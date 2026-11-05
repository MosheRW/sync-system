import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

export interface StaticFile {
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

const MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Files the server renders or reads itself, never served as they are. */
const NOT_SERVED = new Set(['index.html', 'library-index.json']);

/**
 * Every file under `dist/`, loaded into memory at startup, keyed by URL
 * path. The map is the only thing the server ever serves, so no request can
 * reach the file system (no path traversal). Hashed `assets/` files are
 * cached for a year.
 */
export function loadStaticFiles(distDir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(distDir, full).split(sep).join('/');
      if (NOT_SERVED.has(rel)) continue;
      files.set(`/${rel}`, {
        body: readFileSync(full),
        contentType: MIME[extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
        cacheControl: rel.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
      });
    }
  };
  walk(distDir);
  return files;
}
