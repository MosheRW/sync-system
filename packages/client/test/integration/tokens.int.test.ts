import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncClientError } from '../../src/errors.js';
import type { LogFields } from '../../src/logger.js';
import { type TokenStorage, memoryStorage } from '../../src/storage.js';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { type RealServer, startRealServer } from '../helpers/real-server.js';
import { waitUntil } from '../helpers/wait.js';
import { joinCreated } from '../helpers/join.js';

let server: RealServer | undefined;

afterEach(async () => {
  closeClients();
  await server?.close();
  server = undefined;
});

function unexpected(): never {
  throw new Error('expected a rejection');
}

function keyOf(s: RealServer): string {
  return `sync-system:v1:app-a@127.0.0.1:${s.port}`;
}

function storedCount(storage: TokenStorage, s: RealServer): number {
  const text = storage.getItem(keyOf(s)) as string | null;
  return text === null ? 0 : (JSON.parse(text) as { entries: unknown[] }).entries.length;
}

describe('stored tokens against the real server (#5 AC31, AC37, AC38)', () => {
  it('checkTokens reports live groups and deletes ended ones', async () => {
    server = await startRealServer();
    const storage = memoryStorage();
    const { client: leader } = newClient(server.url, { storage });
    await leader.connect();
    const first = await leader.createGroup({});
    await expect(leader.checkTokens()).resolves.toEqual([
      { groupId: first.groupId, role: 'leader', status: 'live' },
    ]);
    await leader.endGroup();
    expect(leader.getSnapshot().group).toMatchObject({
      status: 'ended',
      reason: 'ended_by_leader',
    });
    await waitUntil(() => storedCount(storage, server!) === 0);
    await expect(leader.checkTokens()).resolves.toEqual([]);
  });

  it('"resume later": a new client with the same storage recreates the group', async () => {
    server = await startRealServer();
    const storage = memoryStorage();
    const { client: first } = newClient(server.url, { storage });
    await first.connect();
    const { groupId } = await first.createGroup({ book: 'b' }, { page: 4 });
    const blocked = randomUUID();
    await first.addToBlockList(groupId, [blocked]);
    first.close();
    await waitUntil(() => storedCount(storage, server!) === 1);

    const { client: later } = newClient(server.url, { storage });
    await later.connect();
    await expect(later.checkTokens()).resolves.toEqual([
      { groupId, role: 'leader', status: 'recoverable' },
    ]);
    const resumed = await later.resumeGroup(groupId);
    expect(resumed).toMatchObject({
      groupId,
      role: 'leader',
      status: 'active',
      recreated: true,
      metadata: { book: 'b' },
      position: { page: 4 },
    });
    await expect(later.getBlockList(groupId)).resolves.toEqual([blocked]);
  });

  it('a member waits for its leader, then is admitted; leaveGroup deletes its token', async () => {
    server = await startRealServer();
    const leaderStorage = memoryStorage();
    const memberStorage = memoryStorage();
    const { client: leader } = newClient(server.url, { storage: leaderStorage });
    const { client: member } = newClient(server.url, { storage: memberStorage });
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({}, { page: 1 });
    const { groupId } = created;
    await joinCreated(member, created);
    leader.close();
    member.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { client: member2 } = newClient(server.url, { storage: memberStorage });
    await member2.connect();
    await expect(member2.resumeGroup(groupId)).resolves.toMatchObject({ status: 'waiting' });
    const admitted = nextEvent(member2, 'rejoined');
    const { client: leader2 } = newClient(server.url, { storage: leaderStorage });
    await leader2.connect();
    await leader2.resumeGroup(groupId);
    expect(await admitted).toMatchObject({ groupId, role: 'member', status: 'active' });

    await member2.leaveGroup();
    expect(member2.getSnapshot().group).toMatchObject({ status: 'ended', reason: 'left' });
    await waitUntil(() => storedCount(memberStorage, server!) === 0);
    await expect(member2.resumeGroup(groupId)).rejects.toMatchObject({ code: 'TOKEN_NOT_FOUND' });
  });

  it('a blocked member is removed and its token deleted', async () => {
    server = await startRealServer();
    const memberStorage = memoryStorage();
    const { client: leader } = newClient(server.url, { storage: memoryStorage() });
    const { client: member } = newClient(server.url, { storage: memberStorage });
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({});
    const { groupId } = created;
    const joined = await joinCreated(member, created);
    const ended = nextEvent(member, 'groupEnded');
    await leader.addToBlockList(groupId, [joined.participantId]);
    expect(await ended).toEqual({ groupId, reason: 'removed' });
    await waitUntil(() => storedCount(memberStorage, server!) === 0);
  });
});

describe('the client never logs or reports tokens, IDs or payloads (#5 AC39)', () => {
  it('keeps them out of logs, errors and error details across the token flows', async () => {
    server = await startRealServer();
    const lines: string[] = [];
    const record = (event: string, fields?: LogFields) => {
      lines.push(`${event} ${JSON.stringify(fields ?? {})}`);
    };
    const logger = { debug: record, info: record, warn: record, error: record };
    const storage = memoryStorage();
    const errors: SyncClientError[] = [];
    const { client: leader } = newClient(server.url, { storage, logger });
    const { client: member } = newClient(server.url, { storage: memoryStorage(), logger });
    leader.on('error', (e) => errors.push(e));
    member.on('error', (e) => errors.push(e));
    await leader.connect();
    await member.connect();
    const metadata = { title: 'SENTINEL-CLIENT-METADATA' };
    const created = await leader.createGroup(metadata, 'SENTINEL-CLIENT-POSITION');
    const joined = await joinCreated(member, created);
    await leader.addToBlockList(created.groupId, [randomUUID()]);
    await leader.checkTokens();
    errors.push(
      ...(await Promise.all([
        member.endGroup().then(unexpected, (e: SyncClientError) => e),
        leader.leaveGroup().then(unexpected, (e: SyncClientError) => e),
        leader.resumeGroup(created.groupId).then(unexpected, (e: SyncClientError) => e),
        member.resumeGroup('x'.repeat(43)).then(unexpected, (e: SyncClientError) => e),
      ])),
    );
    const tokens = (
      JSON.parse(storage.getItem(keyOf(server)) as string) as {
        entries: Array<{ token: string }>;
      }
    ).entries.map((e) => e.token);
    const text = [
      ...lines,
      ...errors.map(
        (e) => `${e.message} ${JSON.stringify(e.details ?? {})} ${e.serverMessage ?? ''}`,
      ),
    ].join('\n');
    expect(errors.length).toBeGreaterThan(3);
    for (const secret of [
      ...tokens,
      ...tokens.map((t) => t.split('.')[1]!),
      created.groupId,
      created.participantId,
      joined.participantId,
      'SENTINEL-CLIENT-METADATA',
      'SENTINEL-CLIENT-POSITION',
    ]) {
      expect(text.includes(secret)).toBe(false);
    }
  });
});
