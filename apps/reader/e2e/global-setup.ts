import type { ChildProcess } from 'node:child_process';
import { LIFECYCLE_CONFIG, freePort, startReader, startSyncServer } from './helpers/servers.js';
import { type TcpProxy, startTcpProxy } from './helpers/tcp-proxy.js';

/** One sync server with a direct reader and a reader behind its own TCP proxy. */
interface Stack {
  readonly reader: string;
  readonly proxied: string;
  readonly proxy: TcpProxy;
  readonly children: ChildProcess[];
}

async function startStack(configPath?: string): Promise<Stack> {
  const syncPort = await freePort();
  const sync = await startSyncServer(syncPort, configPath);
  const readerPort = await freePort();
  const reader = await startReader(readerPort, syncPort);
  // The proxied reader needs the proxy's port before it starts: a fixed proxy
  // here forwards to the sync server, and the specs cut it.
  const proxy = await startTcpProxy(syncPort);
  const proxiedPort = await freePort();
  const proxied = await startReader(proxiedPort, proxy.port);
  return {
    reader: `http://127.0.0.1:${readerPort}`,
    proxied: `http://127.0.0.1:${proxiedPort}`,
    proxy,
    children: [proxied, reader, sync],
  };
}

/**
 * Starts two stacks (#24 ADR 0008, #25 13.2): the default one (30 s grace,
 * the phone-lock check) and the lifecycle one (5 s grace, `auto` handoff,
 * the handoff and take-back check). Each has the real sync server, a direct
 * reader (members) and a reader through a TCP proxy (the leader), cut by
 * the specs through a loopback control.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const main = await startStack();
  const lifecycle = await startStack(LIFECYCLE_CONFIG);
  const control = await startControl({ main: main.proxy, lifecycle: lifecycle.proxy });

  process.env['E2E_READER'] = main.reader;
  process.env['E2E_PROXIED_READER'] = main.proxied;
  process.env['E2E_LIFECYCLE_READER'] = lifecycle.reader;
  process.env['E2E_LIFECYCLE_PROXIED_READER'] = lifecycle.proxied;
  process.env['E2E_PROXY_CONTROL'] = `http://127.0.0.1:${control.port}`;

  return async () => {
    for (const child of [...main.children, ...lifecycle.children]) child.kill();
    await control.close();
    await main.proxy.close();
    await lifecycle.proxy.close();
  };
}

/** The longest cut a spec may ask for (#25 R23: a bounded integer). */
const MAX_CUT_MS = 60_000;

/**
 * A tiny loopback HTTP control so tests in workers can cut a proxy:
 * `POST /cut/<ms>` (default stack) or `POST /cut/lifecycle/<ms>`.
 */
async function startControl(proxies: { main: TcpProxy; lifecycle: TcpProxy }) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const match = /^\/cut\/(?:(lifecycle)\/)?(\d{1,6})$/.exec(req.url ?? '');
    const ms = match ? Number(match[2]) : Number.NaN;
    if (req.method !== 'POST' || !match || !Number.isSafeInteger(ms) || ms > MAX_CUT_MS) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const proxy = match[1] === 'lifecycle' ? proxies.lifecycle : proxies.main;
    void proxy.cut(ms).then(() => res.end('ok'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
