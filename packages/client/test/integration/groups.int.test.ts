import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isSyncClientError } from '../../src/errors.js';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { KEY_A, type RealServer, startRealServer } from '../helpers/real-server.js';

let server: RealServer;

beforeAll(async () => {
  server = await startRealServer({
    apps: [{ namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 2 }],
  });
});

afterEach(() => {
  closeClients();
});

afterAll(async () => {
  await server.close();
});

async function connected() {
  const { client } = newClient(server.url);
  await client.connect();
  return client;
}

describe('groups against the real server (AC15-AC19, AC30)', () => {
  it('create, join with a position, update, and receive positionUpdated', async () => {
    const leader = await connected();
    const member = await connected();
    const created = await leader.createGroup({ book: 'b1' }, { page: 1 });
    expect(created.role).toBe('leader');
    expect(created.groupId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const joined = await member.joinGroup(created.groupId);
    expect(joined).toMatchObject({
      role: 'member',
      metadata: { book: 'b1' },
      hasPosition: true,
      position: { page: 1 },
    });

    const received = nextEvent(member, 'positionUpdated');
    leader.updatePosition({ page: 2, offset: 0.5 });
    expect(await received).toEqual({
      groupId: created.groupId,
      position: { page: 2, offset: 0.5 },
    });
  });

  it('join without a position reports hasPosition false', async () => {
    const leader = await connected();
    const member = await connected();
    const { groupId } = await leader.createGroup({});
    const joined = await member.joinGroup(groupId);
    expect(joined.hasPosition).toBe(false);
  });

  it('rejects GROUP_NOT_FOUND and GROUP_FULL', async () => {
    const leader = await connected();
    const member = await connected();
    const third = await connected();
    let error: unknown = await member.joinGroup('x'.repeat(43)).catch((err: unknown) => err);
    expect(isSyncClientError(error, 'GROUP_NOT_FOUND')).toBe(true);

    const { groupId } = await leader.createGroup({});
    await member.joinGroup(groupId);
    error = await third.joinGroup(groupId).catch((err: unknown) => err);
    expect(isSyncClientError(error, 'GROUP_FULL')).toBe(true);
    if (isSyncClientError(error, 'GROUP_FULL')) expect(error.details).toEqual({ maxGroupSize: 2 });
  });

  it('a member and a groupless client cannot update the position (AC18)', async () => {
    const leader = await connected();
    const member = await connected();
    expect(() => member.updatePosition(1)).toThrow(
      expect.objectContaining({ code: 'NOT_IN_GROUP' }),
    );
    const { groupId } = await leader.createGroup({});
    await member.joinGroup(groupId);
    expect(() => member.updatePosition(1)).toThrow(expect.objectContaining({ code: 'NOT_LEADER' }));
  });

  // #5 AC18: a leader disconnect freezes the group instead of ending it.
  it('the member stays in the group when the leader disconnects', async () => {
    const leader = await connected();
    const member = await connected();
    const { groupId } = await leader.createGroup({});
    await member.joinGroup(groupId);
    const ended = vi.fn();
    member.on('groupEnded', ended);
    leader.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ended).not.toHaveBeenCalled();
    expect(member.getSnapshot().group).toMatchObject({ status: 'active', groupId });
    expect(member.getState().status).toBe('connected');
  });
});
