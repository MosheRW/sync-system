import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppRegistry } from './apps/app-registry.js';
import type { ServerEnv } from './config/env.js';
import { handleHttpRequest } from './http/health.js';
import {
  HTTP_CONNECTION_MARGIN,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
} from './limits/constants.js';
import type { Logger } from './logging/logger.js';

export interface SyncServerOptions {
  env: ServerEnv;
  registry: AppRegistry;
  logger: Logger;
  /** Clock in ms; injected by tests. */
  now?: () => number;
}

export interface SyncServer {
  /** Starts listening; resolves with the bound port. */
  listen(port: number, host: string): Promise<number>;
  /** Stops accepting, closes every socket, and resolves when done. */
  close(): Promise<void>;
  /** Bound port (0 before listen). */
  readonly port: number;
  /** The underlying HTTP server (tests inspect its timeouts). */
  readonly httpServer: Server;
}

export function createSyncServer(options: SyncServerOptions): SyncServer {
  const { env, logger } = options;

  const httpServer = createServer(handleHttpRequest);
  // Slowloris protection and a hard socket backstop above the WS cap (H1).
  httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  httpServer.maxConnections = env.maxConnections + HTTP_CONNECTION_MARGIN;

  // Error guards (H4): a malformed request or a server error never crashes.
  httpServer.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    logger.error({ event: 'http_error', code: err.code, name: err.name }, 'http server error');
  });

  let port = 0;

  return {
    get port() {
      return port;
    },
    httpServer,
    listen(listenPort, host) {
      return new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          port = (httpServer.address() as AddressInfo).port;
          resolve(port);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(listenPort, host);
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };
}
