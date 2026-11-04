import { describe, expect, it } from 'vitest';
import { HANDOFF_MODES, PROTOCOL_VERSION, parseClientMessage } from '../src/index.js';

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
