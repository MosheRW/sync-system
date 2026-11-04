import { ErrorCode } from '@sync-system/protocol';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ERROR_TEXT,
  ERROR_TEXT,
  actionErrorMessage,
  errorMessage,
} from '../src/ws/error-messages.js';

/** Words each action's text must contain (#7 AC19). */
const NAMES: Record<string, RegExp> = {
  'position.update': /position/i,
  'tokens.check': /token check/i,
  'group.end': /end the group/i,
  'blocklist.set': /block list/i,
  'group.joinByCode': /join attempts/i,
  'codes.rotate': /rotat/i,
  'join.approve': /approve join/i,
  'join.deny': /deny join/i,
  'group.joinByQr': /join attempts/i,
  'qr.issue': /QR code/i,
  'group.resume': /recover/i,
  'vice.set': /vice-leader/i,
  'vice.clear': /vice-leader/i,
  'group.lock': /lock/i,
  'group.unlock': /unlock/i,
  'member.remove': /remov/i,
};

describe('per-action error texts (#7 A1)', () => {
  it('gives each action its own text that names the action (AC19)', () => {
    for (const [code, rows] of Object.entries(ACTION_ERROR_TEXT)) {
      // Both join requests share "Too many join attempts" (#10 4.4).
      const texts = Object.entries(rows)
        .filter(([action]) => action !== 'group.joinByQr')
        .map(([, text]) => text);
      expect(new Set(texts).size, code).toBe(texts.length);
      for (const [action, text] of Object.entries(rows)) {
        expect(text, `${code} ${action}`).toMatch(NAMES[action]!);
      }
    }
  });

  it('has exactly the planned rows and texts', () => {
    expect(ACTION_ERROR_TEXT).toEqual({
      RATE_LIMITED: {
        'position.update': 'Too many position updates',
        'tokens.check': 'Too many token checks',
        'group.joinByCode': 'Too many join attempts',
        'codes.rotate': 'Too many code rotations',
        'group.joinByQr': 'Too many join attempts',
        'qr.issue': 'Too many QR code requests',
        'group.resume': 'Too many group recoveries',
        'vice.set': 'Too many vice-leader changes',
        'vice.clear': 'Too many vice-leader clears',
        'group.lock': 'Too many group locks',
        'group.unlock': 'Too many group unlocks',
        'member.remove': 'Too many member removals',
      },
      NOT_LEADER: {
        'position.update': 'Only the leader can update the position',
        'group.end': 'Only the leader can end the group',
        'blocklist.set': 'Only the leader can set the block list',
        'codes.rotate': 'Only the leader can rotate the codes',
        'join.approve': 'Only the leader can approve join requests',
        'join.deny': 'Only the leader can deny join requests',
        'qr.issue': 'Only the leader can issue QR codes',
        'vice.set': 'Only the leader can choose the vice-leader',
        'vice.clear': 'Only the leader can clear the vice-leader',
        'group.lock': 'Only the leader can lock the group',
        'group.unlock': 'Only the leader can unlock the group',
        'member.remove': 'Only the leader can remove members',
      },
      NOT_ALLOWED: {
        'vice.set': 'This participant cannot be the vice-leader now',
        'member.remove': 'This participant cannot be removed',
      },
    });
  });

  it('keeps texts fixed: no placeholders or received values (AC20)', () => {
    const all = [
      ...Object.values(ERROR_TEXT),
      ...Object.values(ACTION_ERROR_TEXT).flatMap((rows) => Object.values(rows)),
    ];
    for (const text of all) expect(text).not.toMatch(/[{}$%<>]/);
  });

  it('has no generic text for the shared codes', () => {
    expect(Object.keys(ERROR_TEXT)).not.toContain(ErrorCode.RATE_LIMITED);
    expect(Object.keys(ERROR_TEXT)).not.toContain(ErrorCode.NOT_LEADER);
    expect(Object.keys(ERROR_TEXT)).not.toContain(ErrorCode.NOT_ALLOWED);
  });

  it('keeps the code, reqId and details unchanged', () => {
    expect(
      actionErrorMessage(ErrorCode.RATE_LIMITED, 'tokens.check', {
        reqId: 'r1',
        details: { retryAfterMs: 5 },
      }),
    ).toEqual({
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'Too many token checks',
      reqId: 'r1',
      details: { retryAfterMs: 5 },
    });
    expect(actionErrorMessage(ErrorCode.NOT_LEADER, 'group.end')).toEqual({
      type: 'error',
      code: 'NOT_LEADER',
      message: 'Only the leader can end the group',
    });
  });

  it('rejects shared codes without an action at compile time (AC21)', () => {
    // @ts-expect-error RATE_LIMITED must go through actionErrorMessage
    expect(() => errorMessage(ErrorCode.RATE_LIMITED)).toBeDefined();
    // @ts-expect-error an action from another code's row set
    expect(() => actionErrorMessage(ErrorCode.RATE_LIMITED, 'group.end')).toBeDefined();
  });
});
