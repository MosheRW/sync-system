import type { AppLimits } from '@sync-system/protocol';
import { SyncClient } from '../../src/client.js';
import type { SyncClientOptions } from '../../src/options.js';
import { FakeWebSocket } from './fake-websocket.js';

/** An obvious test value, never a real key. */
export const TEST_API_KEY = 'test-api-key-client-0123456789-0123456789';

export const LIMITS: AppLimits = {
  maxGroupSize: 30,
  maxLeaderUpdatesPerSecond: 5,
  maxMessageBytes: 4096,
};

export const PARTICIPANT_ID = 'participant-1';

/** A client on a FakeWebSocket. `random` defaults to 1, so delays equal their caps. */
export function makeClient(extra: Partial<SyncClientOptions> = {}): SyncClient {
  return new SyncClient({
    url: 'ws://127.0.0.1:1/ws',
    apiKey: TEST_API_KEY,
    appVersion: '1.0.0',
    WebSocket: FakeWebSocket,
    random: () => 1,
    ...extra,
  });
}

/** Plays the server side of a successful handshake on `socket`. */
export function serverHandshake(
  socket: FakeWebSocket,
  options: { participantId?: string; limits?: AppLimits } = {},
): void {
  socket.open();
  socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
  const hello = socket.lastMessage();
  socket.receive({
    type: 'hello.ok',
    reqId: hello.reqId,
    participantId: options.participantId ?? PARTICIPANT_ID,
    limits: options.limits ?? LIMITS,
  });
}

/** A connected client and its socket. */
export async function connectedClient(
  extra: Partial<SyncClientOptions> = {},
  limits?: AppLimits,
): Promise<{ client: SyncClient; socket: FakeWebSocket }> {
  const client = makeClient(extra);
  const connecting = client.connect();
  const socket = FakeWebSocket.last;
  serverHandshake(socket, limits ? { limits } : {});
  await connecting;
  return { client, socket };
}
