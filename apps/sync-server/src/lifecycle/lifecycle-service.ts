import type {
  JoinCodesPayload,
  LeaderState,
  LeadershipReason,
  ServerMessage,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import {
  type GroupPause,
  type GroupRecord,
  type GroupStore,
  connectedCount,
  pauseDeadline,
} from '../groups/group-store.js';
import type { GroupTimers } from '../groups/group-timers.js';
import type { Session } from '../groups/session.js';
import { type Logger, groupRef } from '../logging/logger.js';
import { nextTerm, pickSuccessor } from './succession.js';

const MINUTE_MS = 60_000;

/** What the lifecycle needs from GroupService (the facade). */
export interface LifecycleHost {
  store: GroupStore;
  timers: GroupTimers;
  logger: Logger;
  /** Runs a timer callback under the group lock; failures are logged. */
  runTimer(namespace: string, groupId: string, task: () => Promise<void>): void;
  /** The attached session of the group's leader, if any. */
  leaderSession(record: GroupRecord): Session | undefined;
  /** Sends `message` to `session` after the replies it is already owed. */
  deliverLater(session: Session, message: ServerMessage): void;
  /** Counts a leader activity for the token refresh (#5 AC12). */
  refresherActivity(namespace: string, groupId: string, at: number): void;
  /** Sends `message` to every attached member (not the leader). */
  toMembers(record: GroupRecord, message: ServerMessage): void;
  /** Arms the frozen bound, or ends the group if it passed (#5 AC21). */
  scheduleFrozenEnd(app: AppConfig, record: GroupRecord): Promise<void>;
  /** The session attached as `pid`, if any. */
  sessionOf(record: GroupRecord, pid: string): Session | undefined;
  /** A token for `pid` with the record's current claims (term, gct, lat). */
  issueToken(record: GroupRecord, pid: string, role: 'leader' | 'member'): string;
  /** The leader recovery state (#13 D13). */
  leaderState(record: GroupRecord): LeaderState;
  /** The leader-only codes payload with a fresh blob. */
  codesPayload(record: GroupRecord): JoinCodesPayload;
  /** The whole roster for the leader. */
  rosterSnapshot(record: GroupRecord): ServerMessage;
  /** Re-sends pending approval requests and a running door pause to a new leader. */
  onLeaderReturn(leader: Session, record: GroupRecord): void;
  /** Restarts the leader-token refresh for the group's online leader. */
  startRefresh(namespace: string, groupId: string, at: number): void;
  /** Ends the group for everyone with `inactivity` (#13 AC22). */
  endInactive(app: AppConfig, groupId: string): Promise<void>;
  /** Ends a group nobody is connected to (#13 D15). */
  endEmpty(app: AppConfig, groupId: string): Promise<void>;
  /** True when an open session owns any membership of the group (#13 RC19). */
  anyoneAttached(record: GroupRecord): boolean;
  now(): number;
}

function keyOf(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

/** A pause as members see it: the wire cause and the grace left (#13 D8, D12). */
export function pauseOnWire(
  pause: GroupPause,
  now: number,
): { cause: 'disconnected' | 'inactive'; graceMs?: number } {
  const cause = pause.cause === 'offline' ? 'disconnected' : 'inactive';
  return pause.graceEndsAt === undefined
    ? { cause }
    : { cause, graceMs: Math.max(0, pause.graceEndsAt - now) };
}

/**
 * The group lifecycle (#13 section 6): leader activity and keep-alive. Every
 * entry point runs under the group lock, and every timer callback takes the
 * lock, re-reads the record and re-arms itself if activity moved its
 * deadline (lazy timers, D7), so an activity never has to touch a timer
 * unless it must tell the leader something.
 */
export class LifecycleService {
  constructor(private readonly host: LifecycleHost) {}

  /** Leader inactivity limit of the app, ms. */
  private limitMs(app: AppConfig): number {
    return app.inactivityLimitMinutes * MINUTE_MS;
  }

  /** When the keep-alive prompt is due: the limit minus the countdown (#13 AC16). */
  private promptAt(app: AppConfig, record: GroupRecord): number {
    return record.lastActivityAt + this.limitMs(app) - app.keepAliveCountdownSeconds * 1000;
  }

  /**
   * Arms the keep-alive prompt for an online leader (#13 6.3): on create,
   * return, recreation, and after an answered prompt. Lazy: if activity
   * moved the deadline when it fires, it re-arms.
   */
  armKeepAlive(app: AppConfig, record: GroupRecord): void {
    const namespace = app.namespace;
    const groupId = record.id;
    this.host.timers.armKind(
      keyOf(namespace, groupId),
      'keepAlivePrompt',
      this.promptAt(app, record),
      () => {
        this.host.runTimer(namespace, groupId, () => this.onPrompt(app, groupId));
      },
    );
  }

  /** Cancels the prompt and its deadline (leader offline, handoff, end). */
  stopKeepAlive(namespace: string, groupId: string): void {
    const key = keyOf(namespace, groupId);
    this.host.timers.clearKind(key, 'keepAlivePrompt');
    this.host.timers.clearKind(key, 'keepAliveDeadline');
  }

  /**
   * A counted leader activity at `at` (#13 6.2, AC15): an accepted position
   * update, `leader.activity`, `keepalive.ack` or any accepted leader
   * action. Moves `lastActivityAt` and counts for the token refresh. An
   * outstanding prompt is answered: the leader gets `keepalive.cleared`
   * after its reply and the prompt is armed again. Under the group lock.
   */
  async activity(
    app: AppConfig,
    record: GroupRecord,
    at: number,
    leader: Session | undefined,
  ): Promise<GroupRecord> {
    const namespace = app.namespace;
    const answered = record.keepAlivePending;
    let updated =
      (await this.host.store.patch(namespace, record.id, {
        lastActivityAt: Math.max(record.lastActivityAt, at),
        keepAlivePending: false,
        // A leader that acted once is like any other leader (#13 D9, Q-B).
        escalated: false,
      })) ?? record;
    // An inactive pause ends with the leader's next counted activity (6.2).
    if (updated.pause?.cause === 'inactive') updated = await this.unpause(app, updated);
    this.host.refresherActivity(namespace, record.id, at);
    if (answered) {
      this.host.timers.clearKind(keyOf(namespace, record.id), 'keepAliveDeadline');
      this.armKeepAlive(app, updated);
      if (leader !== undefined) {
        this.host.deliverLater(leader, { type: 'keepalive.cleared', groupId: record.id });
      }
    }
    return updated;
  }

  /** The prompt timer (#13 6.3). Stale if the leader went away; re-arms if activity moved it. */
  private async onPrompt(app: AppConfig, groupId: string): Promise<void> {
    const namespace = app.namespace;
    const record = await this.host.store.get(namespace, groupId);
    if (record === undefined || !record.leaderOnline || record.keepAlivePending) return;
    const now = this.host.now();
    if (this.promptAt(app, record) > now) {
      this.armKeepAlive(app, record);
      return;
    }
    const deadline = record.lastActivityAt + this.limitMs(app);
    const updated =
      (await this.host.store.patch(namespace, groupId, { keepAlivePending: true })) ?? record;
    const leader = this.host.leaderSession(updated);
    if (leader !== undefined) {
      this.host.deliverLater(leader, {
        type: 'keepalive.prompt',
        groupId,
        countdownMs: Math.max(0, deadline - now),
      });
    }
    this.host.logger.info(
      { event: 'keepalive_prompted', namespace, groupRef: groupRef(groupId) },
      'keep-alive prompt sent',
    );
    this.host.timers.armKind(keyOf(namespace, groupId), 'keepAliveDeadline', deadline, () => {
      this.host.runTimer(namespace, groupId, () => this.onDeadline(app, groupId));
    });
  }

  /** The countdown ended (#13 AC17, AC22). Stale if answered or the leader went away. */
  private async onDeadline(app: AppConfig, groupId: string): Promise<void> {
    const namespace = app.namespace;
    const record = await this.host.store.get(namespace, groupId);
    if (record === undefined || !record.keepAlivePending || !record.leaderOnline) return;
    if (record.lastActivityAt + this.limitMs(app) > this.host.now()) return;
    this.host.logger.info(
      { event: 'keepalive_missed', namespace, groupRef: groupRef(groupId) },
      'keep-alive missed',
    );
    // One-step escalation (AC22): a leader that got the lead through a
    // missed keep-alive and missed its own ends the group, with no grace.
    if (record.escalated) {
      await this.host.endInactive(app, groupId);
      return;
    }
    // The first leader to miss it: freeze for the grace period (AC17, Q1.2).
    await this.pause(app, record, 'inactive');
  }

  /**
   * Pauses the group (#13 6.4, D8, AC14, AC17): members get `leader.offline`
   * with the cause and, in `auto` mode, the grace left. A running pause
   * keeps its earlier grace end when its cause changes (no extension). The
   * grace timer (auto) and the frozen bound are armed. Under the group lock.
   */
  async pause(
    app: AppConfig,
    record: GroupRecord,
    cause: GroupPause['cause'],
  ): Promise<GroupRecord> {
    const namespace = app.namespace;
    const now = this.host.now();
    let graceEndsAt: number | undefined;
    if (record.handoff === 'auto') {
      graceEndsAt = record.pause?.graceEndsAt ?? now + app.disconnectGraceSeconds * 1000;
    }
    const pause: GroupPause = graceEndsAt === undefined ? { cause } : { cause, graceEndsAt };
    const updated = (await this.host.store.patch(namespace, record.id, { pause })) ?? record;
    this.host.toMembers(updated, {
      type: 'leader.offline',
      groupId: record.id,
      ...pauseOnWire(pause, now),
    });
    this.host.logger.info(
      { event: 'group_paused', namespace, groupRef: groupRef(record.id), cause },
      'group paused',
    );
    if (graceEndsAt !== undefined) this.armGrace(app, updated, graceEndsAt);
    await this.host.scheduleFrozenEnd(app, updated);
    return updated;
  }

  /**
   * Ends a pause (#13 6.2, AC14): the leader returned or acted. Members get
   * `leader.online`; the grace and frozen-end timers go. Under the lock.
   */
  async unpause(app: AppConfig, record: GroupRecord): Promise<GroupRecord> {
    if (record.pause === undefined) return record;
    const namespace = app.namespace;
    const updated =
      (await this.host.store.patch(namespace, record.id, { pause: undefined })) ?? record;
    const key = keyOf(namespace, record.id);
    this.host.timers.clearKind(key, 'grace');
    this.host.timers.clearFrozenEnd(key);
    this.host.toMembers(updated, { type: 'leader.online', groupId: record.id });
    this.host.logger.info(
      { event: 'group_unpaused', namespace, groupRef: groupRef(record.id) },
      'group live again',
    );
    return updated;
  }

  /** Arms the grace end of a pause (#13 6.4). Stale if the term or the pause changed. */
  private armGrace(app: AppConfig, record: GroupRecord, at: number): void {
    const namespace = app.namespace;
    const groupId = record.id;
    const term = record.term;
    this.host.timers.armKind(keyOf(namespace, groupId), 'grace', at, () => {
      this.host.runTimer(namespace, groupId, () => this.onGraceEnd(app, groupId, term, at));
    });
  }

  /**
   * The pause deadline passed (#13 6.4, Q-G): the grace end, or the end of
   * an empty group's hold.
   */
  private async onGraceEnd(
    app: AppConfig,
    groupId: string,
    term: number,
    deadline: number,
  ): Promise<void> {
    const record = await this.host.store.get(app.namespace, groupId);
    // Stale: the group is gone, live again, or a new leader leads (RC13).
    if (record === undefined || record.term !== term) return;
    if (pauseDeadline(record.pause) !== deadline) return;
    // RC21 (c): still nobody connected at the deadline: the group ends, in
    // both modes, never falling back to the frozen bound.
    if (this.isEmpty(record)) {
      await this.host.endEmpty(app, groupId);
      return;
    }
    if (record.pause?.graceEndsAt === deadline) await this.graceEnded(app, record);
  }

  /** Nobody is connected: no attached member and the leader offline (#13 Q-G). */
  isEmpty(record: GroupRecord): boolean {
    return connectedCount(record) === 0 && !this.host.anyoneAttached(record);
  }

  /**
   * Holds a group that just emptied (#13 Q-G, RC21): instead of ending at
   * once, it stays in memory, paused, until one deadline that is never
   * extended: the running grace end (auto), or a hold end set once (frozen).
   * While held nobody new is admitted (`GROUP_LOCKED`); only token resumes
   * re-attach. If that deadline already passed, the group ends now. Under
   * the group lock, after the RC19 re-check.
   */
  async hold(app: AppConfig, record: GroupRecord): Promise<void> {
    const namespace = app.namespace;
    const now = this.host.now();
    const running = pauseDeadline(record.pause);
    const deadline = running ?? now + app.disconnectGraceSeconds * 1000;
    // The leader is offline, so the cause is `offline` (D8 invariant).
    const pause: GroupPause =
      running !== undefined
        ? { ...record.pause!, cause: 'offline' }
        : record.handoff === 'auto'
          ? { cause: 'offline', graceEndsAt: deadline }
          : { ...record.pause, cause: 'offline', holdEndsAt: deadline };
    const hadPause = record.pause !== undefined;
    record = (await this.host.store.patch(namespace, record.id, { pause })) ?? record;
    if (!hadPause) {
      await this.host.scheduleFrozenEnd(app, record);
      if ((await this.host.store.get(namespace, record.id)) === undefined) return;
    }
    if (deadline <= now) {
      await this.host.endEmpty(app, record.id);
      return;
    }
    this.armGrace(app, record, deadline);
    this.host.logger.info(
      { event: 'group_held', namespace, groupRef: groupRef(record.id) },
      'empty group held',
    );
  }

  /**
   * The grace period ended with the leader still away (#13 6.4, AC20): in
   * `auto` mode the lead passes to the successor. With nobody eligible the
   * group stays paused until the frozen bound, like frozen mode (AC21).
   */
  private async graceEnded(app: AppConfig, record: GroupRecord): Promise<void> {
    const successor = pickSuccessor(record, (pid) => {
      const session = this.host.sessionOf(record, pid);
      return session !== undefined && session.isOpen();
    });
    if (record.handoff !== 'auto' || successor === undefined || record.pause === undefined) {
      this.host.logger.info(
        { event: 'grace_ended', namespace: app.namespace, groupRef: groupRef(record.id) },
        'grace period ended without a handoff',
      );
      return;
    }
    const reason = record.pause.cause === 'inactive' ? 'handoff_inactivity' : 'handoff_disconnect';
    await this.handoff(app, record, successor, reason);
  }

  /**
   * Hands the lead to `successor` (#13 6.5, AC20, AC23, RC13), in one step
   * under the group lock: a new term from `nextTerm` with the recovery
   * floor, the old leader displaced (the take-back slot), the escalation
   * flag set only for an inactivity handoff, the vice cleared if it is the
   * successor, the pause and keep-alive cleared, and a fresh inactivity
   * period. The old leader leaves the leader slot if it is offline. Then
   * the new leader gets `leader.granted`, the roster, pending requests; an
   * attached old leader gets `leader.lost` with a member token; everyone
   * else `leader.changed`.
   */
  async handoff(
    app: AppConfig,
    record: GroupRecord,
    successor: string,
    reason: 'handoff_disconnect' | 'handoff_inactivity' | 'take_back',
  ): Promise<{ record: GroupRecord; granted: ServerMessage }> {
    const namespace = app.namespace;
    const now = this.host.now();
    const old = record.leaderId;
    const oldSession = this.host.sessionOf(record, old);
    const oldAttached = oldSession !== undefined && oldSession.isOpen();
    const participantIds = oldAttached
      ? record.participantIds
      : record.participantIds.filter((pid) => pid !== old);
    const updated =
      (await this.host.store.patch(namespace, record.id, {
        term: nextTerm(record.term, now, record.recoveredAt ?? 0),
        leaderId: successor,
        displacedLeaderId: old,
        escalated: reason === 'handoff_inactivity',
        viceId: record.viceId === successor ? undefined : record.viceId,
        lastActivityAt: now,
        leaderOnline: true,
        pause: undefined,
        keepAlivePending: false,
        participantIds,
      })) ?? record;
    const key = keyOf(namespace, record.id);
    this.host.timers.clearKind(key, 'grace');
    this.host.timers.clearFrozenEnd(key);
    this.stopKeepAlive(namespace, record.id);
    this.armKeepAlive(app, updated);
    this.host.startRefresh(namespace, record.id, now);
    const granted = this.announce(
      updated,
      successor,
      old,
      reason,
      oldAttached ? oldSession : undefined,
    );
    this.host.logger.info(
      { event: 'leader_handoff', namespace, groupRef: groupRef(record.id), handoffReason: reason },
      'leadership handed over',
    );
    return { record: updated, granted };
  }

  /**
   * Tells the new leader, the old leader and everyone else (#13 AC23).
   * Returns `leader.granted`; a take-back sends it as the reply instead of
   * an event (the roster and the pending requests follow either way).
   */
  private announce(
    record: GroupRecord,
    successor: string,
    old: string,
    reason: 'handoff_disconnect' | 'handoff_inactivity' | 'take_back',
    oldSession: Session | undefined,
  ): ServerMessage {
    const granted: ServerMessage = {
      type: 'leader.granted',
      groupId: record.id,
      reason,
      token: this.host.issueToken(record, successor, 'leader'),
      state: this.host.leaderState(record),
      joinMethods: [...record.joinMethods],
      codes: this.host.codesPayload(record),
    };
    const leader = this.host.sessionOf(record, successor);
    if (leader !== undefined) {
      if (reason !== 'take_back') this.host.deliverLater(leader, granted);
      this.host.deliverLater(leader, this.host.rosterSnapshot(record));
      this.host.onLeaderReturn(leader, record);
    }
    if (oldSession !== undefined) {
      this.host.deliverLater(oldSession, {
        type: 'leader.lost',
        groupId: record.id,
        reason,
        token: this.host.issueToken(record, old, 'member'),
        takeBackAvailable: record.displacedLeaderId === old,
      });
    }
    const changed: ServerMessage = {
      type: 'leader.changed',
      groupId: record.id,
      reason: reason satisfies LeadershipReason,
    };
    for (const pid of record.participantIds) {
      if (pid === successor || pid === old) continue;
      const session = this.host.sessionOf(record, pid);
      if (session !== undefined) this.host.deliverLater(session, changed);
    }
    return granted;
  }
}
