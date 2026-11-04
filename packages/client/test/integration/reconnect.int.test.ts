import { afterEach, describe, expect, it } from 'vitest';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { type RealServer, startRealServer } from '../helpers/real-server.js';
import { type TcpProxy, startTcpProxy } from '../helpers/tcp-proxy.js';
import { waitUntil } from '../helpers/wait.js';
import { joinCreated } from '../helpers/join.js';

let server: RealServer | undefined;
let proxy: TcpProxy | undefined;

afterEach(async () => {
  closeClients();
  await proxy?.close();
  await server?.close();
  proxy = undefined;
  server = undefined;
});

describe('reconnect against the real server (AC26, AC27, AC29, AC30)', () => {
  it('reconnects after the server shuts down (1001) and restarts on the same port', async () => {
    server = await startRealServer();
    const { port } = server;
    const { client, sockets } = newClient(server.url);
    const first = await client.connect();
    await server.close();
    await waitUntil(() => client.getState().status === 'reconnecting', 3000, 'reconnecting');
    server = await startRealServer({ port });
    await waitUntil(() => client.getState().status === 'connected', 8000, 'reconnected');
    const state = client.getState();
    expect(state.status === 'connected' && state.participantId).not.toBe(first.participantId);
    expect(sockets()).toBeGreaterThanOrEqual(2);
  });

  it('a member dropped abnormally rejoins its group with the current position', async () => {
    server = await startRealServer();
    proxy = await startTcpProxy(server.port);
    const { client: leader } = newClient(server.url);
    const { client: member } = newClient(proxy.url);
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({ book: 'b' }, { page: 1 });
    const { groupId } = created;
    await joinCreated(member, created);

    const rejoined = nextEvent(member, 'rejoined');
    proxy.cutAll();
    await waitUntil(() => member.getSnapshot().group?.status === 'rejoining', 3000, 'rejoining');
    leader.updatePosition({ page: 4 });
    const event = await rejoined;
    expect(event).toMatchObject({
      groupId,
      role: 'member',
      hasPosition: true,
      position: { page: 4 },
    });
    expect(member.getSnapshot().group).toMatchObject({ status: 'active', position: { page: 4 } });

    // Still following after the rejoin.
    const updated = nextEvent(member, 'positionUpdated');
    leader.updatePosition({ page: 5 });
    expect((await updated).position).toEqual({ page: 5 });
  });

  it('a member whose group emptied while it was away learns it ended (#13 D15)', async () => {
    server = await startRealServer();
    proxy = await startTcpProxy(server.port);
    const { client: leader } = newClient(server.url);
    const { client: member } = newClient(proxy.url, {
      // Wait long enough for the leader to leave before the member retries.
      reconnect: { initialDelayMs: 1000, maxDelayMs: 1000, stableAfterMs: 1000 },
      random: () => 1,
    });
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({});
    const { groupId } = created;
    await joinCreated(member, created);

    const ended = nextEvent(member, 'groupEnded', undefined, 5000);
    proxy.cutAll();
    leader.close();
    // Nobody stayed connected, so the server ended the group; it is never
    // recreated in the same server process (#13 D15).
    expect(await ended).toEqual({ groupId, reason: 'rejoin_failed', code: 'GROUP_ENDED' });
    expect(member.getSnapshot().group).toMatchObject({
      status: 'ended',
      reason: 'rejoin_failed',
      code: 'GROUP_ENDED',
    });
    expect(member.getState().status).toBe('connected');
  });

  it('a leader dropped abnormally resumes its group with its token (#5 AC35)', async () => {
    server = await startRealServer();
    proxy = await startTcpProxy(server.port);
    const { client: leader } = newClient(proxy.url);
    const { client: member } = newClient(server.url);
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({ book: 'b' }, { page: 2 });
    const { groupId } = created;
    // A member stays connected, so the group is frozen, not ended (#13 D15).
    await joinCreated(member, created);
    const rejoined = nextEvent(leader, 'rejoined');
    proxy.cutAll();
    await waitUntil(() => leader.getSnapshot().group?.status === 'rejoining', 3000, 'rejoining');
    expect(await rejoined).toMatchObject({
      groupId,
      role: 'leader',
      status: 'active',
      recreated: false,
      position: { page: 2 },
    });
    expect(leader.getSnapshot().group).toMatchObject({ status: 'active', role: 'leader' });
  });
});
