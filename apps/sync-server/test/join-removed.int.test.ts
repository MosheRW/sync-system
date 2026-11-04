import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import type { GroupActions } from '../src/groups/session.js';
import { codesOf, createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('join by group ID is gone (#10 AC36, R15)', () => {
  it('answers group.join with INVALID_MESSAGE and keeps the connection', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 0);
    const client = await ts.connectReady();
    client.send({ type: 'group.join', reqId: 'old', groupId: group.groupId });
    expect(await client.next('error')).toEqual({
      type: 'error',
      reqId: 'old',
      code: 'INVALID_MESSAGE',
      message: 'Invalid message',
    });
    expect(client.isClosed).toBe(false);
    expect((await store.get('app-a', group.groupId))?.participantIds).toHaveLength(1);
  });

  it('has no join action in the group interface', () => {
    const actions: Record<keyof GroupActions, true> = {
      create: true,
      joinByCode: true,
      joinByQr: true,
      issueQr: true,
      update: true,
      resume: true,
      checkTokens: true,
      setBlockList: true,
      end: true,
      leave: true,
      rotateCodes: true,
      cancelJoin: true,
      approveJoin: true,
      denyJoin: true,
      setVice: true,
      clearVice: true,
      disconnect: true,
    };
    expect(Object.keys(actions)).not.toContain('join');
  });
});

describe('the block list now holds (#10 AC37)', () => {
  it('keeps a blocked member out; a new identity needs the current codes', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 1);
    const blockedId = group.memberIds[0]!;
    group.leader.send({ type: 'blocklist.set', blockList: [blockedId] });
    await group.leader.next('blocklist.ack');
    expect(await group.members[0]!.next('group.ended')).toMatchObject({ reason: 'removed' });

    // The old identity: refused on every path that presents it.
    const { reply } = await resumeWith(ts, group.memberTokens[0]);
    expect(reply).toMatchObject({ code: 'PARTICIPANT_BLOCKED' });
    const byId = await ts.connectReady();
    byId.send({ type: 'group.join', groupId: group.groupId });
    expect(await byId.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });

    // A new identity with the current codes still gets in (documented residual).
    const fresh = await ts.connectReady();
    fresh.send({ type: 'group.joinByCode', ...group.join });
    expect(await fresh.next('group.joined')).toMatchObject({ role: 'member' });

    // The leader's mitigation: rotate. The old codes stop working.
    group.leader.send({ type: 'codes.rotate' });
    const rotated = await group.leader.next('codes.updated');
    const late = await ts.connectReady();
    late.send({ type: 'group.joinByCode', ...group.join });
    expect(await late.next('error')).toMatchObject({ code: 'CODE_NOT_FOUND' });
    late.send({ type: 'group.joinByCode', ...codesOf(rotated.codes) });
    expect(await late.next('group.joined')).toMatchObject({ role: 'member' });
    await waitUntil(
      async () => (await store.get('app-a', group.groupId))?.participantIds.length === 3,
    );
  });
});
