import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecrets } from '../src/config/token-secret.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { TokenKeyring, deriveAppKey } from '../src/tokens/token-keys.js';
import { TokenService } from '../src/tokens/token-service.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { KEY_A, KEY_B, type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf, forge, headerSegment } from './helpers/tokens.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
const WINDOW = 20 * MINUTE + 300_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

function secrets(): TokenSecrets {
  return { current: randomBytes(32), source: 'env' };
}

describe('member token rejoin (#5 AC17)', () => {
  it('rejoins a live group with the same participant ID and a fresh token', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const group = await createGroupWithMembers(ts, 1, { metadata: { m: 1 }, position: { p: 1 } });
    await group.members[0]!.close();
    scheduler.advance(30_000);

    const { client, reply } = await resumeWith(ts, group.memberTokens[0], { reqId: 'r1' });
    expect(reply).toEqual({
      type: 'group.joined',
      reqId: 'r1',
      groupId: group.groupId,
      participantId: group.memberIds[0],
      role: 'member',
      metadata: { m: 1 },
      token: expect.any(String) as string,
      leaderOnline: true,
      hasPosition: true,
      position: { p: 1 },
    });
    if (reply.type !== 'group.joined') throw new Error('expected joined');
    expect(reply.token).not.toBe(group.memberTokens[0]);
    expect(claimsOf(reply.token)).toMatchObject({ pid: group.memberIds[0], role: 'member' });

    group.leader.send({ type: 'position.update', position: 2 });
    await group.leader.next('position.ack');
    expect(await client.next('position.updated')).toMatchObject({ position: 2 });
  });

  it('says hasPosition false when there is no position', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1);
    await group.members[0]!.close();
    const { reply } = await resumeWith(ts, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'group.joined', hasPosition: false });
    expect(reply).not.toHaveProperty('position');
  });

  it('refuses a full group with GROUP_FULL', async () => {
    ts = await startTestServer({ apps: [{ namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 2 }] });
    const group = await createGroupWithMembers(ts, 1);
    await group.members[0]!.close();
    const late = await ts.connectReady();
    await waitUntil(async () => {
      late.send({ type: 'group.joinByCode', ...group.join });
      return (await late.next()).type === 'group.joined';
    });
    const { reply } = await resumeWith(ts, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_FULL' });
  });

  it('accepts a member token with an old lat on a live group (Q-B)', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const group = await createGroupWithMembers(ts, 1);
    await group.members[0]!.close();
    scheduler.advance(WINDOW + 10 * MINUTE);
    const { reply } = await resumeWith(ts, group.memberTokens[0]);
    expect(reply.type).toBe('group.joined');
  });
});

describe('leader return (#5 AC19)', () => {
  it('takes the lead back: server position wins, members hear leader.online', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1, { metadata: { m: 1 }, position: 'server' });
    await group.leader.close();
    await group.members[0]!.next('leader.offline');

    const { client: leader, reply } = await resumeWith(ts, group.leaderToken, {
      reqId: 'r',
      metadata: { m: 'client' },
      position: 'client',
    });
    expect(reply).toEqual({
      type: 'group.resumed',
      reqId: 'r',
      groupId: group.groupId,
      participantId: group.leaderId,
      role: 'leader',
      metadata: { m: 1 },
      hasPosition: true,
      position: 'server',
      token: expect.any(String) as string,
      recreated: false,
      joinMethods: ['A', 'D'],
      codes: { ...group.codes, blob: expect.any(String) as string },
      codesChanged: true,
    });
    expect(await group.members[0]!.next('leader.online')).toEqual({
      type: 'leader.online',
      groupId: group.groupId,
    });
    leader.send({ type: 'position.update', position: 'next' });
    await leader.next('position.ack');
    expect(await group.members[0]!.next('position.updated')).toMatchObject({ position: 'next' });
  });

  it('cancels the frozen-end timer', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const group = await createGroupWithMembers(ts, 1);
    await group.leader.close();
    await group.members[0]!.next('leader.offline');
    expect(scheduler.pending).toBe(2);
    await resumeWith(ts, group.leaderToken);
    await group.members[0]!.next('leader.online');
    expect(scheduler.pending).toBe(1);
    scheduler.advance(WINDOW + 1);
    await group.members[0]!.expectNoMessage(30);
  });

  it('records the return as leader activity (fresh lat)', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const group = await createGroupWithMembers(ts, 1);
    await group.leader.close();
    scheduler.advance(5 * MINUTE);
    const { reply } = await resumeWith(ts, group.leaderToken);
    if (reply.type !== 'group.resumed') throw new Error('expected resumed');
    expect(claimsOf(reply.token).lat).toBe(scheduler.now());
  });
});

describe('newest resume wins (#5 AC20, M4)', () => {
  it('replaces an older leader connection without ending the group', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 1);
    const { client: newer, reply } = await resumeWith(ts, group.leaderToken);
    expect(reply.type).toBe('group.resumed');
    expect(await group.leader.next('group.ended')).toEqual({
      type: 'group.ended',
      groupId: group.groupId,
      reason: 'replaced',
    });
    // Members were never told the leader went away.
    await group.members[0]!.expectNoMessage(30);
    newer.send({ type: 'position.update', position: 1 });
    await newer.next('position.ack');
    await group.members[0]!.next('position.updated');

    // The old socket closing later changes nothing.
    await group.leader.close();
    await group.members[0]!.expectNoMessage(50);
    expect(await store.get('app-a', group.groupId)).toMatchObject({ leaderOnline: true });
  });

  it('strips every right from the replaced session at once (M4)', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1);
    const newer = await ts.connectReady();
    newer.send({ type: 'group.resume', token: group.leaderToken });
    // Pipelined right after the newer resume.
    await newer.next('group.resumed');
    group.leader.send({ type: 'position.update', reqId: 'u', position: 'stale' });
    group.leader.send({ type: 'group.end', reqId: 'e' });
    group.leader.send({ type: 'group.leave', reqId: 'l' });
    expect(await group.leader.next('group.ended')).toMatchObject({ reason: 'replaced' });
    expect(await group.leader.next('error')).toMatchObject({ reqId: 'u', code: 'NOT_IN_GROUP' });
    expect(await group.leader.next('error')).toMatchObject({ reqId: 'e', code: 'NOT_IN_GROUP' });
    expect(await group.leader.next('error')).toMatchObject({ reqId: 'l', code: 'NOT_IN_GROUP' });
    await group.members[0]!.expectNoMessage(50);
    newer.send({ type: 'position.update', position: 'live' });
    await newer.next('position.ack');
  });

  it('replaces an older member connection and keeps one slot', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 1);
    const { client: newer, reply } = await resumeWith(ts, group.memberTokens[0]);
    expect(reply.type).toBe('group.joined');
    expect((await group.members[0]!.next('group.ended')).reason).toBe('replaced');
    expect((await store.get('app-a', group.groupId))?.participantIds).toHaveLength(2);
    await group.members[0]!.close();
    group.leader.send({ type: 'position.update', position: 1 });
    await group.leader.next('position.ack');
    expect(await newer.next('position.updated')).toMatchObject({ position: 1 });
    expect((await store.get('app-a', group.groupId))?.participantIds).toHaveLength(2);
  });
});

describe('token rejections (#5 AC7, AC8, AC9, AC27)', () => {
  it('answers ALREADY_IN_GROUP first, before looking at the token', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 0);
    group.leader.send({ type: 'group.resume', token: 'garbage' });
    expect(await group.leader.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });
  });

  it('gives identical TOKEN_INVALID for every forged token, echoing nothing', async () => {
    const tokenSecrets = secrets();
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 1);
    const key = deriveAppKey(tokenSecrets.current, 'app-a');
    const claims = claimsOf(group.leaderToken);
    const [h, p, s] = group.leaderToken.split('.') as [string, string, string];
    const forged = [
      'garbage',
      forge(claims, key, { header: headerSegment({ alg: 'none', typ: 'JWT' }) }),
      forge(claims, key, { algorithm: 'sha512' }),
      forge(claims, randomBytes(32)),
      forge({ ...claims, v: 2 }, key),
      forge({ ...claims, role: 'admin' }, key),
      `${h}.${p}.${(s[0] === 'A' ? 'B' : 'A') + s.slice(1)}`,
      `${h}.${p}`,
    ];
    const replies: unknown[] = [];
    for (const token of forged) {
      const { reply } = await resumeWith(ts, token, { reqId: 'same' });
      replies.push(reply);
      expect(JSON.stringify(reply)).not.toContain(s);
      expect(JSON.stringify(reply)).not.toContain(group.groupId);
    }
    for (const reply of replies) {
      expect(reply).toEqual({
        type: 'error',
        reqId: 'same',
        code: 'TOKEN_INVALID',
        message: 'Invalid token',
      });
    }
  });

  it('refuses a token over 2048 characters as an invalid message', async () => {
    ts = await startTestServer();
    const { reply } = await resumeWith(ts, 'x'.repeat(2049), { reqId: 'long' });
    expect(reply).toMatchObject({ type: 'error', reqId: 'long', code: 'INVALID_MESSAGE' });
  });

  it('treats another app’s valid token exactly like garbage (AC8)', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 0);
    const cross = await resumeWith(ts, group.leaderToken, { reqId: 'x' }, KEY_B);
    const garbage = await resumeWith(ts, 'not-a-token', { reqId: 'x' }, KEY_B);
    expect(cross.reply).toEqual(garbage.reply);
    expect(cross.reply).toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('refuses a leader token whose pid is not the group leader', async () => {
    const tokenSecrets = secrets();
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 0);
    const issuer = new TokenService(new TokenKeyring(tokenSecrets));
    const claims = claimsOf(group.leaderToken);
    const impostor = issuer.issue({
      namespace: 'app-a',
      groupId: group.groupId,
      participantId: randomUUID(),
      role: 'leader',
      groupCreatedAt: claims.gct,
      lastActivityAt: claims.lat,
      now: Date.now(),
    });
    const { reply } = await resumeWith(ts, impostor);
    expect(reply).toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('reports a leader token past the recovery window as TOKEN_EXPIRED (AC9)', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const group = await createGroupWithMembers(ts, 1);
    // The group stays live through a member while the leader is gone; the
    // leader token itself has not been refreshed.
    group.leader.terminate();
    await group.members[0]!.next('leader.offline');
    scheduler.advance(WINDOW - 1);
    const { reply: early } = await resumeWith(ts, group.leaderToken);
    expect(early.type).toBe('group.resumed');
  });

  it('reports TOKEN_EXPIRED one window after the last activity, and creates nothing', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, store });
    const group = await createGroupWithMembers(ts, 0);
    await group.leader.close();
    await waitUntil(() => store.size === 0);
    scheduler.advance(WINDOW);
    const { reply } = await resumeWith(ts, group.leaderToken);
    expect(reply).toMatchObject({ code: 'TOKEN_EXPIRED', message: 'Token expired' });
    expect(store.size).toBe(0);
  });

  it('reports any token past the max session time as TOKEN_EXPIRED', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      scheduler,
      store,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, maxSessionMinutes: 5 }],
    });
    const group = await createGroupWithMembers(ts, 1);
    await group.members[0]!.close();
    await group.leader.close();
    await waitUntil(() => store.size === 0);
    scheduler.advance(5 * MINUTE);
    expect((await resumeWith(ts, group.memberTokens[0])).reply).toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
    expect((await resumeWith(ts, group.leaderToken)).reply).toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });

  it('answers GROUP_ENDED for tokens of a group that ended (AC27, AC29)', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1);
    group.leader.send({ type: 'group.end' });
    await group.leader.next('group.ended');
    expect((await resumeWith(ts, group.leaderToken)).reply).toMatchObject({
      code: 'GROUP_ENDED',
      message: 'Group has ended',
    });
    expect((await resumeWith(ts, group.memberTokens[0])).reply).toMatchObject({
      code: 'GROUP_ENDED',
    });
  });

  it('re-signs a previous-secret token with the current secret (AC2)', async () => {
    const old = secrets();
    const fresh = secrets();
    ts = await startTestServer({ tokenSecrets: old });
    const group = await createGroupWithMembers(ts, 1);
    await ts.close();
    ts = await startTestServer({
      tokenSecrets: { current: fresh.current, previous: old.current, source: 'env' },
    });
    // The group is gone after the restart; a member resume of a live group
    // needs one, so create it again through the leader's member.
    const live = await createGroupWithMembers(ts, 1);
    await live.members[0]!.close();
    const reissued = new TokenService(new TokenKeyring({ current: old.current }));
    const claims = claimsOf(live.memberTokens[0]);
    const oldToken = reissued.issue({
      namespace: 'app-a',
      groupId: claims.gid,
      participantId: claims.pid,
      role: 'member',
      groupCreatedAt: claims.gct,
      lastActivityAt: claims.lat,
      now: Date.now(),
    });
    const { reply } = await resumeWith(ts, oldToken);
    if (reply.type !== 'group.joined') throw new Error(`expected joined, got ${reply.type}`);
    const verifyCurrent = new TokenService(new TokenKeyring({ current: fresh.current }));
    expect(verifyCurrent.verify(reply.token, 'app-a', Date.now()).ok).toBe(true);
    expect(group.groupId).not.toBe(live.groupId);
  });
});
