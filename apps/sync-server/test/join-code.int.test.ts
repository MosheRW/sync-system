import {
  ALPHA_CODE_PATTERN,
  GROUP_CODE_PATTERN,
  type JoinCodesPayload,
  type JoinMethod,
  PARTICIPANT_ID_PATTERN,
  decodeTokenClaims,
} from '@sync-system/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { CodesBlobService } from '../src/tokens/codes-blob.js';
import { CODES_BLOB_INFO_PREFIX, TokenKeyring } from '../src/tokens/token-keys.js';
import { ScriptedRandom } from './helpers/codes.js';
import { createGroupWithMembers } from './helpers/groups.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  KEY_B,
  type StartOptions,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const SECRET = Buffer.from('q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=');
const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

async function start(options: StartOptions = {}): Promise<TestServer> {
  ts = await startTestServer({
    apps: [
      { namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL },
      { namespace: 'app-b', apiKey: KEY_B, joinMethods: ['A', 'C', 'D'] },
    ],
    tokenSecrets: { current: SECRET, source: 'env' },
    ...options,
  });
  return ts;
}

async function create(
  client: TestClient,
  joinMethods?: unknown,
): Promise<Extract<Awaited<ReturnType<TestClient['next']>>, { type: 'group.created' }>> {
  const message: Record<string, unknown> = { type: 'group.create', metadata: { c: 1 } };
  if (joinMethods !== undefined) message.joinMethods = joinMethods;
  client.send(message);
  return client.next('group.created');
}

const blobs = new CodesBlobService(new TokenKeyring({ current: SECRET }, CODES_BLOB_INFO_PREFIX));

describe('codes at group creation (#10 AC5, AC6)', () => {
  it('returns the codes of the group methods, a generation and a verifiable blob', async () => {
    const server = await start();
    const cases: Array<[JoinMethod[] | undefined, JoinMethod[], (keyof JoinCodesPayload)[]]> = [
      [undefined, ['A', 'C', 'D'], ['groupCode', 'doorCode', 'alphaCode']],
      [['A'], ['A'], ['groupCode', 'doorCode']],
      [['B', 'D'], ['B', 'D'], ['groupCode']],
      [['D', 'C'], ['C', 'D'], ['alphaCode']],
      [['D'], ['D'], []],
    ];
    for (const [requested, methods, present] of cases) {
      const leader = await server.connectReady();
      const created = await create(leader, requested);
      expect(created.joinMethods).toEqual(methods);
      const { codes } = created;
      expect(Object.keys(codes).sort()).toEqual(['blob', 'generation', ...present].sort());
      expect(Number.isSafeInteger(codes.generation)).toBe(true);
      if (codes.groupCode !== undefined) expect(codes.groupCode).toMatch(GROUP_CODE_PATTERN);
      if (codes.doorCode !== undefined) {
        expect(codes.doorCode).toMatch(GROUP_CODE_PATTERN);
        expect(codes.doorCode).not.toBe(codes.groupCode);
      }
      if (codes.alphaCode !== undefined) expect(codes.alphaCode).toMatch(ALPHA_CODE_PATTERN);
      const verified = blobs.verify(codes.blob, 'app-a', created.groupId);
      expect(verified?.methods).toEqual(methods);
      expect(verified?.codes).toMatchObject({
        generation: codes.generation,
        ticketGeneration: codes.generation,
      });
      expect(verified?.codes.groupCode).toBe(codes.groupCode);
      expect(verified?.codes.doorCode).toBe(codes.doorCode);
      expect(verified?.codes.alphaCode).toBe(codes.alphaCode);
    }
  });

  it('rejects a bad method set with JOIN_METHOD_NOT_ALLOWED and stores nothing (AC5)', async () => {
    const store = new InMemoryGroupStore();
    const server = await start({ store });
    const leader = await server.connectReady(KEY_B);
    for (const joinMethods of [['A', 'A'], ['A', 'B'], ['B'], ['C', 'C', 'D']]) {
      leader.send({ type: 'group.create', reqId: 'r', metadata: {}, joinMethods });
      expect(await leader.next('error')).toEqual({
        type: 'error',
        reqId: 'r',
        code: 'JOIN_METHOD_NOT_ALLOWED',
        message: 'Join method not allowed',
      });
    }
    for (const joinMethods of [[], ['E'], 'A', ['A', 'B', 'C', 'D', 'A']]) {
      leader.send({ type: 'group.create', metadata: {}, joinMethods });
      expect(await leader.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    }
    expect(store.size).toBe(0);
    // The connection can still create a group.
    expect((await create(leader, ['A'])).joinMethods).toEqual(['A']);
  });

  it('defaults to the app methods minus B when A is allowed (AC5)', async () => {
    const server = await start({
      apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'B', 'D'] }],
    });
    expect((await create(await server.connectReady())).joinMethods).toEqual(['A', 'D']);
  });

  it('never sends codes to members (AC10, R13)', async () => {
    const server = await start();
    const group = await createGroupWithMembers(server, 1);
    group.leader.send({ type: 'position.update', position: { p: 1 } });
    await group.leader.next('position.ack');
    const updated = await group.members[0]!.next('position.updated');
    expect(JSON.stringify(updated)).not.toContain('codes');
  });
});

describe('code uniqueness and release (#10 AC9, AC11)', () => {
  it('redraws a code another live group of the app holds; other apps may share it', async () => {
    const random = new ScriptedRandom();
    const server = await start({ codeRandom: random.next });
    random.queue(7);
    const first = await create(await server.connectReady(), ['B']);
    expect(first.codes.groupCode).toBe('000007');
    random.queue(7, 8);
    const second = await create(await server.connectReady(), ['B']);
    expect(second.codes.groupCode).toBe('000008');
    random.queue(7, 2);
    const other = await create(await server.connectReady(KEY_B), ['A']);
    expect(other.codes.groupCode).toBe('000007');
  });

  it('fails with CODES_EXHAUSTED after 20 taken draws and registers nothing', async () => {
    const random = new ScriptedRandom();
    const store = new InMemoryGroupStore();
    const server = await start({ codeRandom: random.next, store });
    random.queue(7);
    await create(await server.connectReady(), ['B']);
    random.queue(...Array.from({ length: 20 }, () => 7));
    const leader = await server.connectReady();
    leader.send({ type: 'group.create', metadata: {}, joinMethods: ['B'] });
    expect(await leader.next('error')).toMatchObject({
      code: 'CODES_EXHAUSTED',
      message: 'No free join code; try again',
    });
    expect(store.size).toBe(1);
  });

  it.each([
    ['ended by the leader', 'end'],
    ['dropped from memory', 'drop'],
  ] as const)('frees the codes of a group %s', async (_label, how) => {
    const random = new ScriptedRandom();
    const store = new InMemoryGroupStore();
    const server = await start({ codeRandom: random.next, store });
    const scripted = [7, 0, 0, 0, 0, 0, 0, 0, 0];
    random.queue(...scripted);
    const leader = await server.connectReady();
    const first = await create(leader, ['B', 'C']);
    if (how === 'end') {
      leader.send({ type: 'group.end' });
      await leader.next('group.ended');
    } else {
      await leader.close();
      await waitUntil(() => store.size === 0);
    }
    random.queue(...scripted);
    const second = await create(await server.connectReady(), ['B', 'C']);
    expect(second.codes.groupCode).toBe(first.codes.groupCode);
    expect(second.codes.alphaCode).toBe('22222222');
    expect(first.codes.alphaCode).toBe('22222222');
  });
});

type Created = Awaited<ReturnType<typeof create>>;

/** A new connection that sends group.joinByCode; returns it with the reply. */
async function joinWith(
  server: TestServer,
  fields: Record<string, unknown>,
  apiKey = KEY_A,
): Promise<{ client: TestClient; reply: Awaited<ReturnType<TestClient['next']>> }> {
  const client = await server.connectReady(apiKey);
  client.send({ type: 'group.joinByCode', reqId: 'j', ...fields });
  return { client, reply: await client.next() };
}

async function leaderOf(
  server: TestServer,
  joinMethods: JoinMethod[],
  apiKey = KEY_A,
): Promise<{ leader: TestClient; created: Created }> {
  const leader = await server.connectReady(apiKey);
  return { leader, created: await create(leader, joinMethods) };
}

describe('join by group code and door code (#10 AC14, AC15)', () => {
  it('admits with both codes and returns group.joined with a member token (AC14)', async () => {
    const server = await start();
    const { created } = await leaderOf(server, ['A', 'D']);
    const { reply } = await joinWith(server, {
      joinCode: created.codes.groupCode,
      doorCode: created.codes.doorCode,
    });
    expect(reply).toEqual({
      type: 'group.joined',
      reqId: 'j',
      groupId: created.groupId,
      participantId: expect.stringMatching(PARTICIPANT_ID_PATTERN) as string,
      role: 'member',
      displayName: expect.any(String) as string,
      generated: true,
      locked: false,
      metadata: { c: 1 },
      token: expect.any(String) as string,
      leaderOnline: true,
      hasPosition: false,
    });
    const claims = decodeTokenClaims((reply as { token: string }).token);
    expect(claims).toMatchObject({ gid: created.groupId, role: 'member', aud: 'app-a' });
  });

  it('asks for the door code without counting a failure, then rejects a wrong one (AC15)', async () => {
    const server = await start();
    const { created } = await leaderOf(server, ['A']);
    const { groupCode, doorCode } = created.codes;
    const client = await server.connectReady();
    for (let i = 0; i < 6; i++) {
      client.send({ type: 'group.joinByCode', reqId: 'r', joinCode: groupCode });
      expect(await client.next('error')).toEqual({
        type: 'error',
        reqId: 'r',
        code: 'DOOR_CODE_REQUIRED',
        message: 'Door code required',
      });
    }
    const wrong = doorCode === '000000' ? '000001' : '000000';
    client.send({ type: 'group.joinByCode', reqId: 'r', joinCode: groupCode, doorCode: wrong });
    expect(await client.next('error')).toEqual({
      type: 'error',
      reqId: 'r',
      code: 'DOOR_CODE_WRONG',
      message: 'Wrong door code',
    });
    client.send({ type: 'group.joinByCode', joinCode: groupCode, doorCode });
    expect((await client.next('group.joined')).groupId).toBe(created.groupId);
  });

  it('applies the group size limit (AC14)', async () => {
    const server = await start({
      apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL, maxGroupSize: 2 }],
    });
    const { created } = await leaderOf(server, ['C']);
    expect((await joinWith(server, { joinCode: created.codes.alphaCode })).reply.type).toBe(
      'group.joined',
    );
    const { reply } = await joinWith(server, { joinCode: created.codes.alphaCode });
    expect(reply).toMatchObject({ code: 'GROUP_FULL', details: { maxGroupSize: 2 } });
  });
});

describe('join by alphanumeric code (#10 AC16)', () => {
  it('admits directly, case-insensitive and with hyphens and spaces (AC12)', async () => {
    const server = await start();
    const { created } = await leaderOf(server, ['C', 'D']);
    const alpha = created.codes.alphaCode!;
    const typed = ` ${alpha.slice(0, 4).toLowerCase()}-${alpha.slice(4)} `;
    const { reply } = await joinWith(server, { joinCode: typed });
    expect(reply).toMatchObject({ type: 'group.joined', groupId: created.groupId });
  });

  it('uses the display name of a direct join as the member name (#13 AC35)', async () => {
    const server = await start();
    const { created } = await leaderOf(server, ['C']);
    const { reply } = await joinWith(server, {
      joinCode: created.codes.alphaCode,
      displayName: ' Dana ',
    });
    expect(reply).toMatchObject({ type: 'group.joined', displayName: 'Dana', generated: false });
  });
});

describe('normalization and validation (#10 AC12, AC20)', () => {
  it('normalizes a group code typed with spaces and hyphens', async () => {
    const server = await start();
    const { created } = await leaderOf(server, ['A']);
    const code = created.codes.groupCode!;
    const door = created.codes.doorCode!;
    const { reply } = await joinWith(server, {
      joinCode: ` ${code.slice(0, 3)}-${code.slice(3)} `,
      doorCode: `${door.slice(0, 3)} ${door.slice(3)}`,
    });
    expect(reply.type).toBe('group.joined');
  });

  it('rejects malformed codes, door codes and names with INVALID_MESSAGE', async () => {
    const server = await start();
    let client = await server.connectReady();
    let sent = 0;
    const bell = String.fromCharCode(7);
    const override = String.fromCharCode(0x202e);
    for (const fields of [
      { joinCode: '12345' },
      { joinCode: '1234567' },
      { joinCode: 'ABCDEFG0' },
      { joinCode: 'ABCDEFGHJ' },
      { joinCode: '' },
      { joinCode: '1'.repeat(33) },
      { joinCode: 123456 },
      {},
      { joinCode: '123456', doorCode: '12345' },
      { joinCode: '123456', doorCode: 'ABCDEF' },
      { joinCode: '123456', doorCode: '1'.repeat(33) },
      { joinCode: '123456', displayName: 'x'.repeat(33) },
      { joinCode: '123456', displayName: `a${bell}b` },
      { joinCode: '123456', displayName: `a${override}b` },
      { joinCode: '123456', displayName: 'x'.repeat(129) },
    ]) {
      // A fresh connection every 10 attempts stays within its join budget.
      if (sent++ % 10 === 9) client = await server.connectReady();
      client.send({ type: 'group.joinByCode', reqId: 'bad', ...fields });
      expect(await client.next('error'), JSON.stringify(fields)).toEqual({
        type: 'error',
        reqId: 'bad',
        code: 'INVALID_MESSAGE',
        message: 'Invalid message',
      });
    }
  });
});

describe('one answer for every unknown code (#10 AC13, R7)', () => {
  it('gives byte-identical replies for an unknown code, another app code and an unused type', async () => {
    const keyC = 'test-key-app-c-0123456789-0123456789-abcdef';
    const server = await start({
      apps: [
        { namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL },
        { namespace: 'app-b', apiKey: KEY_B, joinMethods: ALL },
        { namespace: 'app-c', apiKey: keyC, joinMethods: ['C', 'D'] },
      ],
    });
    const { created: inB } = await leaderOf(server, ['A', 'C'], KEY_B);
    const unknown = inB.codes.groupCode === '000000' ? '000001' : '000000';
    const replies: string[] = [];
    for (const [apiKey, joinCode] of [
      [KEY_A, unknown],
      [KEY_A, inB.codes.groupCode],
      [KEY_A, inB.codes.alphaCode],
      [keyC, unknown],
    ] as const) {
      const { reply } = await joinWith(server, { joinCode, doorCode: '123456' }, apiKey);
      replies.push(JSON.stringify(reply));
    }
    expect(new Set(replies).size).toBe(1);
    expect(JSON.parse(replies[0]!)).toEqual({
      type: 'error',
      reqId: 'j',
      code: 'CODE_NOT_FOUND',
      message: 'Join code not found',
    });
  });

  it('treats the code of an ended group as not found (AC11)', async () => {
    const server = await start();
    const { leader, created } = await leaderOf(server, ['C']);
    leader.send({ type: 'group.end' });
    await leader.next('group.ended');
    const { reply } = await joinWith(server, { joinCode: created.codes.alphaCode });
    expect(reply).toMatchObject({ code: 'CODE_NOT_FOUND' });
  });
});

describe('frozen groups and busy sessions (#10 AC17, AC18)', () => {
  it('admits A and C joiners while the leader is offline (AC17)', async () => {
    const server = await start();
    const { leader, created } = await leaderOf(server, ['A', 'D']);
    const { client: first } = await joinWith(server, {
      joinCode: created.codes.groupCode,
      doorCode: created.codes.doorCode,
    });
    await leader.close();
    await first.next('leader.offline');
    const { reply } = await joinWith(server, {
      joinCode: created.codes.groupCode,
      doorCode: created.codes.doorCode,
    });
    expect(reply).toMatchObject({ type: 'group.joined', leaderOnline: false });

    const { leader: leaderC, created: createdC } = await leaderOf(server, ['C']);
    const { client: memberC } = await joinWith(server, { joinCode: createdC.codes.alphaCode });
    await leaderC.close();
    await memberC.next('leader.offline');
    const late = await joinWith(server, { joinCode: createdC.codes.alphaCode });
    expect(late.reply).toMatchObject({ type: 'group.joined', leaderOnline: false });
  });

  it('answers ALREADY_IN_GROUP to a member and to the leader (AC18)', async () => {
    const server = await start();
    const { leader, created } = await leaderOf(server, ['C']);
    const { client: member } = await joinWith(server, { joinCode: created.codes.alphaCode });
    for (const client of [leader, member]) {
      client.send({ type: 'group.joinByCode', joinCode: created.codes.alphaCode });
      expect(await client.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });
    }
  });
});
