import { randomInt, timingSafeEqual } from 'node:crypto';
import {
  ALPHA_CODE_ALPHABET,
  ALPHA_CODE_LENGTH,
  GROUP_CODE_PATTERN,
  type JoinMethod,
} from '@sync-system/protocol';
import { MAX_CODE_DRAWS } from '../limits/constants.js';
import type { CodeIndex } from './code-index.js';
import { usesGroupCode } from './join-methods.js';

/**
 * A group's join codes and generations (#10 architecture 3, D4, D12). Built
 * only by `issueCodeSet` and `rotateDoorCode` (and restored from a verified
 * blob), so no other code path assigns a generation. Never logged.
 */
export interface GroupCodes {
  /** Code generation: changes on every code change (D4, R3). */
  readonly generation: number;
  /**
   * Ticket generation: the code generation at the last ticket-revoking
   * change (create, leader rotation, new set on recreation). Always
   * `<= generation`; QR tickets are checked against it only (D12).
   */
  readonly ticketGeneration: number;
  /** 6 digits; methods A or B. */
  readonly groupCode?: string | undefined;
  /** 6 digits, never equal to the group code; method A. */
  readonly doorCode?: string | undefined;
  /** 8 characters of ALPHA_CODE_ALPHABET; method C. */
  readonly alphaCode?: string | undefined;
}

/** A uniform random integer in `[0, max)` from the CSPRNG. Injected by tests. */
export type RandomInt = (max: number) => number;

/** `crypto.randomInt`: uniform, no modulo bias (AC7, AC8). */
export const cryptoRandomInt: RandomInt = (max) => randomInt(max);

/** A 6-digit code, `000000` to `999999`, uniform (AC7). */
export function drawSixDigits(random: RandomInt = cryptoRandomInt): string {
  return String(random(1_000_000)).padStart(6, '0');
}

/** An 8-character code over the 31-character alphabet, uniform (AC8). */
export function drawAlphaCode(random: RandomInt = cryptoRandomInt): string {
  let code = '';
  for (let i = 0; i < ALPHA_CODE_LENGTH; i++) {
    code += ALPHA_CODE_ALPHABET[random(ALPHA_CODE_ALPHABET.length)]!;
  }
  return code;
}

/**
 * A door code different from the group code and from `previous` (a rotated
 * door code always changes), or undefined after MAX_CODE_DRAWS draws.
 */
export function drawDoorCode(
  groupCode: string,
  previous?: string,
  random: RandomInt = cryptoRandomInt,
): string | undefined {
  for (let i = 0; i < MAX_CODE_DRAWS; i++) {
    const code = drawSixDigits(random);
    if (code !== groupCode && code !== previous) return code;
  }
  return undefined;
}

/**
 * Compares a presented door code with the group's (#10 AC15, R6): both are
 * validated as exactly 6 ASCII digits first, then compared with
 * `timingSafeEqual` on two 6-byte buffers, so the time does not depend on
 * how many digits match.
 */
export function doorCodeMatches(presented: string, expected: string): boolean {
  if (!GROUP_CODE_PATTERN.test(presented) || !GROUP_CODE_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(presented, 'ascii'), Buffer.from(expected, 'ascii'));
}

/**
 * The next code generation (D4, R3): `max(previous + 1, nowMs)`. In
 * milliseconds, so a full new set issued after a restart without a blob is
 * above every earlier generation, and it always increases.
 */
export function nextGeneration(previous: number, nowMs: number): number {
  return Math.max(previous + 1, nowMs);
}

/** A code of `kind` free in `namespace` (also not held by this group), or undefined. */
function drawFree(
  index: CodeIndex,
  namespace: string,
  kind: 'group' | 'alpha',
  random: RandomInt,
): string | undefined {
  for (let i = 0; i < MAX_CODE_DRAWS; i++) {
    const code = kind === 'group' ? drawSixDigits(random) : drawAlphaCode(random);
    if (index.isFree(namespace, kind, code)) return code;
  }
  return undefined;
}

/**
 * A full new code set for `methods`, claimed in `index` for `groupId` (#10
 * AC6-AC9). Every code differs from the group's current ones, because codes
 * the group holds count as taken. The code generation follows D4 and the
 * ticket generation is set to the same value: a new set always revokes QR
 * tickets (D12). `'exhausted'` (CODES_EXHAUSTED) when a free code was not
 * found within MAX_CODE_DRAWS draws; nothing is claimed then. The caller
 * releases the group's previous codes after a success.
 */
export function issueCodeSet(
  index: CodeIndex,
  namespace: string,
  groupId: string,
  methods: readonly JoinMethod[],
  previousGeneration: number,
  nowMs: number,
  random: RandomInt = cryptoRandomInt,
): GroupCodes | 'exhausted' {
  let groupCode: string | undefined;
  let doorCode: string | undefined;
  let alphaCode: string | undefined;
  if (usesGroupCode(methods)) {
    groupCode = drawFree(index, namespace, 'group', random);
    if (groupCode === undefined) return 'exhausted';
    if (methods.includes('A')) {
      doorCode = drawDoorCode(groupCode, undefined, random);
      if (doorCode === undefined) return 'exhausted';
    }
  }
  if (methods.includes('C')) {
    alphaCode = drawFree(index, namespace, 'alpha', random);
    if (alphaCode === undefined) return 'exhausted';
  }
  // Synchronous since the draws, so the codes are still free (R14).
  if (!index.claim(namespace, groupId, { groupCode, alphaCode })) return 'exhausted';
  const generation = nextGeneration(previousGeneration, nowMs);
  return { generation, ticketGeneration: generation, groupCode, doorCode, alphaCode };
}

/**
 * A new door code after door-code failures (#10 AC29, R1a): the group code
 * and alphanumeric code stay, the code generation moves on (D4), and the
 * ticket generation is copied unchanged, so QR tickets keep working (D12).
 * `'exhausted'` if no different door code was drawn (practically never).
 */
export function rotateDoorCode(
  codes: GroupCodes,
  nowMs: number,
  random: RandomInt = cryptoRandomInt,
): GroupCodes | 'exhausted' {
  if (codes.groupCode === undefined || codes.doorCode === undefined) return 'exhausted';
  const doorCode = drawDoorCode(codes.groupCode, codes.doorCode, random);
  if (doorCode === undefined) return 'exhausted';
  return {
    generation: nextGeneration(codes.generation, nowMs),
    ticketGeneration: codes.ticketGeneration,
    groupCode: codes.groupCode,
    doorCode,
    alphaCode: codes.alphaCode,
  };
}
