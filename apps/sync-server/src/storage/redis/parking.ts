import type { RedisContext, RedisWorkSource } from './unit-of-work.js';
import { INSTANCE_ID_PATTERN } from './keys.js';

/**
 * Which instances hold a parked member of a missing group (#35 architecture
 * 12.10): a set of instance IDs `P:pk:<ns>:<gid>` (no personal data),
 * kept until the latest parking bound, read and deleted by the commit that
 * recreates the group.
 */
export interface ParkingRegistry {
  /** This instance parks a member of the group until `until` (in the running task's commit). */
  park(namespace: string, groupId: string, until: number): void;
  /** The group was recreated: the other instances with parked members (the set goes). */
  recreated(namespace: string, groupId: string): Promise<string[]>;
}

export class RedisParking implements ParkingRegistry {
  constructor(
    private readonly ctx: RedisContext,
    private readonly work: RedisWorkSource,
  ) {}

  park(namespace: string, groupId: string, until: number): void {
    const running = this.work.current();
    const self = running?.instanceId;
    if (running === undefined || self === undefined) return;
    const key = this.ctx.keys.parking(namespace, groupId);
    running.addStep((plan) => {
      plan.sadd(key, self);
      plan.extend(key, until);
    });
  }

  async recreated(namespace: string, groupId: string): Promise<string[]> {
    const running = this.work.current();
    if (running === undefined) return [];
    const key = this.ctx.keys.parking(namespace, groupId);
    const reply = await this.ctx.link.send(['SMEMBERS', key]);
    const ids = Array.isArray(reply) ? (reply as unknown[]).map(String) : [];
    if (ids.length > 0) running.addStep((plan) => plan.del(key));
    const self = running.instanceId;
    return ids.filter((id) => INSTANCE_ID_PATTERN.test(id) && id !== self);
  }
}
