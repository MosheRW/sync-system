/**
 * A set of listeners. Emitting iterates over a copy, skips a listener that
 * was removed while the emit runs (AC19), and catches listener exceptions
 * so one bad listener cannot break the others or the client.
 */
export class ListenerSet<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly #onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  get size(): number {
    return this.#listeners.size;
  }

  add(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  delete(listener: (value: T) => void): void {
    this.#listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.#listeners]) {
      if (!this.#listeners.has(listener)) continue;
      try {
        listener(value);
      } catch (error) {
        this.#onError(error);
      }
    }
  }
}

/** A small typed event emitter built on `ListenerSet`. */
export class Emitter<Events extends object> {
  readonly #sets = new Map<keyof Events, unknown>();
  readonly #onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  #set<E extends keyof Events>(event: E): ListenerSet<Events[E]> {
    let set = this.#sets.get(event) as ListenerSet<Events[E]> | undefined;
    if (set === undefined) {
      set = new ListenerSet<Events[E]>(this.#onError);
      this.#sets.set(event, set);
    }
    return set;
  }

  on<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): () => void {
    return this.#set(event).add(listener);
  }

  off<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): void {
    (this.#sets.get(event) as ListenerSet<Events[E]> | undefined)?.delete(listener);
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    (this.#sets.get(event) as ListenerSet<Events[E]> | undefined)?.emit(payload);
  }
}
