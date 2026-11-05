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
  const create = api.useCreateGroup();
  const byCode = api.useJoinByCode();
  const byQr = api.useJoinByQr();
  const approval = api.useJoinApproval();
  const stored = api.useStoredGroups({ checkOnConnect: true });
  const codes = api.useLeaderCodes();
  const qr = api.useQrTicket();
  const requests = api.useJoinRequests();
  const roster = api.useRoster();
  const vice = api.useViceLeader();
  const lock = api.useGroupLock();
  const removal = api.useMemberRemoval();
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
    joining: create.pending || byCode.pending || byQr.pending,
    flow: approval.flow.status,
    stored: stored.groups === null ? null : stored.groups.length,
    codes: codes.codes === null ? null : 'set',
    qr: qr.state.status,
    requests: requests.requests.length,
    roster: roster.length,
    vice: vice.isVice,
    locked: lock.locked,
    blocked: removal.blockList.length,
  };
  return (
    <div>
      <pre>{JSON.stringify(summary)}</pre>
      <api.ConnectionIndicator>{({ indicator: i }) => <span>{i}</span>}</api.ConnectionIndicator>
      <api.QrTicket>{(state) => <span>{state.status}</span>}</api.QrTicket>
    </div>
  );
}
