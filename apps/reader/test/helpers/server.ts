import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const INDEX_TEMPLATE =
  '<!doctype html><html><head><!--reader-config--><script type="module" src="/assets/app-abc123.js"></script></head><body><div id="root"></div></body></html>';

/** A minimal `dist/` like the Vite build emits. */
export function makeDist(
  entries: { contentId: string; dir: 'ltr' | 'rtl' }[] = [
    { contentId: 'samples/psalms-he', dir: 'rtl' },
    { contentId: 'samples/untitled', dir: 'ltr' },
  ],
): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'reader-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX_TEMPLATE);
  writeFileSync(join(dir, 'library-index.json'), JSON.stringify(entries));
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1);');
  writeFileSync(join(dir, 'assets', 'app-abc123.css'), 'body{}');
  writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Sends raw bytes and resolves with the raw response (for malformed requests). */
export function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    socket.write(request);
    setTimeout(() => socket.end(), 500);
  });
}
