import type { IncomingMessage, ServerResponse } from 'node:http';
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@sync-system/protocol';

export type StorageKind = 'memory' | 'redis';

export interface HttpDeps {
  /** The server's validated semver version, read once at startup (#36 AC33). */
  version: string;
  /** Which storage serves groups; never its connectivity state (#36 AC34). */
  storageKind: StorageKind;
  /**
   * Whether this instance can serve now (#36 AC35). Synchronous and reads
   * in-memory state only: a probe never sends a Redis command.
   */
  ready: () => boolean;
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

/**
 * The two readiness bodies: `status` and the storage kind only, never a
 * reason, host, address, instance ID or key prefix (#36 AC35, security C7).
 */
export function readyBodies(storageKind: StorageKind): { ready: string; notReady: string } {
  return {
    ready: JSON.stringify({ status: 'ready', storage: storageKind }),
    notReady: JSON.stringify({ status: 'not_ready', storage: storageKind }),
  };
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
 * `GET /health` (liveness) always returns 200; `GET /ready` (readiness)
 * returns 200 or 503 from `deps.ready()`; every other path or method returns
 * 404. Every body is prebuilt; no per-request I/O.
 */
export function createHttpHandler(
  deps: HttpDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const health = healthBody(deps);
  const ready = readyBodies(deps.storageKind);
  return (req, res) => {
    const path = req.method === 'GET' ? pathOf(req.url) : undefined;
    if (path === '/health') {
      sendJson(res, 200, health);
      return;
    }
    if (path === '/ready') {
      if (deps.ready()) sendJson(res, 200, ready.ready);
      else sendJson(res, 503, ready.notReady);
      return;
    }
    sendJson(res, 404, NOT_FOUND_BODY);
  };
}
