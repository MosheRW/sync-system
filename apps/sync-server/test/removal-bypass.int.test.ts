import { randomBytes } from 'node:crypto';
import type { ServerMessage } from '@mosherw/sync-system-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecrets } from '../src/config/token-secret.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers, joinByCode, resumeWith } from './helpers/groups.js';
import { GRACE_MS } from './helpers/lifecycle.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, KEY_B, type TestServer, startTestServer } from './helpers/test-server.js';

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

describe('a removed member cannot get back by any path (#13 AC33, AC45, RC4)', () => {
  it('the block list moves to the new leader on handoff and holds after a later restart', async () => {
    const secrets: TokenSecrets = { current: randomBytes(32), source: 'env' };
    const scheduler = new ManualScheduler();
    ts = await startTestServer({
      tokenSecrets: secrets,
      scheduler,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'B', 'D'] }],
    });
    const group = await createGroupWithMembers(ts, 2, { joinMethods: ['A', 'D'] });
    const [next, removed] = group.members as [TestClient, TestClient];
    group.leader.send({ type: 'qr.issue' });
    const ticket = await frameOf(group.leader, 'qr.ticket');
    group.leader.send({ type: 'member.remove', participantId: group.memberIds[1] });
    await frameOf(group.leader, 'member.removed');
    await frameOf(removed, 'group.ended');

    // Handoff: the new leader gets the list in its recovery state.
    await group.leader.close();
    await next.next('leader.offline');
    scheduler.advance(GRACE_MS);
    const granted = await frameOf(next, 'leader.granted');
    if (granted.type !== 'leader.granted') throw new Error('expected leader.granted');
    expect(granted.state.blockList).toEqual([group.memberIds[1]]);

    // Every path while live: token, old codes, old QR ticket.
    expect((await resumeWith(ts, group.memberTokens[1])).reply).toMatchObject({
      code: 'PARTICIPANT_BLOCKED',
    });
    expect((await joinByCode(ts, group)).reply).toMatchObject({ code: 'CODE_NOT_FOUND' });
    const qr = await ts.connectReady();
    qr.send({ type: 'group.joinByQr', ticket: (ticket as { ticket: string }).ticket });
    expect(await qr.next('error')).toMatchObject({ code: 'QR_INVALID' });

    // A later restart: the new leader recreates with its stored list.
    await ts.close();
    ts = await startTestServer({
      tokenSecrets: secrets,
      scheduler,
      store: new InMemoryGroupStore(),
      apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'B', 'D'] }],
    });
    const { client: parked, reply: waiting } = await resumeWith(ts, group.memberTokens[1]);
    expect(waiting).toMatchObject({ type: 'group.waiting', groupId: group.groupId });
    const { reply } = await resumeWith(ts, granted.token, {
      metadata: {},
      blockList: granted.state.blockList,
    });
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: true });
    expect(await parked.next('error')).toMatchObject({ code: 'PARTICIPANT_BLOCKED' });
    expect((await resumeWith(ts, group.memberTokens[1])).reply).toMatchObject({
      code: 'PARTICIPANT_BLOCKED',
    });
    // The removed member's token can never recreate the group.
    expect((await resumeWith(ts, group.memberTokens[1], { metadata: {} })).reply).toMatchObject({
      code: 'PARTICIPANT_BLOCKED',
    });
  });
});

describe('cross-group and cross-app IDs and tokens (#13 AC44)', () => {
  it('answers another group’s or app’s participant exactly like an unknown ID', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1);
    const other = await createGroupWithMembers(ts, 1);
    const otherApp = await createGroupWithMembers(ts, 1, { apiKey: KEY_B });
    const replies = [];
    for (const participantId of [other.memberIds[0], otherApp.memberIds[0]]) {
      for (const type of ['member.remove', 'vice.set']) {
        group.leader.send({ type, reqId: 'r', participantId });
        replies.push(JSON.stringify(await frameOf(group.leader, 'error')));
      }
    }
    expect(new Set(replies).size).toBe(1);
    expect(JSON.parse(replies[0]!)).toEqual({
      type: 'error',
      reqId: 'r',
      code: 'PARTICIPANT_NOT_FOUND',
      message: 'Participant not found',
    });
    // Another app's token is invalid, like garbage.
    expect((await resumeWith(ts, otherApp.leaderToken)).reply).toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });
});
