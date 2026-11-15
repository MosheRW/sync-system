import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { AppRegistry } from '../src/apps/app-registry.js';
import { parseAppsConfig } from '../src/config/apps-config.js';
import { parseEnv } from '../src/config/env.js';
import type { GroupActions, Session } from '../src/groups/session.js';
import { createLogger } from '../src/logging/logger.js';
import { Connection } from '../src/ws/connection.js';
import { ConnectionCounter } from '../src/ws/connection-counter.js';
import { TestClient } from './helpers/test-client.js';
import { KEY_A } from './helpers/test-server.js';
import { sleep } from './helpers/wait.js';

const GROUP = 'g'.repeat(43);
const moved = (page: number) =>
  JSON.stringify({ type: 'position.updated', groupId: GROUP, position: { page } });

let wss: WebSocketServer | undefined;
afterEach(async () => {
  for (const ws of wss?.clients ?? []) ws.terminate();
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  wss = undefined;
});

/**
 * One real Connection over a socket, with `groups` stubbed: the join attaches
 * the session, and a frame for it arrives (as a remote effect or another
 * task's flush would) before the join's reply is sent.
 */
async function connectWith(
  groups: Partial<GroupActions>,
  maxBufferedBytes = 1 << 20,
): Promise<TestClient> {
  const env = parseEnv({});
  const registry = new AppRegistry(
    parseAppsConfig(
      JSON.stringify({ apps: [{ namespace: 'app-a', apiKey: KEY_A, minAppVersion: '1.0.0' }] }),
      env,
    ),
  );
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    new Connection(ws, {
      logger: createLogger({ level: 'silent' }),
      counter: new ConnectionCounter(),
      registry,
      groups: groups as GroupActions,
      handshakeTimeoutMs: 5_000,
      inbound: { ratePerSecond: 100, burst: 100 },
      now: Date.now,
      maxBufferedBytes,
      maxQueuedBytes: 1 << 20,
      onClosed: () => undefined,
    });
  });
  await new Promise<void>((resolve) => wss!.once('listening', () => resolve()));
  const { port } = wss.address() as AddressInfo;
  const client = await TestClient.connect(`ws://127.0.0.1:${port}/ws`);
  expect(await client.hello({ apiKey: KEY_A })).toMatchObject({ type: 'hello.ok' });
  return client;
}

function joined(session: Session) {
  return {
    type: 'group.joined' as const,
    groupId: GROUP,
    participantId: session.membership!.participantId,
  } as never;
}

it('a frame for a session attached by a request in flight follows its reply', async () => {
  let attached: Session | undefined;
  const client = await connectWith({
    async joinByCode(session) {
      session.membership = { groupId: GROUP, participantId: 'p', attachId: 'a' };
      attached = session;
      // Committed and attached; a frame arrives before the reply goes out.
      session.deliver(moved(2));
      await sleep(20);
      session.deliver(moved(3));
      return joined(session);
    },
  });
  client.send({ type: 'group.joinByCode', joinCode: '123456', doorCode: '123456' });
  expect((await client.next()).type).toBe('group.joined');
  expect(await client.next()).toMatchObject({ position: { page: 2 } });
  expect(await client.next()).toMatchObject({ position: { page: 3 } });
  // With no request in flight, frames go out at once, in order.
  attached!.deliver(moved(4));
  expect(await client.next()).toMatchObject({ position: { page: 4 } });
});

it('a frame for an existing member is not held behind its other requests', async () => {
  let member: Session | undefined;
  let release: (() => void) | undefined;
  const client = await connectWith({
    joinByCode(session) {
      session.membership = { groupId: GROUP, participantId: 'p', attachId: 'a' };
      member = session;
      return Promise.resolve(joined(session));
    },
    async update() {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { type: 'position.ack', groupId: GROUP } as never;
    },
  });
  client.send({ type: 'group.joinByCode', joinCode: '123456', doorCode: '123456' });
  await client.next('group.joined');
  client.send({ type: 'position.update', position: { page: 9 } });
  await sleep(20);
  member!.deliver(moved(5));
  expect(await client.next()).toMatchObject({ position: { page: 5 } });
  release!();
  expect((await client.next()).type).toBe('position.ack');
});

it('held frames count against the outbound buffer limit: over it, the socket is cut (security S5)', async () => {
  const client = await connectWith(
    {
      async joinByCode(session) {
        session.membership = { groupId: GROUP, participantId: 'p', attachId: 'a' };
        // A busy group: frames for the session pile up while the join is in flight.
        for (let page = 1; page <= 20; page++) session.deliver(moved(page) + ' '.repeat(500));
        await sleep(20);
        return joined(session);
      },
    },
    4_096,
  );
  client.send({ type: 'group.joinByCode', joinCode: '123456', doorCode: '123456' });
  // Twenty frames of over 500 bytes are past the 4 KiB limit: terminated, not held.
  expect(await client.closed()).toMatchObject({ code: 1006 });
});

it('held frames under the limit all go out after the reply', async () => {
  const client = await connectWith(
    {
      async joinByCode(session) {
        session.membership = { groupId: GROUP, participantId: 'p', attachId: 'a' };
        for (let page = 1; page <= 5; page++) session.deliver(moved(page) + ' '.repeat(500));
        await sleep(20);
        return joined(session);
      },
    },
    4_096,
  );
  client.send({ type: 'group.joinByCode', joinCode: '123456', doorCode: '123456' });
  expect((await client.next()).type).toBe('group.joined');
  for (let page = 1; page <= 5; page++) {
    expect(await client.next()).toMatchObject({ position: { page } });
  }
});
