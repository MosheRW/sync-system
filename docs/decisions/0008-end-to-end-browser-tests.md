# 0008. End-to-end browser test tool

- Status: Proposed
- Date: 2026-11-06
- Issue: #24

## Context

#24 AC56 (Decision Q10) needs an automated browser test that runs the real
sync server and the real reader server and measures: opening the app from a
QR deep link or code entry to following the leader in under 15 s of app
time, and a member update under 1 s after a leader move. AC25, AC34 and
AC35 (reload, phone lock against the real grace period) also need a real
browser and a real server. The numbers are recorded in the PR.

Constraints: a dev dependency only (never in a runtime image); runs in CI
(`ubuntu-latest`, no secrets, read-only token); several browser contexts at
once (a leader and members); the production CSP must stay active in the
test, so CSP violations are caught (#19 C7 asks for zero violations).

## Options

1. **Playwright Test (`@playwright/test`) with Chromium only
   (recommended).** Apache-2.0, maintained by Microsoft, release 1.65.0 on
   2026-11-05. npm dependencies: `playwright` -> `playwright-core` (no
   further runtime deps). Has its own runner, isolated browser contexts per
   user, `webServer` to start both servers, network control, traces on
   failure, and `page.on('console')` / CSP violation hooks. Cons: browsers
   are downloaded from Playwright's CDN by `playwright install`
   (Chromium about 170 MB in CI); a second test runner next to Vitest.
2. **Vitest browser mode.** Same runner as the unit tests. Cons: built to
   run component tests inside a browser, not to drive a full app served by
   other processes with several users; it still uses Playwright (or
   WebdriverIO) underneath, so the download is the same.
3. **Puppeteer.** Apache-2.0, Chrome-focused. Cons: no test runner (would
   need Vitest around it), more npm dependencies (`puppeteer-core`,
   `chromium-bidi`, `devtools-protocol`, `@puppeteer/browsers`, `lilconfig`,
   `typed-query-selector`), also downloads a browser.
4. **WebdriverIO.** Cons: much larger dependency tree and a driver per
   browser; nothing here needs cross-browser grids.

## Decision

Proposed: **Playwright Test, Chromium only**, pinned to an exact version as
a dev dependency of `apps/reader`, with tests in `apps/reader/e2e/` and a
`test:e2e` script that is **not** part of `pnpm test`. It runs in a separate
CI job (`e2e`) after the build. Runner-up: Vitest browser mode.

## Consequences

- CI downloads Chromium with `pnpm --filter @sync-system/reader exec
playwright install --with-deps chromium` in the `e2e` job only; the
  `check` job is unchanged.
- The tests start the built reader server (`node dist-server/server/main.js`)
  and the sync server, so the production CSP and headers are under test.
- Other browsers (WebKit for iOS Safari) can be added later with one line,
  at the cost of another download.
- The pinned version is bumped deliberately; `pnpm audit` covers it.
