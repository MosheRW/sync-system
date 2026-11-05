// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FETCH_OPTIONS, type FetchLike, fetchText } from '../src/content/fetch-text.js';

const URL_ = new URL('https://content.example.org/a.json');
const MAX = 1024;

function stream(chunks: Uint8Array[], { hang = false } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else if (!hang) controller.close();
      else return new Promise<void>(() => undefined);
    },
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

function respond(body: BodyInit | null, init: ResponseInit = {}): FetchLike {
  return () => Promise.resolve(new Response(body, init));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchText (AC5, AC34, ADR 0006, security C3)', () => {
  it('sends exactly the ADR 0006 request options to url.href', async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(new Response('{}')));
    await fetchText(URL_, { timeoutMs: 1000, maxBytes: MAX, fetchImpl });
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(input).toBe(URL_.href);
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      mode: 'cors',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(FETCH_OPTIONS).toEqual({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      mode: 'cors',
    });
  });

  it('returns the text, dropping a BOM', async () => {
    const result = await fetchText(URL_, {
      timeoutMs: 1000,
      maxBytes: MAX,
      fetchImpl: respond(stream([new Uint8Array([0xef, 0xbb, 0xbf]), bytes('{"a":"שלום"}')])),
    });
    expect(result).toEqual({ ok: true, text: '{"a":"שלום"}' });
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const all = bytes('שלום');
    const result = await fetchText(URL_, {
      timeoutMs: 1000,
      maxBytes: MAX,
      fetchImpl: respond(stream([all.slice(0, 1), all.slice(1)])),
    });
    expect(result).toEqual({ ok: true, text: 'שלום' });
  });

  it('maps a network error', async () => {
    const result = await fetchText(URL_, {
      timeoutMs: 1000,
      maxBytes: MAX,
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(result).toEqual({ ok: false, error: { kind: 'network' } });
  });

  it.each([404, 500])('maps HTTP %i', async (status) => {
    const result = await fetchText(URL_, {
      timeoutMs: 1000,
      maxBytes: MAX,
      fetchImpl: respond('nope', { status }),
    });
    expect(result).toEqual({ ok: false, error: { kind: 'http', status } });
  });

  it('refuses a declared Content-Length over the cap before reading', async () => {
    const body = stream([bytes('x')]);
    const result = await fetchText(URL_, {
      timeoutMs: 1000,
      maxBytes: MAX,
      fetchImpl: respond(body, { headers: { 'content-length': String(MAX + 1) } }),
    });
    expect(result).toEqual({ ok: false, error: { kind: 'too-large', maxBytes: MAX } });
  });

  it('caps the streamed body when Content-Length lies or is absent', async () => {
    const chunk = new Uint8Array(400).fill(0x20);
    const variants: Record<string, string>[] = [{ 'content-length': '10' }, {}];
    for (const headers of variants) {
      const result = await fetchText(URL_, {
        timeoutMs: 1000,
        maxBytes: MAX,
        fetchImpl: respond(stream([chunk, chunk, chunk, chunk]), { headers }),
      });
      expect(result).toEqual({ ok: false, error: { kind: 'too-large', maxBytes: MAX } });
    }
  });

  it('counts decoded bytes: a small gzip body that inflates past the cap is refused', async () => {
    // What the browser hands to the reader after content decoding: the
    // inflated bytes. The compressed size is far below the cap.
    const inflated = new Uint8Array(MAX * 20).fill(0x20);
    expect(gzipSync(inflated).byteLength).toBeLessThan(MAX);
    const result = await fetchText(URL_, {
      timeoutMs: 1000,
      maxBytes: MAX,
      fetchImpl: respond(stream([inflated]), {
        headers: { 'content-length': String(gzipSync(inflated).byteLength) },
      }),
    });
    expect(result).toEqual({ ok: false, error: { kind: 'too-large', maxBytes: MAX } });
  });

  it('treats a null body as empty text (never text())', async () => {
    const response = new Response(null, { status: 200 });
    const text = vi.spyOn(response, 'text');
    const json = vi.spyOn(response, 'json');
    const result = await fetchText(URL_, {
      timeoutMs: 1000,
      maxBytes: MAX,
      fetchImpl: () => Promise.resolve(response),
    });
    expect(result).toEqual({ ok: true, text: '' });
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('refuses invalid UTF-8 as invalid-json', async () => {
    const result = await fetchText(URL_, {
      timeoutMs: 1000,
      maxBytes: MAX,
      fetchImpl: respond(stream([new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])])),
    });
    expect(result).toEqual({ ok: false, error: { kind: 'invalid-json' } });
  });

  it('times out waiting for headers (default 15 s)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const pending = fetchText(URL_, { timeoutMs: 15_000, maxBytes: MAX, fetchImpl: hanging });
    await vi.advanceTimersByTimeAsync(14_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: { kind: 'timeout', seconds: 15 } });
  });

  it('times out on a slow body with the configured value (3 s)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = fetchText(URL_, {
      timeoutMs: 3000,
      maxBytes: MAX,
      fetchImpl: respond(stream([bytes('{"a":')], { hang: true })),
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toEqual({ ok: false, error: { kind: 'timeout', seconds: 3 } });
  });

  it('reports a caller abort as aborted', async () => {
    const controller = new AbortController();
    const pending = fetchText(URL_, {
      timeoutMs: 10_000,
      maxBytes: MAX,
      signal: controller.signal,
      fetchImpl: respond(stream([bytes('{')], { hang: true })),
    });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: 'aborted' } });
  });
});
