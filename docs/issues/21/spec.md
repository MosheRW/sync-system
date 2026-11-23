# Spec: #21 fix(reader): enforce trusted types in the csp (follow-up to #19)

Issue: https://github.com/MosheRW/sync-system/issues/21
Path: fast

## Problem
The reading app's Content-Security-Policy, built in `apps/reader/server/headers.ts`, does not enforce Trusted Types, so the browser does not restrict DOM XSS sinks as a defense-in-depth layer. Source: `docs/issues/19/security.md` finding F10 (remainder is advisory A1, Low), deferred at Gate 3 of PR #20. Priority rose because the reader now holds participant tokens (#24).

## Acceptance criteria
- [ ] AC1: The CSP built in `apps/reader/server/headers.ts` includes `require-trusted-types-for 'script'`.
- [ ] AC2: If any policy is needed, the CSP also includes a `trusted-types` directive listing only the required policy names (no `*`, no `'allow-duplicates'` unless justified in the README).
- [ ] AC3: In Chromium, the built app (Vite production output) loads and the main flows work with zero Trusted Types violations in the console and no `securitypolicyviolation` events (React 19, Vite output, zod in jitless mode).
- [ ] AC4: A test asserts the Content-Security-Policy header contains the Trusted Types directive(s).
- [ ] AC5: The security notes in `apps/reader/README.md` describe the Trusted Types enforcement and any policy names.
- [ ] AC6: Existing checks (lint, typecheck, tests, build) pass.

## Out of scope
- Other CSP changes unrelated to Trusted Types.
- Other open security advisories on PR #20.
- Browsers without Trusted Types support (directive is ignored; no polyfill).

## Open questions
- None. If a third-party dependency needs a Trusted Types policy, the engineer notes it and proposes the minimal `trusted-types` list.
