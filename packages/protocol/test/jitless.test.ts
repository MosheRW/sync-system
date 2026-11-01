import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildJitless } from '../src/jitless.js';

describe('buildJitless', () => {
  afterEach(() => {
    z.config({ jitless: undefined });
  });

  it('turns jitless on during the build and restores the previous value', () => {
    z.config({ jitless: false });
    const seen = buildJitless(() => z.config().jitless);
    expect(seen).toBe(true);
    expect(z.config().jitless).toBe(false);
  });

  it('restores the previous value when the build throws', () => {
    expect(z.config().jitless).toBeUndefined();
    expect(() =>
      buildJitless(() => {
        throw new Error('build failed');
      }),
    ).toThrow('build failed');
    expect(z.config().jitless).toBeUndefined();
  });
});
