import type { ReactNode } from 'react';
import * as api from '../../src/index.js';

/**
 * Calls every public hook and renders every render-prop helper, so the
 * server-render, hydration and logging tests cover the whole surface
 * (AC10). Renders a stable text summary (no credentials). Extended with
 * each chunk that adds hooks.
 */
export function AllHooks(): ReactNode {
  const snapshot = api.useSyncSnapshot();
  const status = api.useSyncSelector((s) => s.connection.status);
  const connection = api.useConnection();
  const indicator = api.useSyncIndicator();
  const update = api.useUpdateRequired();
  const client = api.useSyncClient();
  const custom = api.useSyncAction((c) => c.getState().status);
  const group = api.useGroup();
  const ended = api.useGroupEnded();
  const position = api.usePosition();
  const leaderStatus = api.useLeaderStatus();
  const removed = api.useRemoved();
  const exit = api.useGroupExit();
  api.useSyncEvent('state', () => undefined);
  const summary = {
    status,
    group: snapshot.group === null ? 'none' : snapshot.group.status,
    connection: connection.status,
    indicator,
    update: update?.kind ?? null,
    client: client === null ? 'none' : 'some',
    custom: custom.pending,
    groupStatus: group?.status ?? null,
    ended: ended?.reason ?? null,
    hasPosition: position.hasPosition,
    leaderOnline: leaderStatus?.online ?? null,
    removed,
    exit: exit.end.pending || exit.leave.pending,
  };
  return (
    <div>
      <pre>{JSON.stringify(summary)}</pre>
      <api.ConnectionIndicator>{({ indicator: i }) => <span>{i}</span>}</api.ConnectionIndicator>
    </div>
  );
}
