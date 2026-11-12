import { describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { ID, groupStoreContract, record } from './contracts/group-store.js';

groupStoreContract('InMemoryGroupStore', {
  make: () => {
    const store = new InMemoryGroupStore();
    return Promise.resolve({ store, count: () => Promise.resolve(store.size) });
  },
});

describe('InMemoryGroupStore', () => {
  it('shares opaque values by reference without cloning', async () => {
    const store = new InMemoryGroupStore();
    const metadata = { deep: { value: [1, 2, 3] } };
    await store.create(record({ metadata }));
    expect((await store.get('app-a', ID))!.metadata).toBe(metadata);
  });
});
