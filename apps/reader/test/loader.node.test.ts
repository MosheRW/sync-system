// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/content/fetch-text.js';
import { type ContentLoaderOptions, createContentLoader } from '../src/content/loader.js';
import { docText, validDoc } from './helpers/content.js';

const text = docText();
const reformatted = JSON.stringify(
  Object.fromEntries(Object.entries(validDoc()).reverse()),
  null,
  2,
);

const config = {
  srcOrigins: ['https://content.example.org'],
  fetchTimeoutSeconds: 15,
  srcMaxBytes: 5 * 1024 * 1024,
};

function loader(overrides: Partial<ContentLoaderOptions> = {}) {
  return createContentLoader({
    bundled: { 'acme/sample': () => Promise.resolve(text) },
    config,
    fetchImpl: () => Promise.resolve(new Response(reformatted)),
    ...overrides,
  });
}

describe('content loader (AC2, AC8, AC17)', () => {
  it('gives the same shape and metadata for bundled and fetched content', async () => {
    const l = loader();
    const bundled = await l.load({ kind: 'bundled', contentId: 'acme/sample' });
    const fetched = await l.load({ kind: 'url', url: 'https://content.example.org/sample.json' });
    if (!bundled.ok || !fetched.ok) throw new Error('expected both to load');
    expect(bundled.content.source).toBe('bundled');
    expect(fetched.content.source).toBe('url');
    expect(Object.keys(bundled.content).sort()).toEqual(Object.keys(fetched.content).sort());
    expect(fetched.content.document).toEqual(bundled.content.document);
    expect(fetched.content.metadata).toEqual(bundled.content.metadata);
    expect(bundled.content.metadata).toEqual({
      contentId: 'acme/sample',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      schemaVersion: 1,
    });
  });

  it('declares version lookup as not supported (AC17)', () => {
    expect(loader().capabilities.versionLookup).toBe(false);
  });

  it('returns not-found for an unknown bundled ID, including prototype names', async () => {
    const l = loader();
    for (const contentId of ['acme/missing', 'constructor', '__proto__', 'toString']) {
      expect(await l.load({ kind: 'bundled', contentId })).toEqual({
        ok: false,
        error: { kind: 'not-found', contentId },
      });
    }
  });

  it('never fetches a URL refused by the src policy', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const l = loader({ fetchImpl });
    expect(await l.load({ kind: 'url', url: 'https://evil.net/a.json' })).toEqual({
      ok: false,
      error: { kind: 'src-not-allowed', origin: 'https://evil.net' },
    });
    expect(await l.load({ kind: 'url', url: 'javascript:alert(1)' })).toEqual({
      ok: false,
      error: { kind: 'src-invalid' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes fetch errors and validation errors through', async () => {
    const failing = loader({ fetchImpl: () => Promise.resolve(new Response('', { status: 503 })) });
    expect(await failing.load({ kind: 'url', url: 'https://content.example.org/a.json' })).toEqual({
      ok: false,
      error: { kind: 'http', status: 503 },
    });

    const invalid = loader({ bundled: { 'acme/sample': () => Promise.resolve('{') } });
    expect(await invalid.load({ kind: 'bundled', contentId: 'acme/sample' })).toEqual({
      ok: false,
      error: { kind: 'invalid-json' },
    });
  });

  it('reports a failed bundled chunk download as a network error', async () => {
    const l = loader({ bundled: { 'acme/sample': () => Promise.reject(new Error('chunk')) } });
    expect(await l.load({ kind: 'bundled', contentId: 'acme/sample' })).toEqual({
      ok: false,
      error: { kind: 'network' },
    });
  });

  it('refuses with crypto-unavailable without Web Crypto', async () => {
    const l = loader({ subtle: null });
    expect(await l.load({ kind: 'bundled', contentId: 'acme/sample' })).toEqual({
      ok: false,
      error: { kind: 'crypto-unavailable' },
    });
  });

  it('reports aborted when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await loader().load(
        { kind: 'bundled', contentId: 'acme/sample' },
        { signal: controller.signal },
      ),
    ).toEqual({ ok: false, error: { kind: 'aborted' } });
  });

  it('applies the configured timeout to fetches (AC34)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hanging: FetchLike = (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const l = loader({ fetchImpl: hanging, config: { ...config, fetchTimeoutSeconds: 3 } });
      const pending = l.load({ kind: 'url', url: 'https://content.example.org/a.json' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({ ok: false, error: { kind: 'timeout', seconds: 3 } });
    } finally {
      vi.useRealTimers();
    }
  });
});
