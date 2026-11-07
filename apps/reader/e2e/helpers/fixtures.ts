import { type Browser, type Page, expect, test as base } from '@playwright/test';

export const BOOK_PATH = '/?book=samples%2Fpride-and-prejudice-en';

export function readerUrl(proxied = false): string {
  const url = process.env[proxied ? 'E2E_PROXIED_READER' : 'E2E_READER'];
  if (url === undefined) throw new Error('global setup did not run');
  return url;
}

/** Collects CSP violations and CSP console errors on a page (#24 AC55, R12). */
async function guard(page: Page, problems: string[]): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const list = ((window as unknown as { __csp?: string[] }).__csp ??= []);
      list.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      problems.push(message.text());
    }
  });
}

export interface Pages {
  /** A new page in its own browser context (its own sessionStorage). */
  open(): Promise<Page>;
}

/** Every page fails the test on a CSP violation. */
export const test = base.extend<{ pages: Pages }>({
  pages: async ({ browser }: { browser: Browser }, use) => {
    const opened: Page[] = [];
    const problems: string[] = [];
    await use({
      open: async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await guard(page, problems);
        opened.push(page);
        return page;
      },
    });
    for (const page of opened) {
      if (page.isClosed()) continue;
      const seen = await page.evaluate(
        () => (window as unknown as { __csp?: string[] }).__csp ?? [],
      );
      problems.push(...seen);
      await page.context().close();
    }
    expect(problems, 'CSP violations').toEqual([]);
  },
});

export { expect };

/** The Group button (its accessible name is the state, design 5.1). */
export function groupButton(page: Page) {
  return page.getByRole('button', { name: /, group options$/ });
}

export async function indicatorIs(page: Page, state: string, timeout = 15_000): Promise<void> {
  await expect(groupButton(page)).toHaveAccessibleName(`${state}, group options`, { timeout });
}

/** Records the QR tickets the leader's client receives (to build the deep link a camera would open). */
export function captureTickets(page: Page): string[] {
  const tickets: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      const match = /"type":"qr\.ticket"[^}]*"ticket":"([A-Za-z0-9_.-]+)"/.exec(text);
      if (match?.[1]) tickets.push(match[1]);
    });
  });
  return tickets;
}

export interface Codes {
  groupCode: string;
  doorCode: string;
}

function spelled(name: string | null): string {
  return (name ?? '').replace(/^[^:]*:\s*/, '').replace(/\s+/g, '');
}

/** On an open book page: starts a group with the defaults (A + D) and returns the codes. */
export async function startGroup(page: Page): Promise<Codes> {
  await groupButton(page).click();
  await page.getByRole('button', { name: 'Start a group' }).click();
  const start = page.getByRole('button', { name: 'Start group' });
  await expect(page.getByRole('checkbox', { name: 'Group code' })).toBeVisible();
  await start.click();
  const ready = page.getByRole('dialog', { name: 'Your group is ready' });
  await expect(ready).toBeVisible();
  const groupCode = spelled(
    await ready.getByRole('img', { name: /^Group code:/ }).getAttribute('aria-label'),
  );
  const doorCode = spelled(
    await ready.getByRole('img', { name: /^Door code:/ }).getAttribute('aria-label'),
  );
  return { groupCode, doorCode };
}

/** Joins with method A from an open book page; returns ms from the first submit to Following. */
export async function joinWithCodes(page: Page, codes: Codes): Promise<number> {
  await groupButton(page).click();
  await page.getByRole('button', { name: 'Join a group' }).click();
  await page.getByRole('textbox', { name: 'Code' }).fill(codes.groupCode);
  const started = Date.now();
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('textbox', { name: 'Door code' }).fill(codes.doorCode);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await indicatorIs(page, 'Following');
  return Date.now() - started;
}

/** Prints a measured number for the PR (AC56). */
export function report(name: string, ms: number): void {
  console.log(`E2E_TIMING ${name}=${ms}ms`);
}
