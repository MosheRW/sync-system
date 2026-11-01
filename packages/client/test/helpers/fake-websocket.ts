import type { WebSocketLike } from '../../src/host.js';

type Listener = (event: unknown) => void;
type EventType = 'open' | 'message' | 'close' | 'error';

/**
 * A controllable WebSocketLike: records sends and close calls, and lets a
 * test deliver open, message, close and error events.
 */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static get last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error('no FakeWebSocket constructed');
    return socket;
  }

  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  throwOnSend = false;
  throwOnClose = false;
  readonly #listeners = new Map<EventType, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error('send failed');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.throwOnClose) throw new Error('close failed');
    this.readyState = 2;
  }

  addEventListener(type: EventType, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: EventType, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  listenerCount(type: EventType): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  /** Parsed messages the client sent. */
  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  lastMessage(): Record<string, unknown> {
    const message = this.messages.at(-1);
    if (!message) throw new Error('nothing sent');
    return message;
  }

  // ---- test controls ----

  open(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }

  /** Delivers a frame: objects are JSON-encoded, strings and others are passed as is. */
  receive(frame: unknown): void {
    const data =
      typeof frame === 'object' && frame !== null && !(frame instanceof ArrayBuffer)
        ? JSON.stringify(frame)
        : frame;
    this.#emit('message', { data });
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.#emit('close', { code, reason });
  }

  error(): void {
    this.#emit('error', {});
  }

  #emit(type: EventType, event: object): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}
