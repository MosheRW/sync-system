import type { ServerMessage } from '@mosherw/sync-system-protocol';
import { WebSocket } from 'ws';

/** The subset of a ws WebSocket that sending needs (fakeable in unit tests). */
export interface SendTarget {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
}

export type SendResult = 'sent' | 'not_open' | 'terminated';

/**
 * Sends an already serialized frame.
 *
 * - A no-op unless the socket is OPEN, so a send to a peer that is closing
 *   never throws (H4).
 * - If the frame would push the socket's outbound buffer over
 *   `maxBufferedBytes`, the socket is terminated instead (H2). The normal
 *   disconnect rules then run. Nothing is ever queued in our own code.
 */
export function sendSerialized(ws: SendTarget, text: string, maxBufferedBytes: number): SendResult {
  if (ws.readyState !== WebSocket.OPEN) return 'not_open';
  if (ws.bufferedAmount + Buffer.byteLength(text, 'utf8') > maxBufferedBytes) {
    ws.terminate();
    return 'terminated';
  }
  ws.send(text);
  return 'sent';
}

export function send(ws: SendTarget, message: ServerMessage, maxBufferedBytes: number): SendResult {
  return sendSerialized(ws, JSON.stringify(message), maxBufferedBytes);
}

/** The subset of a ws WebSocket that answering a ping needs. */
export interface PongTarget {
  readonly readyState: number;
  readonly bufferedAmount: number;
  pong(data: Buffer): void;
}

export type PongResult = 'sent' | 'not_open' | 'dropped';

/**
 * Answers a ping by hand (ws auto-pong is off). The pong is skipped, not
 * queued, if the outbound buffer is at the limit or the pong would push it
 * over, so a peer that pings but never reads cannot grow server memory (H2).
 */
export function sendPong(ws: PongTarget, data: Buffer, maxBufferedBytes: number): PongResult {
  if (ws.readyState !== WebSocket.OPEN) return 'not_open';
  if (ws.bufferedAmount >= maxBufferedBytes || ws.bufferedAmount + data.length > maxBufferedBytes) {
    return 'dropped';
  }
  ws.pong(data);
  return 'sent';
}
