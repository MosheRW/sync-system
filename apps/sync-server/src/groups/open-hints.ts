import { type Logger, safeErr } from '../logging/logger.js';
import { type Recipient, RemoteRecipient } from './recipients.js';

/**
 * `isOpen()` hints for a few participants (#42, #35 architecture 12.6,
 * security C12): the pids whose recipient is open (a local open socket, or
 * a remote instance in the live cache), plus the pids on a remote instance
 * missing from the cache whose liveness key Redis confirms now. A peer that
 * started after this instance's last heartbeat is in Redis but not yet in
 * the cache, so without the read it would look dead for up to 5 s.
 *
 * Bounded (security R4): no read when every remote recipient is a cache
 * hit or there is no cluster (`liveOf` undefined); else exactly one
 * `liveOf` call with the distinct missed instance IDs (`liveOf` keeps
 * filtering them by `INSTANCE_ID_PATTERN`, R3). Local recipients never go
 * to Redis: a closed local session stays not open.
 *
 * A failed read leaves every miss not open, as a cache miss is today, and
 * calls `onError` once (R6); it never rejects. The result is a hint only
 * (R1): it never grants membership, leadership or approval by itself.
 */
export async function openHints(
  entries: ReadonlyArray<readonly [pid: string, recipient: Recipient | undefined]>,
  liveOf: ((ids: readonly string[]) => Promise<Set<string>>) | undefined,
  onError: (err: unknown) => void,
): Promise<Set<string>> {
  const open = new Set<string>();
  const missed = new Map<string, string[]>();
  for (const [pid, recipient] of entries) {
    if (recipient === undefined) continue;
    if (recipient.isOpen()) {
      open.add(pid);
      continue;
    }
    if (!(recipient instanceof RemoteRecipient)) continue;
    const pids = missed.get(recipient.instance);
    if (pids === undefined) missed.set(recipient.instance, [pid]);
    else pids.push(pid);
  }
  if (missed.size === 0 || liveOf === undefined) return open;
  let live: Set<string>;
  try {
    live = await liveOf([...missed.keys()]);
  } catch (err) {
    onError(err);
    return open;
  }
  for (const [instance, pids] of missed) {
    if (live.has(instance)) for (const pid of pids) open.add(pid);
  }
  return open;
}

/**
 * The `onError` of `openHints` for the group service: one warn line with
 * the redacted error only, never a pid, instance ID or group data (R5).
 */
export function logHintFailure(logger: Pick<Logger, 'warn'>): (err: unknown) => void {
  return (err) =>
    logger.warn({ event: 'liveness_hint_failed', err: safeErr(err) }, 'liveness hint read failed');
}
