import { afterEach, describe, expect, it } from 'vitest';
import type { GroupTimers, TimerKind } from '../../src/groups/group-timers.js';

const G = 'T'.repeat(43);

/**
 * The timer backend contract (#35 AC29, ADR 0013): memory and Redis fire
 * the same timers, once, by kind, with their data.
 */
export interface TimerHarness {
  make(): Promise<{
    timers: GroupTimers;
    /** Runs `step` as a locked group task of `app-a`/G (Redis: committed at its end). */
    inTask: (step: () => void | Promise<void>) => Promise<void>;
    /** Moves the clock and waits until due timers fired and their tasks finished. */
    advance: (ms: number) => Promise<void>;
    now: () => number;
  }>;
  cleanup?(): Promise<void>;
}

export function timerBackendContract(label: string, harness: TimerHarness): void {
  describe(`Timer backend contract: ${label}`, () => {
    afterEach(async () => {
      await harness.cleanup?.();
    });

    async function setup() {
      const h = await harness.make();
      const fired: string[] = [];
      const record =
        (kind: TimerKind) => (ns: string, id: string, data: unknown, claim?: () => void) => {
          void h.inTask(() => {
            claim?.();
            fired.push(`${kind} ${ns}:${id === G ? 'G' : id} ${JSON.stringify(data ?? null)}`);
          });
        };
      h.timers.on('maxSession', record('maxSession'));
      h.timers.on('frozenEnd', record('frozenEnd'));
      h.timers.on('grace', record('grace'));
      return { ...h, fired };
    }

    it('fires each kind once at its time, with its data', async () => {
      const { timers, inTask, advance, now, fired } = await setup();
      const t0 = now();
      await inTask(() => {
        timers.arm('app-a', G, 'maxSession', t0 + 100);
        timers.arm('app-a', G, 'grace', t0 + 50, { term: 3, at: t0 + 50 });
      });
      await advance(49);
      expect(fired).toEqual([]);
      await advance(1);
      expect(fired).toEqual([`grace app-a:G {"term":3,"at":${t0 + 50}}`]);
      await advance(50);
      expect(fired).toEqual([
        `grace app-a:G {"term":3,"at":${t0 + 50}}`,
        'maxSession app-a:G null',
      ]);
      await advance(60_000);
      expect(fired).toHaveLength(2);
    });

    it('replaces a timer of the same kind and clears one kind or the whole group', async () => {
      const { timers, inTask, advance, now, fired } = await setup();
      const t0 = now();
      await inTask(() => {
        timers.arm('app-a', G, 'frozenEnd', t0 + 10);
        timers.arm('app-a', G, 'frozenEnd', t0 + 20);
        timers.arm('app-a', G, 'maxSession', t0 + 20);
        timers.arm('app-a', G, 'grace', t0 + 20, { term: 1, at: t0 + 20 });
      });
      await inTask(() => timers.clear('app-a', G, 'maxSession'));
      await advance(15);
      expect(fired).toEqual([]);
      await advance(5);
      expect(fired.map((f) => f.split(' ')[0]).sort()).toEqual(['frozenEnd', 'grace']);
      await inTask(() => {
        timers.arm('app-a', G, 'frozenEnd', t0 + 100);
        timers.arm('app-a', G, 'maxSession', t0 + 100);
      });
      await inTask(() => timers.clearGroup('app-a', G));
      await advance(200);
      expect(fired).toHaveLength(2);
    });

    it('keeps a timer the handler armed again', async () => {
      const h = await harness.make();
      const fired: number[] = [];
      h.timers.on('maxSession', (ns, id, _data, claim) => {
        void h.inTask(() => {
          claim?.();
          fired.push(h.now());
          if (fired.length === 1) h.timers.arm(ns, id, 'maxSession', h.now() + 30);
        });
      });
      const t0 = h.now();
      await h.inTask(() => h.timers.arm('app-a', G, 'maxSession', t0 + 10));
      await h.advance(10);
      await h.advance(30);
      expect(fired).toHaveLength(2);
      await h.advance(1000);
      expect(fired).toHaveLength(2);
    });
  });
}
