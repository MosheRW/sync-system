import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StaticFile } from './static-files.js';

export interface HandlerOptions {
  /** URL path -> file (the in-memory allow-list). */
  files: ReadonlyMap<string, StaticFile>;
  /** `index.html` with the config injected. */
  indexHtml: string;
  /** `/library` is served only when the library is on (ADR 0005 B1). */
  libraryOn: boolean;
  /** Security headers for every response. */
  headers: Readonly<Record<string, string>>;
}

const URL_BASE = 'http://reader.invalid';

/**
 * The reader's request handler (architecture 5.5, security C1): GET and
 * HEAD only; `/health`, `/`, `/library` and the in-memory files; everything
 * else 404. A malformed target is 400; any unexpected error is a 500 with a
 * fixed body. Never echoes the path, query or headers, and logs nothing per
 * request (query strings carry URLs, C9). The reader server never fetches
 * anything (C8).
 */
export function createHandler(options: HandlerOptions) {
  const indexBody = Buffer.from(options.indexHtml, 'utf8');

  return function handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      route(req, res);
    } catch {
      if (!res.headersSent) {
        send(req, res, 500, 'text/plain; charset=utf-8', 'no-store', 'Internal error\n');
      } else {
        res.destroy();
      }
    }
  };

  function route(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      send(req, res, 405, 'text/plain; charset=utf-8', 'no-store', 'Method not allowed\n');
      return;
    }
    const pathname = parsePath(req.url);
    if (pathname === null) {
      send(req, res, 400, 'text/plain; charset=utf-8', 'no-store', 'Bad request\n');
      return;
    }
    if (pathname === '/health') {
      send(req, res, 200, 'text/plain; charset=utf-8', 'no-store', 'ok\n');
      return;
    }
    if (pathname === '/' || (pathname === '/library' && options.libraryOn)) {
      send(req, res, 200, 'text/html; charset=utf-8', 'no-cache', indexBody);
      return;
    }
    const file = options.files.get(pathname);
    if (file) {
      send(req, res, 200, file.contentType, file.cacheControl, file.body);
      return;
    }
    send(req, res, 404, 'text/plain; charset=utf-8', 'no-store', 'Not found\n');
  }

  function send(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    contentType: string,
    cacheControl: string,
    body: string | Buffer,
  ): void {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    for (const [name, value] of Object.entries(options.headers)) res.setHeader(name, value);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Content-Length', bytes.byteLength);
    res.statusCode = status;
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
}

/**
 * The decoded path of an origin-form request target, or `null` when the
 * target is malformed (absolute-form, `*`, bad percent-encoding).
 */
export function parsePath(target: string | undefined): string | null {
  if (target === undefined || !target.startsWith('/') || target.startsWith('//')) return null;
  try {
    const { pathname } = new URL(target, URL_BASE);
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
