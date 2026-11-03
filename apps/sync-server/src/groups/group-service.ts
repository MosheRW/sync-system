import {
  type BlockListSetMessage,
  ErrorCode,
  GROUP_ID_PATTERN,
  type GroupCreateMessage,
  type GroupEndMessage,
  type GroupEndedReason,
  type GroupJoinMessage,
  type GroupJoinByCodeMessage,
  type JoinMethod,
  type GroupLeaveMessage,
  type GroupResumeMessage,
  type PositionUpdateMessage,
  type Role,
  type ServerMessage,
  type TokenClaims,
  type TokensCheckMessage,
  type TokensResultMessage,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import { jsonByteLength } from '../limits/json-size.js';
import {
  TOKENS_CHECK_PER_APP_PER_MINUTE,
  TOKENS_CHECK_PER_MINUTE,
  TOKENS_CHECK_WINDOW_MS,
} from '../limits/constants.js';
import { SlidingWindowRateLimiter } from '../limits/rate-limiter.js';
import { type Logger, groupRef, participantRef, safeErr } from '../logging/logger.js';
import type { Scheduler } from '../time/scheduler.js';
import type { TokenService } from '../tokens/token-service.js';
import type { CodesBlobService } from '../tokens/codes-blob.js';
import type { QrTicketService } from '../tokens/qr-tickets.js';
import type { RandomInt } from '../joins/codes.js';
import { JoinService } from '../joins/join-service.js';
import { actionErrorMessage, errorMessage } from '../ws/error-messages.js';
import { type GroupRecord, type GroupStore, connectedCount } from './group-store.js';
import type { EndedGroups } from './ended-groups.js';
import { GroupTimers } from './group-timers.js';
import { newGroupId, newParticipantId } from './ids.js';
import { KeyedLock } from './keyed-lock.js';
import type { Notifier } from './notifier.js';
import { ParkingLot } from './parking-lot.js';
import { classifyToken } from './resume.js';
import { type RefreshPolicy, TokenRefresher } from './token-refresher.js';
import { type GroupActions, type Membership, type Session, membershipKey } from './session.js';

export interface GroupServiceDeps {
  store: GroupStore;
  notifier: Notifier;
  logger: Logger;
  /** Clock and timers (frozen-group end). */
  scheduler: Scheduler;
  /** Leader update limiter, keyed by group (AC22). */
  rateLimiter: SlidingWindowRateLimiter;
  /** Issues participant tokens (#5 AC5). */
  tokens: TokenService;
  /** Leader token refresh policy (#5 AC12); `maxMs` is also the recovery slack (Q10). */
  refresh: RefreshPolicy;
  /** Groups that ended in this process (Q8). */
  ended: EndedGroups;
  /** Signs and verifies QR tickets (#10). */
  qrTickets: QrTicketService;
  /** Signs and verifies codes blobs (#10). */
  codesBlobs: CodesBlobService;
  /** Join code draws; injected by tests (#10 AC9). */
  codeRandom?: RandomInt;
}

/**
 * MESSAGE_TOO_LARGE if `value` is over the app's limit, else undefined. A value
 * exactly at the limit is accepted (AC27).
 */
function sizeError(
  field: 'position' | 'metadata',
  value: unknown,
  limitBytes: number,
): ServerMessage | undefined {
  if (jsonByteLength(value) <= limitBytes) return undefined;
  return errorMessage(ErrorCode.MESSAGE_TOO_LARGE, { details: { field, limitBytes } });
}

function groupKey(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

const MINUTE_MS = 60_000;

/**
 * Group business rules. Never reads the fields of `position` or `metadata`:
 * they are stored and relayed as the parsed references (AC14).
 *
 * Participant IDs are group-scoped: a new one is minted for every create and
 * join. They appear in replies to their owner only, and never in logs (L7).
 *
 * Every state change of a group runs under its per-group lock, timer
 * callbacks included; those re-read the group, since a timer may be stale.
 */
export class GroupService implements GroupActions {
  /** Serializes join and teardown per group (namespace + ID). */
  private readonly locks = new KeyedLock();
  private readonly timers: GroupTimers;
  private readonly parking: ParkingLot;
  private readonly refresher: TokenRefresher;
  /** tokens.check limiter, keyed by connection (#5 AC16). */
  private readonly checkLimiter: SlidingWindowRateLimiter;
  /** tokens.check budget shared by all connections of an app, keyed by namespace (#7 L2). */
  private readonly appCheckLimiter: SlidingWindowRateLimiter;
  /** When the app-budget warning was last logged, per namespace (#7 L-2). */
  private readonly appBudgetWarnedAt = new Map<string, number>();
  /** Join codes and every join flow (#10). */
  private readonly joins: JoinService;

  constructor(private readonly deps: GroupServiceDeps) {
    this.joins = new JoinService(
      {
        store: deps.store,
        logger: deps.logger,
        scheduler: deps.scheduler,
        qrTickets: deps.qrTickets,
        codesBlobs: deps.codesBlobs,
        ...(deps.codeRandom === undefined ? {} : { random: deps.codeRandom }),
      },
      {
        busy: (session) => this.busy(session),
        runLocked: (namespace, groupId, task) => this.locks.run(groupKey(namespace, groupId), task),
        admit: (session, groupId, method) => this.admitMember(session, groupId, method),
      },
    );
    this.checkLimiter = new SlidingWindowRateLimiter(() => this.now(), TOKENS_CHECK_WINDOW_MS);
    this.appCheckLimiter = new SlidingWindowRateLimiter(() => this.now(), TOKENS_CHECK_WINDOW_MS);
    this.timers = new GroupTimers(deps.scheduler);
    this.parking = new ParkingLot(deps.scheduler);
    this.refresher = new TokenRefresher(deps.scheduler, deps.refresh);
  }

  /** Cancels every group and parking timer (server shutdown). */
  close(): void {
    this.timers.clearAll();
    this.parking.clearAll();
    this.refresher.clearAll();
    this.checkLimiter.clear();
    this.appCheckLimiter.clear();
    this.appBudgetWarnedAt.clear();
    this.joins.close();
  }

  /** Number of indexed join codes in every app. For tests only. */
  get codeCount(): number {
    return this.joins.index.size;
  }

  /**
   * Starts refresh counting for the group's online leader after a fresh
   * leader token was issued at `at` (create, return, recreation).
   */
  private startRefresh(namespace: string, groupId: string, at: number): void {
    this.refresher.reset(groupKey(namespace, groupId), at, () => {
      this.runTimer(namespace, groupId, () => this.sendRefreshedToken(namespace, groupId));
    });
  }

  /**
   * Sends the online leader a token with the group's current last-activity
   * time; all other claims stay the same (#5 AC12). Runs under the group lock.
   */
  private async sendRefreshedToken(namespace: string, groupId: string): Promise<void> {
    const record = await this.deps.store.get(namespace, groupId);
    if (!record || !record.leaderOnline) return;
    const leader = this.deps.notifier.get(membershipKey(namespace, groupId, record.leaderId));
    if (leader === undefined) return;
    const token = this.issueToken(namespace, record, record.leaderId, 'leader', this.now());
    leader.deliver(
      JSON.stringify({ type: 'token.refreshed', groupId, token } satisfies ServerMessage),
    );
    this.deps.logger.debug(
      { event: 'token_refreshed', namespace, groupRef: groupRef(groupId) },
      'leader token refreshed',
    );
  }

  /** Number of parked sessions. For tests only. */
  get parkedCount(): number {
    return this.parking.size;
  }

  /** In a group or waiting for one (ALREADY_IN_GROUP). */
  private busy(session: Session): boolean {
    return session.membership !== undefined || session.parked !== undefined;
  }

  /** Number of groups with a pending timer. For tests only. */
  get timerCount(): number {
    return this.timers.size;
  }

  private now(): number {
    return this.deps.scheduler.now();
  }

  /** The session's membership if the session still owns it in the notifier (M4). */
  private owned(session: Session): Membership | undefined {
    const membership = session.membership;
    if (membership === undefined) return undefined;
    const key = membershipKey(session.app.namespace, membership.groupId, membership.participantId);
    return this.deps.notifier.get(key) === session ? membership : undefined;
  }

  private attach(session: Session, membership: Membership): void {
    session.membership = membership;
    this.deps.notifier.register(
      membershipKey(session.app.namespace, membership.groupId, membership.participantId),
      session,
    );
  }

  private issueToken(
    namespace: string,
    record: GroupRecord,
    participantId: string,
    role: Role,
    now: number,
  ): string {
    return this.deps.tokens.issue({
      namespace,
      groupId: record.id,
      participantId,
      role,
      groupCreatedAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      now,
    });
  }

  /** When a frozen group ends: the recovery window after the leader's last activity. */
  private frozenEndAt(app: AppConfig, record: GroupRecord): number {
    return record.lastActivityAt + app.inactivityLimitMinutes * MINUTE_MS + this.deps.refresh.maxMs;
  }

  private maxSessionEndAt(app: AppConfig, record: GroupRecord): number {
    return record.createdAt + app.maxSessionMinutes * MINUTE_MS;
  }

  /**
   * Arms the max-session timer (#5 AC21, Q2): the group ends with
   * `max_session` at `createdAt + maxSessionMinutes`, leader online or not.
   */
  private armMaxSession(app: AppConfig, record: GroupRecord): void {
    const namespace = app.namespace;
    const groupId = record.id;
    this.timers.armMaxSession(
      groupKey(namespace, groupId),
      this.maxSessionEndAt(app, record),
      () => {
        this.runTimer(namespace, groupId, async () => {
          const current = await this.deps.store.get(namespace, groupId);
          if (!current) return;
          // Re-checked against the clock under the lock (R3).
          if (this.maxSessionEndAt(app, current) > this.now()) {
            this.armMaxSession(app, current);
            return;
          }
          await this.endGroup(app, groupId, 'max_session');
        });
      },
    );
  }

  /** Runs a timer callback under the group lock; failures are logged, never thrown. */
  private runTimer(namespace: string, groupId: string, task: () => Promise<void>): void {
    this.locks.run(groupKey(namespace, groupId), task).catch((err: unknown) => {
      this.deps.logger.error({ event: 'timer_error', err: safeErr(err) }, 'group timer failed');
    });
  }

  async create(session: Session, message: GroupCreateMessage): Promise<ServerMessage> {
    if (this.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);

    const { app } = session;
    // Checked before anything is stored: an oversized create leaves no group.
    const tooLarge =
      sizeError('metadata', message.metadata, app.maxMessageBytes) ??
      (message.position === undefined
        ? undefined
        : sizeError('position', message.position, app.maxMessageBytes));
    if (tooLarge) return tooLarge;

    // Methods and codes before anything is stored: a bad method set or no
    // free code leaves no group (#10 AC5, AC9).
    const groupId = newGroupId();
    const initial = this.joins.initialCodes(app, groupId, message.joinMethods);
    if (!initial.ok) return initial.error;

    const participantId = newParticipantId();
    const now = this.now();
    const record: GroupRecord = {
      id: groupId,
      appNamespace: app.namespace,
      metadata: message.metadata,
      position:
        message.position === undefined ? { has: false } : { has: true, payload: message.position },
      leaderId: participantId,
      participantIds: [participantId],
      createdAt: now,
      lastActivityAt: now,
      leaderOnline: true,
      blockList: [],
      joinMethods: initial.methods,
      codes: initial.codes,
    };
    try {
      await this.deps.store.create(record);
    } catch (err) {
      this.joins.releaseCodes(app.namespace, groupId, initial.codes);
      throw err;
    }
    this.armMaxSession(app, record);
    this.startRefresh(app.namespace, record.id, now);
    this.attach(session, { groupId: record.id, participantId, role: 'leader' });
    this.deps.logger.info(
      { event: 'group_created', namespace: app.namespace, groupRef: groupRef(record.id) },
      'group created',
    );
    const token = this.issueToken(app.namespace, record, participantId, 'leader', now);
    // Codes go to the leader's connection only (#10 AC10, R13).
    return {
      type: 'group.created',
      groupId: record.id,
      participantId,
      role: 'leader',
      token,
      joinMethods: [...record.joinMethods],
      codes: this.joins.payload(record),
    };
  }

  async join(session: Session, message: GroupJoinMessage): Promise<ServerMessage> {
    if (this.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);

    const { app } = session;
    const { groupId } = message;
    // A malformed ID gets the same answer as an unknown one: no oracle (L3).
    if (!GROUP_ID_PATTERN.test(groupId)) return errorMessage(ErrorCode.GROUP_NOT_FOUND);

    // Serialized with the group's teardown: the insert and the session
    // commit happen together, either fully before the group ends (so the
    // teardown sees and notifies this member) or after it (not found).
    // Without this, a slow insert reply could commit the session to a
    // group that was already deleted.
    return this.locks.run(groupKey(app.namespace, groupId), async () => {
      const participantId = newParticipantId();
      const added = await this.deps.store.addParticipant(
        app.namespace,
        groupId,
        participantId,
        app.maxGroupSize,
      );
      if (added.status === 'not_found') return errorMessage(ErrorCode.GROUP_NOT_FOUND);
      // A freshly minted ID is never blocked; checked for completeness.
      if (added.status === 'blocked') return errorMessage(ErrorCode.PARTICIPANT_BLOCKED);
      // The leader counts toward the size (AC21).
      if (added.status === 'full') {
        return errorMessage(ErrorCode.GROUP_FULL, { details: { maxGroupSize: app.maxGroupSize } });
      }
      // The snapshot comes from the same atomic insert. A second read could
      // fail after the insert and leave the participant in the group while
      // the session stays groupless.
      return this.commitJoin(session, participantId, added.group);
    });
  }

  /** group.joinByCode (#10): the join rules live in JoinService. */
  joinByCode(session: Session, message: GroupJoinByCodeMessage): Promise<ServerMessage> {
    return this.joins.joinByCode(session, message);
  }

  /**
   * Admits a new member found by code or ticket (#10 AC14): a fresh
   * group-scoped participant ID, the size limit, then group.joined with a
   * member token, exactly as a join by ID did. Runs under the group lock.
   */
  private async admitMember(
    session: Session,
    groupId: string,
    method: JoinMethod,
  ): Promise<ServerMessage> {
    const { app } = session;
    const participantId = newParticipantId();
    const added = await this.deps.store.addParticipant(
      app.namespace,
      groupId,
      participantId,
      app.maxGroupSize,
    );
    if (added.status === 'not_found') return errorMessage(ErrorCode.CODE_NOT_FOUND);
    if (added.status === 'blocked') return errorMessage(ErrorCode.PARTICIPANT_BLOCKED);
    if (added.status === 'full') {
      return errorMessage(ErrorCode.GROUP_FULL, { details: { maxGroupSize: app.maxGroupSize } });
    }
    return this.commitJoin(session, participantId, added.group, method);
  }

  private commitJoin(
    session: Session,
    participantId: string,
    record: GroupRecord,
    method?: JoinMethod,
  ): ServerMessage {
    const { app } = session;
    this.attach(session, { groupId: record.id, participantId, role: 'member' });
    this.deps.logger.info(
      {
        event: 'group_joined',
        namespace: app.namespace,
        groupRef: groupRef(record.id),
        // The connection-scoped ref only: never the group-scoped ID (L7).
        participantRef: participantRef(session.connectionId),
        ...(method === undefined ? {} : { method }),
      },
      'group joined',
    );
    return this.joinedMessage(
      record,
      participantId,
      this.issueToken(app.namespace, record, participantId, 'member', this.now()),
    );
  }

  private joinedMessage(record: GroupRecord, participantId: string, token: string): ServerMessage {
    const base = {
      type: 'group.joined' as const,
      groupId: record.id,
      participantId,
      role: 'member' as const,
      metadata: record.metadata,
      token,
      leaderOnline: record.leaderOnline,
    };
    return record.position.has
      ? { ...base, hasPosition: true, position: record.position.payload }
      : { ...base, hasPosition: false };
  }

  async update(session: Session, message: PositionUpdateMessage): Promise<ServerMessage> {
    // Authorized by ownership, not by the cached role alone (M4).
    const membership = this.owned(session);
    if (membership === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
    if (membership.role !== 'leader') {
      return actionErrorMessage(ErrorCode.NOT_LEADER, 'position.update');
    }

    const { app } = session;
    const namespace = app.namespace;
    const { groupId } = membership;
    const tooLarge = sizeError('position', message.position, app.maxMessageBytes);
    if (tooLarge) return tooLarge;

    // Checked last, so rejected updates never use rate budget. Over-rate
    // updates are rejected, never queued or coalesced (AC22).
    const rate = this.deps.rateLimiter.tryAcquire(
      groupKey(namespace, groupId),
      app.maxLeaderUpdatesPerSecond,
    );
    if (!rate.ok) {
      return actionErrorMessage(ErrorCode.RATE_LIMITED, 'position.update', {
        details: {
          maxLeaderUpdatesPerSecond: app.maxLeaderUpdatesPerSecond,
          retryAfterMs: rate.retryAfterMs,
        },
      });
    }

    // An accepted update is a leader activity (#5 AC12).
    const at = this.now();
    const stored = await this.deps.store.setPosition(namespace, groupId, message.position, at);
    if (!stored) return errorMessage(ErrorCode.NOT_IN_GROUP);
    this.refresher.activity(groupKey(namespace, groupId), at);

    const record = await this.deps.store.get(namespace, groupId);
    if (record) {
      // Members only: the leader gets position.ack, not the broadcast (AC13).
      this.deps.notifier.broadcast(this.memberKeys(record), {
        type: 'position.updated',
        groupId,
        position: message.position,
      });
    }
    this.deps.logger.debug(
      { event: 'position_updated', namespace, groupRef: groupRef(groupId) },
      'position updated',
    );
    return { type: 'position.ack' };
  }

  /**
   * One warning per window per app when its shared tokens.check budget is
   * used up, so operators can see it (#7 L-2). Namespace only: never a
   * token, participant ID or connection ID.
   */
  private warnAppCheckBudget(namespace: string): void {
    const now = this.now();
    const last = this.appBudgetWarnedAt.get(namespace);
    if (last !== undefined && now - last < TOKENS_CHECK_WINDOW_MS) return;
    this.appBudgetWarnedAt.set(namespace, now);
    this.deps.logger.warn(
      { event: 'tokens_check_app_budget_exhausted', namespace },
      'tokens.check budget for the app is used up',
    );
  }

  private memberKeys(record: GroupRecord): string[] {
    return record.participantIds
      .filter((id) => id !== record.leaderId)
      .map((id) => membershipKey(record.appNamespace, record.id, id));
  }

  /**
   * tokens.check (#5 AC14-AC16). Limited per connection first, then by the
   * app's shared budget (#7 L2). The per-connection check comes first so a
   * connection over its own limit never spends the shared budget. Both run
   * before any verification or store access (#7 AC5). Each token is
   * verified, and only a verified token leads to a group lookup, so invalid
   * tokens never touch group state (AC15). Results carry only a status, plus
   * a re-signed token for usable previous-secret tokens (AC2).
   */
  async checkTokens(session: Session, message: TokensCheckMessage): Promise<ServerMessage> {
    const rate = this.checkLimiter.tryAcquire(session.connectionId, TOKENS_CHECK_PER_MINUTE);
    if (!rate.ok) {
      return actionErrorMessage(ErrorCode.RATE_LIMITED, 'tokens.check', {
        details: { retryAfterMs: rate.retryAfterMs },
      });
    }
    const { app } = session;
    const appRate = this.appCheckLimiter.tryAcquire(app.namespace, TOKENS_CHECK_PER_APP_PER_MINUTE);
    if (!appRate.ok) {
      this.warnAppCheckBudget(app.namespace);
      return actionErrorMessage(ErrorCode.RATE_LIMITED, 'tokens.check', {
        details: { retryAfterMs: appRate.retryAfterMs },
      });
    }
    const results: TokensResultMessage['results'] = [];
    for (const token of message.tokens) {
      const now = this.now();
      const verified = this.deps.tokens.verify(token, app.namespace, now);
      if (!verified.ok) {
        results.push({ status: 'invalid' });
        continue;
      }
      const { claims } = verified;
      const status = classifyToken({
        claims,
        app,
        record: await this.deps.store.get(app.namespace, claims.gid),
        ended: this.deps.ended.has(app.namespace, claims.gid),
        now,
        refreshMaxMs: this.deps.refresh.maxMs,
      });
      const usable = status === 'live' || status === 'recoverable' || status === 'waiting';
      results.push(
        verified.viaPrevious && usable
          ? { status, token: this.deps.tokens.resign(claims, app.namespace) }
          : { status },
      );
    }
    this.deps.logger.debug(
      { event: 'tokens_checked', namespace: app.namespace, count: results.length },
      'tokens checked',
    );
    return { type: 'tokens.result', results };
  }

  /**
   * blocklist.set (#5 AC26, AC34): the leader replaces the block list.
   * Listed members still attached are removed with group.ended `removed`;
   * later resumes with those IDs get PARTICIPANT_BLOCKED. The list is kept
   * in memory only and never logged (a count at most).
   */
  async setBlockList(session: Session, message: BlockListSetMessage): Promise<ServerMessage> {
    if (session.parked !== undefined) {
      return actionErrorMessage(ErrorCode.NOT_LEADER, 'blocklist.set');
    }
    const membership = this.owned(session);
    if (membership === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
    if (membership.role !== 'leader') {
      return actionErrorMessage(ErrorCode.NOT_LEADER, 'blocklist.set');
    }
    const { app } = session;
    const { groupId } = membership;
    return this.locks.run(groupKey(app.namespace, groupId), async () => {
      if (this.owned(session) !== membership) return errorMessage(ErrorCode.NOT_IN_GROUP);
      const record = await this.deps.store.get(app.namespace, groupId);
      if (!record) return errorMessage(ErrorCode.NOT_IN_GROUP);
      await this.applyBlockList(app, record, message.blockList);
      return { type: 'blocklist.ack' };
    });
  }

  /**
   * Stores a deduplicated block list (without the leader's own ID) and
   * removes listed members that are attached. Runs under the group lock.
   */
  private async applyBlockList(
    app: AppConfig,
    record: GroupRecord,
    list: readonly string[],
  ): Promise<void> {
    const namespace = app.namespace;
    const blockList = [...new Set(list)].filter((id) => id !== record.leaderId);
    const result = await this.deps.store.setBlockList(namespace, record.id, blockList);
    if (!result) return;
    const text = JSON.stringify({
      type: 'group.ended',
      groupId: record.id,
      reason: 'removed',
    } satisfies ServerMessage);
    for (const participantId of result.removed) {
      const key = membershipKey(namespace, record.id, participantId);
      const member = this.deps.notifier.get(key);
      if (member === undefined) continue;
      this.deps.notifier.unregister(key, member);
      if (member.membership?.groupId === record.id) member.membership = undefined;
      member.afterPending(() => member.deliver(text));
    }
    this.deps.logger.info(
      {
        event: 'block_list_set',
        namespace,
        groupRef: groupRef(record.id),
        blocked: blockList.length,
        removed: result.removed.length,
      },
      'block list set',
    );
  }

  /**
   * group.end (#5 AC29): the leader ends the group. Members get group.ended
   * `ended_by_leader`; the leader gets the same message as its reply.
   */
  async end(session: Session, _message: GroupEndMessage): Promise<ServerMessage> {
    // A parked session is a member waiting for its leader.
    if (session.parked !== undefined) {
      return actionErrorMessage(ErrorCode.NOT_LEADER, 'group.end');
    }
    const membership = this.owned(session);
    if (membership === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
    if (membership.role !== 'leader') {
      return actionErrorMessage(ErrorCode.NOT_LEADER, 'group.end');
    }
    const { app } = session;
    const { groupId } = membership;
    return this.locks.run(groupKey(app.namespace, groupId), async () => {
      // Replaced while waiting for the lock (M4).
      if (this.owned(session) !== membership) return errorMessage(ErrorCode.NOT_IN_GROUP);
      await this.endGroup(app, groupId, 'ended_by_leader', session);
      return { type: 'group.ended', groupId, reason: 'ended_by_leader' };
    });
  }

  /**
   * group.leave (#5 AC30): a member leaves; the leader is not affected and the
   * member is not blocked. The leader must use group.end (Q-D).
   */
  async leave(session: Session, _message: GroupLeaveMessage): Promise<ServerMessage> {
    const parked = session.parked;
    if (parked !== undefined) {
      this.parking.unpark(session);
      return { type: 'group.left', groupId: parked.groupId };
    }
    const membership = this.owned(session);
    if (membership === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
    if (membership.role === 'leader') return errorMessage(ErrorCode.LEADER_CANNOT_LEAVE);
    const { app } = session;
    const { groupId, participantId } = membership;
    return this.locks.run(groupKey(app.namespace, groupId), async () => {
      if (this.owned(session) !== membership) return errorMessage(ErrorCode.NOT_IN_GROUP);
      this.deps.notifier.unregister(membershipKey(app.namespace, groupId, participantId), session);
      session.membership = undefined;
      const result = await this.deps.store.removeParticipant(app.namespace, groupId, participantId);
      if (result && result.connected === 0) await this.dropGroup(app.namespace, groupId);
      this.deps.logger.info(
        { event: 'group_left', namespace: app.namespace, groupRef: groupRef(groupId) },
        'group left',
      );
      return { type: 'group.left', groupId };
    });
  }

  /**
   * group.resume (#5 AC17, AC19, AC20): rejoin with a participant token. The
   * token is verified before anything else touches group state; every
   * verification failure gets the same TOKEN_INVALID (AC8, AC15). The rest
   * runs under the group lock, so concurrent resumes with one token
   * serialize (AC27).
   */
  async resume(session: Session, message: GroupResumeMessage): Promise<ServerMessage> {
    if (this.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);
    const { app } = session;
    const verified = this.deps.tokens.verify(message.token, app.namespace, this.now());
    if (!verified.ok) return errorMessage(ErrorCode.TOKEN_INVALID);
    const { claims } = verified;

    // Size-checked like group.create, whether or not they end up used.
    const tooLarge =
      (message.metadata === undefined
        ? undefined
        : sizeError('metadata', message.metadata, app.maxMessageBytes)) ??
      (message.position === undefined
        ? undefined
        : sizeError('position', message.position, app.maxMessageBytes));
    if (tooLarge) return tooLarge;

    return this.locks.run(groupKey(app.namespace, claims.gid), async () => {
      if (this.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);
      const record = await this.deps.store.get(app.namespace, claims.gid);
      const status = classifyToken({
        claims,
        app,
        record,
        ended: this.deps.ended.has(app.namespace, claims.gid),
        now: this.now(),
        refreshMaxMs: this.deps.refresh.maxMs,
      });
      switch (status) {
        case 'invalid':
          return errorMessage(ErrorCode.TOKEN_INVALID);
        case 'expired':
          return errorMessage(ErrorCode.TOKEN_EXPIRED);
        case 'ended':
          return errorMessage(ErrorCode.GROUP_ENDED);
        case 'blocked':
          return errorMessage(ErrorCode.PARTICIPANT_BLOCKED);
        case 'live':
          return claims.role === 'leader'
            ? this.leaderReturn(session, record!, claims, message.blockList)
            : this.memberResume(session, record!, claims);
        case 'recoverable':
          return this.recreate(session, claims, message);
        case 'waiting':
          return this.parkMember(session, claims);
      }
    });
  }

  /**
   * Detaches an older session that holds the same membership (AC20): it
   * loses the membership at once (M4) and is told `replaced` after its
   * pending replies. The group goes on for everyone else.
   */
  private replaceOwner(
    namespace: string,
    groupId: string,
    participantId: string,
    by: Session,
  ): void {
    const key = membershipKey(namespace, groupId, participantId);
    const older = this.deps.notifier.get(key);
    if (older === undefined || older === by) return;
    this.deps.notifier.unregister(key, older);
    if (older.membership?.groupId === groupId) older.membership = undefined;
    const text = JSON.stringify({
      type: 'group.ended',
      groupId,
      reason: 'replaced',
    } satisfies ServerMessage);
    older.afterPending(() => older.deliver(text));
    this.deps.logger.info(
      { event: 'session_replaced', namespace, groupRef: groupRef(groupId) },
      'session replaced',
    );
  }

  /**
   * The leader comes back to a live or frozen group (AC19). The server's
   * metadata and position win over anything the client sends (Q14). Runs
   * under the group lock.
   */
  private async leaderReturn(
    session: Session,
    record: GroupRecord,
    claims: TokenClaims,
    blockList?: readonly string[],
  ): Promise<ServerMessage> {
    const { app } = session;
    const namespace = app.namespace;
    const now = this.now();
    this.replaceOwner(namespace, record.id, claims.pid, session);
    // Only an explicit list replaces the server's; an omitted one keeps it (L5).
    if (blockList !== undefined) await this.applyBlockList(app, record, blockList);
    const updated = await this.deps.store.setLeaderOnline(namespace, record.id, true, now);
    if (!updated) return errorMessage(ErrorCode.GROUP_NOT_FOUND);
    this.timers.clearFrozenEnd(groupKey(namespace, record.id));
    this.startRefresh(namespace, record.id, now);
    if (!record.leaderOnline) {
      this.deps.notifier.broadcast(this.memberKeys(updated), {
        type: 'leader.online',
        groupId: record.id,
      });
    }
    this.attach(session, { groupId: record.id, participantId: claims.pid, role: 'leader' });
    this.deps.logger.info(
      { event: 'group_resumed', namespace, groupRef: groupRef(record.id), recreated: false },
      'leader resumed',
    );
    return this.resumedMessage(updated, claims.pid, false, now);
  }

  /**
   * Rebuilds a group that is not in memory from the leader's token and the
   * recovery data its client sends (AC23, AC24, AC28): same group ID, the
   * token's creation time (so a group never outlives its max session) and the
   * leader's participant ID. Runs under the group lock.
   */
  private async recreate(
    session: Session,
    claims: TokenClaims,
    message: GroupResumeMessage,
  ): Promise<ServerMessage> {
    if (message.metadata === undefined) return errorMessage(ErrorCode.INVALID_MESSAGE);
    const { app } = session;
    const namespace = app.namespace;
    const now = this.now();
    // Until codes survive restarts, a recreated group gets a full new set
    // with the app's default group methods.
    const initial = this.joins.initialCodes(app, claims.gid);
    if (!initial.ok) return initial.error;
    const record: GroupRecord = {
      id: claims.gid,
      appNamespace: namespace,
      metadata: message.metadata,
      position:
        message.position === undefined ? { has: false } : { has: true, payload: message.position },
      leaderId: claims.pid,
      participantIds: [claims.pid],
      createdAt: claims.gct,
      lastActivityAt: now,
      leaderOnline: true,
      // Deduplicated; the leader's own ID is ignored.
      blockList: [...new Set(message.blockList ?? [])].filter((id) => id !== claims.pid),
      joinMethods: initial.methods,
      codes: initial.codes,
    };
    if ((await this.deps.store.createIfAbsent(record)) === 'exists') {
      this.joins.releaseCodes(namespace, claims.gid, initial.codes);
      // Impossible under the in-process lock; with a shared store, the group
      // someone else just recreated is resumed instead.
      const existing = await this.deps.store.get(namespace, claims.gid);
      if (!existing) return errorMessage(ErrorCode.GROUP_NOT_FOUND);
      return this.leaderReturn(session, existing, claims, message.blockList);
    }
    this.armMaxSession(app, record);
    this.startRefresh(namespace, record.id, now);
    this.attach(session, { groupId: record.id, participantId: claims.pid, role: 'leader' });
    await this.admitParked(app, record);
    this.deps.logger.info(
      {
        event: 'group_resumed',
        namespace,
        groupRef: groupRef(record.id),
        recreated: true,
        blocked: record.blockList.length,
      },
      'group recreated',
    );
    return this.resumedMessage(record, claims.pid, true, now);
  }

  /**
   * A member resumed a group that is not in memory (AC25): the connection is
   * parked until the leader recreates the group, or until no leader token
   * able to recreate it can exist any more. Runs under the group lock.
   */
  private parkMember(session: Session, claims: TokenClaims): ServerMessage {
    const { app } = session;
    const namespace = app.namespace;
    const now = this.now();
    const sessionEnd = claims.gct + app.maxSessionMinutes * MINUTE_MS;
    // A recreating leader token has lat <= now, so after this no such token
    // is usable any more (architecture 6.5).
    const leaderWindowEnd = now + app.inactivityLimitMinutes * MINUTE_MS + this.deps.refresh.maxMs;
    const until = Math.min(sessionEnd, leaderWindowEnd);
    const reason: GroupEndedReason =
      sessionEnd <= leaderWindowEnd ? 'max_session' : 'leader_timeout';
    const key = groupKey(namespace, claims.gid);
    const older = this.parking.park(session, key, claims.gid, claims.pid, until, () => {
      this.runTimer(namespace, claims.gid, () => {
        if (session.parked?.groupKey === key && this.parking.unpark(session)) {
          const text = JSON.stringify({
            type: 'group.ended',
            groupId: claims.gid,
            reason,
          } satisfies ServerMessage);
          session.afterPending(() => session.deliver(text));
        }
        return Promise.resolve();
      });
    });
    if (older !== undefined) {
      // One parked session per participant: newest wins (M5).
      const text = JSON.stringify({
        type: 'group.ended',
        groupId: claims.gid,
        reason: 'replaced',
      } satisfies ServerMessage);
      older.afterPending(() => older.deliver(text));
    }
    this.deps.logger.info(
      {
        event: 'group_waiting',
        namespace,
        groupRef: groupRef(claims.gid),
        participantRef: participantRef(session.connectionId),
      },
      'member waiting for leader',
    );
    return { type: 'group.waiting', groupId: claims.gid };
  }

  /**
   * After a recreation, admits every parked member in arrival order (AC25,
   * AC26): blocked ones get PARTICIPANT_BLOCKED, those over the size limit
   * GROUP_FULL, the rest an unsolicited group.joined with a fresh token.
   * Runs under the group lock.
   */
  private async admitParked(app: AppConfig, record: GroupRecord): Promise<void> {
    const namespace = app.namespace;
    for (const { session: member, participantId } of this.parking.drain(
      groupKey(namespace, record.id),
    )) {
      if (record.blockList.includes(participantId)) {
        this.deliverLater(member, errorMessage(ErrorCode.PARTICIPANT_BLOCKED));
        continue;
      }
      const added = await this.deps.store.addParticipant(
        namespace,
        record.id,
        participantId,
        app.maxGroupSize,
      );
      if (added.status !== 'ok') {
        this.deliverLater(
          member,
          added.status === 'blocked'
            ? errorMessage(ErrorCode.PARTICIPANT_BLOCKED)
            : errorMessage(ErrorCode.GROUP_FULL, { details: { maxGroupSize: app.maxGroupSize } }),
        );
        continue;
      }
      this.attach(member, { groupId: record.id, participantId, role: 'member' });
      const token = this.issueToken(namespace, added.group, participantId, 'member', this.now());
      this.deliverLater(member, this.joinedMessage(added.group, participantId, token));
    }
  }

  private deliverLater(session: Session, message: ServerMessage): void {
    const text = JSON.stringify(message);
    session.afterPending(() => session.deliver(text));
  }

  private resumedMessage(
    record: GroupRecord,
    participantId: string,
    recreated: boolean,
    now: number,
  ): ServerMessage {
    const base = {
      type: 'group.resumed' as const,
      groupId: record.id,
      participantId,
      role: 'leader' as const,
      metadata: record.metadata,
      token: this.issueToken(record.appNamespace, record, participantId, 'leader', now),
      recreated,
    };
    return record.position.has
      ? { ...base, hasPosition: true, position: record.position.payload }
      : { ...base, hasPosition: false };
  }

  /** A member rejoins a live or frozen group with its token's participant ID (AC17). */
  private async memberResume(
    session: Session,
    record: GroupRecord,
    claims: TokenClaims,
  ): Promise<ServerMessage> {
    const { app } = session;
    const namespace = app.namespace;
    // Newest wins (AC20). The store is idempotent per participant ID, so the
    // replaced session's slot is reused, not doubled.
    this.replaceOwner(namespace, record.id, claims.pid, session);
    const added = await this.deps.store.addParticipant(
      namespace,
      record.id,
      claims.pid,
      app.maxGroupSize,
    );
    if (added.status === 'not_found') return errorMessage(ErrorCode.GROUP_NOT_FOUND);
    if (added.status === 'blocked') return errorMessage(ErrorCode.PARTICIPANT_BLOCKED);
    if (added.status === 'full') {
      return errorMessage(ErrorCode.GROUP_FULL, { details: { maxGroupSize: app.maxGroupSize } });
    }
    this.attach(session, { groupId: record.id, participantId: claims.pid, role: 'member' });
    this.deps.logger.info(
      {
        event: 'group_resumed',
        namespace,
        groupRef: groupRef(record.id),
        participantRef: participantRef(session.connectionId),
        recreated: false,
      },
      'member resumed',
    );
    const token = this.issueToken(app.namespace, added.group, claims.pid, 'member', this.now());
    return this.joinedMessage(added.group, claims.pid, token);
  }

  async disconnect(session: Session): Promise<void> {
    this.checkLimiter.forget(session.connectionId);
    // A parked session just stops waiting.
    this.parking.unpark(session);
    const membership = session.membership;
    if (membership === undefined) return;
    const { app } = session;
    const namespace = app.namespace;
    const { groupId, participantId } = membership;
    session.membership = undefined;
    // A session that no longer owns its membership changes nothing (M4).
    if (!this.deps.notifier.unregister(membershipKey(namespace, groupId, participantId), session)) {
      return;
    }

    // Under the group lock, so a join cannot land between the removal and
    // the delete.
    await this.locks.run(groupKey(namespace, groupId), async () => {
      if (membership.role === 'leader') {
        await this.leaderOffline(app, groupId);
        return;
      }
      const result = await this.deps.store.removeParticipant(namespace, groupId, participantId);
      if (result && result.connected === 0) await this.dropGroup(namespace, groupId);
    });
  }

  /**
   * The leader's connection closed (#5 AC18, replaces #1 AC17): the group is
   * not ended. With no member left it is dropped from memory; otherwise it is
   * frozen, members get leader.offline, and it ends when the recovery window
   * after the leader's last activity lapses (AC21). Runs under the group lock.
   */
  private async leaderOffline(app: AppConfig, groupId: string): Promise<void> {
    const namespace = app.namespace;
    const record = await this.deps.store.setLeaderOnline(namespace, groupId, false);
    this.refresher.clear(groupKey(namespace, groupId));
    if (!record) return;
    if (connectedCount(record) === 0) {
      await this.dropGroup(namespace, groupId);
      return;
    }
    this.deps.notifier.broadcast(this.memberKeys(record), { type: 'leader.offline', groupId });
    this.deps.logger.info(
      { event: 'group_frozen', namespace, groupRef: groupRef(groupId) },
      'leader offline',
    );
    await this.scheduleFrozenEnd(app, record);
  }

  /**
   * Arms the frozen-end timer, or ends the group now if its time has passed.
   * Runs under the group lock.
   */
  private async scheduleFrozenEnd(app: AppConfig, record: GroupRecord): Promise<void> {
    const at = this.frozenEndAt(app, record);
    const groupId = record.id;
    const namespace = app.namespace;
    if (this.maxSessionEndAt(app, record) <= this.now()) {
      await this.endGroup(app, groupId, 'max_session');
      return;
    }
    if (at <= this.now()) {
      await this.endGroup(app, groupId, 'leader_timeout');
      return;
    }
    // Max session comes first: its own timer ends the group.
    if (this.maxSessionEndAt(app, record) <= at) return;
    this.timers.armFrozenEnd(groupKey(namespace, groupId), at, () => {
      this.runTimer(namespace, groupId, async () => {
        const current = await this.deps.store.get(namespace, groupId);
        // Stale timer: the group is gone or the leader came back.
        if (!current || current.leaderOnline) return;
        await this.scheduleFrozenEnd(app, current);
      });
    });
  }

  /**
   * Removes a group nobody is connected to from memory (#5 AC22). This is not
   * an end: its tokens stay usable until their own limits pass.
   */
  private async dropGroup(namespace: string, groupId: string): Promise<void> {
    const record = await this.deps.store.get(namespace, groupId);
    await this.deps.store.delete(namespace, groupId);
    this.forgetGroup(namespace, groupId, record);
    this.deps.logger.info(
      { event: 'group_dropped', namespace, groupRef: groupRef(groupId) },
      'group dropped',
    );
  }

  /** Clears every per-group structure; frees the group's join codes (#10 AC11). */
  private forgetGroup(namespace: string, groupId: string, record: GroupRecord | undefined): void {
    const key = groupKey(namespace, groupId);
    this.deps.rateLimiter.forget(key);
    this.timers.clear(key);
    this.refresher.clear(key);
    this.joins.onGroupGone(namespace, groupId, record);
  }

  /**
   * Ends a group: it is deleted and every attached participant gets
   * group.ended with `reason`. Must run under the group lock.
   *
   * Each participant loses its membership at once (M4) and is notified
   * through its own message queue, after the replies to messages it has
   * already sent. A member whose join was in flight therefore gets
   * group.joined first, then group.ended.
   */
  private async endGroup(
    app: AppConfig,
    groupId: string,
    reason: GroupEndedReason,
    requester?: Session,
  ): Promise<void> {
    const namespace = app.namespace;
    const record = await this.deps.store.get(namespace, groupId);
    await this.deps.store.delete(namespace, groupId);
    this.forgetGroup(namespace, groupId, record);
    // Remembered until its max-session deadline, as a hashed ref only (Q8).
    if (record) this.deps.ended.remember(namespace, groupId, this.maxSessionEndAt(app, record));
    const keys = (record?.participantIds ?? []).map((id) => membershipKey(namespace, groupId, id));
    const ended = JSON.stringify({ type: 'group.ended', groupId, reason } satisfies ServerMessage);
    let notified = 0;
    for (const key of keys) {
      const participant = this.deps.notifier.get(key);
      if (participant === undefined) continue;
      notified += 1;
      this.deps.notifier.unregister(key, participant);
      if (participant.membership?.groupId === groupId) participant.membership = undefined;
      // The requester gets group.ended as its direct reply instead.
      if (participant !== requester) participant.afterPending(() => participant.deliver(ended));
    }
    this.deps.logger.info(
      {
        event: 'group_ended',
        namespace,
        groupRef: groupRef(groupId),
        endReason: reason,
        members: notified,
      },
      'group ended',
    );
  }
}
