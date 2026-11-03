import {
  ALPHA_CODE_PATTERN,
  GROUP_CODE_PATTERN,
  type JoinCodesPayload,
  type JoinMethod,
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
