import {
  ALPHA_CODE_PATTERN,
  GROUP_CODE_PATTERN,
  GROUP_ID_PATTERN,
  NAMESPACE_PATTERN,
} from '@sync-system/protocol';
import { REDIS_KEY_PREFIX_PATTERN } from '../../config/redis.js';
import { TIMER_KINDS, type TimerKind } from '../../groups/group-timers.js';

/** A key part failed its format check: a bug or hostile input, never a stored key (security C6). */
export class KeyPartError extends Error {
  constructor(part: string) {
    super(`invalid redis key part: ${part}`);
    this.name = 'KeyPartError';
  }
}

const REF_PATTERN = /^[0-9a-f]{32}$/;

/** An instance ID: 16 random bytes, hex (#35 architecture 12.3, 12.5). */
export const INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/;

function check(pattern: RegExp, value: string, part: string): string {
  if (!pattern.test(value)) throw new KeyPartError(part);
  return value;
}

/**
 * Every Redis key and sorted-set member (#35 architecture 4.1, security C6).
 * Each part is checked against its format here, so no client input can
 * reach a key name unchecked and no part can contain `:`. Keys of two
 * prefixes never overlap (AC5).
 */
export class RedisKeys {
  /** `<prefix>:v1` */
  readonly base: string;

  constructor(prefix: string) {
    this.base = `${check(REDIS_KEY_PREFIX_PATTERN, prefix, 'prefix')}:v1`;
  }

  private group_(namespace: string, groupId: string): string {
    return `${check(NAMESPACE_PATTERN, namespace, 'namespace')}:${check(GROUP_ID_PATTERN, groupId, 'groupId')}`;
  }

  /** When this keyspace started (#35 architecture 4.5). */
  epoch(): string {
    return `${this.base}:epoch`;
  }

  /** The group document: `{v: 1, record, door?}`. */
  group(namespace: string, groupId: string): string {
    return `${this.base}:g:${this.group_(namespace, groupId)}`;
  }

  /**
   * The group's position and last leader activity, apart from the document
   * so a position update writes a few bytes, not the whole group (#35 F10).
   */
  position(namespace: string, groupId: string): string {
    return `${this.base}:p:${this.group_(namespace, groupId)}`;
  }

  /** The group holding a 6-digit group code. */
  groupCode(namespace: string, code: string): string {
    return `${this.base}:c:${check(NAMESPACE_PATTERN, namespace, 'namespace')}:g:${check(GROUP_CODE_PATTERN, code, 'groupCode')}`;
  }

  /** The group holding an alphanumeric code. */
  alphaCode(namespace: string, code: string): string {
    return `${this.base}:c:${check(NAMESPACE_PATTERN, namespace, 'namespace')}:a:${check(ALPHA_CODE_PATTERN, code, 'alphaCode')}`;
  }

  /** The group's timers: kind -> `{at, data}`. */
  timers(namespace: string, groupId: string): string {
    return `${this.base}:t:${this.group_(namespace, groupId)}`;
  }

  /** Due timers: member `ns:gid:kind`, score = due time or lease end. */
  due(): string {
    return `${this.base}:due`;
  }

  dueMember(namespace: string, groupId: string, kind: TimerKind): string {
    if (!TIMER_KINDS.includes(kind)) throw new KeyPartError('kind');
    return `${this.group_(namespace, groupId)}:${kind}`;
  }

  /** Live groups: member `ns:gid`, score = the group's end bound E. */
  live(): string {
    return `${this.base}:live`;
  }

  liveMember(namespace: string, groupId: string): string {
    return this.group_(namespace, groupId);
  }

  /** An ended group, by hashed ref only. */
  ended(ref: string): string {
    return `${this.base}:e:${check(REF_PATTERN, ref, 'ref')}`;
  }

  endedPlain(): string {
    return `${this.base}:e:plain`;
  }

  endedGuarded(): string {
    return `${this.base}:e:guarded`;
  }

  endedClosed(): string {
    return `${this.base}:e:closed`;
  }

  endedSeq(): string {
    return `${this.base}:e:seq`;
  }

  /** Liveness of an instance (#35 architecture 12.5): `1`, PX 15 s, renewed. */
  instance(id: string): string {
    return `${this.base}:inst:${check(INSTANCE_ID_PATTERN, id, 'instance')}`;
  }

  /** Instance IDs, score = liveness deadline in Redis time. */
  instances(): string {
    return `${this.base}:insts`;
  }

  /** The groups with an attachment on instance `id` (`ns:gid` members). */
  instanceGroups(id: string): string {
    return `${this.base}:ig:${check(INSTANCE_ID_PATTERN, id, 'instance')}`;
  }

  /** The pub/sub channel of instance `id` (#35 architecture 12.7). */
  channel(id: string): string {
    return `${this.base}:ch:${check(INSTANCE_ID_PATTERN, id, 'instance')}`;
  }
}

/** Splits a `ns:gid` or `ns:gid:kind` member; undefined when malformed (security C1). */
export function parseMember(
  member: string,
): { namespace: string; groupId: string; kind?: TimerKind } | undefined {
  const [namespace, groupId, kind, extra] = member.split(':');
  if (extra !== undefined || namespace === undefined || groupId === undefined) return undefined;
  if (!NAMESPACE_PATTERN.test(namespace) || !GROUP_ID_PATTERN.test(groupId)) return undefined;
  if (kind === undefined) return { namespace, groupId };
  if (!(TIMER_KINDS as readonly string[]).includes(kind)) return undefined;
  return { namespace, groupId, kind: kind as TimerKind };
}
