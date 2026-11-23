import type { RosterEntryWire, ServerMessage } from '@mosherw/sync-system-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers, joinByCode, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

function participants(message: ServerMessage): RosterEntryWire[] {
  if (message.type !== 'roster.snapshot') throw new Error(`expected a snapshot: ${message.type}`);
  return message.participants;
}

describe('the leader-only roster (#13 AC5, AC31)', () => {
  it('sends the leader a snapshot after create, then a delta per join and disconnect', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, displayName: 'Dana' });
    const created = await leader.next('group.created');
    expect(created).toMatchObject({ displayName: 'Dana', generated: false, handoff: 'auto' });
    expect(participants(await leader.next('roster.snapshot'))).toEqual([
      {
        participantId: created.participantId,
        displayName: 'Dana',
        generated: false,
        role: 'leader',
        connected: true,
        joinedAgoMs: 0,
      },
    ]);

    scheduler.advance(5_000);
    const { client: member, reply } = await joinByCode(ts, created);
    if (reply.type !== 'group.joined') throw new Error('expected group.joined');
    expect(reply).toMatchObject({ displayName: 'Guest 1', generated: true });
    expect(await leader.next('roster.updated')).toEqual({
      type: 'roster.updated',
      groupId: created.groupId,
      participant: {
        participantId: reply.participantId,
        displayName: 'Guest 1',
        generated: true,
        guestNumber: 1,
        role: 'member',
        connected: true,
        joinedAgoMs: 0,
      },
    });

    scheduler.advance(1_000);
    await member.close();
    expect(await leader.next('roster.updated')).toMatchObject({
      participant: { participantId: reply.participantId, connected: false, joinedAgoMs: 1_000 },
    });
  });

  it('keeps a disconnected member in place and marks it connected on resume', async () => {
    ts = await startTestServer({ scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 2);
    await group.leader.next('roster.snapshot');
    await group.leader.next('roster.updated');
    await group.leader.next('roster.updated');
    await group.members[0]!.close();
    await group.leader.next('roster.updated');
    const { reply } = await resumeWith(ts, group.memberTokens[0], { displayName: 'Renamed' });
    // An existing entry keeps its name (no renaming, Q5.3); the creator is Guest 1.
    expect(reply).toMatchObject({ displayName: 'Guest 2', generated: true });
    expect(await group.leader.next('roster.updated')).toMatchObject({
      participant: { participantId: group.memberIds[0], connected: true, displayName: 'Guest 2' },
    });
    // A leader return gets the snapshot in admission order.
    await group.leader.close();
    const { client: back } = await resumeWith(ts, group.leaderToken);
    const roster = participants(await back.next('roster.snapshot'));
    expect(roster.map((e) => [e.participantId, e.role, e.connected])).toEqual([
      [group.leaderId, 'leader', true],
      [group.memberIds[0], 'member', true],
      [group.memberIds[1], 'member', true],
    ]);
  });

  it('removes leavers and blocked participants, and tells the leader', async () => {
    ts = await startTestServer({ scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 2);
    await group.leader.next('roster.snapshot');
    await group.leader.next('roster.updated');
    await group.leader.next('roster.updated');
    group.members[0]!.send({ type: 'group.leave' });
    await group.members[0]!.next('group.left');
    expect(await group.leader.next('roster.removed')).toEqual({
      type: 'roster.removed',
      groupId: group.groupId,
      participantId: group.memberIds[0],
    });
    group.leader.send({ type: 'blocklist.set', blockList: [group.memberIds[1]] });
    await group.leader.next('blocklist.ack');
    expect(await group.leader.next('roster.removed')).toMatchObject({
      participantId: group.memberIds[1],
    });
  });

  it('never sends a roster frame, another ID or another name to a member', async () => {
    ts = await startTestServer({ scheduler: new ManualScheduler() });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, displayName: 'Leader Name' });
    const created = await leader.next('group.created');
    const { client: first, reply: firstReply } = await joinByCode(ts, created, {
      extra: { displayName: 'First Member' },
    });
    if (firstReply.type !== 'group.joined') throw new Error('expected group.joined');
    const { client: second } = await joinByCode(ts, created, {
      extra: { displayName: 'Second Member' },
    });
    await second.close();
    leader.send({ type: 'position.update', position: 1 });
    await first.next('position.updated');
    await first.expectNoMessage(30);
    expect(first.rosterFrames).toEqual([]);
    const text = JSON.stringify(firstReply);
    for (const secret of [created.participantId, 'Leader Name', 'Second Member']) {
      expect(text).not.toContain(secret);
    }
  });

  it('evicts the first-disconnected entry past maxGroupSize disconnected entries', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      scheduler: new ManualScheduler(),
      store,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 3 }],
    });
    const group = await createGroupWithMembers(ts, 2);
    // Leader + 3 disconnected members with a cap of 3 disconnected entries:
    // nobody goes yet; a 4th disconnected entry evicts the first.
    await group.members[0]!.close();
    await group.members[1]!.close();
    const late = await joinByCode(ts, { codes: group.codes });
    await late.client.close();
    const fourth = await joinByCode(ts, { codes: group.codes });
    await fourth.client.close();
    await waitUntil(async () => (await store.get('app-a', group.groupId))?.roster.length === 4);
    const roster = (await store.get('app-a', group.groupId))!.roster;
    expect(roster.map((e) => e.pid)).not.toContain(group.memberIds[0]);
    expect(roster[0]?.pid).toBe(group.leaderId);
    // The removal reaches the leader after the store changed: wait for it.
    const isRemoval = (f: ServerMessage) => f.type === 'roster.removed';
    await waitUntil(() => group.leader.rosterFrames.some(isRemoval), 2000, 'roster.removed');
    const removed = group.leader.rosterFrames.filter(isRemoval);
    expect(removed).toEqual([
      { type: 'roster.removed', groupId: group.groupId, participantId: group.memberIds[0] },
    ]);
  });
});
