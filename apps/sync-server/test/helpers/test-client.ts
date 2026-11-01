import type { ServerMessage, ServerMessageType } from '@sync-system/protocol';
import WebSocket from 'ws';

export const TEST_APP_VERSION = '1.0.0';

export interface HelloOptions {
  apiKey?: string | undefined;
  appVersion?: string;
  protocolVersion?: number;
  reqId?: string;
}

type MessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

/**
 * A `ws` client wrapper for integration tests. It buffers every message from
 * the moment the socket opens, so `welcome` is never missed.
 */
export class TestClient {
  private readonly queue: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  private readonly closePromise: Promise<{ code: number; reason: string }>;
  isClosed = false;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? '' : (data as Buffer).toString('utf8');
      this.queue.push(JSON.parse(text) as ServerMessage);
      this.notify();
    });
    ws.on('error', () => {
      // Surface failures through `closed()` and timeouts instead.
    });
    this.closePromise = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.isClosed = true;
        this.notify();
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
  }

  static connect(url: string, options: WebSocket.ClientOptions = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      const client = new TestClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`unexpected response ${res.statusCode ?? 0}`));
      });
      ws.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(data: string | Buffer, binary = false): void {
    this.ws.send(data, { binary });
  }

  /** Waits for the next message; throws if it is not of `type` (when given). */
  async next<T extends ServerMessageType>(type: T, timeoutMs?: number): Promise<MessageOf<T>>;
  async next(type?: undefined, timeoutMs?: number): Promise<ServerMessage>;
  async next(type?: ServerMessageType, timeoutMs = 2000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length === 0) {
      if (this.isClosed) throw new Error(`socket closed while waiting for ${type ?? 'a message'}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type ?? 'a message'}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const message = this.queue.shift()!;
    if (type !== undefined && message.type !== type) {
      throw new Error(`expected ${type}, got ${JSON.stringify(message)}`);
    }
    return message;
  }

  /** Waits for an `error` message and returns it. */
  error(timeoutMs?: number): Promise<MessageOf<'error'>> {
    return this.next('error', timeoutMs);
  }

  /** Asserts that no message arrives within `ms`. */
  async expectNoMessage(ms = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.queue.length > 0) {
      throw new Error(`expected no message, got ${JSON.stringify(this.queue[0])}`);
    }
  }

  /** Number of buffered, unread messages. */
  get pending(): number {
    return this.queue.length;
  }

  /** Consumes `welcome`, sends `hello`, and returns the reply. */
  async hello(options: HelloOptions = {}): Promise<ServerMessage> {
    await this.next('welcome');
    const message: Record<string, unknown> = {
      type: 'hello',
      protocolVersion: options.protocolVersion ?? 1,
      appVersion: options.appVersion ?? TEST_APP_VERSION,
    };
    if (options.apiKey !== undefined) message.apiKey = options.apiKey;
    if (options.reqId !== undefined) message.reqId = options.reqId;
    this.send(message);
    return this.next();
  }

  closed(): Promise<{ code: number; reason: string }> {
    return this.closePromise;
  }

  close(code?: number, reason?: string): Promise<{ code: number; reason: string }> {
    this.ws.close(code, reason);
    return this.closePromise;
  }

  terminate(): void {
    this.ws.terminate();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
