import type { JsonObject, JsonValue } from '@sync-system/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { type RealServer, startRealServer } from '../helpers/real-server.js';

let server: RealServer;

beforeAll(async () => {
  server = await startRealServer();
});

afterEach(() => {
  closeClients();
});

afterAll(async () => {
  await server.close();
});

describe('opaque passthrough (AC20)', () => {
  it('metadata and positions arrive deep-equal, extra fields and __proto__ keys included', async () => {
    const metadata = JSON.parse(
      '{"book":"קריאה","n":[1,[2,[3,null]]],"extra":{"emoji":"📖","flag":false},"__proto__":{"x":1}}',
    ) as JsonObject;
    const initial = JSON.parse(
      '{"page":1,"__proto__":{"polluted":true},"deep":[[[{"a":null}]]]}',
    ) as JsonValue;
    const update = JSON.parse(
      '{"page":2,"unknownField":"kept","nested":{"list":[1.5,0,"é"]},"__proto__":{"y":2}}',
    ) as JsonValue;

    const { client: leader } = newClient(server.url);
    const { client: member } = newClient(server.url);
    await leader.connect();
    await member.connect();
    const { groupId } = await leader.createGroup(metadata, initial);
    const joined = await member.joinGroup(groupId);
    expect(joined.metadata).toStrictEqual(metadata);
    expect(joined.position).toStrictEqual(initial);
    expect(Object.hasOwn(joined.metadata, '__proto__')).toBe(true);

    const received = nextEvent(member, 'positionUpdated');
    leader.updatePosition(update);
    const event = await received;
    expect(event.position).toStrictEqual(update);
    expect(member.getSnapshot().group).toMatchObject({ position: update });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
