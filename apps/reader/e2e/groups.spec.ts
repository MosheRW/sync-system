import {
  BOOK_PATH,
  captureTickets,
  expect,
  groupButton,
  indicatorIs,
  joinWithCodes,
  readerUrl,
  report,
  startGroup,
  test,
} from './helpers/fixtures.js';

test.describe('join and follow against the real sync server (#24 AC56, AC25, AC17)', () => {
  test('QR deep link and code entry to following under 15 s; member update under 1 s', async ({
    pages,
  }) => {
    const leader = await pages.open();
    const tickets = captureTickets(leader);
    await leader.goto(`${readerUrl()}${BOOK_PATH}`);
    const codes = await startGroup(leader);
    // The ready view shows the QR (method D on by default): a ticket was issued.
    await expect(
      leader
        .getByRole('dialog', { name: 'Your group is ready' })
        .getByRole('img', { name: 'QR code to join this group' }),
    ).toBeVisible();
    await expect.poll(() => tickets.length).toBeGreaterThan(0);
    await leader.getByRole('button', { name: 'Start reading' }).click();
    await indicatorIs(leader, 'Leading');

    // A phone camera opening the leader's QR deep link (method D).
    const scanner = await pages.open();
    const link = `${readerUrl()}${BOOK_PATH}#t=${tickets.at(-1)!}`;
    const qrStart = Date.now();
    await scanner.goto(link);
    await indicatorIs(scanner, 'Following');
    const qrMs = Date.now() - qrStart;
    report('qr_link_to_following', qrMs);
    // The ticket left the address bar and the history entry (R3).
    expect(await scanner.evaluate(() => location.hash)).toBe('');
    expect(scanner.url()).not.toContain('#t=');

    // Typing the codes (method A), measured from the first submit.
    const typer = await pages.open();
    await typer.goto(`${readerUrl()}${BOOK_PATH}`);
    const codeMs = await joinWithCodes(typer, codes);
    report('code_submit_to_following', codeMs);

    // The leader turns the page: both members follow.
    const moveStart = Date.now();
    await leader.keyboard.press('ArrowRight');
    await Promise.all([
      expect(scanner.getByText('2 / 3', { exact: true })).toBeVisible({ timeout: 5_000 }),
      expect(typer.getByText('2 / 3', { exact: true })).toBeVisible({ timeout: 5_000 }),
    ]);
    const moveMs = Date.now() - moveStart;
    report('leader_move_to_members', moveMs);

    expect(qrMs).toBeLessThan(15_000);
    expect(codeMs).toBeLessThan(15_000);
    expect(moveMs).toBeLessThan(1_000);
  });

  test('reload: member and leader come back with the same role and no codes (AC34, AC36)', async ({
    pages,
  }) => {
    const leader = await pages.open();
    await leader.goto(`${readerUrl()}${BOOK_PATH}`);
    const codes = await startGroup(leader);
    await leader.getByRole('button', { name: 'Start reading' }).click();
    await leader.keyboard.press('ArrowRight');

    const member = await pages.open();
    await member.goto(`${readerUrl()}${BOOK_PATH}`);
    await joinWithCodes(member, codes);
    await expect(member.getByText('2 / 3', { exact: true })).toBeVisible();

    await member.reload();
    await indicatorIs(member, 'Following');
    await expect(member.getByText('2 / 3', { exact: true })).toBeVisible();
    await expect(member.getByRole('textbox')).toHaveCount(0);

    await leader.reload();
    await indicatorIs(leader, 'Leading');
    // Codes are back (panel on this desktop viewport, strip on phones).
    await expect(leader.getByRole('img', { name: /^Group code:/ }).first()).toBeVisible();
    await expect(leader.getByRole('dialog')).toHaveCount(0);
    // The group still works after both reloads.
    await leader.keyboard.press('ArrowRight');
    await expect(member.getByText('3 / 3', { exact: true })).toBeVisible();
  });

  test('keyboard only: start, join and leave (AC52)', async ({ pages }) => {
    const leader = await pages.open();
    await leader.goto(`${readerUrl()}${BOOK_PATH}`);
    await groupButton(leader).focus();
    await leader.keyboard.press('Enter');
    await expect(leader.getByRole('dialog', { name: 'Read together' })).toBeVisible();
    // Tab inside the modal reaches the actions; the page behind is inert.
    const start = leader.getByRole('button', { name: 'Start a group' });
    for (
      let i = 0;
      i < 4 && !(await start.evaluate((el) => el === document.activeElement));
      i += 1
    ) {
      await leader.keyboard.press('Tab');
    }
    await expect(start).toBeFocused();
    await leader.keyboard.press('Enter');
    await expect(leader.getByRole('checkbox', { name: 'Group code' })).toBeVisible();
    await leader.getByRole('button', { name: 'Start group' }).focus();
    await leader.keyboard.press('Enter');
    await expect(leader.getByRole('dialog', { name: 'Your group is ready' })).toBeVisible();
    await leader.keyboard.press('Escape');
    await expect(leader.getByRole('dialog')).toHaveCount(0);
    await expect(groupButton(leader)).toBeFocused();
    await indicatorIs(leader, 'Leading');
  });
});
