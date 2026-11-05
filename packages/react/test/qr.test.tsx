import {
  type CodesChangedReason,
  type ConnectionState,
  type QrTicket,
  SyncClientError,
} from '@sync-system/client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QrTicket as QrTicketHelper } from '../src/components/qr-ticket.js';
import { type QrTicketHook, useQrTicket } from '../src/hooks/leader.js';
import { FakeSyncClient, deferred } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

let issued = 0;

/** A leader fake whose tickets live `lifetimeMs`. */
function leader(lifetimeMs = 60_000): FakeSyncClient {
  const client = new FakeSyncClient();
  client.codes = { generation: 1, groupCode: '123456' };
  client.lead('g-1');
  client.impl.issueQrTicket = (): QrTicket => {
    issued += 1;
    return { ticket: `tk-${issued}`, expiresAt: Date.now() + lifetimeMs };
  };
  return client;
}

function mount(
  client: FakeSyncClient,
  options?: Parameters<typeof useQrTicket>[0],
): { values: QrTicketHook[]; unmount: () => void } {
  const values: QrTicketHook[] = [];
  function Probe(): ReactNode {
    values.push(useQrTicket(options));
    return null;
  }
  const view = renderWithProvider(<Probe />, { client });
  return { values, unmount: view.unmount };
}

const ticketOf = (value: QrTicketHook | undefined): string | null => {
  const state = value?.state;
  return state && 'ticket' in state && state.ticket !== null ? state.ticket.ticket : null;
};

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  issued = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QR re-issue (AC18)', () => {
  it('issues once on mount under StrictMode', async () => {
    const client = leader();
    const { values } = mount(client);
    await advance(0);
    expect(client.count('issueQrTicket')).toBe(1);
    expect(values.at(-1)?.state.status).toBe('ready');
    expect(ticketOf(values.at(-1))).toBe('tk-1');
  });

  it('re-issues at 80 % of the lifetime', async () => {
    const client = leader(60_000);
    mount(client);
    await advance(0);
    await advance(47_999);
    expect(client.count('issueQrTicket')).toBe(1);
    await advance(1);
    expect(client.count('issueQrTicket')).toBe(2);
  });

  it('never re-issues sooner than 10 s (floor), and never exposes an expired ticket', async () => {
    const client = leader(5_000);
    const { values } = mount(client);
    await advance(0);
    expect(ticketOf(values.at(-1))).toBe('tk-1');
    await advance(5_000);
    // Expired before the 10 s floor: dropped, not shown as ready.
    expect(values.at(-1)?.state).toEqual({ status: 'loading', ticket: null });
    await advance(4_999);
    expect(client.count('issueQrTicket')).toBe(1);
    await advance(1);
    expect(client.count('issueQrTicket')).toBe(2);
    expect(ticketOf(values.at(-1))).toBe('tk-2');
  });

  it('a ticket that is already expired is an error, never ready (R9)', async () => {
    const client = leader();
    client.impl.issueQrTicket = () => ({ ticket: 'tk-old', expiresAt: Date.now() - 1 });
    const { values } = mount(client);
    await advance(0);
    expect(values.at(-1)?.state).toMatchObject({ status: 'error', ticket: null });
    await advance(10 * 60_000);
    expect(client.count('issueQrTicket')).toBe(1);
  });

  it.each(['rotated', 'resumed', 'member_removed', 'superseded'] as CodesChangedReason[])(
    're-issues at once on codesChanged %s and drops the revoked ticket (R1)',
    async (reason) => {
      const client = leader();
      const { values } = mount(client);
      await advance(0);
      expect(client.count('issueQrTicket')).toBe(1);
      const gate = deferred<QrTicket>();
      client.impl.issueQrTicket = () => gate.promise;
      act(() => {
        client.codes = { generation: 2, groupCode: '654321' };
        client.emit('codesChanged', { groupId: 'g-1', codes: client.codes, reason });
      });
      expect(client.count('issueQrTicket')).toBe(2);
      expect(values.at(-1)?.state).toEqual({ status: 'loading', ticket: null });
      await act(async () => {
        gate.resolve({ ticket: 'tk-new', expiresAt: Date.now() + 60_000 });
        await Promise.resolve();
      });
      expect(ticketOf(values.at(-1))).toBe('tk-new');
    },
  );

  it.each(['door_failures', 'created'] as CodesChangedReason[])(
    'does not re-issue on codesChanged %s',
    async (reason) => {
      const client = leader();
      const { values } = mount(client);
      await advance(0);
      act(() => {
        client.codes = { generation: 2, groupCode: '123456', doorCode: '000111' };
        client.emit('codesChanged', { groupId: 'g-1', codes: client.codes, reason });
      });
      await advance(1_000);
      expect(client.count('issueQrTicket')).toBe(1);
      expect(ticketOf(values.at(-1))).toBe('tk-1');
    },
  );

  it('discards a stale in-flight result after a rotation', async () => {
    const client = leader();
    const first = deferred<QrTicket>();
    const second = deferred<QrTicket>();
    const gates = [first, second];
    client.impl.issueQrTicket = () => gates.shift()!.promise;
    const { values } = mount(client);
    await advance(0);
    act(() => {
      client.codes = { generation: 2, groupCode: '654321' };
      client.emit('codesChanged', { groupId: 'g-1', codes: client.codes, reason: 'rotated' });
    });
    await act(async () => {
      first.resolve({ ticket: 'tk-stale', expiresAt: Date.now() + 60_000 });
      await Promise.resolve();
    });
    expect(ticketOf(values.at(-1))).toBeNull();
    await act(async () => {
      second.resolve({ ticket: 'tk-fresh', expiresAt: Date.now() + 60_000 });
      await Promise.resolve();
    });
    expect(ticketOf(values.at(-1))).toBe('tk-fresh');
  });

  it('a resume in the same tick as becoming eligible issues once', async () => {
    const client = leader();
    client.setConnection({
      status: 'reconnecting',
      attempt: 1,
      delayMs: 1,
      retryAt: 1,
      attempting: true,
    });
    mount(client);
    await advance(0);
    expect(client.count('issueQrTicket')).toBe(0);
    act(() => {
      client.codes = { generation: 2, groupCode: '654321' };
      client.lead('g-1');
      client.emit('codesChanged', { groupId: 'g-1', codes: client.codes, reason: 'resumed' });
    });
    await advance(0);
    expect(client.count('issueQrTicket')).toBe(1);
  });

  it('clears every timer and drops the ticket on unmount', async () => {
    const client = leader();
    const { unmount } = mount(client);
    await advance(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    await advance(0);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * 60_000);
    expect(client.count('issueQrTicket')).toBe(1);
  });

  it('two consumers share one ticket and one issue', async () => {
    const client = leader();
    const seen: string[] = [];
    function Two(): ReactNode {
      const a = useQrTicket();
      const b = useQrTicket();
      seen.push(`${ticketOf(a)}|${ticketOf(b)}`);
      return null;
    }
    renderWithProvider(<Two />, { client });
    await advance(0);
    expect(client.count('issueQrTicket')).toBe(1);
    expect(seen.at(-1)).toBe('tk-1|tk-1');
  });

  it('RATE_LIMITED: keeps the ticket, retries after the server delay (10 s to 60 s)', async () => {
    const client = leader();
    const { values } = mount(client);
    await advance(0);
    const limited = (retryAfterMs: number) =>
      new SyncClientError('RATE_LIMITED', { details: { retryAfterMs } });
    client.impl.issueQrTicket = () => Promise.reject(limited(30_000));
    await advance(48_000);
    expect(client.count('issueQrTicket')).toBe(2);
    expect(values.at(-1)?.state).toMatchObject({ status: 'error', ticket: { ticket: 'tk-1' } });
    client.impl.issueQrTicket = () => Promise.reject(limited(1e12));
    await advance(29_999);
    expect(client.count('issueQrTicket')).toBe(2);
    await advance(1);
    expect(client.count('issueQrTicket')).toBe(3);
    // Capped at 60 s.
    client.impl.issueQrTicket = () => Promise.reject(limited(Number.NaN));
    await advance(59_999);
    expect(client.count('issueQrTicket')).toBe(3);
    await advance(1);
    expect(client.count('issueQrTicket')).toBe(4);
    // Not finite: the 10 s floor.
    await advance(10_000);
    expect(client.count('issueQrTicket')).toBe(5);
  });

  /** Mounts, issues tk-1, then a re-issue at 48 s is rate-limited for 40 s. */
  async function rateLimited(): Promise<{ client: FakeSyncClient; values: QrTicketHook[] }> {
    const client = leader();
    const { values } = mount(client);
    await advance(0);
    client.impl.issueQrTicket = () =>
      Promise.reject(new SyncClientError('RATE_LIMITED', { details: { retryAfterMs: 40_000 } }));
    await advance(48_000);
    expect(client.count('issueQrTicket')).toBe(2);
    client.impl.issueQrTicket = (): QrTicket => {
      issued += 1;
      return { ticket: `tk-${issued}`, expiresAt: Date.now() + 60_000 };
    };
    return { client, values };
  }

  it.each(['rotated', 'resumed', 'member_removed', 'superseded'] as CodesChangedReason[])(
    'codesChanged %s during a RATE_LIMITED wait drops the ticket at once but keeps the wait (R1, R9)',
    async (reason) => {
      const { client, values } = await rateLimited();
      await advance(5_000);
      act(() => {
        client.codes = { generation: 2, groupCode: '654321' };
        client.emit('codesChanged', { groupId: 'g-1', codes: client.codes, reason });
      });
      expect(values.at(-1)?.state).toEqual({ status: 'loading', ticket: null });
      await advance(34_999);
      expect(client.count('issueQrTicket')).toBe(2);
      expect(ticketOf(values.at(-1))).toBeNull();
      await advance(1);
      expect(client.count('issueQrTicket')).toBe(3);
      expect(ticketOf(values.at(-1))).toBe('tk-2');
    },
  );

  it('a demotion and a new group during a RATE_LIMITED wait issue only after the wait', async () => {
    const { client, values } = await rateLimited();
    act(() => client.follow('g-1'));
    expect(values.at(-1)?.state).toEqual({ status: 'idle' });
    act(() => client.lead('g-2'));
    await advance(39_999);
    expect(client.count('issueQrTicket')).toBe(2);
    await advance(1);
    expect(client.count('issueQrTicket')).toBe(3);
  });

  it('hiding and showing the QR during a RATE_LIMITED wait issues only after the wait', async () => {
    const client = leader();
    const values: QrTicketHook[] = [];
    function Probe(): ReactNode {
      values.push(useQrTicket());
      return null;
    }
    const view = renderWithProvider(<Probe />, { client });
    await advance(0);
    client.impl.issueQrTicket = () =>
      Promise.reject(new SyncClientError('RATE_LIMITED', { details: { retryAfterMs: 40_000 } }));
    await advance(48_000);
    view.rerenderWith(null);
    await advance(0);
    client.impl.issueQrTicket = () => ({ ticket: 'tk-again', expiresAt: Date.now() + 60_000 });
    view.rerenderWith(<Probe />);
    await advance(39_999);
    expect(client.count('issueQrTicket')).toBe(2);
    await advance(1);
    expect(client.count('issueQrTicket')).toBe(3);
    expect(ticketOf(values.at(-1))).toBe('tk-again');
  });

  const RECONNECTING: ConnectionState = Object.freeze({
    status: 'reconnecting' as const,
    attempt: 1,
    delayMs: 500,
    retryAt: 0,
    attempting: true,
  });

  /** Drops the connection and opens a new one, still leading g-1. */
  function reconnect(client: FakeSyncClient): void {
    act(() => {
      client.setConnection(RECONNECTING);
      client.lead('g-1');
    });
  }

  it('a reconnect during a RATE_LIMITED wait ends the wait; the 10 s floor stays', async () => {
    const { client, values } = await rateLimited();
    // 5 s into the 40 s wait; the last issue was 5 s ago.
    await advance(5_000);
    reconnect(client);
    await advance(4_999);
    expect(client.count('issueQrTicket')).toBe(2);
    await advance(1);
    expect(client.count('issueQrTicket')).toBe(3);
    expect(ticketOf(values.at(-1))).toBe('tk-2');
  });

  it('a reconnect storm issues at most once per 10 s', async () => {
    const { client } = await rateLimited();
    const issuedAt: number[] = [];
    client.impl.issueQrTicket = (): QrTicket => {
      issuedAt.push(Date.now());
      issued += 1;
      return { ticket: `tk-${issued}`, expiresAt: Date.now() + 60_000 };
    };
    for (let i = 0; i < 120; i += 1) {
      reconnect(client);
      await advance(500);
    }
    expect(issuedAt.length).toBeGreaterThan(0);
    expect(issuedAt.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < issuedAt.length; i += 1) {
      expect(issuedAt[i]! - issuedAt[i - 1]!).toBeGreaterThanOrEqual(10_000);
    }
  });

  it('a demotion and re-promotion on the same connection keep the wait', async () => {
    const { client } = await rateLimited();
    act(() => client.follow('g-1'));
    act(() => client.lead('g-1'));
    await advance(39_999);
    expect(client.count('issueQrTicket')).toBe(2);
    await advance(1);
    expect(client.count('issueQrTicket')).toBe(3);
  });

  it('JOIN_METHOD_UNAVAILABLE: unavailable, no timer', async () => {
    const client = leader();
    client.impl.issueQrTicket = () =>
      Promise.reject(new SyncClientError('JOIN_METHOD_UNAVAILABLE'));
    const { values } = mount(client);
    await advance(0);
    expect(values.at(-1)?.state).toEqual({ status: 'unavailable' });
    await advance(10 * 60_000);
    expect(client.count('issueQrTicket')).toBe(1);
  });

  it('other errors: error state, no automatic retry', async () => {
    const client = leader();
    client.impl.issueQrTicket = () => Promise.reject(new SyncClientError('CONNECTION_LOST'));
    const { values } = mount(client);
    await advance(0);
    expect(values.at(-1)?.state).toMatchObject({ status: 'error', ticket: null });
    await advance(10 * 60_000);
    expect(client.count('issueQrTicket')).toBe(1);
  });

  it('is idle and issues nothing for a member, when disabled, or when not connected', async () => {
    const member = new FakeSyncClient();
    member.follow('g-1');
    const a = mount(member);
    const leaderClient = leader();
    const b = mount(leaderClient, { enabled: false });
    await advance(60_000);
    expect(member.count('issueQrTicket')).toBe(0);
    expect(leaderClient.count('issueQrTicket')).toBe(0);
    expect(a.values.at(-1)?.state).toEqual({ status: 'idle' });
    expect(b.values.at(-1)?.state).toEqual({ status: 'idle' });
  });

  it('drops the ticket on demotion and re-issues for a new group', async () => {
    const client = leader();
    const { values } = mount(client);
    await advance(0);
    act(() => client.follow('g-1'));
    expect(values.at(-1)?.state).toEqual({ status: 'idle' });
    act(() => client.lead('g-2'));
    await advance(10_000);
    expect(client.count('issueQrTicket')).toBe(2);
    expect(ticketOf(values.at(-1))).toBe('tk-2');
  });
});

describe('manual refresh (R2, M2)', () => {
  it('100 refresh() calls in one tick issue nothing extra within 10 s', async () => {
    const client = leader();
    const { values } = mount(client);
    await advance(0);
    act(() => {
      for (let i = 0; i < 100; i += 1) values.at(-1)!.refresh();
    });
    await advance(0);
    expect(client.count('issueQrTicket')).toBe(1);
  });

  it('a refresh loop every second issues at most once per 10 s', async () => {
    const client = leader(10 * 60_000);
    const { values } = mount(client);
    await advance(0);
    for (let second = 0; second < 60; second += 1) {
      act(() => values.at(-1)!.refresh());
      await advance(1_000);
    }
    // One on mount plus at most one per 10 s over 60 s.
    expect(client.count('issueQrTicket')).toBeLessThanOrEqual(7);
    expect(client.count('issueQrTicket')).toBeGreaterThanOrEqual(2);
  });

  it('is ignored while a request is in flight and during a rate-limit wait', async () => {
    const client = leader();
    const gate = deferred<QrTicket>();
    client.impl.issueQrTicket = () => gate.promise;
    const { values } = mount(client);
    await advance(11_000);
    act(() => values.at(-1)!.refresh());
    expect(client.count('issueQrTicket')).toBe(1);
    await act(async () => {
      gate.reject(new SyncClientError('RATE_LIMITED', { details: { retryAfterMs: 40_000 } }));
      await Promise.resolve();
    });
    await advance(20_000);
    act(() => values.at(-1)!.refresh());
    expect(client.count('issueQrTicket')).toBe(1);
  });

  it('is allowed after 10 s', async () => {
    const client = leader();
    const { values } = mount(client);
    await advance(10_000);
    act(() => values.at(-1)!.refresh());
    expect(client.count('issueQrTicket')).toBe(2);
  });
});

describe('<QrTicket> (Q4)', () => {
  it('renders only what the render prop returns', async () => {
    const client = leader();
    const view = renderWithProvider(
      <QrTicketHelper>
        {(state) => <span>{state.status === 'ready' ? state.ticket.ticket : state.status}</span>}
      </QrTicketHelper>,
      { client },
    );
    await advance(0);
    expect(view.container.innerHTML).toBe('<span>tk-1</span>');
  });
});
