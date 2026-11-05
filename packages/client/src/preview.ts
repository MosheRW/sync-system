import type { JsonValue } from '@sync-system/protocol';
import { now } from './host.js';

/** At most one `leader.activity` per this interval from the preview helper (#13 8.2). */
export const LEADER_ACTIVITY_MIN_INTERVAL_MS = 10_000;

/** What the preview helper needs from the client. */
export interface PreviewHost {
  /** True while this client leads an active group. */
  isLeader(): boolean;
  /** The group's current position (what members see), if any. */
  groupPosition(): JsonValue | undefined;
  /** Sends a normal position update (moves the group). */
  updatePosition(position: JsonValue): void;
  /** Sends `leader.activity` (no payload). */
  sendActivity(): Promise<void>;
}

/** The preview state (#13 AC41). Positions are opaque and never leave the client. */
export interface PreviewState {
  readonly active: boolean;
  /** Where the group is: the last position sent to the members. */
  readonly groupPosition: JsonValue | undefined;
  /** Where the leader looks while previewing; undefined when not previewing. */
  readonly previewPosition: JsonValue | undefined;
}

/**
 * The leader's private preview (#13 AC41, Q6.1, Q6.2), framework-free: the
 * leader browses ahead without moving the group. While it is active the
 * helper never sends a position; it only tells the server "the leader is
 * active" with a throttled `leader.activity` (at most one per 10 s), so
 * the keep-alive does not fire. The previewed position is never sent,
 * stored or logged. `bringGroupHere()` moves the group to the preview
 * with one normal position update; `returnToGroup()` just ends it.
 */
export class LeaderPreview {
  #active = false;
  #previewPosition: JsonValue | undefined;
  #lastActivityAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly host: PreviewHost) {}

  /** Starts previewing at the group's position (or `position`). */
  start(position?: JsonValue): void {
    this.#active = true;
    this.#previewPosition = position ?? this.host.groupPosition();
    this.#touch();
  }

  /** The leader moved inside the preview: nothing is sent but a throttled activity. */
  move(position: JsonValue): void {
    if (!this.#active) return;
    this.#previewPosition = position;
    this.#touch();
  }

  /** Ends the preview without moving the group. */
  end(): void {
    this.#active = false;
    this.#previewPosition = undefined;
  }

  /** Moves the group to the previewed position (one normal update), then ends the preview. */
  bringGroupHere(): void {
    if (!this.#active || this.#previewPosition === undefined) {
      this.end();
      return;
    }
    const target = this.#previewPosition;
    this.end();
    this.host.updatePosition(target);
  }

  /** Back to the group's position; the group never moved. Returns that position. */
  returnToGroup(): JsonValue | undefined {
    this.end();
    return this.host.groupPosition();
  }

  getState(): PreviewState {
    return Object.freeze({
      active: this.#active,
      groupPosition: this.host.groupPosition(),
      previewPosition: this.#active ? this.#previewPosition : undefined,
    });
  }

  /** A throttled `leader.activity`, only while leading (#13 AC30). */
  #touch(): void {
    if (!this.host.isLeader()) return;
    const time = now();
    if (time - this.#lastActivityAt < LEADER_ACTIVITY_MIN_INTERVAL_MS) return;
    this.#lastActivityAt = time;
    void this.host.sendActivity().catch(() => undefined);
  }
}
