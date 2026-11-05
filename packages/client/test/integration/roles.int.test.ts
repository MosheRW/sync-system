import { afterEach, describe, expect, it } from 'vitest';
import { isSyncClientError } from '../../src/errors.js';
import { memoryStorage } from '../../src/storage.js';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { joinCreated } from '../helpers/join.js';
import { KEY_A, type RealServer, startRealServer } from '../helpers/real-server.js';
import { waitUntil } from '../helpers/wait.js';

let server: RealServer | undefined;

afterEach(async () => {
  closeClients();
  await server?.close();
  server = undefined;
});

/** A 1 s grace keeps the real-clock handoff short. */
async function start(): Promise<RealServer> {
  server = await startRealServer({
    apps: [{ namespace: 'app-a', apiKey: KEY_A, disconnectGraceSeconds: 1 }],
  });
  return server;
}

describe('roles on a real server (#13 AC23, AC24, AC31, AC32)', () => {
  it('names, roster, vice and lock reach the right clients', async () => {
    const s = await start();
    const { client: leader } = newClient(s.url);
    const { client: member } = newClient(s.url);
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({ book: 'b' }, undefined, { displayName: 'Dana' });
    const roster = nextEvent(leader, 'rosterChanged', (e) => e.roster.length === 2);
    const joined = await member.joinByCode(created.codes.groupCode!, {
      doorCode: created.codes.doorCode!,
      displayName: 'Noa',
    });
    expect((await roster).roster.map((e) => e.displayName)).toEqual(['Dana', 'Noa']);
    const vice = nextEvent(member, 'viceChanged');
    await leader.setViceLeader(joined.participantId);
    expect(await vice).toMatchObject({ isVice: true });
    const lock = nextEvent(member, 'lockChanged');
    await leader.lockGroup();
    expect(await lock).toMatchObject({ locked: true });
    expect(leader.getLeaderState()).toMatchObject({ locked: true, viceId: joined.participantId });
    // Members never get the roster.
    expect(member.getRoster()).toEqual([]);
  });

  it(
    'hands off when the leader is gone, then the old leader takes back',
    { timeout: 15_000 },
    async () => {
      const s = await start();
      const leaderStorage = memoryStorage();
      const { client: leader } = newClient(s.url, {
        storage: leaderStorage,
        reconnect: { initialDelayMs: 5_000, maxDelayMs: 5_000, stableAfterMs: 1000 },
      });
      const { client: member } = newClient(s.url);
      await leader.connect();
      await member.connect();
      const created = await leader.createGroup({ book: 'b' });
      await joinCreated(member, created);
      const leading = nextEvent(member, 'nowLeading', undefined, 8_000);
      leader.close();
      expect(await leading).toMatchObject({ reason: 'handoff_disconnect' });
      expect(member.getSnapshot().group).toMatchObject({ role: 'leader' });

      // The old leader comes back as a member and takes back.
      const { client: back } = newClient(s.url, { storage: leaderStorage });
      await back.connect();
      const offered = nextEvent(back, 'takeBackOffered');
      const resumed = await back.resumeGroup(created.groupId);
      expect(resumed).toMatchObject({ role: 'member' });
      await offered;
      const lost = nextEvent(member, 'leadershipLost');
      await back.takeBackLeadership();
      expect(back.getSnapshot().group).toMatchObject({ role: 'leader' });
      expect(await lost).toMatchObject({ reason: 'take_back', takeBackAvailable: true });
      expect(member.getRoster()).toEqual([]);
    },
  );

  it('a removed member is closed for good and its token deleted (Gate 2 Q-A)', async () => {
    const s = await start();
    const { client: leader } = newClient(s.url);
    const memberStorage = memoryStorage();
    const { client: member, sockets } = newClient(s.url, { storage: memberStorage });
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({});
    const joined = await joinCreated(member, created);
    const removed = nextEvent(member, 'removed');
    await leader.removeMember(joined.participantId);
    expect(await removed).toEqual({ groupId: created.groupId });
    expect(member.getState()).toMatchObject({ status: 'closed', reason: 'removed' });
    const opened = sockets();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(sockets()).toBe(opened);
    await waitUntil(() => {
      const text = memberStorage.getItem(`sync-system:v1:app-a@127.0.0.1:${s.port}`) as
        string | null;
      return text === null || (JSON.parse(text) as { entries: unknown[] }).entries.length === 0;
    });
    // The removed person cannot join again with the old codes.
    await member.connect();
    const again = await joinCreated(member, created).catch((error: unknown) => error);
    expect(isSyncClientError(again, 'CODE_NOT_FOUND')).toBe(true);
  });
});
