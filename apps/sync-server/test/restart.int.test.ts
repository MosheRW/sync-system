import { codesOf } from './helpers/groups.js';
import { describe, expect, it } from 'vitest';
import { startTestServer } from './helpers/test-server.js';

describe('in-memory only (AC16)', () => {
  it('forgets every group after a restart', async () => {
    const first = await startTestServer();
    const leader = await first.connectReady();
    leader.send({ type: 'group.create', metadata: { contentId: 'c' }, position: 1 });
    const { codes } = await leader.next('group.created');
    await first.close();

    const second = await startTestServer();
    try {
      const member = await second.connectReady();
      member.send({ type: 'group.joinByCode', ...codesOf(codes) });
      expect(await member.next('error')).toMatchObject({ code: 'CODE_NOT_FOUND' });
    } finally {
      await second.close();
    }
  });
});
