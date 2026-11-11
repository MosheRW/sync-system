import { type Server, type Socket, connect, createServer } from 'node:net';

/**
 * A loopback TCP proxy in front of the sync server (#24 AC35): `cut(ms)`
 * drops every open connection and holds new ones for `ms`, like a phone
 * that locked or lost its network. Binds 127.0.0.1 only (security R11).
 */
export interface TcpProxy {
  readonly port: number;
  cut(ms: number): Promise<void>;
  close(): Promise<void>;
}

export async function startTcpProxy(targetPort: number): Promise<TcpProxy> {
  const sockets = new Set<Socket>();
  let blockedUntil = 0;
  const wire = (client: Socket) => {
    if (client.destroyed) return;
    const upstream = connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  };
  const server: Server = createServer({ pauseOnConnect: true }, (client) => {
    const wait = blockedUntil - Date.now();
    // During a cut, packets go nowhere (as on a locked phone): the connection
    // hangs until the network is back, then goes through.
    if (wait > 0) {
      client.on('error', () => client.destroy());
      setTimeout(() => wire(client), wait);
      return;
    }
    wire(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('proxy has no port');
  return {
    port: address.port,
    cut: async (ms) => {
      blockedUntil = Date.now() + ms;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
