import type { ServerMessage } from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import type { GroupPause, GroupRecord, GroupStore } from '../groups/group-store.js';
import type { GroupTimers } from '../groups/group-timers.js';
import type { Session } from '../groups/session.js';
import { type Logger, groupRef } from '../logging/logger.js';

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

  /** The grace period ended (#13 6.4). */
  private async onGraceEnd(
    app: AppConfig,
    groupId: string,
    term: number,
    graceEndsAt: number,
  ): Promise<void> {
    const record = await this.host.store.get(app.namespace, groupId);
    // Stale: the group is gone, live again, or a new leader leads (RC13).
    if (record === undefined || record.term !== term) return;
    if (record.pause?.graceEndsAt !== graceEndsAt) return;
    await this.graceEnded(app, record);
  }

  /**
   * After the grace period with the leader still away: nobody to hand off
   * to yet, so the group stays paused until the frozen bound (#13 AC21).
   */
  protected async graceEnded(app: AppConfig, record: GroupRecord): Promise<void> {
    this.host.logger.info(
      { event: 'grace_ended', namespace: app.namespace, groupRef: groupRef(record.id) },
      'grace period ended',
    );
    return Promise.resolve();
  }
}
