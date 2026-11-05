import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerMessage } from '@sync-system/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import {
  LOCK_CHANGES_PER_GROUP_PER_MINUTE,
  VICE_CHANGES_PER_GROUP_PER_MINUTE,
} from '../src/limits/constants.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { GRACE_MS } from './helpers/lifecycle.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

const PID = randomUUID();

/** Every leader-only action (#13 section 7), with a valid frame. */
const ACTIONS: Array<[string, Record<string, unknown>]> = [
  ['position.update', { type: 'position.update', position: 1 }],
  ['group.end', { type: 'group.end' }],
  ['blocklist.set', { type: 'blocklist.set', blockList: [PID] }],
  ['codes.rotate', { type: 'codes.rotate' }],
  ['qr.issue', { type: 'qr.issue' }],
  ['join.approve', { type: 'join.approve', requestId: 'A'.repeat(22) }],
  ['join.deny', { type: 'join.deny', requestId: 'A'.repeat(22) }],
  ['vice.set', { type: 'vice.set', participantId: PID }],
  ['vice.clear', { type: 'vice.clear' }],
  ['group.lock', { type: 'group.lock' }],
  ['group.unlock', { type: 'group.unlock' }],
  ['member.remove', { type: 'member.remove', participantId: PID }],
  ['leader.activity', { type: 'leader.activity' }],
  ['keepalive.ack', { type: 'keepalive.ack' }],
];

/** The next frame of `type`, skipping any other frame in between. */
async function frameOf(client: TestClient, type: string): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message;
  }
}

async function start() {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'B', 'D'] }],
  });
  return { scheduler, store };
}

describe('role matrix (#13 AC6, AC7, section 7, RC1, RC2)', () => {
  it('refuses every leader action from every non-leader, with no effect or budget spent', async () => {
    const { scheduler, store } = await start();
    const group = await createGroupWithMembers(ts!, 2, { joinMethods: ['A', 'D'] });
    const [member, vice] = group.members as [TestClient, TestClient];
    group.leader.send({ type: 'vice.set', participantId: group.memberIds[1] });
    await frameOf(group.leader, 'vice.updated');
    await vice.next('vice.changed');
    // A pending joiner of a method B group and a groupless connection.
    const b = await ts!.connectReady();
    b.send({ type: 'group.create', metadata: {}, joinMethods: ['B'] });
    const bCreated = await frameOf(b, 'group.created');
    const pending = await ts!.connectReady();
    pending.send({
      type: 'group.joinByCode',
      joinCode: (bCreated as { codes: { groupCode: string } }).codes.groupCode,
    });
    await pending.next('join.pending');
    const groupless = await ts!.connectReady();
    const before = await store.get('app-a', group.groupId);
    const promptAt = scheduler.nextAt;

    for (const [label, client] of [
      ['member', member],
      ['vice', vice],
      ['pending', pending],
    ] as const) {
      for (const [action, frame] of ACTIONS) {
        client.send({ ...frame, reqId: 'x' });
        const reply = await client.next('error');
        expect(reply, `${label} ${action}`).toMatchObject({ reqId: 'x', code: 'NOT_LEADER' });
      }
    }
    for (const [action, frame] of ACTIONS) {
      groupless.send(frame);
      expect((await groupless.next('error')).code, action).toBe('NOT_IN_GROUP');
    }
    // Nothing changed, no activity counted, no budget spent.
    const after = await store.get('app-a', group.groupId);
    expect(after).toEqual(before);
    expect(scheduler.nextAt).toBe(promptAt);
    // The one vice.set above is the only charge so far.
    for (let i = 1; i < VICE_CHANGES_PER_GROUP_PER_MINUTE; i++) {
      group.leader.send({ type: 'vice.clear' });
      await frameOf(group.leader, 'vice.updated');
    }
    for (let i = 0; i < LOCK_CHANGES_PER_GROUP_PER_MINUTE; i++) {
      group.leader.send({ type: i % 2 === 0 ? 'group.lock' : 'group.unlock' });
      await frameOf(group.leader, 'lock.changed');
    }
  });

  it('refuses a parked participant like any non-leader', async () => {
    const secrets = { current: randomBytes(32), source: 'env' as const };
    ts = await startTestServer({ tokenSecrets: secrets });
    const group = await createGroupWithMembers(ts, 1);
    await ts.close();
    ts = await startTestServer({ tokenSecrets: secrets });
    const { client: parked } = await resumeWith(ts, group.memberTokens[0]);
    for (const [action, frame] of ACTIONS) {
      parked.send(frame);
      expect((await parked.next('error')).code, action).toBe('NOT_LEADER');
    }
  });

  it('refuses the old leader connection right after a handoff (stale role)', async () => {
    const { scheduler } = await start();
    const group = await createGroupWithMembers(ts!, 1);
    scheduler.advance(19 * 60_000);
    await group.leader.next('keepalive.prompt');
    scheduler.advance(60_000);
    await group.members[0]!.next('leader.offline');
    scheduler.advance(GRACE_MS);
    await frameOf(group.members[0]!, 'leader.granted');
    await frameOf(group.leader, 'leader.lost');
    for (const [action, frame] of ACTIONS) {
      group.leader.send(frame);
      const reply = await frameOf(group.leader, 'error');
      expect((reply as { code: string }).code, action).toBe('NOT_LEADER');
    }
  });
});

describe('leader races (#13 AC8, D2)', () => {
  it('an action in the same tick as the handoff gets its full effect or NOT_LEADER, never both', async () => {
    const { scheduler } = await start();
    const group = await createGroupWithMembers(ts!, 2);
    const [next, other] = group.members as [TestClient, TestClient];
    scheduler.advance(19 * 60_000);
    await group.leader.next('keepalive.prompt');
    scheduler.advance(60_000);
    await next.next('leader.offline');
    await other.next('leader.offline');
    // The old leader's update races the grace end.
    group.leader.send({ type: 'position.update', position: 'race' });
    scheduler.advance(GRACE_MS);
    const reply = await frameOf(group.leader, 'position.ack').catch(() => undefined);
    const frames: string[] = [];
    for (;;) {
      const message = await other.next(undefined, 200).catch(() => undefined);
      if (message === undefined) break;
      frames.push(message.type);
    }
    // Never a relay after leader.changed.
    const changed = frames.indexOf('leader.changed');
    const relayed = frames.indexOf('position.updated');
    if (relayed >= 0) expect(relayed).toBeLessThan(changed);
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(reply === undefined || relayed >= 0).toBe(true);
  });
});

describe('members never learn other IDs or names (#13 RC11, AC31, Q3.3)', () => {
  it('captures every member and vice frame over vice, lock, removal, handoff and take-back', async () => {
    const { scheduler } = await start();
    const leader = await ts!.connectReady();
    leader.send({ type: 'group.create', metadata: {}, displayName: 'Leader Secret' });
    const created = await frameOf(leader, 'group.created');
    const codes = (created as { codes: { groupCode: string; doorCode: string } }).codes;
    const members: Array<{ client: TestClient; pid: string }> = [];
    for (const name of ['Alpha Secret', 'Beta Secret', 'Gamma Secret']) {
      const client = await ts!.connectReady();
      client.send({
        type: 'group.joinByCode',
        joinCode: codes.groupCode,
        doorCode: codes.doorCode,
        displayName: name,
      });
      const joined = await frameOf(client, 'group.joined');
      members.push({ client, pid: (joined as { participantId: string }).participantId });
    }
    const [a, b, c] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0]];
    const leaderPid = (created as { participantId: string }).participantId;
    leader.send({ type: 'vice.set', participantId: b.pid });
    await frameOf(leader, 'vice.updated');
    leader.send({ type: 'group.lock' });
    await frameOf(leader, 'lock.changed');
    leader.send({ type: 'member.remove', participantId: c.pid });
    await frameOf(leader, 'member.removed');
    await leader.close();
    // The server handled the close before the clock moves.
    await frameOf(a.client, 'leader.offline');
    scheduler.advance(GRACE_MS);
    await frameOf(b.client, 'leader.granted');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const names = ['Leader Secret', 'Alpha Secret', 'Beta Secret', 'Gamma Secret'];
    // A plain member and the vice (until it leads) see no other ID or name.
    const viceFrames = b.client.received.slice(
      0,
      b.client.received.findIndex((f) => f.type === 'leader.granted'),
    );
    for (const [own, frames] of [
      ['Alpha Secret', a.client.received],
      ['Beta Secret', viceFrames],
    ] as const) {
      const text = JSON.stringify(frames);
      for (const other of [leaderPid, a.pid, b.pid, c.pid]) {
        if (!text.includes(other)) continue;
        // Only its own ID, in its own join reply and token.
        expect(frames === viceFrames ? b.pid : a.pid).toBe(other);
      }
      for (const name of names.filter((n) => n !== own)) expect(text).not.toContain(name);
      expect(text).not.toContain(codes.groupCode);
      expect(frames.some((f) => f.type.startsWith('roster.'))).toBe(false);
    }
  });
});

describe('leader budgets are per group (#13 8.2, RC2)', () => {
  it('a spent budget in one group leaves another group of the app untouched', async () => {
    await start();
    const first = await createGroupWithMembers(ts!, 0);
    const second = await createGroupWithMembers(ts!, 0);
    for (let i = 0; i < LOCK_CHANGES_PER_GROUP_PER_MINUTE; i++) {
      first.leader.send({ type: i % 2 === 0 ? 'group.lock' : 'group.unlock' });
      await frameOf(first.leader, 'lock.changed');
    }
    first.leader.send({ type: 'group.lock' });
    expect(await frameOf(first.leader, 'error')).toMatchObject({ code: 'RATE_LIMITED' });
    second.leader.send({ type: 'group.lock' });
    expect(await frameOf(second.leader, 'lock.changed')).toMatchObject({ locked: true });
  });
});
