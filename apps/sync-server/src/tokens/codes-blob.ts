import {
  ALPHA_CODE_PATTERN,
  GROUP_CODE_PATTERN,
  GROUP_ID_PATTERN,
  JOIN_METHODS,
  type JoinMethod,
  MAX_CODES_BLOB_LENGTH,
} from '@mosherw/sync-system-protocol';
import { isClaimInteger, parseCompactPayload, signCompact, verifyCompact } from './signed-blob.js';
import type { TokenKeyring } from './token-keys.js';

/** Version of the codes blob claim set. */
export const CODES_BLOB_FORMAT_VERSION = 1;

/**
 * The content of a signed codes blob: a group's codes and both generations
 * (#10 AC32, D12). Same shape as the server's `GroupCodes`.
 */
export interface BlobCodes {
  /** Code generation (changes on every code change). */
  readonly generation: number;
  /** Ticket generation (changes only on ticket-revoking changes); <= generation. */
  readonly ticketGeneration: number;
  readonly groupCode?: string | undefined;
  readonly doorCode?: string | undefined;
  readonly alphaCode?: string | undefined;
}

export interface VerifiedCodesBlob {
  /** The blob's join methods, canonical order. */
  readonly methods: readonly JoinMethod[];
  readonly codes: BlobCodes;
}

const ALLOWED_KEYS = new Set(['v', 'g', 'n', 't', 'm', 'gc', 'dc', 'ac']);

/** The method letters as one canonical string, e.g. `"AD"`. */
function methodsText(methods: readonly JoinMethod[]): string {
  return JOIN_METHODS.filter((method) => methods.includes(method)).join('');
}

/** A valid group method set from its canonical text, or undefined. */
function parseMethods(text: unknown): JoinMethod[] | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const methods = JOIN_METHODS.filter((method) => text.includes(method));
  // Canonical order, distinct, known letters only, and never A with B.
  if (methods.join('') !== text) return undefined;
  if (methods.includes('A') && methods.includes('B')) return undefined;
  return methods;
}

/**
 * True when the codes match the methods: a group code iff A or B, a door
 * code (different from the group code) iff A, an alphanumeric code iff C.
 */
function codesMatchMethods(methods: readonly JoinMethod[], codes: BlobCodes): boolean {
  const needsGroup = methods.includes('A') || methods.includes('B');
  const needsDoor = methods.includes('A');
  const needsAlpha = methods.includes('C');
  if (needsGroup !== (codes.groupCode !== undefined)) return false;
  if (needsDoor !== (codes.doorCode !== undefined)) return false;
  if (needsAlpha !== (codes.alphaCode !== undefined)) return false;
  if (codes.groupCode !== undefined && !GROUP_CODE_PATTERN.test(codes.groupCode)) return false;
  if (codes.doorCode !== undefined && !GROUP_CODE_PATTERN.test(codes.doorCode)) return false;
  if (codes.doorCode !== undefined && codes.doorCode === codes.groupCode) return false;
  if (codes.alphaCode !== undefined && !ALPHA_CODE_PATTERN.test(codes.alphaCode)) return false;
  return true;
}

function optionalCode(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

/**
 * Signs and verifies codes blobs (#10 AC32, AC33, architecture 4.8): the
 * leader's client stores the blob and sends it back when it recreates the
 * group after a restart. The server accepts only codes it signed for that
 * group ID, with its own codes-blob key per app (R4, R5).
 */
export class CodesBlobService {
  constructor(
    /** Keyring with the codes blob purpose label (R4). */
    private readonly keyring: TokenKeyring,
  ) {}

  sign(
    namespace: string,
    groupId: string,
    methods: readonly JoinMethod[],
    codes: BlobCodes,
  ): string {
    const payload: Record<string, string | number> = {
      v: CODES_BLOB_FORMAT_VERSION,
      g: groupId,
      n: codes.generation,
      t: codes.ticketGeneration,
      m: methodsText(methods),
    };
    if (codes.groupCode !== undefined) payload.gc = codes.groupCode;
    if (codes.doorCode !== undefined) payload.dc = codes.doorCode;
    if (codes.alphaCode !== undefined) payload.ac = codes.alphaCode;
    return signCompact(JSON.stringify(payload), this.keyring.keysFor(namespace).current);
  }

  /**
   * The blob's methods and codes if it is a well-formed blob this server
   * signed (current or previous secret) for `groupId` in `namespace`, else
   * undefined. Rejects a blob whose ticket generation `t` is missing, not a
   * safe non-negative integer, or above the code generation `n` (D12).
   */
  verify(blob: unknown, namespace: string, groupId: string): VerifiedCodesBlob | undefined {
    const verified = verifyCompact(
      blob,
      this.keyring.keysFor(namespace).verify,
      MAX_CODES_BLOB_LENGTH,
    );
    if (verified === undefined) return undefined;
    const claims = parseCompactPayload(verified.payloadJson);
    if (claims === undefined) return undefined;
    if (Object.keys(claims).some((key) => !ALLOWED_KEYS.has(key))) return undefined;
    const { v, g, n, t } = claims;
    if (v !== CODES_BLOB_FORMAT_VERSION) return undefined;
    if (typeof g !== 'string' || !GROUP_ID_PATTERN.test(g) || g !== groupId) return undefined;
    if (!isClaimInteger(n) || !isClaimInteger(t) || t > n) return undefined;
    const methods = parseMethods(claims.m);
    if (methods === undefined) return undefined;
    const groupCode = optionalCode(claims.gc);
    const doorCode = optionalCode(claims.dc);
    const alphaCode = optionalCode(claims.ac);
    if (groupCode === null || doorCode === null || alphaCode === null) return undefined;
    const codes: BlobCodes = { generation: n, ticketGeneration: t, groupCode, doorCode, alphaCode };
    if (!codesMatchMethods(methods, codes)) return undefined;
    return { methods, codes };
  }
}
