import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSyncClientError } from '../src/errors.js';
import type { CodesChangedEvent, JoinRequestedEvent } from '../src/state.js';
import { CREATED_FIELDS, TEST_CODES, connectedClient, joinTestGroup } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

const GROUP_ID = 'G'.repeat(43);
const REQUEST_ID = 'R'.repeat(22);
const BLOB = `eyJ2IjoxfQ.${'B'.repeat(43)}`;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function leader(joinMethods: string[] = ['A', 'D']) {
  const { client, socket } = await connectedClient();
  const changed: CodesChangedEvent[] = [];
  client.on('codesChanged', (e) => changed.push(e));
  const creating = client.createGroup({ m: 1 });
  socket.receive({
    type: 'group.created',
    ...CREATED_FIELDS,
    joinMethods,
    reqId: socket.lastMessage().reqId,
    groupId: GROUP_ID,
    participantId: 'p',
    role: 'leader',
    token: 'h.p.s',
  });
  const created = await creating;
  return { client, socket, created, changed };
}

describe('createGroup with join methods (#10 AC38)', () => {
  it('sends the methods and resolves with the codes', async () => {
    const { client, socket } = await connectedClient();
    void client.createGroup({}, undefined, { joinMethods: ['D', 'A'] }).catch(() => {});
    expect(socket.lastMessage()).toMatchObject({ type: 'group.create', joinMethods: ['D', 'A'] });
    client.close();
  });

  it('rejects methods the app does not allow, duplicates and A with B, sending nothing', async () => {
    const { client, socket } = await connectedClient();
    const sent = socket.sent.length;
    for (const joinMethods of [[], ['A', 'A'], ['A', 'B'], ['E'], 'A']) {
      const error = await rejection(
        client.createGroup({}, undefined, { joinMethods: joinMethods as never }),
      );
      expect(isSyncClientError(error, 'JOIN_METHOD_UNAVAILABLE')).toBe(true);
    }
    expect(socket.sent).toHaveLength(sent);
    client.close();
  });

  it('exposes the codes to the leader and fires codesChanged created', async () => {
    const { client, created, changed } = await leader();
    const codes = { generation: TEST_CODES.generation, groupCode: '123456', doorCode: '654321' };
    expect(created.codes).toEqual(codes);
    expect(client.getJoinCodes()).toEqual(codes);
    expect(changed).toEqual([{ groupId: GROUP_ID, codes, reason: 'created' }]);
    expect(JSON.stringify(client.getSnapshot())).not.toContain('123456');
    client.close();
  });
});

describe('leader API (#10 AC40)', () => {
  it('rotates codes and updates them', async () => {
    const { client, socket, changed } = await leader();
    const rotating = client.rotateCodes();
    const sent = socket.lastMessage();
    expect(sent).toEqual({ type: 'codes.rotate', reqId: sent.reqId });
    socket.receive({
      type: 'codes.updated',
      reqId: sent.reqId,
      groupId: GROUP_ID,
      reason: 'rotated',
      codes: { generation: 9, groupCode: '111111', doorCode: '222222', blob: BLOB },
    });
    expect(await rotating).toEqual({ generation: 9, groupCode: '111111', doorCode: '222222' });
    expect(client.getJoinCodes()?.groupCode).toBe('111111');
    expect(changed.at(-1)?.reason).toBe('rotated');
    client.close();
  });

  it('takes unsolicited door rotations', async () => {
    const { client, socket, changed } = await leader();
    socket.receive({
      type: 'codes.updated',
      groupId: GROUP_ID,
      reason: 'door_failures',
      codes: { generation: 5, groupCode: '123456', doorCode: '333333', blob: BLOB },
    });
    expect(client.getJoinCodes()?.doorCode).toBe('333333');
    expect(changed.at(-1)?.reason).toBe('door_failures');
    client.close();
  });

  it('issues QR tickets with a local expiry', async () => {
    const { client, socket } = await leader();
    const issuing = client.issueQrTicket();
    const sent = socket.lastMessage();
    expect(sent.type).toBe('qr.issue');
    const ticket = `eyJ2IjoxfQ.${'T'.repeat(43)}`;
    socket.receive({ type: 'qr.ticket', reqId: sent.reqId, ticket, expiresInMs: 300_000 });
    const result = await issuing;
    expect(result.ticket).toBe(ticket);
    expect(result.expiresAt).toBe(Date.now() + 300_000);
    client.close();
  });

  it('refuses issueQrTicket without method D, and leader calls from a member', async () => {
    const noD = await leader(['C']);
    expect(
      isSyncClientError(await rejection(noD.client.issueQrTicket()), 'JOIN_METHOD_UNAVAILABLE'),
    ).toBe(true);
    noD.client.close();
    const { client, socket } = await connectedClient();
    expect(isSyncClientError(await rejection(client.rotateCodes()), 'NOT_IN_GROUP')).toBe(true);
    const joining = joinTestGroup(client);
    socket.receive({
      type: 'group.joined',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: 'm',
      role: 'member',
      metadata: {},
      token: 'h.p.s',
      leaderOnline: true,
      hasPosition: false,
    });
    await joining;
    for (const call of [
      () => client.rotateCodes(),
      () => client.issueQrTicket(),
      () => client.approveJoin(REQUEST_ID),
      () => client.denyJoin(REQUEST_ID),
    ]) {
      expect(isSyncClientError(await rejection(call()), 'NOT_LEADER')).toBe(true);
    }
    expect(client.getJoinCodes()).toBeNull();
    client.close();
  });

  it('tracks join requests, deduplicated, and approves or denies them', async () => {
    const { client, socket } = await leader(['B', 'D']);
    const requested: JoinRequestedEvent[] = [];
    const withdrawn = vi.fn();
    client.on('joinRequested', (e) => requested.push(e));
    client.on('joinWithdrawn', withdrawn);
    const frame = {
      type: 'join.requested',
      groupId: GROUP_ID,
      requestId: REQUEST_ID,
      expiresInMs: 60_000,
      displayName: 'Dana',
    };
    socket.receive(frame);
    socket.receive(frame);
    expect(requested).toHaveLength(1);
    expect(client.getJoinRequests()).toEqual([
      { requestId: REQUEST_ID, displayName: 'Dana', expiresAt: Date.now() + 60_000 },
    ]);
    const approving = client.approveJoin(REQUEST_ID);
    const sent = socket.lastMessage();
    expect(sent).toEqual({ type: 'join.approve', reqId: sent.reqId, requestId: REQUEST_ID });
    socket.receive({
      type: 'join.decided',
      reqId: sent.reqId,
      requestId: REQUEST_ID,
      outcome: 'group_full',
    });
    expect(await approving).toBe('group_full');
    expect(client.getJoinRequests()).toEqual([]);

    const other = 'Q'.repeat(22);
    socket.receive({ ...frame, requestId: other });
    socket.receive({
      type: 'join.withdrawn',
      groupId: GROUP_ID,
      requestId: other,
      reason: 'timeout',
    });
    expect(withdrawn).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      requestId: other,
      reason: 'timeout',
    });

    socket.receive({ ...frame, requestId: other });
    const denying = client.denyJoin(other);
    const deny = socket.lastMessage();
    socket.receive({
      type: 'join.decided',
      reqId: deny.reqId,
      requestId: other,
      outcome: 'denied',
    });
    await denying;
    expect(isSyncClientError(await rejection(client.approveJoin('bad')), 'INVALID_PAYLOAD')).toBe(
      true,
    );
    client.close();
  });

  it('emits joinPaused and joinResumed', async () => {
    const { client, socket } = await leader();
    const paused = vi.fn();
    const resumed = vi.fn();
    client.on('joinPaused', paused);
    client.on('joinResumed', resumed);
    socket.receive({ type: 'join.paused', groupId: GROUP_ID, retryAfterMs: 600_000 });
    socket.receive({ type: 'join.resumed', groupId: GROUP_ID });
    socket.receive({ type: 'join.paused', groupId: 'H'.repeat(43), retryAfterMs: 1 });
    expect(paused).toHaveBeenCalledWith({ groupId: GROUP_ID, retryAfterMs: 600_000 });
    expect(paused).toHaveBeenCalledTimes(1);
    expect(resumed).toHaveBeenCalledWith({ groupId: GROUP_ID });
    client.close();
  });

  it('forgets codes and requests when the group ends', async () => {
    const { client, socket } = await leader(['B']);
    socket.receive({
      type: 'join.requested',
      groupId: GROUP_ID,
      requestId: REQUEST_ID,
      expiresInMs: 1,
    });
    const ending = client.endGroup();
    socket.receive({
      type: 'group.ended',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      reason: 'ended_by_leader',
    });
    await ending;
    expect(client.getJoinCodes()).toBeNull();
    expect(client.getJoinRequests()).toEqual([]);
    client.close();
  });
});
