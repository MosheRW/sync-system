import { afterEach, describe, expect, it } from 'vitest';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { type RealServer, startRealServer } from '../helpers/real-server.js';
import { type TcpProxy, startTcpProxy } from '../helpers/tcp-proxy.js';
import { waitUntil } from '../helpers/wait.js';

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
    const { groupId } = await leader.createGroup({ book: 'b' }, { page: 1 });
    await member.joinGroup(groupId);

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

  it('a member whose group ended while it was away gets groupEnded rejoin_failed', async () => {
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
    const { groupId } = await leader.createGroup({});
    await member.joinGroup(groupId);

    const ended = nextEvent(member, 'groupEnded');
    proxy.cutAll();
    leader.close();
    expect(await ended).toEqual({ groupId, reason: 'rejoin_failed', code: 'GROUP_NOT_FOUND' });
    expect(member.getState().status).toBe('connected');
  });

  it('a leader dropped abnormally sees groupEnded at once and reconnects with no group', async () => {
    server = await startRealServer();
    proxy = await startTcpProxy(server.port);
    const { client: leader } = newClient(proxy.url);
    await leader.connect();
    const { groupId } = await leader.createGroup({});
    const ended = nextEvent(leader, 'groupEnded');
    proxy.cutAll();
    expect(await ended).toEqual({ groupId, reason: 'leader_disconnected' });
    await waitUntil(() => leader.getState().status === 'connected', 5000, 'reconnected');
    expect(leader.getSnapshot().group).toMatchObject({ status: 'ended' });
  });
});
