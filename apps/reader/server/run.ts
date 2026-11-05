import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../src/config/config-error.js';
import { type EnvSource, parseReaderConfig } from '../src/config/schema.js';
import type { LibraryEntry } from '../src/library/types.js';
import { createHandler } from './handler.js';
import { securityHeaders } from './headers.js';
import { renderIndexHtml } from './html.js';
import { loadStaticFiles } from './static-files.js';

export interface RunIO {
  /** Startup errors and warnings; defaults to process.stderr. */
  stderr?: (text: string) => void;
  /** The one startup line; defaults to process.stdout. */
  stdout?: (text: string) => void;
  /** The Vite build output; defaults to `dist/` next to `dist-server/`. */
  distDir?: string;
}

export type RunResult =
  | { ok: true; server: Server; port: number; close: () => Promise<void> }
  | { ok: false; exitCode: number };

const DEFAULT_DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

function readLibraryIds(distDir: string): string[] | null {
  try {
    const entries = JSON.parse(
      readFileSync(join(distDir, 'library-index.json'), 'utf8'),
    ) as unknown;
    if (!Array.isArray(entries)) return null;
    return (entries as LibraryEntry[]).map((entry) => entry.contentId);
  } catch {
    return null;
  }
}

/**
 * Starts the reader server (ADR 0001, 0005): validates the env against the
 * built library index (exit 1 with `Config error: ...` lines, AC30, AC41),
 * loads `dist/` into memory, renders `index.html` with the public config
 * once, and listens. Prints only the offending reader variables, never other
 * env values (C9).
 */
export async function run(env: EnvSource, io: RunIO = {}): Promise<RunResult> {
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const distDir = io.distDir ?? DEFAULT_DIST;

  const libraryIds = readLibraryIds(distDir);
  if (libraryIds === null) {
    stderr('Startup error: dist/library-index.json is missing or invalid (run the build first)\n');
    return { ok: false, exitCode: 1 };
  }

  let config;
  try {
    config = parseReaderConfig(env, libraryIds);
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const problem of err.problems) stderr(`Config error: ${problem}\n`);
      return { ok: false, exitCode: 1 };
    }
    throw err;
  }
  for (const warning of config.warnings) stderr(`Warning: ${warning}\n`);

  let indexHtml: string;
  try {
    indexHtml = renderIndexHtml(readFileSync(join(distDir, 'index.html'), 'utf8'), config);
  } catch {
    stderr('Startup error: dist/index.html is missing or has no config placeholder\n');
    return { ok: false, exitCode: 1 };
  }

  const headers = securityHeaders(config.srcOrigins);
  const server = createServer(
    createHandler({
      files: loadStaticFiles(distDir),
      indexHtml,
      libraryOn: config.library === 'on',
      headers,
    }),
  );
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  // Unparseable requests never reach the handler: answer 400 and close (C1).
  server.on('clientError', (_err, socket) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
    socket.end(
      ['HTTP/1.1 400 Bad Request', 'Connection: close', 'Content-Length: 0', ...lines, '', ''].join(
        '\r\n',
      ),
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    stderr(`Startup error: cannot listen on port ${config.port} (${code})\n`);
    return { ok: false, exitCode: 1 };
  }

  const { port } = server.address() as AddressInfo;
  stdout(`reader listening on port ${port}\n`);
  return {
    ok: true,
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
