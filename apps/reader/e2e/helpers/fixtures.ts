import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  expect,
  test as base,
} from '@playwright/test';

export const BOOK_PATH = '/?book=samples%2Fpride-and-prejudice-en';

/** The stacks global setup starts: `main` (30 s grace) and `lifecycle` (5 s, auto handoff). */
export type Stack = 'main' | 'lifecycle';

export function readerUrl(proxied = false, stack: Stack = 'main'): string {
  const prefix = stack === 'lifecycle' ? 'E2E_LIFECYCLE_' : 'E2E_';
  const url = process.env[`${prefix}${proxied ? 'PROXIED_READER' : 'READER'}`];
  if (url === undefined) throw new Error('global setup did not run');
  return url;
}

/** Drops the proxied reader's connection of `stack` for `ms` (a locked phone). */
export async function cutLeader(ms: number, stack: Stack = 'main'): Promise<void> {
  const control = process.env['E2E_PROXY_CONTROL'];
  if (control === undefined) throw new Error('global setup did not run');
  const path = stack === 'lifecycle' ? `/cut/lifecycle/${ms}` : `/cut/${ms}`;
  const response = await fetch(`${control}${path}`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

/** Console errors Chromium prints for CSP and Trusted Types violations. */
const VIOLATION_CONSOLE = /Content Security Policy|Trusted ?Type|requires 'Trusted/i;

/** An uncaught Trusted Types `TypeError` (a sink refused a plain string). */
const TRUSTED_TYPES_ERROR = /\bTrusted(?:HTML|Script|ScriptURL)\b/;

/**
 * Fails the test on any CSP or Trusted Types violation in `context` (#24
 * AC55, R12; #21 AC3, security C4). Every `securitypolicyviolation` event is
 * forwarded to the test as it happens through an exposed binding (#21
 * security L1), so a page that closes or navigates away can't hide one;
 * `window.__csp` is kept as a second record read at teardown. Every page of
 * the context gets the console and page-error listeners from creation.
 * No allow-list: a violation caused by test tooling is a deviation to report,
 * not something to filter out here.
 */
async function guard(context: BrowserContext, problems: string[]): Promise<void> {
  await context.exposeBinding('__cspReport', (_source, report: unknown) => {
    problems.push(`securitypolicyviolation: ${String(report)}`);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const entry = `${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`;
      const page = window as unknown as { __csp?: string[]; __cspReport?: (r: string) => unknown };
      (page.__csp ??= []).push(entry);
      void page.__cspReport?.(entry);
    });
  });
  const watch = (page: Page) => {
    page.on('console', (message) => {
      if (message.type() === 'error' && VIOLATION_CONSOLE.test(message.text())) {
        problems.push(`console: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      if (TRUSTED_TYPES_ERROR.test(`${error.name}: ${error.message}`)) {
        problems.push(`pageerror: ${error.name}: ${error.message}`);
      }
    });
  };
  context.on('page', watch);
}

export interface Pages {
  /** A new page in its own browser context (its own sessionStorage). */
  open(options?: BrowserContextOptions): Promise<Page>;
}

/** Every page fails the test on a CSP or Trusted Types violation. */
export const test = base.extend<{ pages: Pages }>({
  pages: async ({ browser }: { browser: Browser }, use) => {
    const contexts: BrowserContext[] = [];
    const problems: string[] = [];
    await use({
      open: async (options) => {
        const context = await browser.newContext(options);
        await guard(context, problems);
        contexts.push(context);
        return context.newPage();
      },
    });
    for (const context of contexts) {
      for (const page of context.pages()) {
        const seen = await page.evaluate(
          () => (window as unknown as { __csp?: string[] }).__csp ?? [],
        );
        for (const entry of seen) {
          const reported = `securitypolicyviolation: ${entry}`;
          if (!problems.includes(reported)) problems.push(reported);
        }
      }
      await context.close();
    }
    expect(problems, 'CSP and Trusted Types violations').toEqual([]);
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
