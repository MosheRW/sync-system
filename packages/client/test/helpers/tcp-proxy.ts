import { type AddressInfo, type Socket, createConnection, createServer } from 'node:net';

export interface TcpProxy {
  url: string;
  /** Connections accepted so far. */
  readonly connections: number;
  /** Cuts every open connection (an abnormal drop for both sides). */
  cutAll(): void;
  /** Cuts each new connection this long after it opens (flapping server). Undefined: never. */
  cutAfterMs: number | undefined;
  close(): Promise<void>;
}

/** A TCP proxy in front of `targetPort` that can drop connections on demand. */
export async function startTcpProxy(targetPort: number): Promise<TcpProxy> {
  const pairs = new Set<{ client: Socket; upstream: Socket; timer?: NodeJS.Timeout }>();
  let connections = 0;
  let cutAfterMs: number | undefined;

  const server = createServer((client) => {
    connections += 1;
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
    const pair: { client: Socket; upstream: Socket; timer?: NodeJS.Timeout } = { client, upstream };
    pairs.add(pair);
    const cut = () => {
      clearTimeout(pair.timer);
      client.destroy();
      upstream.destroy();
      pairs.delete(pair);
    };
    client.on('error', cut);
    upstream.on('error', cut);
    client.on('close', cut);
    upstream.on('close', cut);
    client.pipe(upstream);
    upstream.pipe(client);
    if (cutAfterMs !== undefined) pair.timer = setTimeout(cut, cutAfterMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    get connections() {
      return connections;
    },
    get cutAfterMs() {
      return cutAfterMs;
    },
    set cutAfterMs(value: number | undefined) {
      cutAfterMs = value;
    },
    cutAll() {
      for (const pair of [...pairs]) {
        clearTimeout(pair.timer);
        pair.client.destroy();
        pair.upstream.destroy();
        pairs.delete(pair);
      }
    },
    close() {
      for (const pair of [...pairs]) {
        clearTimeout(pair.timer);
        pair.client.destroy();
        pair.upstream.destroy();
      }
      pairs.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
