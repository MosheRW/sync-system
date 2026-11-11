import type { Page } from '@playwright/test';
import {
  BOOK_PATH,
  type Codes,
  cutLeader,
  expect,
  groupButton,
  indicatorIs,
  readerUrl,
  report,
  startGroup,
  test,
} from './helpers/fixtures.js';

/**
 * Handoff, take-back and preview against the real sync server (#25 AC59,
 * architecture 13.2): the lifecycle stack (5 s grace, `auto` handoff). The
 * leader reads through the stack's TCP proxy; the vice and the member are
 * direct. Desktop viewport (>= 1024 px), so the roster list shows. No
 * retries: flaky timing is a bug.
 */

/** Joins with method A and a chosen name from an open book page. */
async function join(page: Page, codes: Codes, name: string): Promise<void> {
  await groupButton(page).click();
  await page.getByRole('button', { name: 'Join a group' }).click();
  await page.getByRole('textbox', { name: 'Code' }).fill(codes.groupCode);
  await page.getByRole('textbox', { name: /^Your name/ }).fill(name);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('textbox', { name: 'Door code' }).fill(codes.doorCode);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await indicatorIs(page, 'Following');
}

const pageCounter = (page: Page, text: string) => page.getByText(text, { exact: true });
/** A banner's text in the reading column (the live region repeats it, hidden). */
const notice = (page: Page, text: string) => page.getByRole('main').getByText(text);

test('handoff to the vice, take-back and preview (AC59)', async ({ pages }) => {
  test.setTimeout(120_000);
  const started = Date.now();

  // 1. The leader starts a group; the vice and a member join.
  const leader = await pages.open();
  await leader.goto(`${readerUrl(true, 'lifecycle')}${BOOK_PATH}`);
  const codes = await startGroup(leader);
  await leader.getByRole('button', { name: 'Start reading' }).click();
  await indicatorIs(leader, 'Leading');
  const vice = await pages.open();
  await vice.goto(`${readerUrl(false, 'lifecycle')}${BOOK_PATH}`);
  await join(vice, codes, 'Vicky');
  const member = await pages.open();
  await member.goto(`${readerUrl(false, 'lifecycle')}${BOOK_PATH}`);
  await join(member, codes, 'Moshe');

  // 2. The leader makes the vice from the roster.
  const panel = leader.getByRole('complementary', { name: 'Your group' });
  const people = panel.getByRole('region', { name: 'People (3)' });
  await people.getByRole('button', { name: /^Vicky/ }).click();
  await people.getByRole('button', { name: 'Make vice-leader' }).click();
  await expect(people.getByRole('button', { name: /^Vicky/ })).toContainText('Vice-leader');
  await expect(notice(vice, "You're the vice-leader.")).toBeVisible();

  // 3. Preview doesn't move a member; Bring group here does.
  await panel.getByRole('button', { name: 'Preview pages' }).click();
  await indicatorIs(leader, 'Previewing');
  await leader.keyboard.press('ArrowRight');
  await leader.keyboard.press('ArrowRight');
  await expect(pageCounter(leader, '3 / 3')).toBeVisible();
  const previewStill = Date.now();
  await leader.waitForTimeout(3_000);
  await expect(pageCounter(member, '1 / 3')).toBeVisible();
  await expect(member.getByRole('region', { name: 'Group page' })).toHaveCount(0);
  report('preview_member_still', Date.now() - previewStill);
  const bring = Date.now();
  await leader
    .getByRole('region', { name: 'Preview' })
    .getByRole('button', {
      name: 'Bring group here',
    })
    .click();
  await expect(pageCounter(member, '3 / 3')).toBeVisible({ timeout: 2_000 });
  report('bring_group_here', Date.now() - bring);
  await expect(pageCounter(vice, '3 / 3')).toBeVisible();

  // 4. The leader's connection drops for 12 s (> 5 s grace + reconnect slack).
  const cutAt = Date.now();
  const cut = cutLeader(12_000, 'lifecycle');

  // 5. The vice leads: the dialog says why; Esc dismisses it (AC52, keyboard).
  const dialog = vice.getByRole('alertdialog', { name: "You're leading the group now" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  report('handoff_to_vice', Date.now() - cutAt);
  await expect(dialog).toContainText('The leader lost connection, so the lead passed to you.');
  await vice.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await indicatorIs(vice, 'Leading');

  // 6. The member is told, then follows the vice.
  await expect(
    notice(member, 'The leader lost connection, so someone else is leading now.'),
  ).toBeVisible();
  await vice.keyboard.press('ArrowLeft');
  await expect(pageCounter(member, '2 / 3')).toBeVisible();

  // 7. The original leader comes back as a member, is told, and takes the lead back.
  await cut;
  const back = Date.now();
  await expect(
    notice(leader, 'You were away too long, so someone else is leading now.'),
  ).toBeVisible({ timeout: 20_000 });
  const card = leader.getByRole('region', { name: 'Take the lead back' });
  await expect(card).toBeVisible();
  report('takeback_offered_after_reconnect', Date.now() - back);
  await card.getByRole('button', { name: 'Take the lead' }).click();
  const now = leader.getByRole('alertdialog', { name: "You're leading the group now" });
  await expect(now).toContainText('You took the lead back.');
  // It was on page 3 and the group is on page 2: it starts in preview (U7).
  await expect(now).toContainText("You're on page 3 and the group is on page 2.");
  await now.getByRole('button', { name: 'Start leading' }).click();
  await indicatorIs(leader, 'Previewing');
  await leader
    .getByRole('region', { name: 'Preview' })
    .getByRole('button', {
      name: 'Return to group',
    })
    .click();
  await indicatorIs(leader, 'Leading');
  await expect(pageCounter(leader, '2 / 3')).toBeVisible();
  await leader.keyboard.press('ArrowRight');
  await expect(pageCounter(member, '3 / 3')).toBeVisible();

  // The vice lost the lead to a take-back: told, and no take-back card (Q-A2).
  await expect(notice(vice, 'The previous leader took the lead back.')).toBeVisible();
  await indicatorIs(vice, 'Following');
  await expect(vice.getByRole('region', { name: 'Take the lead back' })).toHaveCount(0);

  report('lifecycle_total', Date.now() - started);
});
