import type { JoinMethod } from '@mosherw/sync-system-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { QrTicketService } from '../src/tokens/qr-tickets.js';
import { signCompact } from '../src/tokens/signed-blob.js';
import { QR_TICKET_INFO_PREFIX, TokenKeyring, deriveAppKey } from '../src/tokens/token-keys.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { expireHold } from './helpers/lifecycle.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, KEY_B, type TestServer, startTestServer } from './helpers/test-server.js';
import { testSecrets } from './helpers/token-secrets.js';

const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];
const SECRET = Buffer.from('q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=');
const PREVIOUS = Buffer.from('Xr4Tn8Qm2Vk6Bz0Pc9Ls3Hd7Jf1Gw5Ye8Ua2Ii6Oo4=');
const MINUTE = 60_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

async function start(previous?: Buffer) {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [
      { namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL, maxGroupSize: 100 },
      { namespace: 'app-b', apiKey: KEY_B, joinMethods: ALL },
    ],
    tokenSecrets:
      previous === undefined
        ? { current: SECRET, source: 'env' }
        : { current: SECRET, previous, source: 'env' },
  });
  return { server: ts, scheduler, store };
}

async function group(server: TestServer, joinMethods: JoinMethod[], apiKey = KEY_A) {
  const leader = await server.connectReady(apiKey);
  leader.send({ type: 'group.create', metadata: { m: 1 }, joinMethods });
  const created = await leader.next('group.created');
  return { leader, created };
}

async function issue(leader: TestClient): Promise<string> {
  leader.send({ type: 'qr.issue' });
  let message = await leader.next();
  while (message.type === 'token.refreshed') message = await leader.next();
  if (message.type !== 'qr.ticket') throw new Error(`expected qr.ticket: ${message.type}`);
  return message.ticket;
}

async function joinQr(server: TestServer, ticket: unknown, apiKey = KEY_A) {
  const client = await server.connectReady(apiKey);
  client.send({ type: 'group.joinByQr', reqId: 'q', ticket });
  return { client, reply: await client.next() };
}

describe('qr.issue (#10 AC23)', () => {
  it('returns a short URL-safe ticket and its lifetime', async () => {
    const { server } = await start();
    const { leader } = await group(server, ['A', 'D']);
    leader.send({ type: 'qr.issue', reqId: 'i' });
    const reply = await leader.next('qr.ticket');
    expect(reply).toEqual({
      type: 'qr.ticket',
      reqId: 'i',
      ticket: expect.stringMatching(/^[A-Za-z0-9_.-]+$/) as string,
      expiresInMs: 300_000,
    });
    expect(reply.ticket.length).toBeLessThanOrEqual(256);
  });

  it('refuses members, groupless sessions and groups without D', async () => {
    const { server } = await start();
    const { leader } = await group(server, ['C', 'D']);
    const { client: member } = await joinQr(server, await issue(leader));
    member.send({ type: 'qr.issue', reqId: 'm' });
    expect(await member.next('error')).toEqual({
      type: 'error',
      reqId: 'm',
      code: 'NOT_LEADER',
      message: 'Only the leader can issue QR codes',
    });
    const outsider = await server.connectReady();
    outsider.send({ type: 'qr.issue' });
    expect(await outsider.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
    const { leader: noD } = await group(server, ['C']);
    noD.send({ type: 'qr.issue' });
    expect(await noD.next('error')).toEqual({
      type: 'error',
      code: 'JOIN_METHOD_NOT_ALLOWED',
      message: 'Join method not allowed',
    });
  });

  it('allows 6 tickets per connection per minute', async () => {
    const { server, scheduler } = await start();
    const { leader } = await group(server, ['D']);
    for (let i = 0; i < 6; i++) await issue(leader);
    leader.send({ type: 'qr.issue', reqId: 'x' });
    expect(await leader.next('error')).toEqual({
      type: 'error',
      reqId: 'x',
      code: 'RATE_LIMITED',
      message: 'Too many QR code requests',
      details: { retryAfterMs: MINUTE },
    });
    scheduler.advance(MINUTE);
    expect(typeof (await issue(leader))).toBe('string');
  });
});

describe('group.joinByQr (#10 AC24)', () => {
  it('admits any number of joiners with one ticket until it expires', async () => {
    const { server } = await start();
    const { leader, created } = await group(server, ['D']);
    const ticket = await issue(leader);
    for (let i = 0; i < 3; i++) {
      const { reply } = await joinQr(server, ticket);
      expect(reply).toMatchObject({
        type: 'group.joined',
        reqId: 'q',
        groupId: created.groupId,
        role: 'member',
        metadata: { m: 1 },
      });
    }
  });

  it('sends a QR joiner of a B group through approval (Q3.2)', async () => {
    const { server } = await start();
    const { leader } = await group(server, ['B', 'D']);
    const ticket = await issue(leader);
    const client = await server.connectReady();
    client.send({ type: 'group.joinByQr', ticket, displayName: 'Dana' });
    const pending = await client.next('join.pending');
    const requested = await leader.next('join.requested');
    expect(requested).toMatchObject({ requestId: pending.requestId, displayName: 'Dana' });
    leader.send({ type: 'join.approve', requestId: pending.requestId });
    expect((await leader.next('join.decided')).outcome).toBe('admitted');
    expect((await client.next('group.joined')).role).toBe('member');
  });

  it('admits while the leader is offline (AC17)', async () => {
    const { server } = await start();
    const { leader } = await group(server, ['D']);
    const ticket = await issue(leader);
    const { client: member } = await joinQr(server, ticket);
    await leader.close();
    await member.next('leader.offline');
    expect((await joinQr(server, ticket)).reply).toMatchObject({
      type: 'group.joined',
      leaderOnline: false,
    });
  });
});

describe('invalid tickets (#10 AC25, R7)', () => {
  it('answers QR_EXPIRED only for a signed, well-formed, expired ticket', async () => {
    const { server, scheduler } = await start();
    const { leader } = await group(server, ['D']);
    const ticket = await issue(leader);
    scheduler.advance(300_000);
    expect((await joinQr(server, ticket)).reply).toEqual({
      type: 'error',
      reqId: 'q',
      code: 'QR_EXPIRED',
      message: 'QR code expired',
    });
  });

  it('gives byte-identical QR_INVALID for every other cause, never echoing the ticket', async () => {
    const { server, scheduler, store } = await start();
    const { leader } = await group(server, ['A', 'D']);
    const ticket = await issue(leader);
    const [payload, signature] = ticket.split('.') as [string, string];
    const { leader: otherApp } = await group(server, ['D'], KEY_B);
    const otherTicket = await issue(otherApp);
    const { leader: dropped, created: droppedGroup } = await group(server, ['D']);
    const droppedTicket = await issue(dropped);
    await dropped.close();
    // Held for the grace period, then gone (#13 Q-G).
    await expireHold(scheduler, store, droppedGroup.groupId);
    const { leader: rotated } = await group(server, ['D']);
    const revoked = await issue(rotated);
    rotated.send({ type: 'codes.rotate' });
    await rotated.next('codes.updated');
    const token = (await group(server, ['C'])).created.token;

    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    const replies: string[] = [];
    for (const bad of [
      `${payload}.${flipped}`,
      `${payload}x.${signature}`,
      'not-a-ticket',
      '',
      `${'a'.repeat(213)}.${signature}`,
      ticket.replace('.', '..'),
      otherTicket,
      droppedTicket,
      revoked,
      token,
    ]) {
      const { reply } = await joinQr(server, bad);
      const text = JSON.stringify(reply);
      if (bad.length > 0) expect(text).not.toContain(bad);
      replies.push(text);
    }
    expect(new Set(replies).size).toBe(1);
    expect(JSON.parse(replies[0]!)).toEqual({
      type: 'error',
      reqId: 'q',
      code: 'QR_INVALID',
      message: 'Invalid QR code',
    });
    // The other app's ticket still works in its own app.
    expect((await joinQr(server, otherTicket, KEY_B)).reply.type).toBe('group.joined');
  });

  it('answers QR_INVALID for a correctly signed ticket of a group without D', async () => {
    const { server, scheduler } = await start();
    const { created } = await group(server, ['C']);
    // A correctly signed ticket for a group without D.
    const forged = new QrTicketService(
      new TokenKeyring(testSecrets({ current: SECRET }), QR_TICKET_INFO_PREFIX),
      3600,
    ).issue('app-a', created.groupId, created.codes.generation, scheduler.now(), 300).ticket;
    expect((await joinQr(server, forged)).reply).toMatchObject({ code: 'QR_INVALID' });
  });

  it('rejects an over-long ticket input by schema only past 512 characters', async () => {
    const { server } = await start();
    expect((await joinQr(server, 'a'.repeat(512))).reply).toMatchObject({ code: 'QR_INVALID' });
    expect((await joinQr(server, 'a'.repeat(513))).reply).toMatchObject({
      code: 'INVALID_MESSAGE',
    });
  });
});

describe('ticket generation (#10 Q-B, D12)', () => {
  it('keeps tickets valid across door rotations and a pause; codes.rotate revokes them', async () => {
    const { server } = await start();
    const { leader, created } = await group(server, ['A', 'D']);
    const ticket = await issue(leader);
    let door = created.codes.doorCode!;
    const wrong = (d: string) => (d === '000000' ? '000001' : '000000');
    for (let rotation = 0; rotation < 3; rotation++) {
      for (let i = 0; i < 5; i++) {
        const client = await server.connectReady();
        client.send({
          type: 'group.joinByCode',
          joinCode: created.codes.groupCode,
          doorCode: wrong(door) === created.codes.groupCode ? '000002' : wrong(door),
        });
        await client.next('error');
      }
      door = (await leader.next('codes.updated')).codes.doorCode!;
      expect((await joinQr(server, ticket)).reply.type).toBe('group.joined');
    }
    await leader.next('join.paused');
    // Method A is paused, D still admits with the same ticket.
    expect((await joinQr(server, ticket)).reply.type).toBe('group.joined');

    leader.send({ type: 'codes.rotate' });
    await leader.next('codes.updated');
    await leader.next('join.resumed');
    expect((await joinQr(server, ticket)).reply).toMatchObject({ code: 'QR_INVALID' });
    expect((await joinQr(server, await issue(leader))).reply.type).toBe('group.joined');
  });
});

describe('keys (#10 AC26)', () => {
  it('accepts tickets signed under the previous secret until they expire', async () => {
    const { server, scheduler } = await start(PREVIOUS);
    const { created } = await group(server, ['D']);
    const old = new QrTicketService(
      new TokenKeyring(testSecrets({ current: PREVIOUS }), QR_TICKET_INFO_PREFIX),
      3600,
    ).issue('app-a', created.groupId, created.codes.generation, scheduler.now(), 300).ticket;
    expect((await joinQr(server, old)).reply.type).toBe('group.joined');
    scheduler.advance(300_000);
    expect((await joinQr(server, old)).reply).toMatchObject({ code: 'QR_EXPIRED' });
  });

  it('never accepts a ticket as a token or a token key as a ticket key', async () => {
    const { server, scheduler } = await start();
    const { leader, created } = await group(server, ['D']);
    const ticket = await issue(leader);
    const client = await server.connectReady();
    client.send({ type: 'group.resume', token: ticket });
    expect(await client.next('error')).toMatchObject({ code: 'TOKEN_INVALID' });
    const underTokenKey = signCompact(
      JSON.stringify({
        v: 1,
        g: created.groupId,
        n: created.codes.generation,
        e: Math.ceil(scheduler.now() / 1000) + 60,
      }),
      deriveAppKey(SECRET, 'app-a'),
    );
    expect((await joinQr(server, underTokenKey)).reply).toMatchObject({ code: 'QR_INVALID' });
    expect((await joinQr(server, '123456')).reply).toMatchObject({ code: 'QR_INVALID' });
  });
});
