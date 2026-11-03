import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JoinMethod, ServerMessage } from '@sync-system/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, isSensitiveLogKey } from '../src/logging/logger.js';
import { codesOf, resumeWith } from './helpers/groups.js';
import { LogCapture } from './helpers/log-capture.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';

const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];
const NAME = 'Sentinelname Dana';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** Every message a client receives, kept for inspection. */
async function drain(client: TestClient, ms = 50): Promise<ServerMessage[]> {
  const out: ServerMessage[] = [];
  for (;;) {
    try {
      out.push(await client.next(undefined, ms));
    } catch {
      return out;
    }
  }
}

describe('join secrets never reach logs or other clients (#10 AC10, AC20, AC31, R10, R13)', () => {
  it('logs no code, door code, ticket, blob, display name or request ID on any join path', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({
      scheduler,
      logLevel: 'trace',
      apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL }],
    });
    const secrets: string[] = [NAME];
    const remember = (codes: {
      groupCode?: string;
      doorCode?: string;
      alphaCode?: string;
      blob: string;
    }) => {
      for (const value of [codes.groupCode, codes.doorCode, codes.alphaCode, codes.blob]) {
        if (value !== undefined) secrets.push(value);
      }
    };

    // Method A + C + D: create, joins of every outcome, door rotation, QR.
    const leaderA = await ts.connectReady();
    leaderA.send({ type: 'group.create', metadata: {}, joinMethods: ['A', 'C', 'D'] });
    const createdA = await leaderA.next('group.created');
    remember(createdA.codes);
    const member = await ts.connectReady();
    member.send({ type: 'group.joinByCode', ...codesOf(createdA.codes), displayName: NAME });
    await member.next('group.joined');
    const wrong = createdA.codes.doorCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) {
      const guesser = await ts.connectReady();
      guesser.send({
        type: 'group.joinByCode',
        joinCode: createdA.codes.groupCode,
        doorCode: wrong,
      });
      const reply = await guesser.next('error');
      expect(JSON.stringify(reply)).not.toContain(createdA.codes.groupCode);
    }
    remember((await leaderA.next('codes.updated')).codes);
    leaderA.send({ type: 'qr.issue' });
    const ticket = (await leaderA.next('qr.ticket')).ticket;
    secrets.push(ticket);
    const qrJoiner = await ts.connectReady();
    qrJoiner.send({ type: 'group.joinByQr', ticket, displayName: NAME });
    await qrJoiner.next('group.joined');
    leaderA.send({ type: 'codes.rotate' });
    remember((await leaderA.next('codes.updated')).codes);
    const stale = await ts.connectReady();
    stale.send({ type: 'group.joinByQr', ticket });
    expect(JSON.stringify(await stale.next('error'))).not.toContain(ticket);

    // Method B: approval with a display name, deny and approve.
    const leaderB = await ts.connectReady();
    leaderB.send({ type: 'group.create', metadata: {}, joinMethods: ['B', 'D'] });
    const createdB = await leaderB.next('group.created');
    remember(createdB.codes);
    const asking = await ts.connectReady();
    asking.send({
      type: 'group.joinByCode',
      joinCode: createdB.codes.groupCode,
      displayName: NAME,
    });
    const pending = await asking.next('join.pending');
    secrets.push(pending.requestId);
    const requested = await leaderB.next('join.requested');
    expect(requested.displayName).toBe(NAME);
    leaderB.send({ type: 'join.approve', requestId: pending.requestId });
    await leaderB.next('join.decided');
    await asking.next('group.joined');

    // Recreation with the blob (leader returns after a drop of everyone).
    const lastBlob = createdB.codes.blob;
    await asking.close();
    await leaderB.close();
    const { reply } = await resumeWith(ts, createdB.token, { metadata: {}, joinCodes: lastBlob });
    expect(reply.type).toBe('group.resumed');

    // Pino's own numeric fields could contain any 6 digits by chance.
    const text = ts.logs.text.replace(/"(time|pid|hostname)":("[^"]*"|\d+)/g, '');
    for (const secret of secrets) expect(text, 'log leak').not.toContain(secret);
    // No new log event uses a `reason` field (it is a redacted path since #5).
    for (const record of ts.logs.records()) {
      if (typeof record.event === 'string' && /join|code|qr/.test(record.event)) {
        expect(Object.keys(record)).not.toContain('reason');
      }
    }
    const events = new Set(ts.logs.events());
    for (const event of [
      'join_rejected',
      'codes_rotated',
      'join_requested',
      'join_settled',
      'codes_restored',
    ]) {
      expect(events.has(event), event).toBe(true);
    }

    // Members never receive codes, tickets or names.
    const memberFrames = JSON.stringify(await drain(member));
    for (const secret of secrets) expect(memberFrames).not.toContain(secret);
  });

  it('leaves no timer, code or queue behind after the server closes (AC31, R14)', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({
      scheduler,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL }],
    });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, joinMethods: ['B', 'D'] });
    const created = await leader.next('group.created');
    const asking = await ts.connectReady();
    asking.send({ type: 'group.joinByCode', joinCode: created.codes.groupCode });
    await asking.next('join.pending');
    expect(scheduler.pending).toBeGreaterThan(0);
    await ts.close();
    ts = undefined;
    expect(scheduler.pending).toBe(0);
  });
});

describe('redaction and log fields (#10 R10, B1)', () => {
  const JOIN_KEYS = [
    'joinCode',
    'doorCode',
    'groupCode',
    'alphaCode',
    'codes',
    'joinCodes',
    'blob',
    'ticket',
    'requestId',
    'displayName',
  ];

  it('treats every join field as sensitive', () => {
    for (const key of JOIN_KEYS) expect(isSensitiveLogKey(key), key).toBe(true);
  });

  it('removes every join field at any depth, also inside arrays', () => {
    const out = new LogCapture();
    const logger = createLogger({ level: 'trace', destination: out });
    for (const key of JOIN_KEYS) {
      const value = `SENTINEL-${key}`;
      logger.info({ event: 'test', [key]: value }, 'x');
      logger.info({ event: 'test', a: { b: { c: { [key]: value } } } }, 'x');
      logger.info({ event: 'test', pending: [{ [key]: value }] }, 'x');
      logger.info({ event: 'test', a: { requests: [{ entry: { [key]: value } }] } }, 'x');
    }
    expect(out.lines).toHaveLength(JOIN_KEYS.length * 4);
    expect(out.text).not.toContain('SENTINEL');
  });

  /** Every log call in the server source, with its full argument text. */
  function logCalls(): Array<{ file: string; call: string }> {
    const root = join(import.meta.dirname, '..', 'src');
    const calls: Array<{ file: string; call: string }> = [];
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = join(entry.parentPath, entry.name);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /logger\.(?:trace|debug|info|warn|error|fatal)\(([\s\S]*?)\);/g,
      )) {
        calls.push({ file, call: match[1] ?? '' });
      }
    }
    return calls;
  }

  it('finds the log calls the static checks inspect', () => {
    const calls = logCalls();
    expect(calls.length).toBeGreaterThan(40);
    expect(calls.some(({ file }) => file.includes('joins'))).toBe(true);
  });

  it('never logs a field named reason anywhere in the server (static check)', () => {
    // A key or shorthand property named reason; a value such as
    // `endReason: reason` is fine (the key is not redacted).
    const reasonKey = /[{,]\s*['"]?reason['"]?\s*[:,}]/;
    for (const { file, call } of logCalls()) expect(call, file).not.toMatch(reasonKey);
    expect('{ event, reason }').toMatch(reasonKey);
    expect("{ event: 'x', 'reason': 1 }").toMatch(reasonKey);
    expect('{ endReason: reason, count }').not.toMatch(reasonKey);
  });

  it('never builds a log message from a template literal (static check)', () => {
    for (const { file, call } of logCalls()) expect(call, file).not.toContain('`');
  });

  it('never logs a field named reason in the join module (static check)', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'joins');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const call of source.match(/logger\.\w+\(\s*\{[^}]*\}/g) ?? []) {
        expect(call, file).not.toMatch(/\breason\b/);
      }
    }
  });
});
