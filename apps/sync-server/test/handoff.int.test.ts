import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('handoff mode at creation (#13 AC3)', () => {
  it('stores auto, frozen or the app default; refuses an unknown mode', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      store,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, defaultHandoff: 'frozen' }],
    });
    const leader = await ts.connectReady();
    const modes: Array<[string | undefined, string]> = [
      ['auto', 'auto'],
      ['frozen', 'frozen'],
      [undefined, 'frozen'],
    ];
    for (const [handoff, stored] of modes) {
      const client = await ts.connectReady();
      client.send({ type: 'group.create', metadata: {}, ...(handoff ? { handoff } : {}) });
      const created = await client.next('group.created');
      expect((await store.get('app-a', created.groupId))?.handoff).toBe(stored);
    }
    leader.send({ type: 'group.create', reqId: 'x', metadata: {}, handoff: 'manual' });
    expect(await leader.next('error')).toMatchObject({ reqId: 'x', code: 'INVALID_MESSAGE' });
    expect(store.size).toBe(3);
  });
});
