import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { TokenSecretsInput } from '../src/config/token-secret.js';
import { TIMER_LEASE_MS } from '../src/limits/constants.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  type TestAppInput,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
const GRACE = 30_000;
/** Default limit 20 min, default countdown 60 s: the prompt is due after 19 min. */
const PROMPT_AFTER = 19 * MINUTE;
const COUNTDOWN = 60_000;

/** Events a fired timer logs; a second start must log none of them. */
const TIMER_EVENTS = ['timer_claimed', 'keepalive_missed', 'group_ended', 'join_resumed'];

/**
 * AC12: a deadline that passed while the server was down takes effect once
 * at the start, with the outcome it has without a restart; a second start
 * fires nothing (#35 architecture 15).
 */
describeRedis('deadlines passed while down, at the start (#35 AC12)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;
  let secrets: TokenSecretsInput;
  let scheduler: ManualScheduler;
  let apps: TestAppInput[] | undefined;
  const servers: TestServer[] = [];

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    for (const ts of servers.splice(0)) await ts.close();
    await inspect.flush(prefix);
  });

  function fresh(withApps?: TestAppInput[]): void {
    prefix = randomPrefix();
    secrets = { current: randomBytes(32), source: 'env' };
    scheduler = new ManualScheduler();
    apps = withApps;
  }

  async function start(): Promise<TestServer> {
    const ts = await startTestServer({
      redisPrefix: prefix,
      tokenSecrets: secrets,
      scheduler,
      ...(apps === undefined ? {} : { apps }),
    });
    servers.push(ts);
    return ts;
  }

  async function stop(ts: TestServer): Promise<void> {
    servers.splice(servers.indexOf(ts), 1);
    await ts.server.close();
  }

  function count(ts: TestServer, event: string): number {
    return ts.logs.events().filter((e) => e === event).length;
  }

  /**
   * A third start once the leases of the second start's claims ran out: a
   * timer that fired is gone, so nothing is claimed or fired again.
   */
  async function startsQuietly(second: TestServer): Promise<void> {
    await stop(second);
    scheduler.advance(TIMER_LEASE_MS + 1000);
    const third = await start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const event of TIMER_EVENTS) expect(count(third, event), event).toBe(0);
  }

  it('a missed keep-alive pauses the group once, then hands off after the grace', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 1);
    scheduler.advance(PROMPT_AFTER);
    await group.leader.next('keepalive.prompt');
    await stop(first);
    // Down past the countdown.
    scheduler.advance(2 * COUNTDOWN);
    const second = await start();
    await waitUntil(() => count(second, 'keepalive_missed') === 1, 2000, 'keep-alive missed');
    expect(second.logs.find('group_paused')).toMatchObject({ cause: 'inactive' });
    const { client: member, reply } = await resumeWith(second, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'group.joined', leaderOnline: false });
    scheduler.advance(GRACE);
    expect(await member.next('leader.granted')).toMatchObject({ groupId: group.groupId });
    expect(count(second, 'keepalive_missed')).toBe(1);
    expect(count(second, 'group_ended')).toBe(0);
    await startsQuietly(second);
  });

  it('an escalated leader that missed its keep-alive ends the group once (AC22)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 2);
    const [next, other] = group.members as [TestClient, TestClient];
    // The first leader misses: pause, grace, the next member leads (escalated).
    scheduler.advance(PROMPT_AFTER);
    await group.leader.next('keepalive.prompt');
    scheduler.advance(COUNTDOWN);
    await next.next('leader.offline');
    await other.next('leader.offline');
    scheduler.advance(GRACE);
    await next.next('leader.granted');
    await other.next('leader.changed');
    // The new leader is prompted, then the server stops.
    scheduler.advance(PROMPT_AFTER);
    await next.next('keepalive.prompt');
    await stop(first);
    scheduler.advance(2 * COUNTDOWN);
    const second = await start();
    await waitUntil(() => count(second, 'group_ended') === 1, 2000, 'group ended');
    expect(second.logs.find('group_ended')).toMatchObject({ endReason: 'inactivity' });
    expect(count(second, 'keepalive_missed')).toBe(1);
    const { reply } = await resumeWith(second, group.memberTokens[1]);
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
    expect(await inspect.keys(`${prefix}:v1:g`)).toEqual([]);
    await startsQuietly(second);
  });

  it('a frozen group past its end bound ends once at the start', async () => {
    fresh([{ namespace: 'app-a', apiKey: KEY_A, defaultHandoff: 'frozen' }]);
    const first = await start();
    const group = await createGroupWithMembers(first, 1);
    group.leader.terminate();
    await group.members[0]!.next('leader.offline');
    await stop(first);
    // Inactivity limit (20 min) plus the max refresh interval (300 s), and more.
    scheduler.advance(20 * MINUTE + 300_000 + MINUTE);
    const second = await start();
    await waitUntil(() => count(second, 'group_ended') === 1, 2000, 'group ended');
    const checker = await second.connectReady();
    checker.send({ type: 'tokens.check', tokens: [group.leaderToken, group.memberTokens[0]] });
    expect(await checker.next('tokens.result')).toMatchObject({
      results: [{ status: 'ended' }, { status: 'ended' }],
    });
    expect(await inspect.keys(`${prefix}:v1:g`)).toEqual([]);
    await startsQuietly(second);
  });

  it('a door-code pause that ran out while down is lifted once at the start (#10 AC29)', async () => {
    fresh([{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'C'], maxGroupSize: 100 }]);
    const first = await start();
    const leader = await first.connectReady();
    leader.send({ type: 'group.create', metadata: {}, joinMethods: ['A', 'C'] });
    const created = await leader.next('group.created');
    const groupCode = created.codes.groupCode!;
    let door = created.codes.doorCode!;
    const wrong = ['000000', '000001', '000002'].find((c) => c !== groupCode && c !== door)!;
    for (let rotation = 0; rotation < 3; rotation++) {
      let client = await first.connectReady();
      for (let i = 0; i < 5; i++) {
        if (i > 0 && i % 10 === 0) client = await first.connectReady();
        client.send({ type: 'group.joinByCode', joinCode: groupCode, doorCode: wrong });
        expect(await client.next('error')).toMatchObject({ code: 'DOOR_CODE_WRONG' });
      }
      door = (await leader.next('codes.updated')).codes.doorCode!;
      if (rotation < 2) scheduler.advance(5 * MINUTE);
    }
    expect(await leader.next('join.paused')).toMatchObject({ retryAfterMs: 10 * MINUTE });
    await stop(first);
    // Down past the 10 minute pause.
    scheduler.advance(11 * MINUTE);
    const second = await start();
    await waitUntil(() => count(second, 'join_resumed') === 1, 2000, 'join resumed');
    // The leader returns (an empty group is held until then), and door-code
    // joining works again.
    const { reply: resumed } = await resumeWith(second, created.token, { metadata: {} });
    expect(resumed).toMatchObject({ type: 'group.resumed', recreated: false });
    const joiner = await second.connectReady();
    joiner.send({ type: 'group.joinByCode', joinCode: groupCode, doorCode: door });
    expect(await joiner.next()).toMatchObject({ type: 'group.joined', groupId: created.groupId });
    expect(count(second, 'join_resumed')).toBe(1);
    await startsQuietly(second);
  });
});
