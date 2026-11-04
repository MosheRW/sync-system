import { describe, expect, it } from 'vitest';
import {
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
