import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import { LogCapture } from './helpers/log-capture.js';

/**
 * Every field name that must never reach a log line (#10 B1), from an audit
 * of the protocol (client and server messages), the server config, the
 * #5 token work and the #10 join work. The list is written out here, not
 * imported, so the test stays independent of the implementation.
 */
const SENSITIVE_KEYS = [
  // Display names (#10 AC20, R9).
  'displayName',
  // Join codes, door codes, the codes payload and the signed codes blob (#10 R10).
  'joinCode',
  'doorCode',
  'groupCode',
  'alphaCode',
  'codes',
  'joinCodes',
  'blob',
  // QR tickets (#10 method D).
  'ticket',
  'qrTicket',
  // Join request IDs (#10 B).
  'requestId',
  // Tokens, group-scoped participant IDs, block lists, secrets (#5 AC10).
  'token',
  'tokens',
  'participantId',
  'blockList',
  'secret',
  'tokenSecret',
  // Group IDs are join capabilities; logs only ever see groupRef.
  'groupId',
  // API keys (#1).
  'apiKey',
  // Client-chosen free text echoed by the server.
  'reqId',
  'appVersion',
  // Opaque app data (#1, #3).
  'position',
  'metadata',
  'payload',
  // Network identity and raw requests.
  'ip',
  'remoteAddress',
  'headers',
  'req',
  'url',
  // Free text that may carry input (#5).
  'reason',
  'message',
  // pino's message key (QA round 3 finding 2, security C1).
  'msg',
] as const;

/** The shapes each key is logged in: top level, deep, arrays, mixed. */
function shapes(key: string, value: string): Array<Record<string, unknown>> {
  return [
    { [key]: value },
    { a: { [key]: value } },
    { a: { b: { c: { [key]: value } } } },
    { a: { b: { c: { d: { e: { f: { [key]: value } } } } } } },
    { list: [{ [key]: value }] },
    { pending: [{ expiresAt: 1, [key]: value }] },
    { requests: [{ entry: { [key]: value } }] },
    { a: { list: [{ b: [{ [key]: value }] }] } },
    { matrix: [[{ [key]: value }]] },
    { a: [1, 'two', { b: { [key]: value } }] },
  ];
}

function capture() {
  const out = new LogCapture();
  return { out, logger: createLogger({ level: 'trace', destination: out }) };
}

describe('log redaction at any depth (#10 B1)', () => {
  it.each(SENSITIVE_KEYS)('never logs %s at any depth or inside arrays', (key) => {
    const { out, logger } = capture();
    const value = `SENTINEL-${key}-VALUE`;
    for (const shape of shapes(key, value)) {
      logger.info({ event: 'test', ...shape }, 'fixed text');
    }
    expect(out.lines).toHaveLength(shapes(key, value).length);
    expect(out.text).not.toContain(value);
    for (const record of out.records()) expect(record.event).toBe('test');
  });

  it.each(SENSITIVE_KEYS)('never logs %s when its value is an object or array', (key) => {
    const { out, logger } = capture();
    logger.info({ event: 'test', [key]: { inner: 'SENTINEL-OBJ' } }, 'x');
    logger.info({ event: 'test', a: { b: { c: { [key]: ['SENTINEL-ARR'] } } } }, 'x');
    logger.info({ event: 'test', list: [{ [key]: [{ x: 'SENTINEL-AOO' }] }] }, 'x');
    expect(out.text).not.toContain('SENTINEL');
  });

  it('matches key spellings regardless of case, underscores and hyphens', () => {
    const { out, logger } = capture();
    logger.info(
      {
        event: 'test',
        DisplayName: 'SENTINEL-1',
        display_name: 'SENTINEL-2',
        'join-code': 'SENTINEL-3',
        JOIN_CODES: 'SENTINEL-4',
        a: { b: { c: [{ API_KEY: 'SENTINEL-5', Remote_Address: 'SENTINEL-6' }] } },
      },
      'x',
    );
    expect(out.text).not.toContain('SENTINEL');
  });

  it('removes keys that contain a credential word (token, secret, ticket, ...)', () => {
    const { out, logger } = capture();
    logger.info(
      {
        event: 'test',
        refreshToken: 'SENTINEL-1',
        previousSecret: 'SENTINEL-2',
        qrTicketFragment: 'SENTINEL-3',
        nested: [{ leaderToken: 'SENTINEL-4', joinRequestId: 'SENTINEL-5' }],
        password: 'SENTINEL-6',
        authorization: 'SENTINEL-7',
        cookie: 'SENTINEL-8',
        doorCodes: ['SENTINEL-9'],
        participantIds: ['SENTINEL-10'],
        pendingDisplayNames: ['SENTINEL-11'],
      },
      'x',
    );
    expect(out.text).not.toContain('SENTINEL');
  });

  it('keeps the allowed fields at every depth', () => {
    const { out, logger } = capture();
    logger.info(
      {
        event: 'test',
        namespace: 'app-a',
        groupRef: 'abc123',
        participantRef: 'def456',
        code: 'CODE_NOT_FOUND',
        count: 3,
        outcome: 'admitted',
        nested: { list: [{ count: 1, cause: 'leader' }], flag: true, none: null },
      },
      'kept',
    );
    expect(out.records()[0]).toMatchObject({
      event: 'test',
      namespace: 'app-a',
      groupRef: 'abc123',
      participantRef: 'def456',
      code: 'CODE_NOT_FOUND',
      count: 3,
      outcome: 'admitted',
      nested: { list: [{ count: 1, cause: 'leader' }], flag: true, none: null },
      msg: 'kept',
    });
  });

  it('logs a pending-requests snapshot without names, IDs or codes', () => {
    const { out, logger } = capture();
    const queue = {
      groupId: 'SENTINEL-GROUP',
      pending: [
        { requestId: 'SENTINEL-R1', displayName: 'SENTINEL-N1', expiresAt: 1 },
        { requestId: 'SENTINEL-R2', displayName: 'SENTINEL-N2', expiresAt: 2 },
      ],
      codes: { groupCode: 'SENTINEL-G', doorCode: 'SENTINEL-D', blob: 'SENTINEL-B' },
    };
    logger.info({ event: 'test', queue, requests: queue.pending }, 'snapshot');
    expect(out.text).not.toContain('SENTINEL');
    expect(out.records()[0]).toMatchObject({
      queue: { pending: [{ expiresAt: 1 }, { expiresAt: 2 }] },
      requests: [{ expiresAt: 1 }, { expiresAt: 2 }],
    });
  });

  it('survives cycles and still removes sensitive keys', () => {
    const { out, logger } = capture();
    const node: Record<string, unknown> = { displayName: 'SENTINEL-1', count: 1 };
    node.self = node;
    node.list = [node, { child: node, joinCode: 'SENTINEL-2' }];
    logger.info({ event: 'test', node }, 'cycle');
    expect(out.text).not.toContain('SENTINEL');
    expect(out.records()[0]).toMatchObject({ event: 'test', node: { count: 1 } });
  });

  it('walks class instances and objects with toJSON', () => {
    const { out, logger } = capture();
    class Entry {
      displayName = 'SENTINEL-1';
      count = 2;
    }
    const withToJson = { toJSON: () => ({ ticket: 'SENTINEL-2', kept: true }) };
    logger.info({ event: 'test', entry: new Entry(), list: [withToJson] }, 'x');
    expect(out.text).not.toContain('SENTINEL');
    expect(out.records()[0]).toMatchObject({ entry: { count: 2 }, list: [{ kept: true }] });
  });

  it('never logs an error message, at the top level or nested', () => {
    const { out, logger } = capture();
    logger.error(new Error('SENTINEL-1 bad input'));
    logger.error({ event: 'test', err: new Error('SENTINEL-2') });
    logger.error({ event: 'test', a: { list: [new TypeError('SENTINEL-3')] } }, 'x');
    expect(out.text).not.toContain('SENTINEL');
    expect(out.records()[1]).toMatchObject({ event: 'test', err: { name: 'Error' } });
  });

  it('never interpolates extra arguments into the message', () => {
    const { out, logger } = capture();
    logger.info({ event: 'test' }, 'name %s code %d obj %j', 'SENTINEL-1', 123456, {
      displayName: 'SENTINEL-2',
    });
    logger.info('only %s', 'SENTINEL-3');
    expect(out.text).not.toContain('SENTINEL');
    expect(out.text).not.toContain('123456');
  });

  it('removes sensitive keys from child logger bindings', () => {
    const { out, logger } = capture();
    logger
      .child({ displayName: 'SENTINEL-1', a: { b: [{ joinCode: 'SENTINEL-2' }] }, side: 'x' })
      .info({ event: 'test' }, 'child');
    logger
      .child({ side: 'y' })
      .child({ list: [{ ticket: 'SENTINEL-3' }], side2: 'z' })
      .info({ event: 'grandchild' }, 'grandchild');
    expect(out.text).not.toContain('SENTINEL');
    expect(out.records()[0]).toMatchObject({ event: 'test', side: 'x' });
    expect(out.records()[1]).toMatchObject({ event: 'grandchild', side: 'y', side2: 'z' });
  });

  it('never writes a msg field, and keeps the real message (QA round 3 finding 2)', () => {
    const { out, logger } = capture();
    logger.info({ msg: 'SENTINEL-1' });
    logger.info({ msg: 'SENTINEL-2' }, 'real');
    logger.info({ event: 'test', msg: 'SENTINEL-3' }, 'real');
    logger.info({ event: 'test', MSG: 'SENTINEL-4', a: [{ msg: 'SENTINEL-5' }] }, 'real');
    logger.child({ msg: 'SENTINEL-6' }).info({ event: 'child' }, 'real');
    expect(out.text).not.toContain('SENTINEL');
    expect(out.lines).toHaveLength(5);
    const [first, ...rest] = out.lines;
    expect(first).not.toContain('"msg"');
    for (const line of rest) {
      // Exactly one msg key per line, and it is the real message.
      expect(line.match(/"msg":/g)).toHaveLength(1);
      expect(JSON.parse(line)).toMatchObject({ msg: 'real' });
    }
  });

  it('does not mutate the logged object', () => {
    const { logger } = capture();
    const fields = { event: 'test', a: { displayName: 'n', list: [{ ticket: 't' }] } };
    logger.info(fields, 'x');
    expect(fields).toEqual({ event: 'test', a: { displayName: 'n', list: [{ ticket: 't' }] } });
  });
});
