import type { ServerMessage } from '@sync-system/protocol';
import { WebSocket } from 'ws';

/** The subset of a ws WebSocket that sending needs (fakeable in unit tests). */
export interface SendTarget {
  readonly readyState: number;
  send(data: string): void;
}

/**
 * Sends an already serialized frame. A no-op unless the socket is OPEN, so a
 * send to a peer that is closing never throws (H4).
 */
export function sendSerialized(ws: SendTarget, text: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(text);
  return true;
}

export function send(ws: SendTarget, message: ServerMessage): boolean {
  return sendSerialized(ws, JSON.stringify(message));
}
