import type { JoinMethod } from '@sync-system/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeIndex } from '../src/joins/code-index.js';
import { codesOf } from './helpers/groups.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  KEY_B,
  type StartOptions,
  TestClock,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';

const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];

let ts: TestServer | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ts?.close();
  ts = undefined;
});

async function start(
  options: StartOptions = {},
): Promise<{ server: TestServer; clock: TestClock }> {
  const clock = new TestClock(1_767_225_600_000);
  ts = await startTestServer({
    now: clock.now,
    apps: [
      { namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL, maxConnections: 1000 },
      { namespace: 'app-b', apiKey: KEY_B, joinMethods: ALL },
    ],
    env: { MAX_CONNECTIONS: '2000', MAX_APP_CONNECTIONS_CEILING: '1000' },
    ...options,
  });
  return { server: ts, clock };
}

async function createGroup(server: TestServer, joinMethods: JoinMethod[], apiKey = KEY_A) {
  const leader = await server.connectReady(apiKey);
  leader.send({ type: 'group.create', metadata: {}, joinMethods });
  const created = await leader.next('group.created');
  return { leader, created, join: codesOf(created.codes) };
}

/** Sends one join attempt and returns the reply. */
async function attempt(client: TestClient, fields: Record<string, unknown>) {
  client.send({ type: 'group.joinByCode', reqId: 'a', ...fields });
  return client.next();
}

describe('join attempts per connection (#10 AC27)', () => {
  it('allows 10 attempts of any outcome per minute, then RATE_LIMITED before any lookup', async () => {
    const { server, clock } = await start();
    const { join } = await createGroup(server, ['A']);
    const client = await server.connectReady();
    const unknown = join.joinCode === '000000' ? '000001' : '000000';
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push((await attempt(client, { joinCode: unknown })).type);
    for (let i = 0; i < 3; i++) {
      outcomes.push((await attempt(client, { joinCode: join.joinCode })).type);
    }
    for (let i = 0; i < 3; i++) outcomes.push((await attempt(client, { joinCode: 'bad' })).type);
    expect(outcomes).toEqual(Array.from({ length: 10 }, () => 'error'));

    const lookup = vi.spyOn(CodeIndex.prototype, 'lookup');
    clock.advance(1000);
    expect(await attempt(client, join)).toEqual({
      type: 'error',
      reqId: 'a',
      code: 'RATE_LIMITED',
      message: 'Too many join attempts',
      details: { retryAfterMs: 59_000 },
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);

    clock.advance(59_000);
    expect((await attempt(client, join)).type).toBe('group.joined');
  });

  it('spends no budget on a busy session (AC18)', async () => {
    const { server } = await start();
    const { leader, join } = await createGroup(server, ['C']);
    for (let i = 0; i < 12; i++) {
      expect(await attempt(leader, join)).toMatchObject({ code: 'ALREADY_IN_GROUP' });
    }
  });

  it('forgets the per-connection budget only for that connection', async () => {
    const { server } = await start();
    const { join } = await createGroup(server, ['C']);
    const first = await server.connectReady();
    for (let i = 0; i < 10; i++) await attempt(first, { joinCode: 'bad' });
    expect(await attempt(first, join)).toMatchObject({ code: 'RATE_LIMITED' });
    const second = await server.connectReady();
    expect((await attempt(second, join)).type).toBe('group.joined');
  });
});

describe('join attempts per app (#10 AC28)', () => {
  it('allows 600 attempts per app per minute across connections; other apps are not affected', async () => {
    const { server, clock } = await start();
    const lookup = vi.spyOn(CodeIndex.prototype, 'lookup');
    const clients: TestClient[] = [];
    for (let c = 0; c < 60; c++) {
      const client = await server.connectReady();
      clients.push(client);
      for (let i = 0; i < 10; i++) client.send({ type: 'group.joinByCode', joinCode: '000000' });
    }
    for (const client of clients) {
      for (let i = 0; i < 10; i++) {
        expect(await client.next('error')).toMatchObject({ code: 'CODE_NOT_FOUND' });
      }
    }
    expect(lookup).toHaveBeenCalledTimes(600);
    const extra = await server.connectReady();
    expect(await attempt(extra, { joinCode: '000000' })).toEqual({
      type: 'error',
      reqId: 'a',
      code: 'RATE_LIMITED',
      message: 'Too many join attempts',
      details: { retryAfterMs: 60_000 },
    });
    expect(lookup).toHaveBeenCalledTimes(600);
    const warnings = server.logs
      .records()
      .filter((record) => record.event === 'join_app_budget_exhausted');
    expect(warnings).toEqual([expect.objectContaining({ namespace: 'app-a', level: 40 })]);
    expect(Object.keys(warnings[0]!).sort()).toEqual(
      ['event', 'hostname', 'level', 'msg', 'namespace', 'pid', 'time'].sort(),
    );
    // Only one warning per window.
    expect(await attempt(extra, { joinCode: '000000' })).toMatchObject({ code: 'RATE_LIMITED' });
    expect(
      server.logs.records().filter((record) => record.event === 'join_app_budget_exhausted'),
    ).toHaveLength(1);

    // App B has its own budget.
    const { join } = await createGroup(server, ['C'], KEY_B);
    const other = await server.connectReady(KEY_B);
    expect((await attempt(other, join)).type).toBe('group.joined');

    clock.advance(60_000);
    expect(await attempt(extra, { joinCode: '000000' })).toMatchObject({
      code: 'CODE_NOT_FOUND',
    });
  });
});
