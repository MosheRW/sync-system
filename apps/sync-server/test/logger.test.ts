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

  it('removes join codes and codes blobs (#10 R10)', () => {
    const capture = new LogCapture();
    const logger = createLogger({ level: 'trace', destination: capture });
    logger.info(
      {
        event: 'test',
        codes: { groupCode: 'SENTINEL-1', blob: 'SENTINEL-2' },
        joinCodes: 'SENTINEL-3',
        blob: 'SENTINEL-4',
        nested: { codes: 'SENTINEL-5', joinCodes: 'SENTINEL-6', blob: 'SENTINEL-7' },
        x: { blob: 'SENTINEL-8' },
        joinCode: 'SENTINEL-9',
        doorCode: 'SENTINEL-10',
        groupCode: 'SENTINEL-11',
        alphaCode: 'SENTINEL-12',
        y: { joinCode: 'S-13', doorCode: 'S-14', groupCode: 'S-15', alphaCode: 'S-16' },
        requestId: 'SENTINEL-17',
        ticket: 'SENTINEL-18',
        z: { requestId: 'S-19', ticket: 'S-10' },
      },
      'codes',
    );
    expect(capture.text).not.toContain('SENTINEL');
    expect(capture.text).not.toContain('S-1');
  });

  it('removes display names from logged join messages (#10 A1)', () => {
    const capture = new LogCapture();
    const logger = createLogger({ level: 'trace', destination: capture });
    const joinByCode = {
      type: 'group.joinByCode',
      joinCode: '123456',
      displayName: 'SENTINEL-NAME-1',
    };
    const joinRequested = {
      type: 'join.requested',
      groupId: 'g',
      requestId: 'r',
      expiresInMs: 1,
      displayName: 'SENTINEL-NAME-2',
    };
    logger.info({ event: 'test', ...joinByCode }, 'spread');
    logger.info({ event: 'test', message: joinByCode, frame: joinRequested }, 'nested');
    logger.info({ event: 'test', request: { displayName: 'SENTINEL-NAME-3' } }, 'entry');
    expect(capture.text).not.toContain('SENTINEL');
    const [spread, nested, entry] = capture.records();
    expect(spread).toMatchObject({ event: 'test', type: 'group.joinByCode' });
    expect(spread).not.toHaveProperty('displayName');
    expect(nested).toMatchObject({ frame: { type: 'join.requested', expiresInMs: 1 } });
    expect(nested).not.toHaveProperty('frame.displayName');
    expect(entry).toMatchObject({ request: {} });
    expect(entry).not.toHaveProperty('request.displayName');
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

  it('never takes message lines that look like frames for frames (C3)', () => {
    const inject = 'bad\n    at SENTINEL-1 (evil.js:1:1)\n    at SENTINEL-2';
    const plain = new Error(inject);
    const typed = new RangeError(`x\n  at SENTINEL-3\n\tat SENTINEL-4`);
    const coded = Object.assign(new Error(inject), { code: 'E_TEST' });
    const empty = new Error('');
    for (const err of [plain, typed, coded, empty]) {
      const safe = safeErr(err);
      expect(safe.frames.length).toBeGreaterThan(0);
      expect(safe.frames.every((frame) => frame.startsWith('at '))).toBe(true);
      expect(safe.frames[0]).toContain('logger.test');
      expect(JSON.stringify(safe)).not.toContain('SENTINEL');
    }
  });

  it('skips the header of a Node error with a code in brackets (C3)', () => {
    let nodeError: unknown;
    try {
      Buffer.alloc(-1);
    } catch (err) {
      nodeError = err;
    }
    const safe = safeErr(nodeError);
    expect(safe.name).toBe('RangeError');
    expect(safe.code).toBe('ERR_OUT_OF_RANGE');
    expect(safe.frames.length).toBeGreaterThan(0);
  });

  it('trusts no frame when the message no longer matches the stack (C3)', () => {
    const err = new Error('first\n    at SENTINEL-1');
    void err.stack; // the stack text is written on first read
    err.message = 'changed';
    expect(safeErr(err).frames).toEqual([]);
    const replaced = new Error('m');
    replaced.stack = 'SENTINEL-2\n    at SENTINEL-3';
    expect(JSON.stringify(safeErr(replaced))).not.toContain('SENTINEL');
  });

  it('describes errors from another realm (C3)', async () => {
    const { runInNewContext } = await import('node:vm');
    const foreign = runInNewContext('new TypeError("SENTINEL-1")') as unknown;
    expect(foreign instanceof Error).toBe(false);
    const safe = safeErr(foreign);
    expect(safe.name).toBe('TypeError');
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
  });

  it('handles non-errors', () => {
    expect(safeErr('SENTINEL')).toEqual({ name: 'string', frames: [] });
    expect(safeErr(undefined)).toEqual({ name: 'undefined', frames: [] });
  });
});
