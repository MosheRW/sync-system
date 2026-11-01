import { describe, expect, it } from 'vitest';
import {
  MAX_API_KEY_LENGTH,
  MAX_APP_VERSION_INPUT_LENGTH,
  MAX_GROUP_ID_INPUT_LENGTH,
  MAX_REQ_ID_LENGTH,
  parseClientMessage,
  parseServerMessage,
} from '../src/index.js';

const KEY = 'k'.repeat(40);
const GROUP_ID = 'A'.repeat(43);

function ok(value: unknown) {
  const result = parseClientMessage(value);
  if (!result.ok) throw new Error(`expected ok, got ${result.issues.join(', ')}`);
  return result.message;
}

function fails(value: unknown): string[] {
  const result = parseClientMessage(value);
  if (result.ok) throw new Error('expected failure');
  return result.issues;
}

describe('client message schemas', () => {
  it('parses every client message type', () => {
    expect(ok({ type: 'hello', protocolVersion: 1, appVersion: '1.0.0', apiKey: KEY }).type).toBe(
      'hello',
    );
    expect(ok({ type: 'group.create', metadata: {} }).type).toBe('group.create');
    expect(ok({ type: 'group.create', metadata: { a: 1 }, position: null }).type).toBe(
      'group.create',
    );
    expect(ok({ type: 'group.join', groupId: GROUP_ID, reqId: 'r1' }).type).toBe('group.join');
    expect(ok({ type: 'position.update', position: 'p' }).type).toBe('position.update');
  });

  it('ignores unknown extra fields', () => {
    const message = ok({ type: 'group.join', groupId: GROUP_ID, displayName: 'x', extra: [1] });
    expect(message).toEqual({ type: 'group.join', groupId: GROUP_ID });
  });

  it('accepts a hello without an apiKey so the handshake can report INVALID_API_KEY', () => {
    expect(ok({ type: 'hello', protocolVersion: 1, appVersion: '1.0.0' }).type).toBe('hello');
  });

  it('rejects unknown types, missing fields and non-objects', () => {
    fails({ type: 'group.list' });
    fails({ type: 'position.update' });
    fails({ type: 'group.join' });
    fails({ type: 'hello', appVersion: '1.0.0', apiKey: KEY });
    fails({ type: 'hello', protocolVersion: 1.5, appVersion: '1.0.0' });
    fails({});
    fails([]);
    fails('hello');
    fails(null);
  });

  it('requires metadata to be a non-array object', () => {
    fails({ type: 'group.create' });
    fails({ type: 'group.create', metadata: [] });
    fails({ type: 'group.create', metadata: null });
    fails({ type: 'group.create', metadata: 'x' });
  });

  it('accepts null and falsy values as a position payload', () => {
    for (const position of [null, 0, false, '', [], {}]) {
      expect(ok({ type: 'position.update', position })).toEqual({
        type: 'position.update',
        position,
      });
    }
  });

  it('bounds string lengths (L2, L3)', () => {
    const hello = { type: 'hello', protocolVersion: 1, appVersion: '1.0.0' };
    ok({ ...hello, apiKey: 'k'.repeat(MAX_API_KEY_LENGTH) });
    fails({ ...hello, apiKey: 'k'.repeat(MAX_API_KEY_LENGTH + 1) });
    ok({ ...hello, appVersion: '1'.repeat(MAX_APP_VERSION_INPUT_LENGTH) });
    fails({ ...hello, appVersion: '1'.repeat(MAX_APP_VERSION_INPUT_LENGTH + 1) });
    ok({ type: 'group.join', groupId: 'g'.repeat(MAX_GROUP_ID_INPUT_LENGTH) });
    fails({ type: 'group.join', groupId: 'g'.repeat(MAX_GROUP_ID_INPUT_LENGTH + 1) });
    ok({ type: 'group.join', groupId: GROUP_ID, reqId: 'r'.repeat(MAX_REQ_ID_LENGTH) });
    fails({ type: 'group.join', groupId: GROUP_ID, reqId: 'r'.repeat(MAX_REQ_ID_LENGTH + 1) });
  });

  it('never echoes received values in issues', () => {
    const secret = 'SENTINEL-SECRET-' + 'x'.repeat(300);
    const issues = fails({ type: 'hello', protocolVersion: 'v', appVersion: 7, apiKey: secret });
    expect(issues.join('\n')).not.toContain('SENTINEL');
    expect(issues).toContain('apiKey: too_big');
  });

  it('passes position and metadata through by reference (L6)', () => {
    const position = { nested: { deep: [1, 2, { x: 'y' }] } };
    const metadata = JSON.parse('{"__proto__": {"polluted": true}, "contentId": "c"}') as object;
    const update = ok({ type: 'position.update', position });
    expect(update.type === 'position.update' && update.position).toBe(position);
    const create = ok({ type: 'group.create', metadata, position });
    expect(create.type === 'group.create' && create.metadata).toBe(metadata);
    expect(Object.keys(metadata)).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('server message schemas', () => {
  it('parses every server message type', () => {
    const messages = [
      { type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 },
      {
        type: 'hello.ok',
        participantId: 'p',
        limits: { maxGroupSize: 30, maxLeaderUpdatesPerSecond: 5, maxMessageBytes: 4096 },
      },
      { type: 'group.created', groupId: GROUP_ID, participantId: 'p', role: 'leader' },
      {
        type: 'group.joined',
        groupId: GROUP_ID,
        participantId: 'p',
        role: 'member',
        metadata: {},
        hasPosition: true,
        position: null,
      },
      {
        type: 'group.joined',
        groupId: GROUP_ID,
        participantId: 'p',
        role: 'member',
        metadata: {},
        hasPosition: false,
      },
      { type: 'position.ack', reqId: 'r' },
      { type: 'position.updated', groupId: GROUP_ID, position: [1] },
      { type: 'group.ended', groupId: GROUP_ID, reason: 'leader_disconnected' },
      { type: 'error', code: 'GROUP_FULL', message: 'full', details: { maxGroupSize: 3 } },
    ];
    for (const message of messages) {
      expect(parseServerMessage(message).ok, message.type).toBe(true);
    }
    expect(parseServerMessage({ type: 'error', code: 'NOPE', message: '' }).ok).toBe(false);
  });
});
