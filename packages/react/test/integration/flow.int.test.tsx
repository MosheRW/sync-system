import { memoryStorage } from '@sync-system/client';
import { act, render } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useConnection } from '../../src/hooks/connection.js';
import { usePosition } from '../../src/hooks/group.js';
import { useCreateGroup, useJoinByCode } from '../../src/hooks/join.js';
import { useViceLeader } from '../../src/hooks/leader.js';
import { useLeadership } from '../../src/hooks/leadership.js';
import { SyncProvider } from '../../src/provider.js';
import {
  type RealServer,
  TEST_KEY,
  TestWebSocket,
  startRealServer,
} from '../helpers/real-server.js';

/**
 * AC26: the package against the in-process sync server: create, join by
 * code, a position update seen by the member, and a leader change (vice
 * set, leader provider unmounted, handoff after the 1 s grace) seen through
 * `useLeadership`. Real timers; every wait polls a condition with a generous
 * deadline, so slow CI hosts only take longer.
 */

let server: RealServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  }
}

interface Probe {
  connection?: ReturnType<typeof useConnection>;
  position?: ReturnType<typeof usePosition>;
  leadership?: ReturnType<typeof useLeadership>;
  vice?: ReturnType<typeof useViceLeader>;
  create?: ReturnType<typeof useCreateGroup>;
  join?: ReturnType<typeof useJoinByCode>;
}

function Screen({ probe }: { probe: Probe }): ReactNode {
  probe.connection = useConnection();
  probe.position = usePosition();
  probe.leadership = useLeadership();
  probe.vice = useViceLeader();
  probe.create = useCreateGroup();
  probe.join = useJoinByCode();
  return null;
}

function app(url: string, probe: Probe): ReactNode {
  return (
    <StrictMode>
      <SyncProvider
        options={{
          url,
          apiKey: TEST_KEY,
          appVersion: '1.0.0',
          WebSocket: TestWebSocket,
          storage: memoryStorage(),
          reconnect: { initialDelayMs: 100, maxDelayMs: 1000, stableAfterMs: 1000 },
        }}
      >
        <Screen probe={probe} />
      </SyncProvider>
    </StrictMode>
  );
}

describe('React package against the real server (AC26)', () => {
  it('create, join by code, position update, leader change', { timeout: 30_000 }, async () => {
    server = await startRealServer({ disconnectGraceSeconds: 1 });
    const leader: Probe = {};
    const member: Probe = {};
    const leaderView = render(app(server.url, leader));
    const memberView = render(app(server.url, member));
    await waitFor(() => leader.connection?.status === 'connected', 'leader connected');
    await waitFor(() => member.connection?.status === 'connected', 'member connected');

    // Create.
    let created: Awaited<ReturnType<NonNullable<Probe['create']>['run']>> | undefined;
    await act(async () => {
      created = await leader.create!.run({ book: 'b' }, { page: 1 });
    });
    expect(created?.ok).toBe(true);
    if (!created?.ok) throw new Error('create failed');
    await waitFor(() => leader.leadership?.isLeader === true, 'leader leads');

    // Join by code (group code + door code for method A, else the alpha code).
    const { groupCode, doorCode, alphaCode } = created.value.codes;
    const code = groupCode ?? alphaCode;
    if (code === undefined) throw new Error('no join code');
    let joined: Awaited<ReturnType<NonNullable<Probe['join']>['run']>> | undefined;
    await act(async () => {
      joined = await member.join!.run(
        code,
        groupCode !== undefined && doorCode !== undefined ? { doorCode } : {},
      );
    });
    expect(joined?.ok).toBe(true);
    if (!joined?.ok) throw new Error('join failed');
    await waitFor(() => member.position?.position !== undefined, 'member sees the position');
    expect(member.position?.position).toEqual({ page: 1 });
    expect(member.leadership).toMatchObject({ role: 'member', isLeader: false });

    // Position update seen by the member.
    act(() => {
      expect(leader.position!.updatePosition({ page: 2 })).toEqual({ ok: true, value: undefined });
    });
    await waitFor(
      () => JSON.stringify(member.position?.position) === JSON.stringify({ page: 2 }),
      'member sees page 2',
    );

    // Leader change: the member becomes vice, the leader's provider unmounts
    // (its client closes), and the member takes over after the grace.
    await act(async () => {
      const result = await leader.vice!.setVice.run(joined!.ok ? joined!.value.participantId : '');
      expect(result.ok).toBe(true);
    });
    await waitFor(() => member.vice?.isVice === true, 'member is vice');
    leaderView.unmount();
    await waitFor(() => member.leadership?.isLeader === true, 'member leads', 15_000);
    expect(member.leadership?.lastChange).toMatchObject({
      kind: 'now_leading',
      reason: 'handoff_disconnect',
    });
    expect(member.position?.canUpdate).toBe(true);
    memberView.unmount();
    // The deferred close of the owned clients runs one tick after unmount.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  });
});
