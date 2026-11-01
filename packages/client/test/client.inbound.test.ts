import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClientError } from '../src/errors.js';
import { LIMITS, PARTICIPANT_ID, connectedClient, makeClient } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('inbound validation (AC10)', () => {
  it('ignores an unknown type: no event, no error, still connected', async () => {
    const debug = vi.fn();
    const { client, socket } = await connectedClient({ logger: { debug } });
    const events = vi.fn();
    client.on('error', events);
    client.on('positionUpdated', events);
    client.on('groupEnded', events);
    const before = client.getSnapshot();
    socket.receive({ type: 'leader.offline', groupId: 'g' });
    expect(events).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toBe(before);
    expect(debug).toHaveBeenCalledWith('unknown_message', { type: 'leader.offline' });
    client.close();
  });

  it('logs an unsafe unknown type as "(invalid)" (L2)', async () => {
    const debug = vi.fn();
    const { client, socket } = await connectedClient({ logger: { debug } });
    socket.receive({ type: '<script>' });
    expect(debug).toHaveBeenCalledWith('unknown_message', { type: '(invalid)' });
    client.close();
  });

  it.each<[string, unknown]>([
    ['a known type with a bad shape', { type: 'position.updated', groupId: 5 }],
    ['binary', new ArrayBuffer(8)],
    ['not JSON', '{nope'],
    ['too deep', `${'['.repeat(70)}${']'.repeat(70)}`],
    [
      'too long',
      JSON.stringify({ type: 'position.updated', groupId: 'g', position: 'x'.repeat(20_000) }),
    ],
  ])('emits INVALID_SERVER_MESSAGE for %s and stays connected', async (_name, frame) => {
    const { client, socket } = await connectedClient();
    const errors: SyncClientError[] = [];
    const typed = vi.fn();
    client.on('error', (e) => errors.push(e));
    client.on('positionUpdated', typed);
    socket.receive(frame);
    expect(errors.map((e) => e.code)).toEqual(['INVALID_SERVER_MESSAGE']);
    expect(typed).not.toHaveBeenCalled();
    expect(client.getState().status).toBe('connected');
    client.close();
  });

  it('ends the attempt on an invalid frame before hello.ok', () => {
    const client = makeClient();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    void client.connect().catch(() => {});
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'welcome', protocolVersion: 'one' });
    expect(errors.map((e) => e.code)).toEqual(['INVALID_SERVER_MESSAGE']);
    expect(socket.closeCalls).toHaveLength(1);
    client.close();
  });

  it('ends the attempt when the first message is not welcome', () => {
    const client = makeClient();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    void client.connect().catch(() => {});
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'position.ack' });
    expect(errors.map((e) => e.code)).toEqual(['INVALID_SERVER_MESSAGE']);
    expect(socket.closeCalls).toHaveLength(1);
    client.close();
  });
});

describe('handshake messages after connected (L8)', () => {
  it('ignores a second welcome or hello.ok and keeps participantId and limits', async () => {
    const { client, socket } = await connectedClient();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    const before = client.getSnapshot();
    socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    socket.receive({
      type: 'hello.ok',
      participantId: 'other',
      limits: { ...LIMITS, maxMessageBytes: 100_000 },
    });
    expect(errors.map((e) => e.code)).toEqual(['INVALID_SERVER_MESSAGE', 'INVALID_SERVER_MESSAGE']);
    expect(client.getSnapshot()).toBe(before);
    expect(client.getState()).toMatchObject({ participantId: PARTICIPANT_ID, limits: LIMITS });
    client.close();
  });
});
