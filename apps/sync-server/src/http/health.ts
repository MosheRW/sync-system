import type { IncomingMessage, ServerResponse } from 'node:http';
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@sync-system/protocol';

export type StorageKind = 'memory' | 'redis';

export interface HttpDeps {
  /** The server's validated semver version, read once at startup (#36 AC33). */
  version: string;
  /** Which storage serves groups; never its connectivity state (#36 AC34). */
  storageKind: StorageKind;
}

const NOT_FOUND_BODY = JSON.stringify({ error: 'not_found' });

/**
 * The liveness body. It reports versions and the storage kind only: no app,
 * group, connection, host or address data (AC23, #36 AC33, AC34). Built
 * once: it is constant for the process.
 */
export function healthBody(deps: HttpDeps): string {
  return JSON.stringify({
    status: 'ok',
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_CLIENT_PROTOCOL_VERSION,
    version: deps.version,
    storage: deps.storageKind,
  });
}

/** Pathname of a request URL, or undefined if it cannot be parsed. */
export function pathOf(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * `GET /health` returns 200 with a prebuilt body; every other path or method
 * returns 404. No per-request I/O.
 */
export function createHttpHandler(
  deps: HttpDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const health = healthBody(deps);
  return (req, res) => {
    if (req.method === 'GET' && pathOf(req.url) === '/health') {
      sendJson(res, 200, health);
      return;
    }
    sendJson(res, 404, NOT_FOUND_BODY);
  };
}
