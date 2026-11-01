import { describe, expect, it } from 'vitest';
import { createLogger, groupRef, participantRef, safeErr } from '../src/logging/logger.js';
import { LogCapture } from './helpers/log-capture.js';

describe('createLogger', () => {
  it('removes sensitive keys as a second line of defense', () => {
    const capture = new LogCapture();
    const logger = createLogger({ level: 'trace', destination: capture });
    logger.info(
      {
        event: 'test',
        apiKey: 'SENTINEL-1',
        position: { page: 'SENTINEL-2' },
        metadata: 'SENTINEL-3',
        ip: '127.0.0.1',
        remoteAddress: '::1',
        headers: { host: 'SENTINEL-4' },
        req: { url: 'SENTINEL-5' },
        displayName: 'SENTINEL-6',
        reason: 'SENTINEL-7',
        message: 'SENTINEL-8',
        nested: { apiKey: 'SENTINEL-9', position: 1, metadata: 2, displayName: 'SENTINEL-10' },
      },
      'human readable',
    );
    expect(capture.text).not.toContain('SENTINEL');
    expect(capture.text).not.toContain('127.0.0.1');
    expect(capture.text).not.toContain('::1');
    const [record] = capture.records();
    expect(record).toMatchObject({ event: 'test', msg: 'human readable', nested: {} });
  });

  it('respects the level', () => {
    const capture = new LogCapture();
    const logger = createLogger({ level: 'warn', destination: capture });
    logger.info({ event: 'info' }, 'x');
    logger.warn({ event: 'warn' }, 'y');
    expect(capture.events()).toEqual(['warn']);
  });
});

describe('refs', () => {
  it('logs a short stable hash instead of the raw value', () => {
    const id = 'A'.repeat(43);
    expect(groupRef(id)).toMatch(/^[0-9a-f]{12}$/);
    expect(groupRef(id)).toBe(groupRef(id));
    expect(groupRef(id)).not.toBe(groupRef('B'.repeat(43)));
    expect(participantRef('p')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('safeErr (L5)', () => {
  it('keeps name, code and frames but never the message', () => {
    const err = new TypeError('bad input SENTINEL\nsecond line SENTINEL') as TypeError & {
      code?: string;
    };
    err.code = 'E_TEST';
    const safe = safeErr(err);
    expect(safe.name).toBe('TypeError');
    expect(safe.code).toBe('E_TEST');
    expect(safe.frames.length).toBeGreaterThan(0);
    expect(safe.frames.every((frame) => frame.startsWith('at '))).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
  });

  it('handles non-errors', () => {
    expect(safeErr('SENTINEL')).toEqual({ name: 'string', frames: [] });
    expect(safeErr(undefined)).toEqual({ name: 'undefined', frames: [] });
  });
});
