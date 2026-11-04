import { afterEach, describe, expect, it } from 'vitest';
import { indicatorOf } from '../../src/state.js';
import { memoryStorage } from '../../src/storage.js';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { type RealServer, startRealServer } from '../helpers/real-server.js';
import { type TcpProxy, startTcpProxy } from '../helpers/tcp-proxy.js';
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

describe('leader offline and back, client side (#5 AC18, AC19, AC36)', () => {
  it('a member sees leader offline, then following again when the leader resumes', async () => {
    server = await startRealServer();
    proxy = await startTcpProxy(server.port);
    const { client: leader } = newClient(proxy.url, { storage: memoryStorage() });
    const { client: member } = newClient(server.url, { storage: memoryStorage() });
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({ book: 'b' }, { page: 1 });
    const { groupId } = created;
    await joinCreated(member, created);
    expect(indicatorOf(member.getSnapshot())).toBe('following');

    const offline = nextEvent(member, 'leaderStatus', (e) => !e.online);
    const online = nextEvent(member, 'leaderStatus', (e) => e.online, 10_000);
    const leaderBack = nextEvent(leader, 'rejoined', undefined, 10_000);
    proxy.cutAll();
    expect(await offline).toEqual({ groupId, online: false });
    expect(member.getSnapshot().group).toMatchObject({ status: 'active', leaderOnline: false });
    expect(indicatorOf(member.getSnapshot())).toBe('leader_offline');

    expect(await leaderBack).toMatchObject({
      role: 'leader',
      recreated: false,
      position: { page: 1 },
    });
    expect(await online).toEqual({ groupId, online: true });
    expect(indicatorOf(member.getSnapshot())).toBe('following');
    expect(indicatorOf(leader.getSnapshot())).toBe('leading');

    const update = nextEvent(member, 'positionUpdated');
    leader.updatePosition({ page: 2 });
    expect((await update).position).toEqual({ page: 2 });
  });
});
