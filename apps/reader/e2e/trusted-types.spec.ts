import { BOOK_PATH, expect, readerUrl, startGroup, test } from './helpers/fixtures.js';

/**
 * Trusted Types enforcement (#21 AC1-AC4, security C3-C5). The CSP carries
 * `require-trusted-types-for 'script'` and `trusted-types 'none'`; the app
 * needs no policy, so every flow must run with zero violations under the
 * guard in `helpers/fixtures.ts`. Group flows are covered by the `groups`,
 * `lifecycle` and `phone-lock` specs under the same guard.
 */

const TRUSTED_TYPES = ["require-trusted-types-for 'script'", "trusted-types 'none'"];

const BOOKS: readonly { id: string; pages: number }[] = [
  { id: 'samples/mixed-en-he', pages: 2 },
  { id: 'samples/mixed-he-en', pages: 2 },
  { id: 'samples/pride-and-prejudice-en', pages: 3 },
  { id: 'samples/psalms-he', pages: 3 },
  { id: 'samples/untitled', pages: 1 },
];

function bookPath(id: string): string {
  return `/?book=${encodeURIComponent(id)}`;
}

function expectTrustedTypes(csp: string | null, what: string): void {
  const directives = (csp ?? '').split('; ');
  for (const directive of TRUSTED_TYPES) {
    expect(
      directives.filter((d) => d === directive),
      `${what}: ${directive}`,
    ).toHaveLength(1);
  }
}

test.describe('Trusted Types in the CSP (#21)', () => {
  test('every response kind carries both directives (security C3)', async () => {
    const page = await fetch(`${readerUrl()}/`);
    expect(page.status).toBe(200);
    expectTrustedTypes(page.headers.get('content-security-policy'), '/');

    const asset = /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(await page.text())?.[1];
    expect(asset, 'the page loads a bundled script').toBeDefined();
    const script = await fetch(`${readerUrl()}${asset!}`);
    expect(script.status).toBe(200);
    expectTrustedTypes(script.headers.get('content-security-policy'), asset!);

    const missing = await fetch(`${readerUrl()}/no-such-file`);
    expect(missing.status).toBe(404);
    expectTrustedTypes(missing.headers.get('content-security-policy'), '404');
  });

  test('Chromium enforces both directives (positive control, security C5)', async ({ browser }) => {
    // Unguarded on purpose: this page provokes violations.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${readerUrl()}/`);
      const result = await page.evaluate(() => {
        const directives: string[] = [];
        document.addEventListener('securitypolicyviolation', (event) => {
          directives.push(event.violatedDirective);
        });
        let sink = 'allowed';
        try {
          document.createElement('div').innerHTML = '<b>x</b>';
        } catch (error) {
          sink = String(error);
        }
        let policy = 'allowed';
        try {
          const tt = (
            window as unknown as {
              trustedTypes: { createPolicy(name: string, rules: object): unknown };
            }
          ).trustedTypes;
          tt.createPolicy('default', {});
        } catch (error) {
          policy = String(error);
        }
        return new Promise<{ sink: string; policy: string; directives: string[] }>((resolve) => {
          setTimeout(() => resolve({ sink, policy, directives }), 200);
        });
      });
      expect(result.sink).toMatch(/TypeError.*TrustedHTML/);
      expect(result.policy).toMatch(/TypeError/);
      expect(result.policy).not.toBe('allowed');
      // The guard listens for these events, so a real violation would fail a test.
      expect(result.directives).toContain('require-trusted-types-for');
      expect(result.directives).toContain('trusted-types');
    } finally {
      await context.close();
    }
  });

  test('library, every bundled book, paging and error screens run without violations', async ({
    pages,
  }) => {
    const page = await pages.open();

    await page.goto(`${readerUrl()}/library`);
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
    const links = page.getByRole('main').getByRole('link');
    await expect(links).toHaveCount(BOOKS.length);
    // Open a book the way a reader does: from the library.
    await links.first().click();
    await expect(page.getByRole('button', { name: 'Next page' })).toBeVisible();

    for (const book of BOOKS) {
      await page.goto(`${readerUrl()}${bookPath(book.id)}`);
      await expect(page.getByText(`1 / ${book.pages}`, { exact: true })).toBeVisible();
      if (book.pages > 1) {
        await page.getByRole('button', { name: 'Next page' }).click();
        await expect(page.getByText(`2 / ${book.pages}`, { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Previous page' }).click();
        await expect(page.getByText(`1 / ${book.pages}`, { exact: true })).toBeVisible();
      }
    }

    await page.goto(`${readerUrl()}${bookPath('samples/no-such-book')}`);
    await expect(page.getByRole('heading', { name: 'Book not found' })).toBeVisible();

    await page.goto(`${readerUrl()}/?book=a&book=b`);
    await expect(page.getByRole('heading', { name: "This link isn't valid" })).toBeVisible();

    const missing = await page.goto(`${readerUrl()}/no-such-page`);
    expect(missing?.status()).toBe(404);

    // Back to the app after the plain-text 404, so the guard reads a live page.
    await page.goto(`${readerUrl()}/library`);
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  });

  test('the QR view runs without violations', async ({ pages }) => {
    const leader = await pages.open();
    await leader.goto(`${readerUrl()}${BOOK_PATH}`);
    await startGroup(leader);
    const qr = { name: 'QR code to join this group' };
    await expect(
      leader.getByRole('dialog', { name: 'Your group is ready' }).getByRole('img', qr),
    ).toBeVisible();
    await leader.getByRole('button', { name: 'Start reading' }).click();

    // Large screen: the side panel's QR, hidden and shown again.
    const panel = leader.getByRole('complementary', { name: 'Your group' });
    await expect(panel.getByRole('img', qr)).toBeVisible();
    await panel.getByRole('button', { name: 'Hide QR code' }).click();
    await expect(panel.getByRole('img', qr)).toBeHidden();
    await panel.getByRole('button', { name: 'Show QR code' }).click();
    await expect(panel.getByRole('img', qr)).toBeVisible();

    // Phone-sized screen: the code strip's QR button opens the QR sheet.
    await leader.setViewportSize({ width: 390, height: 844 });
    await leader.getByRole('button', { name: 'Show QR code' }).click();
    await expect(leader.getByRole('dialog').getByRole('img', qr)).toBeVisible();
  });
});
