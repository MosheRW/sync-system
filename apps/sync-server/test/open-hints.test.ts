import { describe, expect, it } from 'vitest';
import type { GroupRecord } from '../src/groups/group-store.js';
import { logHintFailure, openHints } from '../src/groups/open-hints.js';
import { type Recipient, RemoteRecipient } from '../src/groups/recipients.js';
import { type RosterState, admit, setConnected } from '../src/lifecycle/roster.js';
import { pickSuccessor, successorCandidates } from '../src/lifecycle/succession.js';
import { createLogger } from '../src/logging/logger.js';
import { LogCapture } from './helpers/log-capture.js';

const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

/** A local recipient whose socket is open or not. */
function local(pid: string, open: boolean): Recipient {
  return {
    pid,
    isOpen: () => open,
    send: () => undefined,
    detach: () => undefined,
    refresh: () => undefined,
  };
}

/** A recipient on `instance`, which the live cache lists or not. */
function remote(pid: string, instance: string, cached: boolean): RemoteRecipient {
  return new RemoteRecipient('ns', 'g', pid, instance, 'att', {
    send: () => undefined,
    forget: () => undefined,
    looksLive: () => cached,
  });
}

/** A `liveOf` that answers from `keys` and records every call. */
function countingLiveOf(keys: readonly string[]) {
  const calls: string[][] = [];
  const liveOf = (ids: readonly string[]) => {
    calls.push([...ids]);
    return Promise.resolve(new Set(ids.filter((id) => keys.includes(id))));
  };
  return { calls, liveOf };
}

const noError = (err: unknown) => {
  throw new Error(`unexpected onError: ${String(err)}`);
};

describe('openHints (#42, security C12, R1-R6)', () => {
  it('reads nothing when every recipient is a cache hit (AC6)', async () => {
    const { calls, liveOf } = countingLiveOf([B]);
    const open = await openHints(
      [
        ['a', local('a', true)],
        ['b', remote('b', B, true)],
      ],
      liveOf,
      noError,
    );
    expect([...open].sort()).toEqual(['a', 'b']);
    expect(calls).toEqual([]);
  });

  it('confirms a remote cache miss whose liveness key exists (AC1)', async () => {
    const { calls, liveOf } = countingLiveOf([B]);
    const open = await openHints([['b', remote('b', B, false)]], liveOf, noError);
    expect([...open]).toEqual(['b']);
    expect(calls).toEqual([[B]]);
  });

  it('keeps a remote miss without a liveness key not open (AC4)', async () => {
    const { liveOf } = countingLiveOf([]);
    const open = await openHints([['c', remote('c', C, false)]], liveOf, noError);
    expect(open.size).toBe(0);
  });

  it('treats a failed read as not live, reports it once, and never rejects (AC6, R6)', async () => {
    const errors: unknown[] = [];
    const failure = new Error('redis down');
    const result = openHints(
      [
        ['a', local('a', true)],
        ['b', remote('b', B, false)],
        ['b2', remote('b2', B, false)],
        ['c', remote('c', C, false)],
      ],
      () => Promise.reject(failure),
      (err) => errors.push(err),
    );
    await expect(result).resolves.toBeInstanceOf(Set);
    expect([...(await result)]).toEqual(['a']);
    expect(errors).toEqual([failure]);
  });

  it('makes one read of the distinct missed instances, never one per member (AC6, R4)', async () => {
    const { calls, liveOf } = countingLiveOf([B, C]);
    const entries = Array.from({ length: 50 }, (_, i) => {
      const pid = `p${i}`;
      return [pid, remote(pid, i % 2 === 0 ? B : C, false)] as const;
    });
    const open = await openHints(entries, liveOf, noError);
    expect(open.size).toBe(50);
    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual([B, C]);
  });

  it('reads nothing without a cluster, and never sends a local miss to Redis (R3)', async () => {
    const memory = await openHints(
      [
        ['a', local('a', false)],
        ['b', remote('b', B, false)],
      ],
      undefined,
      noError,
    );
    expect(memory.size).toBe(0);
    const { calls, liveOf } = countingLiveOf([B]);
    const open = await openHints([['a', local('a', false)]], liveOf, noError);
    expect(open.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('treats a pid nobody is attached as as not open', async () => {
    const { calls, liveOf } = countingLiveOf([B]);
    const open = await openHints([['x', undefined]], liveOf, noError);
    expect(open.size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('liveness hints never widen the succession rule (#42 AC5, R1, R2)', () => {
  function record(names: string[], overrides: Partial<GroupRecord> = {}) {
    let state: RosterState = { roster: [], nextAdmissionSeq: 0, nextGuestNumber: 1 };
    for (const pid of names) state = admit(state, pid, { generated: true }, 0);
    return {
      leaderId: 'L',
      viceId: undefined,
      displacedLeaderId: undefined,
      roster: state.roster,
      blockList: [],
      participantIds: [...names],
      ...overrides,
    } as Pick<
      GroupRecord,
      'leaderId' | 'viceId' | 'displacedLeaderId' | 'roster' | 'blockList' | 'participantIds'
    >;
  }

  it('never picks a Redis-live pid that is blocked, displaced, the leader, not a participant or disconnected', async () => {
    const base = record(['L', 'blocked', 'displaced', 'gone', 'off', 'outsider']);
    const view = {
      ...base,
      blockList: ['blocked'],
      displacedLeaderId: 'displaced',
      participantIds: base.participantIds.filter((pid) => pid !== 'gone'),
      roster: setConnected(base.roster, 'off', false, 1),
    };
    const everyone = ['L', 'blocked', 'displaced', 'gone', 'off', 'outsider', 'stranger'];
    // Every pid sits on a peer missing from the cache that Redis says is live.
    const { liveOf } = countingLiveOf([B]);
    const open = await openHints(
      everyone.map((pid) => [pid, remote(pid, B, false)] as const),
      liveOf,
      noError,
    );
    expect(open.size).toBe(everyone.length);
    expect(pickSuccessor(view, (pid) => open.has(pid))).toBe('outsider');
    const onlyIneligible = { ...view, roster: view.roster.filter((e) => e.pid !== 'outsider') };
    expect(pickSuccessor(onlyIneligible, (pid) => open.has(pid))).toBeUndefined();
    expect(successorCandidates(onlyIneligible)).toEqual([]);
  });
});

describe('logHintFailure (#42, security R5)', () => {
  it('logs one warn line with the redacted error only', () => {
    const out = new LogCapture();
    const onError = logHintFailure(createLogger({ level: 'trace', destination: out }));
    onError(new Error(`no instance ${B} for pid pid-secret-7`));
    const records = out.records();
    expect(records).toHaveLength(1);
    const line = records[0]!;
    expect(line.event).toBe('liveness_hint_failed');
    expect(line.level).toBe(40);
    const pinoKeys = ['level', 'time', 'pid', 'hostname', 'msg', 'event'];
    expect(Object.keys(line).filter((key) => !pinoKeys.includes(key))).toEqual(['err']);
    expect(out.text).not.toContain(B);
    expect(out.text).not.toContain('pid-secret-7');
  });
});
