import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSyncClientError } from '../../src/errors.js';
import type { LogFields, SyncClientLogger } from '../../src/logger.js';
import { memoryStorage } from '../../src/storage.js';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { joinCreated } from '../helpers/join.js';
import { KEY_A, type RealServer, startRealServer } from '../helpers/real-server.js';

const NAME = 'Sentinelname Dana';

let server: RealServer | undefined;

afterEach(async () => {
  closeClients();
  await server?.close();
  server = undefined;
});

function recordingLogger(): { logger: SyncClientLogger; text: () => string } {
  const entries: Array<[string, string, LogFields | undefined]> = [];
  const record =
    (level: string) =>
    (event: string, fields?: LogFields): void => {
      entries.push([level, event, fields]);
    };
  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    text: () => JSON.stringify(entries),
  };
}

async function start(options: Parameters<typeof startRealServer>[0] = {}) {
  server = await startRealServer({
    apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'B', 'C', 'D'] }],
    ...options,
  });
  return server;
}

describe('join flows against the real server (#10 AC39, AC42)', () => {
  it('joins by group code and door code, asking for the door code first', async () => {
    const real = await start();
    const { client: leader } = newClient(real.url);
    const { client: member } = newClient(real.url);
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({ book: 'b' }, undefined, { joinMethods: ['A', 'D'] });
    expect(created.joinMethods).toEqual(['A', 'D']);
    expect(leader.getJoinCodes()).toEqual(created.codes);
    const code = created.codes.groupCode!;
    const typed = `${code.slice(0, 3)}-${code.slice(3)}`;
    const first = await member.joinByCode(typed).catch((error: unknown) => error);
    expect(isSyncClientError(first, 'DOOR_CODE_REQUIRED')).toBe(true);
    const joined = await member.joinByCode(typed, { doorCode: created.codes.doorCode });
    expect(joined).toMatchObject({ groupId: created.groupId, role: 'member' });
  });

  it('joins by alphanumeric code and by QR ticket', async () => {
    const real = await start();
    const { client: leader } = newClient(real.url);
    const { client: byCode } = newClient(real.url);
    const { client: byQr } = newClient(real.url);
    await Promise.all([leader.connect(), byCode.connect(), byQr.connect()]);
    const created = await leader.createGroup({}, undefined, { joinMethods: ['C', 'D'] });
    await byCode.joinByCode(created.codes.alphaCode!.toLowerCase());
    const { ticket } = await leader.issueQrTicket();
    expect((await byQr.joinByQr(ticket)).groupId).toBe(created.groupId);
  });

  it('waits for approval, then the leader admits the joiner', async () => {
    const real = await start();
    const { client: leader } = newClient(real.url);
    const { client: joiner } = newClient(real.url);
    await leader.connect();
    await joiner.connect();
    const created = await leader.createGroup({}, undefined, { joinMethods: ['B'] });
    const requested = nextEvent(leader, 'joinRequested');
    const joining = joiner.joinByCode(created.codes.groupCode!, { displayName: NAME });
    const request = await requested;
    expect(request.displayName).toBe(NAME);
    // The two sockets are independent: join.pending may arrive after join.requested.
    await vi.waitFor(() => expect(joiner.getSnapshot().group?.status).toBe('awaiting_approval'));
    expect(leader.getJoinRequests()).toHaveLength(1);
    await expect(leader.approveJoin(request.requestId)).resolves.toBe('admitted');
    expect((await joining).groupId).toBe(created.groupId);
  });

  it('a denied joiner gets JOIN_DENIED; a cancelled one JOIN_CANCELLED', async () => {
    const real = await start();
    const { client: leader } = newClient(real.url);
    const { client: joiner } = newClient(real.url);
    await leader.connect();
    await joiner.connect();
    const created = await leader.createGroup({}, undefined, { joinMethods: ['B'] });
    let requested = nextEvent(leader, 'joinRequested');
    let joining = joiner.joinByCode(created.codes.groupCode!).catch((error: unknown) => error);
    await leader.denyJoin((await requested).requestId);
    expect(isSyncClientError(await joining, 'JOIN_DENIED')).toBe(true);

    requested = nextEvent(leader, 'joinRequested');
    const withdrawn = nextEvent(leader, 'joinWithdrawn');
    joining = joiner.joinByCode(created.codes.groupCode!).catch((error: unknown) => error);
    await requested;
    await vi.waitFor(() => expect(joiner.getSnapshot().group?.status).toBe('awaiting_approval'));
    await joiner.cancelJoin();
    expect(isSyncClientError(await joining, 'JOIN_CANCELLED')).toBe(true);
    expect((await withdrawn).reason).toBe('cancelled');
    expect(joiner.getSnapshot().group).toBeNull();
  });

  it('rotates codes: the old ones stop working', async () => {
    const real = await start();
    const { client: leader } = newClient(real.url);
    const { client: member } = newClient(real.url);
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({}, undefined, { joinMethods: ['C', 'D'] });
    const { ticket } = await leader.issueQrTicket();
    const changed = nextEvent(leader, 'codesChanged');
    const codes = await leader.rotateCodes();
    expect((await changed).reason).toBe('rotated');
    expect(codes.alphaCode).not.toBe(created.codes.alphaCode);
    const old = await member.joinByCode(created.codes.alphaCode!).catch((e: unknown) => e);
    expect(isSyncClientError(old, 'CODE_NOT_FOUND')).toBe(true);
    const qr = await member.joinByQr(ticket).catch((e: unknown) => e);
    expect(isSyncClientError(qr, 'QR_INVALID')).toBe(true);
    await member.joinByCode(codes.alphaCode!);
  });

  it('never logs codes, tickets, the blob or names (AC42)', async () => {
    const real = await start();
    const leaderLog = recordingLogger();
    const joinerLog = recordingLogger();
    const { client: leader } = newClient(real.url, { logger: leaderLog.logger });
    const { client: joiner } = newClient(real.url, { logger: joinerLog.logger });
    await leader.connect();
    await joiner.connect();
    const created = await leader.createGroup({}, undefined, { joinMethods: ['B', 'D'] });
    const { ticket } = await leader.issueQrTicket();
    const requested = nextEvent(leader, 'joinRequested');
    const joining = joiner.joinByQr(ticket, { displayName: NAME });
    await leader.approveJoin((await requested).requestId);
    await joining;
    const rotated = await leader.rotateCodes();
    const text = leaderLog.text() + joinerLog.text();
    for (const secret of [
      created.codes.groupCode!,
      rotated.groupCode!,
      ticket,
      NAME,
      (await requested).requestId,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('eyJ');
  });
});

describe('codes across a server restart, client side (#10 AC35)', () => {
  it('the leader gets the same codes back and a new joiner gets in with them', async () => {
    const tokenSecrets = { current: randomBytes(32), source: 'env' as const };
    const real = await start({ tokenSecrets });
    const { port } = real;
    const { client: leader } = newClient(real.url, { storage: memoryStorage() });
    const { client: member } = newClient(real.url, { storage: memoryStorage() });
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({ book: 'b' }, undefined, {
      joinMethods: ['A', 'D'],
    });
    await joinCreated(member, created);

    const leaderBack = nextEvent(leader, 'rejoined', undefined, 10_000);
    const changed = { count: 0 };
    leader.on('codesChanged', () => {
      changed.count += 1;
    });
    await real.close();
    server = await start({ port, tokenSecrets });
    expect(await leaderBack).toMatchObject({ groupId: created.groupId, recreated: true });
    expect(leader.getJoinCodes()).toEqual(created.codes);
    expect(changed.count).toBe(0);

    const { client: newcomer } = newClient(server.url);
    await newcomer.connect();
    expect((await joinCreated(newcomer, created)).groupId).toBe(created.groupId);
  });
});
