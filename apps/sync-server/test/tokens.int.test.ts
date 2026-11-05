import { codesOf } from './helpers/groups.js';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_TTL_SECONDS } from '../src/limits/constants.js';
import { TokenKeyring } from '../src/tokens/token-keys.js';
import { TokenService } from '../src/tokens/token-service.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { KEY_B, type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';

const SECRETS = { current: randomBytes(32), source: 'env' as const };
const verifier = new TokenService(new TokenKeyring(SECRETS));

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('tokens on create and join (#5 AC5, AC6)', () => {
  it('gives the leader a signed leader token whose pid is its participant ID', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler, tokenSecrets: SECRETS });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: { a: 1 } });
    const created = await leader.next('group.created');

    const result = verifier.verify(created.token, 'app-a', scheduler.now());
    expect(result).toMatchObject({ ok: true, viaPrevious: false });
    const claims = claimsOf(created.token);
    expect(claims).toEqual({
      v: 2,
      aud: 'app-a',
      gid: created.groupId,
      pid: created.participantId,
      role: 'leader',
      gct: scheduler.now(),
      lat: scheduler.now(),
      term: scheduler.now(),
      iat: Math.floor(scheduler.now() / 1000),
      exp: Math.floor(scheduler.now() / 1000) + TOKEN_TTL_SECONDS,
    });
  });

  it('gives a member a member token for the same group and creation time', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler, tokenSecrets: SECRETS });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const created = await leader.next('group.created');
    scheduler.advance(5_000);

    const member = await ts.connectReady();
    member.send({ type: 'group.joinByCode', ...codesOf(created.codes) });
    const joined = await member.next('group.joined');
    expect(verifier.verify(joined.token, 'app-a', scheduler.now()).ok).toBe(true);
    const claims = claimsOf(joined.token);
    expect(claims).toMatchObject({
      aud: 'app-a',
      gid: created.groupId,
      pid: joined.participantId,
      role: 'member',
      gct: claimsOf(created.token).gct,
      iat: Math.floor(scheduler.now() / 1000),
    });
    expect(claims.exp - claims.iat).toBe(TOKEN_TTL_SECONDS);
    expect(joined.participantId).not.toBe(created.participantId);
  });

  it('signs per app: app A tokens do not verify for app B (AC8)', async () => {
    ts = await startTestServer({ tokenSecrets: SECRETS });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const { token } = await leader.next('group.created');
    expect(verifier.verify(token, 'app-b', Date.now()).ok).toBe(false);
    const other = await ts.connectReady(KEY_B);
    other.send({ type: 'group.create', metadata: {} });
    const b = await other.next('group.created');
    expect(verifier.verify(b.token, 'app-b', Date.now()).ok).toBe(true);
  });

  it('uses a random secret per instance when none is given (AC3)', async () => {
    ts = await startTestServer();
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const { token } = await leader.next('group.created');
    expect(verifier.verify(token, 'app-a', Date.now()).ok).toBe(false);
    expect(claimsOf(token).aud).toBe('app-a');
  });

  it('returns the app namespace in hello.ok (AC33)', async () => {
    ts = await startTestServer();
    const client = await ts.connect();
    const reply = await client.hello({ apiKey: KEY_B });
    expect(reply).toMatchObject({ type: 'hello.ok', namespace: 'app-b' });
  });
});
