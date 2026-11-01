import { randomBytes } from 'node:crypto';
import net from 'node:net';

/**
 * A raw TCP WebSocket client for tests. It performs the HTTP upgrade by hand
 * and writes hand-built frames, so tests can send what a well-behaved client
 * library never would: unmasked frames, RSV bits, invalid UTF-8, bad close
 * codes, oversized length headers. It can also stop reading (`pause()`) to
 * simulate a slow consumer.
 */

export const Opcode = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface FrameOptions {
  opcode: number;
  payload?: Buffer;
  fin?: boolean;
  /** Client frames must be masked; set false to send an illegal unmasked frame. */
  mask?: boolean;
  rsv1?: boolean;
  /** Declare this payload length in the header instead of the real one. */
  declaredLength?: number;
}

export function encodeFrame(options: FrameOptions): Buffer {
  const payload = options.payload ?? Buffer.alloc(0);
  const fin = options.fin ?? true;
  const mask = options.mask ?? true;
  const length = options.declaredLength ?? payload.length;

  const first = (fin ? 0x80 : 0) | (options.rsv1 ? 0x40 : 0) | (options.opcode & 0x0f);
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([first, (mask ? 0x80 : 0) | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  if (!mask) return Buffer.concat([header, payload]);

  const key = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i]! ^ key[i % 4]!;
  }
  return Buffer.concat([header, key, masked]);
}

export interface DecodedFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
}

/** Decodes as many complete unmasked (server) frames as `buffer` holds. */
export function decodeFrames(buffer: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const total = headerLength + maskLength + length;
    if (buffer.length - offset < total) break;
    let payload = buffer.subarray(offset + headerLength + maskLength, offset + total);
    if (masked) {
      const key = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]!));
    }
    frames.push({ opcode: first & 0x0f, fin: (first & 0x80) !== 0, payload: Buffer.from(payload) });
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export interface UpgradeResult {
  /** HTTP status code of the response to the upgrade request. */
  status: number;
  /** Set when status is 101. */
  client?: RawClient;
}

export interface RawUpgradeOptions {
  path?: string;
  headers?: Record<string, string>;
  host?: string;
  timeoutMs?: number;
}

export class RawClient {
  readonly messages: unknown[] = [];
  closeCode: number | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private readonly endPromise: Promise<void>;
  ended = false;
  /** Answer server pings automatically (set false to simulate a dead peer). */
  autoPong = true;

  private constructor(
    readonly socket: net.Socket,
    initial: Buffer,
  ) {
    this.endPromise = new Promise((resolve) => {
      socket.on('close', () => {
        this.ended = true;
        this.notify();
        resolve();
      });
    });
    socket.on('error', () => {
      // Expected when the server destroys the socket.
    });
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    if (initial.length > 0) this.onData(initial);
  }

  /** Performs the HTTP upgrade by hand. Resolves with the response status. */
  static upgrade(port: number, options: RawUpgradeOptions = {}): Promise<UpgradeResult> {
    const path = options.path ?? '/ws';
    const host = options.host ?? '127.0.0.1';
    return new Promise((resolve, reject) => {
      const socket = net.connect({ port, host });
      let response = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('raw upgrade timed out'));
      }, options.timeoutMs ?? 3000);

      const finish = (result: UpgradeResult) => {
        clearTimeout(timer);
        resolve(result);
      };

      socket.on('error', () => {
        // A refused or reset upgrade is reported through `close` below.
      });
      socket.on('close', () => {
        if (response.length === 0) finish({ status: 0 });
      });
      socket.on('connect', () => {
        const headers = {
          Host: `${host}:${port}`,
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
          ...options.headers,
        };
        const lines = [`GET ${path} HTTP/1.1`];
        for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
        socket.write(lines.join('\r\n') + '\r\n\r\n');
      });

      const onData = (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        const end = response.indexOf('\r\n\r\n');
        if (end === -1) return;
        socket.off('data', onData);
        const head = response.subarray(0, end).toString('latin1');
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
        const rest = response.subarray(end + 4);
        if (status !== 101) {
          socket.destroy();
          finish({ status });
          return;
        }
        const client = new RawClient(socket, rest);
        client.responseHead = head;
        finish({ status, client });
      };
      socket.on('data', onData);
    });
  }

  /** Upgrade and fail unless the server answers 101. */
  static async connect(port: number, options: RawUpgradeOptions = {}): Promise<RawClient> {
    const result = await RawClient.upgrade(port, options);
    if (!result.client) throw new Error(`expected 101, got ${result.status}`);
    return result.client;
  }

  /** Raw HTTP response head of the upgrade (status line and headers). */
  responseHead = '';

  writeFrame(options: FrameOptions): void {
    this.socket.write(encodeFrame(options));
  }

  writeRaw(data: Buffer): void {
    this.socket.write(data);
  }

  sendText(text: string | Buffer): void {
    this.writeFrame({
      opcode: Opcode.TEXT,
      payload: typeof text === 'string' ? Buffer.from(text, 'utf8') : text,
    });
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  /** Stop reading from the socket (simulates a client that does not read). */
  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  /** Resolves when the TCP connection is closed. */
  closed(): Promise<void> {
    return this.endPromise;
  }

  /** Waits until a message matching `predicate` was received. */
  async waitFor(predicate: (message: unknown) => boolean, timeoutMs = 2000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found !== undefined) return found;
      if (this.ended) throw new Error('connection ended before the message arrived');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for message');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  waitForType(type: string, timeoutMs = 2000): Promise<unknown> {
    return this.waitFor(
      (message) => (message as { type?: unknown } | null)?.type === type,
      timeoutMs,
    );
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === Opcode.TEXT) {
        try {
          this.messages.push(JSON.parse(frame.payload.toString('utf8')));
        } catch {
          this.messages.push(frame.payload.toString('utf8'));
        }
      } else if (frame.opcode === Opcode.CLOSE) {
        this.closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        // Complete the close handshake like a normal client would.
        if (this.socket.writable) {
          this.writeFrame({ opcode: Opcode.CLOSE, payload: frame.payload.subarray(0, 2) });
          this.socket.end();
        }
      } else if (frame.opcode === Opcode.PING && this.autoPong) {
        this.writeFrame({ opcode: Opcode.PONG, payload: frame.payload });
      }
    }
    if (frames.length > 0) this.notify();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
