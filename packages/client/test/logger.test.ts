import { describe, expect, it, vi } from 'vitest';
import { log } from '../src/logger.js';

describe('log', () => {
  it('calls the method with the event and fields, and skips missing methods', () => {
    const info = vi.fn();
    log({ info }, 'info', 'state_changed', { status: 'connected' });
    expect(info).toHaveBeenCalledWith('state_changed', { status: 'connected' });
    expect(() => log({}, 'debug', 'x')).not.toThrow();
    expect(() => log(undefined, 'error', 'x')).not.toThrow();
  });

  it('swallows logger exceptions', () => {
    const logger = {
      warn: () => {
        throw new Error('boom');
      },
    };
    expect(() => log(logger, 'warn', 'x')).not.toThrow();
  });
});
