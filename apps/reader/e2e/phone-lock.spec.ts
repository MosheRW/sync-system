import {
  BOOK_PATH,
  expect,
  indicatorIs,
  joinWithCodes,
  readerUrl,
  startGroup,
  test,
} from './helpers/fixtures.js';

/** Drops the leader's connection (through the TCP proxy) for `ms` (Gate 2 Q-A3: 25 s). */
async function cutLeader(ms: number): Promise<void> {
  const control = process.env['E2E_PROXY_CONTROL'];
  if (control === undefined) throw new Error('global setup did not run');
  const response = await fetch(`${control}/cut/${ms}`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

test('a leader whose phone locks for 25 s comes back still leading, with no prompt (AC35)', async ({
  pages,
}) => {
  test.setTimeout(120_000);
  const leader = await pages.open();
  await leader.goto(`${readerUrl(true)}${BOOK_PATH}`);
  const codes = await startGroup(leader);
  await leader.getByRole('button', { name: 'Start reading' }).click();
  await indicatorIs(leader, 'Leading');

  const member = await pages.open();
  await member.goto(`${readerUrl()}${BOOK_PATH}`);
  await joinWithCodes(member, codes);

  const cut = cutLeader(25_000);
  // Members see the leader is away, with the grace counted down (AC30, AC53).
  await expect(
    member.getByRole('button', {
      name: /^(Waiting for leader · \d+:\d\d|Leader offline), group options$/,
    }),
  ).toBeVisible({
    timeout: 10_000,
  });
  await cut;

  await indicatorIs(leader, 'Leading', 20_000);
  await indicatorIs(member, 'Following', 20_000);
  await expect(leader.getByRole('dialog')).toHaveCount(0);
  await expect(leader.getByRole('alertdialog')).toHaveCount(0);
  await expect(leader.getByRole('img', { name: /^Group code:/ }).first()).toBeVisible();
  // Still the leader: the member follows its next move.
  await leader.keyboard.press('ArrowRight');
  await expect(member.getByText('2 / 3', { exact: true })).toBeVisible();
});
