import {
  ErrorCode,
  type ErrorMessage,
  type GroupJoinByCodeMessage,
  type JoinCodeKind,
  type JoinCodesPayload,
  type JoinMethod,
  type ServerMessage,
  classifyJoinCode,
  isDoorCode,
  normalizeDisplayName,
  normalizeJoinCode,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import type { GroupRecord, GroupStore } from '../groups/group-store.js';
import type { Session } from '../groups/session.js';
import {
  JOIN_ATTEMPTS_PER_APP_PER_MINUTE,
  JOIN_ATTEMPTS_PER_CONNECTION_PER_MINUTE,
  JOIN_WINDOW_MS,
} from '../limits/constants.js';
import { SlidingWindowRateLimiter } from '../limits/rate-limiter.js';
import { type Logger, groupRef } from '../logging/logger.js';
import type { Scheduler } from '../time/scheduler.js';
import type { CodesBlobService } from '../tokens/codes-blob.js';
import type { QrTicketService } from '../tokens/qr-tickets.js';
import { actionErrorMessage, errorMessage } from '../ws/error-messages.js';
import { CodeIndex } from './code-index.js';
import {
  type GroupCodes,
  type RandomInt,
  cryptoRandomInt,
  doorCodeMatches,
  issueCodeSet,
} from './codes.js';
import { resolveGroupMethods } from './join-methods.js';

export interface JoinServiceDeps {
  store: GroupStore;
  logger: Logger;
  scheduler: Scheduler;
  /** Signs and verifies QR tickets (#10 AC23-AC26). */
  qrTickets: QrTicketService;
  /** Signs and verifies codes blobs (#10 AC32, AC33). */
  codesBlobs: CodesBlobService;
  /** CSPRNG integer source; injected by tests to force code collisions. */
  random?: RandomInt;
}

/**
 * What JoinService needs from GroupService (the facade). Every method that
 * touches a group runs under that group's lock.
 */
export interface JoinHost {
  /** In a group, parked, or waiting for approval (ALREADY_IN_GROUP). */
  busy(session: Session): boolean;
  /** Runs `task` under the per-group lock (`namespace:groupId`). */
  runLocked<T>(namespace: string, groupId: string, task: () => Promise<T>): Promise<T>;
  /**
   * Adds `session` as a new member with a fresh participant ID and returns
   * group.joined with a token, or GROUP_FULL (#10 AC14). Under the lock.
   */
  admit(session: Session, groupId: string, method: JoinMethod): Promise<ServerMessage>;
}

/** Why a join attempt was refused, for the debug log (never a code or group ref for not_found). */
type RejectCause = 'not_found' | 'door_required' | 'door_wrong';

/**
 * One frozen error per "not found" answer (#10 AC13, R7): fixed text, no
 * details, never the input. Unknown code, another app's code and a code type
 * the group does not use all get these same bytes.
 */
const CODE_NOT_FOUND: ErrorMessage = Object.freeze(errorMessage(ErrorCode.CODE_NOT_FOUND));
const INVALID_MESSAGE: ErrorMessage = Object.freeze(errorMessage(ErrorCode.INVALID_MESSAGE));

/** A normalized and validated join-by-code request. */
interface ParsedCodeJoin {
  kind: JoinCodeKind;
  joinCode: string;
  doorCode: string | undefined;
  displayName: string | undefined;
}

/** Normalizes and validates the code fields (#10 AC12, AC20); undefined when invalid. */
function parseCodeJoin(message: GroupJoinByCodeMessage): ParsedCodeJoin | undefined {
  const joinCode = normalizeJoinCode(message.joinCode);
  const kind = classifyJoinCode(joinCode);
  if (kind === undefined) return undefined;
  let doorCode: string | undefined;
  if (message.doorCode !== undefined) {
    doorCode = normalizeJoinCode(message.doorCode);
    if (!isDoorCode(doorCode)) return undefined;
  }
  let displayName: string | undefined;
  if (message.displayName !== undefined) {
    displayName = normalizeDisplayName(message.displayName);
    if (displayName === undefined) return undefined;
  }
  return { kind, joinCode, doorCode, displayName };
}

export type InitialCodesResult =
  { ok: true; methods: JoinMethod[]; codes: GroupCodes } | { ok: false; error: ServerMessage };

/**
 * Every join and join-code flow (#10 architecture 1). `GroupService` stays
 * the facade: it owns the group lock, the store and the lifecycle, and calls
 * in here. Codes are group state (`GroupRecord.codes`); the code -> group
 * lookup is the process-local `CodeIndex`. Nothing here logs a code, door
 * code, ticket, blob, display name or request ID.
 */
export class JoinService {
  /** Code -> group lookup per app. */
  readonly index = new CodeIndex();
  private readonly random: RandomInt;
  /** Join attempts per connection (#10 AC27). */
  private readonly joinLimiter: SlidingWindowRateLimiter;
  /** Join attempts per app, shared by its connections (#10 AC28). */
  private readonly appJoinLimiter: SlidingWindowRateLimiter;
  /** When a per-app budget warning was last logged, per `event:namespace`. */
  private readonly warnedAt = new Map<string, number>();

  constructor(
    private readonly deps: JoinServiceDeps,
    private readonly host: JoinHost,
  ) {
    this.random = deps.random ?? cryptoRandomInt;
    const now = (): number => this.now();
    this.joinLimiter = new SlidingWindowRateLimiter(now, JOIN_WINDOW_MS);
    this.appJoinLimiter = new SlidingWindowRateLimiter(now, JOIN_WINDOW_MS);
  }

  /**
   * One warning per window per app when one of its shared budgets is used
   * up (#10 6.1, as #7 L-2). Namespace only.
   */
  private warnOnce(event: string, namespace: string, windowMs: number, text: string): void {
    const key = `${event}:${namespace}`;
    const now = this.now();
    const last = this.warnedAt.get(key);
    if (last !== undefined && now - last < windowMs) return;
    this.warnedAt.set(key, now);
    this.deps.logger.warn({ event, namespace }, text);
  }

  /**
   * The join attempt budgets (#10 AC27, AC28, R8): per connection first, so
   * one socket over its own limit cannot drain the app's budget, then per
   * app. Both run before any normalization or code lookup. Undefined when
   * the attempt may go on.
   */
  private spendJoinAttempt(session: Session, action: 'group.joinByCode'): ErrorMessage | undefined {
    const rate = this.joinLimiter.tryAcquire(
      session.connectionId,
      JOIN_ATTEMPTS_PER_CONNECTION_PER_MINUTE,
    );
    if (!rate.ok) {
      return actionErrorMessage(ErrorCode.RATE_LIMITED, action, {
        details: { retryAfterMs: rate.retryAfterMs },
      });
    }
    const namespace = session.app.namespace;
    const appRate = this.appJoinLimiter.tryAcquire(namespace, JOIN_ATTEMPTS_PER_APP_PER_MINUTE);
    if (!appRate.ok) {
      this.warnOnce(
        'join_app_budget_exhausted',
        namespace,
        JOIN_WINDOW_MS,
        'join attempt budget for the app is used up',
      );
      return actionErrorMessage(ErrorCode.RATE_LIMITED, action, {
        details: { retryAfterMs: appRate.retryAfterMs },
      });
    }
    return undefined;
  }

  /** Debug log of a refused attempt: namespace and a fixed cause only (#10 6.1). */
  private rejected(namespace: string, cause: RejectCause, groupId?: string): void {
    this.deps.logger.debug(
      {
        event: 'join_rejected',
        namespace,
        cause,
        ...(groupId === undefined ? {} : { groupRef: groupRef(groupId) }),
      },
      'join rejected',
    );
  }

  /**
   * group.joinByCode (#10 AC12-AC18, architecture 4.3): busy, then
   * normalization, then the code lookup outside the lock, then the method
   * rules under the group lock, after re-checking that the code still maps
   * to the same group (it may have rotated or been freed meanwhile, R8).
   */
  async joinByCode(session: Session, message: GroupJoinByCodeMessage): Promise<ServerMessage> {
    // A busy session spends no budget (AC18).
    if (this.host.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);
    const limited = this.spendJoinAttempt(session, 'group.joinByCode');
    if (limited !== undefined) return limited;
    const namespace = session.app.namespace;
    const parsed = parseCodeJoin(message);
    if (parsed === undefined) return INVALID_MESSAGE;

    const groupId = this.index.lookup(namespace, parsed.kind, parsed.joinCode);
    if (groupId === undefined) {
      this.rejected(namespace, 'not_found');
      return CODE_NOT_FOUND;
    }
    return this.host.runLocked(namespace, groupId, async () => {
      if (this.host.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);
      const record = await this.deps.store.get(namespace, groupId);
      if (
        record === undefined ||
        this.index.lookup(namespace, parsed.kind, parsed.joinCode) !== groupId
      ) {
        this.rejected(namespace, 'not_found');
        return CODE_NOT_FOUND;
      }
      if (parsed.kind === 'alpha') {
        if (!record.joinMethods.includes('C')) return CODE_NOT_FOUND;
        return this.host.admit(session, groupId, 'C');
      }
      if (record.joinMethods.includes('A')) return this.doorJoin(session, record, parsed);
      // Method B (approval) is not served yet.
      this.rejected(namespace, 'not_found');
      return CODE_NOT_FOUND;
    });
  }

  /**
   * Method A under the group lock (#10 AC14, AC15): no door code is
   * DOOR_CODE_REQUIRED (not a failure); the door code is compared in
   * constant time, after both sides were validated as 6 digits (R6).
   */
  private async doorJoin(
    session: Session,
    record: GroupRecord,
    parsed: ParsedCodeJoin,
  ): Promise<ServerMessage> {
    const namespace = record.appNamespace;
    if (parsed.doorCode === undefined) {
      this.rejected(namespace, 'door_required', record.id);
      return errorMessage(ErrorCode.DOOR_CODE_REQUIRED);
    }
    const expected = record.codes.doorCode;
    if (expected === undefined || !doorCodeMatches(parsed.doorCode, expected)) {
      this.rejected(namespace, 'door_wrong', record.id);
      return errorMessage(ErrorCode.DOOR_CODE_WRONG);
    }
    return this.host.admit(session, record.id, 'A');
  }

  private now(): number {
    return this.deps.scheduler.now();
  }

  /**
   * The methods and a claimed code set for a new group (#10 AC5-AC9).
   * JOIN_METHOD_NOT_ALLOWED for a bad method set, CODES_EXHAUSTED when no
   * free code was found; nothing is claimed in either case.
   */
  initialCodes(app: AppConfig, groupId: string, requested?: JoinMethod[]): InitialCodesResult {
    const resolved = resolveGroupMethods(app.joinMethods, requested);
    if (!resolved.ok) return { ok: false, error: errorMessage(ErrorCode.JOIN_METHOD_NOT_ALLOWED) };
    const codes = issueCodeSet(
      this.index,
      app.namespace,
      groupId,
      resolved.methods,
      0,
      this.now(),
      this.random,
    );
    if (codes === 'exhausted') return { ok: false, error: errorMessage(ErrorCode.CODES_EXHAUSTED) };
    return { ok: true, methods: resolved.methods, codes };
  }

  /** The leader-only codes payload with a freshly signed blob (#10 AC6, AC32). */
  payload(
    record: Pick<GroupRecord, 'appNamespace' | 'id' | 'joinMethods' | 'codes'>,
  ): JoinCodesPayload {
    const { codes } = record;
    const payload: JoinCodesPayload = {
      generation: codes.generation,
      blob: this.deps.codesBlobs.sign(record.appNamespace, record.id, record.joinMethods, codes),
    };
    if (codes.groupCode !== undefined) payload.groupCode = codes.groupCode;
    if (codes.doorCode !== undefined) payload.doorCode = codes.doorCode;
    if (codes.alphaCode !== undefined) payload.alphaCode = codes.alphaCode;
    return payload;
  }

  /** Frees a claimed code set that was never stored (a failed create). */
  releaseCodes(namespace: string, groupId: string, codes: GroupCodes): void {
    this.index.release(namespace, groupId, codes);
  }

  /**
   * The group ended or left memory (#10 AC11, R14): its codes are freed at
   * once and can resolve to a new group later. Runs under the group lock.
   */
  onGroupGone(namespace: string, groupId: string, record: GroupRecord | undefined): void {
    if (record !== undefined) this.index.release(namespace, groupId, record.codes);
  }

  /** A connection closed: its per-connection budgets are forgotten (#10 6). */
  onDisconnect(session: Session): void {
    this.joinLimiter.forget(session.connectionId);
  }

  /** Server shutdown: forgets every code and budget (AC31). */
  close(): void {
    this.index.clear();
    this.joinLimiter.clear();
    this.appJoinLimiter.clear();
    this.warnedAt.clear();
  }

  /** Number of tracked limiter keys. For tests only. */
  get limiterSize(): number {
    return this.joinLimiter.size + this.appJoinLimiter.size;
  }
}
