import type { JoinCodesPayload, ServerMessage } from '@sync-system/protocol';
import type { TestClient } from './test-client.js';
import type { TestServer } from './test-server.js';
import { KEY_A } from './test-server.js';

/** The fields of a `group.joinByCode` that admit to a group with these codes. */
export interface JoinFields {
  joinCode: string;
  doorCode?: string;
}

export interface TestGroup {
  groupId: string;
  leader: TestClient;
  members: TestClient[];
  /** The leader's token from group.created. */
  leaderToken: string;
  /** Each member's token from group.joined, in join order. */
  memberTokens: string[];
  /** Each member's group-scoped participant ID, in join order. */
  memberIds: string[];
  leaderId: string;
  /** The group's join codes from group.created (#10). */
  codes: JoinCodesPayload;
  /** Spread into a `group.joinByCode` frame to join this group. */
  join: JoinFields;
}

/**
 * The `group.joinByCode` fields for a set of codes (#10 D11): the group code
 * plus door code (method A), else the group code (B), else the alphanumeric
 * code (C).
 */
export function codesOf(codes: JoinCodesPayload): JoinFields {
  if (codes.groupCode !== undefined) {
    return codes.doorCode === undefined
      ? { joinCode: codes.groupCode }
      : { joinCode: codes.groupCode, doorCode: codes.doorCode };
  }
  if (codes.alphaCode !== undefined) return { joinCode: codes.alphaCode };
  throw new Error('the group has no join code (method D only)');
}

/**
 * A new connection (default app A) that joins by code (#10 D11); returns it
 * with the reply.
 */
export async function joinByCode(
  ts: TestServer,
  created: { codes: JoinCodesPayload },
  options: { apiKey?: string; reqId?: string; extra?: Record<string, unknown> } = {},
): Promise<{ client: TestClient; reply: ServerMessage }> {
  const client = await ts.connectReady(options.apiKey ?? KEY_A);
  const message: Record<string, unknown> = {
    type: 'group.joinByCode',
    ...codesOf(created.codes),
    ...options.extra,
  };
  if (options.reqId !== undefined) message.reqId = options.reqId;
  client.send(message);
  return { client, reply: await client.next() };
}

/** Creates a group as a new leader and joins `memberCount` new members by code. */
export async function createGroupWithMembers(
  ts: TestServer,
  memberCount: number,
  options: { apiKey?: string; metadata?: unknown; position?: unknown; joinMethods?: string[] } = {},
): Promise<TestGroup> {
  const apiKey = options.apiKey ?? KEY_A;
  const leader = await ts.connectReady(apiKey);
  const create: Record<string, unknown> = {
    type: 'group.create',
    metadata: options.metadata ?? { contentId: 'c' },
  };
  if ('position' in options) create.position = options.position;
  if (options.joinMethods !== undefined) create.joinMethods = options.joinMethods;
  leader.send(create);
  const created = await leader.next('group.created');
  const { groupId } = created;
  const join = codesOf(created.codes);
  const members: TestClient[] = [];
  const memberTokens: string[] = [];
  const memberIds: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const member = await ts.connectReady(apiKey);
    member.send({ type: 'group.joinByCode', ...join });
    const joined = await member.next('group.joined');
    members.push(member);
    memberTokens.push(joined.token);
    memberIds.push(joined.participantId);
  }
  return {
    groupId,
    leader,
    members,
    leaderToken: created.token,
    leaderId: created.participantId,
    memberTokens,
    memberIds,
    codes: created.codes,
    join,
  };
}

/** A new connection (default app A) that sends group.resume; returns it with the reply. */
export async function resumeWith(
  ts: TestServer,
  token: unknown,
  extra: Record<string, unknown> = {},
  apiKey = KEY_A,
): Promise<{ client: TestClient; reply: ServerMessage }> {
  const client = await ts.connectReady(apiKey);
  client.send({ type: 'group.resume', token, ...extra });
  return { client, reply: await client.next() };
}
