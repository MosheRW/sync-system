import type { ChildProcess } from 'node:child_process';
import { freePort, startReader, startSyncServer } from './helpers/servers.js';
import { startTcpProxy } from './helpers/tcp-proxy.js';

/**
 * Starts the real sync server and two reader servers (#24 ADR 0008): one
 * direct (members) and one through a TCP proxy (the leader in the phone-lock
 * check). The proxy runs inside the tests (it must be cut from there), so
 * this only publishes the sync port for it.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const syncPort = await freePort();
  const sync = await startSyncServer(syncPort);
  const readerPort = await freePort();
  const reader = await startReader(readerPort, syncPort);
  // The proxied reader needs the proxy's port before it starts: a fixed proxy
  // here forwards to the sync server, and the phone-lock spec cuts it.
  const proxy = await startTcpProxy(syncPort);
  const proxiedPort = await freePort();
  const proxied = await startReader(proxiedPort, proxy.port);
  const control = await startControl(proxy);

  process.env['E2E_READER'] = `http://127.0.0.1:${readerPort}`;
  process.env['E2E_PROXIED_READER'] = `http://127.0.0.1:${proxiedPort}`;
  process.env['E2E_PROXY_CONTROL'] = `http://127.0.0.1:${control.port}`;

  const children: ChildProcess[] = [proxied, reader, sync];
  return async () => {
    for (const child of children) child.kill();
    await control.close();
    await proxy.close();
  };
}

/** A tiny loopback HTTP control so tests in workers can cut the proxy. */
async function startControl(proxy: Awaited<ReturnType<typeof startTcpProxy>>) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const match = /^\/cut\/(\d+)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void proxy.cut(Number(match[1])).then(() => res.end('ok'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
