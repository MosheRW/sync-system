import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestServer, KEY_A, startTestServer } from './helpers/test-server.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer({
    apps: [
      { namespace: 'app-a', apiKey: KEY_A, minAppVersion: '1.9.0' },
      {
        namespace: 'app-pre',
        apiKey: 'test-key-prerelease-0123456789-0123456789',
        minAppVersion: '2.0.0',
      },
    ],
  });
});

afterAll(async () => {
  await ts.close();
});

const GROUP_ACTIONS = [
  { type: 'group.create', metadata: { contentId: 'c' } },
  { type: 'group.joinByCode', joinCode: '123456' },
  { type: 'position.update', position: { page: 1 } },
];

describe('handshake', () => {
  it('declares both protocol versions in welcome first (AC8)', async () => {
    const client = await ts.connect();
    expect(await client.next()).toEqual({
      type: 'welcome',
      protocolVersion: 1,
      minProtocolVersion: 1,
    });
  });

  it('accepts a valid hello and returns participantId and limits', async () => {
    const client = await ts.connect();
    const reply = await client.hello({ apiKey: KEY_A, appVersion: '1.9.0', reqId: 'h1' });
    expect(reply).toEqual({
      type: 'hello.ok',
      reqId: 'h1',
      participantId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      namespace: 'app-a',
      joinMethods: ['A', 'D'],
      limits: {
        maxGroupSize: 30,
        maxLeaderUpdatesPerSecond: 5,
        maxMessageBytes: 4096,
        maxSessionMinutes: 180,
        qrTicketSeconds: 300,
        approvalTimeoutSeconds: 120,
        inactivityLimitMinutes: 20,
        disconnectGraceSeconds: 30,
        keepAliveCountdownSeconds: 60,
      },
      defaultHandoff: 'auto',
    });
  });

  it('sends the lifecycle timers and the default handoff mode in hello.ok (#13 AC1, AC3)', async () => {
    const custom = await startTestServer({
      apps: [
        {
          namespace: 'app-a',
          apiKey: KEY_A,
          inactivityLimitMinutes: 10,
          disconnectGraceSeconds: 45,
          keepAliveCountdownSeconds: 90,
          defaultHandoff: 'frozen',
        },
      ],
    });
    try {
      const client = await custom.connect();
      expect(await client.hello({ apiKey: KEY_A })).toMatchObject({
        limits: {
          inactivityLimitMinutes: 10,
          disconnectGraceSeconds: 45,
          keepAliveCountdownSeconds: 90,
        },
        defaultHandoff: 'frozen',
      });
    } finally {
      await custom.close();
    }
  });

  it('sends the app join methods and join timers in hello.ok (#10 AC4)', async () => {
    const custom = await startTestServer({
      apps: [
        {
          namespace: 'app-c',
          apiKey: KEY_A,
          joinMethods: ['D', 'C', 'B'],
          qrTicketSeconds: 60,
          approvalTimeoutSeconds: 30,
        },
      ],
    });
    try {
      const client = await custom.connect();
      const reply = await client.hello({ apiKey: KEY_A });
      expect(reply).toMatchObject({
        type: 'hello.ok',
        joinMethods: ['B', 'C', 'D'],
        limits: { qrTicketSeconds: 60, approvalTimeoutSeconds: 30 },
      });
    } finally {
      await custom.close();
    }
  });

  it('rejects an unknown key with INVALID_API_KEY and close 4001 (AC7)', async () => {
    const client = await ts.connect();
    const reply = await client.hello({ apiKey: 'unknown-key-0123456789-0123456789-0123' });
    expect(reply).toMatchObject({ type: 'error', code: 'INVALID_API_KEY' });
    expect(await client.closed()).toEqual({ code: 4001, reason: 'INVALID_API_KEY' });
  });

  it('rejects a missing key with INVALID_API_KEY and close 4001 (AC7)', async () => {
    const client = await ts.connect();
    const reply = await client.hello({ apiKey: undefined });
    expect(reply).toMatchObject({ type: 'error', code: 'INVALID_API_KEY' });
    expect((await client.closed()).code).toBe(4001);
  });

  it('rejects an empty key with INVALID_API_KEY', async () => {
    const client = await ts.connect();
    expect(await client.hello({ apiKey: '' })).toMatchObject({ code: 'INVALID_API_KEY' });
  });

  it('rejects an old protocol with PROTOCOL_TOO_OLD and the minimum (AC8)', async () => {
    const client = await ts.connect();
    const reply = await client.hello({ apiKey: KEY_A, protocolVersion: 0, appVersion: '2.0.0' });
    expect(reply).toEqual({
      type: 'error',
      code: 'PROTOCOL_TOO_OLD',
      message: expect.any(String) as string,
      details: { minProtocolVersion: 1 },
    });
    expect((await client.closed()).code).toBe(4001);
  });

  it('rejects an old app version with APP_VERSION_TOO_OLD and the minimum (AC9)', async () => {
    const client = await ts.connect();
    const reply = await client.hello({ apiKey: KEY_A, appVersion: '1.8.9' });
    expect(reply).toMatchObject({
      type: 'error',
      code: 'APP_VERSION_TOO_OLD',
      details: { minAppVersion: '1.9.0' },
    });
    expect((await client.closed()).code).toBe(4001);
  });

  it('compares app versions as semver (AC9)', async () => {
    for (const version of ['1.9.0', '1.10.0', '2.0.0', '1.9.1-beta.1']) {
      const client = await ts.connect();
      expect((await client.hello({ apiKey: KEY_A, appVersion: version })).type, version).toBe(
        'hello.ok',
      );
    }
    // 1.9.0-rc.1 is a prerelease of the minimum, so it is below it.
    const client = await ts.connect();
    expect(await client.hello({ apiKey: KEY_A, appVersion: '1.9.0-rc.1' })).toMatchObject({
      code: 'APP_VERSION_TOO_OLD',
    });
    const pre = await ts.connect();
    expect(
      await pre.hello({
        apiKey: 'test-key-prerelease-0123456789-0123456789',
        appVersion: '2.0.0-beta',
      }),
    ).toMatchObject({ code: 'APP_VERSION_TOO_OLD' });
  });

  it('rejects a non-semver or too-long app version with INVALID_APP_VERSION (AC9, L2)', async () => {
    for (const version of ['latest', '1.0', '', '1'.repeat(65), `1.0.0-${'a'.repeat(59)}`]) {
      const client = await ts.connect();
      const reply = await client.hello({ apiKey: KEY_A, appVersion: version });
      expect(reply, version).toMatchObject({ type: 'error', code: 'INVALID_APP_VERSION' });
      expect((await client.closed()).code).toBe(4001);
    }
  });

  it('rejects a 257-char apiKey by schema, before any key lookup (L2)', async () => {
    const spy = vi.spyOn(ts.registry, 'findByApiKey');
    try {
      const client = await ts.connect();
      const reply = await client.hello({ apiKey: 'k'.repeat(257) });
      expect(reply).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });
      expect((await client.closed()).code).toBe(4001);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('closes with 4001 on an invalid message before the handshake', async () => {
    const client = await ts.connect();
    await client.next('welcome');
    client.sendRaw('not json');
    expect(await client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect((await client.closed()).code).toBe(4001);
  });

  for (const action of GROUP_ACTIONS) {
    it(`rejects ${action.type} before hello with HANDSHAKE_REQUIRED and a close (AC10)`, async () => {
      const client = await ts.connect();
      await client.next('welcome');
      client.send({ ...action, reqId: 'r1' });
      expect(await client.next('error')).toMatchObject({
        code: 'HANDSHAKE_REQUIRED',
        reqId: 'r1',
      });
      expect(await client.closed()).toEqual({ code: 4001, reason: 'HANDSHAKE_REQUIRED' });
    });
  }

  it('accepts no group action after a failed hello (AC10)', async () => {
    const client = await ts.connect();
    await client.hello({ apiKey: 'unknown-key-0123456789-0123456789-0123' });
    for (const action of GROUP_ACTIONS) {
      if (client.isClosed) break;
      try {
        client.send(action);
      } catch {
        // The socket may already be closing.
      }
    }
    expect((await client.closed()).code).toBe(4001);
    await expect(client.next(undefined, 100)).rejects.toThrow();
  });

  it('answers a second hello with ALREADY_AUTHENTICATED and stays open', async () => {
    const client = await ts.connect();
    await client.hello({ apiKey: KEY_A, appVersion: '2.0.0' });
    client.send({
      type: 'hello',
      protocolVersion: 1,
      appVersion: '2.0.0',
      apiKey: KEY_A,
      reqId: 'again',
    });
    expect(await client.next('error')).toMatchObject({
      code: 'ALREADY_AUTHENTICATED',
      reqId: 'again',
    });
    expect(client.isClosed).toBe(false);
  });
});
