import { GROUP_ID_PATTERN, type JoinCodeKind } from '@sync-system/protocol';
import type { CodeIndexStore, IndexedCodes } from '../../joins/code-index.js';
import { type CommitPlan, type RedisContext, type RedisWorkSource } from './unit-of-work.js';
import { CLAIM } from './scripts.js';

/**
 * The code -> group index in Redis (#10 D1, #35 AC7, AC16): one key per
 * code holding the group ID, alive until the group's end bound. A claim is
 * one Lua step (all or none, R14). A release inside a group task is a
 * compare-and-delete in the task's commit, so a failed commit keeps the old
 * codes; claims of a failed task are released again (best effort, their
 * TTL bounds them anyway).
 */
export class RedisCodeIndex implements CodeIndexStore {
  constructor(
    private readonly ctx: RedisContext,
    private readonly work: RedisWorkSource,
  ) {}

  private keyOf(namespace: string, kind: JoinCodeKind, code: string): string {
    return kind === 'group'
      ? this.ctx.keys.groupCode(namespace, code)
      : this.ctx.keys.alphaCode(namespace, code);
  }

  private keysOf(namespace: string, codes: IndexedCodes): string[] {
    const keys: string[] = [];
    if (codes.groupCode !== undefined)
      keys.push(this.ctx.keys.groupCode(namespace, codes.groupCode));
    if (codes.alphaCode !== undefined)
      keys.push(this.ctx.keys.alphaCode(namespace, codes.alphaCode));
    return keys;
  }

  /** The holder, or undefined; a value that is not a group ID is no holder (C1). */
  async lookup(namespace: string, kind: JoinCodeKind, code: string): Promise<string | undefined> {
    const value = await this.ctx.link.send(['GET', this.keyOf(namespace, kind, code)]);
    return typeof value === 'string' && GROUP_ID_PATTERN.test(value) ? value : undefined;
  }

  async isFree(namespace: string, kind: JoinCodeKind, code: string): Promise<boolean> {
    return (await this.ctx.link.send(['EXISTS', this.keyOf(namespace, kind, code)])) === 0;
  }

  async claim(
    namespace: string,
    groupId: string,
    codes: IndexedCodes,
    expiresAt: number,
  ): Promise<boolean> {
    const keys = this.keysOf(namespace, codes);
    if (keys.length === 0) return true;
    const ttl = String(Math.max(1, Math.ceil(expiresAt - this.ctx.now())));
    const reply = await this.ctx.link.script(CLAIM, keys, [groupId, ttl]);
    const flags = Array.isArray(reply) ? (reply as unknown[]).map(Number) : [0];
    if (flags[0] !== 1) return false;
    const fresh = keys.filter((_key, i) => flags[i + 1] === 1);
    this.work.current()?.onAbandon(async () => {
      const plan = this.planFor();
      for (const key of fresh) plan.deleq(key, groupId);
      await plan.run(this.ctx.link);
    });
    return true;
  }

  async release(namespace: string, groupId: string, codes: IndexedCodes): Promise<void> {
    const keys = this.keysOf(namespace, codes);
    if (keys.length === 0) return;
    const running = this.work.current();
    if (running !== undefined) {
      running.addStep((plan) => {
        for (const key of keys) plan.deleq(key, groupId);
      });
      return;
    }
    const plan = this.planFor();
    for (const key of keys) plan.deleq(key, groupId);
    await plan.run(this.ctx.link);
  }

  /** Compare-and-delete releases need no instance fence (security C11). */
  private planFor(): CommitPlan {
    return this.work.plan(false);
  }

  /** Nothing local to forget: the index lives in Redis. */
  clear(): void {
    return undefined;
  }
}
