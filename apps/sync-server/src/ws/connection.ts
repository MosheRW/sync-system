import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@sync-system/protocol';
import type { WebSocket } from 'ws';
import type { Logger } from '../logging/logger.js';
import type { ConnectionCounter } from './connection-counter.js';
import { send } from './send.js';

export interface ConnectionDeps {
  logger: Logger;
  counter: ConnectionCounter;
  /** Called once when the socket has closed. */
  onClosed: (connection: Connection) => void;
}

/** Per-socket state. */
export class Connection {
  /** App namespace once the handshake succeeded. */
  namespace: string | undefined;
  private closed = false;

  constructor(
    readonly ws: WebSocket,
    private readonly deps: ConnectionDeps,
  ) {
    deps.counter.opened();

    // Without an 'error' listener, a protocol violation from the peer would
    // throw from the EventEmitter and crash the process (H4).
    ws.on('error', (err: NodeJS.ErrnoException) => {
      deps.logger.debug({ event: 'ws_error', code: err.code, name: err.name }, 'websocket error');
    });
    // The client's close reason is never logged (L8).
    ws.on('close', (code: number) => this.onClose(code));

    send(ws, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      minProtocolVersion: MIN_CLIENT_PROTOCOL_VERSION,
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.deps.counter.closed(this.namespace);
    this.deps.logger.debug({ event: 'ws_closed', code }, 'websocket closed');
    this.deps.onClosed(this);
  }
}
