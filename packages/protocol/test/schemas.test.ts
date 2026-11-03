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
const BLOB = `eyJ2IjoxfQ.${'B'.repeat(43)}`;

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

describe('token messages (#5)', () => {
  const PID = '0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b';

  it('parses group.resume, group.end and group.leave', () => {
    expect(ok({ type: 'group.resume', token: 't' }).type).toBe('group.resume');
    expect(
      ok({ type: 'group.resume', token: 't', metadata: {}, position: null, blockList: [PID] }).type,
    ).toBe('group.resume');
    expect(ok({ type: 'group.end', reqId: 'e' }).type).toBe('group.end');
    expect(ok({ type: 'group.leave' }).type).toBe('group.leave');
  });

  it('bounds the token and the block list (AC24)', () => {
    ok({ type: 'group.resume', token: 'x'.repeat(2048) });
    fails({ type: 'group.resume', token: 'x'.repeat(2049) });
    fails({ type: 'group.resume' });
    fails({ type: 'group.resume', token: 1 });
    ok({ type: 'group.resume', token: 't', blockList: Array.from({ length: 256 }, () => PID) });
    fails({ type: 'group.resume', token: 't', blockList: Array.from({ length: 257 }, () => PID) });
    fails({ type: 'group.resume', token: 't', blockList: ['not-a-uuid'] });
    fails({ type: 'group.resume', token: 't', blockList: PID });
    fails({ type: 'group.resume', token: 't', metadata: [] });
  });
});

describe('approval messages (#10 AC19-AC22)', () => {
  const RID = 'R'.repeat(22);

  it('parses join.cancel, join.approve and join.deny with a request ID', () => {
    expect(ok({ type: 'join.cancel' }).type).toBe('join.cancel');
    expect(ok({ type: 'join.approve', requestId: RID }).type).toBe('join.approve');
    expect(ok({ type: 'join.deny', reqId: 'r', requestId: RID }).type).toBe('join.deny');
    for (const requestId of [undefined, '', 'R'.repeat(21), 'R'.repeat(23), `${'R'.repeat(21)}=`]) {
      fails({ type: 'join.approve', requestId });
      fails({ type: 'join.deny', requestId });
    }
  });

  it('parses the approval events', () => {
    for (const message of [
      { type: 'join.pending', reqId: 'r', requestId: RID, timeoutMs: 120_000 },
      { type: 'join.requested', groupId: GROUP_ID, requestId: RID, expiresInMs: 5 },
      {
        type: 'join.requested',
        groupId: GROUP_ID,
        requestId: RID,
        expiresInMs: 5,
        displayName: 'Dana',
      },
      { type: 'join.withdrawn', groupId: GROUP_ID, requestId: RID, reason: 'cancelled' },
      { type: 'join.withdrawn', groupId: GROUP_ID, requestId: RID, reason: 'disconnected' },
      { type: 'join.withdrawn', groupId: GROUP_ID, requestId: RID, reason: 'timeout' },
      { type: 'join.decided', reqId: 'r', requestId: RID, outcome: 'admitted' },
      { type: 'join.decided', requestId: RID, outcome: 'group_full' },
      { type: 'join.decided', requestId: RID, outcome: 'denied' },
      { type: 'join.cancelled', requestId: RID },
    ]) {
      expect(parseServerMessage(message).ok, message.type).toBe(true);
    }
    expect(
      parseServerMessage({ type: 'join.withdrawn', groupId: GROUP_ID, requestId: RID, reason: 'x' })
        .ok,
    ).toBe(false);
    expect(parseServerMessage({ type: 'join.pending', requestId: RID, timeoutMs: -1 }).ok).toBe(
      false,
    );
  });
});

describe('codes.rotate and code events (#10 AC29, AC30)', () => {
  it('parses codes.rotate and the leader events', () => {
    expect(ok({ type: 'codes.rotate', reqId: 'r' }).type).toBe('codes.rotate');
    for (const message of [
      {
        type: 'codes.updated',
        reqId: 'r',
        groupId: GROUP_ID,
        reason: 'rotated',
        codes: { generation: 2, alphaCode: 'ABCDEFGH', blob: BLOB },
      },
      {
        type: 'codes.updated',
        groupId: GROUP_ID,
        reason: 'door_failures',
        codes: { generation: 3, groupCode: '123456', doorCode: '654321', blob: BLOB },
      },
      { type: 'join.paused', groupId: GROUP_ID, retryAfterMs: 600_000 },
      { type: 'join.resumed', groupId: GROUP_ID },
    ]) {
      expect(parseServerMessage(message).ok, message.type).toBe(true);
    }
    expect(
      parseServerMessage({
        type: 'codes.updated',
        groupId: GROUP_ID,
        reason: 'other',
        codes: { generation: 1, blob: BLOB },
      }).ok,
    ).toBe(false);
    expect(parseServerMessage({ type: 'join.paused', groupId: GROUP_ID }).ok).toBe(false);
  });
});

describe('group.joinByCode (#10 AC12)', () => {
  it('accepts a code with an optional door code and display name, length-capped only', () => {
    expect(ok({ type: 'group.joinByCode', joinCode: '123456' }).type).toBe('group.joinByCode');
    expect(
      ok({
        type: 'group.joinByCode',
        reqId: 'r',
        joinCode: 'not a code yet',
        doorCode: 'x',
        displayName: ' ',
      }).type,
    ).toBe('group.joinByCode');
    fails({ type: 'group.joinByCode' });
    fails({ type: 'group.joinByCode', joinCode: 1 });
    fails({ type: 'group.joinByCode', joinCode: '1'.repeat(33) });
    fails({ type: 'group.joinByCode', joinCode: '123456', doorCode: '1'.repeat(33) });
    fails({ type: 'group.joinByCode', joinCode: '123456', displayName: 'x'.repeat(129) });
    expect(ok({ type: 'group.joinByCode', joinCode: '1'.repeat(32) }).type).toBe(
      'group.joinByCode',
    );
  });
});

describe('group.create join methods and group.created codes (#10 AC5, AC6)', () => {
  it('accepts 1 to 4 method letters on group.create', () => {
    expect(ok({ type: 'group.create', metadata: {}, joinMethods: ['A', 'D'] }).type).toBe(
      'group.create',
    );
    expect(ok({ type: 'group.create', metadata: {}, joinMethods: ['A', 'A'] }).type).toBe(
      'group.create',
    );
    for (const joinMethods of [[], ['E'], ['a'], 'A', ['A', 'B', 'C', 'D', 'A']]) {
      fails({ type: 'group.create', metadata: {}, joinMethods });
    }
  });

  it('validates the codes payload of group.created', () => {
    const created = {
      type: 'group.created',
      groupId: GROUP_ID,
      participantId: 'p',
      role: 'leader',
      token: 't',
      joinMethods: ['A', 'C', 'D'],
      codes: {
        generation: 1_767_225_600_000,
        groupCode: '000000',
        doorCode: '999999',
        alphaCode: 'ABCDEFGH',
        blob: BLOB,
      },
    };
    expect(parseServerMessage(created).ok).toBe(true);
    for (const codes of [
      { ...created.codes, groupCode: '12345' },
      { ...created.codes, doorCode: 'ABCDEF' },
      { ...created.codes, alphaCode: 'ABCDEFG0' },
      { ...created.codes, generation: -1 },
      { ...created.codes, blob: 'x' },
      { ...created.codes, blob: `${'a'.repeat(470)}.${'B'.repeat(43)}` },
      { generation: 1 },
    ]) {
      expect(parseServerMessage({ ...created, codes }).ok).toBe(false);
    }
    const noCodes: Record<string, unknown> = { ...created };
    delete noCodes.codes;
    expect(parseServerMessage(noCodes).ok).toBe(false);
  });
});

describe('server message schemas', () => {
  it('parses every server message type', () => {
    const messages = [
      { type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 },
      {
        type: 'hello.ok',
        participantId: 'p',
        namespace: 'app-a',
        joinMethods: ['A', 'D'],
        limits: {
          maxGroupSize: 30,
          maxLeaderUpdatesPerSecond: 5,
          maxMessageBytes: 4096,
          maxSessionMinutes: 180,
          qrTicketSeconds: 300,
          approvalTimeoutSeconds: 120,
        },
      },
      {
        type: 'group.created',
        groupId: GROUP_ID,
        participantId: 'p',
        role: 'leader',
        token: 't',
        joinMethods: ['A', 'D'],
        codes: { generation: 1, groupCode: '012345', doorCode: '543210', blob: BLOB },
      },
      {
        type: 'group.joined',
        groupId: GROUP_ID,
        participantId: 'p',
        role: 'member',
        metadata: {},
        token: 't',
        leaderOnline: true,
        hasPosition: true,
        position: null,
      },
      {
        type: 'group.joined',
        groupId: GROUP_ID,
        participantId: 'p',
        role: 'member',
        metadata: {},
        token: 't',
        leaderOnline: false,
        hasPosition: false,
      },
      { type: 'position.ack', reqId: 'r' },
      { type: 'position.updated', groupId: GROUP_ID, position: [1] },
      { type: 'group.ended', groupId: GROUP_ID, reason: 'ended_by_leader' },
      { type: 'group.ended', groupId: GROUP_ID, reason: 'leader_timeout' },
      { type: 'group.ended', groupId: GROUP_ID, reason: 'max_session' },
      { type: 'group.ended', groupId: GROUP_ID, reason: 'replaced' },
      { type: 'group.ended', groupId: GROUP_ID, reason: 'removed' },
      { type: 'leader.offline', groupId: GROUP_ID },
      { type: 'leader.online', groupId: GROUP_ID },
      { type: 'error', code: 'GROUP_FULL', message: 'full', details: { maxGroupSize: 3 } },
    ];
    for (const message of messages) {
      expect(parseServerMessage(message).ok, message.type).toBe(true);
    }
    expect(parseServerMessage({ type: 'error', code: 'NOPE', message: '' }).ok).toBe(false);
    expect(
      parseServerMessage({ type: 'group.ended', groupId: GROUP_ID, reason: 'leader_disconnected' })
        .ok,
    ).toBe(false);
  });

  it('requires a bounded token and a valid namespace (#5)', () => {
    const created = {
      type: 'group.created',
      groupId: GROUP_ID,
      participantId: 'p',
      role: 'leader',
      joinMethods: ['D'],
      codes: { generation: 1, blob: BLOB },
    };
    expect(parseServerMessage(created).ok).toBe(false);
    expect(parseServerMessage({ ...created, token: '' }).ok).toBe(false);
    expect(parseServerMessage({ ...created, token: 'x'.repeat(2049) }).ok).toBe(false);
    expect(parseServerMessage({ ...created, token: 'x'.repeat(2048) }).ok).toBe(true);
    const helloOk = {
      type: 'hello.ok',
      participantId: 'p',
      namespace: 'app-a',
      joinMethods: ['C'],
      limits: {
        maxGroupSize: 3,
        maxLeaderUpdatesPerSecond: 1,
        maxMessageBytes: 1,
        maxSessionMinutes: 1,
        qrTicketSeconds: 30,
        approvalTimeoutSeconds: 15,
      },
    };
    expect(parseServerMessage(helloOk).ok).toBe(true);
    expect(parseServerMessage({ ...helloOk, namespace: 'Bad App' }).ok).toBe(false);
    expect(parseServerMessage({ ...helloOk, namespace: undefined }).ok).toBe(false);
  });

  it('requires the join methods and join timers in hello.ok (#10 AC4)', () => {
    const helloOk = {
      type: 'hello.ok',
      participantId: 'p',
      namespace: 'app-a',
      joinMethods: ['A', 'B', 'C', 'D'],
      limits: {
        maxGroupSize: 3,
        maxLeaderUpdatesPerSecond: 1,
        maxMessageBytes: 1,
        maxSessionMinutes: 1,
        qrTicketSeconds: 300,
        approvalTimeoutSeconds: 120,
      },
    };
    expect(parseServerMessage(helloOk).ok).toBe(true);
    for (const joinMethods of [undefined, [], ['E'], ['a'], 'A', ['A', 'B', 'C', 'D', 'A']]) {
      expect(parseServerMessage({ ...helloOk, joinMethods }).ok).toBe(false);
    }
    for (const key of ['qrTicketSeconds', 'approvalTimeoutSeconds']) {
      const limits: Record<string, number> = { ...helloOk.limits };
      delete limits[key];
      expect(parseServerMessage({ ...helloOk, limits }).ok).toBe(false);
    }
  });
});
