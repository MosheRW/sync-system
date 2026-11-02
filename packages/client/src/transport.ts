import {
  MAX_JSON_DEPTH,
  MAX_REQ_ID_LENGTH,
  type ServerMessage,
  checkJson,
  parseServerMessage,
} from '@sync-system/protocol';
import type { WebSocketConstructorLike, WebSocketLike } from './host.js';

/** Result of decoding one inbound frame. */
export type InboundFrame =
  | { kind: 'message'; message: ServerMessage }
  /** An object whose `type` this client does not know: ignored (AC10). */
  | { kind: 'unknown'; type: string }
  /** Binary, too long, not JSON, too deep, or a known type failing its schema. */
  | { kind: 'invalid'; issues: string[]; reqId: string | undefined };

const KNOWN_TYPES: ReadonlySet<string> = new Set<ServerMessage['type']>([
  'welcome',
  'hello.ok',
  'group.created',
  'group.joined',
  'position.ack',
  'position.updated',
  'group.ended',
  'token.refreshed',
  'error',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawReqId(frame: unknown): string | undefined {
  if (!isObject(frame) || !Object.hasOwn(frame, 'reqId')) return undefined;
  const reqId = frame.reqId;
  return typeof reqId === 'string' && reqId.length <= MAX_REQ_ID_LENGTH ? reqId : undefined;
}

/**
 * Untrusted server input, in order (AC10): text check -> length guard ->
 * `JSON.parse` -> iterative depth check -> unknown type -> schema. Opaque
 * fields pass through by reference (AC20).
 */
export function decodeFrame(data: unknown, maxChars: number): InboundFrame {
  if (typeof data !== 'string')
    return { kind: 'invalid', issues: ['(root): binary'], reqId: undefined };
  if (data.length > maxChars)
    return { kind: 'invalid', issues: ['(root): too_big'], reqId: undefined };
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return { kind: 'invalid', issues: ['(root): invalid_json'], reqId: undefined };
  }
  const check = checkJson(frame, { maxDepth: MAX_JSON_DEPTH });
  if (check !== 'ok') return { kind: 'invalid', issues: [`(root): ${check}`], reqId: undefined };
  if (isObject(frame) && typeof frame.type === 'string' && !KNOWN_TYPES.has(frame.type)) {
    return { kind: 'unknown', type: frame.type };
  }
  const parsed = parseServerMessage(frame);
  if (!parsed.ok) return { kind: 'invalid', issues: parsed.issues, reqId: rawReqId(frame) };
  return { kind: 'message', message: parsed.message };
}

/** Close code used when the socket reports an error (abnormal closure). */
export const ABNORMAL_CLOSE = 1006;

export interface TransportHandlers {
  onOpen(): void;
  onFrame(frame: InboundFrame): void;
  /** The socket closed or failed. Called at most once; the transport is retired after it. */
  onClose(code: number): void;
}

/**
 * One socket attempt. After `retire()` (or the socket's own close) no handler
 * is called again, so late events from an old socket are ignored.
 */
export class Transport {
  readonly #socket: WebSocketLike;
  readonly #handlers: TransportHandlers;
  #retired = false;
  #maxChars: number;

  readonly #onOpen = () => {
    if (!this.#retired) this.#handlers.onOpen();
  };
  readonly #onMessage = (event: unknown) => {
    if (this.#retired) return;
    const data = isObject(event) ? event.data : undefined;
    this.#handlers.onFrame(decodeFrame(data, this.#maxChars));
  };
  readonly #onClose = (event: unknown) => {
    const code = isObject(event) ? event.code : undefined;
    this.#ended(typeof code === 'number' ? code : ABNORMAL_CLOSE);
  };
  readonly #onError = () => {
    this.#ended(ABNORMAL_CLOSE);
  };
  /**
   * Stays attached to a retired socket for good (H2). `ws` is an
   * EventEmitter: an 'error' with no listener (for example after close() on
   * a socket that is still CONNECTING) would throw and end the Node process.
   */
  readonly #ignoreError = () => {};

  /** Throws if the constructor throws; the caller treats that as a failed attempt. */
  constructor(
    Ctor: WebSocketConstructorLike,
    url: string,
    handlers: TransportHandlers,
    maxChars: number,
  ) {
    this.#handlers = handlers;
    this.#maxChars = maxChars;
    this.#socket = new Ctor(url);
    this.#socket.addEventListener('open', this.#onOpen);
    this.#socket.addEventListener('message', this.#onMessage);
    this.#socket.addEventListener('close', this.#onClose);
    this.#socket.addEventListener('error', this.#onError);
  }

  get retired(): boolean {
    return this.#retired;
  }

  /** Raises the inbound length guard after `hello.ok`. */
  setMaxInboundChars(maxChars: number): void {
    this.#maxChars = maxChars;
  }

  /**
   * Sends one message as JSON. Returns false if the transport is retired or
   * the socket threw; a throw is handled like a socket error (H2), so
   * `onClose` has already run when this returns false.
   */
  send(message: object): boolean {
    return this.#write(() => JSON.stringify(message));
  }

  /** Sends text that is already serialized JSON, exactly as given. Same contract as `send`. */
  sendText(text: string): boolean {
    return this.#write(() => text);
  }

  #write(serialize: () => string): boolean {
    if (this.#retired) return false;
    try {
      this.#socket.send(serialize());
      return true;
    } catch {
      // A socket event fired during send() may have ended the transport already.
      if (this.#retired) return false;
      // Close the socket (keeping the no-op error listener) before reporting
      // the drop, so a socket that is still open never outlives the transport.
      this.retire(1000);
      this.#handlers.onClose(ABNORMAL_CLOSE);
      return false;
    }
  }

  /** Stops listening and closes the socket. Idempotent. */
  retire(code = 1000, reason?: string): void {
    if (this.#retired) return;
    this.#detach();
    try {
      this.#socket.close(code, reason);
    } catch {
      // Some implementations throw on invalid state or codes; never rethrow (H2).
    }
  }

  #ended(code: number): void {
    if (this.#retired) return;
    this.#detach();
    this.#handlers.onClose(code);
  }

  #detach(): void {
    this.#retired = true;
    // Attached before the real handlers go and before close() (H2).
    this.#socket.addEventListener('error', this.#ignoreError);
    this.#socket.removeEventListener('open', this.#onOpen);
    this.#socket.removeEventListener('message', this.#onMessage);
    this.#socket.removeEventListener('close', this.#onClose);
    this.#socket.removeEventListener('error', this.#onError);
  }
}
