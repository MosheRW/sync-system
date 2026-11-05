import type { ContentError } from './errors.js';
import { type FetchLike, fetchText } from './fetch-text.js';
import { CryptoUnavailableError, type DigestProvider, computeFingerprint } from './fingerprint.js';
import { SUPPORTED_SCHEMA, type SchemaRange } from './limits.js';
import type { ContentMetadata } from './metadata.js';
import { parseContentText } from './parse.js';
import type { ContentDocument } from './schema.js';
import { checkSrc } from './src-policy.js';

export type ContentSource =
  | { kind: 'bundled'; contentId: string }
  /** The raw `?src` value; checked by the src policy inside the loader. */
  | { kind: 'url'; url: string };

export interface LoadedContent {
  source: 'bundled' | 'url';
  /** Validated, as written in the file. */
  document: ContentDocument;
  metadata: ContentMetadata;
}

export type LoadResult = { ok: true; content: LoadedContent } | { ok: false; error: ContentError };

export interface ContentLoader {
  /** Never rejects. */
  load(source: ContentSource, options?: { signal?: AbortSignal }): Promise<LoadResult>;
  /** AC17: declared for later, not implemented (no loading by ID + fingerprint). */
  readonly capabilities: { readonly versionLookup: false };
}

/** Raw text of each bundled book, keyed by content ID (`virtual:reader-library`). */
export type BundledLoaders = Readonly<Record<string, () => Promise<string>>>;

export interface LoaderConfig {
  srcOrigins: readonly string[];
  fetchTimeoutSeconds: number;
  srcMaxBytes: number;
}

export interface ContentLoaderOptions {
  bundled: BundledLoaders;
  config: LoaderConfig;
  fetchImpl?: FetchLike;
  /** `null` simulates a non-secure context; omitted uses `crypto.subtle`. */
  subtle?: DigestProvider | null;
  supported?: SchemaRange;
}

/**
 * One loader for bundled and fetched content (AC2): both go raw text ->
 * parse/validate -> fingerprint and return the same `LoadedContent` shape.
 */
export function createContentLoader(options: ContentLoaderOptions): ContentLoader {
  const supported = options.supported ?? SUPPORTED_SCHEMA;

  async function readText(
    source: ContentSource,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; text: string } | { ok: false; error: ContentError }> {
    if (source.kind === 'bundled') {
      const loadRaw = Object.hasOwn(options.bundled, source.contentId)
        ? options.bundled[source.contentId]
        : undefined;
      if (!loadRaw) return { ok: false, error: { kind: 'not-found', contentId: source.contentId } };
      try {
        return { ok: true, text: await loadRaw() };
      } catch {
        // A lazily loaded chunk failed to download: retryable.
        return { ok: false, error: { kind: 'network' } };
      }
    }
    const checked = checkSrc(source.url, options.config.srcOrigins);
    if (!checked.ok) return checked;
    return fetchText(checked.url, {
      timeoutMs: options.config.fetchTimeoutSeconds * 1000,
      maxBytes: options.config.srcMaxBytes,
      ...(signal ? { signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  async function load(
    source: ContentSource,
    loadOptions: { signal?: AbortSignal } = {},
  ): Promise<LoadResult> {
    const { signal } = loadOptions;
    try {
      const raw = await readText(source, signal);
      if (signal?.aborted) return { ok: false, error: { kind: 'aborted' } };
      if (!raw.ok) return raw;
      const parsed = parseContentText(raw.text, supported);
      if (!parsed.ok) return parsed;
      const { document } = parsed;
      const fingerprint = await computeFingerprint(document, options.subtle);
      if (signal?.aborted) return { ok: false, error: { kind: 'aborted' } };
      return {
        ok: true,
        content: {
          source: source.kind,
          document,
          metadata: {
            contentId: document.contentId,
            fingerprint,
            schemaVersion: document.schemaVersion,
          },
        },
      };
    } catch (err) {
      if (err instanceof CryptoUnavailableError) {
        return { ok: false, error: { kind: 'crypto-unavailable' } };
      }
      return {
        ok: false,
        error: {
          kind: 'invalid-content',
          path: '',
          code: 'wrong-type',
          detail: 'the file could not be read',
        },
      };
    }
  }

  return { load, capabilities: Object.freeze({ versionLookup: false as const }) };
}
