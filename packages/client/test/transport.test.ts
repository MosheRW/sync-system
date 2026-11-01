import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_LIMIT_BOUNDS,
  PRE_HANDSHAKE_MAX_CHARS,
  findOutOfBoundsLimit,
  maxInboundChars,
} from '../src/limits.js';
import { type InboundFrame, Transport, decodeFrame } from '../src/transport.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

afterEach(() => {
  FakeWebSocket.reset();
});

function nested(depth: number): string {
  return '['.repeat(depth) + ']'.repeat(depth);
}

describe('decodeFrame (AC10)', () => {
  it('returns a validated known message, opaque fields by reference', () => {
    const frame = decodeFrame(
      JSON.stringify({ type: 'position.updated', groupId: 'g', position: { a: [1, { b: null }] } }),
      8192,
    );
    expect(frame).toEqual({
      kind: 'message',
      message: { type: 'position.updated', groupId: 'g', position: { a: [1, { b: null }] } },
    });
  });

  it('marks unknown types as unknown', () => {
    expect(decodeFrame('{"type":"leader.offline","x":1}', 8192)).toEqual({
      kind: 'unknown',
      type: 'leader.offline',
    });
  });

  it.each<[string, unknown, number]>([
    ['binary', new ArrayBuffer(4), 8192],
    ['too long', `"${'x'.repeat(100)}"`, 50],
    ['not JSON', '{nope', 8192],
    ['too deep', nested(65), 100_000],
    ['known type with a bad shape', '{"type":"hello.ok","participantId":5}', 8192],
    ['no type', '{"a":1}', 8192],
    ['array', '[1,2]', 8192],
  ])('rejects %s as invalid', (_name, data, maxChars) => {
    expect(decodeFrame(data, maxChars).kind).toBe('invalid');
  });

  it('keeps a short string reqId of an invalid known frame', () => {
    const frame = decodeFrame('{"type":"group.joined","reqId":"c7"}', 8192) as Extract<
      InboundFrame,
      { kind: 'invalid' }
    >;
    expect(frame.reqId).toBe('c7');
    const long = decodeFrame(
      JSON.stringify({ type: 'group.joined', reqId: 'x'.repeat(65) }),
      8192,
    ) as Extract<InboundFrame, { kind: 'invalid' }>;
    expect(long.reqId).toBeUndefined();
  });

  it('reports schema paths only, never values', () => {
    const frame = decodeFrame(
      JSON.stringify({ type: 'hello.ok', participantId: 'SECRET-VALUE', limits: 'x' }),
      8192,
    );
    expect(JSON.stringify(frame)).not.toContain('SECRET-VALUE');
  });
});

describe('limits (M1)', () => {
  it('accepts limits within the client bounds', () => {
    expect(
      findOutOfBoundsLimit({
        maxGroupSize: 30,
        maxLeaderUpdatesPerSecond: 5,
        maxMessageBytes: 4096,
        maxSessionMinutes: 180,
      }),
    ).toBeUndefined();
    expect(findOutOfBoundsLimit({ ...CLIENT_LIMIT_BOUNDS })).toBeUndefined();
  });

  it.each([
    ['maxMessageBytes', 2 ** 53],
    ['maxMessageBytes', 1_048_577],
    ['maxLeaderUpdatesPerSecond', 1e6],
    ['maxLeaderUpdatesPerSecond', 0],
    ['maxLeaderUpdatesPerSecond', 1.5],
    ['maxGroupSize', 10_001],
    ['maxSessionMinutes', 10_081],
    ['maxSessionMinutes', 0],
  ] as const)('names %s = %d as out of bounds', (key, value) => {
    const limits = {
      maxGroupSize: 30,
      maxLeaderUpdatesPerSecond: 5,
      maxMessageBytes: 4096,
      maxSessionMinutes: 180,
    };
    expect(findOutOfBoundsLimit({ ...limits, [key]: value })).toBe(key);
  });

  it('sizes the inbound guard from the limits', () => {
    expect(maxInboundChars(undefined)).toBe(PRE_HANDSHAKE_MAX_CHARS);
    expect(
      maxInboundChars({
        maxGroupSize: 2,
        maxLeaderUpdatesPerSecond: 1,
        maxMessageBytes: 1000,
        maxSessionMinutes: 180,
      }),
    ).toBe(2000 + 8192);
  });
});

describe('Transport', () => {
  function open(maxChars = 8192) {
    const handlers = { onOpen: vi.fn(), onFrame: vi.fn(), onClose: vi.fn() };
    const transport = new Transport(FakeWebSocket, 'wss://x/', handlers, maxChars);
    return { transport, handlers, socket: FakeWebSocket.last };
  }

  it('constructs the socket with the url and forwards events', () => {
    const { handlers, socket } = open();
    expect(socket.url).toBe('wss://x/');
    socket.open();
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    socket.receive({ type: 'position.ack' });
    expect(handlers.onFrame).toHaveBeenCalledWith({
      kind: 'message',
      message: { type: 'position.ack' },
    });
    socket.serverClose(4008);
    expect(handlers.onClose).toHaveBeenCalledWith(4008);
  });

  it('treats a socket error as an abnormal close, reported once', () => {
    const { handlers, socket, transport } = open();
    socket.error();
    socket.serverClose(1006);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledWith(1006);
    expect(transport.retired).toBe(true);
  });

  it('sends JSON', () => {
    const { transport, socket } = open();
    expect(transport.send({ type: 'hello' })).toBe(true);
    expect(socket.sent).toEqual(['{"type":"hello"}']);
  });

  it('ignores events after retire and closes the socket', () => {
    const { transport, handlers, socket } = open();
    transport.retire(1000, 'bye');
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'bye' }]);
    socket.receive({ type: 'position.ack' });
    socket.serverClose(1000);
    expect(handlers.onFrame).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(transport.send({ type: 'x' })).toBe(false);
    transport.retire();
    expect(socket.closeCalls).toHaveLength(1);
  });

  it('applies the length guard and lets it be raised after hello.ok', () => {
    const { transport, handlers, socket } = open(20);
    const frame = { type: 'position.updated', groupId: 'g', position: 'x'.repeat(30) };
    socket.receive(frame);
    expect((handlers.onFrame.mock.calls[0]![0] as InboundFrame).kind).toBe('invalid');
    transport.setMaxInboundChars(1000);
    socket.receive(frame);
    expect((handlers.onFrame.mock.calls[1]![0] as InboundFrame).kind).toBe('message');
  });
});

describe('Transport host safety (H2)', () => {
  function open() {
    const handlers = { onOpen: vi.fn(), onFrame: vi.fn(), onClose: vi.fn() };
    const transport = new Transport(FakeWebSocket, 'wss://x/', handlers, 8192);
    return { transport, handlers, socket: FakeWebSocket.last };
  }

  it('keeps an error listener on a retired socket for good', () => {
    const { transport, socket } = open();
    transport.retire();
    expect(socket.listenerCount('error')).toBe(1);
    expect(socket.listenerCount('open')).toBe(0);
    expect(socket.listenerCount('message')).toBe(0);
    expect(socket.listenerCount('close')).toBe(0);
    expect(() => socket.error()).not.toThrow();
  });

  it('keeps an error listener after the socket closed by itself', () => {
    const { socket } = open();
    socket.serverClose(1001);
    expect(socket.listenerCount('error')).toBe(1);
  });

  it('never rethrows from close()', () => {
    const { transport, socket } = open();
    socket.throwOnClose = true;
    expect(() => transport.retire(1000)).not.toThrow();
    expect(transport.retired).toBe(true);
  });

  it('treats a throwing send() as a socket error', () => {
    const { transport, handlers, socket } = open();
    socket.throwOnSend = true;
    expect(transport.send({ type: 'hello' })).toBe(false);
    expect(handlers.onClose).toHaveBeenCalledWith(1006);
    expect(transport.retired).toBe(true);
  });

  it('sendText() sends the given text unchanged and handles a throw like send()', () => {
    const { transport, handlers, socket } = open();
    expect(transport.sendText('{"type":"position.update","position":{"b":1,"a":2}}')).toBe(true);
    expect(socket.sent).toEqual(['{"type":"position.update","position":{"b":1,"a":2}}']);
    socket.throwOnSend = true;
    expect(transport.sendText('{}')).toBe(false);
    expect(handlers.onClose).toHaveBeenCalledWith(1006);
    expect(socket.closeCalls).toHaveLength(1);
    expect(transport.sendText('{}')).toBe(false);
  });

  it('closes the socket exactly once when send() throws, before reporting the drop', () => {
    const { transport, handlers, socket } = open();
    socket.throwOnSend = true;
    handlers.onClose.mockImplementation(() => {
      expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    });
    expect(transport.send({ type: 'hello' })).toBe(false);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    transport.retire();
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    expect(socket.listenerCount('error')).toBe(1);
    expect(() => socket.error()).not.toThrow();
  });

  it('closes the socket once on a throwing send() even if close() throws too', () => {
    const { transport, handlers, socket } = open();
    socket.throwOnSend = true;
    socket.throwOnClose = true;
    expect(transport.send({ type: 'hello' })).toBe(false);
    expect(socket.closeCalls).toHaveLength(1);
    expect(handlers.onClose).toHaveBeenCalledWith(1006);
  });
});
