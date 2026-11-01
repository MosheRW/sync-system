import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import type { LogFields, SyncClientLogger } from '../src/logger.js';
import type { SyncClientOptions } from '../src/options.js';
import { PARTICIPANT_ID, TEST_API_KEY, makeClient, serverHandshake } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

const GROUP_ID = 'G'.repeat(43);
const MARKER = 'PAYLOAD-MARKER-7f3a';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Connect, create, update, a member join with a marker, a reconnect, then a fatal error. */
async function fullFlow(extra: Partial<SyncClientOptions> = {}): Promise<SyncClient> {
  const client = makeClient(extra);
  client.on('error', () => {});
  const connecting = client.connect();
  serverHandshake(FakeWebSocket.last);
  await connecting;
  let socket = FakeWebSocket.last;

  const creating = client.createGroup({ secret: MARKER }, { page: MARKER });
  socket.receive({
    type: 'group.created',
    reqId: socket.lastMessage().reqId,
    groupId: GROUP_ID,
    participantId: PARTICIPANT_ID,
    role: 'leader',
  });
  await creating;
  client.updatePosition({ page: MARKER });
  socket.receive({
    type: 'error',
    reqId: socket.lastMessage().reqId,
    code: 'RATE_LIMITED',
    message: `server text ${MARKER}`,
  });
  socket.receive({ type: `unknown.${MARKER}` });

  socket.serverClose(1006);
  vi.advanceTimersByTime(10_000);
  socket = FakeWebSocket.last;
  socket.open();
  socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
  socket.receive({
    type: 'error',
    reqId: socket.lastMessage().reqId,
    code: 'INVALID_API_KEY',
    message: MARKER,
  });
  return client;
}

describe('logging (AC32)', () => {
  it('writes nothing to the console by default', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    await fullFlow();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('never passes the key, group ID, participant ID, URL, payloads or server text to the logger', async () => {
    const entries: Array<[string, string, LogFields | undefined]> = [];
    const record =
      (level: string) =>
      (event: string, fields?: LogFields): void => {
        entries.push([level, event, fields]);
      };
    const logger: SyncClientLogger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
    await fullFlow({ logger });
    expect(entries.length).toBeGreaterThan(5);
    const text = JSON.stringify(entries);
    for (const secret of [TEST_API_KEY, GROUP_ID, PARTICIPANT_ID, MARKER, '127.0.0.1']) {
      expect(text).not.toContain(secret);
    }
    for (const [, , fields] of entries) {
      for (const value of Object.values(fields ?? {})) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });
});
