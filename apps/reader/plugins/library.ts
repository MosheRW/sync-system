import { readFileSync, readdirSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import { ConfigError } from '../src/config/config-error.js';
import { type EnvSource, type ReaderConfig, parseReaderConfig } from '../src/config/schema.js';
import { securityHeaders } from '../server/headers.js';
import { renderIndexHtml } from '../server/html.js';
import type { ContentError } from '../src/content/errors.js';
import { parseContentText } from '../src/content/parse.js';
import { documentDir } from '../src/direction/effective.js';
import type { LibraryEntry } from '../src/library/types.js';

export const VIRTUAL_ID = 'virtual:reader-library';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
export const LIBRARY_INDEX_FILE = 'library-index.json';

export class LibraryBuildError extends Error {
  override readonly name = 'LibraryBuildError';
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid bundled content (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

export interface LibraryIndex {
  entries: LibraryEntry[];
  /** Content ID -> path relative to the content directory, posix separators. */
  files: Map<string, string>;
}

/** Plain-English summary of a refusal, for build errors (not shown to readers). */
export function describeContentError(error: ContentError): string {
  switch (error.kind) {
    case 'invalid-json':
      return 'not valid JSON (or not UTF-8)';
    case 'invalid-content':
      return error.path ? `${error.path}: ${error.detail}` : error.detail;
    case 'schema-version-missing':
      return 'missing schemaVersion';
    case 'schema-version-invalid':
      return 'schemaVersion is not a positive integer';
    case 'schema-version-unsupported':
      return `schema version ${error.version} is outside the supported range ${error.min}-${error.max}`;
    default:
      return error.kind;
  }
}

function listJsonFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * Validates every bundled book with the app's own parser (AC38): the file
 * path must be `<contentId>.json`, IDs are unique, and any problem in any
 * file fails the build with one error listing all of them. Valid books
 * become library entries (AC39).
 */
export function buildLibraryIndex(contentDir: string): LibraryIndex {
  const problems: string[] = [];
  const entries: LibraryEntry[] = [];
  const files = new Map<string, string>();

  for (const file of listJsonFiles(contentDir)) {
    const rel = relative(contentDir, file).split(sep).join('/');
    const result = parseContentText(readFileSync(file, 'utf8'));
    if (!result.ok) {
      problems.push(`${rel}: ${describeContentError(result.error)}`);
      continue;
    }
    const { document } = result;
    if (`${document.contentId}.json` !== rel) {
      problems.push(
        `${rel}: contentId "${document.contentId}" must match its path (${document.contentId}.json)`,
      );
      continue;
    }
    if (files.has(document.contentId)) {
      problems.push(`${rel}: duplicate contentId "${document.contentId}"`);
      continue;
    }
    files.set(document.contentId, rel);
    const entry: LibraryEntry = { contentId: document.contentId, dir: documentDir(document) };
    if (document.title !== undefined) entry.title = document.title;
    if (document.lang !== undefined) entry.lang = document.lang;
    entries.push(entry);
  }

  if (problems.length > 0) throw new LibraryBuildError(problems);
  return { entries, files };
}

/** Source of `virtual:reader-library`: entries plus lazy `?raw` loaders. */
export function libraryModuleSource(index: LibraryIndex, contentUrlBase: string): string {
  const loaders = [...index.files].map(
    ([id, rel]) =>
      `  ${JSON.stringify(id)}: () => import(${JSON.stringify(`${contentUrlBase}/${rel}?raw`)}).then((m) => m.default),`,
  );
  return [
    `export const entries = ${JSON.stringify(index.entries)};`,
    `export const loaders = {\n${loaders.join('\n')}\n};`,
    '',
  ].join('\n');
}

export interface ReaderLibraryOptions {
  /** Absolute path of the bundled content directory (inside the Vite root). */
  contentDir: string;
  /** URL of `contentDir` relative to the Vite root, e.g. `/content`. */
  contentUrl?: string;
  /** Environment for the dev/preview servers' config check; defaults to `process.env`. */
  env?: EnvSource;
}

/**
 * Validates the reader config for the dev and preview servers, so `pnpm dev`
 * with a bad env fails to start like the production server (AC30).
 */
export function loadDevConfig(env: EnvSource, index: LibraryIndex): ReaderConfig {
  try {
    return parseReaderConfig(
      env,
      index.entries.map((entry) => entry.contentId),
    );
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new Error(err.problems.map((problem) => `Config error: ${problem}`).join('\n'));
    }
    throw err;
  }
}

/**
 * Vite plugin (ADR 0005 D1): builds and validates the library index, serves
 * `virtual:reader-library`, emits `library-index.json` for the server, and
 * watches the content directory in dev.
 */
export function readerLibrary(options: ReaderLibraryOptions): Plugin {
  const contentUrl = options.contentUrl ?? '/content';
  let index: LibraryIndex | undefined;
  const getIndex = () => (index ??= buildLibraryIndex(options.contentDir));

  return {
    name: 'reader-library',
    buildStart() {
      index = undefined;
      getIndex();
      this.addWatchFile(options.contentDir);
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      return id === RESOLVED_ID ? libraryModuleSource(getIndex(), contentUrl) : null;
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: LIBRARY_INDEX_FILE,
        source: `${JSON.stringify(getIndex().entries, null, 2)}\n`,
      });
    },
    // Dev only (ctx.server is unset in a build): the built index.html keeps
    // the placeholder for the production server to fill in.
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.server) return html;
        return renderIndexHtml(html, loadDevConfig(options.env ?? process.env, getIndex()));
      },
    },
    // `vite preview` serves the built files; inject the config and send the
    // production headers for the two HTML routes, like the reader server.
    configurePreviewServer(server) {
      const config = loadDevConfig(options.env ?? process.env, getIndex());
      const outDir = join(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, res: ServerResponse, next) => {
        const path = (req.url ?? '/').split('?')[0];
        const isIndex = path === '/' || (path === '/library' && config.library === 'on');
        if (req.method !== 'GET' || !isIndex) {
          next();
          return;
        }
        const html = renderIndexHtml(readFileSync(join(outDir, 'index.html'), 'utf8'), config);
        for (const [name, value] of Object.entries(securityHeaders(config.srcOrigins))) {
          res.setHeader(name, value);
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(html);
      });
    },
    configureServer(server) {
      loadDevConfig(options.env ?? process.env, getIndex());
      server.watcher.add(options.contentDir);
      const onChange = (file: string) => {
        if (!file.startsWith(options.contentDir)) return;
        index = undefined;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', onChange);
      server.watcher.on('change', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}
