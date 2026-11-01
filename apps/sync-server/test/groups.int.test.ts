import { GROUP_ID_PATTERN, PARTICIPANT_ID_PATTERN } from '@sync-system/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer;
let store: InMemoryGroupStore;

beforeEach(async () => {
  store = new InMemoryGroupStore();
  ts = await startTestServer({ store });
});

afterEach(async () => {
  await ts.close();
});

const METADATA = { contentId: 'book-1', fingerprint: 'abc', schemaVersion: 2 };

describe('group create (AC11)', () => {
  it('creates a group with metadata and an initial position; creator is leader', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', reqId: 'c1', metadata: METADATA, position: { page: 3 } });
    const created = await leader.next('group.created');
    expect(created).toEqual({
      type: 'group.created',
      reqId: 'c1',
      groupId: expect.stringMatching(GROUP_ID_PATTERN) as string,
      participantId: expect.any(String) as string,
      role: 'leader',
    });
    expect(store.size).toBe(1);
  });

  it('creates a group without a position', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    expect((await leader.next('group.created')).role).toBe('leader');
  });

  it('rejects a second create on the same connection with ALREADY_IN_GROUP', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    await leader.next('group.created');
    leader.send({ type: 'group.create', metadata: {}, reqId: 'again' });
    expect(await leader.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP', reqId: 'again' });
    expect(store.size).toBe(1);
  });

  it('rejects metadata that is not an object with INVALID_MESSAGE', async () => {
    const leader = await ts.connectReady();
    for (const metadata of [[], null, 'x', 1]) {
      leader.send({ type: 'group.create', metadata });
      expect(await leader.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    }
    leader.send({ type: 'group.create' });
    expect(await leader.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(store.size).toBe(0);
    expect(leader.isClosed).toBe(false);
  });
});

describe('group join (AC12)', () => {
  it('returns the metadata and current position on join', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: METADATA, position: { page: 3 } });
    const { groupId } = await leader.next('group.created');

    const member = await ts.connectReady();
    member.send({ type: 'group.join', reqId: 'j1', groupId });
    expect(await member.next('group.joined')).toEqual({
      type: 'group.joined',
      reqId: 'j1',
      groupId,
      participantId: expect.any(String) as string,
      role: 'member',
      metadata: METADATA,
      hasPosition: true,
      position: { page: 3 },
    });
  });

  it('says hasPosition false, with no position field, when there is none yet', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: METADATA });
    const { groupId } = await leader.next('group.created');

    const member = await ts.connectReady();
    member.send({ type: 'group.join', groupId });
    const joined = await member.next('group.joined');
    expect(joined.hasPosition).toBe(false);
    expect('position' in joined).toBe(false);
  });

  it('keeps null as a real initial position', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, position: null });
    const { groupId } = await leader.next('group.created');
    const member = await ts.connectReady();
    member.send({ type: 'group.join', groupId });
    expect(await member.next('group.joined')).toMatchObject({ hasPosition: true, position: null });
  });

  it('gives each participant a distinct participant ID', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const created = await leader.next('group.created');
    const member = await ts.connectReady();
    member.send({ type: 'group.join', groupId: created.groupId });
    const joined = await member.next('group.joined');
    expect(joined.participantId).not.toBe(created.participantId);
  });

  it('mints group-scoped participant IDs, distinct from the connection ID (#5 AC6)', async () => {
    const leader = await ts.connect();
    const hello = await leader.hello({ apiKey: KEY_A });
    if (hello.type !== 'hello.ok') throw new Error('hello failed');
    leader.send({ type: 'group.create', metadata: {} });
    const created = await leader.next('group.created');
    expect(created.participantId).toMatch(PARTICIPANT_ID_PATTERN);
    expect(created.participantId).not.toBe(hello.participantId);
    const record = await store.get('app-a', created.groupId);
    expect(record?.leaderId).toBe(created.participantId);
    expect(record?.participantIds).toEqual([created.participantId]);
  });

  it('answers an unknown group ID with GROUP_NOT_FOUND', async () => {
    const member = await ts.connectReady();
    member.send({ type: 'group.join', groupId: 'Z'.repeat(43), reqId: 'x' });
    expect(await member.next('error')).toMatchObject({ code: 'GROUP_NOT_FOUND', reqId: 'x' });
    expect(member.isClosed).toBe(false);
  });

  it('rejects joining while already in a group with ALREADY_IN_GROUP', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const { groupId } = await leader.next('group.created');
    leader.send({ type: 'group.join', groupId });
    expect(await leader.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });

    const member = await ts.connectReady();
    member.send({ type: 'group.join', groupId });
    await member.next('group.joined');
    member.send({ type: 'group.join', groupId });
    expect(await member.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });
  });

  it('removes the group from memory when its last participant leaves', async () => {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    await leader.next('group.created');
    expect(store.size).toBe(1);
    await leader.close();
    await waitUntil(() => store.size === 0);
  });
});
