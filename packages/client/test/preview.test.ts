import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADER_ACTIVITY_MIN_INTERVAL_MS, LeaderPreview } from '../src/preview.js';
import { CREATED_FIELDS, connectedClient } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken } from './helpers/tokens.js';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

function host(leader = true) {
  const sent: unknown[] = [];
  let activities = 0;
  let position: unknown = { page: 1 };
  return {
    sent,
    activities: () => activities,
    host: {
      isLeader: () => leader,
      groupPosition: () => position as never,
      updatePosition: (p: unknown) => {
        sent.push(p);
        position = p;
      },
      sendActivity: () => {
        activities += 1;
        return Promise.resolve();
      },
    },
  };
}

describe('LeaderPreview (#13 AC41, AC30)', () => {
  it('never sends a position while previewing; throttles leader activity', () => {
    const fake = host();
    const preview = new LeaderPreview(fake.host);
    preview.start();
    expect(preview.getState()).toEqual({
      active: true,
      groupPosition: { page: 1 },
      previewPosition: { page: 1 },
    });
    for (let page = 2; page < 10; page++) preview.move({ page });
    expect(fake.sent).toEqual([]);
    expect(fake.activities()).toBe(1);
    vi.advanceTimersByTime(LEADER_ACTIVITY_MIN_INTERVAL_MS);
    preview.move({ page: 11 });
    expect(fake.activities()).toBe(2);
    expect(preview.getState().previewPosition).toEqual({ page: 11 });
  });

  it('bringGroupHere sends one normal update; returnToGroup moves nothing', () => {
    const fake = host();
    const preview = new LeaderPreview(fake.host);
    preview.start();
    preview.move({ page: 5 });
    expect(preview.returnToGroup()).toEqual({ page: 1 });
    expect(fake.sent).toEqual([]);
    preview.start();
    preview.move({ page: 7 });
    preview.bringGroupHere();
    expect(fake.sent).toEqual([{ page: 7 }]);
    expect(preview.getState()).toMatchObject({ active: false, groupPosition: { page: 7 } });
  });

  it('sends no activity while not leading', () => {
    const fake = host(false);
    const preview = new LeaderPreview(fake.host);
    preview.start();
    preview.move({ page: 2 });
    expect(fake.activities()).toBe(0);
  });

  it('on a real client: leader.activity frames only, never position.update', async () => {
    const { client, socket } = await connectedClient();
    const creating = client.createGroup({}, { page: 1 });
    socket.receive({
      type: 'group.created',
      handoff: 'auto',
      displayName: 'Guest 1',
      generated: true,
      state: { blockList: [], locked: false, handoff: 'auto' },
      ...CREATED_FIELDS,
      reqId: socket.lastMessage().reqId,
      groupId: 'G'.repeat(43),
      participantId: 'p',
      role: 'leader',
      token: fakeToken({ gid: 'G'.repeat(43) }),
    });
    await creating;
    const before = socket.sent.length;
    client.preview.start();
    client.preview.move({ page: 3 });
    const types = socket.sent.slice(before).map((t) => (JSON.parse(t) as { type: string }).type);
    expect(types).toEqual(['leader.activity']);
    expect(JSON.stringify(socket.sent.slice(before))).not.toContain('page');
    client.close();
  });
});
