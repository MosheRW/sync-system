import { PARTICIPANT_ID_PATTERN } from '@sync-system/protocol';
import { z } from 'zod';
import { INSTANCE_ID_PATTERN } from './keys.js';

/** An attach ID: 16 random bytes, base64url (#35 architecture 12.3). */
export const ATTACH_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Where a participant is attached: instance `i`, attach ID `t`. */
export interface Attachment {
  readonly i: string;
  readonly t: string;
}

/**
 * The stored registry `{v: 1, a: {<pid>: {i, t}}}` (#35 architecture 12.6,
 * security C1, C16): every part checked against its pattern, so no
 * `__proto__` or other key reaches an object.
 */
const registrySchema = z
  .object({
    v: z.literal(1),
    a: z.record(
      z.string().regex(PARTICIPANT_ID_PATTERN),
      z
        .object({
          i: z.string().regex(INSTANCE_ID_PATTERN),
          t: z.string().regex(ATTACH_ID_PATTERN),
        })
        .strict(),
    ),
  })
  .strict();

/** The registry in a stored text, or `'invalid'` (fails closed, C1). */
export function decodeRegistry(text: string): Map<string, Attachment> | 'invalid' {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  const parsed = registrySchema.safeParse(value);
  if (!parsed.success) return 'invalid';
  // Every stored key must survive the parse (a `__proto__` key would not).
  const raw = (value as { a: object }).a;
  if (Object.keys(raw).length !== Object.keys(parsed.data.a).length) return 'invalid';
  return new Map(Object.entries(parsed.data.a).map(([pid, a]) => [pid, { i: a.i, t: a.t }]));
}

/** The stored text of a registry (pids sorted, so an unchanged one encodes the same); undefined when empty. */
export function encodeRegistry(entries: ReadonlyMap<string, Attachment>): string | undefined {
  if (entries.size === 0) return undefined;
  const a: Record<string, Attachment> = {};
  for (const pid of [...entries.keys()].sort()) {
    const entry = entries.get(pid)!;
    a[pid] = { i: entry.i, t: entry.t };
  }
  return JSON.stringify({ v: 1, a });
}

/**
 * One group's attachment registry inside a unit of work (#35 architecture
 * 12.6): read with the document, changed by the task, written by the
 * commit only when it changed. It says which instance and which session
 * (attach ID) own each connected participant.
 */
export class AttachmentRegistry {
  private readonly entries: Map<string, Attachment>;

  constructor(
    /** The registry as stored when the task read it. */
    readonly loaded: ReadonlyMap<string, Attachment> = new Map(),
    /** The stored text, to write only what changed. */
    readonly text: string | undefined = undefined,
  ) {
    this.entries = new Map(loaded);
  }

  get(pid: string): Attachment | undefined {
    return this.entries.get(pid);
  }

  set(pid: string, attachment: Attachment): void {
    this.entries.set(pid, attachment);
  }

  /** Deletes the entry of `pid`, only while it is still the attachment `t` when given. */
  delete(pid: string, t?: string): void {
    const entry = this.entries.get(pid);
    if (entry === undefined || (t !== undefined && entry.t !== t)) return;
    this.entries.delete(pid);
  }

  /** Keeps only the pids `keep` accepts (the invariant with the record). */
  retain(keep: (pid: string) => boolean): void {
    for (const pid of [...this.entries.keys()]) if (!keep(pid)) this.entries.delete(pid);
  }

  pids(): string[] {
    return [...this.entries.keys()];
  }

  /** The current entries. */
  current(): ReadonlyMap<string, Attachment> {
    return this.entries;
  }
}

/** The instances named by a registry. */
export function instancesOf(entries: ReadonlyMap<string, Attachment>): Set<string> {
  return new Set([...entries.values()].map((entry) => entry.i));
}
