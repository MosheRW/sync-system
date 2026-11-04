import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createGroupWithMembers, joinByCode, resumeWith } from './helpers/groups.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** Names the strict #10 rule refuses (Q5.5): control, bidi, zero-width, too long. */
const BAD_NAMES = [
  'x'.repeat(33),
  `a${String.fromCharCode(7)}b`,
  `a${String.fromCharCode(0x202e)}b`,
  `a${String.fromCharCode(0x2066)}b`,
  `a${String.fromCharCode(0x200b)}b`,
  String.fromCodePoint(0x2800),
];

describe('display names (#13 AC35-AC38)', () => {
  it('refuses a bad name on create, join and resume with INVALID_MESSAGE, storing nothing', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1);
    for (const displayName of BAD_NAMES) {
      const creator = await ts.connectReady();
      creator.send({ type: 'group.create', reqId: 'c', metadata: {}, displayName });
      expect(await creator.next('error')).toMatchObject({ reqId: 'c', code: 'INVALID_MESSAGE' });
      const { reply } = await joinByCode(ts, group, { extra: { displayName } });
      expect(reply).toMatchObject({ code: 'INVALID_MESSAGE' });
      const resumed = await resumeWith(ts, group.memberTokens[0], { displayName });
      expect(resumed.reply).toMatchObject({ code: 'INVALID_MESSAGE' });
    }
  });

  it('gives a missing or blank name a unique Guest N, skipping chosen look-alikes', async () => {
    ts = await startTestServer();
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, displayName: '   ' });
    const created = await leader.next('group.created');
    expect(created).toMatchObject({ displayName: 'Guest 1', generated: true });
    const chosen = await joinByCode(ts, created, { extra: { displayName: 'Guest 2' } });
    expect(chosen.reply).toMatchObject({ displayName: 'Guest 2', generated: false });
    const blank = await joinByCode(ts, created, { extra: { displayName: '' } });
    expect(blank.reply).toMatchObject({ displayName: 'Guest 3', generated: true });
    const roster = leader.rosterFrames
      .filter((f) => f.type === 'roster.updated')
      .map((f) => (f.type === 'roster.updated' ? f.participant : undefined));
    expect(roster.map((p) => [p?.displayName, p?.generated, p?.guestNumber])).toEqual([
      ['Guest 2', false, undefined],
      ['Guest 3', true, 3],
    ]);
  });

  it('trims a chosen name and keeps RTL and emoji names as plain text', async () => {
    ts = await startTestServer();
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, displayName: '  דנה 🙂  ' });
    expect(await leader.next('group.created')).toMatchObject({
      displayName: 'דנה 🙂',
      generated: false,
    });
  });

  it('uses the approval joiner name for the roster, the same rule in join.requested', async () => {
    ts = await startTestServer({
      apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['B'] }],
    });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const created = await leader.next('group.created');
    const named = await joinByCode(ts, created, { extra: { displayName: 'Noa' } });
    expect(named.reply).toMatchObject({ type: 'join.pending' });
    const requested = await leader.next('join.requested');
    expect(requested.displayName).toBe('Noa');
    leader.send({ type: 'join.approve', requestId: requested.requestId });
    await leader.next('join.decided');
    expect(await named.client.next('group.joined')).toMatchObject({
      displayName: 'Noa',
      generated: false,
    });
    const unnamed = await joinByCode(ts, created);
    const second = await leader.next('join.requested');
    expect(second).not.toHaveProperty('displayName');
    leader.send({ type: 'join.approve', requestId: second.requestId });
    await leader.next('join.decided');
    expect(await unnamed.client.next('group.joined')).toMatchObject({ generated: true });
  });

  it('after a restart a resume sends the name again; without one it is generated again (AC37)', async () => {
    const tokenSecrets = { current: randomBytes(32), source: 'env' as const };
    ts = await startTestServer({ tokenSecrets });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, displayName: 'Dana' });
    const created = await leader.next('group.created');
    const { reply: joined } = await joinByCode(ts, created, { extra: { displayName: 'Ari' } });
    if (joined.type !== 'group.joined') throw new Error('expected group.joined');
    await ts.close();
    ts = await startTestServer({ tokenSecrets });
    const back = await resumeWith(ts, created.token, { metadata: {} });
    // Names are not in tokens: the leader sent none, so it is generated.
    expect(back.reply).toMatchObject({ type: 'group.resumed', displayName: 'Guest 1' });
    const member = await resumeWith(ts, joined.token, { displayName: 'Ari' });
    expect(member.reply).toMatchObject({ displayName: 'Ari', generated: false });
    for (const token of [created.token, joined.token]) {
      expect(Buffer.from(token.split('.')[1]!, 'base64url').toString()).not.toMatch(/Dana|Ari/);
    }
  });
});
