import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenSecrets } from '../src/config/token-secret.js';
import type { GroupRecord } from '../src/groups/group-store.js';
import { GroupService } from '../src/groups/group-service.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { TokenKeyring, deriveAppKey } from '../src/tokens/token-keys.js';
import { TokenService } from '../src/tokens/token-service.js';
import {
  TOKENS_CHECK_PER_APP_PER_MINUTE,
  TOKENS_CHECK_PER_MINUTE,
} from '../src/limits/constants.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_B,
  RESTART_CLOCK_STEP_MS,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';
import { claimsOf, forge } from './helpers/tokens.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
const WINDOW = 20 * MINUTE + 300_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

function secrets(): TokenSecrets {
  return { current: randomBytes(32), source: 'env' };
}

class CountingStore extends InMemoryGroupStore {
  gets = 0;
  override get(namespace: string, id: string): Promise<GroupRecord | undefined> {
    this.gets += 1;
    return super.get(namespace, id);
  }
}

async function check(client: TestClient, tokens: unknown[], reqId = 'c') {
  client.send({ type: 'tokens.check', reqId, tokens });
  return client.next();
}

describe('tokens.check (#5 AC14)', () => {
  it('reports every status, one result per token, in order', async () => {
    const scheduler = new ManualScheduler();
    const tokenSecrets = secrets();
    ts = await startTestServer({ scheduler, tokenSecrets });

    // Expired: a group of the earlier process whose leader window has passed.
    const old = await createGroupWithMembers(ts, 0);
    scheduler.advance(WINDOW);
    // Recoverable and waiting: a group of the earlier process (#13 D15:
    // only a restart leaves a group recoverable).
    const dropped = await createGroupWithMembers(ts, 1);
    await ts.close();

    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, tokenSecrets, store });
    const live = await createGroupWithMembers(ts, 2);
    live.leader.send({ type: 'blocklist.set', blockList: [live.memberIds[1]] });
    await live.leader.next('blocklist.ack');

    const ended = await createGroupWithMembers(ts, 0);
    ended.leader.send({ type: 'group.end' });
    await ended.leader.next('group.ended');
    await waitUntil(() => store.size === 1);

    const client = await ts.connectReady();
    const reply = await check(client, [
      live.leaderToken,
      dropped.leaderToken,
      dropped.memberTokens[0],
      live.memberTokens[1],
      ended.leaderToken,
      old.leaderToken,
      'garbage',
    ]);
    expect(reply).toEqual({
      type: 'tokens.result',
      reqId: 'c',
      results: [
        { status: 'live' },
        { status: 'recoverable' },
        { status: 'waiting' },
        { status: 'blocked' },
        { status: 'ended' },
        { status: 'expired' },
        { status: 'invalid' },
      ],
    });
  });

  it('accepts 20 tokens and refuses 21 or none as an invalid message', async () => {
    ts = await startTestServer();
    const client = await ts.connectReady();
    const twenty = await check(
      client,
      Array.from({ length: 20 }, () => 'x'),
    );
    expect(twenty).toMatchObject({ type: 'tokens.result' });
    if (twenty.type === 'tokens.result') expect(twenty.results).toHaveLength(20);
    expect(
      await check(
        client,
        Array.from({ length: 21 }, () => 'x'),
      ),
    ).toMatchObject({
      code: 'INVALID_MESSAGE',
    });
    expect(await check(client, [])).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(await check(client, ['x'.repeat(2049)])).toMatchObject({ code: 'INVALID_MESSAGE' });
  });
});

describe('no oracle (#5 AC8, AC15)', () => {
  it('an invalid token naming a live group gets the same result as a random string', async () => {
    const tokenSecrets = secrets();
    const store = new CountingStore();
    ts = await startTestServer({ tokenSecrets, store });
    const live = await createGroupWithMembers(ts, 0);
    const claims = claimsOf(live.leaderToken);
    const wrongKey = forge(claims, randomBytes(32));
    const client = await ts.connectReady();
    const before = store.gets;
    const a = await check(client, [wrongKey], 'same');
    const b = await check(client, ['random-string'], 'same');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ results: [{ status: 'invalid' }] });
    // Invalid tokens never reach the store.
    expect(store.gets).toBe(before);
  });

  it('another app’s token is invalid, like garbage', async () => {
    ts = await startTestServer();
    const live = await createGroupWithMembers(ts, 0);
    const other = await ts.connectReady(KEY_B);
    const a = await check(other, [live.leaderToken]);
    const b = await check(other, ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.AAAA']);
    expect(a).toEqual(b);
  });

  it('a forged token with the right key but another audience is invalid', async () => {
    const tokenSecrets = secrets();
    ts = await startTestServer({ tokenSecrets });
    const live = await createGroupWithMembers(ts, 0);
    const forgedAud = forge(
      { ...claimsOf(live.leaderToken), aud: 'app-b' },
      deriveAppKey(tokenSecrets.current, 'app-a'),
    );
    const client = await ts.connectReady();
    expect(await check(client, [forgedAud])).toMatchObject({ results: [{ status: 'invalid' }] });
  });
});

describe('rate limit (#5 AC16)', () => {
  it('allows 10 checks per connection per minute; the 11th is RATE_LIMITED, socket open', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const client = await ts.connectReady();
    for (let i = 0; i < 10; i++) {
      expect((await check(client, ['x'])).type).toBe('tokens.result');
    }
    const limited = await check(client, ['x'], 'r11');
    expect(limited).toMatchObject({
      type: 'error',
      reqId: 'r11',
      code: 'RATE_LIMITED',
      message: 'Too many token checks',
      details: { retryAfterMs: 60_000 },
    });
    expect(client.isClosed).toBe(false);

    // Another connection has its own budget.
    const other = await ts.connectReady();
    expect((await check(other, ['x'])).type).toBe('tokens.result');

    scheduler.advance(60_000);
    expect((await check(client, ['x'])).type).toBe('tokens.result');
  });
});

/** Sends `count` checks of one garbage token each, then reads the replies. */
async function checkMany(client: TestClient, count: number) {
  for (let i = 0; i < count; i++) {
    client.send({ type: 'tokens.check', reqId: `m${i}`, tokens: ['garbage'] });
  }
  const replies = [];
  for (let i = 0; i < count; i++) replies.push(await client.next());
  return replies;
}

/** Uses up app A's shared budget with 60 connections x 10 checks. */
async function exhaustAppBudget(server: TestServer): Promise<void> {
  expect(TOKENS_CHECK_PER_APP_PER_MINUTE).toBe(600);
  for (let i = 0; i < TOKENS_CHECK_PER_APP_PER_MINUTE / 10; i++) {
    const client = await server.connectReady();
    const replies = await checkMany(client, 10);
    expect(replies.every((reply) => reply.type === 'tokens.result')).toBe(true);
    client.terminate();
  }
}

describe('per-app tokens.check budget (#7 L2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses the 601st check of an app before any verification; other apps unaffected (AC4, AC5)', async () => {
    const scheduler = new ManualScheduler();
    const store = new CountingStore();
    ts = await startTestServer({ scheduler, store });
    await exhaustAppBudget(ts);

    const verify = vi.spyOn(TokenService.prototype, 'verify');
    const gets = store.gets;
    const client = await ts.connectReady();
    const limited = await check(client, ['garbage'], 'over');
    expect(limited).toEqual({
      type: 'error',
      reqId: 'over',
      code: 'RATE_LIMITED',
      message: 'Too many token checks',
      details: { retryAfterMs: expect.any(Number) as number },
    });
    if (limited.type === 'error') {
      const retry = limited.details?.retryAfterMs as number;
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(MINUTE);
    }
    expect(verify).not.toHaveBeenCalled();
    expect(store.gets).toBe(gets);
    expect(client.isClosed).toBe(false);

    // App B has its own budget.
    const other = await ts.connectReady(KEY_B);
    expect((await check(other, ['garbage'])).type).toBe('tokens.result');
    expect(verify).toHaveBeenCalledTimes(1);

    // The budget refills after the window.
    scheduler.advance(MINUTE);
    const later = await ts.connectReady();
    expect((await check(later, ['garbage'])).type).toBe('tokens.result');
  });

  it('logs one warning per window per app, with the namespace only (L-2, AC6)', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    await exhaustAppBudget(ts);
    const client = await ts.connectReady();
    const token = forgeLooking();
    expect(await check(client, [token], 'a')).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await check(client, [token], 'b')).toMatchObject({ code: 'RATE_LIMITED' });

    const warnings = ts.logs
      .records()
      .filter((record) => record.event === 'tokens_check_app_budget_exhausted');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 40, namespace: 'app-a' });
    expect(ts.logs.text).not.toContain(token);
  });

  it('leaves no timers and no budget state after close, with both limits used up (AC6)', async () => {
    const scheduler = new ManualScheduler();
    const checkTokens = vi.spyOn(GroupService.prototype, 'checkTokens');
    ts = await startTestServer({ scheduler });
    await exhaustAppBudget(ts);

    // One live connection at its own limit too: 10 checks spend its
    // per-connection budget (refused by the app budget), the 11th is
    // refused by the per-connection limit.
    const client = await ts.connectReady();
    const replies = await checkMany(client, TOKENS_CHECK_PER_MINUTE + 1);
    expect(replies.every((reply) => reply.type === 'error' && reply.code === 'RATE_LIMITED')).toBe(
      true,
    );

    const service = checkTokens.mock.contexts[0] as BudgetState;
    expect(service.appCheckLimiter.size).toBe(1);
    expect(service.checkLimiter.size).toBeGreaterThanOrEqual(1);
    expect(service.appBudgetWarnedAt.size).toBe(1);

    await ts.close();
    ts = undefined;
    expect(scheduler.pending).toBe(0);
    expect(service.appCheckLimiter.size).toBe(0);
    expect(service.checkLimiter.size).toBe(0);
    expect(service.appBudgetWarnedAt.size).toBe(0);
  });
});

/** GroupService's private tokens.check budget state, read by the AC6 test only. */
interface BudgetState {
  readonly checkLimiter: { readonly size: number };
  readonly appCheckLimiter: { readonly size: number };
  readonly appBudgetWarnedAt: ReadonlyMap<string, number>;
}

/** A token-shaped string that must never reach the logs. */
function forgeLooking(): string {
  return `SENTINEL.${randomBytes(12).toString('base64url')}.${randomBytes(12).toString('base64url')}`;
}

describe('secret rotation (#5 AC2)', () => {
  it('still delivers tokens.result with 20 re-signed tokens under the inbound byte cap (#7 AC9)', async () => {
    const old = secrets();
    const fresh = secrets();
    ts = await startTestServer({ tokenSecrets: old });
    const tokens: string[] = [];
    for (let i = 0; i < 20; i++) tokens.push((await createGroupWithMembers(ts, 0)).leaderToken);
    await ts.close();
    ts = await startTestServer({
      tokenSecrets: { current: fresh.current, previous: old.current, source: 'env' },
      // A restart (#13 6.9 layer 2): a later second than the old tokens.
      now: () => Date.now() + RESTART_CLOCK_STEP_MS,
    });
    const client = await ts.connectReady();
    const reply = await check(client, tokens);
    if (reply.type !== 'tokens.result') throw new Error('expected tokens.result');
    expect(reply.results).toHaveLength(20);
    for (const result of reply.results) {
      expect(result.status).toBe('recoverable');
      expect(typeof result.token).toBe('string');
    }
    expect(client.isClosed).toBe(false);
  });

  it('returns a current-secret token for usable previous-secret tokens only', async () => {
    const old = secrets();
    const fresh = secrets();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets: old, scheduler });
    const usable = await createGroupWithMembers(ts, 0);
    const stale = await createGroupWithMembers(ts, 0);
    await ts.close();
    // Rotated: the old secret is now the previous one. Both groups were
    // dropped with the old process.
    ts = await startTestServer({
      tokenSecrets: { current: fresh.current, previous: old.current, source: 'env' },
      scheduler,
    });
    const client = await ts.connectReady();
    const reply = await check(client, [usable.leaderToken, 'garbage']);
    if (reply.type !== 'tokens.result') throw new Error('expected tokens.result');
    const [first, second] = reply.results;
    expect(first?.status).toBe('recoverable');
    const current = new TokenService(new TokenKeyring({ current: fresh.current }));
    expect(current.verify(first?.token, 'app-a', scheduler.now()).ok).toBe(true);
    expect(claimsOf(first?.token)).toEqual(claimsOf(usable.leaderToken));
    expect(second).toEqual({ status: 'invalid' });

    // A current-secret token is not re-signed.
    const again = await check(client, [first?.token]);
    expect(again).toMatchObject({ results: [{ status: 'recoverable' }] });
    if (again.type === 'tokens.result') expect(again.results[0]).not.toHaveProperty('token');

    // An expired previous-secret token is not re-signed either.
    scheduler.advance(WINDOW);
    const expired = await check(client, [stale.leaderToken]);
    expect(expired).toMatchObject({ results: [{ status: 'expired' }] });
    if (expired.type === 'tokens.result') expect(expired.results[0]).not.toHaveProperty('token');
  });
});
