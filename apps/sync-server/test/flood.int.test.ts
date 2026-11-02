import { afterEach, describe, expect, it } from 'vitest';
import type { GroupRecord } from '../src/groups/group-store.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { parseEnv } from '../src/config/env.js';
import { maxQueuedInboundBytes, transportMaxPayload } from '../src/limits/constants.js';
import { rawByteLength } from '../src/ws/connection.js';
import { Opcode, RawClient, encodeFrame } from './helpers/raw-client.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, TestClock, startTestServer } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** 5 messages/s with a burst of 5; the leader ceiling must stay below the rate. */
const FLOOD_ENV = {
  MAX_LEADER_UPDATE_RATE_CEILING: '4',
  MAX_INBOUND_MESSAGES_PER_SECOND: '5',
  MAX_INBOUND_BURST: '5',
};

const DUPLICATE_HELLO = { type: 'hello', protocolVersion: 1, appVersion: '1.0.0', apiKey: KEY_A };

async function drainErrors(client: TestClient, count: number, code: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    expect(await client.next('error')).toMatchObject({ code });
  }
}

describe('inbound message limit (H3)', () => {
  it('closes with one TOO_MANY_MESSAGES and 4008 when the bucket is empty', async () => {
    const clock = new TestClock();
    ts = await startTestServer({ env: FLOOD_ENV, now: clock.now });
    const client = await ts.connectReady(); // the hello took token 1 of 5

    for (let i = 0; i < 4; i++) client.send(DUPLICATE_HELLO);
    await drainErrors(client, 4, 'ALREADY_AUTHENTICATED');

    // Frame 6 in the same tick: over the limit.
    for (let i = 0; i < 20; i++) client.send(DUPLICATE_HELLO);
    expect(await client.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
    expect(await client.closed()).toEqual({ code: 4008, reason: 'TOO_MANY_MESSAGES' });
    // No amplification: exactly one error frame for the whole flood.
    expect(client.pending).toBe(0);
  });

  it('counts invalid frames too', async () => {
    const clock = new TestClock();
    ts = await startTestServer({ env: FLOOD_ENV, now: clock.now });
    const client = await ts.connectReady();
    for (let i = 0; i < 4; i++) client.sendRaw('{not json');
    await drainErrors(client, 4, 'INVALID_MESSAGE');
    for (let i = 0; i < 10; i++) client.sendRaw('{not json');
    expect(await client.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
    expect((await client.closed()).code).toBe(4008);
  });

  it('counts NOT_LEADER updates and random joins', async () => {
    const clock = new TestClock();
    ts = await startTestServer({ env: FLOOD_ENV, now: clock.now });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const { groupId } = await leader.next('group.created');

    const member = await ts.connectReady();
    member.send({ type: 'group.join', groupId }); // tokens used: hello, join
    await member.next('group.joined');
    for (let i = 0; i < 3; i++) member.send({ type: 'position.update', position: i });
    await drainErrors(member, 3, 'NOT_LEADER');
    for (let i = 0; i < 5; i++) member.send({ type: 'position.update', position: i });
    expect(await member.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
    expect((await member.closed()).code).toBe(4008);

    const joiner = await ts.connectReady();
    for (let i = 0; i < 4; i++) joiner.send({ type: 'group.join', groupId: 'R'.repeat(43) });
    await drainErrors(joiner, 4, 'GROUP_NOT_FOUND');
    for (let i = 0; i < 5; i++) joiner.send({ type: 'group.join', groupId: 'R'.repeat(43) });
    expect(await joiner.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
    expect((await joiner.closed()).code).toBe(4008);
  });

  it('refills over time, so a client under the rate stays connected', async () => {
    const clock = new TestClock();
    ts = await startTestServer({ env: FLOOD_ENV, now: clock.now });
    const client = await ts.connectReady();
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 4; i++) client.send(DUPLICATE_HELLO);
      await drainErrors(client, 4, 'ALREADY_AUTHENTICATED');
      clock.advance(1000);
    }
    expect(client.isClosed).toBe(false);
  });

  it('does not affect another connection during a flood', async () => {
    const clock = new TestClock();
    ts = await startTestServer({ env: FLOOD_ENV, now: clock.now });
    const flooder = await ts.connectReady();
    const bystander = await ts.connectReady();

    for (let i = 0; i < 50; i++) flooder.send(DUPLICATE_HELLO);
    expect((await flooder.closed()).code).toBe(4008);

    bystander.send({ ...DUPLICATE_HELLO, reqId: 'still-here' });
    expect(await bystander.next('error')).toMatchObject({
      code: 'ALREADY_AUTHENTICATED',
      reqId: 'still-here',
    });
    expect(bystander.isClosed).toBe(false);
    await waitUntil(() => ts!.server.stats().total === 1);
  });

  it('applies before the handshake', async () => {
    const clock = new TestClock();
    ts = await startTestServer({ env: FLOOD_ENV, now: clock.now });
    const raw = await RawClient.connect(ts.port);
    await raw.waitForType('welcome');
    // Six frames in one TCP write: all are counted before any is processed.
    const frames = Array.from({ length: 6 }, () =>
      encodeFrame({ opcode: Opcode.TEXT, payload: Buffer.from('x') }),
    );
    raw.writeRaw(Buffer.concat(frames));
    await raw.closed();
    expect(raw.closeCode).toBe(4008);
    const errors = raw.messages.filter((m) => (m as { type?: string }).type === 'error');
    expect(errors).toEqual([expect.objectContaining({ code: 'TOO_MANY_MESSAGES' })]);
  });

  it('closes with 4008 when more than 32 messages are queued', async () => {
    const clock = new TestClock();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new InMemoryGroupStore();
    const blockingStore = Object.assign(Object.create(store) as InMemoryGroupStore, {
      create: async (group: GroupRecord) => {
        await gate;
        return store.create(group);
      },
    });
    // Default inbound limits (20/s, burst 40) are not reached by 34 frames.
    ts = await startTestServer({ store: blockingStore, now: clock.now });
    const client = await ts.connectReady();
    try {
      // The first create blocks in the store; 31 more fill the queue to 32.
      for (let i = 0; i < 32; i++) client.send({ type: 'group.create', metadata: {} });
      await sleep(50);
      expect(client.isClosed).toBe(false);
      client.send({ type: 'group.create', metadata: {} });
      expect(await client.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
      expect((await client.closed()).code).toBe(4008);
    } finally {
      release();
    }
  });
});

/** A store whose create() waits for `release()`, so later frames stay queued. */
function blockingStore(): { store: InMemoryGroupStore; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = new InMemoryGroupStore();
  const store = Object.assign(Object.create(inner) as InMemoryGroupStore, {
    create: async (group: GroupRecord) => {
      await gate;
      return inner.create(group);
    },
  });
  return { store, release };
}

describe('queued inbound bytes cap (#7 L3)', () => {
  const ceiling = parseEnv({}).maxMessageSizeCeiling;
  const maxPayload = transportMaxPayload(ceiling);
  const cap = maxQueuedInboundBytes(ceiling);
  const CREATE = { type: 'group.create', metadata: {} };
  const createBytes = Buffer.byteLength(JSON.stringify(CREATE));

  it('is 4 x the transport frame limit (AC7)', () => {
    expect(cap).toBe(4 * maxPayload);
  });

  it('keeps a queue exactly at the cap open and closes on the next byte (AC8)', async () => {
    const { store, release } = blockingStore();
    ts = await startTestServer({ store, now: new TestClock().now });
    const client = await ts.connectReady();
    try {
      // The create blocks in the store and still counts while it is handled.
      client.send(CREATE);
      for (let i = 0; i < 3; i++) client.sendRaw('x'.repeat(maxPayload));
      client.sendRaw('x'.repeat(cap - createBytes - 3 * maxPayload));
      await sleep(50);
      expect(client.isClosed).toBe(false);

      // Six frames are far below the 32-message cap: only the bytes count.
      client.sendRaw('x');
      expect(await client.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
      expect(await client.closed()).toEqual({ code: 4008, reason: 'TOO_MANY_MESSAGES' });
      expect(client.pending).toBe(0);
    } finally {
      release();
    }
  });

  it('closes when a large frame would go over the cap (AC8)', async () => {
    const { store, release } = blockingStore();
    ts = await startTestServer({ store, now: new TestClock().now });
    const client = await ts.connectReady();
    try {
      client.send(CREATE);
      for (let i = 0; i < 3; i++) client.sendRaw('x'.repeat(maxPayload));
      await sleep(50);
      expect(client.isClosed).toBe(false);
      client.sendRaw('x'.repeat(maxPayload));
      expect(await client.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
      expect((await client.closed()).code).toBe(4008);
    } finally {
      release();
    }
  });

  it('releases the bytes once frames are handled', async () => {
    const { store, release } = blockingStore();
    ts = await startTestServer({ store, now: new TestClock().now });
    const client = await ts.connectReady();
    client.send(CREATE);
    for (let i = 0; i < 3; i++) client.sendRaw('x'.repeat(maxPayload));
    await sleep(50);
    release();
    await client.next('group.created');
    for (let i = 0; i < 3; i++) await client.next('error');
    // The queue is empty again, so four more large frames fit one by one.
    for (let i = 0; i < 4; i++) {
      client.sendRaw('x'.repeat(maxPayload));
      expect(await client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    }
    expect(client.isClosed).toBe(false);
  });
});

describe('rawByteLength (#7 L3)', () => {
  it('measures a Buffer, an ArrayBuffer and fragments', () => {
    expect(rawByteLength(Buffer.from('abc'))).toBe(3);
    expect(rawByteLength(new ArrayBuffer(7))).toBe(7);
    expect(rawByteLength([Buffer.from('ab'), Buffer.from('cde')])).toBe(5);
  });
});

describe('control frames count toward the inbound limit (H3)', () => {
  const ping = (payload = 'p') =>
    encodeFrame({ opcode: Opcode.PING, payload: Buffer.from(payload) });

  it('closes a ping flood before the handshake with 4008', async () => {
    ts = await startTestServer({ env: FLOOD_ENV, now: new TestClock().now });
    const raw = await RawClient.connect(ts.port);
    await raw.waitForType('welcome');
    // Six pings in one TCP write: one over the burst of 5.
    raw.writeRaw(Buffer.concat(Array.from({ length: 6 }, () => ping())));
    await raw.closed();
    expect(raw.closeCode).toBe(4008);
    // Only the pings within budget were answered.
    expect(raw.pongs.length).toBeLessThanOrEqual(5);
  });

  it('closes a ping flood after the handshake with 4008', async () => {
    ts = await startTestServer({ env: FLOOD_ENV, now: new TestClock().now });
    const client = await ts.connectReady(); // the hello took token 1 of 5
    for (let i = 0; i < 20; i++) client.ws.ping();
    expect(await client.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
    expect(await client.closed()).toEqual({ code: 4008, reason: 'TOO_MANY_MESSAGES' });
  });

  it('closes a pong flood after the handshake with 4008', async () => {
    ts = await startTestServer({ env: FLOOD_ENV, now: new TestClock().now });
    const client = await ts.connectReady();
    for (let i = 0; i < 20; i++) client.ws.pong();
    expect(await client.next('error')).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
    expect((await client.closed()).code).toBe(4008);
  });

  it('still answers a ping within budget with the echoed payload', async () => {
    ts = await startTestServer({ env: FLOOD_ENV, now: new TestClock().now });
    const raw = await RawClient.connect(ts.port);
    await raw.waitForType('welcome');
    raw.writeRaw(ping('echo-me'));
    await waitUntil(() => raw.pongs.length === 1);
    expect(raw.pongs[0]!.toString()).toBe('echo-me');
    raw.destroy();
  });
});

describe('heartbeat with manual pongs (H2)', () => {
  it('keeps a peer that echoes the ping payload and drops one that does not', async () => {
    ts = await startTestServer({ heartbeatMs: 100 });
    const alive = await RawClient.connect(ts.port);
    const dead = await RawClient.connect(ts.port);
    dead.autoPong = false;
    await alive.waitForType('welcome');
    await dead.waitForType('welcome');
    await dead.closed();
    await sleep(100);
    expect(alive.ended).toBe(false);
    alive.destroy();
  });
});
