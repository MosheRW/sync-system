import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddParticipantResult } from '../src/groups/group-store.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** A store that refuses the next admission as full (a shared store could). */
class RefusingStore extends InMemoryGroupStore {
  refuseNext = false;

  override addParticipant(
    namespace: string,
    id: string,
    participantId: string,
    maxSize: number,
  ): Promise<AddParticipantResult> {
    if (this.refuseNext) {
      this.refuseNext = false;
      return Promise.resolve({ status: 'full' });
    }
    return super.addParticipant(namespace, id, participantId, maxSize);
  }
}

describe('a refused resume changes nothing (#13 security L-1)', () => {
  it('a leader return refused with BLOCK_LIST_FULL keeps the old leader session', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 1);
    const first = Array.from({ length: 200 }, () => randomUUID());
    group.leader.send({ type: 'blocklist.set', blockList: first });
    await group.leader.next('blocklist.ack');
    const before = await store.get('app-a', group.groupId);

    // A second socket resumes with a list whose union passes 256.
    const more = [...Array.from({ length: 57 }, () => randomUUID()), group.memberIds[0]];
    const { client, reply } = await resumeWith(ts, group.leaderToken, { blockList: more });
    expect(reply).toMatchObject({ type: 'error', code: 'BLOCK_LIST_FULL' });

    // Nothing changed: the old session is still attached and leading.
    expect(await store.get('app-a', group.groupId)).toEqual(before);
    await group.leader.expectNoMessage(30);
    group.leader.send({ type: 'position.update', position: 'still' });
    await group.leader.next('position.ack');
    expect(await group.members[0]!.next('position.updated')).toMatchObject({ position: 'still' });
    // The refused socket is in no group.
    client.send({ type: 'position.update', position: 'nope' });
    expect(await client.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
  });

  it('an accepted leader return still replaces the old session', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1);
    const { reply } = await resumeWith(ts, group.leaderToken, { blockList: [randomUUID()] });
    expect(reply).toMatchObject({ type: 'group.resumed' });
    expect(await group.leader.next('group.ended')).toMatchObject({ reason: 'replaced' });
  });

  it('a member resume refused by the store keeps the older member session', async () => {
    const store = new RefusingStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 1);
    const before = await store.get('app-a', group.groupId);
    store.refuseNext = true;
    const { client, reply } = await resumeWith(ts, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_FULL' });
    expect(await store.get('app-a', group.groupId)).toEqual(before);
    // The older member session was not replaced and still gets updates.
    await group.members[0]!.expectNoMessage(30);
    group.leader.send({ type: 'position.update', position: 'kept' });
    await group.leader.next('position.ack');
    expect(await group.members[0]!.next('position.updated')).toMatchObject({ position: 'kept' });
    client.send({ type: 'group.leave' });
    expect(await client.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
  });
});
