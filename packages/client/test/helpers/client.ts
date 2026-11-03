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
  maxSessionMinutes: 180,
  qrTicketSeconds: 300,
  approvalTimeoutSeconds: 120,
};

/** The app's join methods in the fake `hello.ok`: every method, so every flow can be tested. */
export const JOIN_METHODS_ALL = ['A', 'B', 'C', 'D'] as const;

export const PARTICIPANT_ID = 'participant-1';

/** A codes payload as the server sends it to a leader (#10 AC6). Never real codes. */
export const TEST_CODES = {
  generation: 1_767_225_600_000,
  groupCode: '123456',
  doorCode: '654321',
  blob: `eyJ2IjoxfQ.${'A'.repeat(43)}`,
};

/** The #10 fields of a `group.created` frame. */
export const CREATED_FIELDS = { joinMethods: ['A', 'D'], codes: TEST_CODES };

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
  options: {
    participantId?: string;
    limits?: AppLimits;
    joinMethods?: readonly ('A' | 'B' | 'C' | 'D')[];
  } = {},
): void {
  socket.open();
  socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
  const hello = socket.lastMessage();
  socket.receive({
    type: 'hello.ok',
    reqId: hello.reqId,
    participantId: options.participantId ?? PARTICIPANT_ID,
    namespace: 'app-a',
    joinMethods: options.joinMethods ?? JOIN_METHODS_ALL,
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
