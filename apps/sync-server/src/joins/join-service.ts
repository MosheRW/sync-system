import {
  ErrorCode,
  type ErrorMessage,
  type GroupJoinByCodeMessage,
  type GroupJoinByQrMessage,
  type JoinCodeKind,
  type JoinCodesPayload,
  type JoinMethod,
  type ServerMessage,
  classifyJoinCode,
  isDoorCode,
  normalizeJoinCode,
  resolveDisplayName,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import type { GroupRecord, GroupStore } from '../groups/group-store.js';
import type { Recipient, Target } from '../groups/recipients.js';
import type { Membership, Session } from '../groups/session.js';
import type { LeaderAction } from '../lifecycle/leader-guard.js';
import type { NameChoice } from '../lifecycle/roster.js';
import {
  QR_ISSUE_PER_CONNECTION_PER_MINUTE,
  QR_ISSUE_WINDOW_MS,
  MAX_PENDING_APPROVALS_PER_GROUP,
  CODE_ROTATIONS_PER_GROUP_PER_MINUTE,
  CODE_ROTATION_WINDOW_MS,
  DOOR_FAILURES_APP_WINDOW_MS,
  DOOR_PAUSE_MS,
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
import type { GroupTimers } from '../groups/group-timers.js';
import type { CodeIndexStore } from './code-index.js';
import {
  type GroupCodes,
  type RandomInt,
  cryptoRandomInt,
  doorCodeMatches,
  issueCodeSet,
  rotateDoorCode,
} from './codes.js';
import {
  type ApprovalStore,
  MemoryApprovals,
  type PendingRequest,
  type TakenRequest,
} from './approval-store.js';
import type { DoorStateStore } from './door-guard.js';
import { isValidGroupMethodSet, resolveGroupMethods } from './join-methods.js';

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
  /** Code -> group lookup per app (#10 D1; in Redis with #35). */
  codes: CodeIndexStore;
  /** Door-code failures, rotations and pauses per method A group (#10 AC29, R1a). */
  doors: DoorStateStore;
  /** Group timers (the door-pause end, #35 ADR 0013). */
  timers: GroupTimers;
  /** The latest a group created at `createdAt` can live: the TTL of its code claims (#35 AC24). */
  groupExpiry(namespace: string, createdAt: number): number;
  /** Pending method B requests; defaults to the in-memory store (#35 architecture 12.9). */
  approvals?: ApprovalStore;
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
  admit(
    session: Session,
    groupId: string,
    method: JoinMethod,
    name: NameChoice,
  ): Promise<ServerMessage>;
  /**
   * The session that owns the leader's membership (ownership-checked through
   * the notifier, M4), if the leader is attached.
   */
  leaderOf(record: GroupRecord): Recipient | undefined;
  /** Sends `message` to `to` after the replies it is already owed. */
  deliverLater(to: Target, message: ServerMessage): void;
  /**
   * True while the group admits nobody new: the leader locked it (#13
   * AC29). Read under the group lock.
   */
  admissionClosed(record: GroupRecord): boolean;
  /**
   * Runs `task` under the group lock of the session's group, after
   * `authorizeLeader` passed against the record read under that lock
   * (#13 D1, RC1). Otherwise answers its error (NOT_LEADER with the action's
   * text, NOT_IN_GROUP) and runs nothing.
   */
  asLeader(
    session: Session,
    action: LeaderAction,
    task: (record: GroupRecord, membership: Membership) => Promise<ServerMessage>,
  ): Promise<ServerMessage>;
}

/** Why a join attempt was refused, for the debug log (never a code or group ref for not_found). */
type RejectCause =
  | 'not_found'
  | 'door_required'
  | 'door_wrong'
  | 'door_budget'
  | 'paused'
  | 'qr_invalid'
  | 'qr_expired'
  | 'locked';

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
/** One frozen answer for every invalid ticket (#10 AC25, R7); never echoes the ticket. */
const QR_INVALID: ErrorMessage = Object.freeze(errorMessage(ErrorCode.QR_INVALID));
const QR_EXPIRED: ErrorMessage = Object.freeze(errorMessage(ErrorCode.QR_EXPIRED));
/**
 * One frozen answer for every join method and for join.approve while the
 * group admits nobody (#13 AC29, D14): no details, so the lock is the same
 * for every method and tells nothing about a code.
 */
export const GROUP_LOCKED: ErrorMessage = Object.freeze(errorMessage(ErrorCode.GROUP_LOCKED));
const REQUEST_NOT_FOUND: ErrorMessage = Object.freeze(
  errorMessage(ErrorCode.JOIN_REQUEST_NOT_FOUND),
);

/** How a pending request was settled, for the log (never a request ID or name). */
type SettleOutcome =
  'admitted' | 'group_full' | 'denied' | 'timeout' | 'cancelled' | 'disconnected' | 'group_gone';

/** A normalized and validated join-by-code request. */
interface ParsedCodeJoin {
  kind: JoinCodeKind;
  joinCode: string;
  doorCode: string | undefined;
  name: NameChoice;
}

/**
 * The joiner's name (#13 D11, AC35, AC36): missing or blank means a
 * generated one; anything else follows the strict #10 rule. Undefined when
 * the name is invalid.
 */
function nameOf(raw: string | undefined): NameChoice | undefined {
  const resolved = resolveDisplayName(raw);
  if (!resolved.ok) return undefined;
  return resolved.generated ? { generated: true } : { generated: false, name: resolved.name };
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
  const name = nameOf(message.displayName);
  if (name === undefined) return undefined;
  return { kind, joinCode, doorCode, name };
}

export type InitialCodesResult =
  { ok: true; methods: JoinMethod[]; codes: GroupCodes } | { ok: false; error: ServerMessage };

export type RestoredCodesResult =
  | { ok: true; methods: JoinMethod[]; codes: GroupCodes; changed: boolean }
  | { ok: false; error: ServerMessage };

/**
 * Every join and join-code flow (#10 architecture 1). `GroupService` stays
 * the facade: it owns the group lock, the store and the lifecycle, and calls
 * in here. Codes are group state (`GroupRecord.codes`); the code -> group
 * lookup is the process-local `CodeIndex`. Nothing here logs a code, door
 * code, ticket, blob, display name or request ID.
 */
export class JoinService {
  private readonly random: RandomInt;
  /** Join attempts per connection (#10 AC27). */
  private readonly joinLimiter: SlidingWindowRateLimiter;
  /** Join attempts per app, shared by its connections (#10 AC28). */
  private readonly appJoinLimiter: SlidingWindowRateLimiter;
  /** When a per-app budget warning was last logged, per `event:namespace`. */
  private readonly warnedAt = new Map<string, number>();
  /** Wrong door codes per app, checked before the compare (#10 R1b). */
  private readonly wrongDoorLimiter: SlidingWindowRateLimiter;
  /** Leader code rotations per group (#10 AC30). */
  private readonly rotateLimiter: SlidingWindowRateLimiter;
  /** Pending method B requests (#10 AC19-AC22). */
  readonly approvals: ApprovalStore;
  /** qr.issue per connection (#10 AC23). */
  private readonly qrLimiter: SlidingWindowRateLimiter;

  constructor(
    private readonly deps: JoinServiceDeps,
    private readonly host: JoinHost,
  ) {
    this.random = deps.random ?? cryptoRandomInt;
    const now = (): number => this.now();
    this.joinLimiter = new SlidingWindowRateLimiter(now, JOIN_WINDOW_MS);
    this.appJoinLimiter = new SlidingWindowRateLimiter(now, JOIN_WINDOW_MS);
    this.wrongDoorLimiter = new SlidingWindowRateLimiter(now, DOOR_FAILURES_APP_WINDOW_MS);
    this.rotateLimiter = new SlidingWindowRateLimiter(now, CODE_ROTATION_WINDOW_MS);
    this.approvals = deps.approvals ?? new MemoryApprovals(deps.scheduler);
    this.qrLimiter = new SlidingWindowRateLimiter(now, QR_ISSUE_WINDOW_MS);
  }

  /**
   * qr.issue (#10 AC23, R12, N6): the ownership-checked leader of a method D
   * group gets a ticket bound to the group's current **ticket** generation,
   * read under the group lock. Limited to 6 per connection per minute.
   */
  issueQr(session: Session): Promise<ServerMessage> {
    const namespace = session.app.namespace;
    return this.host.asLeader(session, 'qr.issue', (record) => {
      const groupId = record.id;
      if (!record.joinMethods.includes('D')) {
        return Promise.resolve(errorMessage(ErrorCode.JOIN_METHOD_NOT_ALLOWED));
      }
      const rate = this.qrLimiter.tryAcquire(
        session.connectionId,
        QR_ISSUE_PER_CONNECTION_PER_MINUTE,
      );
      if (!rate.ok) {
        return Promise.resolve(
          actionErrorMessage(ErrorCode.RATE_LIMITED, 'qr.issue', {
            details: { retryAfterMs: rate.retryAfterMs },
          }),
        );
      }
      const issued = this.deps.qrTickets.issue(
        namespace,
        groupId,
        record.codes.ticketGeneration,
        this.now(),
        session.app.qrTicketSeconds,
      );
      this.deps.logger.debug(
        { event: 'qr_issued', namespace, groupRef: groupRef(groupId) },
        'qr ticket issued',
      );
      return Promise.resolve({
        type: 'qr.ticket',
        ticket: issued.ticket,
        expiresInMs: issued.expiresInMs,
      });
    });
  }

  /**
   * group.joinByQr (#10 AC24, AC25, architecture 4.3, 4.7): busy, the join
   * budgets, the display name, then the ticket (length, shape, signature,
   * claims, expiry) outside the lock, then under the group lock: the group
   * must be in memory, use method D, and have the ticket's ticket
   * generation (a door rotation does not change it, D12). A method B group
   * still asks the leader (Q3.2). Every invalid ticket gets the same
   * QR_INVALID; only a well-formed, signed, expired one gets QR_EXPIRED.
   */
  async joinByQr(session: Session, message: GroupJoinByQrMessage): Promise<ServerMessage> {
    if (this.host.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);
    const limited = this.spendJoinAttempt(session, 'group.joinByQr');
    if (limited !== undefined) return limited;
    const namespace = session.app.namespace;
    const name = nameOf(message.displayName);
    if (name === undefined) return INVALID_MESSAGE;
    const verified = this.deps.qrTickets.verify(message.ticket, namespace, this.now());
    if (!verified.ok) {
      this.rejected(namespace, verified.expired ? 'qr_expired' : 'qr_invalid');
      return verified.expired ? QR_EXPIRED : QR_INVALID;
    }
    const { groupId, ticketGeneration } = verified;
    return this.host.runLocked(namespace, groupId, async () => {
      if (this.host.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);
      const record = await this.deps.store.get(namespace, groupId);
      if (
        record === undefined ||
        !record.joinMethods.includes('D') ||
        record.codes.ticketGeneration !== ticketGeneration
      ) {
        this.rejected(namespace, 'qr_invalid');
        return QR_INVALID;
      }
      // #13 D14: after the full ticket check, before approval or admission.
      if (this.host.admissionClosed(record)) {
        this.rejected(namespace, 'locked', groupId);
        return GROUP_LOCKED;
      }
      if (record.joinMethods.includes('B')) return this.requestApproval(session, record, name);
      return this.host.admit(session, groupId, 'D', name);
    });
  }

  private settled(request: PendingRequest, outcome: SettleOutcome): void {
    const namespace = request.session.app.namespace;
    this.deps.logger.info(
      { event: 'join_settled', namespace, groupRef: groupRef(request.groupId), outcome },
      'join request settled',
    );
  }

  /** `join.requested` for the leader, with the remaining time (#10 AC19, AC34). */
  private requestedMessage(request: PendingRequest): ServerMessage {
    const message: ServerMessage = {
      type: 'join.requested',
      groupId: request.groupId,
      requestId: request.requestId,
      expiresInMs: Math.max(0, request.deadline - this.now()),
    };
    if (request.displayName !== undefined) message.displayName = request.displayName;
    return message;
  }

  /**
   * A valid method B code (or a QR ticket of a B group) under the group lock
   * (#10 AC19, AC22, architecture 4.6): the request is queued with its
   * deadline; the joiner gets `join.pending`, and the attached leader gets
   * `join.requested` after its pending replies. A frozen group's request
   * waits for the leader (Q6.2).
   */
  private async requestApproval(
    session: Session,
    record: GroupRecord,
    name: NameChoice,
  ): Promise<ServerMessage> {
    // Only a chosen name is shown in join.requested; a generated one is
    // drawn at admission (#13 AC36).
    const displayName = name.generated ? undefined : name.name;
    const namespace = record.appNamespace;
    const timeoutMs = session.app.approvalTimeoutSeconds * 1000;
    const added = await this.approvals.add(
      {
        groupKey: groupKey(namespace, record.id),
        groupId: record.id,
        session,
        displayName,
        deadline: this.now() + timeoutMs,
      },
      (requestId) => this.onApprovalTimeout(namespace, record.id, requestId),
    );
    if (added === 'full') {
      return errorMessage(ErrorCode.APPROVAL_QUEUE_FULL, {
        details: { maxPending: MAX_PENDING_APPROVALS_PER_GROUP },
      });
    }
    this.deps.logger.info(
      { event: 'join_requested', namespace, groupRef: groupRef(record.id) },
      'join requested',
    );
    const leader = this.host.leaderOf(record);
    if (leader !== undefined) this.host.deliverLater(leader, this.requestedMessage(added));
    return { type: 'join.pending', requestId: added.requestId, timeoutMs };
  }

  /** The deadline timer: under the group lock, unless the request already settled. */
  private onApprovalTimeout(namespace: string, groupId: string, requestId: string): void {
    this.host
      .runLocked(namespace, groupId, async () => {
        const taken = await this.approvals.take(groupKey(namespace, groupId), requestId);
        if (taken === undefined) return;
        this.settled(taken, 'timeout');
        this.host.deliverLater(taken.session, errorMessage(ErrorCode.APPROVAL_TIMEOUT));
        await this.withdrawn(namespace, taken, 'timeout');
      })
      .catch((err: unknown) => {
        this.deps.logger.error(
          { event: 'timer_error', err: safeErr(err) },
          'approval timer failed',
        );
      });
  }

  /** Tells the attached leader a request left without a decision. Under the lock. */
  private async withdrawn(
    namespace: string,
    request: PendingRequest,
    reason: 'cancelled' | 'disconnected' | 'timeout',
  ): Promise<void> {
    const record = await this.deps.store.get(namespace, request.groupId);
    const leader = record === undefined ? undefined : this.host.leaderOf(record);
    if (leader === undefined) return;
    this.host.deliverLater(leader, {
      type: 'join.withdrawn',
      groupId: request.groupId,
      requestId: request.requestId,
      reason,
    });
  }

  /**
   * join.approve / join.deny (#10 AC21, R11, R12): the ownership-checked
   * leader decides a request of its own group only. The request is removed
   * first, so it settles exactly once. Approve re-checks that the joiner's
   * socket is still open and still waits for this request; if not, nobody
   * is added and the leader gets JOIN_REQUEST_NOT_FOUND.
   */
  async decide(
    session: Session,
    requestId: string,
    decision: 'approve' | 'deny',
  ): Promise<ServerMessage> {
    const action = decision === 'approve' ? 'join.approve' : 'join.deny';
    const namespace = session.app.namespace;
    return this.host.asLeader(session, action, async (record) => {
      const groupId = record.id;
      // #13 Q4.2: while locked a request stays pending and cannot be approved.
      if (decision === 'approve' && this.host.admissionClosed(record)) {
        const pending = (await this.approvals.list(groupKey(namespace, groupId))).some(
          (request) => request.requestId === requestId,
        );
        return pending ? GROUP_LOCKED : REQUEST_NOT_FOUND;
      }
      const taken = await this.approvals.take(groupKey(namespace, groupId), requestId);
      if (taken === undefined) return REQUEST_NOT_FOUND;
      if (decision === 'deny') {
        this.settled(taken, 'denied');
        this.host.deliverLater(taken.session, errorMessage(ErrorCode.JOIN_DENIED));
        return { type: 'join.decided', requestId, outcome: 'denied' };
      }
      if (!taken.current || !taken.session.isOpen() || this.host.busy(taken.session)) {
        this.settled(taken, 'disconnected');
        return REQUEST_NOT_FOUND;
      }
      return this.admitApproved(taken);
    });
  }

  /** Adds an approved joiner (#10 AC21): group.joined to it, or GROUP_FULL. Under the lock. */
  private async admitApproved(taken: TakenRequest): Promise<ServerMessage> {
    const name: NameChoice =
      taken.displayName === undefined
        ? { generated: true }
        : { generated: false, name: taken.displayName };
    const admitted = await this.host.admit(taken.session, taken.groupId, 'B', name);
    // The joiner gets the outcome unsolicited (no reqId): its own request was join.pending.
    this.host.deliverLater(taken.session, admitted);
    const outcome = admitted.type === 'group.joined' ? 'admitted' : 'group_full';
    this.settled(taken, outcome);
    return { type: 'join.decided', requestId: taken.requestId, outcome };
  }

  /** join.cancel (#10 AC21): the joiner withdraws; the leader gets `join.withdrawn cancelled`. */
  async cancel(session: Session): Promise<ServerMessage> {
    const pending = session.pendingJoin;
    if (pending === undefined) return REQUEST_NOT_FOUND;
    const namespace = session.app.namespace;
    return this.host.runLocked(namespace, pending.groupId, async () => {
      const taken = await this.approvals.takeBySession(session);
      if (taken === undefined) return REQUEST_NOT_FOUND;
      this.settled(taken, 'cancelled');
      await this.withdrawn(namespace, taken, 'cancelled');
      return { type: 'join.cancelled', requestId: taken.requestId };
    });
  }

  /**
   * The leader is back (#10 AC21, AC29, AC34): every pending request is
   * re-sent after the reply, and `join.paused` if method A is still paused.
   */
  async onLeaderReturn(leader: Target, record: GroupRecord): Promise<void> {
    const paused = await this.pausedFor(record.appNamespace, record.id);
    if (paused > 0) {
      this.host.deliverLater(leader, {
        type: 'join.paused',
        groupId: record.id,
        retryAfterMs: paused,
      });
    }
    for (const request of await this.approvals.list(groupKey(record.appNamespace, record.id))) {
      this.host.deliverLater(leader, this.requestedMessage(request));
    }
  }

  /**
   * codes.rotate (#10 AC30, R12): the ownership-checked leader replaces
   * every code of its group. A full new set, so the code generation and the
   * ticket generation move to the same new value and older QR tickets stop
   * working (D12). Door-code failures, rotation history and any pause are
   * cleared; a lifted pause is announced with `join.resumed` after the
   * reply. Limited to 6 per group per minute.
   */
  rotate(session: Session): Promise<ServerMessage> {
    const namespace = session.app.namespace;
    return this.host.asLeader(session, 'codes.rotate', async (record) => {
      const groupId = record.id;
      const key = groupKey(namespace, groupId);
      const rate = this.rotateLimiter.tryAcquire(key, CODE_ROTATIONS_PER_GROUP_PER_MINUTE);
      if (!rate.ok) {
        return actionErrorMessage(ErrorCode.RATE_LIMITED, 'codes.rotate', {
          details: { retryAfterMs: rate.retryAfterMs },
        });
      }
      const next = await this.claimFullSet(record);
      if (next === 'exhausted') return errorMessage(ErrorCode.CODES_EXHAUSTED);
      const updated = await this.commitFullSet(record, next, 'leader', session);
      if (updated === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
      return {
        type: 'codes.updated',
        groupId,
        reason: 'rotated',
        codes: this.payload(updated),
      };
    });
  }

  /**
   * Claims a full new code set for the group (#10 AC30, #13 RC4): new
   * codes, and the ticket generation moves with the code generation, so
   * every older QR ticket stops working (D12). Nothing changes until
   * `commitFullSet`; on `exhausted` nothing was claimed.
   */
  claimFullSet(record: GroupRecord): Promise<GroupCodes | 'exhausted'> {
    return issueCodeSet(
      this.deps.codes,
      record.appNamespace,
      record.id,
      record.joinMethods,
      record.codes.generation,
      this.now(),
      this.random,
      this.deps.groupExpiry(record.appNamespace, record.createdAt),
    );
  }

  /** Clears door state; a lifted pause's timer goes too. Under the group lock. */
  private async resetDoor(namespace: string, groupId: string): Promise<boolean> {
    const lifted = await this.deps.doors.reset(namespace, groupId, this.now());
    this.deps.timers.clear(namespace, groupId, 'doorPauseEnd');
    return lifted;
  }

  /**
   * Stores a claimed full set and frees the old codes; door-code failures,
   * rotation history and any pause are cleared, and a lifted pause is told
   * to `leader` (`join.resumed`). Returns the updated record, or undefined
   * when the group is gone (the claim is released). Under the group lock.
   */
  async commitFullSet(
    record: GroupRecord,
    next: GroupCodes,
    cause: 'leader' | 'member_removed' | 'superseded',
    leader: Target | undefined,
  ): Promise<GroupRecord | undefined> {
    const namespace = record.appNamespace;
    const groupId = record.id;
    const updated = await this.deps.store.setCodes(namespace, groupId, next);
    if (updated === undefined) {
      await this.deps.codes.release(namespace, groupId, next);
      return undefined;
    }
    // The new codes differ from the old ones, which are freed now.
    await this.deps.codes.release(namespace, groupId, record.codes);
    const lifted = await this.resetDoor(namespace, groupId);
    this.deps.logger.info(
      { event: 'codes_rotated', namespace, groupRef: groupRef(groupId), cause },
      'codes rotated',
    );
    if (lifted) {
      this.deps.logger.info(
        { event: 'join_resumed', namespace, groupRef: groupRef(groupId) },
        'door code joining resumed',
      );
      if (leader !== undefined) this.host.deliverLater(leader, { type: 'join.resumed', groupId });
    }
    return updated;
  }

  /**
   * Supersede codes (#13 6.6.2 step 5, M1): the requester's blob is adopted
   * (codes and ticket generation) if it verifies for this group, has the
   * group's methods, shares nothing with the stale line (another code
   * generation, another ticket generation, no equal code), and its codes
   * are free; otherwise a full new set is claimed. Either way no code or
   * ticket of the stale line survives: a blob from after a door-only
   * rotation keeps the stale ticket generation and group code, so it is
   * rotated (#13 security L-2). Returns the codes to store, or `exhausted`.
   */
  async supersedeCodes(
    record: GroupRecord,
    blob: string | undefined,
  ): Promise<{ codes: GroupCodes; rotated: boolean } | 'exhausted'> {
    const namespace = record.appNamespace;
    const verified =
      blob === undefined ? undefined : this.deps.codesBlobs.verify(blob, namespace, record.id);
    if (
      verified !== undefined &&
      sharesNothing(verified.codes, record.codes) &&
      verified.methods.length === record.joinMethods.length &&
      verified.methods.every((m) => record.joinMethods.includes(m)) &&
      (await this.deps.codes.claim(
        namespace,
        record.id,
        verified.codes,
        this.deps.groupExpiry(namespace, record.createdAt),
      ))
    ) {
      return { codes: { ...verified.codes }, rotated: false };
    }
    const next = await this.claimFullSet(record);
    return next === 'exhausted' ? next : { codes: next, rotated: true };
  }

  /** Stores supersede codes and frees the old ones that are not reused. */
  async commitSupersedeCodes(record: GroupRecord, codes: GroupCodes): Promise<GroupRecord> {
    const namespace = record.appNamespace;
    const updated = (await this.deps.store.setCodes(namespace, record.id, codes)) ?? record;
    const old = record.codes;
    await this.deps.codes.release(namespace, record.id, {
      ...(old.groupCode !== undefined && old.groupCode !== codes.groupCode
        ? { groupCode: old.groupCode }
        : {}),
      ...(old.alphaCode !== undefined && old.alphaCode !== codes.alphaCode
        ? { alphaCode: old.alphaCode }
        : {}),
    });
    await this.resetDoor(namespace, record.id);
    this.deps.logger.info(
      { event: 'codes_rotated', namespace, groupRef: groupRef(record.id), cause: 'superseded' },
      'codes replaced on supersede',
    );
    return updated;
  }

  /** Releases a claimed set that was never committed. */
  releaseClaim(record: GroupRecord, claimed: GroupCodes): Promise<void> {
    return this.deps.codes.release(record.appNamespace, record.id, claimed);
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
  private spendJoinAttempt(
    session: Session,
    action: 'group.joinByCode' | 'group.joinByQr',
  ): ErrorMessage | undefined {
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

    const groupId = await this.deps.codes.lookup(namespace, parsed.kind, parsed.joinCode);
    if (groupId === undefined) {
      this.rejected(namespace, 'not_found');
      return CODE_NOT_FOUND;
    }
    return this.host.runLocked(namespace, groupId, async () => {
      if (this.host.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);
      const record = await this.deps.store.get(namespace, groupId);
      if (
        record === undefined ||
        (await this.deps.codes.lookup(namespace, parsed.kind, parsed.joinCode)) !== groupId
      ) {
        this.rejected(namespace, 'not_found');
        return CODE_NOT_FOUND;
      }
      const usable =
        parsed.kind === 'alpha'
          ? record.joinMethods.includes('C')
          : record.joinMethods.includes('A') || record.joinMethods.includes('B');
      if (!usable) {
        this.rejected(namespace, 'not_found');
        return CODE_NOT_FOUND;
      }
      // #13 D14: the code is resolved; the lock comes before the door-code
      // compare, the approval queue and admission (no door failure counted).
      if (this.host.admissionClosed(record)) {
        this.rejected(namespace, 'locked', groupId);
        return GROUP_LOCKED;
      }
      if (parsed.kind === 'alpha') return this.host.admit(session, groupId, 'C', parsed.name);
      if (record.joinMethods.includes('A')) return this.doorJoin(session, record, parsed);
      return this.requestApproval(session, record, parsed.name);
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
   * N2: steps 3 and 4 and the app budget record run in one synchronous
   * block, with no `await` inside. The group lock is per group but the
   * budget is per app, so an `await` there would let attempts on other
   * groups of the same app peek past the cap. The group's own failure count
   * is per group, so it is recorded after the block, still under the group
   * lock; the rotation's store write follows.
   */
  private async doorJoin(
    session: Session,
    record: GroupRecord,
    parsed: ParsedCodeJoin,
  ): Promise<ServerMessage> {
    const namespace = record.appNamespace;
    const paused = await this.deps.doors.pausedFor(namespace, record.id, this.now());
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
      return this.host.admit(session, record.id, 'A', parsed.name);
    }
    this.wrongDoorLimiter.record(namespace);
    // --- end of the synchronous block ---
    const outcome = await this.deps.doors.recordFailure(namespace, record.id);

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
    const now = this.now();
    const next = rotateDoorCode(record.codes, now, this.random);
    if (next === 'exhausted') return;
    const updated = await this.deps.store.setCodes(namespace, record.id, next);
    if (updated === undefined) return;
    const pause = await this.deps.doors.recordRotation(namespace, record.id, now);
    if (pause.paused)
      this.deps.timers.arm(namespace, record.id, 'doorPauseEnd', now + DOOR_PAUSE_MS);
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

  /**
   * The `doorPauseEnd` timer (runs under the group lock): end the pause and
   * tell the leader. Stale if the pause was lifted or moved.
   */
  async pauseEnded(namespace: string, groupId: string): Promise<void> {
    if (!(await this.deps.doors.endPause(namespace, groupId, this.now()))) return;
    this.deps.logger.info(
      { event: 'join_resumed', namespace, groupRef: groupRef(groupId) },
      'door code joining resumed',
    );
    const record = await this.deps.store.get(namespace, groupId);
    const leader = record === undefined ? undefined : this.host.leaderOf(record);
    if (leader !== undefined) {
      this.host.deliverLater(leader, { type: 'join.resumed', groupId });
    }
  }

  /** The remaining door-code pause of a group, or 0. */
  pausedFor(namespace: string, groupId: string): Promise<number> {
    return this.deps.doors.pausedFor(namespace, groupId, this.now());
  }

  private now(): number {
    return this.deps.scheduler.now();
  }

  /**
   * The methods and a claimed code set for a new group (#10 AC5-AC9).
   * JOIN_METHOD_NOT_ALLOWED for a bad method set, CODES_EXHAUSTED when no
   * free code was found; nothing is claimed in either case.
   */
  async initialCodes(
    app: AppConfig,
    groupId: string,
    requested?: JoinMethod[],
  ): Promise<InitialCodesResult> {
    const resolved = resolveGroupMethods(app.joinMethods, requested);
    if (!resolved.ok) return { ok: false, error: errorMessage(ErrorCode.JOIN_METHOD_NOT_ALLOWED) };
    const now = this.now();
    const codes = await issueCodeSet(
      this.deps.codes,
      app.namespace,
      groupId,
      resolved.methods,
      0,
      now,
      this.random,
      this.deps.groupExpiry(app.namespace, now),
    );
    if (codes === 'exhausted') return { ok: false, error: errorMessage(ErrorCode.CODES_EXHAUSTED) };
    return { ok: true, methods: resolved.methods, codes };
  }

  /**
   * Codes for a group recreated from the leader's token (#10 AC33, R5, D12):
   * the blob must verify (current or previous codes key) for this app and
   * group ID, and its methods must still be allowed for the app. Then, if
   * every code is free, the group keeps the same codes, code generation and
   * ticket generation (QR tickets from before the restart keep working).
   * Otherwise (missing, invalid, foreign or tampered blob, methods no longer
   * allowed, a code taken) a full new set is issued with a higher code
   * generation and the ticket generation set to it, so older tickets stop
   * working. The server never accepts codes it did not sign for the group.
   */
  async restoreCodes(
    app: AppConfig,
    groupId: string,
    createdAt: number,
    blob: string | undefined,
  ): Promise<RestoredCodesResult> {
    const namespace = app.namespace;
    const expiresAt = this.deps.groupExpiry(namespace, createdAt);
    const verified =
      blob === undefined ? undefined : this.deps.codesBlobs.verify(blob, namespace, groupId);
    if (verified !== undefined && verified.methods.every((m) => app.joinMethods.includes(m))) {
      if (await this.deps.codes.claim(namespace, groupId, verified.codes, expiresAt)) {
        this.deps.logger.info(
          { event: 'codes_restored', namespace, groupRef: groupRef(groupId), changed: false },
          'join codes restored',
        );
        return {
          ok: true,
          methods: [...verified.methods],
          codes: { ...verified.codes },
          changed: false,
        };
      }
    }
    let methods: JoinMethod[] | undefined;
    if (verified !== undefined) {
      const kept = verified.methods.filter((method) => app.joinMethods.includes(method));
      if (isValidGroupMethodSet(kept)) methods = kept;
    }
    if (methods === undefined) {
      const resolved = resolveGroupMethods(app.joinMethods);
      if (!resolved.ok) {
        return { ok: false, error: errorMessage(ErrorCode.JOIN_METHOD_NOT_ALLOWED) };
      }
      methods = resolved.methods;
    }
    const codes = await issueCodeSet(
      this.deps.codes,
      namespace,
      groupId,
      methods,
      verified?.codes.generation ?? 0,
      this.now(),
      this.random,
      expiresAt,
    );
    if (codes === 'exhausted') return { ok: false, error: errorMessage(ErrorCode.CODES_EXHAUSTED) };
    this.deps.logger.info(
      { event: 'codes_restored', namespace, groupRef: groupRef(groupId), changed: true },
      'join codes restored',
    );
    return { ok: true, methods, codes, changed: true };
  }

  /**
   * On leader return (#10 AC34): false only when the presented blob verifies
   * for this group and carries the current code generation. A door rotation
   * while the leader was away shows up as changed.
   */
  codesChangedFor(record: GroupRecord, blob: string | undefined): boolean {
    if (blob === undefined) return true;
    const verified = this.deps.codesBlobs.verify(blob, record.appNamespace, record.id);
    return verified?.codes.generation !== record.codes.generation;
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
  releaseCodes(namespace: string, groupId: string, codes: GroupCodes): Promise<void> {
    return this.deps.codes.release(namespace, groupId, codes);
  }

  /**
   * The group ended or left memory (#10 AC11, AC22, R14): its codes are
   * freed at once and can resolve to a new group later, and every pending
   * joiner gets GROUP_ENDED without a group ID or details (D9, R13). Runs
   * under the group lock.
   */
  async onGroupGone(
    namespace: string,
    groupId: string,
    record: GroupRecord | undefined,
  ): Promise<void> {
    for (const taken of await this.approvals.drain(groupKey(namespace, groupId))) {
      this.settled(taken, 'group_gone');
      this.host.deliverLater(taken.session, errorMessage(ErrorCode.GROUP_ENDED));
    }
    if (record !== undefined) await this.deps.codes.release(namespace, groupId, record.codes);
    await this.deps.doors.clear(namespace, groupId);
    this.rotateLimiter.forget(groupKey(namespace, groupId));
  }

  /**
   * A connection closed (#10 6): its per-connection budgets are forgotten,
   * and a pending request is withdrawn under the group lock (the leader
   * gets `join.withdrawn disconnected`).
   */
  async onDisconnect(session: Session): Promise<void> {
    this.joinLimiter.forget(session.connectionId);
    this.qrLimiter.forget(session.connectionId);
    const pending = session.pendingJoin;
    if (pending === undefined) return;
    const namespace = session.app.namespace;
    await this.host.runLocked(namespace, pending.groupId, async () => {
      const taken = await this.approvals.takeBySession(session);
      if (taken === undefined) return;
      this.settled(taken, 'disconnected');
      await this.withdrawn(namespace, taken, 'disconnected');
    });
  }

  /**
   * The session stops waiting without the leader being told (#35 security
   * C13: a self-fence). In memory the request goes too; in Redis it
   * expires at its deadline, and an approve after that finds nothing.
   */
  forgetPending(session: Session): void {
    void this.approvals.takeBySession(session).catch(() => undefined);
    session.pendingJoin = undefined;
  }

  /** Server shutdown: forgets every code and budget (AC31). */
  close(): void {
    this.deps.codes.clear();
    this.joinLimiter.clear();
    this.appJoinLimiter.clear();
    this.wrongDoorLimiter.clear();
    this.rotateLimiter.clear();
    this.qrLimiter.clear();
    this.approvals.clearAll();
    this.deps.doors.clearAll();
    this.warnedAt.clear();
  }

  /** Number of tracked limiter keys. For tests only. */
  get limiterSize(): number {
    return (
      this.joinLimiter.size +
      this.appJoinLimiter.size +
      this.wrongDoorLimiter.size +
      this.rotateLimiter.size +
      this.qrLimiter.size
    );
  }
}

/**
 * Whether `next` keeps nothing of `stale` (#13 M1, security L-2): another
 * code generation and ticket generation, and no code equal to a stale one.
 */
function sharesNothing(next: GroupCodes, stale: GroupCodes): boolean {
  const same = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && a === b;
  return (
    next.generation !== stale.generation &&
    next.ticketGeneration !== stale.ticketGeneration &&
    !same(next.groupCode, stale.groupCode) &&
    !same(next.doorCode, stale.doorCode) &&
    !same(next.alphaCode, stale.alphaCode)
  );
}
