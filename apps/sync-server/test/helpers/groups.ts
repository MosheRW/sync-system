import type { ServerMessage } from '@sync-system/protocol';
import type { TestClient } from './test-client.js';
import type { TestServer } from './test-server.js';
import { KEY_A } from './test-server.js';

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
}

/** Creates a group as a new leader and joins `memberCount` new members. */
export async function createGroupWithMembers(
  ts: TestServer,
  memberCount: number,
  options: { apiKey?: string; metadata?: unknown; position?: unknown } = {},
): Promise<TestGroup> {
  const apiKey = options.apiKey ?? KEY_A;
  const leader = await ts.connectReady(apiKey);
  const create: Record<string, unknown> = {
    type: 'group.create',
    metadata: options.metadata ?? { contentId: 'c' },
  };
  if ('position' in options) create.position = options.position;
  leader.send(create);
  const created = await leader.next('group.created');
  const { groupId } = created;
  const members: TestClient[] = [];
  const memberTokens: string[] = [];
  const memberIds: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const member = await ts.connectReady(apiKey);
    member.send({ type: 'group.join', groupId });
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
