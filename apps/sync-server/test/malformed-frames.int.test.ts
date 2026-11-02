import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FrameOptions, Opcode, RawClient, encodeFrame } from './helpers/raw-client.js';
import { KEY_A, type TestServer, httpGet, startTestServer } from './helpers/test-server.js';
import { transportMaxPayload } from '../src/limits/constants.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.close();
});

const HELLO = { type: 'hello', protocolVersion: 1, appVersion: '1.0.0', apiKey: KEY_A };
const MAX_PAYLOAD = transportMaxPayload(16384);

async function readyRaw(): Promise<RawClient> {
  const raw = await RawClient.connect(ts.port);
  await raw.waitForType('welcome');
  raw.sendJson(HELLO);
  await raw.waitForType('hello.ok');
  return raw;
}

/** After each bad frame: /health is 200 and a normal client can create and update. */
async function expectServerHealthy(): Promise<void> {
  expect((await httpGet(ts.port, '/health')).status).toBe(200);
  const client = await ts.connectReady();
  client.send({ type: 'group.create', metadata: {} });
  await client.next('group.created');
  client.send({ type: 'position.update', position: 1 });
  await client.next('position.ack');
  await client.close();
}

const PROTOCOL_VIOLATIONS: Array<{ name: string; frames: () => Buffer; closeCode?: number }> = [
  {
    name: '(a) text frame with invalid UTF-8',
    frames: () => encodeFrame({ opcode: Opcode.TEXT, payload: Buffer.from([0x7b, 0xff, 0xfe]) }),
    closeCode: 1007,
  },
  {
    name: '(b) RSV1 bit set without an extension',
    frames: () => encodeFrame({ opcode: Opcode.TEXT, payload: Buffer.from('{}'), rsv1: true }),
    closeCode: 1002,
  },
  {
    name: '(c) close frame with the invalid code 1005',
    frames: () => {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1005);
      return encodeFrame({ opcode: Opcode.CLOSE, payload });
    },
    closeCode: 1002,
  },
  {
    name: '(d) length header over maxPayload',
    frames: () =>
      encodeFrame({
        opcode: Opcode.TEXT,
        payload: Buffer.alloc(0),
        declaredLength: MAX_PAYLOAD + 1,
      } satisfies FrameOptions),
    closeCode: 1009,
  },
  {
    name: '(e) unmasked client frame',
    frames: () => encodeFrame({ opcode: Opcode.TEXT, payload: Buffer.from('{}'), mask: false }),
    closeCode: 1002,
  },
  {
    name: '(f) truncated frame followed by socket end',
    frames: () =>
      encodeFrame({ opcode: Opcode.TEXT, payload: Buffer.from('{"type":"hello"}') }).subarray(0, 8),
  },
];

describe('protocol violations never crash the server (H4)', () => {
  for (const violation of PROTOCOL_VIOLATIONS) {
    for (const phase of ['before', 'after'] as const) {
      it(`${violation.name}, ${phase} the handshake`, async () => {
        const raw = phase === 'before' ? await RawClient.connect(ts.port) : await readyRaw();
        raw.writeRaw(violation.frames());
        if (violation.closeCode === undefined) raw.end();
        await raw.closed();
        if (violation.closeCode !== undefined) expect(raw.closeCode).toBe(violation.closeCode);
        await expectServerHealthy();
      });
    }
  }
});

describe('invalid content is answered, not fatal (H4, M4)', () => {
  it('(g) binary frame gives INVALID_MESSAGE and the socket stays usable', async () => {
    const raw = await readyRaw();
    raw.writeFrame({ opcode: Opcode.BINARY, payload: Buffer.from('{"type":"group.create"}') });
    await raw.waitFor((m) => (m as { code?: string }).code === 'INVALID_MESSAGE');
    raw.sendJson({ type: 'group.create', metadata: {} });
    await raw.waitForType('group.created');
    raw.destroy();
    await expectServerHealthy();
  });

  it('(h) invalid JSON gives INVALID_MESSAGE', async () => {
    const raw = await readyRaw();
    raw.sendText('{"type": "group.create", metadata: }');
    await raw.waitFor((m) => (m as { code?: string }).code === 'INVALID_MESSAGE');
    expect(raw.ended).toBe(false);
    raw.destroy();
    await expectServerHealthy();
  });

  it('(i) nesting 10,000 deep gives INVALID_MESSAGE without a stack overflow', async () => {
    const raw = await readyRaw();
    const depth = 10_000;
    raw.sendText(`{"type":"position.update","position":${'['.repeat(depth)}${']'.repeat(depth)}}`);
    await raw.waitFor((m) => (m as { code?: string }).code === 'INVALID_MESSAGE');
    expect(raw.ended).toBe(false);
    raw.destroy();
    await expectServerHealthy();
  });

  it('closes with 4001 on binary, invalid JSON or deep frames before the handshake', async () => {
    const payloads: Array<() => Buffer> = [
      () => encodeFrame({ opcode: Opcode.BINARY, payload: Buffer.from('x') }),
      () => encodeFrame({ opcode: Opcode.TEXT, payload: Buffer.from('{oops') }),
      () =>
        encodeFrame({
          opcode: Opcode.TEXT,
          payload: Buffer.from('['.repeat(10_000) + ']'.repeat(10_000)),
        }),
    ];
    for (const frame of payloads) {
      const raw = await RawClient.connect(ts.port);
      raw.writeRaw(frame());
      await raw.closed();
      expect(raw.closeCode).toBe(4001);
    }
    await expectServerHealthy();
  });
});
