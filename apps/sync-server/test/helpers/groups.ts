import type { TestClient } from './test-client.js';
import type { TestServer } from './test-server.js';
import { KEY_A } from './test-server.js';

export interface TestGroup {
  groupId: string;
  leader: TestClient;
  members: TestClient[];
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
  const { groupId } = await leader.next('group.created');
  const members: TestClient[] = [];
  for (let i = 0; i < memberCount; i++) {
    const member = await ts.connectReady(apiKey);
    member.send({ type: 'group.join', groupId });
    await member.next('group.joined');
    members.push(member);
  }
  return { groupId, leader, members };
}
