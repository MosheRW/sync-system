import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@sync-system/protocol';
import type { TokenSecrets } from '../src/config/token-secret.js';
import { createLogger, groupRef, participantRef } from '../src/logging/logger.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { LogCapture } from './helpers/log-capture.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';

const SENTINEL = {
  metadata: 'SENTINEL-TOKEN-METADATA-title',
  position: 'SENTINEL-TOKEN-POSITION-page-9',
};

const tokenSecrets: TokenSecrets = { current: randomBytes(32), source: 'env' };
const scheduler = new ManualScheduler();
/** Log captures of every server instance (one per restart). */
const captures: LogCapture[] = [];
/** Every token, participant ID and block-list entry seen during the flows. */
const secrets = new Set<string>();
/** Every frame any client received. */
const frames: ServerMessage[] = [];
const blockedId = randomUUID();
let ts: TestServer;

function collect(message: ServerMessage): ServerMessage {
  frames.push(message);
  const record = message as unknown as Record<string, unknown>;
  for (const key of ['token', 'participantId']) {
    if (typeof record[key] === 'string') secrets.add(record[key]);
  }
  if (message.type === 'tokens.result') {
    for (const result of message.results) if (result.token) secrets.add(result.token);
  }
  return message;
}

function allLogs(): string {
  return captures.map((capture) => capture.text).join('\n');
}

async function next(client: TestClient): Promise<ServerMessage> {
  return collect(await client.next());
}

beforeAll(async () => {
  // Restarts share one capture, so every process's logs are checked.
  const start = async () => {
    const server = await startTestServer({
      tokenSecrets,
      scheduler,
      logLevel: 'trace',
      env: { TOKEN_REFRESH_ACTIVITIES: '1', TOKEN_REFRESH_MIN_SECONDS: '1' },
    });
    captures.push(server.logs);
    return server;
  };
  ts = await start();
  const metadata = { title: SENTINEL.metadata };

  // Issue: create and join.
  const group = await createGroupWithMembers(ts, 2, { metadata, position: SENTINEL.position });
  for (const token of [group.leaderToken, ...group.memberTokens]) secrets.add(token);
  for (const id of [group.leaderId, ...group.memberIds]) secrets.add(id);
  secrets.add(blockedId);

  // Refresh.
  scheduler.advance(2_000);
  group.leader.send({ type: 'position.update', position: SENTINEL.position });
  // Reads the ack and the refreshed token, in whichever order they come.
  while (
    !frames.some((f) => f.type === 'position.ack') ||
    !frames.some((f) => f.type === 'token.refreshed')
  ) {
    await next(group.leader);
  }

  // Block list while live.
  group.leader.send({ type: 'blocklist.set', blockList: [blockedId, group.memberIds[1]!] });
  while ((await next(group.leader)).type !== 'blocklist.ack');
  await next(group.members[1]!);

  // Check: live, blocked, invalid.
  const checker = await ts.connectReady();
  checker.send({
    type: 'tokens.check',
    tokens: [group.leaderToken, group.memberTokens[1], 'garbage', group.leaderToken.slice(0, -2)],
  });
  await next(checker);

  // Rejections: forged, blocked resume.
  collect((await resumeWith(ts, `${group.leaderToken}x`)).reply);
  collect((await resumeWith(ts, group.memberTokens[1])).reply);

  // Live resume (replaced) and leader return.
  collect((await resumeWith(ts, group.memberTokens[0])).reply);
  await next(group.members[0]!);
  await group.leader.close();

  // Restart: park and recreation.
  await ts.close();
  ts = await start();
  const { client: parked, reply: waiting } = await resumeWith(ts, group.memberTokens[0]);
  collect(waiting);
  const { client: leader, reply: resumed } = await resumeWith(ts, group.leaderToken, {
    metadata,
    position: SENTINEL.position,
    blockList: [blockedId],
  });
  collect(resumed);
  await next(parked);

  // End.
  leader.send({ type: 'group.end' });
  await next(leader);
  await next(parked);
  checker.terminate();
});

afterAll(async () => {
  await ts.close();
});

describe('tokens and IDs never reach logs or errors (#5 AC10, R11, L7)', () => {
  it('ran the flows at trace level', () => {
    const events = captures.flatMap((capture) => capture.events());
    for (const event of ['group_waiting', 'group_resumed', 'block_list_set', 'group_ended']) {
      expect(events, event).toContain(event);
    }
    expect(frames.some((f) => f.type === 'token.refreshed')).toBe(true);
    expect(frames.some((f) => f.type === 'tokens.result')).toBe(true);
    expect(secrets.size).toBeGreaterThan(8);
  });

  it('logs no token, token segment, raw or hashed participant ID, block-list entry or payload', () => {
    const text = allLogs();
    for (const value of secrets) {
      expect(text.includes(value), 'raw value').toBe(false);
      for (const segment of value.split('.')) {
        if (segment.length >= 16) expect(text.includes(segment), 'token segment').toBe(false);
      }
      // L7: not even the ref of a group-scoped participant ID.
      expect(text.includes(participantRef(value)), 'participant ref').toBe(false);
    }
    expect(text).not.toContain(SENTINEL.metadata);
    expect(text).not.toContain(SENTINEL.position);
  });

  it('keeps group IDs as refs only', () => {
    const groupIds = new Set(frames.flatMap((f) => ('groupId' in f ? [f.groupId] : [])));
    for (const id of groupIds) {
      const text = allLogs();
      expect(text).not.toContain(id);
      expect(text).toContain(groupRef(id));
    }
  });

  it('puts no token, ID or block-list entry in any error frame', () => {
    const errors = frames.filter((f) => f.type === 'error');
    expect(errors.length).toBeGreaterThan(1);
    const text = JSON.stringify(errors);
    for (const value of secrets) expect(text.includes(value)).toBe(false);
  });

  it('redacts token-like keys as a second line of defense', () => {
    const capture = new LogCapture();
    const logger = createLogger({ level: 'info', destination: capture });
    logger.info(
      {
        token: 'T',
        tokens: ['T'],
        blockList: ['B'],
        participantId: 'P',
        secret: 'S',
        nested: { token: 'T', blockList: ['B'], participantId: 'P', secret: 'S', tokens: ['T'] },
      },
      'probe',
    );
    const record = capture.records()[0]!;
    expect(record).not.toHaveProperty('token');
    expect(record).not.toHaveProperty('tokens');
    expect(record).not.toHaveProperty('blockList');
    expect(record).not.toHaveProperty('participantId');
    expect(record).not.toHaveProperty('secret');
    expect(record.nested).toEqual({});
  });
});
