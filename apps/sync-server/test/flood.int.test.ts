import { afterEach, describe, expect, it } from 'vitest';
import type { GroupRecord } from '../src/groups/group-store.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
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
