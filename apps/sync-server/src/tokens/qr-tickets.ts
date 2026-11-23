import { GROUP_ID_PATTERN, MAX_QR_TICKET_LENGTH } from '@mosherw/sync-system-protocol';
import { MAX_CLOCK_SKEW_MS } from '../limits/constants.js';
import {
  hasExactKeys,
  isClaimInteger,
  parseCompactPayload,
  signCompact,
  verifyCompact,
} from './signed-blob.js';
import type { TokenKeyring } from './token-keys.js';

/** Version of the QR ticket claim set. */
export const QR_TICKET_FORMAT_VERSION = 1;

const TICKET_KEYS = ['v', 'g', 'n', 'e'] as const;

export interface IssuedQrTicket {
  /** Opaque, URL-safe, at most 256 characters (#10 AC23). */
  ticket: string;
  /** Lifetime as a relative time (#10 D6). */
  expiresInMs: number;
}

export type QrVerifyResult =
  | { ok: true; groupId: string; ticketGeneration: number }
  /**
   * `expired` is true only for a well-formed, correctly signed, plausible
   * ticket whose expiry has passed (QR_EXPIRED); every other failure looks
   * the same (QR_INVALID, #10 AC25).
   */
  | { ok: false; expired: boolean };

const INVALID: QrVerifyResult = Object.freeze({ ok: false, expired: false });
const EXPIRED: QrVerifyResult = Object.freeze({ ok: false, expired: true });

/**
 * Signs and verifies QR tickets (#10 AC23-AC26, architecture 4.7). A ticket
 * is a stateless compact string `{"v":1,"g":<gid>,"n":<ticketGeneration>,"e":<exp s>}`
 * signed with the app's QR ticket key. The namespace is not inside: the
 * per-app key binds it. Never logs and never throws with input.
 */
export class QrTicketService {
  constructor(
    /** Keyring with the QR ticket purpose label (R4). */
    private readonly keyring: TokenKeyring,
    /** QR_TICKET_SECONDS_CEILING: bounds a plausible expiry. */
    private readonly ceilingSeconds: number,
  ) {}

  /**
   * A ticket for `groupId` at `ticketGeneration`, valid for at least
   * `seconds` from `now` (the expiry is rounded up to a whole second).
   */
  issue(
    namespace: string,
    groupId: string,
    ticketGeneration: number,
    now: number,
    seconds: number,
  ): IssuedQrTicket {
    const exp = Math.ceil(now / 1000) + seconds;
    const payload = JSON.stringify({
      v: QR_TICKET_FORMAT_VERSION,
      g: groupId,
      n: ticketGeneration,
      e: exp,
    });
    return {
      ticket: signCompact(payload, this.keyring.keysFor(namespace).current),
      expiresInMs: seconds * 1000,
    };
  }

  /**
   * Verification order (R5): length and shape, signature with every key
   * (current, then previous), JSON, the exact claim schema, a plausibility
   * bound on the expiry, then the expiry itself. The group and generation
   * checks are the caller's, under the group lock.
   */
  verify(ticket: unknown, namespace: string, now: number): QrVerifyResult {
    const verified = verifyCompact(
      ticket,
      this.keyring.keysFor(namespace).verify,
      MAX_QR_TICKET_LENGTH,
    );
    if (verified === undefined) return INVALID;
    const claims = parseCompactPayload(verified.payloadJson);
    if (claims === undefined || !hasExactKeys(claims, TICKET_KEYS)) return INVALID;
    const { v, g, n, e } = claims;
    if (v !== QR_TICKET_FORMAT_VERSION) return INVALID;
    if (typeof g !== 'string' || !GROUP_ID_PATTERN.test(g)) return INVALID;
    if (!isClaimInteger(n) || !isClaimInteger(e)) return INVALID;
    // Only this server signs tickets; an expiry further out than any ticket
    // it could have issued means a leaked key or a stepped clock.
    if (e * 1000 > now + this.ceilingSeconds * 1000 + MAX_CLOCK_SKEW_MS + 1000) return INVALID;
    if (e * 1000 <= now) return EXPIRED;
    return { ok: true, groupId: g, ticketGeneration: n };
  }
}
