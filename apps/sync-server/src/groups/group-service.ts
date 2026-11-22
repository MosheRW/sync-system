import {
  type BlockListSetMessage,
  type CodesRotateMessage,
  type JoinApproveMessage,
  type JoinCancelMessage,
  type JoinDenyMessage,
  type GroupJoinByQrMessage,
  type QrIssueMessage,
  ErrorCode,
  type ErrorMessage,
  type GroupCreateMessage,
  type GroupEndMessage,
  type GroupEndedReason,
  type GroupJoinByCodeMessage,
  type JoinMethod,
  type GroupLeaveMessage,
  type GroupResumeMessage,
  type PositionUpdateMessage,
  type ServerMessage,
  type TokenClaims,
  type TokenRole,
  type TokensCheckMessage,
  type TokensResultMessage,
  type MemberRemoveMessage,
  type KeepAliveAckMessage,
  type LeaderActivityMessage,
  type LeaderTakeBackMessage,
  CloseCode,
  MAX_BLOCK_LIST_SIZE,
  type ViceClearMessage,
  type ViceSetMessage,
  type GroupLockMessage,
  type GroupUnlockMessage,
  type LeaderState,
  PARTICIPANT_ID_PATTERN,
  resolveDisplayName,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import { jsonByteLength } from '../limits/json-size.js';
import {
  END_TTL_SLACK_MS,
  GROUP_CREATE_WINDOW_MS,
  type GroupCreateLimits,
  MAX_CLOCK_SKEW_MS,
  RECREATIONS_PER_CONNECTION_PER_MINUTE,
  RECREATION_WINDOW_MS,
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
import { GROUP_LOCKED, JoinService } from '../joins/join-service.js';
import { resolveGroupMethods } from '../joins/join-methods.js';
import {
  type LeaderAction,
  authorizeLeader,
  isGuardError,
  isParticipantConnected,
} from '../lifecycle/leader-guard.js';
import { actionErrorMessage, errorMessage } from '../ws/error-messages.js';
import {
  type NameChoice,
  type RosterState,
  admit as admitToRoster,
  evictOverflow,
  find as findEntry,
  remove as removeFromRoster,
  setConnected,
  toWire,
} from '../lifecycle/roster.js';
import { LeaderControls } from '../lifecycle/leader-controls.js';
import { LifecycleService, pauseOnWire } from '../lifecycle/lifecycle-service.js';
import {
  type GroupPause,
  type GroupRecord,
  type GroupStore,
  connectedCount,
  pauseDeadline,
} from './group-store.js';
import type { EndedGroupsStore } from './ended-groups.js';
import type { CodeIndexStore } from '../joins/code-index.js';
import type { DoorStateStore } from '../joins/door-guard.js';
import {
  GroupTimers,
  MemoryTimerBackend,
  type TimerBackend,
  type TimerData,
  type TimerKind,
} from './group-timers.js';
import { newAttachId, newGroupId, newParticipantId } from './ids.js';
import { GroupLock, type LeaseSource, type UnitOfWorkSource } from './group-lock.js';
import {
  LeaseLostError,
  StorageBusyError,
  StorageConflictError,
  StorageUnavailableError,
} from '../storage/errors.js';
import type { EpochSource } from '../storage/redis/epoch.js';
import type { Notifier } from './notifier.js';
import {
  LocalRecipient,
  type Recipient,
  RemoteRecipient,
  type Target,
  isRecipient,
} from './recipients.js';
import type { ClusterNotifier } from './cluster-notifier.js';
import type { RemoteEffect } from './remote-effects.js';
import type { ApprovalStore } from '../joins/approval-store.js';
import type { ParkingRegistry } from '../storage/redis/parking.js';
import { ParkingLot } from './parking-lot.js';
import { canSupersede, classifyToken } from './resume.js';
import { nextTerm } from '../lifecycle/succession.js';
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
  /** Groups that ended (Q8), in memory or in Redis (#35 AC13). */
  ended: EndedGroupsStore;
  /** Code -> group lookup (#10 D1, #35 AC7). */
  codes: CodeIndexStore;
  /** Door-code failure state (#10 AC29, #35 AC7). */
  doors: DoorStateStore;
  /**
   * When this process started, from the injected clock, read before any
   * token was issued (#13 6.9 layer 2). Defaults to the clock at
   * construction. The epoch of the in-memory store.
   */
  processStartedAt?: number;
  /** The store's epoch (Redis, #35 architecture 4.5); defaults to `processStartedAt`. */
  epoch?: EpochSource;
  /**
   * Keep the stored attachments when the server stops (Redis): the restart
   * grace then counts from when the server is back (#35 AC11).
   */
  keepAttachmentsOnClose?: boolean;
  /**
   * Most groups whose disconnects wait for Redis to come back (#35 security
   * C4); defaults to 10 000. Over it, the oldest group is dropped (its
   * sessions re-check on their next resume).
   */
  replayCap?: number;
  /** Signs and verifies QR tickets (#10). */
  qrTickets: QrTicketService;
  /** Signs and verifies codes blobs (#10). */
  codesBlobs: CodesBlobService;
  /** Join code draws; injected by tests (#10 AC9). */
  codeRandom?: RandomInt;
  /** The app of a namespace, for timers that fire without a session (#35 ADR 0013). */
  appOf: (namespace: string) => AppConfig | undefined;
  /** Where group timers live; defaults to `setTimeout` on the scheduler. */
  timerBackend?: TimerBackend;
  /** The storage's unit of work (#35 ADR 0011); defaults to the in-memory one. */
  work?: UnitOfWorkSource;
  /** The group leases across instances (#35 architecture 12.4); memory has none. */
  leases?: LeaseSource;
  /** The synchronous instance guard (#35 security C11). */
  fenced?: () => boolean;
  /**
   * Several instances (#35 architecture 12.6): who owns a membership comes
   * from the group's attachment registry, read under the lease.
   */
  cluster?: ClusterNotifier;
  /** Pending method B requests (Redis, #35 architecture 12.9); defaults to memory. */
  approvals?: ApprovalStore;
  /** Which instances hold parked members of a missing group (Redis, 12.10). */
  parked?: ParkingRegistry;
  /** `group.create` limits (#12), from the env or the test-only `groupLimits`. */
  createLimits: GroupCreateLimits;
  /** Test-only: replaces the derived sustained create rate per app (#12 R7). */
  createRefillPerMinute?: number;
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

/** A roster with nobody on it, for a new or recreated group. */
const EMPTY_ROSTER: RosterState = { roster: [], nextAdmissionSeq: 0, nextGuestNumber: 1 };

/** The roster fields of a record. */
function rosterStateOf(record: GroupRecord): RosterState {
  return {
    roster: record.roster,
    nextAdmissionSeq: record.nextAdmissionSeq,
    nextGuestNumber: record.nextGuestNumber,
  };
}

/** The name rule of a create or resume (#13 D11); undefined for an invalid name. */
function nameChoice(raw: string | undefined): NameChoice | undefined {
  const resolved = resolveDisplayName(raw);
  if (!resolved.ok) return undefined;
  return resolved.generated ? { generated: true } : { generated: false, name: resolved.name };
}

/** A task's local changes, undone when its commit fails (#35 security L1). */
interface Rollback {
  /** Each touched session as it was before the task: membership and whether it owned it. */
  sessions: Map<Session, { membership: Membership | undefined; attached: boolean }>;
  /** Groups whose refresh state this task created. */
  refresh: Set<string>;
}

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
  /**
   * Serializes every state change per group (namespace + ID), with its
   * unit of work and effect outbox (#35 ADR 0011).
   */
  private readonly lock: GroupLock;
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
  /** Activity, keep-alive and, later, pause and handoff (#13 section 6). */
  private readonly lifecycle: LifecycleService;
  /** Vice, lock, removal and the other leader controls (#13 3.1). */
  private readonly controls: LeaderControls;
  /** Group recreations per connection (#13 RC20). */
  private readonly recreateLimiter: SlidingWindowRateLimiter;
  /** `group.create` attempts per connection (#12 AC1); forgotten on disconnect. */
  private readonly createLimiter: SlidingWindowRateLimiter;
  /** When this process started (#13 6.9 layer 2). */
  private readonly processStartedAt: number;

  constructor(private readonly deps: GroupServiceDeps) {
    this.lock = new GroupLock(
      deps.work,
      (namespace, groupId, err, sessions) => {
        this.failedCommit(namespace, groupId, err, sessions as ReadonlySet<Session>);
      },
      {
        leases: deps.leases,
        fenced: deps.fenced,
        beforeTask: (namespace, groupId) => this.drainInbox(groupKey(namespace, groupId)),
      },
    );
    this.timers = new GroupTimers(deps.timerBackend ?? new MemoryTimerBackend(deps.scheduler));
    this.joins = new JoinService(
      {
        store: deps.store,
        logger: deps.logger,
        scheduler: deps.scheduler,
        qrTickets: deps.qrTickets,
        codesBlobs: deps.codesBlobs,
        ...(deps.codeRandom === undefined ? {} : { random: deps.codeRandom }),
        codes: deps.codes,
        doors: deps.doors,
        timers: this.timers,
        groupExpiry: (namespace, createdAt) => this.groupExpiry(namespace, createdAt),
        ...(deps.approvals === undefined ? {} : { approvals: deps.approvals }),
      },
      {
        busy: (session) => this.busy(session),
        runLocked: (namespace, groupId, task) => this.lock.run(namespace, groupId, task),
        admit: (session, groupId, method, name) => this.admitMember(session, groupId, method, name),
        leaderOf: (record) => this.recipientOf(record, record.leaderId),
        deliverLater: (session, message) => this.deliverLater(session, message),
        admissionClosed: (record) => this.admissionClosed(record),
        asLeader: (session, action, task) => this.asLeader(session, action, task),
        ...(deps.cluster === undefined
          ? {}
          : {
              admitRemote: (app, groupId, name, instance, requestId) =>
                this.admitRemote(app, groupId, name, instance, requestId),
              settleRemote: (instance, namespace, groupId, requestId, message) =>
                deps.cluster!.host.send(instance, {
                  op: 'settle',
                  ns: namespace,
                  gid: groupId,
                  rid: requestId,
                  text: JSON.stringify(message),
                }),
              instanceLive: async (instance) =>
                (await deps.cluster!.host.liveOf([instance])).has(instance),
            }),
      },
    );
    this.checkLimiter = new SlidingWindowRateLimiter(() => this.now(), TOKENS_CHECK_WINDOW_MS);
    this.appCheckLimiter = new SlidingWindowRateLimiter(() => this.now(), TOKENS_CHECK_WINDOW_MS);
    this.recreateLimiter = new SlidingWindowRateLimiter(() => this.now(), RECREATION_WINDOW_MS);
    this.createLimiter = new SlidingWindowRateLimiter(() => this.now(), GROUP_CREATE_WINDOW_MS);
    this.controls = new LeaderControls(
      {
        asLeader: (session, action, task) => this.asLeader(session, action, task),
        patch: async (record, patch) =>
          (await this.deps.store.patch(record.appNamespace, record.id, patch)) ?? record,
        sessionOf: (record, pid) => this.sessionOf(record, pid),
        deliverLater: (session, message) => this.deliverLater(session, message),
        rosterUpdated: (record, pid) => this.rosterUpdated(record, pid),
        block: (app, record, pids) => this.applyBlockList(app, record, pids),
        claimFullSet: (record) => this.joins.claimFullSet(record),
        commitFullSet: (record, next, leader) =>
          this.joins.commitFullSet(record, next, 'member_removed', leader),
        releaseClaim: (record, claimed) => this.joins.releaseClaim(record, claimed),
        codesPayload: (record) => this.joins.payload(record),
        get: (record) => this.deps.store.get(record.appNamespace, record.id),
        asMember: (session, task) => this.asMember(session, task),
        takeBackFor: async (session, record, pid) => {
          const swapped = await this.lifecycle.handoff(session.app, record, pid, 'take_back');
          return swapped.granted;
        },
        toMembers: (record, message) => this.toMembers(record, message),
        now: () => this.now(),
      },
      deps.logger,
    );
    this.processStartedAt = deps.processStartedAt ?? deps.scheduler.now();
    this.lifecycle = new LifecycleService({
      store: deps.store,
      timers: this.timers,
      logger: deps.logger,
      leaderSession: (record) => this.sessionOf(record, record.leaderId),
      deliverLater: (session, message) => this.deliverLater(session, message),
      refresherActivity: (namespace, groupId, at) =>
        this.refresher.activity(groupKey(namespace, groupId), at),
      toMembers: (record, message) => this.toMembers(record, message),
      scheduleFrozenEnd: (app, record) => this.scheduleFrozenEnd(app, record),
      sessionOf: (record, pid) => this.sessionOf(record, pid),
      issueToken: (record, pid, role) =>
        this.issueToken(record.appNamespace, record, pid, role, this.now()),
      leaderState: (record) => this.leaderState(record),
      codesPayload: (record) => this.joins.payload(record),
      rosterSnapshot: (record) => this.rosterSnapshot(record),
      onLeaderReturn: (leader, record) => this.joins.onLeaderReturn(leader, record),
      refreshLeader: (record, pid, at) => this.refreshLeader(record, pid, at),
      endEmpty: (app, groupId) => this.endGroup(app, groupId, 'empty'),
      endInactive: (app, groupId) => this.endGroup(app, groupId, 'inactivity'),
      anyoneAttached: (record) => this.anyoneAttached(record),
      now: () => this.now(),
    });
    this.parking = new ParkingLot(deps.scheduler);
    this.refresher = new TokenRefresher(deps.scheduler, deps.refresh);
    this.onTimer('maxSession', (app, groupId) => this.onMaxSession(app, groupId));
    this.onTimer('frozenEnd', (app, groupId) => this.onFrozenEnd(app, groupId));
    this.onTimer('keepAlivePrompt', (app, groupId) => this.lifecycle.onPrompt(app, groupId));
    this.onTimer('keepAliveDeadline', (app, groupId) => this.lifecycle.onDeadline(app, groupId));
    this.onTimer('doorPauseEnd', (app, groupId) => this.joins.pauseEnded(app.namespace, groupId));
    this.onTimer('approvalDue', (app, groupId) => this.joins.approvalDue(app.namespace, groupId));
    this.onTimer('grace', (app, groupId, data) =>
      data === undefined
        ? Promise.resolve()
        : this.lifecycle.onGraceEnd(app, groupId, data.term, data.at),
    );
  }

  /**
   * Registers the handler of a timer kind: it runs under the group lock with
   * the group's app (#35 ADR 0013). A timer of an app no longer configured
   * does nothing.
   */
  private onTimer(
    kind: TimerKind,
    handler: (app: AppConfig, groupId: string, data: TimerData | undefined) => Promise<void>,
  ): void {
    this.timers.on(kind, (namespace, groupId, data, claim) => {
      const app = this.deps.appOf(namespace);
      this.runTimer(namespace, groupId, async () => {
        claim?.();
        if (app !== undefined) await handler(app, groupId, data);
      });
    });
  }

  /** Set once the server stops: disconnects then keep stored attachments (Redis). */
  private closing = false;

  /**
   * Groups whose disconnects could not be stored (Redis unreachable), in
   * arrival order, replayed under the group lock when Redis is back
   * (#35 architecture 8, security C4).
   */
  private readonly replay = new Set<string>();

  /**
   * A task's commit failed (#35 ADR 0014, security C8). Only when Redis is
   * unavailable: every local session of the group is closed with 1001, so
   * clients resume later; other errors close nobody.
   */
  private failedCommit(
    namespace: string,
    groupId: string,
    err: unknown,
    touched: ReadonlySet<Session>,
  ): void {
    if (!(err instanceof StorageUnavailableError)) {
      // Nothing was stored, and nobody is closed (C8): the attachments this
      // task made or dropped go back to how they were (security L1).
      const undo = this.rollbacks.get(touched);
      if (undo !== undefined) this.rollBack(undo);
      return;
    }
    if (err instanceof LeaseLostError) {
      // Another instance took the lease: this view may be stale (12.4).
      this.deps.logger.warn(
        { event: 'group_lease_lost', groupRef: groupRef(groupId) },
        'group lease lost before the commit',
      );
    }
    const sessions = new Set([...this.deps.notifier.sessionsOf(namespace, groupId), ...touched]);
    for (const session of sessions) {
      session.close(CloseCode.GOING_AWAY, 'temporarily unavailable');
    }
  }

  /**
   * What a task changed locally, to undo when its commit fails with anything
   * but "unavailable" (#35 security L1). Keyed by the task's session set.
   */
  private readonly rollbacks = new WeakMap<object, Rollback>();

  /** The running task's rollback record, created on first use. */
  private rollback(): Rollback | undefined {
    const task = this.lock.current();
    if (task === undefined) return undefined;
    let undo = this.rollbacks.get(task.sessions);
    if (undo === undefined) {
      undo = { sessions: new Map(), refresh: new Set() };
      this.rollbacks.set(task.sessions, undo);
    }
    return undo;
  }

  /** Restores every touched session's membership and attachment; drops new refresh state. */
  private rollBack(undo: Rollback): void {
    for (const session of undo.sessions.keys()) {
      const membership = session.membership;
      if (membership === undefined) continue;
      this.deps.notifier.unregister(
        membershipKey(session.app.namespace, membership.groupId, membership.participantId),
        session,
      );
    }
    for (const [session, before] of undo.sessions) {
      session.membership = before.membership;
      if (before.membership !== undefined && before.attached) {
        this.deps.notifier.register(
          membershipKey(
            session.app.namespace,
            before.membership.groupId,
            before.membership.participantId,
          ),
          session,
        );
      }
    }
    for (const key of undo.refresh) this.refresher.clear(key);
  }

  /** Notes a session whose attachment this task changed (closed if the commit fails). */
  private touch(session: Session): void {
    const task = this.lock.current();
    if (task === undefined) return;
    const undo = this.rollback();
    if (undo !== undefined && !undo.sessions.has(session)) {
      const membership = session.membership;
      undo.sessions.set(session, {
        membership,
        attached:
          membership !== undefined &&
          this.deps.notifier.get(
            membershipKey(session.app.namespace, membership.groupId, membership.participantId),
          ) === session,
      });
    }
    task.sessions.add(session);
  }

  /** Remembers a group whose disconnect waits for Redis (bounded, deduplicated). */
  private queueReplay(namespace: string, groupId: string): void {
    const key = `${namespace}:${groupId}`;
    this.replay.delete(key);
    this.replay.add(key);
    const cap = this.deps.replayCap ?? 10_000;
    while (this.replay.size > cap) {
      const oldest = this.replay.values().next().value;
      if (oldest === undefined) break;
      this.replay.delete(oldest);
    }
  }

  /**
   * This instance fenced itself (#35 architecture 12.5, security C13): a
   * session in a group, parked or waiting for approval leaves it here
   * without any disconnect rule (the orphan sweep of a peer, or of this
   * instance under its new ID, runs them). Returns whether it was in one;
   * the caller then closes it with 1001.
   */
  quietDetach(session: Session): boolean {
    let busy = false;
    const membership = session.membership;
    if (membership !== undefined) {
      busy = true;
      this.deps.notifier.unregister(
        membershipKey(session.app.namespace, membership.groupId, membership.participantId),
        session,
      );
      session.membership = undefined;
    }
    if (session.parked !== undefined) {
      busy = true;
      this.parking.unpark(session);
    }
    if (session.pendingJoin !== undefined) {
      busy = true;
      this.joins.forgetPending(session);
    }
    return busy;
  }

  /**
   * After a self-fence (#35 architecture 12.5, C13): queued disconnect
   * replays, refreshers and parking go; the sweep takes over.
   */
  onFenced(): void {
    this.replay.clear();
    this.refresher.clearAll();
    this.parking.clearAll();
  }

  /** Effects received from other instances, per group, not yet applied (12.7). */
  private readonly inbox = new Map<string, RemoteEffect[]>();

  /**
   * Effects another instance published for sessions here (#35 architecture
   * 12.7): each group's effects are applied in arrival order through the
   * group's local queue, so they never interleave with a local task of the
   * group; a task drains them first itself (Gate 2 Q-B10).
   */
  receiveRemote(effects: readonly RemoteEffect[]): void {
    const groups = new Map<string, { namespace: string; groupId: string }>();
    for (const effect of effects) {
      const key = groupKey(effect.ns, effect.gid);
      let queue = this.inbox.get(key);
      if (queue === undefined) {
        queue = [];
        this.inbox.set(key, queue);
      }
      queue.push(effect);
      groups.set(key, { namespace: effect.ns, groupId: effect.gid });
    }
    for (const [key, { namespace, groupId }] of groups) {
      this.lock
        .runLocal(namespace, groupId, () => this.drainInbox(key))
        .catch((err: unknown) => {
          this.deps.logger.error(
            { event: 'remote_effect_error', err: safeErr(err) },
            'remote failed',
          );
        });
    }
  }

  /** Applies the group's received effects, in order. In the group's local queue. */
  private drainInbox(key: string): void {
    const queue = this.inbox.get(key);
    if (queue === undefined) return;
    this.inbox.delete(key);
    for (const effect of queue) this.applyRemote(effect);
  }

  /**
   * One received effect (#35 architecture 12.7, security P2-4, C15): it
   * acts only on the local session that still holds the membership with
   * the same attach ID; anything else is dropped. Never runs while fenced.
   */
  private applyRemote(effect: RemoteEffect): void {
    if (this.deps.fenced?.() === true) return;
    const dropped = () =>
      this.deps.logger.debug({ event: 'remote_effect_dropped', op: effect.op }, 'effect dropped');
    switch (effect.op) {
      case 'deliver':
      case 'detach':
      case 'refresh': {
        const key = membershipKey(effect.ns, effect.gid, effect.pid);
        const session = this.deps.notifier.get(key);
        if (session === undefined || session.membership?.attachId !== effect.att) {
          dropped();
          return;
        }
        if (effect.op === 'deliver') {
          const { text } = effect;
          if (effect.later) session.afterPending(() => session.deliver(text));
          else session.deliver(text);
        } else if (effect.op === 'detach') {
          this.deps.notifier.unregister(key, session);
          session.membership = undefined;
          const { text, close } = effect;
          if (text !== undefined || close !== undefined) {
            session.afterPending(() => {
              if (text !== undefined) session.deliver(text);
              if (close !== undefined) session.close(close, 'removed');
            });
          }
        } else {
          this.startRefresh(effect.ns, effect.gid, effect.at);
        }
        return;
      }
      case 'admit': {
        // An approved joiner (12.9): attach it as the registry already says.
        const joiner = this.joins.approvals.releaseJoiner(effect.rid);
        if (
          joiner === undefined ||
          !joiner.isOpen() ||
          joiner.app.namespace !== effect.ns ||
          this.busy(joiner)
        ) {
          // Gone meanwhile (Gate 2 Q-B3): removed with the usual rules.
          this.disconnectStale(effect.ns, effect.gid, effect.pid, effect.att);
          return;
        }
        this.attach(joiner, effect.gid, effect.pid, effect.att);
        const { text } = effect;
        joiner.afterPending(() => joiner.deliver(text));
        return;
      }
      case 'settle': {
        const joiner = this.joins.approvals.releaseJoiner(effect.rid);
        if (joiner === undefined || joiner.app.namespace !== effect.ns) {
          dropped();
          return;
        }
        const { text } = effect;
        joiner.afterPending(() => joiner.deliver(text));
        return;
      }
      case 'admitParked': {
        // Under the group lease, after this local step (12.10).
        const app = this.deps.appOf(effect.ns);
        if (app === undefined) return;
        this.lock
          .run(effect.ns, effect.gid, () => this.admitParkedNow(app, effect.gid))
          .catch((err: unknown) => {
            if (err instanceof StorageUnavailableError || err instanceof StorageBusyError) {
              this.queueReplay(effect.ns, effect.gid);
              return;
            }
            this.deps.logger.error({ event: 'remote_effect_error', err: safeErr(err) }, 'admit');
          });
        return;
      }
      case 'forget': {
        const key = groupKey(effect.ns, effect.gid);
        this.deps.rateLimiter.forget(key);
        this.controls.forgetGroup(effect.ns, effect.gid);
        this.refresher.clear(key);
        return;
      }
      default:
        dropped();
    }
  }

  /** Number of groups waiting for a disconnect replay. For tests only. */
  get replayCount(): number {
    return this.replay.size;
  }

  /**
   * Redis is back (#35 architecture 8): for each queued group, under its
   * lock, every participant without an open local session is disconnected
   * with the usual rules. A group that failed again stays queued.
   */
  replayDisconnects(): Promise<void> {
    // One replay at a time (Redis back, and every heartbeat tick).
    this.replaying ??= this.replayAll().finally(() => {
      this.replaying = undefined;
    });
    return this.replaying;
  }

  private replaying: Promise<void> | undefined;

  private async replayAll(): Promise<void> {
    for (const key of [...this.replay]) {
      this.replay.delete(key);
      const at = key.indexOf(':');
      const namespace = key.slice(0, at);
      const groupId = key.slice(at + 1);
      const app = this.deps.appOf(namespace);
      if (app === undefined) continue;
      try {
        await this.lock.run(namespace, groupId, async () => {
          await this.reconcile(app, groupId);
          // Members parked here for a group recreated elsewhere (12.10).
          await this.admitParkedNow(app, groupId);
        });
      } catch (err) {
        if (err instanceof StorageUnavailableError) {
          this.queueReplay(namespace, groupId);
          return;
        }
        // Another instance holds the group: try again at the next replay.
        if (err instanceof StorageBusyError) {
          this.queueReplay(namespace, groupId);
          continue;
        }
        this.deps.logger.error({ event: 'replay_error', err: safeErr(err) }, 'replay failed');
      }
    }
  }

  /**
   * The connected participants of the group nobody holds any more (#35
   * architecture 12.8, security C12, C13). In memory: no open local
   * session. With several instances, from the registry read under the
   * lease: no entry, an entry naming an instance whose liveness key is gone
   * (read from Redis now, never the cache), or an entry naming this
   * instance with no matching open local session.
   */
  private async orphans(record: GroupRecord): Promise<Set<string>> {
    const namespace = record.appNamespace;
    const groupId = record.id;
    const connected = record.participantIds.filter((pid) => pid !== record.leaderId);
    if (record.leaderOnline) connected.push(record.leaderId);
    const localGone = (pid: string) => {
      const owner = this.recipient(namespace, groupId, pid);
      return !(owner instanceof LocalRecipient && owner.isOpen());
    };
    const cluster = this.deps.cluster;
    if (cluster === undefined) return new Set(connected.filter(localGone));
    const entries = cluster.entries(namespace, groupId);
    const self = cluster.host.selfId();
    const others = connected
      .map((pid) => entries.get(pid)?.i)
      .filter((id): id is string => id !== undefined && id !== self);
    const live = await cluster.host.liveOf(others);
    return new Set(
      connected.filter((pid) => {
        const entry = entries.get(pid);
        if (entry === undefined) return true;
        return entry.i === self ? localGone(pid) : !live.has(entry.i);
      }),
    );
  }

  /**
   * Disconnects every participant nobody holds any more (`orphans`), with
   * the usual rules: a leader goes offline with the grace from now (AC21),
   * members leave and are marked disconnected, an emptied group is held.
   * After a restart (`restart`), a pause or hold of a group nobody is
   * attached to on a live instance ends no earlier than
   * `disconnectGraceSeconds` from now (#35 Gate 2 Q-A3, AC11). Under the
   * group lock.
   */
  private async reconcile(app: AppConfig, groupId: string, restart = false): Promise<number> {
    const namespace = app.namespace;
    let record = await this.deps.store.get(namespace, groupId);
    if (record === undefined) return 0;
    const gone = await this.orphans(record);
    const connected = record.participantIds.filter((pid) => pid !== record!.leaderId);
    if (record.leaderOnline) connected.push(record.leaderId);
    const attended = connected.some((pid) => !gone.has(pid));
    if (restart && !attended) {
      const floor = this.now() + app.disconnectGraceSeconds * 1000;
      const running = pauseDeadline(record.pause);
      if (record.pause !== undefined && running !== undefined && running < floor) {
        const pause: GroupPause =
          record.pause.graceEndsAt !== undefined
            ? { ...record.pause, graceEndsAt: floor }
            : { ...record.pause, holdEndsAt: floor };
        record = (await this.deps.store.patch(namespace, groupId, { pause })) ?? record;
        this.lifecycle.armPauseEnd(app, record, floor);
      }
    }
    for (const pid of record.participantIds) {
      if (pid === record.leaderId || !gone.has(pid)) continue;
      const result = await this.deps.store.removeParticipant(namespace, groupId, pid);
      const current = await this.deps.store.get(namespace, groupId);
      if (current !== undefined) await this.leaveRosterOnDisconnect(app, current, pid);
      if (result && result.connected === 0) await this.emptied(app, groupId);
    }
    const current = await this.deps.store.get(namespace, groupId);
    if (current === undefined) return gone.size;
    if (current.leaderOnline && gone.has(current.leaderId)) await this.leaderOffline(app, groupId);
    else if (restart && !attended && connectedCount(current) === 0)
      await this.emptied(app, groupId);
    return gone.size;
  }

  /** The store's epoch: the Redis epoch, or this process's start (#35 4.5). */
  private epoch(): Promise<number> {
    return this.deps.epoch?.current() ?? Promise.resolve(this.processStartedAt);
  }

  /** Cancels every group and parking timer (server shutdown). */
  close(): void {
    this.closing = true;
    this.timers.clearAll();
    this.parking.clearAll();
    this.refresher.clearAll();
    this.checkLimiter.clear();
    this.appCheckLimiter.clear();
    this.recreateLimiter.clear();
    this.createLimiter.clear();
    this.controls.close();
    this.appBudgetWarnedAt.clear();
    this.joins.close();
  }

  /**
   * The latest a group created at `createdAt` can live: its max-session
   * deadline plus the slack its end needs (#35 AC24, Gate 2 Q-A2).
   */
  private groupExpiry(namespace: string, createdAt: number): number {
    const app = this.deps.appOf(namespace);
    if (app === undefined) return createdAt + END_TTL_SLACK_MS;
    return createdAt + app.maxSessionMinutes * MINUTE_MS + END_TTL_SLACK_MS;
  }

  /**
   * Starts refresh counting for the group's online leader after a fresh
   * leader token was issued at `at` (create, return, recreation).
   */
  private startRefresh(namespace: string, groupId: string, at: number): void {
    const key = groupKey(namespace, groupId);
    // Refresh state this task creates goes if its commit fails (L1).
    if (!this.refresher.has(key)) this.rollback()?.refresh.add(key);
    this.refresher.reset(key, at, () => {
      this.runTimer(namespace, groupId, () => this.sendRefreshedToken(namespace, groupId));
    });
  }

  /**
   * Starts the refresher where the new leader `pid` is attached (#35
   * architecture 12.6); with nobody attached, here.
   */
  private refreshLeader(record: GroupRecord, pid: string, at: number): void {
    const leader = this.recipientOf(record, pid);
    if (leader instanceof RemoteRecipient) {
      // The refresher runs where the leader's actions are counted.
      this.refresher.clear(groupKey(record.appNamespace, record.id));
      leader.refresh(at);
    } else if (leader !== undefined) leader.refresh(at);
    else this.startRefresh(record.appNamespace, record.id, at);
  }

  /**
   * Sends the online leader a token with the group's current last-activity
   * time; all other claims stay the same (#5 AC12). Runs under the group lock.
   */
  private async sendRefreshedToken(namespace: string, groupId: string): Promise<void> {
    const record = await this.deps.store.get(namespace, groupId);
    if (!record || !record.leaderOnline) return;
    const leader = this.recipient(namespace, groupId, record.leaderId);
    if (leader === undefined) return;
    const token = this.issueToken(namespace, record, record.leaderId, 'leader', this.now());
    const text = JSON.stringify({
      type: 'token.refreshed',
      groupId,
      token,
    } satisfies ServerMessage);
    leader.send(text, false);
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
    return (
      session.membership !== undefined ||
      session.parked !== undefined ||
      session.pendingJoin !== undefined
    );
  }

  /** Number of groups with a pending timer. For tests only. */
  get timerCount(): number {
    return this.timers.size;
  }

  private now(): number {
    return this.deps.scheduler.now();
  }

  /**
   * The session's membership if the session still owns it (M4). Locally
   * that is the notifier; inside a task of its group with several
   * instances, the registry read under the lease decides too: the local
   * check alone may only deny (#35 security C14).
   */
  private owned(session: Session): Membership | undefined {
    const membership = session.membership;
    if (membership === undefined) return undefined;
    const namespace = session.app.namespace;
    const key = membershipKey(namespace, membership.groupId, membership.participantId);
    if (this.deps.notifier.get(key) !== session) return undefined;
    if (this.deps.cluster === undefined) return membership;
    const task = this.lock.current();
    if (task === undefined || task.groupId !== membership.groupId) return membership;
    const owner = this.recipient(namespace, membership.groupId, membership.participantId);
    return owner instanceof LocalRecipient && owner.session === session ? membership : undefined;
  }

  /** Attaches `session` as `participantId` of the group, with a new attach ID. */
  private attach(
    session: Session,
    groupId: string,
    participantId: string,
    attachId = newAttachId(),
  ): void {
    this.touch(session);
    session.membership = { groupId, participantId, attachId };
    this.deps.notifier.register(
      membershipKey(session.app.namespace, groupId, participantId),
      session,
    );
    // Several instances: the registry names this instance and attach ID (12.6).
    this.deps.cluster?.attached(session.app.namespace, groupId, participantId, attachId);
  }

  /**
   * The participant `pid` of the group as a task reaches it (#35
   * architecture 12.6), or undefined when nobody is attached as `pid`.
   */
  private recipient(namespace: string, groupId: string, pid: string): Recipient | undefined {
    const cluster = this.deps.cluster;
    if (cluster === undefined) {
      const session = this.deps.notifier.get(membershipKey(namespace, groupId, pid));
      return session === undefined ? undefined : this.localRecipient(session, groupId, pid);
    }
    const resolved = cluster.resolve(namespace, groupId, pid);
    if (resolved === undefined) return undefined;
    if (resolved.kind === 'local') return this.localRecipient(resolved.session, groupId, pid);
    return new RemoteRecipient(namespace, groupId, pid, resolved.instance, resolved.attachId, {
      send: (instance, effect) => cluster.host.send(instance, effect),
      forget: (participantId, attachId) =>
        cluster.detached(namespace, groupId, participantId, attachId),
      looksLive: (instance) => cluster.host.looksLive(instance),
    });
  }

  private localRecipient(session: Session, groupId: string, pid: string): LocalRecipient {
    return new LocalRecipient(session, groupId, pid, {
      effect: (effect) => this.lock.effect(effect),
      detachLocal: (detached, gid, participantId) => this.detachLocal(detached, gid, participantId),
      refreshLocal: (gid, at) => this.startRefresh(session.app.namespace, gid, at),
    });
  }

  /** The attached participant `pid` of `record`'s group, if any. */
  private recipientOf(record: GroupRecord, pid: string): Recipient | undefined {
    return this.recipient(record.appNamespace, record.id, pid);
  }

  /**
   * `session` loses the membership `pid` of `groupId` at once (M4): it is
   * unregistered and its membership cleared; the task's rollback record
   * notes it first (#35 security L1).
   */
  private detachLocal(session: Session, groupId: string, pid: string): void {
    this.touch(session);
    if (session.membership?.groupId === groupId) {
      this.deps.cluster?.detached(session.app.namespace, groupId, pid, session.membership.attachId);
    }
    this.deps.notifier.unregister(membershipKey(session.app.namespace, groupId, pid), session);
    if (session.membership?.groupId === groupId) session.membership = undefined;
  }

  private issueToken(
    namespace: string,
    record: GroupRecord,
    participantId: string,
    role: TokenRole,
    now: number,
  ): string {
    return this.deps.tokens.issue({
      namespace,
      groupId: record.id,
      participantId,
      role,
      groupCreatedAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      term: record.term,
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
    this.timers.arm(app.namespace, record.id, 'maxSession', this.maxSessionEndAt(app, record));
  }

  /** The max-session timer, under the group lock. */
  private async onMaxSession(app: AppConfig, groupId: string): Promise<void> {
    const current = await this.deps.store.get(app.namespace, groupId);
    if (!current) return;
    // Re-checked against the clock under the lock (R3).
    if (this.maxSessionEndAt(app, current) > this.now()) {
      this.armMaxSession(app, current);
      return;
    }
    await this.endGroup(app, groupId, 'max_session');
  }

  /** The frozen-end timer, under the group lock. */
  private async onFrozenEnd(app: AppConfig, groupId: string): Promise<void> {
    const current = await this.deps.store.get(app.namespace, groupId);
    // Stale timer: the group is gone or live again (#13 6.4).
    if (!current || current.pause === undefined) return;
    await this.scheduleFrozenEnd(app, current);
  }

  /** Runs a timer callback under the group lock; failures are logged, never thrown. */
  private runTimer(namespace: string, groupId: string, task: () => Promise<void>): void {
    this.lock.run(namespace, groupId, task).catch((err: unknown) => {
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
    const name = nameChoice(message.displayName);
    if (name === undefined) return errorMessage(ErrorCode.INVALID_MESSAGE);

    // Every attempt from here on counts against the connection, whatever
    // its outcome, so polling an empty app budget costs fresh connections
    // (#12 AC1, M4). In process and first, so a socket over its own limit
    // never spends the app's budget.
    const rate = this.createLimiter.tryAcquire(
      session.connectionId,
      this.deps.createLimits.perConnectionPerMinute,
    );
    if (!rate.ok) {
      return actionErrorMessage(ErrorCode.RATE_LIMITED, 'group.create', {
        details: { retryAfterMs: rate.retryAfterMs },
      });
    }

    // A pure check, before the lock and before anything is reserved (#12 M2).
    const methods = resolveGroupMethods(app.joinMethods, message.joinMethods);
    if (!methods.ok) return errorMessage(ErrorCode.JOIN_METHOD_NOT_ALLOWED);

    const groupId = newGroupId();
    // Under the new group's lock, so the group, its codes and its timers
    // are stored in one step (#35 ADR 0011).
    return this.lock.run(app.namespace, groupId, () =>
      this.createLocked(session, message, groupId, name, methods.methods),
    );
  }

  private async createLocked(
    session: Session,
    message: GroupCreateMessage,
    groupId: string,
    name: NameChoice,
    methods: JoinMethod[],
  ): Promise<ServerMessage> {
    const { app } = session;
    const initial = await this.joins.initialCodes(app, groupId, methods);
    if (!initial.ok) return initial.error;

    const participantId = newParticipantId();
    const now = this.now();
    const roster = admitToRoster(EMPTY_ROSTER, participantId, name, now);
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
      term: now,
      recoveredAt: undefined,
      handoff: message.handoff ?? app.defaultHandoff,
      viceId: undefined,
      locked: false,
      keepAlivePending: false,
      pause: undefined,
      displacedLeaderId: undefined,
      escalated: false,
      anchorTerm: undefined,
      recoveryMarking: false,
      leaderOnline: true,
      blockList: [],
      joinMethods: initial.methods,
      codes: initial.codes,
      roster: roster.roster,
      nextAdmissionSeq: roster.nextAdmissionSeq,
      nextGuestNumber: roster.nextGuestNumber,
    };
    try {
      await this.deps.store.create(record);
    } catch (err) {
      await this.joins.releaseCodes(app.namespace, groupId, initial.codes);
      throw err;
    }
    this.armMaxSession(app, record);
    this.startRefresh(app.namespace, record.id, now);
    this.lifecycle.armKeepAlive(app, record);
    this.attach(session, record.id, participantId);
    this.deps.logger.info(
      { event: 'group_created', namespace: app.namespace, groupRef: groupRef(record.id) },
      'group created',
    );
    const token = this.issueToken(app.namespace, record, participantId, 'leader', now);
    // The roster goes to the leader after its reply (#13 AC31).
    this.deliverLater(session, this.rosterSnapshot(record));
    // Codes go to the leader's connection only (#10 AC10, R13).
    return {
      type: 'group.created',
      groupId: record.id,
      participantId,
      role: 'leader',
      handoff: record.handoff,
      state: this.leaderState(record),
      displayName: roster.entry.name,
      generated: roster.entry.generated,
      token,
      joinMethods: [...record.joinMethods],
      codes: this.joins.payload(record),
    };
  }

  /**
   * Runs a leader-only action (#13 D1, RC1): takes the lock of the session's
   * group, re-reads the record under it and calls `authorizeLeader` against
   * `record.leaderId` before `task` runs. Nothing outside the lock decides
   * who leads, so an action racing a handoff gets either its full effect or
   * NOT_LEADER (AC8). `task` must not release the lock between its checks
   * and its effect.
   */
  private async asLeader(
    session: Session,
    action: LeaderAction,
    task: (record: GroupRecord, membership: Membership) => Promise<ServerMessage>,
  ): Promise<ServerMessage> {
    // Parked, pending or groupless sessions are answered without a lock.
    const membership = this.owned(session);
    if (membership === undefined || session.parked !== undefined) {
      const refused = authorizeLeader(
        { session, owned: membership, groupId: '', record: undefined },
        action,
      );
      return isGuardError(refused) ? refused : errorMessage(ErrorCode.NOT_IN_GROUP);
    }
    const { groupId } = membership;
    const namespace = session.app.namespace;
    return this.lock.run(namespace, groupId, async () => {
      const record = await this.deps.store.get(namespace, groupId);
      const auth = authorizeLeader(
        { session, owned: this.owned(session), groupId, record },
        action,
      );
      if (isGuardError(auth)) return auth;
      const reply = await task(record!, auth);
      // An accepted leader action is a leader activity (#13 6.2, AC15).
      // Rejected, rate-limited and refused actions never count.
      if (reply.type !== 'error' && action !== 'group.end') {
        const current = await this.deps.store.get(namespace, groupId);
        if (current !== undefined && current.leaderId === auth.participantId) {
          await this.lifecycle.activity(session.app, current, this.now(), session);
        }
      }
      return reply;
    });
  }

  /** leader.takeBack (#13 AC24). */
  takeBack(session: Session, message: LeaderTakeBackMessage): Promise<ServerMessage> {
    return this.controls.takeBack(session, message);
  }

  /**
   * Runs `task` under the lock of the session's own group with the record
   * read under it (for take-back: no leader check, the caller decides).
   * Parked, pending and groupless sessions get NOT_ALLOWED / NOT_IN_GROUP.
   */
  private async asMember(
    session: Session,
    task: (record: GroupRecord, membership: Membership) => Promise<ServerMessage>,
  ): Promise<ServerMessage> {
    if (session.parked !== undefined || session.pendingJoin !== undefined) {
      return actionErrorMessage(ErrorCode.NOT_ALLOWED, 'leader.takeBack');
    }
    const membership = this.owned(session);
    if (membership === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
    const namespace = session.app.namespace;
    return this.lock.run(namespace, membership.groupId, async () => {
      const current = this.owned(session);
      if (current === undefined || current.groupId !== membership.groupId) {
        return errorMessage(ErrorCode.NOT_IN_GROUP);
      }
      const record = await this.deps.store.get(namespace, membership.groupId);
      if (record === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
      return task(record, current);
    });
  }

  /** leader.activity / keepalive.ack (#13 AC16, AC30). */
  leaderActivity(
    session: Session,
    message: LeaderActivityMessage | KeepAliveAckMessage,
  ): Promise<ServerMessage> {
    return this.controls.leaderActivity(session, message);
  }

  /** member.remove (#13 AC32). */
  removeMember(session: Session, message: MemberRemoveMessage): Promise<ServerMessage> {
    return this.controls.removeMember(session, message);
  }

  /** group.lock / group.unlock (#13 AC29). */
  setLock(
    session: Session,
    message: GroupLockMessage | GroupUnlockMessage,
  ): Promise<ServerMessage> {
    return this.controls.setLock(session, message);
  }

  /**
   * True while the group admits nobody new, by any method (#13 AC29, D14):
   * the leader locked it. Token resumes and parked admissions ignore it.
   */
  private admissionClosed(record: GroupRecord): boolean {
    // RC21 (a): a held empty group admits nobody new either, with the same
    // answer as a locked one, so the hold is no new oracle.
    return record.locked || (!record.leaderOnline && connectedCount(record) === 0);
  }

  /**
   * Nobody is connected any more (#13 D15, Q-G): the group is held for the
   * grace period, then ends `empty` (RC21). Under the group lock.
   */
  private async emptied(app: AppConfig, groupId: string): Promise<void> {
    const record = await this.deps.store.get(app.namespace, groupId);
    if (record === undefined) return;
    await this.lifecycle.hold(app, record);
  }

  /** The leader recovery state (#13 D13). */
  private leaderState(record: GroupRecord): LeaderState {
    const state: LeaderState = {
      blockList: [...record.blockList],
      locked: record.locked,
      handoff: record.handoff,
    };
    if (record.viceId !== undefined) state.viceId = record.viceId;
    return state;
  }

  /** vice.set (#13 AC10). */
  setVice(session: Session, message: ViceSetMessage): Promise<ServerMessage> {
    return this.controls.setVice(session, message);
  }

  /** vice.clear (#13 AC10). */
  clearVice(session: Session, message: ViceClearMessage): Promise<ServerMessage> {
    return this.controls.clearVice(session, message);
  }

  /** The vice is told again when it rejoins, after its reply (#13 5.2, AC13). */
  private tellReturningVice(record: GroupRecord, pid: string): void {
    if (pid === record.viceId) this.controls.tellVice(record, pid, true);
  }

  /** The participant attached as `pid` in the group, if any. */
  private sessionOf(record: GroupRecord, pid: string): Recipient | undefined {
    return this.recipientOf(record, pid);
  }

  /** codes.rotate (#10 AC30). */
  rotateCodes(session: Session, _message: CodesRotateMessage): Promise<ServerMessage> {
    return this.joins.rotate(session);
  }

  /** group.joinByQr (#10 AC24). */
  joinByQr(session: Session, message: GroupJoinByQrMessage): Promise<ServerMessage> {
    return this.joins.joinByQr(session, message);
  }

  /** qr.issue (#10 AC23). */
  issueQr(session: Session, _message: QrIssueMessage): Promise<ServerMessage> {
    return this.joins.issueQr(session);
  }

  /** join.cancel (#10 AC21). */
  cancelJoin(session: Session, _message: JoinCancelMessage): Promise<ServerMessage> {
    return this.joins.cancel(session);
  }

  /** join.approve (#10 AC21). */
  approveJoin(session: Session, message: JoinApproveMessage): Promise<ServerMessage> {
    return this.joins.decide(session, message.requestId, 'approve');
  }

  /** join.deny (#10 AC21). */
  denyJoin(session: Session, message: JoinDenyMessage): Promise<ServerMessage> {
    return this.joins.decide(session, message.requestId, 'deny');
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
    name: NameChoice,
  ): Promise<ServerMessage> {
    const { app } = session;
    // #13 D14 / RC3: the admit step checks the lock again under the same
    // group lock, so a lock set after the method checks still refuses.
    const current = await this.deps.store.get(app.namespace, groupId);
    if (current !== undefined && this.admissionClosed(current)) return GROUP_LOCKED;
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
    // Code, QR and approval admissions after a recreation are marked, so a
    // superseding leader can review them (#13 6.6.4, M4).
    const record = await this.enterRoster(
      added.group,
      participantId,
      name,
      added.group.recoveryMarking,
    );
    return this.commitJoin(session, participantId, record, method);
  }

  private commitJoin(
    session: Session,
    participantId: string,
    record: GroupRecord,
    method?: JoinMethod,
  ): ServerMessage {
    const { app } = session;
    this.attach(session, record.id, participantId);
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
      ...this.ownName(record, participantId),
      metadata: record.metadata,
      token,
      // False while paused (#13 5.2): the group does not follow anyone now.
      leaderOnline: record.leaderOnline && record.pause === undefined,
      locked: record.locked,
      ...(record.pause === undefined ? {} : { leaderPause: pauseOnWire(record.pause, this.now()) }),
    };
    return record.position.has
      ? { ...base, hasPosition: true, position: record.position.payload }
      : { ...base, hasPosition: false };
  }

  /**
   * position.update runs under the group lock (#13 D2): authorization, then
   * the size check, then the rate limit, then the relay. An update racing a
   * handoff is never relayed after it (AC8).
   */
  update(session: Session, message: PositionUpdateMessage): Promise<ServerMessage> {
    const { app } = session;
    const namespace = app.namespace;
    return this.asLeader(session, 'position.update', async (record) => {
      const groupId = record.id;
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

      // Members only: the leader gets position.ack, not the broadcast (AC13).
      this.toMembers(record, {
        type: 'position.updated',
        groupId,
        position: message.position,
      });
      this.deps.logger.debug(
        { event: 'position_updated', namespace, groupRef: groupRef(groupId) },
        'position updated',
      );
      return { type: 'position.ack' };
    });
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

  private memberIds(record: GroupRecord): string[] {
    return record.participantIds.filter((id) => id !== record.leaderId);
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
        ended: await this.deps.ended.has(app.namespace, claims.gid),
        epoch: await this.epoch(),
        recoveryClosed: await this.deps.ended.isRecoveryClosed(app.namespace),
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
  setBlockList(session: Session, message: BlockListSetMessage): Promise<ServerMessage> {
    return this.asLeader(session, 'blocklist.set', async (record) => {
      const refused = await this.applyBlockList(session.app, record, message.blockList);
      return refused ?? { type: 'blocklist.ack' };
    });
  }

  /**
   * Adds `list` to the block list (#13 D5, Q-C): the list only grows while
   * the group is live, and a union past 256 IDs answers BLOCK_LIST_FULL and
   * changes nothing (never truncates: that would unblock someone). Listed
   * attached members are removed (D6, Q-A), listed entries leave the
   * roster, and a listed vice loses the designation. Returns the error, or
   * undefined. Runs under the group lock.
   */
  private async applyBlockList(
    app: AppConfig,
    record: GroupRecord,
    list: readonly string[],
  ): Promise<ErrorMessage | undefined> {
    const namespace = app.namespace;
    const blockList = blockListUnion(record, list);
    if (blockList.length > MAX_BLOCK_LIST_SIZE) return blockListFull();
    const result = await this.deps.store.setBlockList(namespace, record.id, blockList);
    if (!result) return undefined;
    // Blocked participants leave the roster, attached or not (#13 AC31),
    // and a blocked vice-leader loses the designation (AC12).
    const gone = record.roster.filter((e) => blockList.includes(e.pid)).map((e) => e.pid);
    if (record.viceId !== undefined && blockList.includes(record.viceId)) {
      await this.controls.applyVice(record, undefined);
    }
    // A blocked displaced leader loses the take-back slot (#13 RC4).
    if (record.displacedLeaderId !== undefined && blockList.includes(record.displacedLeaderId)) {
      await this.deps.store.patch(namespace, record.id, { displacedLeaderId: undefined });
    }
    if (gone.length > 0) {
      const current = (await this.deps.store.get(namespace, record.id)) ?? record;
      const updated = await this.putRoster(current, {
        ...rosterStateOf(current),
        roster: removeFromRoster(current.roster, gone),
      });
      this.rosterRemoved(updated, gone);
    }
    for (const participantId of result.removed) this.detachRemoved(record, participantId);
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
    return undefined;
  }

  /**
   * Detaches a removed participant's session (#13 D6, RC4, Gate 2 Q-A): it
   * loses the membership at once, so no later broadcast reaches it; it gets
   * `group.ended {reason: 'removed'}` as its last group frame, after its
   * pending replies, and then its socket is closed with
   * `CloseCode.REMOVED`. A participant with no attached session (offline)
   * has nothing to close.
   */
  private detachRemoved(record: GroupRecord, participantId: string): void {
    const member = this.recipientOf(record, participantId);
    if (member === undefined) return;
    const text = JSON.stringify({
      type: 'group.ended',
      groupId: record.id,
      reason: 'removed',
    } satisfies ServerMessage);
    member.detach('removed', text, CloseCode.REMOVED);
  }

  /**
   * group.end (#5 AC29): the leader ends the group. Members get group.ended
   * `ended_by_leader`; the leader gets the same message as its reply.
   */
  end(session: Session, _message: GroupEndMessage): Promise<ServerMessage> {
    return this.asLeader(session, 'group.end', async (record) => {
      await this.endGroup(session.app, record.id, 'ended_by_leader', session);
      return { type: 'group.ended', groupId: record.id, reason: 'ended_by_leader' };
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
    const { app } = session;
    const { groupId, participantId } = membership;
    return this.lock.run(app.namespace, groupId, async () => {
      if (this.owned(session) !== membership) return errorMessage(ErrorCode.NOT_IN_GROUP);
      // Decided under the lock against the live record (#13 L3): right after
      // a handoff the old leader may leave and the new one may not.
      const current = await this.deps.store.get(app.namespace, groupId);
      if (current?.leaderId === participantId) return errorMessage(ErrorCode.LEADER_CANNOT_LEAVE);
      this.detachLocal(session, groupId, participantId);
      const result = await this.deps.store.removeParticipant(app.namespace, groupId, participantId);
      if (current !== undefined) {
        // A vice-leader who leaves loses the designation (#13 AC12), and a
        // displaced leader who leaves loses the take-back slot (L3).
        if (current.viceId === participantId) await this.controls.applyVice(current, undefined);
        if (current.displacedLeaderId === participantId) {
          await this.deps.store.patch(app.namespace, groupId, { displacedLeaderId: undefined });
        }
        const latest = (await this.deps.store.get(app.namespace, groupId)) ?? current;
        const updated = await this.putRoster(latest, {
          ...rosterStateOf(latest),
          roster: removeFromRoster(latest.roster, [participantId]),
        });
        this.rosterRemoved(updated, [participantId]);
      }
      if (result && result.connected === 0) await this.emptied(app, groupId);
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
    const name = nameChoice(message.displayName);
    if (name === undefined) return errorMessage(ErrorCode.INVALID_MESSAGE);

    // Size-checked like group.create, whether or not they end up used.
    const tooLarge =
      (message.metadata === undefined
        ? undefined
        : sizeError('metadata', message.metadata, app.maxMessageBytes)) ??
      (message.position === undefined
        ? undefined
        : sizeError('position', message.position, app.maxMessageBytes));
    if (tooLarge) return tooLarge;

    return this.lock
      .run(app.namespace, claims.gid, () => this.resumeLocked(session, claims, message, name))
      .catch((err: unknown) => {
        // A recreation whose commit found the group stored or ended (#35 C7).
        if (err instanceof StorageConflictError) return errorMessage(ErrorCode.GROUP_ENDED);
        throw err;
      });
  }

  private async resumeLocked(
    session: Session,
    claims: TokenClaims,
    message: GroupResumeMessage,
    name: NameChoice,
  ): Promise<ServerMessage> {
    const { app } = session;
    if (this.busy(session)) return errorMessage(ErrorCode.ALREADY_IN_GROUP);
    // The entry, the fence and the closure are read under the lock, with
    // the record, so the classification and a recreation are one step
    // (#13 RC17).
    const record = await this.deps.store.get(app.namespace, claims.gid);
    const status = classifyToken({
      claims,
      app,
      record,
      ended: await this.deps.ended.has(app.namespace, claims.gid),
      epoch: await this.epoch(),
      recoveryClosed: await this.deps.ended.isRecoveryClosed(app.namespace),
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
        return this.resumeLive(session, record!, claims, message, name);
      case 'recoverable': {
        // Slows a stock-up of recreations after a restart (#13 RC20, M5).
        const rate = this.recreateLimiter.tryAcquire(
          session.connectionId,
          RECREATIONS_PER_CONNECTION_PER_MINUTE,
        );
        if (!rate.ok) {
          return actionErrorMessage(ErrorCode.RATE_LIMITED, 'group.resume', {
            details: { retryAfterMs: rate.retryAfterMs },
          });
        }
        return this.recreate(session, claims, message, name);
      }
      case 'waiting':
        return this.parkMember(session, claims, name);
    }
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
    const older = this.recipient(namespace, groupId, participantId);
    if (older === undefined || (older instanceof LocalRecipient && older.session === by)) return;
    const text = JSON.stringify({
      type: 'group.ended',
      groupId,
      reason: 'replaced',
    } satisfies ServerMessage);
    older.detach('replaced', text);
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
    joinCodes?: string,
  ): Promise<ServerMessage> {
    const { app } = session;
    const namespace = app.namespace;
    const now = this.now();
    // Only an explicit list replaces the server's; an omitted one keeps it (L5).
    // A union only (#13 D5); past 256 the leader is told and nothing changes:
    // checked before any state changes, so a refused return keeps the old
    // session attached (#13 security L-1).
    if (blockList !== undefined && blockListUnion(record, blockList).length > MAX_BLOCK_LIST_SIZE) {
      return blockListFull();
    }
    this.replaceOwner(namespace, record.id, claims.pid, session);
    if (blockList !== undefined) {
      const refused = await this.applyBlockList(app, record, blockList);
      if (refused !== undefined) return refused;
    }
    const online = await this.deps.store.setLeaderOnline(namespace, record.id, true, now);
    if (!online) return errorMessage(ErrorCode.GROUP_NOT_FOUND);
    const updated = await this.putRoster(online, {
      ...rosterStateOf(online),
      roster: setConnected(online.roster, claims.pid, true, now),
    });
    this.startRefresh(namespace, record.id, now);
    // A return is an activity: no prompt is outstanding (#13 6.2).
    if (updated.keepAlivePending) {
      await this.deps.store.patch(namespace, record.id, { keepAlivePending: false });
    }
    this.lifecycle.armKeepAlive(app, updated);
    // The return ends a pause (offline or inactive); members get leader.online.
    await this.lifecycle.unpause(app, updated);
    this.attach(session, record.id, claims.pid);
    // The roster, then pending approval requests and a running pause, are
    // sent after the reply (#13 AC31, #10 AC21, AC29, AC34).
    this.deliverLater(session, this.rosterSnapshot(updated));
    await this.joins.onLeaderReturn(session, updated);
    this.deps.logger.info(
      { event: 'group_resumed', namespace, groupRef: groupRef(record.id), recreated: false },
      'leader resumed',
    );
    // The blob is ignored for state: the current codes win (#10 AC34).
    const codesChanged = this.joins.codesChangedFor(updated, joinCodes);
    return this.resumedMessage(updated, claims.pid, false, now, codesChanged);
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
    name: NameChoice,
  ): Promise<ServerMessage> {
    if (message.metadata === undefined) return errorMessage(ErrorCode.INVALID_MESSAGE);
    const { app } = session;
    const namespace = app.namespace;
    const now = this.now();
    // The same codes if the leader's blob is valid and every code is free,
    // else a full new set; CODES_EXHAUSTED recreates nothing (#10 AC33).
    const initial = await this.joins.restoreCodes(app, claims.gid, claims.gct, message.joinCodes);
    if (!initial.ok) return initial.error;
    // A new roster: names are not in tokens (#13 AC36, AC37).
    const roster = admitToRoster(EMPTY_ROSTER, claims.pid, name, now);
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
      // The recreating token's grant (#13 D3).
      term: claims.term,
      // Clamped above the recreating term (#13 RC18), so a pre-restart token
      // whose term ran ahead of the clock still leaves term < recoveredAt.
      recoveredAt: Math.max(now, claims.term + 1),
      // From the leader's recovery state, else the app default (#13 D13).
      handoff: message.handoff ?? app.defaultHandoff,
      // Kept only if it is not the leader and not blocked; it takes effect
      // when that participant is admitted again (#13 AC13, 6.7).
      viceId:
        message.viceId !== undefined &&
        message.viceId !== claims.pid &&
        PARTICIPANT_ID_PATTERN.test(message.viceId) &&
        !(message.blockList ?? []).includes(message.viceId)
          ? message.viceId
          : undefined,
      // The lock flag from the leader's recovery state (#13 Q4.3).
      locked: message.locked ?? false,
      keepAlivePending: false,
      pause: undefined,
      // A recreated group starts a new line: no take-back slot (#13 6.6).
      displacedLeaderId: undefined,
      escalated: false,
      // The recreating grant anchors the supersede rule (#13 6.6.1, RC6).
      anchorTerm: claims.term,
      recoveryMarking: true,
      leaderOnline: true,
      // Deduplicated; the leader's own ID is ignored.
      blockList: [...new Set(message.blockList ?? [])].filter((id) => id !== claims.pid),
      joinMethods: initial.methods,
      codes: initial.codes,
      roster: roster.roster,
      nextAdmissionSeq: roster.nextAdmissionSeq,
      nextGuestNumber: roster.nextGuestNumber,
    };
    if ((await this.deps.store.createIfAbsent(record)) === 'exists') {
      await this.joins.releaseCodes(namespace, claims.gid, initial.codes);
      // Impossible under the in-process lock; with a shared store, the token
      // is classified again against the group someone else just recreated
      // (#13 L9, RC15): another pid never gets a leader return.
      const existing = await this.deps.store.get(namespace, claims.gid);
      if (!existing) return errorMessage(ErrorCode.GROUP_NOT_FOUND);
      const status = classifyToken({
        claims,
        app,
        record: existing,
        ended: false,
        epoch: await this.epoch(),
        recoveryClosed: false,
        now: this.now(),
        refreshMaxMs: this.deps.refresh.maxMs,
      });
      if (status === 'blocked') return errorMessage(ErrorCode.PARTICIPANT_BLOCKED);
      if (status !== 'live') return errorMessage(ErrorCode.TOKEN_EXPIRED);
      return this.resumeLive(session, existing, claims, message, name);
    }
    this.armMaxSession(app, record);
    this.startRefresh(namespace, record.id, now);
    this.lifecycle.armKeepAlive(app, record);
    this.attach(session, record.id, claims.pid);
    this.deliverLater(session, this.rosterSnapshot(record));
    await this.admitParked(app, record);
    // Members parked on other instances are admitted there (12.10).
    for (const instance of (await this.deps.parked?.recreated(namespace, record.id)) ?? []) {
      this.deps.cluster?.host.send(instance, { op: 'admitParked', ns: namespace, gid: record.id });
    }
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
    return this.resumedMessage(record, claims.pid, true, now, initial.changed);
  }

  /**
   * A token resumes a group in memory (#13 D4): a later pre-restart leader
   * token supersedes the stale recreator (6.6), the record's leader returns,
   * anyone else rejoins as a member. Under the group lock.
   */
  private resumeLive(
    session: Session,
    record: GroupRecord,
    claims: TokenClaims,
    message: GroupResumeMessage,
    name: NameChoice,
  ): Promise<ServerMessage> {
    const app = session.app;
    if (canSupersede(record, claims, app, this.now(), this.deps.refresh.maxMs)) {
      return this.supersede(session, record, claims, message, name);
    }
    return claims.pid === record.leaderId
      ? this.leaderReturn(session, record, claims, message.blockList, message.joinCodes)
      : this.memberResume(session, record, claims, name);
  }

  /**
   * Supersede (#13 6.6.2, RC6, RC7): after a restart, a later pre-restart
   * leader token takes the lead from the stale leader that recreated the
   * group first. One step under the group lock:
   * 1. the requester's block list replaces the stale one and is applied
   *    first (L1): listed attached participants are removed (4004), the
   *    stale leader included, with no token;
   * 2. leadership: the anchor moves to the requester's term, a new term
   *    from `nextTerm` floored at `recoveredAt`, no take-back slot, no
   *    escalation, no pause, a fresh inactivity period;
   * 3. the stale leader, if still attached, gets `leader.lost superseded`
   *    with a member token;
   * 4. lock and handoff mode from the requester; its vice only if valid;
   * 5. codes adopted from the requester's blob or rotated (M1);
   * 6. the requester gets `group.resumed {superseded: true}` with a new
   *    leader token, then the roster (with the recovery marker), and
   *    `codes.updated superseded` if the codes rotated; members get
   *    `leader.changed superseded`.
   */
  private async supersede(
    session: Session,
    record: GroupRecord,
    claims: TokenClaims,
    message: GroupResumeMessage,
    name: NameChoice,
  ): Promise<ServerMessage> {
    const app = session.app;
    const namespace = app.namespace;
    const now = this.now();
    const stale = record.leaderId;
    const codes = await this.joins.supersedeCodes(record, message.joinCodes);
    if (codes === 'exhausted') return errorMessage(ErrorCode.CODES_EXHAUSTED);

    // Step 1: the requester's list, as given (the stale list never applies to it).
    const blockList = [...new Set(message.blockList ?? [])].filter((id) => id !== claims.pid);
    const staleSession = this.sessionOf(record, stale);
    const result = await this.deps.store.setBlockList(namespace, record.id, blockList);
    for (const pid of result?.removed ?? []) this.detachRemoved(record, pid);
    const staleBlocked = blockList.includes(stale);
    if (staleBlocked && staleSession !== undefined) this.detachRemoved(record, stale);
    let current = (await this.deps.store.get(namespace, record.id)) ?? record;
    const gone = current.roster.filter((e) => blockList.includes(e.pid)).map((e) => e.pid);

    // Step 2 and 4.
    const viceId =
      message.viceId !== undefined &&
      message.viceId !== claims.pid &&
      !blockList.includes(message.viceId) &&
      findEntry(current.roster, message.viceId) !== undefined
        ? message.viceId
        : undefined;
    const participantIds = current.participantIds.filter(
      (pid) => pid !== stale || (!staleBlocked && staleSession !== undefined),
    );
    if (!participantIds.includes(claims.pid)) participantIds.push(claims.pid);
    const previousVice = current.viceId;
    current =
      (await this.deps.store.patch(namespace, record.id, {
        anchorTerm: claims.term,
        term: nextTerm(Math.max(current.term, claims.term), now, current.recoveredAt ?? 0),
        leaderId: claims.pid,
        displacedLeaderId: undefined,
        escalated: false,
        pause: undefined,
        keepAlivePending: false,
        lastActivityAt: now,
        leaderOnline: true,
        recoveryMarking: false,
        locked: message.locked ?? current.locked,
        handoff: message.handoff ?? current.handoff,
        viceId,
        participantIds,
        roster: removeFromRoster(current.roster, gone),
      })) ?? current;
    current = await this.enterRoster(current, claims.pid, name);
    if (previousVice !== undefined && previousVice !== viceId) {
      this.controls.tellVice(current, previousVice, false);
    }

    // Step 5.
    current = await this.joins.commitSupersedeCodes(current, codes.codes);

    // Timers: a fresh period for the new leader (RC13).
    this.timers.clear(namespace, record.id, 'grace');
    this.timers.clear(namespace, record.id, 'frozenEnd');
    this.lifecycle.stopKeepAlive(namespace, record.id);
    this.lifecycle.armKeepAlive(app, current);
    this.startRefresh(namespace, record.id, now);

    this.replaceOwner(namespace, record.id, claims.pid, session);
    this.attach(session, record.id, claims.pid);

    // Step 3.
    if (!staleBlocked && staleSession !== undefined) {
      this.deliverLater(staleSession, {
        type: 'leader.lost',
        groupId: record.id,
        reason: 'superseded',
        token: this.issueToken(namespace, current, stale, 'member', now),
        takeBackAvailable: false,
      });
    }
    // Step 6.
    this.deliverLater(session, this.rosterSnapshot(current));
    if (codes.rotated) {
      this.deliverLater(session, {
        type: 'codes.updated',
        groupId: record.id,
        reason: 'superseded',
        codes: this.joins.payload(current),
      });
    }
    await this.joins.onLeaderReturn(session, current);
    for (const pid of current.participantIds) {
      if (pid === claims.pid || pid === stale) continue;
      const member = this.sessionOf(current, pid);
      if (member !== undefined) {
        this.deliverLater(member, {
          type: 'leader.changed',
          groupId: record.id,
          reason: 'superseded',
        });
      }
    }
    this.deps.logger.info(
      { event: 'leader_superseded', namespace, groupRef: groupRef(record.id) },
      'stale leader superseded',
    );
    const reply = this.resumedMessage(current, claims.pid, false, now, codes.rotated);
    return reply.type === 'group.resumed' ? { ...reply, superseded: true } : reply;
  }

  /**
   * A member resumed a group that is not in memory (AC25): the connection is
   * parked until the leader recreates the group, or until no leader token
   * able to recreate it can exist any more. Runs under the group lock.
   */
  private parkMember(session: Session, claims: TokenClaims, name: NameChoice): ServerMessage {
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
    const older = this.parking.park(
      session,
      key,
      claims.gid,
      claims.pid,
      until,
      () => {
        this.runTimer(namespace, claims.gid, () => {
          if (session.parked?.groupKey === key && this.parking.unpark(session)) {
            const text = JSON.stringify({
              type: 'group.ended',
              groupId: claims.gid,
              reason,
            } satisfies ServerMessage);
            this.lock.effect(() => session.afterPending(() => session.deliver(text)));
          }
          return Promise.resolve();
        });
      },
      name,
    );
    // Several instances: a recreation elsewhere admits it here (12.10).
    this.deps.parked?.park(namespace, claims.gid, until);
    if (older !== undefined) {
      // One parked session per participant: newest wins (M5).
      const text = JSON.stringify({
        type: 'group.ended',
        groupId: claims.gid,
        reason: 'replaced',
      } satisfies ServerMessage);
      this.lock.effect(() => older.afterPending(() => older.deliver(text)));
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
    for (const { session: member, participantId, name } of this.parking.drain(
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
      const entered = await this.enterRoster(added.group, participantId, name);
      this.attach(member, record.id, participantId);
      this.tellReturningVice(entered, participantId);
      const token = this.issueToken(namespace, entered, participantId, 'member', this.now());
      this.deliverLater(member, this.joinedMessage(entered, participantId, token));
    }
  }

  /** Admits the members parked here if the group exists now. Under the group lock. */
  private async admitParkedNow(app: AppConfig, groupId: string): Promise<void> {
    if (!this.parking.has(groupKey(app.namespace, groupId))) return;
    const record = await this.deps.store.get(app.namespace, groupId);
    if (record !== undefined) await this.admitParked(app, record);
  }

  /** Stores a roster change (#13 D10). Runs under the group lock. */
  private async putRoster(record: GroupRecord, state: RosterState): Promise<GroupRecord> {
    const updated = await this.deps.store.patch(record.appNamespace, record.id, {
      roster: state.roster,
      nextAdmissionSeq: state.nextAdmissionSeq,
      nextGuestNumber: state.nextGuestNumber,
    });
    return updated ?? record;
  }

  /**
   * Admits `pid` to the roster with `name`, or marks its existing entry
   * connected (an existing entry keeps its name, Q5.3), and tells the
   * leader. Runs under the group lock.
   */
  private async enterRoster(
    record: GroupRecord,
    pid: string,
    name: NameChoice,
    marked = false,
  ): Promise<GroupRecord> {
    const now = this.now();
    const state = findEntry(record.roster, pid)
      ? { ...rosterStateOf(record), roster: setConnected(record.roster, pid, true, now) }
      : admitToRoster(rosterStateOf(record), pid, name, now, marked);
    const updated = await this.putRoster(record, state);
    if (pid !== updated.leaderId) this.rosterUpdated(updated, pid);
    return updated;
  }

  /**
   * A member's connection closed: its entry stays, disconnected; past the
   * cap the entry that disconnected first is evicted (#13 D10, RC10).
   */
  private async leaveRosterOnDisconnect(
    app: AppConfig,
    record: GroupRecord,
    pid: string,
  ): Promise<void> {
    const marked = setConnected(record.roster, pid, false, this.now());
    const { roster, evicted } = evictOverflow(marked, app.maxGroupSize, this.protectedPids(record));
    const updated = await this.putRoster(record, { ...rosterStateOf(record), roster });
    this.rosterUpdated(updated, pid);
    this.rosterRemoved(updated, evicted);
  }

  /** Roster entries that are never evicted (#13 D10, RC10). */
  private protectedPids(record: GroupRecord): Array<string | undefined> {
    return [record.leaderId, record.viceId, record.displacedLeaderId];
  }

  /** Sends `message` to the group's attached leader, after its pending replies. */
  private toLeader(record: GroupRecord, message: ServerMessage): void {
    const leader = this.recipientOf(record, record.leaderId);
    if (leader !== undefined) this.deliverLater(leader, message);
  }

  /** The whole roster, for the leader only (#13 AC31). */
  private rosterSnapshot(record: GroupRecord): ServerMessage {
    const now = this.now();
    return {
      type: 'roster.snapshot',
      groupId: record.id,
      participants: record.roster.map((entry) => toWire(entry, record, now)),
    };
  }

  /** One changed entry, to the leader (#13 AC31). */
  private rosterUpdated(record: GroupRecord, pid: string): void {
    const entry = findEntry(record.roster, pid);
    if (entry === undefined) return;
    this.toLeader(record, {
      type: 'roster.updated',
      groupId: record.id,
      participant: toWire(entry, record, this.now()),
    });
  }

  /** Entries that left the roster, to the leader (#13 AC31). */
  private rosterRemoved(record: GroupRecord, pids: readonly string[]): void {
    for (const participantId of pids) {
      this.toLeader(record, { type: 'roster.removed', groupId: record.id, participantId });
    }
  }

  /** The participant's own name for its reply (#13 AC36). */
  private ownName(record: GroupRecord, pid: string): { displayName: string; generated: boolean } {
    const entry = findEntry(record.roster, pid);
    return { displayName: entry?.name ?? '', generated: entry?.generated ?? true };
  }

  /**
   * Sends `message` to `session` after the replies it is already owed. In a
   * locked task it waits in the outbox until the task's state is committed.
   */
  private deliverLater(to: Target, message: ServerMessage): void {
    const text = JSON.stringify(message);
    if (isRecipient(to)) {
      to.send(text, true);
      return;
    }
    this.lock.effect(() => to.afterPending(() => to.deliver(text)));
  }

  /**
   * Sends `message` to every attached member (not the leader). The members
   * are resolved now, so a later detach in the same task does not change
   * who gets it; the frames go out with the task's other effects.
   */
  private toMembers(record: GroupRecord, message: ServerMessage): void {
    const members = this.memberIds(record)
      .map((pid) => this.recipientOf(record, pid))
      .filter((member) => member !== undefined);
    if (members.length === 0) return;
    const text = JSON.stringify(message);
    for (const member of members) member.send(text, false);
  }

  private resumedMessage(
    record: GroupRecord,
    participantId: string,
    recreated: boolean,
    now: number,
    codesChanged: boolean,
  ): ServerMessage {
    const base = {
      type: 'group.resumed' as const,
      groupId: record.id,
      participantId,
      role: 'leader' as const,
      ...this.ownName(record, participantId),
      metadata: record.metadata,
      token: this.issueToken(record.appNamespace, record, participantId, 'leader', now),
      recreated,
      // Codes go to the leader's connection only (#10 AC10, R13).
      joinMethods: [...record.joinMethods],
      codes: this.joins.payload(record),
      codesChanged,
      state: this.leaderState(record),
      superseded: false,
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
    name: NameChoice,
  ): Promise<ServerMessage> {
    const { app } = session;
    const namespace = app.namespace;
    // The store is idempotent per participant ID, so the replaced session's
    // slot is reused, not doubled. Refusals come first: a refused resume
    // leaves the older session attached (#13 security L-1).
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
    // Newest wins (AC20).
    this.replaceOwner(namespace, record.id, claims.pid, session);
    const entered = await this.enterRoster(added.group, claims.pid, name);
    this.attach(session, record.id, claims.pid);
    this.tellReturningVice(entered, claims.pid);
    // The displaced leader is back as a member: it may take back (AC24).
    if (claims.pid === entered.displacedLeaderId) {
      this.deliverLater(session, { type: 'takeback.offered', groupId: record.id });
    }
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
    const token = this.issueToken(app.namespace, entered, claims.pid, 'member', this.now());
    return this.joinedMessage(entered, claims.pid, token);
  }

  /**
   * Admits an approved joiner that waits on another instance (#35
   * architecture 12.9): the store-side admission (lock, size, block list,
   * roster), a registry entry naming that instance with a new attach ID,
   * and `group.joined` sent there in this commit. Under the group lock.
   */
  private async admitRemote(
    app: AppConfig,
    groupId: string,
    name: NameChoice,
    instance: string,
    requestId: string,
  ): Promise<ServerMessage> {
    const namespace = app.namespace;
    const current = await this.deps.store.get(namespace, groupId);
    if (current !== undefined && this.admissionClosed(current)) return GROUP_LOCKED;
    const participantId = newParticipantId();
    const added = await this.deps.store.addParticipant(
      namespace,
      groupId,
      participantId,
      app.maxGroupSize,
    );
    if (added.status === 'not_found') return errorMessage(ErrorCode.CODE_NOT_FOUND);
    if (added.status === 'blocked') return errorMessage(ErrorCode.PARTICIPANT_BLOCKED);
    if (added.status === 'full') {
      return errorMessage(ErrorCode.GROUP_FULL, { details: { maxGroupSize: app.maxGroupSize } });
    }
    const record = await this.enterRoster(
      added.group,
      participantId,
      name,
      added.group.recoveryMarking,
    );
    const attachId = newAttachId();
    this.deps.cluster!.attachedElsewhere(namespace, groupId, participantId, instance, attachId);
    const joined = this.joinedMessage(
      record,
      participantId,
      this.issueToken(namespace, record, participantId, 'member', this.now()),
    );
    this.deps.cluster!.host.send(instance, {
      op: 'admit',
      ns: namespace,
      gid: groupId,
      pid: participantId,
      att: attachId,
      rid: requestId,
      text: JSON.stringify(joined),
    });
    this.deps.logger.info(
      { event: 'group_joined', namespace, groupRef: groupRef(groupId), method: 'B' },
      'group joined',
    );
    return joined;
  }

  /**
   * An approved joiner was gone when its admission arrived (#35 Gate 2
   * Q-B3): under the lease, the member-disconnect rules run for `pid`, only
   * while the registry still names that attachment. Busy or failed: the
   * group is replayed (security C13).
   */
  private disconnectStale(namespace: string, groupId: string, pid: string, attachId: string): void {
    const app = this.deps.appOf(namespace);
    if (app === undefined) return;
    this.lock
      .run(namespace, groupId, async () => {
        if (this.deps.cluster?.entries(namespace, groupId).get(pid)?.t !== attachId) return;
        // A session here that holds that attachment is attached: nothing to do.
        const held = this.deps.notifier.get(membershipKey(namespace, groupId, pid));
        if (held?.membership?.attachId === attachId && held.isOpen()) return;
        const record = await this.deps.store.get(namespace, groupId);
        if (record === undefined || record.leaderId === pid) return;
        const result = await this.deps.store.removeParticipant(namespace, groupId, pid);
        await this.leaveRosterOnDisconnect(app, record, pid);
        if (result && result.connected === 0) await this.emptied(app, groupId);
      })
      .catch((err: unknown) => {
        if (err instanceof StorageUnavailableError || err instanceof StorageBusyError) {
          this.queueReplay(namespace, groupId);
          return;
        }
        this.deps.logger.error({ event: 'remote_effect_error', err: safeErr(err) }, 'stale failed');
      });
  }

  async disconnect(session: Session): Promise<void> {
    this.checkLimiter.forget(session.connectionId);
    this.recreateLimiter.forget(session.connectionId);
    this.createLimiter.forget(session.connectionId);
    await this.joins.onDisconnect(session);
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
    // A clean stop with Redis leaves the stored attachments: the restart
    // sweep disconnects them with a full grace from the restart (#35 AC11).
    if (this.closing && this.deps.keepAttachmentsOnClose === true) return;

    // Under the group lock, so a join cannot land between the removal and
    // the delete. If Redis is down, the group is replayed when it is back.
    await this.lock
      .run(namespace, groupId, async () => {
        // #13 RC19: the participant resumed on a new socket before this close
        // was handled; that session owns the membership, so nothing changes.
        // Attached elsewhere (another instance's session owns it) or anew
        // here: nothing changes (M4).
        const owner = this.recipient(namespace, groupId, participantId);
        if (owner instanceof RemoteRecipient || isParticipantConnected(owner)) return;
        const record = await this.deps.store.get(namespace, groupId);
        if (record === undefined) return;
        // The role is read from the live record, never from the session (#13 D1).
        if (record.leaderId === participantId) {
          await this.leaderOffline(app, groupId);
          return;
        }
        const result = await this.deps.store.removeParticipant(namespace, groupId, participantId);
        await this.leaveRosterOnDisconnect(app, record, participantId);
        if (result && result.connected === 0) await this.emptied(app, groupId);
      })
      .catch((err: unknown) => {
        // Redis down, or another instance held the group too long (12.4):
        // the disconnect is replayed later.
        if (!(err instanceof StorageUnavailableError) && !(err instanceof StorageBusyError)) {
          throw err;
        }
        this.queueReplay(namespace, groupId);
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
    const offline = await this.deps.store.setLeaderOnline(namespace, groupId, false);
    this.refresher.clear(groupKey(namespace, groupId));
    if (!offline) return;
    const record = await this.putRoster(offline, {
      ...rosterStateOf(offline),
      roster: setConnected(offline.roster, offline.leaderId, false, this.now()),
    });
    // Nobody to prompt while the leader is away (#13 6.3).
    this.lifecycle.stopKeepAlive(namespace, groupId);
    if (connectedCount(record) === 0) {
      await this.lifecycle.hold(app, record);
      return;
    }
    this.deps.logger.info(
      { event: 'group_frozen', namespace, groupRef: groupRef(groupId) },
      'leader offline',
    );
    // A pause with a grace period (#13 6.4, AC14); a running inactive pause
    // keeps its grace end.
    await this.lifecycle.pause(app, record, 'offline');
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
    this.timers.arm(namespace, groupId, 'frozenEnd', at);
  }

  /**
   * The orphan sweep of one group (#35 architecture 12.8, AC21, AC11), under
   * the group lease: every connected participant nobody holds any more (its
   * instance stopped or died, or a PR 1 group with no registry) is
   * disconnected with the usual rules; `restart` adds the Q-A3 floor.
   * Nobody whose session is gone is told anything; participants still
   * attached elsewhere get the usual `leader.offline` and roster frames.
   * Returns how many participants it disconnected.
   */
  async sweepGroup(namespace: string, groupId: string, restart: boolean): Promise<number> {
    const app = this.deps.appOf(namespace);
    if (app === undefined) return 0;
    return this.lock.run(namespace, groupId, () => this.reconcile(app, groupId, restart));
  }

  /** True when an open session owns any membership of the group (#13 RC19). */
  private anyoneAttached(record: GroupRecord): boolean {
    return record.participantIds.some((id) => isParticipantConnected(this.recipientOf(record, id)));
  }

  /** Clears every per-group structure; frees the group's join codes (#10 AC11). */
  private async forgetGroup(
    namespace: string,
    groupId: string,
    record: GroupRecord | undefined,
  ): Promise<void> {
    const key = groupKey(namespace, groupId);
    this.deps.rateLimiter.forget(key);
    this.controls.forgetGroup(namespace, groupId);
    this.timers.clearGroup(namespace, groupId);
    this.refresher.clear(key);
    await this.joins.onGroupGone(namespace, groupId, record);
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
    reason: GroupEndedReason | 'empty',
    requester?: Session,
  ): Promise<void> {
    const namespace = app.namespace;
    const record = await this.deps.store.get(namespace, groupId);
    if (reason === 'empty' && record !== undefined && this.anyoneAttached(record)) {
      // #13 RC19: an empty end with someone attached would end a live group
      // without telling them. The callers re-check first, so this is a bug.
      this.deps.logger.error(
        { event: 'empty_end_refused', namespace, groupRef: groupRef(groupId) },
        'refused to end a group as empty while a participant is attached',
      );
      return;
    }
    await this.deps.store.delete(namespace, groupId);
    await this.forgetGroup(namespace, groupId, record);
    // Remembered until its max-session deadline, as a hashed ref only (Q8),
    // for every end including `empty` (#13 D15). A group recreated in this
    // process gets a guard: its pre-restart leader tokens are not covered
    // by the `iat` fence until their `lat` window passed (#13 6.9 layer 1).
    if (record) {
      const deadline = this.maxSessionEndAt(app, record);
      const epoch = record.recoveredAt === undefined ? 0 : await this.epoch();
      const guardUntil =
        record.recoveredAt === undefined
          ? undefined
          : Math.min(
              deadline,
              epoch +
                app.inactivityLimitMinutes * MINUTE_MS +
                this.deps.refresh.maxMs +
                MAX_CLOCK_SKEW_MS,
            );
      await this.deps.ended.remember(namespace, groupId, deadline, guardUntil);
    }
    let notified = 0;
    // `empty` has no wire reason: nobody is attached to be told (#13 6.9).
    if (reason !== 'empty') {
      const ended = JSON.stringify({
        type: 'group.ended',
        groupId,
        reason,
      } satisfies ServerMessage);
      for (const pid of record?.participantIds ?? []) {
        const participant = this.recipient(namespace, groupId, pid);
        if (participant === undefined) continue;
        notified += 1;
        // The requester gets group.ended as its direct reply instead.
        const isRequester =
          participant instanceof LocalRecipient && participant.session === requester;
        participant.detach('ended', isRequester ? undefined : ended);
      }
    }
    // Other instances drop their per-group state too (12.7).
    for (const instance of this.deps.cluster?.others(namespace, groupId) ?? []) {
      this.deps.cluster!.host.send(instance, { op: 'forget', ns: namespace, gid: groupId });
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

/** The block list after adding `list`: deduplicated, never the leader (#13 D5). */
function blockListUnion(record: GroupRecord, list: readonly string[]): string[] {
  return [...new Set([...record.blockList, ...list])].filter((id) => id !== record.leaderId);
}

/** BLOCK_LIST_FULL: a union past the cap changes nothing (#13 Q-C). */
function blockListFull(): ErrorMessage {
  return errorMessage(ErrorCode.BLOCK_LIST_FULL, {
    details: { maxBlockList: MAX_BLOCK_LIST_SIZE },
  });
}
