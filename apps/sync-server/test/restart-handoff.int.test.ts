import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecretsInput } from '../src/config/token-secret.js';
import type { GroupRecord, GroupStore } from '../src/groups/group-store.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { DOOR_FAILURES_BEFORE_ROTATION } from '../src/limits/constants.js';
import { TokenKeyring } from '../src/tokens/token-keys.js';
import { TokenService } from '../src/tokens/token-service.js';
import {
  type TestGroup,
  createGroupWithMembers,
  joinByCode,
  resumeWith,
} from './helpers/groups.js';
import { GRACE_MS, isHeld } from './helpers/lifecycle.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';
import { waitUntil } from './helpers/wait.js';
import { testSecrets } from './helpers/token-secrets.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** The next frame of `type`, skipping any other frame in between. */
async function frameOf(client: TestClient, type: string) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message;
  }
}

interface Line {
  secrets: TokenSecretsInput;
  scheduler: ManualScheduler;
  group: TestGroup;
  /** A's leader token (term T0). */
  a: string;
  /** B's leader token after the handoff (term T1). */
  b: string;
  /** The codes blob B last got in P1, and its generation. */
  bBlob: string;
  bGeneration: number;
}

/**
 * P1: A creates, members B and M join; A disconnects and the lead passes
 * to B (term T1 > T0); B removes A. Then the server restarts (P2).
 */
async function lineThenRestart(): Promise<Line & { store: InMemoryGroupStore }> {
  const secrets: TokenSecretsInput = { current: randomBytes(32), source: 'env' };
  const scheduler = new ManualScheduler();
  ts = await startTestServer({ tokenSecrets: secrets, scheduler });
  const group = await createGroupWithMembers(ts, 2);
  const [bClient] = group.members as [TestClient, TestClient];
  await group.leader.close();
  await bClient.next('leader.offline');
  scheduler.advance(GRACE_MS);
  const granted = await bClient.next('leader.granted');
  if (granted.type !== 'leader.granted') throw new Error('expected leader.granted');
  bClient.send({ type: 'member.remove', participantId: group.leaderId });
  await frameOf(bClient, 'member.removed');
  const updated = await frameOf(bClient, 'codes.updated');
  if (updated.type !== 'codes.updated') throw new Error('expected codes.updated');
  await ts.close();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({ tokenSecrets: secrets, scheduler, store });
  return {
    secrets,
    scheduler,
    store,
    group,
    a: group.leaderToken,
    b: granted.token,
    bBlob: updated.codes.blob,
    bGeneration: updated.codes.generation,
  };
}

async function record(store: GroupStore, groupId: string): Promise<GroupRecord> {
  const found = await store.get('app-a', groupId);
  if (found === undefined) throw new Error('group not in memory');
  return found;
}

describe('supersede after a restart (#13 AC26, 6.6, RC6, RC7)', () => {
  it('stale A recreates first; B supersedes, removes A by its list, rotates the stale codes', async () => {
    const line = await lineThenRestart();
    const { store, group } = line;
    const { client: a, reply: recreated } = await resumeWith(ts!, line.a, {
      metadata: {},
      joinCodes: group.codes.blob,
    });
    expect(recreated).toMatchObject({ type: 'group.resumed', recreated: true });
    const afterRecreate = await record(store, group.groupId);
    expect(afterRecreate.anchorTerm).toBe(claimsOf(line.a).term);
    expect(afterRecreate.anchorTerm!).toBeLessThan(afterRecreate.recoveredAt!);
    // A admits a newcomer through its stale codes during the window (M4).
    const newcomer = await joinByCode(ts!, group);
    expect(newcomer.reply.type).toBe('group.joined');

    const { client: b, reply } = await resumeWith(ts!, line.b, {
      blockList: [group.leaderId],
    });
    expect(reply).toMatchObject({ type: 'group.resumed', superseded: true, recreated: false });
    const bToken = (reply as { token: string }).token;
    expect(claimsOf(bToken).term).toBeGreaterThanOrEqual(afterRecreate.recoveredAt!);
    expect(claimsOf(bToken).pid).toBe(group.memberIds[0]);
    // A was on B's list: removed, no token, socket closed (L1).
    expect(await frameOf(a, 'group.ended')).toMatchObject({ reason: 'removed' });
    expect((await a.closed()).code).toBe(4004);
    // The stale codes were rotated (M1) and the newcomer is flagged (6.6.4).
    const roster = await b.next('roster.snapshot');
    const flagged = roster.participants.filter((p) => p.admittedSinceRecovery === true);
    expect(flagged.map((p) => p.displayName)).toHaveLength(1);
    expect(await frameOf(b, 'codes.updated')).toMatchObject({ reason: 'superseded' });
    expect((await joinByCode(ts!, group)).reply).toMatchObject({ code: 'CODE_NOT_FOUND' });
    const after = await record(store, group.groupId);
    expect(after).toMatchObject({
      leaderId: group.memberIds[0],
      anchorTerm: claimsOf(line.b).term,
      recoveredAt: afterRecreate.recoveredAt,
      displacedLeaderId: undefined,
      escalated: false,
      blockList: [group.leaderId],
    });
    // A's old token is blocked now (6.6.3 row 3).
    expect((await resumeWith(ts!, line.a)).reply).toMatchObject({ code: 'PARTICIPANT_BLOCKED' });
  });

  it('adopts the requester codes when its blob is valid and newer', async () => {
    const line = await lineThenRestart();
    await resumeWith(ts!, line.a, { metadata: {}, joinCodes: line.group.codes.blob });
    const { client: b, reply } = await resumeWith(ts!, line.b, {
      blockList: [line.group.leaderId],
      joinCodes: line.bBlob,
    });
    expect(reply).toMatchObject({
      superseded: true,
      codesChanged: false,
      codes: { generation: line.bGeneration },
    });
    await b.next('roster.snapshot');
    // B's codes work; A's stale ones do not.
    if (reply.type !== 'group.resumed') throw new Error('expected group.resumed');
    expect((await joinByCode(ts!, { codes: reply.codes })).reply.type).toBe('group.joined');
    expect((await joinByCode(ts!, line.group)).reply).toMatchObject({ code: 'CODE_NOT_FOUND' });
  });

  it('rotates when the requester blob differs only by a door rotation: no stale ticket or code survives (L-2)', async () => {
    const secrets: TokenSecretsInput = { current: randomBytes(32), source: 'env' };
    const scheduler = new ManualScheduler();
    const apps = [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'D'] }];
    ts = await startTestServer({ tokenSecrets: secrets, scheduler, apps });
    const group = await createGroupWithMembers(ts, 2, { joinMethods: ['A', 'D'] });
    const [bClient] = group.members as [TestClient, TestClient];
    await group.leader.close();
    await bClient.next('leader.offline');
    scheduler.advance(GRACE_MS);
    const granted = await bClient.next('leader.granted');
    // Wrong door codes rotate the door only: same group code, same ticket generation.
    const guesser = await ts.connectReady();
    const door = group.join.doorCode!;
    const wrong = String((Number(door) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < DOOR_FAILURES_BEFORE_ROTATION; i++) {
      guesser.send({ type: 'group.joinByCode', joinCode: group.join.joinCode, doorCode: wrong });
      await guesser.next('error');
    }
    const updated = await frameOf(bClient, 'codes.updated');
    if (updated.type !== 'codes.updated') throw new Error('expected codes.updated');
    expect(updated).toMatchObject({ reason: 'door_failures' });
    expect(updated.codes.groupCode).toBe(group.codes.groupCode);
    await ts.close();

    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets: secrets, scheduler, store, apps });
    // Stale A recreates from its old blob and issues a QR ticket in its stale period.
    const { client: a, reply: recreated } = await resumeWith(ts, group.leaderToken, {
      metadata: {},
      joinCodes: group.codes.blob,
    });
    expect(recreated).toMatchObject({ type: 'group.resumed', recreated: true });
    a.send({ type: 'qr.issue' });
    const issued = await frameOf(a, 'qr.ticket');
    const ticket = (issued as { ticket: string }).ticket;
    const staleTicketGeneration = (await record(store, group.groupId)).codes.ticketGeneration;

    const { client: b, reply } = await resumeWith(ts, granted.token, {
      joinCodes: updated.codes.blob,
    });
    expect(reply).toMatchObject({ type: 'group.resumed', superseded: true, codesChanged: true });
    expect(await frameOf(b, 'codes.updated')).toMatchObject({ reason: 'superseded' });
    const after = await record(store, group.groupId);
    expect(after.codes.ticketGeneration).not.toBe(staleTicketGeneration);
    expect(after.codes.groupCode).not.toBe(group.codes.groupCode);
    // The stale period's ticket and the stale group code are dead.
    const joiner = await ts.connectReady();
    joiner.send({ type: 'group.joinByQr', ticket });
    expect(await joiner.next('error')).toMatchObject({ code: 'QR_INVALID' });
    expect((await joinByCode(ts, group)).reply).toMatchObject({ code: 'CODE_NOT_FOUND' });
  });

  it('H1: a grant made in P2 by the stale line never beats B (6.6.3 rows 1, 2)', async () => {
    const line = await lineThenRestart();
    const { scheduler, store, group } = line;
    const { client: a } = await resumeWith(ts!, line.a, { metadata: {} });
    // M (the second member) comes back; A makes it vice and leaves.
    const { client: m } = await resumeWith(ts!, group.memberTokens[1]);
    a.send({ type: 'vice.set', participantId: group.memberIds[1] });
    await frameOf(a, 'vice.updated');
    await a.close();
    await frameOf(m, 'leader.offline');
    scheduler.advance(GRACE_MS);
    const mGranted = await frameOf(m, 'leader.granted');
    const mToken = (mGranted as { token: string }).token;
    const recoveredAt = (await record(store, group.groupId)).recoveredAt!;
    expect(claimsOf(mToken).term).toBeGreaterThanOrEqual(recoveredAt);

    const { reply } = await resumeWith(ts!, line.b, { blockList: [group.leaderId] });
    expect(reply).toMatchObject({ superseded: true });
    expect(await frameOf(m, 'leader.lost')).toMatchObject({
      reason: 'superseded',
      takeBackAvailable: false,
    });
    await m.close();
    // M's in-process leader token resumes as a member only.
    expect((await resumeWith(ts!, mToken)).reply).toMatchObject({
      type: 'group.joined',
      role: 'member',
    });
    expect((await record(store, group.groupId)).leaderId).toBe(group.memberIds[0]);
  });

  it('B first, then stale A: A is a member and blocked (6.6.3 row 4)', async () => {
    const line = await lineThenRestart();
    const { reply } = await resumeWith(ts!, line.b, {
      metadata: {},
      blockList: [line.group.leaderId],
    });
    expect(reply).toMatchObject({ recreated: true });
    expect((await resumeWith(ts!, line.a)).reply).toMatchObject({ code: 'PARTICIPANT_BLOCKED' });
  });

  it('stale A after B without a list: a member, never the leader', async () => {
    const line = await lineThenRestart();
    await resumeWith(ts!, line.b, { metadata: {} });
    expect((await resumeWith(ts!, line.a)).reply).toMatchObject({
      type: 'group.joined',
      role: 'member',
    });
  });

  it('a group created in this process never supersedes (6.6.3 row 5)', async () => {
    const secrets: TokenSecretsInput = { current: randomBytes(32), source: 'env' };
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets: secrets, scheduler, store });
    const group = await createGroupWithMembers(ts, 0);
    const claims = claimsOf(group.leaderToken);
    const issuer = new TokenService(new TokenKeyring(testSecrets(secrets)));
    for (const term of [claims.gct, scheduler.now()]) {
      const forged = issuer.issue({
        namespace: 'app-a',
        groupId: group.groupId,
        participantId: randomUUID(),
        role: 'leader',
        groupCreatedAt: claims.gct,
        lastActivityAt: claims.lat,
        term,
        now: scheduler.now(),
      });
      expect((await resumeWith(ts, forged)).reply).toMatchObject({ role: 'member' });
    }
    expect((await record(store, group.groupId)).leaderId).toBe(group.leaderId);
  });

  it('later pre-restart grants win in order; an equal term does not (rows 6, 7)', async () => {
    const line = await lineThenRestart();
    const { store, group, secrets } = line;
    await resumeWith(ts!, line.a, { metadata: {} });
    const issuer = new TokenService(new TokenKeyring(testSecrets(secrets)));
    const t0 = claimsOf(line.a);
    const bClaims = claimsOf(line.b);
    const pre = (pid: string, term: number) =>
      issuer.issue({
        namespace: 'app-a',
        groupId: group.groupId,
        participantId: pid,
        role: 'leader',
        groupCreatedAt: t0.gct,
        lastActivityAt: bClaims.lat,
        term,
        now: bClaims.iat * 1000,
      });
    const c = randomUUID();
    const d = randomUUID();
    expect((await resumeWith(ts!, pre(c, bClaims.term + 1))).reply).toMatchObject({
      superseded: true,
    });
    expect((await record(store, group.groupId)).anchorTerm).toBe(bClaims.term + 1);
    // Equal to the anchor: no supersede.
    expect((await resumeWith(ts!, pre(d, bClaims.term + 1))).reply).toMatchObject({
      role: 'member',
    });
    // Lower than the anchor (B's own T1): no supersede.
    expect((await resumeWith(ts!, line.b)).reply).toMatchObject({ role: 'member' });
    expect((await record(store, group.groupId)).leaderId).toBe(c);
  });

  it('a lat-expired real leader token never supersedes (row 8, RC8)', async () => {
    const line = await lineThenRestart();
    const { scheduler, group } = line;
    const { client: a } = await resumeWith(ts!, line.a, { metadata: {} });
    for (let t = 0; t < 26; t += 10) {
      scheduler.advance(10 * 60_000);
      a.send({ type: 'leader.activity' });
      await a.next('activity.ack');
    }
    expect((await resumeWith(ts!, line.b)).reply).toMatchObject({ role: 'member' });
    expect((await record(line.store, group.groupId)).leaderId).toBe(group.leaderId);
  });

  it('after a supersede the stale leader cannot take back (row 9)', async () => {
    const line = await lineThenRestart();
    const { client: a } = await resumeWith(ts!, line.a, { metadata: {} });
    await resumeWith(ts!, line.b, {});
    await frameOf(a, 'leader.lost');
    a.send({ type: 'leader.takeBack' });
    expect(await frameOf(a, 'error')).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('a supersede inside the empty-group hold (RC21 f)', async () => {
    const line = await lineThenRestart();
    const { client: a } = await resumeWith(ts!, line.a, { metadata: {} });
    await a.close();
    await waitUntil(() => isHeld(line.store, line.group.groupId));
    expect((await resumeWith(ts!, line.b, {})).reply).toMatchObject({ superseded: true });
    const after = await record(line.store, line.group.groupId);
    expect(after).toMatchObject({ leaderOnline: true, pause: undefined });
  });

  it('R-2R residual: two restarts let an in-line P2 grant win (documented, Q-F no)', async () => {
    const line = await lineThenRestart();
    const { scheduler, group, secrets } = line;
    const { client: a } = await resumeWith(ts!, line.a, { metadata: {} });
    const { client: m } = await resumeWith(ts!, group.memberTokens[1]);
    await a.close();
    await m.next('leader.offline');
    scheduler.advance(GRACE_MS);
    const mGranted = await frameOf(m, 'leader.granted');
    const mToken = (mGranted as { token: string }).token;
    // Restart 2 while B stayed away for all of P2.
    await ts!.close();
    ts = await startTestServer({
      tokenSecrets: secrets,
      scheduler,
      store: new InMemoryGroupStore(),
    });
    expect((await resumeWith(ts, mToken, { metadata: {} })).reply).toMatchObject({
      recreated: true,
    });
    // B cannot supersede: its T1 is below M's P2 term (the accepted residual).
    expect((await resumeWith(ts, line.b)).reply).toMatchObject({ role: 'member' });
  });
});

/** A store whose `createIfAbsent` finds a group that another node recreated (RC15). */
class RacingStore extends InMemoryGroupStore {
  leaderOfOther: string | undefined;

  override async createIfAbsent(group: GroupRecord): Promise<'created' | 'exists'> {
    if (this.leaderOfOther === undefined) return super.createIfAbsent(group);
    const other = this.leaderOfOther;
    this.leaderOfOther = undefined;
    await super.create({
      ...group,
      leaderId: other,
      participantIds: [other],
      roster: [],
      nextAdmissionSeq: 0,
    });
    return 'exists';
  }
}

describe('recreation fallback and the clock (#13 L9 / RC15, L10 / RC16)', () => {
  it('re-classifies against a group someone else recreated: never a leader return for another pid', async () => {
    const secrets: TokenSecretsInput = { current: randomBytes(32), source: 'env' };
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets: secrets, scheduler });
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();
    const store = new RacingStore();
    ts = await startTestServer({ tokenSecrets: secrets, scheduler, store });
    store.leaderOfOther = randomUUID();
    const { reply } = await resumeWith(ts, group.leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ type: 'group.joined', role: 'member' });
    expect((await record(store, group.groupId)).leaderId).not.toBe(group.leaderId);
  });

  it('a clock behind B across the restart keeps the stale recreator (L10, documented)', async () => {
    const line = await lineThenRestart();
    // The new process's clock is behind B's grant.
    line.scheduler.time = claimsOf(line.b).term - 1_000;
    await resumeWith(ts!, line.a, { metadata: {} });
    const recoveredAt = (await record(line.store, line.group.groupId)).recoveredAt!;
    expect(recoveredAt).toBeLessThanOrEqual(claimsOf(line.b).term);
    expect((await resumeWith(ts!, line.b)).reply).toMatchObject({ role: 'member' });
  });
});
