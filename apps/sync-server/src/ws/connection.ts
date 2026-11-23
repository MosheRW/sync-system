import { StorageBusyError, StorageUnavailableError } from '../storage/errors.js';
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
} from '@mosherw/sync-system-protocol';
import { type RawData, WebSocket } from 'ws';
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
  /** Cap on queued, not yet handled inbound bytes per socket (#7 L3). */
  maxQueuedBytes: number;
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

/** Size of a received frame in bytes, without copying it (#7 L3). */
export function rawByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data.byteLength;
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
  /** Bytes of the queued frames, including the one being handled (#7 L3). */
  private queuedBytes = 0;
  private flooded = false;
  /**
   * The membership the request being handled started with (`null`: no
   * request in flight). A request that attached the session (join, resume)
   * has not sent its reply yet: frames for the new membership wait for it.
   */
  private requestMembership: Session['membership'] | null = null;
  /** Frames queued behind a reply, not sent yet: later frames queue too (order). */
  private heldFrames = 0;
  /** Their bytes: they count against `maxBufferedBytes` like sent ones (security S5). */
  private heldBytes = 0;
  /** True while a queued task (afterPending or a held frame) runs. */
  private draining = false;

  constructor(
    readonly ws: WebSocket,
    private readonly deps: ConnectionDeps,
  ) {
    deps.counter.opened();
    this.limiter = new InboundLimiter(deps.inbound.ratePerSecond, deps.inbound.burst, deps.now);

    // Without an 'error' listener, a protocol violation from the peer would
    // throw from the EventEmitter and crash the process (H4).
    ws.on('error', (err: NodeJS.ErrnoException) => {
      deps.logger.debug({ event: 'ws_error', err: safeErr(err) }, 'websocket error');
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
    // A token is taken for every frame before any parsing (H3). The byte cap
    // is checked before the frame is queued (#7 L3); a single legal frame is
    // at most maxPayload, so it always fits an empty queue.
    const size = rawByteLength(data);
    if (
      !this.limiter.take() ||
      this.queueLength >= MAX_QUEUED_MESSAGES ||
      this.queuedBytes + size > this.deps.maxQueuedBytes
    ) {
      this.closeFlooded();
      return;
    }
    this.queueLength += 1;
    this.queuedBytes += size;
    this.enqueue(async () => {
      try {
        await this.process(data, isBinary);
      } finally {
        this.queueLength -= 1;
        this.queuedBytes -= size;
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

  /** Queues a synchronous task; frames it delivers go out at once, in queue order. */
  private enqueueNow(task: () => void): void {
    this.enqueue(() => {
      this.draining = true;
      try {
        task();
      } finally {
        this.draining = false;
      }
      return Promise.resolve();
    });
  }

  /** Whether the request in flight attached the session to a (new) membership. */
  private attaching(): boolean {
    const now = this.session?.membership;
    return this.requestMembership !== null && now !== undefined && now !== this.requestMembership;
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
        this.requestMembership = this.session?.membership;
        try {
          await this.handleReady(message);
        } finally {
          this.requestMembership = null;
        }
      }
    } catch (err) {
      if (err instanceof StorageUnavailableError || err instanceof StorageBusyError) {
        // Redis is down (#35 ADR 0014), or another instance held the group
        // past the wait bound (12.4, Gate 2 Q-B4: this connection only):
        // nothing was stored; the client resumes later. Going away /
        // temporarily unavailable.
        this.deps.logger.info(
          {
            event:
              err instanceof StorageBusyError
                ? 'storage_busy_closed'
                : 'storage_unavailable_closed',
            type: message.type,
          },
          'closed: storage unavailable',
        );
        this.state = 'closing';
        this.ws.close(CloseCode.GOING_AWAY, 'temporarily unavailable');
        return;
      }
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
        { event: 'handshake_rejected', errorCode: result.code },
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
      isOpen: () => !this.closed,
      deliver: (text) => {
        if (this.draining || (this.heldFrames === 0 && !this.attaching())) {
          this.transmit(text);
          return;
        }
        // A group frame never goes out before the reply that attached the
        // session (#35 fix round 1): it waits in the queue, behind the reply.
        // Held frames count against the outbound buffer limit as if sent
        // (H2, security S5): over it, the socket is cut like a slow consumer.
        const bytes = Buffer.byteLength(text, 'utf8');
        if (
          this.ws.readyState === WebSocket.OPEN &&
          this.ws.bufferedAmount + this.heldBytes + bytes > this.deps.maxBufferedBytes
        ) {
          this.ws.terminate();
          this.deps.logger.warn(
            { event: 'slow_consumer_terminated', namespace: this.session?.app.namespace },
            'outbound buffer limit exceeded',
          );
          return;
        }
        this.heldFrames += 1;
        this.heldBytes += bytes;
        this.enqueueNow(() => {
          this.heldFrames -= 1;
          this.heldBytes -= bytes;
          this.transmit(text);
        });
      },
      close: (code, reason) => {
        if (this.closed || this.state === 'closing') return;
        this.state = 'closing';
        this.ws.close(code, reason);
      },
      afterPending: (task) => this.enqueueNow(task),
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
      // The client rejects an unsupported method locally (#10 AC4).
      joinMethods: [...app.joinMethods],
      limits: {
        maxGroupSize: app.maxGroupSize,
        maxLeaderUpdatesPerSecond: app.maxLeaderUpdatesPerSecond,
        maxMessageBytes: app.maxMessageBytes,
        maxSessionMinutes: app.maxSessionMinutes,
        qrTicketSeconds: app.qrTicketSeconds,
        approvalTimeoutSeconds: app.approvalTimeoutSeconds,
        inactivityLimitMinutes: app.inactivityLimitMinutes,
        disconnectGraceSeconds: app.disconnectGraceSeconds,
        keepAliveCountdownSeconds: app.keepAliveCountdownSeconds,
      },
      defaultHandoff: app.defaultHandoff,
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
      case 'group.joinByCode':
        response = await groups.joinByCode(session, message);
        break;
      case 'position.update':
        response = await groups.update(session, message);
        break;
      case 'group.resume':
        response = await groups.resume(session, message);
        break;
      case 'tokens.check':
        response = await groups.checkTokens(session, message);
        break;
      case 'blocklist.set':
        response = await groups.setBlockList(session, message);
        break;
      case 'group.end':
        response = await groups.end(session, message);
        break;
      case 'group.leave':
        response = await groups.leave(session, message);
        break;
      case 'codes.rotate':
        response = await groups.rotateCodes(session, message);
        break;
      case 'group.joinByQr':
        response = await groups.joinByQr(session, message);
        break;
      case 'qr.issue':
        response = await groups.issueQr(session, message);
        break;
      case 'join.cancel':
        response = await groups.cancelJoin(session, message);
        break;
      case 'join.approve':
        response = await groups.approveJoin(session, message);
        break;
      case 'join.deny':
        response = await groups.denyJoin(session, message);
        break;
      case 'vice.set':
        response = await groups.setVice(session, message);
        break;
      case 'vice.clear':
        response = await groups.clearVice(session, message);
        break;
      case 'group.lock':
      case 'group.unlock':
        response = await groups.setLock(session, message);
        break;
      case 'member.remove':
        response = await groups.removeMember(session, message);
        break;
      case 'leader.activity':
      case 'keepalive.ack':
        response = await groups.leaderActivity(session, message);
        break;
      case 'leader.takeBack':
        response = await groups.takeBack(session, message);
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
    this.deps.logger.debug({ event: 'ws_closed', closeCode: code }, 'websocket closed');
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
    message.type === 'group.waiting' ||
    message.type === 'tokens.result' ||
    message.type === 'group.ended' ||
    message.type === 'group.left' ||
    message.type === 'blocklist.ack' ||
    message.type === 'codes.updated' ||
    message.type === 'join.pending' ||
    message.type === 'join.decided' ||
    message.type === 'join.cancelled' ||
    message.type === 'qr.ticket' ||
    message.type === 'vice.updated' ||
    message.type === 'lock.changed' ||
    message.type === 'member.removed' ||
    message.type === 'activity.ack' ||
    message.type === 'leader.granted'
  );
}
