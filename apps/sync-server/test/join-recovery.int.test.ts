import type { JoinMethod, ServerMessage } from '@sync-system/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecrets } from '../src/config/token-secret.js';
import {
  MAX_BLOCK_LIST_SIZE,
  MAX_CODES_BLOB_LENGTH,
  MAX_TOKEN_LENGTH,
} from '@sync-system/protocol';
import { transportMaxPayload } from '../src/limits/constants.js';
import { CodesBlobService } from '../src/tokens/codes-blob.js';
import { CODES_BLOB_INFO_PREFIX, TokenKeyring } from '../src/tokens/token-keys.js';
import { ScriptedRandom } from './helpers/codes.js';
import { codesOf, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  KEY_B,
  type TestAppInput,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';

const SECRET = Buffer.from('q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=');
const TOKEN_SECRETS: TokenSecrets = { current: SECRET, source: 'env' };
const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];
const APPS: TestAppInput[] = [
  { namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL },
  { namespace: 'app-b', apiKey: KEY_B, joinMethods: ALL },
];
const blobs = new CodesBlobService(new TokenKeyring({ current: SECRET }, CODES_BLOB_INFO_PREFIX));

let ts: TestServer | undefined;
const scheduler = new ManualScheduler();
const random = new ScriptedRandom();

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

async function start(apps: TestAppInput[] = APPS): Promise<TestServer> {
  ts = await startTestServer({
    scheduler,
    apps,
    tokenSecrets: TOKEN_SECRETS,
    codeRandom: random.next,
  });
  return ts;
}

/** Stops the server and starts a new, empty one with the same secret (a restart). */
async function restart(apps: TestAppInput[] = APPS, advanceMs = 60_000): Promise<TestServer> {
  await ts?.close();
  scheduler.advance(advanceMs);
  return start(apps);
}

async function create(server: TestServer, joinMethods: JoinMethod[], apiKey = KEY_A) {
  const leader = await server.connectReady(apiKey);
  leader.send({ type: 'group.create', metadata: { m: 1 }, joinMethods });
  const created = await leader.next('group.created');
  return { leader, created };
}

async function issue(leader: TestClient): Promise<string> {
  leader.send({ type: 'qr.issue' });
  return (await leader.next('qr.ticket')).ticket;
}

async function joinQr(server: TestServer, ticket: string): Promise<ServerMessage> {
  const client = await server.connectReady();
  client.send({ type: 'group.joinByQr', ticket });
  return client.next();
}

async function joinCode(server: TestServer, fields: object): Promise<ServerMessage> {
  const client = await server.connectReady();
  client.send({ type: 'group.joinByCode', ...fields });
  return client.next();
}

function resumed(reply: ServerMessage) {
  if (reply.type !== 'group.resumed') throw new Error(`expected group.resumed: ${reply.type}`);
  return reply;
}

describe('recreation keeps the codes with a valid blob (#10 AC32, AC33, Q-B)', () => {
  it('keeps codes, code generation and ticket generation; earlier tickets keep working', async () => {
    let server = await start();
    const { leader, created } = await create(server, ['A', 'C', 'D']);
    const ticket = await issue(leader);
    server = await restart();

    const { reply } = await resumeWith(server, created.token, {
      metadata: { m: 1 },
      joinCodes: created.codes.blob,
    });
    const back = resumed(reply);
    expect(back).toMatchObject({
      recreated: true,
      codesChanged: false,
      joinMethods: ['A', 'C', 'D'],
    });
    expect({ ...back.codes, blob: '' }).toEqual({ ...created.codes, blob: '' });
    expect(blobs.verify(back.codes.blob, 'app-a', created.groupId)?.codes.ticketGeneration).toBe(
      created.codes.generation,
    );
    expect((await joinQr(server, ticket)).type).toBe('group.joined');
    expect((await joinCode(server, codesOf(created.codes))).type).toBe('group.joined');
    expect((await joinCode(server, { joinCode: created.codes.alphaCode })).type).toBe(
      'group.joined',
    );
  });
});

describe('recreation issues a full new set otherwise (#10 AC33, R3, D12)', () => {
  async function setup(joinMethods: JoinMethod[] = ['A', 'D']) {
    const server = await start();
    const { leader, created } = await create(server, joinMethods);
    const ticket = await issue(leader);
    return { server, leader, created, ticket };
  }

  async function expectNewSet(
    server: TestServer,
    created: { codes: { generation: number; groupCode?: string } },
    ticket: string,
    reply: ServerMessage,
  ) {
    const back = resumed(reply);
    expect(back.codesChanged).toBe(true);
    expect(back.codes.generation).toBeGreaterThan(created.codes.generation);
    expect(back.codes.groupCode).not.toBe(created.codes.groupCode);
    const verified = blobs.verify(back.codes.blob, 'app-a', back.groupId);
    expect(verified?.codes.ticketGeneration).toBe(back.codes.generation);
    // Tickets issued before the restart cannot come back (R3).
    expect(await joinQr(server, ticket)).toMatchObject({ code: 'QR_INVALID' });
    return back;
  }

  it('without a blob', async () => {
    const { created, ticket } = await setup();
    const server = await restart();
    const { reply } = await resumeWith(server, created.token, { metadata: {} });
    await expectNewSet(server, created, ticket, reply);
  });

  it('with a tampered, foreign, invented or other-app blob', async () => {
    const { server: first, created, ticket } = await setup();
    const other = await create(first, ['A', 'D']);
    const otherApp = await create(first, ['A', 'D'], KEY_B);
    const [payload, signature] = created.codes.blob.split('.') as [string, string];
    const bad = [
      `${payload}x.${signature}`,
      other.created.codes.blob,
      otherApp.created.codes.blob,
      `eyJ2IjoxfQ.${'A'.repeat(43)}`,
      'x'.repeat(512),
    ];
    for (const joinCodes of bad) {
      // Short restarts, so the ticket from before is not simply expired.
      const server = await restart(APPS, 1000);
      const { reply } = await resumeWith(server, created.token, { metadata: {}, joinCodes });
      await expectNewSet(server, created, ticket, reply);
    }
  });

  it('when a code was taken by another group meanwhile (AC35)', async () => {
    random.queue(424_242);
    const { created, ticket } = await setup(['B', 'D']);
    expect(created.codes.groupCode).toBe('424242');
    const server = await restart();
    random.queue(424_242);
    const squatter = await create(server, ['B']);
    expect(squatter.created.codes.groupCode).toBe('424242');
    const { reply } = await resumeWith(server, created.token, {
      metadata: {},
      joinCodes: created.codes.blob,
    });
    const back = await expectNewSet(server, created, ticket, reply);
    expect(back.joinMethods).toEqual(['B', 'D']);
  });

  it('when the app no longer allows a method: the methods still allowed are kept', async () => {
    const { created, ticket } = await setup(['A', 'D']);
    const server = await restart([{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['C', 'D'] }]);
    const { reply } = await resumeWith(server, created.token, {
      metadata: {},
      joinCodes: created.codes.blob,
    });
    const back = resumed(reply);
    expect(back).toMatchObject({ codesChanged: true, joinMethods: ['D'] });
    expect(await joinQr(server, ticket)).toMatchObject({ code: 'QR_INVALID' });
  });

  it('stays above every earlier ticket generation after rapid rotations (R3)', async () => {
    const server = await start();
    const { leader, created } = await create(server, ['D']);
    const tickets = [await issue(leader)];
    let latest = created.codes.blob;
    for (let i = 0; i < 6; i++) {
      leader.send({ type: 'codes.rotate' });
      latest = (await leader.next('codes.updated')).codes.blob;
      tickets.push(await issue(leader).catch(() => ''));
    }
    const restarted = await restart(APPS, 1000);
    const { reply } = await resumeWith(restarted, created.token, { metadata: {} });
    const back = resumed(reply);
    const before = blobs.verify(latest, 'app-a', created.groupId)!.codes.generation;
    expect(back.codes.generation).toBeGreaterThan(before);
    for (const ticket of tickets.filter((t) => t !== '')) {
      expect(await joinQr(restarted, ticket)).toMatchObject({ code: 'QR_INVALID' });
    }
  });
});

describe('leader return (#10 AC34)', () => {
  it('returns the current codes, unchanged for the current blob', async () => {
    const server = await start();
    const { leader, created } = await create(server, ['C', 'D']);
    const member = await server.connectReady();
    member.send({ type: 'group.joinByCode', joinCode: created.codes.alphaCode });
    await member.next('group.joined');
    await leader.close();
    await member.next('leader.offline');
    const { reply } = await resumeWith(server, created.token, {
      joinCodes: created.codes.blob,
    });
    const back = resumed(reply);
    expect(back).toMatchObject({ recreated: false, codesChanged: false, joinMethods: ['C', 'D'] });
    expect(back.codes.alphaCode).toBe(created.codes.alphaCode);
    expect(back.codes.generation).toBe(created.codes.generation);
  });

  it('reports changed codes after a door rotation while away, and re-sends a pause', async () => {
    const server = await start();
    const { leader, created } = await create(server, ['A', 'D']);
    const member = await server.connectReady();
    member.send({ type: 'group.joinByCode', ...codesOf(created.codes) });
    await member.next('group.joined');
    await leader.close();
    await member.next('leader.offline');
    let door = created.codes.doorCode!;
    for (let rotation = 0; rotation < 3; rotation++) {
      for (let i = 0; i < 5; i++) {
        const client = await server.connectReady();
        const wrong = ['000000', '000001', '000002'].find(
          (c) => c !== door && c !== created.codes.groupCode,
        )!;
        client.send({
          type: 'group.joinByCode',
          joinCode: created.codes.groupCode,
          doorCode: wrong,
        });
        await client.next('error');
      }
      // The leader is away; find the new door code by trying the blob after return.
      const { client: peek, reply } = await resumeWith(server, created.token, {});
      door = resumed(reply).codes.doorCode!;
      await peek.close();
      await member.next('leader.online');
      await member.next('leader.offline');
    }
    const { client: back, reply } = await resumeWith(server, created.token, {
      joinCodes: created.codes.blob,
    });
    const resumedReply = resumed(reply);
    expect(resumedReply.codesChanged).toBe(true);
    expect(resumedReply.codes.groupCode).toBe(created.codes.groupCode);
    expect(resumedReply.codes.doorCode).not.toBe(created.codes.doorCode);
    expect(await back.next('join.paused')).toMatchObject({ groupId: created.groupId });
  });
});

describe('restart end to end in-process (#10 AC35)', () => {
  it('keeps the same codes: a new joiner gets in and the old member resumes', async () => {
    let server = await start();
    const { created } = await create(server, ['A', 'D']);
    const member = await server.connectReady();
    member.send({ type: 'group.joinByCode', ...codesOf(created.codes) });
    const joined = await member.next('group.joined');
    server = await restart();

    const { reply } = await resumeWith(server, created.token, {
      metadata: { m: 1 },
      joinCodes: created.codes.blob,
    });
    expect(resumed(reply)).toMatchObject({ codesChanged: false });
    expect(resumed(reply).codes.groupCode).toBe(created.codes.groupCode);
    expect(resumed(reply).codes.doorCode).toBe(created.codes.doorCode);
    expect((await joinCode(server, codesOf(created.codes))).type).toBe('group.joined');
    const old = await resumeWith(server, joined.token);
    expect(old.reply).toMatchObject({ type: 'group.joined', participantId: joined.participantId });
  });
});

describe('frame sizes (#10 4.9)', () => {
  it('fits a maximal group.resume with a blob in the transport limit', () => {
    const ceiling = 16_384;
    const frame = JSON.stringify({
      type: 'group.resume',
      reqId: 'r'.repeat(64),
      token: 't'.repeat(MAX_TOKEN_LENGTH),
      metadata: { m: 'x'.repeat(ceiling - 8) },
      position: 'p'.repeat(ceiling - 2),
      blockList: Array.from(
        { length: MAX_BLOCK_LIST_SIZE },
        () => '00000000-0000-4000-8000-000000000000',
      ),
      joinCodes: 'b'.repeat(MAX_CODES_BLOB_LENGTH),
    });
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(transportMaxPayload(ceiling));
  });
});
