import type { ContentError } from './errors.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FetchTextOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export type FetchTextResult = { ok: true; text: string } | { ok: false; error: ContentError };

/** Exactly the request options of ADR 0006 (security C3). */
export const FETCH_OPTIONS = {
  credentials: 'omit',
  redirect: 'error',
  referrerPolicy: 'no-referrer',
  cache: 'no-store',
  mode: 'cors',
} as const satisfies RequestInit;

class Stop extends Error {
  constructor(readonly error: ContentError) {
    super(error.kind);
  }
}

/**
 * Fetches a text file with a timeout and a byte cap (ADR 0006, AC5, AC34,
 * security C3). One abort signal covers the request and the whole body read.
 * The cap counts the bytes actually read from `response.body` (after any
 * content decoding), so a gzip bomb or a lying `Content-Length` cannot get
 * past it; on overflow the body is cancelled. Never uses `text()`/`json()`.
 * Strict UTF-8 decoding (a leading BOM is dropped). Never rejects.
 */
export async function fetchText(url: URL, options: FetchTextOptions): Promise<FetchTextResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const signal = controller.signal;

  const abortError = (): ContentError =>
    timedOut
      ? { kind: 'timeout', seconds: Math.round(options.timeoutMs / 1000) }
      : { kind: 'aborted' };

  try {
    let response: Response;
    try {
      response = await fetchImpl(url.href, { ...FETCH_OPTIONS, signal });
    } catch {
      throw new Stop(signal.aborted ? abortError() : { kind: 'network' });
    }
    if (!response.ok) {
      cancelQuietly(response.body);
      throw new Stop({ kind: 'http', status: response.status });
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      cancelQuietly(response.body);
      throw new Stop({ kind: 'too-large', maxBytes: options.maxBytes });
    }
    if (response.body === null) return { ok: true, text: '' };

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await readWithSignal(reader, signal, abortError);
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          throw new Stop({ kind: 'too-large', maxBytes: options.maxBytes });
        }
        text += decode(decoder, value);
      }
      text += decode(decoder);
    } catch (err) {
      reader.cancel().catch(() => undefined);
      controller.abort();
      if (err instanceof Stop) throw err;
      throw new Stop(signal.aborted ? abortError() : { kind: 'network' });
    }
    return { ok: true, text };
  } catch (err) {
    if (err instanceof Stop) return { ok: false, error: err.error };
    return { ok: false, error: { kind: 'network' } };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Strict UTF-8: invalid bytes refuse the file as `invalid-json` (ADR 0006). */
function decode(decoder: TextDecoder, chunk?: Uint8Array): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
  } catch {
    throw new Stop({ kind: 'invalid-json' });
  }
}

function cancelQuietly(body: ReadableStream<Uint8Array> | null): void {
  body?.cancel().catch(() => undefined);
}

/** One `read()`, rejected as soon as the signal aborts (even if the stream ignores it). */
function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  abortError: () => ContentError,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Stop(abortError()));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Stop(abortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error('read failed'));
      },
    );
  });
}
