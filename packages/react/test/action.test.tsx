import { SyncClientError } from '@mosherw/sync-system-client';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useSyncAction } from '../src/action.js';
import { SyncProvider } from '../src/provider.js';
import type { ActionState, SyncClientLike } from '../src/types.js';
import { FakeSyncClient, deferred } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

function track<A extends unknown[], T>(
  fn: (client: SyncClientLike, ...args: A) => Promise<T> | T,
): { values: ActionState<A, T>[]; Probe: () => ReactNode } {
  const values: ActionState<A, T>[] = [];
  return {
    values,
    Probe: () => {
      values.push(useSyncAction(fn));
      return null;
    },
  };
}

describe('useSyncAction (D8, AC15)', () => {
  it('pending -> value, with a stable run', async () => {
    const client = new FakeSyncClient();
    const gate = deferred<number>();
    const { values, Probe } = track((_c, n: number) => gate.promise.then((v) => v + n));
    renderWithProvider(<Probe />, { client });
    const run = values.at(-1)!.run;
    let result: Promise<unknown> | undefined;
    act(() => {
      result = run(1);
    });
    expect(values.at(-1)?.pending).toBe(true);
    expect(values.at(-1)?.run).toBe(run);
    await act(async () => {
      gate.resolve(41);
      await result;
    });
    await expect(result).resolves.toEqual({ ok: true, value: 42 });
    expect(values.at(-1)).toMatchObject({ pending: false, error: null, value: 42 });
  });

  it('a rejection and a synchronous throw resolve { ok: false } and set error', async () => {
    const client = new FakeSyncClient();
    const error = new SyncClientError('NOT_LEADER');
    const rejecting = track(() => Promise.reject(error));
    renderWithProvider(<rejecting.Probe />, { client });
    let result: unknown;
    await act(async () => {
      result = await rejecting.values.at(-1)!.run();
    });
    expect(result).toEqual({ ok: false, error });
    expect(rejecting.values.at(-1)?.error).toBe(error);

    const throwing = track(() => {
      throw new Error('app detail');
    });
    renderWithProvider(<throwing.Probe />, { client });
    await act(async () => {
      result = await throwing.values.at(-1)!.run();
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(throwing.values.at(-1)?.error?.message).not.toContain('app detail');
  });

  it('a newer call supersedes an older one; reset clears the state', async () => {
    const client = new FakeSyncClient();
    const gates = [deferred<string>(), deferred<string>()];
    let i = 0;
    const { values, Probe } = track(() => gates[i++]!.promise);
    renderWithProvider(<Probe />, { client, strict: false });
    const run = values.at(-1)!.run;
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => {
      first = run();
      second = run();
    });
    await act(async () => {
      gates[1]!.resolve('new');
      await second;
      gates[0]!.resolve('old');
      await first;
    });
    expect(values.at(-1)?.value).toBe('new');
    act(() => values.at(-1)!.reset());
    expect(values.at(-1)).toMatchObject({ pending: false, error: null, value: undefined });
  });

  it('without a client it resolves NOT_CONNECTED and calls nothing', async () => {
    let called = false;
    const { values, Probe } = track(() => {
      called = true;
    });
    // Owned mode before the client exists: render only, read the first value.
    const view = render(
      <SyncProvider
        options={{ url: 'not a url', apiKey: 'test-key', appVersion: '1.0.0' }}
        autoConnect={false}
      >
        <Probe />
      </SyncProvider>,
    );
    let result: unknown;
    await act(async () => {
      result = await values.at(-1)!.run();
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED' } });
    expect(called).toBe(false);
    view.unmount();
  });

  it('skips state updates after unmount', async () => {
    const client = new FakeSyncClient();
    const gate = deferred<string>();
    const { values, Probe } = track(() => gate.promise);
    const view = renderWithProvider(<Probe />, { client });
    let result: Promise<unknown> | undefined;
    act(() => {
      result = values.at(-1)!.run();
    });
    const count = values.length;
    view.unmount();
    gate.resolve('late');
    await expect(result).resolves.toEqual({ ok: true, value: 'late' });
    expect(values.length).toBe(count);
  });
});
