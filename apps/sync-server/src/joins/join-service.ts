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
  DOOR_FAILURES_APP_WINDOW_MS,
  DOOR_FAILURES_PER_APP_PER_MINUTE,
  JOIN_ATTEMPTS_PER_APP_PER_MINUTE,
  JOIN_ATTEMPTS_PER_CONNECTION_PER_MINUTE,
  JOIN_WINDOW_MS,
} from '../limits/constants.js';
import { SlidingWindowRateLimiter } from '../limits/rate-limiter.js';
import { type Logger, groupRef, safeErr } from '../logging/logger.js';
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
  rotateDoorCode,
} from './codes.js';
import { DoorGuard } from './door-guard.js';
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
  /**
   * The session that owns the leader's membership (ownership-checked through
   * the notifier, M4), if the leader is attached.
   */
  leaderOf(record: GroupRecord): Session | undefined;
  /** Sends `message` to `session` after the replies it is already owed. */
  deliverLater(session: Session, message: ServerMessage): void;
}

/** Why a join attempt was refused, for the debug log (never a code or group ref for not_found). */
type RejectCause = 'not_found' | 'door_required' | 'door_wrong' | 'door_budget' | 'paused';

function groupKey(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

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
  /** Wrong door codes per app, checked before the compare (#10 R1b). */
  private readonly wrongDoorLimiter: SlidingWindowRateLimiter;
  /** Door-code failures, rotations and pauses per method A group (#10 AC29, R1a). */
  readonly doors: DoorGuard;

  constructor(
    private readonly deps: JoinServiceDeps,
    private readonly host: JoinHost,
  ) {
    this.random = deps.random ?? cryptoRandomInt;
    const now = (): number => this.now();
    this.joinLimiter = new SlidingWindowRateLimiter(now, JOIN_WINDOW_MS);
    this.appJoinLimiter = new SlidingWindowRateLimiter(now, JOIN_WINDOW_MS);
    this.wrongDoorLimiter = new SlidingWindowRateLimiter(now, DOOR_FAILURES_APP_WINDOW_MS);
    this.doors = new DoorGuard(deps.scheduler);
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
   * Method A under the group lock (#10 AC14, AC15, AC29, architecture 4.3
   * step 7), in this order:
   * 1. paused: JOIN_PAUSED, nothing compared (R6);
   * 2. no door code: DOOR_CODE_REQUIRED, not a failure, no budget used;
   * 3. the app's wrong-door budget used up: RATE_LIMITED, nothing compared (R1b);
   * 4. constant-time compare (R6). Wrong: one event in the app budget and
   *    one group failure; every 5th failure rotates the door code (R1a).
   *
   * N2: steps 3 and 4 and the two records run in one synchronous block, with
   * no `await` inside. The group lock is per group but the budget is per
   * app, so an `await` there would let attempts on other groups of the same
   * app peek past the cap. The rotation's store write starts after it.
   */
  private async doorJoin(
    session: Session,
    record: GroupRecord,
    parsed: ParsedCodeJoin,
  ): Promise<ServerMessage> {
    const namespace = record.appNamespace;
    const key = groupKey(namespace, record.id);
    const paused = this.doors.pausedFor(key, this.now());
    if (paused > 0) {
      this.rejected(namespace, 'paused', record.id);
      return errorMessage(ErrorCode.JOIN_PAUSED, { details: { retryAfterMs: paused } });
    }
    if (parsed.doorCode === undefined) {
      this.rejected(namespace, 'door_required', record.id);
      return errorMessage(ErrorCode.DOOR_CODE_REQUIRED);
    }

    // --- one synchronous block (N2): check, compare, record ---
    const budget = this.wrongDoorLimiter.check(namespace, DOOR_FAILURES_PER_APP_PER_MINUTE);
    if (!budget.ok) {
      this.warnOnce(
        'door_failures_app_budget_exhausted',
        namespace,
        DOOR_FAILURES_APP_WINDOW_MS,
        'wrong door code budget for the app is used up',
      );
      this.rejected(namespace, 'door_budget', record.id);
      return actionErrorMessage(ErrorCode.RATE_LIMITED, 'group.joinByCode', {
        details: { retryAfterMs: budget.retryAfterMs },
      });
    }
    const expected = record.codes.doorCode;
    if (expected !== undefined && doorCodeMatches(parsed.doorCode, expected)) {
      return this.host.admit(session, record.id, 'A');
    }
    this.wrongDoorLimiter.record(namespace);
    const outcome = this.doors.recordFailure(key);
    // --- end of the synchronous block ---

    this.rejected(namespace, 'door_wrong', record.id);
    if (outcome === 'rotate') await this.rotateDoor(record);
    return errorMessage(ErrorCode.DOOR_CODE_WRONG);
  }

  /**
   * Rotates the door code after DOOR_FAILURES_BEFORE_ROTATION wrong codes
   * (#10 AC29, R1a): new door code and code generation, same group code,
   * same ticket generation (QR tickets keep working, D12). The leader gets
   * `codes.updated door_failures`, and `join.paused` when this rotation
   * starts a pause. Runs under the group lock.
   */
  private async rotateDoor(record: GroupRecord): Promise<void> {
    const namespace = record.appNamespace;
    const key = groupKey(namespace, record.id);
    const now = this.now();
    const next = rotateDoorCode(record.codes, now, this.random);
    if (next === 'exhausted') return;
    const updated = await this.deps.store.setCodes(namespace, record.id, next);
    if (updated === undefined) return;
    const pause = this.doors.recordRotation(key, now, () => {
      this.onPauseEnd(namespace, record.id);
    });
    this.deps.logger.info(
      { event: 'codes_rotated', namespace, groupRef: groupRef(record.id), cause: 'door_failures' },
      'door code rotated',
    );
    const leader = this.host.leaderOf(updated);
    if (leader !== undefined) {
      this.host.deliverLater(leader, {
        type: 'codes.updated',
        groupId: record.id,
        reason: 'door_failures',
        codes: this.payload(updated),
      });
    }
    if (pause.paused) {
      this.deps.logger.info(
        { event: 'join_paused', namespace, groupRef: groupRef(record.id) },
        'door code joining paused',
      );
      if (leader !== undefined) {
        this.host.deliverLater(leader, {
          type: 'join.paused',
          groupId: record.id,
          retryAfterMs: pause.retryAfterMs ?? 0,
        });
      }
    }
  }

  /** The pause timer fired: under the group lock, end the pause and tell the leader. */
  private onPauseEnd(namespace: string, groupId: string): void {
    this.host
      .runLocked(namespace, groupId, async () => {
        if (!this.doors.endPause(groupKey(namespace, groupId), this.now())) return;
        this.deps.logger.info(
          { event: 'join_resumed', namespace, groupRef: groupRef(groupId) },
          'door code joining resumed',
        );
        const record = await this.deps.store.get(namespace, groupId);
        const leader = record === undefined ? undefined : this.host.leaderOf(record);
        if (leader !== undefined) {
          this.host.deliverLater(leader, { type: 'join.resumed', groupId });
        }
      })
      .catch((err: unknown) => {
        this.deps.logger.error(
          { event: 'timer_error', err: safeErr(err) },
          'join pause timer failed',
        );
      });
  }

  /** The remaining door-code pause of a group, or 0. */
  pausedFor(namespace: string, groupId: string): number {
    return this.doors.pausedFor(groupKey(namespace, groupId), this.now());
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
    this.doors.clear(groupKey(namespace, groupId));
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
    this.wrongDoorLimiter.clear();
    this.doors.clearAll();
    this.warnedAt.clear();
  }

  /** Number of tracked limiter keys. For tests only. */
  get limiterSize(): number {
    return this.joinLimiter.size + this.appJoinLimiter.size + this.wrongDoorLimiter.size;
  }
}
