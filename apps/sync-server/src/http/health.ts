import type { IncomingMessage, ServerResponse } from 'node:http';
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from '@sync-system/protocol';

/** The health body reports versions only: no app, group or connection data (AC23). */
const HEALTH_BODY = JSON.stringify({
  status: 'ok',
  protocolVersion: PROTOCOL_VERSION,
  minProtocolVersion: MIN_CLIENT_PROTOCOL_VERSION,
});

const NOT_FOUND_BODY = JSON.stringify({ error: 'not_found' });

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

/** `GET /health` returns 200; every other path or method returns 404. */
export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && pathOf(req.url) === '/health') {
    sendJson(res, 200, HEALTH_BODY);
    return;
  }
  sendJson(res, 404, NOT_FOUND_BODY);
}
