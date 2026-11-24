import type { Page } from '@playwright/test';
import { expect, readerUrl, test } from './helpers/fixtures.js';

/** #27: the reading header at phone width, in both interface directions. */
const viewport = { width: 390, height: 844 };
const LONG_LTR = 'A very long English title that cannot possibly fit in a phone header';
const LONG_RTL = 'כותרת עברית ארוכה מאוד שלא תיכנס בשום אופן בכותרת של טלפון קטן';

const interfaces = [
  { locale: 'en-US', dir: 'ltr' },
  { locale: 'he-IL', dir: 'rtl' },
] as const;
const books = [
  { path: '/?book=samples%2Fpride-and-prejudice-en', dir: 'ltr', long: LONG_LTR },
  { path: '/?book=samples%2Fpsalms-he', dir: 'rtl', long: LONG_RTL },
] as const;

async function open(
  pages: { open: (o: { locale: string; viewport: typeof viewport }) => Promise<Page> },
  locale: string,
  path: string,
  dir: string,
): Promise<Page> {
  const page = await pages.open({ locale, viewport });
  await page.goto(new URL(path, readerUrl()).href);
  await expect(page.locator('html')).toHaveAttribute('dir', dir);
  await expect(page.getByRole('banner')).toBeVisible();
  return page;
}

/** No horizontal overflow of the page or the header (AC3). */
async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const header = document.querySelector('header')!;
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      header: header.scrollWidth - header.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.header).toBeLessThanOrEqual(0);
}

for (const ui of interfaces) {
  test.describe(`interface ${ui.locale}`, () => {
    test('page counter reads "1 / 3" in order (AC1)', async ({ pages }) => {
      const page = await open(pages, ui.locale, books[0].path, ui.dir);
      const order = await page.evaluate(() => {
        const counter = [...document.querySelectorAll('header p')].at(-1)!.querySelector('bdi')!;
        const text = counter.firstChild as Text;
        const rect = (i: number) => {
          const range = document.createRange();
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          return range.getBoundingClientRect();
        };
        const value = text.data;
        return {
          value,
          first: rect(0).right,
          last: rect(value.length - 1).left,
        };
      });
      expect(order.value).toMatch(/^1\D+\d+$/);
      expect(order.first).toBeLessThanOrEqual(order.last);
      await expectNoOverflow(page);
    });

    for (const book of books) {
      test(`title of ${book.path} truncates at its own end (AC2, AC3)`, async ({ pages }) => {
        const page = await open(pages, ui.locale, book.path, ui.dir);

        // Short title keeps the interface start (layout unchanged).
        const short = await page.evaluate(() => {
          const title = document.querySelector('header p')!;
          const bdi = title.querySelector(':scope > bdi')!;
          const t = title.getBoundingClientRect();
          const b = bdi.getBoundingClientRect();
          return { dir: bdi.getAttribute('dir'), tl: t.left, tr: t.right, bl: b.left, br: b.right };
        });
        expect(short.dir).toBe(book.dir);
        if (ui.dir === 'rtl') expect(Math.abs(short.br - short.tr)).toBeLessThanOrEqual(1);
        else expect(Math.abs(short.bl - short.tl)).toBeLessThanOrEqual(1);
        await expectNoOverflow(page);

        // Long title (layout probe only): clipped at its logical end.
        const probe = await page.evaluate((long) => {
          const bdi = document.querySelector('header p > bdi')!;
          const text = bdi.firstChild as Text;
          text.data = long;
          const rect = (i: number) => {
            const range = document.createRange();
            range.setStart(text, i);
            range.setEnd(text, i + 1);
            return range.getBoundingClientRect();
          };
          const box = bdi.getBoundingClientRect();
          return {
            truncated: bdi.scrollWidth > bdi.clientWidth,
            box: { left: box.left, right: box.right },
            first: rect(0),
            last: rect(long.length - 1),
            style: getComputedStyle(bdi).textOverflow,
          };
        }, book.long);
        expect(probe.truncated).toBe(true);
        expect(probe.style).toBe('ellipsis');
        if (book.dir === 'ltr') {
          expect(probe.first.left).toBeGreaterThanOrEqual(probe.box.left - 1);
          expect(probe.first.right).toBeLessThanOrEqual(probe.box.right + 1);
          expect(probe.last.left).toBeGreaterThanOrEqual(probe.box.right - 1);
        } else {
          expect(probe.first.right).toBeLessThanOrEqual(probe.box.right + 1);
          expect(probe.first.left).toBeGreaterThanOrEqual(probe.box.left - 1);
          expect(probe.last.right).toBeLessThanOrEqual(probe.box.left + 1);
        }
        await expectNoOverflow(page);
      });
    }
  });
}
