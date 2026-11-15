import { randomBytes } from 'node:crypto';
import type { HeldLease, LeaseSource } from '../../groups/group-lock.js';
import {
  GROUP_LEASE_MAX_HOLD_MS,
  GROUP_LEASE_MS,
  GROUP_LEASE_RENEW_MS,
  GROUP_LOCK_WAIT_MS,
} from '../../limits/constants.js';
import { groupRef } from '../../logging/logger.js';
import { InstanceFencedError, StorageBusyError } from '../errors.js';
import { LEASE_RELEASE, LEASE_RENEW } from './scripts.js';
import type { RedisContext } from './unit-of-work.js';

/** The group lease timings (#35 architecture 12.4, Gate 2 Q-B5); tests shorten them. */
export interface LeaseTimings {
  /** The lease lives this long after each renewal. */
  leaseMs: number;
  /** A running task renews it this often. */
  renewMs: number;
  /** Renewals stop after this long (the fence then refuses the commit). */
  maxHoldMs: number;
  /** How long a task waits for a lease another instance holds. */
  waitMs: number;
}

export const LEASE_TIMINGS: LeaseTimings = {
  leaseMs: GROUP_LEASE_MS,
  renewMs: GROUP_LEASE_RENEW_MS,
  maxHoldMs: GROUP_LEASE_MAX_HOLD_MS,
  waitMs: GROUP_LOCK_WAIT_MS,
};

/** The longest single back-off between two tries, ms. */
const MAX_BACKOFF_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The per-group lease lock across instances (#35 architecture 12.4, ADR
 * 0011, security P2-7). `acquire` runs inside the local per-group queue:
 * `SET NX PX` with a random token, retried with full-jitter back-off until
 * the wait bound, then `StorageBusyError`. The holder renews while the task
 * runs (compare-and-expire), up to a hold cap, and releases with
 * compare-and-delete. Every commit of the task checks the token first (the
 * fence), so a task that lost its lease never writes.
 */
export class RedisLeaseSource implements LeaseSource {
  constructor(
    private readonly ctx: RedisContext,
    private readonly timings: LeaseTimings = LEASE_TIMINGS,
    /** The synchronous instance guard (security C11); false without instances. */
    private readonly fenced: () => boolean = () => false,
    private readonly random: () => number = Math.random,
  ) {}

  async acquire(namespace: string, groupId: string): Promise<HeldLease> {
    // Security C11: a fenced instance takes no lease.
    if (this.fenced()) throw new InstanceFencedError();
    const key = this.ctx.keys.lock(namespace, groupId);
    // 16 bytes from the CSPRNG (security C16).
    const token = randomBytes(16).toString('hex');
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const reply = await this.ctx.link.send([
        'SET',
        key,
        token,
        'NX',
        'PX',
        String(this.timings.leaseMs),
      ]);
      if (reply === 'OK') break;
      if (Date.now() - started >= this.timings.waitMs) {
        this.ctx.logger.debug(
          { event: 'group_lock_busy', groupRef: groupRef(groupId) },
          'group lease busy',
        );
        throw new StorageBusyError();
      }
      const cap = Math.min(MAX_BACKOFF_MS, 5 * 2 ** Math.min(attempt, 10));
      await sleep(Math.floor(this.random() * cap));
    }
    if (this.fenced()) {
      await this.release(key, token);
      throw new InstanceFencedError();
    }
    return this.hold(key, token, groupId);
  }

  private hold(key: string, token: string, groupId: string): HeldLease {
    const acquiredAt = Date.now();
    let renewing = false;
    const lease: HeldLease = {
      key,
      token,
      lost: false,
      release: async () => {
        clearInterval(timer);
        await this.release(key, token);
      },
    };
    const timer = setInterval(() => {
      if (renewing) return;
      if (Date.now() - acquiredAt >= this.timings.maxHoldMs) {
        // A task this long is a bug: let the lease lapse; its commit aborts.
        clearInterval(timer);
        this.ctx.logger.warn(
          { event: 'group_lease_hold_cap', groupRef: groupRef(groupId) },
          'group task held its lease too long',
        );
        return;
      }
      renewing = true;
      this.ctx.link
        .script(LEASE_RENEW, [key], [token, String(this.timings.leaseMs)])
        .then((reply) => {
          if (Number(reply) !== 1) lease.lost = true;
        })
        .catch(() => {
          lease.lost = true;
        })
        .finally(() => {
          renewing = false;
        });
    }, this.timings.renewMs);
    timer.unref();
    return lease;
  }

  private async release(key: string, token: string): Promise<void> {
    try {
      await this.ctx.link.script(LEASE_RELEASE, [key], [token]);
    } catch {
      // It expires with its TTL.
    }
  }
}
