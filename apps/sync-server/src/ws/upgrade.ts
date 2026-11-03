import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import type { ServerEnv } from '../config/env.js';
import { pathOf } from '../http/health.js';
import { type Logger, safeErr } from '../logging/logger.js';
import type { ConnectionCounter } from './connection-counter.js';

export const WS_PATH = '/ws';

export interface UpgradeDeps {
  wss: WebSocketServer;
  counter: ConnectionCounter;
  env: Pick<ServerEnv, 'maxConnections' | 'maxPendingHandshakes'>;
  logger: Logger;
  onConnection: (ws: WebSocket) => void;
}

const STATUS_TEXT: Record<number, string> = {
  404: 'Not Found',
  503: 'Service Unavailable',
};

/** Answers the upgrade with a plain HTTP error and closes the socket. */
function refuse(socket: Duplex, status: number): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({ error: status === 404 ? 'not_found' : 'unavailable' });
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

/**
 * Handles the HTTP `upgrade` event. The path and the connection caps are
 * checked before `handleUpgrade`, so a refused socket never becomes a
 * WebSocket and never costs ws buffers (H1). The request object and the
 * remote address are never logged (AC24).
 */
export function createUpgradeHandler(deps: UpgradeDeps) {
  const { wss, counter, env, logger, onConnection } = deps;

  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Until ws takes over the socket, a socket error must not crash (H4).
    const onSocketError = (err: NodeJS.ErrnoException) => {
      logger.debug({ event: 'upgrade_socket_error', err: safeErr(err) }, 'upgrade socket error');
      socket.destroy();
    };
    socket.on('error', onSocketError);

    if (pathOf(req.url) !== WS_PATH) {
      refuse(socket, 404);
      return;
    }
    if (counter.total >= env.maxConnections) {
      logger.warn({ event: 'upgrade_refused', limit: 'MAX_CONNECTIONS' }, 'connection cap reached');
      refuse(socket, 503);
      return;
    }
    if (counter.pending >= env.maxPendingHandshakes) {
      logger.warn(
        { event: 'upgrade_refused', limit: 'MAX_PENDING_HANDSHAKES' },
        'pending handshake cap reached',
      );
      refuse(socket, 503);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off('error', onSocketError);
      onConnection(ws);
    });
  };
}
