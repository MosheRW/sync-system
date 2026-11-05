import { type GroupStore, connectedCount } from '../../src/groups/group-store.js';
import type { ManualScheduler } from './manual-scheduler.js';
import { waitUntil } from './wait.js';

/** The default `disconnectGraceSeconds` (#13 AC1), ms. */
export const GRACE_MS = 30_000;

/** The group is held: in memory, paused, and nobody connected (#13 Q-G). */
export async function isHeld(store: GroupStore, groupId: string, namespace = 'app-a') {
  const record = await store.get(namespace, groupId);
  return (
    record !== undefined &&
    record.pause !== undefined &&
    !record.leaderOnline &&
    connectedCount(record) === 0
  );
}

/**
 * Waits until the emptied group is held, then lets the hold run out, so it
 * ends `empty` (#13 Q-G, RC21), and waits until it left memory.
 */
export async function expireHold(
  scheduler: ManualScheduler,
  store: GroupStore,
  groupId: string,
  namespace = 'app-a',
): Promise<void> {
  await waitUntil(
    async () =>
      (await isHeld(store, groupId, namespace)) ||
      (await store.get(namespace, groupId)) === undefined,
    2000,
    'held group',
  );
  scheduler.advance(GRACE_MS);
  await waitUntil(
    async () => (await store.get(namespace, groupId)) === undefined,
    2000,
    'group ended',
  );
}
