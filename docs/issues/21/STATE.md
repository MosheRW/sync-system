# State: #21 fix(reader): enforce trusted types in the csp (follow-up to #19)
- Path: fast
- Phase: implementation
- Branch: fix/21-reader-trusted-types
- PR: #49
- Plan approved by user: yes (Gate 2, 2026-11-23; security advisories L1 and L2 folded in)
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (rule) → DONE
## Open questions
- None.
## Deviations from plan
- L1 (user decision at Gate 2): the e2e guard now works per browser
  context: `context.exposeBinding('__cspReport')` forwards each
  `securitypolicyviolation` to the test as it happens, and every page of the
  context gets the console and `pageerror` listeners from creation, so a
  closed or navigated page can't hide a violation. `window.__csp` is still
  read at teardown (deduplicated). Chunk 3.
- L2 (user decision at Gate 2): the bundle tripwire also flags
  `serviceWorker.register` (forbidden), `createElement("script")` (only the 3
  known React DOM resource sites) and `javascript:` (only React DOM's own
  throwing guard, 3 occurrences). Chunk 2.
- `build-output.node.test.ts` now builds with `NODE_ENV=production` (restored
  afterwards): under Vitest (`NODE_ENV=test`) Vite bundled React's
  development build, so the tripwire would not have seen the shipped bundle.
  Chunk 2.
- The QR-view tour step covers both the large-screen side panel (hide/show)
  and the phone-sized QR sheet; the plan said "the QR view". Chunk 3.
- C7 checked locally, not committed: with `jitless: false` in
  `src/content/zod.ts` the guard failed every app flow with
  `require-trusted-types-for trusted-types-sink` events and "requires
  'TrustedScript' assignment" console errors, while the header and positive
  control tests still passed.
