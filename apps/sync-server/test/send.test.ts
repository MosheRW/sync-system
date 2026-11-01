import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type SendTarget, send, sendSerialized } from '../src/ws/send.js';

class FakeSocket implements SendTarget {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  terminated = false;
  send(data: string): void {
    this.sent.push(data);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('sendSerialized (H2, H4)', () => {
  it('sends when the socket is open and the buffer has room', () => {
    const ws = new FakeSocket();
    expect(sendSerialized(ws, 'hello', 100)).toBe('sent');
    expect(ws.sent).toEqual(['hello']);
  });

  it('does nothing unless the socket is OPEN', () => {
    for (const state of [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
      const ws = new FakeSocket();
      ws.readyState = state;
      expect(sendSerialized(ws, 'x', 100)).toBe('not_open');
      expect(ws.sent).toEqual([]);
      expect(ws.terminated).toBe(false);
    }
  });

  it('terminates instead of sending when the buffer would exceed the limit', () => {
    const ws = new FakeSocket();
    ws.bufferedAmount = 95;
    expect(sendSerialized(ws, 'abcdef', 100)).toBe('terminated');
    expect(ws.terminated).toBe(true);
    expect(ws.sent).toEqual([]);
  });

  it('allows filling the buffer exactly to the limit', () => {
    const ws = new FakeSocket();
    ws.bufferedAmount = 95;
    expect(sendSerialized(ws, 'abcde', 100)).toBe('sent');
  });

  it('counts UTF-8 bytes, not characters', () => {
    const ws = new FakeSocket();
    ws.bufferedAmount = 0;
    expect(sendSerialized(ws, 'אבג', 5)).toBe('terminated'); // 6 bytes
  });

  it('serializes messages', () => {
    const ws = new FakeSocket();
    send(ws, { type: 'position.ack', reqId: 'r' }, 100);
    expect(ws.sent).toEqual(['{"type":"position.ack","reqId":"r"}']);
  });
});
