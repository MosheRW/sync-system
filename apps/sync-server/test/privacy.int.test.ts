import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashApiKey } from '../src/apps/app-registry.js';
import { checkDevKeys } from '../src/config/dev-key.js';
import { createLogger } from '../src/logging/logger.js';
import { FailingStore } from './helpers/failing-store.js';
import { RawClient } from './helpers/raw-client.js';
import {
  KEY_A,
  KEY_B,
  type TestServer,
  TestClock,
  startTestServer,
} from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const SENTINEL = {
  badKey: 'SENTINEL-BADKEY-0123456789-0123456789-xyz',
  displayName: 'SENTINEL-DISPLAYNAME-Dana',
  payload: 'SENTINEL-PAYLOAD-chapter-7',
  metadata: 'SENTINEL-METADATA-book-title',
  closeReason: 'SENTINEL-CLOSE-REASON',
  internal: 'SENTINEL-INTERNAL-ERROR-MESSAGE',
  devKey: 'dev-only-insecure-api-key-change-me-please',
};

let ts: TestServer;
let store: FailingStore;
let clock: TestClock;
const groupIds: string[] = [];

beforeAll(async () => {
  store = new FailingStore();
  clock = new TestClock();
  ts = await startTestServer({
    store,
    now: clock.now,
    logLevel: 'trace',
    env: {
      MAX_LEADER_UPDATE_RATE_CEILING: '4',
      MAX_INBOUND_MESSAGES_PER_SECOND: '20',
      MAX_INBOUND_BURST: '20',
    },
    apps: [
      { namespace: 'app-a', apiKey: KEY_A, maxLeaderUpdatesPerSecond: 2, maxMessageBytes: 256 },
      { namespace: 'app-b', apiKey: KEY_B },
    ],
  });
});

afterAll(async () => {
  await ts.close();
});

describe('logs never contain personal or secret data (AC24, L5, L8)', () => {
  it('runs every flow with sentinel values', async () => {
    // Bad-key hello.
    const bad = await ts.connect();
    expect(await bad.hello({ apiKey: SENTINEL.badKey })).toMatchObject({ code: 'INVALID_API_KEY' });

    // Create with sentinel metadata and position, plus an extra displayName field.
    const leader = await ts.connectReady(KEY_A);
    leader.send({
      type: 'group.create',
      metadata: { title: SENTINEL.metadata },
      position: { at: SENTINEL.payload },
      displayName: SENTINEL.displayName,
    });
    const { groupId } = await leader.next('group.created');
    groupIds.push(groupId);

    // Join with a displayName extra field.
    const member = await ts.connectReady(KEY_A);
    member.send({ type: 'group.join', groupId, displayName: SENTINEL.displayName });
    await member.next('group.joined');

    // Update, then rate limited (app limit 2/s).
    leader.send({ type: 'position.update', position: { at: SENTINEL.payload } });
    await leader.next('position.ack');
    leader.send({ type: 'position.update', position: { at: SENTINEL.payload, n: 2 } });
    await leader.next('position.ack');
    leader.send({ type: 'position.update', position: { at: SENTINEL.payload, n: 3 } });
    expect(await leader.next('error')).toMatchObject({ code: 'RATE_LIMITED' });

    // Too large (app limit 256 bytes).
    leader.send({ type: 'position.update', position: SENTINEL.payload.repeat(20) });
    expect(await leader.next('error')).toMatchObject({ code: 'MESSAGE_TOO_LARGE' });

    // The member received the two accepted updates.
    await member.next('position.updated');
    await member.next('position.updated');

    // Not leader.
    member.send({ type: 'position.update', position: { at: SENTINEL.payload } });
    expect(await member.next('error')).toMatchObject({ code: 'NOT_LEADER' });

    // Malformed frame containing a sentinel.
    member.sendRaw(`{"type":"group.join","groupId":"${SENTINEL.payload}`);
    expect(await member.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });

    // Forced handler exception whose message holds a sentinel (L5).
    clock.advance(1000);
    store.failNext('setPosition', `boom ${SENTINEL.internal} ${SENTINEL.payload}`);
    leader.send({ type: 'position.update', position: { at: SENTINEL.payload } });
    expect(await leader.next('error')).toMatchObject({ code: 'INTERNAL_ERROR' });

    // Flood close.
    const flooder = await ts.connectReady(KEY_B);
    for (let i = 0; i < 40; i++) flooder.send({ type: 'group.join', groupId });
    expect((await flooder.closed()).code).toBe(4008);

    // Raw client: a close frame carrying a sentinel reason (L8).
    const raw = await RawClient.connect(ts.port);
    raw.writeFrame({
      opcode: 0x8,
      payload: Buffer.concat([Buffer.from([0x0f, 0xa0]), Buffer.from(SENTINEL.closeReason)]),
    });
    await raw.closed();

    // Disconnects with a client close reason.
    await member.close(4000, SENTINEL.closeReason);
    await leader.close(4000, SENTINEL.closeReason);
    await waitUntil(() => ts.server.stats().total === 0);

    // Dev key warning through the same kind of logger.
    checkDevKeys(
      [
        {
          namespace: 'dev-app',
          apiKeyHash: hashApiKey(SENTINEL.devKey),
          minAppVersion: '0.0.0',
          maxGroupSize: 30,
          maxLeaderUpdatesPerSecond: 5,
          maxMessageBytes: 4096,
          maxConnections: 1000,
          maxSessionMinutes: 180,
          inactivityLimitMinutes: 20,
        },
      ],
      'development',
      createLogger({ level: 'trace', destination: ts.logs }),
    );

    // Sanity: the flows really were logged at trace level.
    const events = ts.logs.events();
    for (const event of [
      'handshake_rejected',
      'handshake_ok',
      'group_created',
      'group_joined',
      'position_updated',
      'internal_error',
      'flood_closed',
      'ws_closed',
      'group_ended',
      'dev_api_key',
    ]) {
      expect(events, event).toContain(event);
    }
  });

  it('contains none of the sentinels, raw group IDs, keys or addresses', () => {
    const text = ts.logs.text;
    for (const [name, value] of Object.entries(SENTINEL)) {
      expect(text.includes(value), name).toBe(false);
    }
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain(KEY_A);
    expect(text).not.toContain(KEY_B);
    for (const groupId of groupIds) expect(text).not.toContain(groupId);
    for (const address of ['127.0.0.1', '::1', '::ffff:', 'localhost']) {
      expect(text, address).not.toContain(address);
    }
  });

  it('logs internal errors as name and frames only', () => {
    const record = ts.logs.records().find((r) => r.event === 'internal_error');
    expect(record).toMatchObject({ err: { name: 'Error' } });
    expect(Array.isArray((record?.err as { frames?: unknown }).frames)).toBe(true);
  });
});
