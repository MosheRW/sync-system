import type { JoinMethod } from '@mosherw/sync-system-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupRecord } from '../src/groups/group-store.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { CodeIndex } from '../src/joins/code-index.js';
import { RedisCodeIndex } from '../src/storage/redis/codes.js';
import * as codesModule from '../src/joins/codes.js';
import type { GroupCodes } from '../src/joins/codes.js';
import { CodesBlobService } from '../src/tokens/codes-blob.js';
import { CODES_BLOB_INFO_PREFIX, TokenKeyring } from '../src/tokens/token-keys.js';
import { type JoinFields, codesOf } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  KEY_B,
  type StartOptions,
  TestClock,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';
import { testSecrets } from './helpers/token-secrets.js';

vi.mock('../src/joins/codes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof codesModule>();
  return { ...actual, doorCodeMatches: vi.fn(actual.doorCodeMatches) };
});

const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];
const MINUTE = 60_000;
const SECRET = Buffer.from('q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=');
const blobs = new CodesBlobService(
  new TokenKeyring(testSecrets({ current: SECRET }), CODES_BLOB_INFO_PREFIX),
);

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
async function attempt(client: TestClient, fields: object) {
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

/** A store whose setCodes can be held until the test releases it (N2). */
class DeferredStore extends InMemoryGroupStore {
  hold = false;
  private readonly held: Array<() => void> = [];

  override async setCodes(
    namespace: string,
    id: string,
    codes: GroupCodes,
  ): Promise<GroupRecord | undefined> {
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    return super.setCodes(namespace, id, codes);
  }

  get waiting(): number {
    return this.held.length;
  }

  release(): void {
    this.hold = false;
    for (const resolve of this.held.splice(0)) resolve();
  }
}

async function startManual(store = new InMemoryGroupStore()) {
  const scheduler = new ManualScheduler();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [
      { namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL, maxGroupSize: 100 },
      { namespace: 'app-b', apiKey: KEY_B, joinMethods: ALL },
    ],
    tokenSecrets: { current: SECRET, source: 'env' },
  });
  return { server: ts, scheduler, store };
}

/** A door code that is not `door` (and not the group code). */
function wrongDoor(join: JoinFields): string {
  for (const candidate of ['000000', '000001', '000002']) {
    if (candidate !== join.doorCode && candidate !== join.joinCode) return candidate;
  }
  throw new Error('unreachable');
}

/**
 * Sends `count` wrong door codes for `join`, each on a fresh connection's
 * budget (10 per connection), and returns the replies' codes.
 */
async function wrongAttempts(server: TestServer, join: JoinFields, count: number) {
  const codes: unknown[] = [];
  let client = await server.connectReady();
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 10 === 0) client = await server.connectReady();
    const reply = await attempt(client, { joinCode: join.joinCode, doorCode: wrongDoor(join) });
    codes.push(reply.type === 'error' ? reply.code : reply.type);
  }
  return codes;
}

describe('door-code rotation and pause (#10 AC29, R1a)', () => {
  it('rotates the door code after 5 wrong codes and tells the leader', async () => {
    const { server } = await startManual();
    const { leader, created, join } = await createGroup(server, ['A', 'D']);
    expect(await wrongAttempts(server, join, 5)).toEqual(
      Array.from({ length: 5 }, () => 'DOOR_CODE_WRONG'),
    );
    const updated = await leader.next('codes.updated');
    expect(updated).toMatchObject({ groupId: created.groupId, reason: 'door_failures' });
    expect(updated.reqId).toBeUndefined();
    expect(updated.codes.groupCode).toBe(created.codes.groupCode);
    expect(updated.codes.doorCode).not.toBe(created.codes.doorCode);
    expect(updated.codes.generation).toBeGreaterThan(created.codes.generation);
    const before = blobs.verify(created.codes.blob, 'app-a', created.groupId);
    const after = blobs.verify(updated.codes.blob, 'app-a', created.groupId);
    // Q-B: the ticket generation stays, so QR tickets keep working.
    expect(after?.codes.ticketGeneration).toBe(before?.codes.ticketGeneration);
    expect(after?.codes.generation).toBe(updated.codes.generation);

    const client = await server.connectReady();
    expect(await attempt(client, join)).toMatchObject({ code: 'DOOR_CODE_WRONG' });
    expect(
      (await attempt(client, { joinCode: join.joinCode, doorCode: updated.codes.doorCode })).type,
    ).toBe('group.joined');
  });

  it('counts failures without decay: 4 wrong, 11 minutes, 1 wrong rotates (R1a)', async () => {
    const { server, scheduler } = await startManual();
    const { leader, join } = await createGroup(server, ['A']);
    await wrongAttempts(server, join, 4);
    scheduler.advance(11 * MINUTE);
    await leader.expectNoMessage(30);
    // Drain the token refresh the advance may have sent.
    await wrongAttempts(server, join, 1);
    let message = await leader.next();
    while (message.type === 'token.refreshed') message = await leader.next();
    expect(message).toMatchObject({ type: 'codes.updated', reason: 'door_failures' });
  });

  it('keeps counting over hours and resets the counter on every rotation (R1a)', async () => {
    const { server, scheduler } = await startManual();
    const { leader, join } = await createGroup(server, ['A']);
    await wrongAttempts(server, join, 5);
    const first = await leader.next('codes.updated');
    const next = { joinCode: join.joinCode, doorCode: first.codes.doorCode! };
    await wrongAttempts(server, next, 4);
    await leader.expectNoMessage(30);
    scheduler.advance(2 * 60 * MINUTE);
    await wrongAttempts(server, next, 1);
    let message = await leader.next();
    while (message.type === 'token.refreshed') message = await leader.next();
    expect(message).toMatchObject({ type: 'codes.updated', reason: 'door_failures' });
  });

  it('pauses method A after 3 rotations in 30 minutes, then resumes (AC29)', async () => {
    const { server, scheduler } = await startManual();
    const { leader, created } = await createGroup(server, ['A', 'C']);
    let door = created.codes.doorCode!;
    const groupCode = created.codes.groupCode!;
    for (let rotation = 0; rotation < 3; rotation++) {
      await wrongAttempts(server, { joinCode: groupCode, doorCode: door }, 5);
      door = (await leader.next('codes.updated')).codes.doorCode!;
      if (rotation < 2) scheduler.advance(5 * MINUTE);
    }
    expect(await leader.next('join.paused')).toEqual({
      type: 'join.paused',
      groupId: created.groupId,
      retryAfterMs: 10 * MINUTE,
    });

    const matches = vi.mocked(codesModule.doorCodeMatches);
    matches.mockClear();
    const client = await server.connectReady();
    // Even the correct door code is refused, without being compared.
    expect(await attempt(client, { joinCode: groupCode, doorCode: door })).toEqual({
      type: 'error',
      reqId: 'a',
      code: 'JOIN_PAUSED',
      message: 'Joining with the door code is paused; try again later',
      details: { retryAfterMs: 10 * MINUTE },
    });
    expect(await attempt(client, { joinCode: groupCode })).toMatchObject({ code: 'JOIN_PAUSED' });
    expect(matches).not.toHaveBeenCalled();
    // Method C still works during the pause.
    expect((await attempt(client, { joinCode: created.codes.alphaCode })).type).toBe(
      'group.joined',
    );

    scheduler.advance(10 * MINUTE);
    let message = await leader.next();
    while (message.type === 'token.refreshed') message = await leader.next();
    expect(message).toEqual({ type: 'join.resumed', groupId: created.groupId });
    const joiner = await server.connectReady();
    expect((await attempt(joiner, { joinCode: groupCode, doorCode: door })).type).toBe(
      'group.joined',
    );

    // The earlier rotations are still in the window: the next one pauses again at once.
    await wrongAttempts(server, { joinCode: groupCode, doorCode: door }, 5);
    await leader.next('codes.updated');
    expect(await leader.next('join.paused')).toMatchObject({ retryAfterMs: 10 * MINUTE });
  });

  it('clears the pause timer when the group ends (AC31)', async () => {
    const { server, scheduler } = await startManual();
    const { leader, created } = await createGroup(server, ['A']);
    let door = created.codes.doorCode!;
    for (let rotation = 0; rotation < 3; rotation++) {
      await wrongAttempts(server, { joinCode: created.codes.groupCode!, doorCode: door }, 5);
      door = (await leader.next('codes.updated')).codes.doorCode!;
    }
    await leader.next('join.paused');
    expect(scheduler.nextAt).toBeDefined();
    leader.send({ type: 'group.end' });
    await leader.next('group.ended');
    expect(scheduler.pending).toBe(0);
  });
});

describe('leader rotation (#10 AC30)', () => {
  it('replaces every code and moves both generations to one new value', async () => {
    const { server } = await startManual();
    const { leader, created, join } = await createGroup(server, ['A', 'C', 'D']);
    leader.send({ type: 'codes.rotate', reqId: 'rot' });
    const rotated = await leader.next('codes.updated');
    expect(rotated).toMatchObject({ reqId: 'rot', groupId: created.groupId, reason: 'rotated' });
    expect(rotated.codes.groupCode).not.toBe(created.codes.groupCode);
    expect(rotated.codes.doorCode).not.toBe(created.codes.doorCode);
    expect(rotated.codes.alphaCode).not.toBe(created.codes.alphaCode);
    expect(rotated.codes.generation).toBeGreaterThan(created.codes.generation);
    const verified = blobs.verify(rotated.codes.blob, 'app-a', created.groupId);
    expect(verified?.codes.ticketGeneration).toBe(rotated.codes.generation);

    // The old codes are freed; the new ones admit.
    const client = await server.connectReady();
    expect(await attempt(client, join)).toMatchObject({ code: 'CODE_NOT_FOUND' });
    expect(await attempt(client, { joinCode: created.codes.alphaCode })).toMatchObject({
      code: 'CODE_NOT_FOUND',
    });
    expect((await attempt(client, codesOf(rotated.codes))).type).toBe('group.joined');
  });

  it('resets door-code failures and lifts a pause (join.resumed after the reply)', async () => {
    const { server } = await startManual();
    const { leader, created } = await createGroup(server, ['A']);
    let door = created.codes.doorCode!;
    const groupCode = created.codes.groupCode!;
    for (let rotation = 0; rotation < 3; rotation++) {
      await wrongAttempts(server, { joinCode: groupCode, doorCode: door }, 5);
      door = (await leader.next('codes.updated')).codes.doorCode!;
    }
    await leader.next('join.paused');
    leader.send({ type: 'codes.rotate' });
    const rotated = await leader.next('codes.updated');
    expect(await leader.next('join.resumed')).toEqual({
      type: 'join.resumed',
      groupId: created.groupId,
    });
    const join = codesOf(rotated.codes);
    // Counter reset: 4 wrong codes do not rotate.
    await wrongAttempts(server, join, 4);
    await leader.expectNoMessage(30);
    const client = await server.connectReady();
    expect((await attempt(client, join)).type).toBe('group.joined');
  });

  it('allows 6 rotations per group per minute', async () => {
    const { server, scheduler } = await startManual();
    const { leader } = await createGroup(server, ['C']);
    for (let i = 0; i < 6; i++) {
      leader.send({ type: 'codes.rotate' });
      await leader.next('codes.updated');
    }
    leader.send({ type: 'codes.rotate', reqId: 'x' });
    expect(await leader.next('error')).toEqual({
      type: 'error',
      reqId: 'x',
      code: 'RATE_LIMITED',
      message: 'Too many code rotations',
      details: { retryAfterMs: MINUTE },
    });
    scheduler.advance(MINUTE);
    leader.send({ type: 'codes.rotate' });
    let message = await leader.next();
    while (message.type === 'token.refreshed') message = await leader.next();
    expect(message.type).toBe('codes.updated');
  });

  it('refuses members and groupless sessions (R12)', async () => {
    const { server } = await startManual();
    const { join } = await createGroup(server, ['C']);
    const member = await server.connectReady();
    await attempt(member, join);
    member.send({ type: 'codes.rotate', reqId: 'm' });
    expect(await member.next('error')).toEqual({
      type: 'error',
      reqId: 'm',
      code: 'NOT_LEADER',
      message: 'Only the leader can rotate the codes',
    });
    const outsider = await server.connectReady();
    outsider.send({ type: 'codes.rotate' });
    expect(await outsider.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
  });
});

describe('wrong door codes per app (#10 R1b, N2)', () => {
  it('refuses the 61st wrong door code in a minute across groups, without comparing', async () => {
    const { server, scheduler } = await startManual();
    const groups = [];
    for (let i = 0; i < 13; i++) groups.push(await createGroup(server, ['A']));
    const matches = vi.mocked(codesModule.doorCodeMatches);
    matches.mockClear();
    let wrong = 0;
    for (const group of groups.slice(0, 12)) {
      const codes = await wrongAttempts(server, group.join, 5);
      wrong += codes.filter((code) => code === 'DOOR_CODE_WRONG').length;
    }
    expect(wrong).toBe(60);
    expect(matches).toHaveBeenCalledTimes(60);

    const last = groups[12]!;
    const client = await server.connectReady();
    expect(await attempt(client, { ...last.join, doorCode: wrongDoor(last.join) })).toEqual({
      type: 'error',
      reqId: 'a',
      code: 'RATE_LIMITED',
      message: 'Too many join attempts',
      details: { retryAfterMs: MINUTE },
    });
    // Over budget even the correct door code is not compared.
    expect(await attempt(client, last.join)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(matches).toHaveBeenCalledTimes(60);
    // No group counter moved: 4 more wrong codes later do not rotate group 13.
    const warnings = server.logs
      .records()
      .filter((record) => record.event === 'door_failures_app_budget_exhausted');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ namespace: 'app-a', level: 40 });
    expect(JSON.stringify(warnings[0])).not.toContain(last.join.joinCode);

    // DOOR_CODE_REQUIRED and other apps are not affected.
    expect(await attempt(client, { joinCode: last.join.joinCode })).toMatchObject({
      code: 'DOOR_CODE_REQUIRED',
    });
    const other = await createGroup(server, ['A'], KEY_B);
    const otherClient = await server.connectReady(KEY_B);
    expect(
      await attempt(otherClient, { ...other.join, doorCode: wrongDoor(other.join) }),
    ).toMatchObject({ code: 'DOOR_CODE_WRONG' });

    scheduler.advance(MINUTE);
    expect(await wrongAttempts(server, last.join, 4)).toEqual(
      Array.from({ length: 4 }, () => 'DOOR_CODE_WRONG'),
    );
    await last.leader.expectNoMessage(30);
  });

  it('never charges correct door codes to the budget', async () => {
    const { server } = await startManual();
    const group = await createGroup(server, ['A']);
    for (let i = 0; i < 61; i++) {
      // A fresh connection per join: each joiner becomes a member.
      const joiner = await server.connectReady();
      expect((await attempt(joiner, group.join)).type).toBe('group.joined');
    }
    expect(await wrongAttempts(server, group.join, 5)).toEqual(
      Array.from({ length: 5 }, () => 'DOOR_CODE_WRONG'),
    );
  });

  it('records the failure before the rotation is stored, so other groups see it (N2)', async () => {
    const store = new DeferredStore();
    const { server } = await startManual(store);
    const groups = [];
    for (let i = 0; i < 13; i++) groups.push(await createGroup(server, ['A']));
    for (const group of groups.slice(0, 11)) await wrongAttempts(server, group.join, 5);
    const twelfth = groups[11]!;
    await wrongAttempts(server, twelfth.join, 4);

    // The 60th wrong code rotates group 12; its store write is held.
    store.hold = true;
    const slow = await server.connectReady();
    slow.send({
      type: 'group.joinByCode',
      joinCode: twelfth.join.joinCode,
      doorCode: wrongDoor(twelfth.join),
    });
    await vi.waitFor(() => expect(store.waiting).toBe(1));

    // Meanwhile the 61st, on another group of the app, is refused.
    const thirteenth = groups[12]!;
    const fast = await server.connectReady();
    expect(
      await attempt(fast, { ...thirteenth.join, doorCode: wrongDoor(thirteenth.join) }),
    ).toMatchObject({ code: 'RATE_LIMITED' });
    expect(slow.pending).toBe(0);

    store.release();
    expect(await slow.next('error')).toMatchObject({ code: 'DOOR_CODE_WRONG' });
    expect((await twelfth.leader.next('codes.updated')).reason).toBe('door_failures');
  });
});

describe('join attempts per app (#10 AC28)', () => {
  it('allows 600 attempts per app per minute across connections; other apps are not affected', async () => {
    const { server, clock } = await start();
    // The memory index, or the Redis one when the suite runs on Redis (#35).
    const memoryLookup = vi.spyOn(CodeIndex.prototype, 'lookup');
    const redisLookup = vi.spyOn(RedisCodeIndex.prototype, 'lookup');
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
    expect(memoryLookup.mock.calls.length + redisLookup.mock.calls.length).toBe(600);
    const extra = await server.connectReady();
    expect(await attempt(extra, { joinCode: '000000' })).toEqual({
      type: 'error',
      reqId: 'a',
      code: 'RATE_LIMITED',
      message: 'Too many join attempts',
      details: { retryAfterMs: 60_000 },
    });
    expect(memoryLookup.mock.calls.length + redisLookup.mock.calls.length).toBe(600);
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
