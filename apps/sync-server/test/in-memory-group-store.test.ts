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
    expect(await store.addParticipant('app-b', ID, 'p', 10)).toBe('not_found');
    expect(await store.setPosition('app-b', ID, 1)).toBe(false);
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
    expect(results.filter((r) => r === 'ok')).toHaveLength(2);
    expect(results.filter((r) => r === 'full')).toHaveLength(3);
    expect((await store.get('app-a', ID))!.participantIds).toHaveLength(3);
    expect(await store.addParticipant('app-a', 'missing'.padEnd(43, 'x'), 'p', 3)).toBe(
      'not_found',
    );
  });

  it('treats re-adding a present participant as ok without duplicating it', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    expect(await store.addParticipant('app-a', ID, 'leader', 1)).toBe('ok');
    expect((await store.get('app-a', ID))!.participantIds).toEqual(['leader']);
  });

  it('removes participants and reports the remaining count', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record({ participantIds: ['leader', 'm1'] }));
    expect(await store.removeParticipant('app-a', ID, 'm1')).toEqual({ remaining: 1 });
    expect(await store.removeParticipant('app-a', ID, 'leader')).toEqual({ remaining: 0 });
  });

  it('sets the position and deletes groups', async () => {
    const store = new InMemoryGroupStore();
    await store.create(record());
    expect(await store.setPosition('app-a', ID, null)).toBe(true);
    expect((await store.get('app-a', ID))!.position).toEqual({ has: true, payload: null });
    await store.delete('app-a', ID);
    expect(await store.get('app-a', ID)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('has no way to list groups (AC20)', () => {
    expectTypeOf<keyof GroupStore>().toEqualTypeOf<
      'create' | 'get' | 'addParticipant' | 'removeParticipant' | 'setPosition' | 'delete'
    >();
  });
});
