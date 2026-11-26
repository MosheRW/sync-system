import { afterEach, describe, expect, it } from 'vitest';
import {
  Heartbeat,
  type HeartbeatTarget,
  heartbeatPong,
  heartbeatTick,
} from '../src/ws/heartbeat.js';
import { Opcode, RawClient } from './helpers/raw-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

class FakeTarget implements HeartbeatTarget {
  awaitingPong = false;
  pingPayload: Buffer | undefined;
  lastBufferedAmount = 0;
  bufferedAmount = 0;
  pings = 0;
  lastPing: Buffer = Buffer.alloc(0);
  terminated = false;
  ping(payload: Buffer): void {
    this.pings += 1;
    this.lastPing = payload;
  }
  /** Answers the outstanding ping correctly. */
  pong(): void {
    heartbeatPong(this, this.lastPing);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('heartbeatTick (H2, AC17)', () => {
  it('pings a healthy socket and keeps it while it answers', () => {
    const target = new FakeTarget();
    for (let i = 0; i < 5; i++) {
      expect(heartbeatTick(target)).toBe('pinged');
      target.pong();
    }
    expect(target.pings).toBe(5);
    expect(target.terminated).toBe(false);
  });

  it('terminates a socket whose ping is still outstanding', () => {
    const target = new FakeTarget();
    heartbeatTick(target);
    expect(heartbeatTick(target)).toBe('no_pong');
    expect(target.terminated).toBe(true);
  });

  it('ignores unsolicited pongs', () => {
    const target = new FakeTarget();
    heartbeatTick(target);
    // Pongs that do not echo the outstanding ping payload do not count.
    heartbeatPong(target, Buffer.alloc(0));
    heartbeatPong(target, Buffer.from('guess-me'));
    expect(target.awaitingPong).toBe(true);
    expect(heartbeatTick(target)).toBe('no_pong');
  });

  it('does not let a pong pre-pay the next ping', () => {
    const target = new FakeTarget();
    heartbeatTick(target);
    target.pong();
    target.pong(); // repeated: nothing outstanding any more
    heartbeatTick(target);
    expect(heartbeatTick(target)).toBe('no_pong');
  });

  it('uses a fresh random payload for every ping', () => {
    const target = new FakeTarget();
    heartbeatTick(target);
    const first = target.lastPing;
    target.pong();
    heartbeatTick(target);
    expect(target.lastPing.length).toBe(8);
    expect(target.lastPing.equals(first)).toBe(false);
  });

  it('terminates a socket whose outbound buffer did not drop between ticks', () => {
    const target = new FakeTarget();
    target.bufferedAmount = 1000;
    expect(heartbeatTick(target)).toBe('pinged');
    target.pong();
    expect(heartbeatTick(target)).toBe('stuck_buffer');
    expect(target.terminated).toBe(true);
  });

  it('keeps a socket whose buffer is draining', () => {
    const target = new FakeTarget();
    target.bufferedAmount = 1000;
    heartbeatTick(target);
    target.pong();
    target.bufferedAmount = 400;
    expect(heartbeatTick(target)).toBe('pinged');
    target.pong();
    target.bufferedAmount = 0;
    expect(heartbeatTick(target)).toBe('pinged');
    expect(target.terminated).toBe(false);
  });

  it('reports terminations from the interval loop', () => {
    const healthy = new FakeTarget();
    const dead = new FakeTarget();
    dead.awaitingPong = true;
    const results: string[] = [];
    const heartbeat = new Heartbeat(
      1000,
      () => [healthy, dead],
      (r) => results.push(r),
    );
    heartbeat.tick();
    expect(results).toEqual(['no_pong']);
    expect(healthy.terminated).toBe(false);
  });
});

// The helper waits of one test add up to more than Vitest's 5 s default, so a
// slow machine would fail with an anonymous timeout (#80).
describe('heartbeat on real sockets', { timeout: 15_000 }, () => {
  let ts: TestServer | undefined;

  afterEach(async () => {
    await ts?.close();
    ts = undefined;
  });

  async function readyRaw(server: TestServer): Promise<RawClient> {
    const raw = await RawClient.connect(server.port);
    raw.sendJson({ type: 'hello', protocolVersion: 1, appVersion: '1.0.0', apiKey: KEY_A });
    await raw.waitForType('hello.ok');
    return raw;
  }

  it('keeps a client that answers pings', async () => {
    ts = await startTestServer({ heartbeatMs: 40 });
    const client = await ts.connectReady();
    await sleep(250);
    expect(client.isClosed).toBe(false);
  });

  it('terminates a peer that never answers pings', async () => {
    ts = await startTestServer({ heartbeatMs: 40 });
    const raw = await readyRaw(ts);
    raw.autoPong = false;
    await waitUntil(() => ts!.server.stats().total === 0, 2000, 'dead peer terminated');
    expect(ts.logs.events()).toContain('heartbeat_terminated');
  });

  it('is not fooled by unsolicited pongs from a peer that ignores pings', async () => {
    ts = await startTestServer({ heartbeatMs: 40 });
    const raw = await readyRaw(ts);
    raw.autoPong = false;
    const timer = setInterval(() => {
      if (!raw.ended) raw.writeFrame({ opcode: Opcode.PONG });
    }, 10);
    try {
      await waitUntil(() => ts!.server.stats().total === 0, 2000, 'peer terminated');
    } finally {
      clearInterval(timer);
    }
  });
});
