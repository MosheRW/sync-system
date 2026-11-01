import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { KEY_A, KEY_B, type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('max group size (AC21)', () => {
  it('counts the leader and rejects the join over the limit with GROUP_FULL', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      store,
      apps: [
        { namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 3 },
        { namespace: 'app-b', apiKey: KEY_B },
      ],
    });
    const { groupId } = await createGroupWithMembers(ts, 2);

    const extra = await ts.connectReady();
    extra.send({ type: 'group.join', groupId, reqId: 'full' });
    expect(await extra.next('error')).toEqual({
      type: 'error',
      reqId: 'full',
      code: 'GROUP_FULL',
      message: 'Group is full',
      details: { maxGroupSize: 3 },
    });
    expect((await store.get('app-a', groupId))?.participantIds).toHaveLength(3);
    // The rejected client stays connected and groupless.
    extra.send({ type: 'group.create', metadata: {} });
    expect((await extra.next('group.created')).role).toBe('leader');
  });

  it('uses the app value, defaulting to 30', async () => {
    ts = await startTestServer();
    const client = await ts.connect();
    const ok = await client.hello({ apiKey: KEY_A });
    expect(ok.type === 'hello.ok' && ok.limits.maxGroupSize).toBe(30);
  });
});
