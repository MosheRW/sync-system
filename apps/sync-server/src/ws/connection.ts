import {
  type ClientMessage,
  CloseCode,
  ErrorCode,
  type ErrorMessage,
  MAX_JSON_DEPTH,
  MAX_REQ_ID_LENGTH,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ServerMessage,
  checkJson,
  parseClientMessage,
} from '@sync-system/protocol';
import type { RawData, WebSocket } from 'ws';
import type { AppRegistry } from '../apps/app-registry.js';
import { newParticipantId } from '../groups/ids.js';
import type { GroupActions, Session } from '../groups/session.js';
import { type Logger, participantRef, safeErr } from '../logging/logger.js';
import { MAX_QUEUED_MESSAGES } from '../limits/constants.js';
import type { ConnectionCounter } from './connection-counter.js';
import { errorMessage } from './error-messages.js';
import { checkHello } from './handshake.js';
import { type HeartbeatTarget, heartbeatPong } from './heartbeat.js';
import { InboundLimiter } from './inbound-limiter.js';
import { sendPong, sendSerialized } from './send.js';

export interface ConnectionDeps {
  logger: Logger;
  counter: ConnectionCounter;
  registry: AppRegistry;
  handshakeTimeoutMs: number;
  /** Per-connection inbound limiter settings (H3). */
  inbound: { ratePerSecond: number; burst: number };
  now: () => number;
  /** Outbound buffer limit per socket (H2). */
  maxBufferedBytes: number;
  groups: GroupActions;
  /** Called once when the socket has closed. */
  onClosed: (connection: Connection) => void;
}

type State = 'awaiting_hello' | 'ready' | 'closing';

type Parsed = { ok: true; message: ClientMessage } | { ok: false; reqId: string | undefined };

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Echo a client `reqId` only if it is a short string. */
function rawReqId(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return undefined;
  const reqId = (frame as Record<string, unknown>).reqId;
  return typeof reqId === 'string' && reqId.length <= MAX_REQ_ID_LENGTH ? reqId : undefined;
}

/**
 * Per-socket state machine (`awaiting_hello` -> `ready`). Inbound messages
 * are processed strictly in order through a promise queue whose tail never
 * rejects; every handler runs inside try/catch (H4).
 */
export class Connection implements HeartbeatTarget {
  /** Per-connection ID, sent as `hello.ok.participantId`. */
  readonly connectionId = newParticipantId();
  /** Set on hello.ok. */
  session: Session | undefined;
  awaitingPong = false;
  pingPayload: Buffer | undefined;
  lastBufferedAmount = 0;
  private state: State = 'awaiting_hello';
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private handshakeTimer: NodeJS.Timeout | undefined;
  private readonly limiter: InboundLimiter;
  private queueLength = 0;
  private flooded = false;

  constructor(
    readonly ws: WebSocket,
    private readonly deps: ConnectionDeps,
  ) {
    deps.counter.opened();
    this.limiter = new InboundLimiter(deps.inbound.ratePerSecond, deps.inbound.burst, deps.now);

    // Without an 'error' listener, a protocol violation from the peer would
    // throw from the EventEmitter and crash the process (H4).
    ws.on('error', (err: NodeJS.ErrnoException) => {
      deps.logger.debug({ event: 'ws_error', code: err.code, name: err.name }, 'websocket error');
    });
    // The client's close reason is never logged (L8).
    ws.on('close', (code: number) => this.onClose(code));
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(data, isBinary));
    // Control frames take inbound tokens like any other frame (H3).
    ws.on('ping', (data: Buffer) => this.onPing(data));
    ws.on('pong', (data: Buffer) => this.onPong(data));

    this.handshakeTimer = setTimeout(() => this.onHandshakeTimeout(), deps.handshakeTimeoutMs);
    this.handshakeTimer.unref();

    this.sendMessage({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      minProtocolVersion: MIN_CLIENT_PROTOCOL_VERSION,
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  ping(payload: Buffer): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.ping(payload);
  }

  terminate(): void {
    this.ws.terminate();
  }

  /** False (and the socket closing with 4008) when the frame is over the limit. */
  private takeInboundToken(): boolean {
    if (this.closed || this.flooded || this.state === 'closing') return false;
    if (this.limiter.take()) return true;
    this.closeFlooded();
    return false;
  }

  private onPing(data: Buffer): void {
    if (!this.takeInboundToken()) return;
    sendPong(this.ws, data, this.deps.maxBufferedBytes);
  }

  private onPong(data: Buffer): void {
    if (!this.takeInboundToken()) return;
    heartbeatPong(this, data);
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.closed || this.flooded || this.state === 'closing') return;
    // A token is taken for every frame before any parsing (H3).
    if (!this.limiter.take() || this.queueLength >= MAX_QUEUED_MESSAGES) {
      this.closeFlooded();
      return;
    }
    this.queueLength += 1;
    this.enqueue(async () => {
      try {
        await this.process(data, isBinary);
      } finally {
        this.queueLength -= 1;
      }
    });
  }

  /** Sends TOO_MANY_MESSAGES once, closes with 4008, ignores the rest (H3). */
  private closeFlooded(): void {
    this.flooded = true;
    this.state = 'closing';
    clearTimeout(this.handshakeTimer);
    this.deps.logger.warn(
      { event: 'flood_closed', namespace: this.session?.app.namespace },
      'inbound message limit exceeded',
    );
    this.sendMessage(errorMessage(ErrorCode.TOO_MANY_MESSAGES));
    this.ws.close(CloseCode.POLICY_VIOLATION, ErrorCode.TOO_MANY_MESSAGES);
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((err: unknown) => {
      this.deps.logger.error({ event: 'queue_error', err: safeErr(err) }, 'queue task failed');
    });
  }

  private async process(data: RawData, isBinary: boolean): Promise<void> {
    if (this.closed || this.state === 'closing') return;

    const parsed = this.parse(data, isBinary);
    if (!parsed.ok) {
      const error = errorMessage(ErrorCode.INVALID_MESSAGE, { reqId: parsed.reqId });
      if (this.state === 'awaiting_hello') {
        this.rejectHandshake(error, CloseCode.HANDSHAKE_REJECTED);
      } else {
        this.reply(error);
      }
      return;
    }

    const message = parsed.message;
    try {
      if (this.state === 'awaiting_hello') {
        this.handleHello(message);
      } else {
        await this.handleReady(message);
      }
    } catch (err) {
      this.deps.logger.error(
        { event: 'internal_error', type: message.type, err: safeErr(err) },
        'handler failed',
      );
      this.reply(errorMessage(ErrorCode.INTERNAL_ERROR, { reqId: message.reqId }));
    }
  }

  /** text -> JSON.parse -> iterative depth/type check -> shallow envelope schema. */
  private parse(data: RawData, isBinary: boolean): Parsed {
    if (isBinary) return { ok: false, reqId: undefined };
    let frame: unknown;
    try {
      frame = JSON.parse(toBuffer(data).toString('utf8'));
    } catch {
      return { ok: false, reqId: undefined };
    }
    if (checkJson(frame, { maxDepth: MAX_JSON_DEPTH }) !== 'ok') {
      return { ok: false, reqId: undefined };
    }
    const result = parseClientMessage(frame);
    if (!result.ok) return { ok: false, reqId: rawReqId(frame) };
    return { ok: true, message: result.message };
  }

  private handleHello(message: ClientMessage): void {
    if (message.type !== 'hello') {
      this.rejectHandshake(
        errorMessage(ErrorCode.HANDSHAKE_REQUIRED, { reqId: message.reqId }),
        CloseCode.HANDSHAKE_REJECTED,
      );
      return;
    }

    const result = checkHello(message, this.deps.registry, this.deps.counter);
    if (!result.ok) {
      this.deps.logger.info(
        { event: 'handshake_rejected', code: result.code },
        'handshake rejected',
      );
      this.rejectHandshake(
        errorMessage(result.code, { reqId: message.reqId, details: result.details }),
        result.closeCode,
      );
      return;
    }

    const { app } = result;
    clearTimeout(this.handshakeTimer);
    this.state = 'ready';
    this.deps.counter.authenticated(app.namespace);
    this.session = {
      connectionId: this.connectionId,
      app,
      membership: undefined,
      deliver: (text) => {
        this.transmit(text);
      },
      afterPending: (task) => {
        this.enqueue(() => {
          task();
          return Promise.resolve();
        });
      },
    };
    this.deps.logger.info(
      {
        event: 'handshake_ok',
        namespace: app.namespace,
        participantRef: participantRef(this.connectionId),
      },
      'handshake ok',
    );
    this.reply({
      type: 'hello.ok',
      ...(message.reqId !== undefined ? { reqId: message.reqId } : {}),
      participantId: this.connectionId,
      // Not secret: clients key token storage by it (#5 AC33).
      namespace: app.namespace,
      limits: {
        maxGroupSize: app.maxGroupSize,
        maxLeaderUpdatesPerSecond: app.maxLeaderUpdatesPerSecond,
        maxMessageBytes: app.maxMessageBytes,
        maxSessionMinutes: app.maxSessionMinutes,
      },
    });
  }

  private async handleReady(message: ClientMessage): Promise<void> {
    const session = this.session!;
    const groups = this.deps.groups;
    if (message.type === 'hello') {
      this.reply(errorMessage(ErrorCode.ALREADY_AUTHENTICATED, { reqId: message.reqId }));
      return;
    }
    let response: ServerMessage;
    switch (message.type) {
      case 'group.create':
        response = await groups.create(session, message);
        break;
      case 'group.join':
        response = await groups.join(session, message);
        break;
      case 'position.update':
        response = await groups.update(session, message);
        break;
      case 'group.resume':
        response = await groups.resume(session, message);
        break;
      case 'group.end':
        response = await groups.end(session, message);
        break;
      case 'group.leave':
        response = await groups.leave(session, message);
        break;
    }
    this.reply(withReqId(response, message.reqId));
  }

  private reply(message: ServerMessage): void {
    this.sendMessage(message);
  }

  private sendMessage(message: ServerMessage): void {
    this.transmit(JSON.stringify(message));
  }

  /** Every outbound frame goes through here: readyState and buffer checks (H2, H4). */
  private transmit(text: string): void {
    if (sendSerialized(this.ws, text, this.deps.maxBufferedBytes) === 'terminated') {
      this.deps.logger.warn(
        { event: 'slow_consumer_terminated', namespace: this.session?.app.namespace },
        'outbound buffer limit exceeded',
      );
    }
  }

  private rejectHandshake(error: ErrorMessage, closeCode: number): void {
    this.state = 'closing';
    clearTimeout(this.handshakeTimer);
    this.sendMessage(error);
    this.ws.close(closeCode, error.code);
  }

  private onHandshakeTimeout(): void {
    if (this.closed || this.state !== 'awaiting_hello') return;
    this.deps.logger.info({ event: 'handshake_timeout' }, 'handshake timeout');
    this.rejectHandshake(errorMessage(ErrorCode.HANDSHAKE_TIMEOUT), CloseCode.HANDSHAKE_TIMEOUT);
  }

  private onClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    this.deps.counter.closed(this.session?.app.namespace);
    this.deps.logger.debug({ event: 'ws_closed', code }, 'websocket closed');
    const session = this.session;
    const groups = this.deps.groups;
    if (session) {
      // Through the same queue, so it runs after any in-flight handler.
      this.enqueue(() => groups.disconnect(session));
    }
    this.deps.onClosed(this);
  }
}

function withReqId(message: ServerMessage, reqId: string | undefined): ServerMessage {
  if (reqId === undefined || !canCarryReqId(message)) return message;
  return { ...message, reqId } as ServerMessage;
}

function canCarryReqId(message: ServerMessage): boolean {
  return (
    message.type === 'error' ||
    message.type === 'group.created' ||
    message.type === 'group.joined' ||
    message.type === 'position.ack' ||
    message.type === 'hello.ok' ||
    message.type === 'group.resumed' ||
    message.type === 'group.ended' ||
    message.type === 'group.left'
  );
}
