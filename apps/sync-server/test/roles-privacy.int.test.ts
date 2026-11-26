import { randomBytes } from 'node:crypto';
import type { ServerMessage } from '@mosherw/sync-system-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecretsInput } from '../src/config/token-secret.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { joinByCode, resumeWith } from './helpers/groups.js';
import { GRACE_MS } from './helpers/lifecycle.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { LogCapture } from './helpers/log-capture.js';
import type { TestClient } from './helpers/test-client.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

async function frameOf(client: TestClient, type: string): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message;
  }
}

/** Log text without pino's own numeric fields, which may hold any digits. */
function text(logs: LogCapture[]): string {
  return logs
    .map((l) => l.text)
    .join('\n')
    .replace(/"(time|pid|hostname)":("[^"]*"|\d+)/g, '');
}

describe('role flows never log names, IDs, tokens, codes or payloads (#13 AC43)', () => {
  it('names, roster, vice, lock, removal, keep-alive, handoff, take-back, restart and supersede', async () => {
    const secrets: TokenSecretsInput = { current: randomBytes(32), source: 'env' };
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets: secrets, scheduler, logLevel: 'trace' });
    const sentinels: string[] = [];
    const leader = await ts.connectReady();
    leader.send({
      type: 'group.create',
      metadata: { title: 'SENTINEL-META' },
      position: { page: 'SENTINEL-POS' },
      displayName: 'Sentinel Leader',
    });
    const created = await frameOf(leader, 'group.created');
    if (created.type !== 'group.created') throw new Error('expected group.created');
    sentinels.push(
      'Sentinel Leader',
      'SENTINEL-META',
      'SENTINEL-POS',
      created.participantId,
      created.token,
      created.groupId,
      created.codes.blob,
    );
    const pids: string[] = [];
    const clients: TestClient[] = [];
    for (const name of ['Sentinel Alpha', 'Sentinel Beta']) {
      const { client, reply } = await joinByCode(ts, created, { extra: { displayName: name } });
      if (reply.type !== 'group.joined') throw new Error('expected group.joined');
      pids.push(reply.participantId);
      clients.push(client);
      sentinels.push(name, reply.participantId, reply.token);
    }
    leader.send({ type: 'vice.set', participantId: pids[1] });
    await frameOf(leader, 'vice.updated');
    leader.send({ type: 'group.lock' });
    await frameOf(leader, 'lock.changed');
    leader.send({ type: 'group.unlock' });
    await frameOf(leader, 'lock.changed');
    const { reply: third } = await joinByCode(ts, created, {
      extra: { displayName: 'Sentinel Gamma' },
    });
    if (third.type !== 'group.joined') throw new Error('expected group.joined');
    sentinels.push('Sentinel Gamma', third.participantId);
    leader.send({ type: 'member.remove', participantId: third.participantId });
    await frameOf(leader, 'member.removed');
    const rotated = await frameOf(leader, 'codes.updated');
    if (rotated.type !== 'codes.updated') throw new Error('expected codes.updated');
    sentinels.push(rotated.codes.blob, rotated.codes.groupCode!, rotated.codes.doorCode!);
    scheduler.advance(19 * 60_000);
    await leader.next('keepalive.prompt');
    leader.send({ type: 'keepalive.ack' });
    await leader.next('activity.ack');
    await leader.next('keepalive.cleared');
    await leader.close();
    // Handoff to the vice, then take-back.
    const firstLogs = ts.logs;
    await frameOf(clients[0]!, 'leader.offline');
    scheduler.advance(GRACE_MS);
    const viceGranted = await frameOf(clients[1]!, 'leader.granted');
    if (viceGranted.type !== 'leader.granted') throw new Error('expected leader.granted');
    sentinels.push(viceGranted.token);
    const { client: back } = await resumeWith(ts, created.token, {
      displayName: 'Sentinel Leader',
    });
    back.send({ type: 'leader.takeBack' });
    const granted = await frameOf(back, 'leader.granted');
    if (granted.type !== 'leader.granted') throw new Error('expected leader.granted');
    sentinels.push(granted.token);
    // Restart, stale recreation, supersede.
    await ts.close();
    ts = await startTestServer({
      tokenSecrets: secrets,
      scheduler,
      logLevel: 'trace',
      store: new InMemoryGroupStore(),
    });
    // The vice's older grant recreates first; the take-back grant supersedes it.
    await resumeWith(ts, viceGranted.token, { metadata: { title: 'SENTINEL-META' } });
    const { reply: superseded } = await resumeWith(ts, granted.token, {
      displayName: 'Sentinel Leader',
    });
    expect(superseded).toMatchObject({ superseded: true });
    const log = text([firstLogs, ts.logs]);
    for (const sentinel of sentinels) expect(log, 'log leak').not.toContain(sentinel);
    for (const event of ['vice_changed', 'group_locked', 'member_removed', 'keepalive_prompted']) {
      expect(firstLogs.events()).toContain(event);
    }
    expect(firstLogs.events()).toContain('leader_handoff');
    expect(ts.logs.events()).toContain('leader_superseded');
  });
});
