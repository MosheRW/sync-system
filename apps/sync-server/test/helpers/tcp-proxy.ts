import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net';

/**
 * An in-process TCP proxy to a Redis, so tests can cut it (connections reset,
 * new ones refused), stall it (data no longer forwarded: commands time out)
 * and restore it (#35 AC26, security C4).
 */
export class TcpProxy {
  private readonly server: Server;
  private readonly pairs = new Set<{ client: Socket; upstream: Socket }>();
  private mode: 'open' | 'cut' | 'stall' = 'open';
  port = 0;

  private constructor(
    private readonly host: string,
    private readonly targetPort: number,
  ) {
    this.server = createServer((client) => this.accept(client));
  }

  static async start(host: string, port: number): Promise<TcpProxy> {
    const proxy = new TcpProxy(host, port);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    proxy.port = (proxy.server.address() as AddressInfo).port;
    return proxy;
  }

  private accept(client: Socket): void {
    client.on('error', () => undefined);
    if (this.mode === 'cut') {
      client.destroy();
      return;
    }
    const upstream = connect(this.targetPort, this.host);
    upstream.on('error', () => client.destroy());
    const pair = { client, upstream };
    this.pairs.add(pair);
    const close = () => {
      this.pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', close);
    upstream.on('close', close);
    client.on('data', (data) => {
      if (this.mode === 'open') upstream.write(data);
    });
    upstream.on('data', (data) => {
      if (this.mode === 'open') client.write(data);
    });
  }

  /** Resets every connection and refuses new ones. */
  cut(): void {
    this.mode = 'cut';
    for (const { client, upstream } of [...this.pairs]) {
      client.resetAndDestroy();
      upstream.destroy();
    }
  }

  /** Keeps connections open but forwards nothing: every command times out. */
  stall(): void {
    this.mode = 'stall';
  }

  restore(): void {
    this.mode = 'open';
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
