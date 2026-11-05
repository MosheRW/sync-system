import type { ReactNode } from 'react';
import * as api from '../../src/index.js';

/**
 * Calls every public hook and renders every render-prop helper, so the
 * server-render, hydration and logging tests cover the whole surface
 * (AC10). Renders a stable text summary (no credentials).
 */
export function AllHooks(): ReactNode {
  const snapshot = api.useSyncSnapshot();
  const status = api.useSyncSelector((s) => s.connection.status);
  const connection = api.useConnection();
  const indicator = api.useSyncIndicator();
  const update = api.useUpdateRequired();
  const client = api.useSyncClient();
  const summary = {
    status,
    group: snapshot.group === null ? 'none' : snapshot.group.status,
    connection: connection.status,
    indicator,
    update: update?.kind ?? null,
    client: client === null ? 'none' : 'some',
  };
  return (
    <div>
      <pre>{JSON.stringify(summary)}</pre>
      <api.ConnectionIndicator>{({ indicator: i }) => <span>{i}</span>}</api.ConnectionIndicator>
    </div>
  );
}
