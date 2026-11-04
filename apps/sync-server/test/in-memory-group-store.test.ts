import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GroupRecord, GroupStore } from '../src/groups/group-store.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';

const ID = 'G'.repeat(43);

function record(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    id: ID,
    appNamespace: 'app-a',
    metadata: { contentId: 'c' },
    position: { has: false },
    leaderId: 'leader',
    participantIds: ['leader'],
    createdAt: 1,
    lastActivityAt: 1,
    leaderOnline: true,
    blockList: [],
    joinMethods: ['A', 'D'],
    codes: { generation: 1, ticketGeneration: 1, groupCode: '123456', doorCode: '654321' },
    ...overrides,
  };
}

describe('InMemoryGroupStore', () => {
  it('creates and gets a group by namespace and ID', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    expect(await store.get('app-a', ID)).toEqual(record());
    expect(store.size).toBe(1);
  });

  it('never finds a group through another namespace (AC18)', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    expect(await store.get('app-b', ID)).toBeUndefined();
    expect(await store.addParticipant('app-b', ID, 'p', 10)).toEqual({ status: 'not_found' });
    expect(await store.setPosition('app-b', ID, 1, 5)).toBe(false);
    expect(await store.setLeaderOnline('app-b', ID, false)).toBeUndefined();
    expect(await store.removeParticipant('app-b', ID, 'leader')).toBeUndefined();
    await store.delete('app-b', ID);
    expect(store.size).toBe(1);
  });

  it('returns copies: callers cannot mutate stored state', async () => {
    const store = new InMemoryGroupStore();
    const original = record();
    await store.create(original);
    original.participantIds.push('sneaky');
    const copy = (await store.get('app-a', ID))!;
    copy.participantIds.push('also-sneaky');
    copy.leaderId = 'x';
    expect(await store.get('app-a', ID)).toEqual(record());
  });

  it('shares opaque values by reference without cloning', async () => {
    const store = new InMemoryGroupStore();
    const metadata = { deep: { value: [1, 2, 3] } };
    await store.create(record({ metadata }));
    expect((await store.get('app-a', ID))!.metadata).toBe(metadata);
  });

  it('adds participants atomically up to maxSize (AC21)', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((p) => store.addParticipant('app-a', ID, p, 3)),
    );
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'full')).toHaveLength(3);
    expect((await store.get('app-a', ID))!.participantIds).toHaveLength(3);
    expect(await store.addParticipant('app-a', 'missing'.padEnd(43, 'x'), 'p', 3)).toEqual({
      status: 'not_found',
    });
  });

  it('treats re-adding a present participant as ok without duplicating it', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    expect(await store.addParticipant('app-a', ID, 'leader', 1)).toEqual({
      status: 'ok',
      group: record(),
    });
    expect((await store.get('app-a', ID))!.participantIds).toEqual(['leader']);
  });

  it('returns a snapshot including the new participant from the same insert', async () => {
    const store = new InMemoryGroupStore();
    const position = { has: true, payload: 7 } as const;
    await store.create(record({ position }));
    const added = await store.addParticipant('app-a', ID, 'm1', 10);
    expect(added).toEqual({
      status: 'ok',
      group: record({ position, participantIds: ['leader', 'm1'] }),
    });
    // A copy: changing the snapshot does not touch the stored group.
    if (added.status === 'ok') added.group.participantIds.push('sneaky');
    expect((await store.get('app-a', ID))!.participantIds).toEqual(['leader', 'm1']);
  });

  it('removes members and reports how many are still connected (#5 AC22)', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record({ participantIds: ['leader', 'm1', 'm2'] }));
    expect(await store.removeParticipant('app-a', ID, 'm1')).toEqual({ connected: 2 });
    await store.setLeaderOnline('app-a', ID, false);
    expect(await store.removeParticipant('app-a', ID, 'm2')).toEqual({ connected: 0 });
  });

  it('keeps the leader slot reserved while the leader is offline (architecture 3)', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record({ participantIds: ['leader', 'm1'] }));
    const frozen = await store.setLeaderOnline('app-a', ID, false);
    expect(frozen).toMatchObject({ leaderOnline: false, participantIds: ['leader', 'm1'] });
    expect(await store.removeParticipant('app-a', ID, 'leader')).toEqual({ connected: 1 });
    expect(await store.addParticipant('app-a', ID, 'm2', 2)).toEqual({ status: 'full' });
  });

  it('records leader activity when the leader comes back or sets a position (#5 AC12)', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    await store.setLeaderOnline('app-a', ID, false, 50);
    expect((await store.get('app-a', ID))!.lastActivityAt).toBe(1);
    expect(await store.setLeaderOnline('app-a', ID, true, 60)).toMatchObject({
      leaderOnline: true,
      lastActivityAt: 60,
    });
    await store.setPosition('app-a', ID, 'p', 70);
    expect((await store.get('app-a', ID))!.lastActivityAt).toBe(70);
  });

  it('sets the position and deletes groups', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    expect(await store.setPosition('app-a', ID, null, 2)).toBe(true);
    expect((await store.get('app-a', ID))!.position).toEqual({ has: true, payload: null });
    await store.delete('app-a', ID);
    expect(await store.get('app-a', ID)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('creates a group only if it is absent, atomically (#5 AC27)', async () => {
    const store = new InMemoryGroupStore();
    const results = await Promise.all([
      store.createIfAbsent(record({ leaderId: 'a', participantIds: ['a'] })),
      store.createIfAbsent(record({ leaderId: 'b', participantIds: ['b'] })),
    ]);
    expect(results).toEqual(['created', 'exists']);
    expect((await store.get('app-a', ID))!.leaderId).toBe('a');
    expect(await store.createIfAbsent(record({ appNamespace: 'app-b' }))).toBe('created');
  });

  it('replaces the block list and removes listed members atomically (#5 AC26)', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record({ participantIds: ['leader', 'm1', 'm2'] }));
    expect(await store.setBlockList('app-a', ID, ['m1', 'x', 'leader'])).toEqual({
      removed: ['m1'],
    });
    const stored = (await store.get('app-a', ID))!;
    expect(stored.participantIds).toEqual(['leader', 'm2']);
    expect(stored.blockList).toEqual(['m1', 'x', 'leader']);
    expect(await store.addParticipant('app-a', ID, 'm1', 10)).toEqual({ status: 'blocked' });
    expect(await store.setBlockList('app-b', ID, [])).toBeUndefined();
  });

  it('has no way to list groups (AC20)', () => {
    expectTypeOf<keyof GroupStore>().toEqualTypeOf<
      | 'create'
      | 'createIfAbsent'
      | 'get'
      | 'addParticipant'
      | 'removeParticipant'
      | 'setLeaderOnline'
      | 'setPosition'
      | 'setBlockList'
      | 'setCodes'
      | 'delete'
    >();
  });

  it('replaces the join codes and copies them on read (#10)', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    const codes = { generation: 2, ticketGeneration: 1, groupCode: '123456', doorCode: '111111' };
    const updated = await store.setCodes('app-a', ID, codes);
    expect(updated?.codes).toEqual(codes);
    expect(updated?.codes).not.toBe(codes);
    const read = (await store.get('app-a', ID))!;
    expect(read.codes).toEqual(codes);
    expect(read.joinMethods).toEqual(['A', 'D']);
    expect(await store.setCodes('app-b', ID, codes)).toBeUndefined();
  });
});
