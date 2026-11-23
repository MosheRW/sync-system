import type { JsonValue } from '@mosherw/sync-system-protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SyncClientError } from '../../src/errors.js';
import { closeClients, newClient } from '../helpers/int.js';
import { KEY_A, type RealServer, startRealServer } from '../helpers/real-server.js';
import { sleep, waitUntil } from '../helpers/wait.js';
import { joinCreated } from '../helpers/join.js';

let server: RealServer;

beforeAll(async () => {
  server = await startRealServer({
    apps: [{ namespace: 'app-a', apiKey: KEY_A, maxLeaderUpdatesPerSecond: 5 }],
  });
});

afterEach(() => {
  closeClients();
});

afterAll(async () => {
  await server.close();
});

describe('leader throttling against the real server (AC21)', () => {
  it('50 updates in 1 s at 5/s: no RATE_LIMITED, and the member ends on the last value', async () => {
    const { client: leader } = newClient(server.url);
    const { client: member } = newClient(server.url);
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({});
    await joinCreated(member, created);

    const errors: SyncClientError[] = [];
    leader.on('error', (e) => errors.push(e));
    let last: JsonValue | undefined;
    member.on('positionUpdated', (e) => {
      last = e.position;
    });

    for (let i = 0; i < 50; i += 1) {
      leader.updatePosition({ page: i });
      await sleep(20);
    }
    await waitUntil(() => JSON.stringify(last) === JSON.stringify({ page: 49 }), 5000, 'last page');
    await sleep(300);
    expect(errors.filter((e) => e.code === 'RATE_LIMITED')).toEqual([]);
    expect(last).toEqual({ page: 49 });
  });
});
