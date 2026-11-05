import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_TTL_SECONDS } from '../src/limits/constants.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

const ENV = {
  TOKEN_REFRESH_ACTIVITIES: '3',
  TOKEN_REFRESH_MIN_SECONDS: '60',
  TOKEN_REFRESH_MAX_SECONDS: '300',
};

describe('leader token refresh (#5 AC12)', () => {
  it('sends token.refreshed after N activities and the min interval, with a new lat', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler, env: ENV });
    const group = await createGroupWithMembers(ts, 1);
    const original = claimsOf(group.leaderToken);
    for (let i = 0; i < 3; i++) {
      scheduler.advance(15_000);
      group.leader.send({ type: 'position.update', position: i });
      await group.leader.next('position.ack');
    }
    const lastActivity = scheduler.now();
    await group.leader.expectNoMessage(30);
    scheduler.advanceTo(original.iat * 1000 + 60_000);
    const refreshed = await group.leader.next('token.refreshed');
    expect(refreshed).toEqual({
      type: 'token.refreshed',
      groupId: group.groupId,
      token: expect.any(String) as string,
    });
    const claims = claimsOf(refreshed.token);
    expect(claims).toEqual({
      ...original,
      lat: lastActivity,
      iat: Math.floor(scheduler.now() / 1000),
      exp: Math.floor(scheduler.now() / 1000) + TOKEN_TTL_SECONDS,
    });
  });

  it('refreshes at the max interval after a single activity', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler, env: ENV });
    const group = await createGroupWithMembers(ts, 0);
    scheduler.advance(10_000);
    group.leader.send({ type: 'position.update', position: 1 });
    await group.leader.next('position.ack');
    scheduler.advance(290_000 - 1);
    await group.leader.expectNoMessage(30);
    scheduler.advance(1);
    const { token } = await group.leader.next('token.refreshed');
    expect(claimsOf(token).lat).toBe(scheduler.now() - 290_000);
  });

  it('sends nothing without activity', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler, env: ENV });
    const group = await createGroupWithMembers(ts, 0);
    scheduler.advance(30 * 60_000);
    await group.leader.expectNoMessage(50);
  });

  it('never refreshes member tokens (AC13)', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler, env: ENV });
    const group = await createGroupWithMembers(ts, 2);
    for (let i = 0; i < 12; i++) {
      scheduler.advance(30_000);
      group.leader.send({ type: 'position.update', position: i });
      // The leader's own refreshes may arrive in between.
      let reply = await group.leader.next();
      while (reply.type === 'token.refreshed') reply = await group.leader.next();
      expect(reply.type).toBe('position.ack');
    }
    scheduler.advance(600_000);
    for (const member of group.members) {
      for (let i = 0; i < 12; i++) await member.next('position.updated');
      await member.expectNoMessage(30);
    }
  });

  it('a returned leader starts counting again from its fresh token', async () => {
    const scheduler = new ManualScheduler();
    // Frozen mode (#13 AC21): the leader keeps the lead while away, as in #5.
    ts = await startTestServer({
      scheduler,
      env: ENV,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, defaultHandoff: 'frozen' }],
    });
    const group = await createGroupWithMembers(ts, 1);
    group.leader.send({ type: 'position.update', position: 1 });
    await group.leader.next('position.ack');
    await group.leader.close();
    await group.members[0]!.next('position.updated');
    await group.members[0]!.next('leader.offline');
    // The offline leader's refresh timer was cleared.
    scheduler.advance(400_000);
    const { client, reply } = await resumeWith(ts, group.leaderToken);
    expect(reply.type).toBe('group.resumed');
    await client.expectNoMessage(30);
    client.send({ type: 'position.update', position: 2 });
    await client.next('position.ack');
    scheduler.advance(300_000);
    expect((await client.next('token.refreshed')).groupId).toBe(group.groupId);
  });
});
