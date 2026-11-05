import type { WebSocketLike } from '@sync-system/client';

type Listener = (event: unknown) => void;
type EventType = 'open' | 'message' | 'close' | 'error';

/**
 * A minimal counting WebSocketLike for owned-mode lifecycle tests with a
 * real `SyncClient` (section 4): counts constructed and closed sockets and
 * never opens (the client stays `connecting`).
 */
export class CountingWebSocket implements WebSocketLike {
  static instances: CountingWebSocket[] = [];

  static reset(): void {
    CountingWebSocket.instances = [];
  }

  static get closed(): number {
    return CountingWebSocket.instances.filter((socket) => socket.closeCalls > 0).length;
  }

  readyState = 0;
  closeCalls = 0;
  readonly #listeners = new Map<EventType, Set<Listener>>();

  constructor(readonly url: string) {
    CountingWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
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
}
