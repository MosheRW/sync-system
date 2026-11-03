import { codesOf } from './helpers/groups.js';
import { afterEach, describe, expect, it } from 'vitest';
import { RawClient } from './helpers/raw-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('slow consumers (H2)', () => {
  it('terminates a member that stops reading; other members keep receiving', async () => {
    ts = await startTestServer({
      env: {
        // Smallest allowed buffer limit: 4 * MAX_MESSAGE_SIZE_CEILING.
        MAX_BUFFERED_BYTES: String(4 * 16384),
        // High update rates so the loop below is bounded by the buffer only.
        MAX_LEADER_UPDATE_RATE_CEILING: '100000',
        MAX_INBOUND_MESSAGES_PER_SECOND: '200000',
        MAX_INBOUND_BURST: '200000',
      },
      apps: [
        {
          namespace: 'app-a',
          apiKey: KEY_A,
          maxLeaderUpdatesPerSecond: 100000,
          maxMessageBytes: 16384,
        },
      ],
    });

    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const { codes } = await leader.next('group.created');

    const normal = await ts.connectReady();
    normal.send({ type: 'group.joinByCode', ...codesOf(codes) });
    await normal.next('group.joined');

    const slow = await RawClient.connect(ts.port);
    slow.sendJson({ type: 'hello', protocolVersion: 1, appVersion: '1.0.0', apiKey: KEY_A });
    await slow.waitForType('hello.ok');
    slow.sendJson({ type: 'group.joinByCode', ...codesOf(codes) });
    await slow.waitForType('group.joined');
    slow.pause();
    expect(ts.server.stats().total).toBe(3);

    const payload = 'x'.repeat(16_000);
    let acked = 0;
    let received = 0;
    // Bounded: about 48 MB at most, far beyond any loopback socket buffer.
    for (let i = 0; i < 3000 && ts.server.stats().total === 3; i++) {
      leader.send({ type: 'position.update', position: { i, payload } });
      await leader.next('position.ack');
      acked += 1;
      // The normal member reads everything.
      while (normal.pending > 0) {
        await normal.next('position.updated');
        received += 1;
      }
    }

    await waitUntil(() => ts!.server.stats().total === 2, 5000, 'slow member terminated');
    while (received < acked) {
      await normal.next('position.updated');
      received += 1;
    }
    expect(received).toBe(acked);
    expect(normal.isClosed).toBe(false);
    expect(ts.logs.events()).toContain('slow_consumer_terminated');

    // The group still works for the remaining member.
    leader.send({ type: 'position.update', position: 'after' });
    await leader.next('position.ack');
    expect((await normal.next('position.updated')).position).toBe('after');
    slow.destroy();
  }, 30_000);
});
