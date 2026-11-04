import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestClient } from './helpers/test-client.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';
import { type JoinFields, codesOf } from './helpers/groups.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.close();
});

/** Raw JSON text so keys like __proto__ are real own keys, as on the wire. */
const PAYLOADS: Array<[string, string]> = [
  ['nested objects and arrays', '{"a":{"b":[1,{"c":[true,false,null]}]},"d":[[[]]]}'],
  ['unicode and RTL text', '{"he":"שלום עולם","ar":"مرحبا","mixed":"abc אבג 123"}'],
  ['emoji', '{"e":"📖👍🏽👨‍👩‍👧","k📚":"v"}'],
  ['numbers', '{"int":42,"neg":-7,"float":3.25,"exp":1e21,"zero":0,"big":9007199254740991}'],
  ['booleans and null', '{"t":true,"f":false,"n":null}'],
  ['null', 'null'],
  ['a bare string', '"just a string"'],
  ['a number', '12.5'],
  ['false', 'false'],
  ['an array', '[1,"two",{"three":3},[4]]'],
  ['an empty object', '{}'],
  [
    'keys named like protocol fields',
    '{"type":"group.ended","groupId":"x","reqId":"y","position":{"type":"error"},"code":"NOT_LEADER"}',
  ],
  [
    '__proto__ and constructor keys',
    '{"__proto__":{"polluted":true},"constructor":{"prototype":1}}',
  ],
  ['escaped characters', '{"q":"\\"quoted\\"","nl":"a\\nb","tab":"\\t","u":"\\u0000\\u2028"}'],
];

/** Metadata without contentId, fingerprint or schemaVersion, plus odd keys. */
const METADATA_TEXT =
  '{"anything":"goes","__proto__":{"x":1},"constructor":"c","nested":{"type":"hello"}}';

function frame(type: string, fields: Record<string, string>): string {
  const parts = [`"type":${JSON.stringify(type)}`];
  for (const [key, json] of Object.entries(fields)) parts.push(`${JSON.stringify(key)}:${json}`);
  return `{${parts.join(',')}}`;
}

/**
 * Deep equality as JSON, including key order. (Vitest's structural equality
 * treats an own "__proto__" key specially, so compare serializations.)
 */
function expectSameJson(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(typeof actual).toBe(typeof expected);
}

function nested(depth: number): string {
  return '['.repeat(depth) + ']'.repeat(depth);
}

async function setup(): Promise<{
  leader: TestClient;
  member: TestClient;
  groupId: string;
  join: JoinFields;
}> {
  const leader = await ts.connectReady();
  leader.sendRaw(frame('group.create', { metadata: METADATA_TEXT }));
  const { groupId, codes } = await leader.next('group.created');
  const join = codesOf(codes);
  const member = await ts.connectReady();
  member.send({ type: 'group.joinByCode', ...join });
  const joined = await member.next('group.joined');
  expectSameJson(joined.metadata, JSON.parse(METADATA_TEXT));
  return { leader, member, groupId, join };
}

describe('opaque payloads (AC14)', () => {
  it('stores and relays metadata unchanged, without required fields', async () => {
    const { member } = await setup();
    expect(member.isClosed).toBe(false);
  });

  for (const [name, json] of PAYLOADS) {
    it(`round-trips ${name} through create, update and join`, async () => {
      const expected: unknown = JSON.parse(json);

      // Initial position on create, read back through join.
      const creator = await ts.connectReady();
      creator.sendRaw(frame('group.create', { metadata: '{}', position: json }));
      const { groupId: createdId, codes } = await creator.next('group.created');
      const joiner = await ts.connectReady();
      joiner.send({ type: 'group.joinByCode', ...codesOf(codes) });
      const joined = await joiner.next('group.joined');
      expect(joined).toMatchObject({ groupId: createdId, role: 'member', hasPosition: true });
      expectSameJson(joined.hasPosition && joined.position, expected);

      // Update relayed to a member, then read back by a late joiner.
      const { leader, member, join } = await setup();
      leader.sendRaw(frame('position.update', { position: json }));
      await leader.next('position.ack');
      const updated = await member.next('position.updated');
      expectSameJson(updated.position, expected);

      const late = await ts.connectReady();
      late.send({ type: 'group.joinByCode', ...join });
      const lateJoined = await late.next('group.joined');
      expect(lateJoined.hasPosition).toBe(true);
      expectSameJson(lateJoined.hasPosition && lateJoined.position, expected);
    });
  }

  it('keeps __proto__ as an own key on the receiving side (L6)', async () => {
    const { leader, member } = await setup();
    leader.sendRaw(frame('position.update', { position: '{"__proto__":{"polluted":"yes"}}' }));
    await leader.next('position.ack');
    const updated = await member.next('position.updated');
    const position = updated.position as Record<string, unknown>;
    expect(Object.keys(position)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts a frame nested 64 levels deep in total', async () => {
    const { leader, member } = await setup();
    // Frame object (1) + 63 nested arrays = depth 64.
    leader.sendRaw(frame('position.update', { position: nested(63) }));
    await leader.next('position.ack');
    const updated = await member.next('position.updated');
    expectSameJson(updated.position, JSON.parse(nested(63)));
  });

  it('rejects a frame nested 65 levels deep with INVALID_MESSAGE', async () => {
    const { leader, member } = await setup();
    leader.sendRaw(frame('position.update', { position: nested(64) }));
    expect(await leader.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    await member.expectNoMessage();
  });
});
