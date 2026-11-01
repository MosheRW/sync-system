import { type Server, type Socket, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface BlackholeServer {
  url: string;
  /** TCP connections accepted so far. */
  readonly connections: number;
  close(): Promise<void>;
}

/**
 * Accepts TCP connections and never answers the HTTP upgrade, so a client
 * socket stays CONNECTING until it gives up (H2 tests).
 */
export async function startBlackholeServer(): Promise<BlackholeServer> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    get connections() {
      return connections;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
