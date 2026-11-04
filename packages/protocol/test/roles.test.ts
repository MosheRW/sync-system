import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  HANDOFF_MODES,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  resolveDisplayName,
} from '../src/index.js';

const GID = 'G'.repeat(43);
const PID = '0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b';
const ENTRY = {
  participantId: PID,
  displayName: 'Guest 3',
  generated: true,
  guestNumber: 3,
  role: 'vice-leader',
  connected: false,
  joinedAgoMs: 1200,
};

describe('roles and lifecycle messages (#13 AC39)', () => {
  it('keeps the protocol version at 1 (Q7)', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts the handoff modes on group.create and group.resume, nothing else (AC3)', () => {
    expect(HANDOFF_MODES).toEqual(['auto', 'frozen']);
    for (const handoff of HANDOFF_MODES) {
      expect(parseClientMessage({ type: 'group.create', metadata: {}, handoff }).ok).toBe(true);
      expect(parseClientMessage({ type: 'group.resume', token: 't', handoff }).ok).toBe(true);
    }
    for (const handoff of ['manual', '', 1, null]) {
      expect(parseClientMessage({ type: 'group.create', metadata: {}, handoff }).ok).toBe(false);
      expect(parseClientMessage({ type: 'group.resume', token: 't', handoff }).ok).toBe(false);
    }
  });
});

describe('names (#13 D11, AC35, AC36)', () => {
  it('generates for missing or blank, applies the strict #10 rule otherwise', () => {
    expect(resolveDisplayName(undefined)).toEqual({ ok: true, generated: true });
    expect(resolveDisplayName('')).toEqual({ ok: true, generated: true });
    expect(resolveDisplayName(' 	 ')).toEqual({ ok: true, generated: true });
    expect(resolveDisplayName('  Dana ')).toEqual({ ok: true, generated: false, name: 'Dana' });
    for (const bad of ['x'.repeat(33), 'a‮b', 'ab', 'a​b', '⠀']) {
      expect(resolveDisplayName(bad)).toEqual({ ok: false });
    }
  });

  it('caps the raw name at 128 characters on create, join and resume', () => {
    const long = 'x'.repeat(129);
    expect(parseClientMessage({ type: 'group.create', metadata: {}, displayName: long }).ok).toBe(
      false,
    );
    expect(parseClientMessage({ type: 'group.resume', token: 't', displayName: long }).ok).toBe(
      false,
    );
    expect(parseClientMessage({ type: 'group.resume', token: 't', displayName: 'Dana' }).ok).toBe(
      true,
    );
  });
});

describe('roster frames (#13 AC31)', () => {
  it('parses a snapshot, an update and a removal', () => {
    expect(
      parseServerMessage({ type: 'roster.snapshot', groupId: GID, participants: [ENTRY] }).ok,
    ).toBe(true);
    expect(
      parseServerMessage({ type: 'roster.updated', groupId: GID, participant: ENTRY }).ok,
    ).toBe(true);
    expect(
      parseServerMessage({ type: 'roster.removed', groupId: GID, participantId: PID }).ok,
    ).toBe(true);
  });

  it('refuses bad entries: unknown role, bad ID, long name, negative durations, a false marker', () => {
    for (const bad of [
      { role: 'admin' },
      { participantId: 'p1' },
      { displayName: 'x'.repeat(129) },
      { joinedAgoMs: -1 },
      { guestNumber: 1.5 },
      { admittedSinceRecovery: false },
    ]) {
      const participant = { ...ENTRY, ...bad };
      expect(
        parseServerMessage({ type: 'roster.updated', groupId: GID, participant }).ok,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('requires the own name on created, joined and resumed', () => {
    const created = {
      type: 'group.created',
      groupId: GID,
      participantId: PID,
      role: 'leader',
      handoff: 'auto',
      displayName: 'Dana',
      generated: false,
      state: { blockList: [], locked: false, handoff: 'auto' },
      token: 't',
      joinMethods: ['C'],
      codes: { generation: 1, alphaCode: 'ABCDEFGH', blob: `a.${'b'.repeat(43)}` },
    };
    expect(parseServerMessage(created).ok).toBe(true);
    for (const key of ['displayName', 'generated', 'handoff']) {
      const missing: Record<string, unknown> = { ...created };
      delete missing[key];
      expect(parseServerMessage(missing).ok, key).toBe(false);
    }
  });
});

describe('vice-leader messages (#13 AC10, AC11)', () => {
  it('parses vice.set with a participant ID and vice.clear', () => {
    expect(parseClientMessage({ type: 'vice.set', participantId: PID }).ok).toBe(true);
    expect(parseClientMessage({ type: 'vice.clear' }).ok).toBe(true);
    for (const participantId of [undefined, 'p1', PID.toUpperCase(), `${PID}x`]) {
      expect(parseClientMessage({ type: 'vice.set', participantId }).ok).toBe(false);
    }
    expect(parseClientMessage({ type: 'group.resume', token: 't', viceId: 'p1' }).ok).toBe(false);
  });

  it('parses vice.updated with an ID or null, and vice.changed', () => {
    expect(parseServerMessage({ type: 'vice.updated', groupId: GID, viceId: PID }).ok).toBe(true);
    expect(parseServerMessage({ type: 'vice.updated', groupId: GID, viceId: null }).ok).toBe(true);
    expect(parseServerMessage({ type: 'vice.updated', groupId: GID }).ok).toBe(false);
    expect(parseServerMessage({ type: 'vice.changed', groupId: GID, isVice: true }).ok).toBe(true);
    expect(parseServerMessage({ type: 'vice.changed', groupId: GID }).ok).toBe(false);
  });
});

describe('lock messages and the leader state (#13 AC29, D13)', () => {
  it('parses group.lock, group.unlock and lock.changed', () => {
    expect(parseClientMessage({ type: 'group.lock' }).ok).toBe(true);
    expect(parseClientMessage({ type: 'group.unlock', reqId: 'u' }).ok).toBe(true);
    expect(parseServerMessage({ type: 'lock.changed', groupId: GID, locked: true }).ok).toBe(true);
    expect(parseServerMessage({ type: 'lock.changed', groupId: GID }).ok).toBe(false);
    expect(parseClientMessage({ type: 'group.resume', token: 't', locked: 'yes' }).ok).toBe(false);
  });

  it('bounds the leader state block list and checks its IDs', () => {
    const base = {
      type: 'group.created',
      groupId: GID,
      participantId: PID,
      role: 'leader',
      handoff: 'auto',
      displayName: 'Dana',
      generated: false,
      token: 't',
      joinMethods: ['C'],
      codes: { generation: 1, alphaCode: 'ABCDEFGH', blob: `a.${'b'.repeat(43)}` },
    };
    const state = { blockList: [PID], locked: true, viceId: PID, handoff: 'frozen' };
    expect(parseServerMessage({ ...base, state }).ok).toBe(true);
    expect(parseServerMessage({ ...base, state: { ...state, blockList: ['x'] } }).ok).toBe(false);
    expect(
      parseServerMessage({ ...base, state: { ...state, blockList: Array(257).fill(PID) } }).ok,
    ).toBe(false);
    expect(parseServerMessage({ ...base, state: { ...state, locked: undefined } }).ok).toBe(false);
  });
});

describe('removal (#13 AC32, Gate 2 Q-A)', () => {
  it('parses member.remove and member.removed, and the codes reason', () => {
    expect(parseClientMessage({ type: 'member.remove', participantId: PID }).ok).toBe(true);
    expect(parseClientMessage({ type: 'member.remove', participantId: 'x' }).ok).toBe(false);
    expect(
      parseServerMessage({
        type: 'member.removed',
        groupId: GID,
        participantId: PID,
        blockList: [PID],
      }).ok,
    ).toBe(true);
    expect(
      parseServerMessage({
        type: 'codes.updated',
        groupId: GID,
        reason: 'member_removed',
        codes: { generation: 2, alphaCode: 'ABCDEFGH', blob: `a.${'b'.repeat(43)}` },
      }).ok,
    ).toBe(true);
  });

  it('has a dedicated close code next to the existing ones', () => {
    expect(CloseCode.REMOVED).toBe(4004);
    const codes = Object.values(CloseCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('activity and keep-alive messages (#13 AC16, AC30)', () => {
  it('parses leader.activity without a payload field, and keepalive.ack', () => {
    const parsed = parseClientMessage({ type: 'leader.activity', position: { page: 3 } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message).toEqual({ type: 'leader.activity' });
    expect(parseClientMessage({ type: 'keepalive.ack', reqId: 'k' }).ok).toBe(true);
  });

  it('parses the prompt with a non-negative duration, the cleared event and the ack', () => {
    expect(
      parseServerMessage({ type: 'keepalive.prompt', groupId: GID, countdownMs: 60_000 }).ok,
    ).toBe(true);
    expect(parseServerMessage({ type: 'keepalive.prompt', groupId: GID, countdownMs: -1 }).ok).toBe(
      false,
    );
    expect(parseServerMessage({ type: 'keepalive.cleared', groupId: GID }).ok).toBe(true);
    expect(parseServerMessage({ type: 'activity.ack', reqId: 'a' }).ok).toBe(true);
  });
});

describe('pause on the wire (#13 D8, D12)', () => {
  it('parses leader.offline with and without a cause and grace', () => {
    expect(parseServerMessage({ type: 'leader.offline', groupId: GID }).ok).toBe(true);
    expect(
      parseServerMessage({ type: 'leader.offline', groupId: GID, cause: 'inactive', graceMs: 5 })
        .ok,
    ).toBe(true);
    expect(parseServerMessage({ type: 'leader.offline', groupId: GID, cause: 'asleep' }).ok).toBe(
      false,
    );
    expect(
      parseServerMessage({ type: 'leader.offline', groupId: GID, cause: 'inactive', graceMs: -5 })
        .ok,
    ).toBe(false);
  });
});

describe('leadership messages (#13 AC23)', () => {
  it('parses leader.granted, leader.lost and leader.changed; no ID in leader.changed', () => {
    const codes = { generation: 1, alphaCode: 'ABCDEFGH', blob: `a.${'b'.repeat(43)}` };
    const state = { blockList: [], locked: false, handoff: 'auto' };
    expect(
      parseServerMessage({
        type: 'leader.granted',
        groupId: GID,
        reason: 'handoff_disconnect',
        token: 't',
        state,
        joinMethods: ['C'],
        codes,
      }).ok,
    ).toBe(true);
    expect(
      parseServerMessage({
        type: 'leader.lost',
        groupId: GID,
        reason: 'superseded',
        token: 't',
        takeBackAvailable: false,
      }).ok,
    ).toBe(true);
    const changed = parseServerMessage({
      type: 'leader.changed',
      groupId: GID,
      reason: 'take_back',
      participantId: PID,
    });
    expect(changed.ok && changed.message).toEqual({
      type: 'leader.changed',
      groupId: GID,
      reason: 'take_back',
    });
    expect(parseServerMessage({ type: 'leader.changed', groupId: GID, reason: 'coup' }).ok).toBe(
      false,
    );
  });
});
