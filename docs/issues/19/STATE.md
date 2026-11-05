# State: #19 feat: reading app content, text direction (RTL) and content fingerprint (PRD item 7)
- Path: full
- Phase: validation
- Branch: feat/19-reading-app-content
- PR: #20
- Plan approved by user: yes (Gate 2, 2026-11-05)
- Security-sensitive: yes
- Review rounds: 2
- Spec approved at Gate 1: yes
- Last updated by: engineer
## Model log
- pm groom: sonnet (default) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (NEXT_MODEL from pm; new app, no existing screen pattern) → DONE
- pm update-spec-2: sonnet (default) → DONE
- designer update: sonnet (clear pattern from first design pass) → DONE
- pm update-spec-3: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (Implementer model line) → DONE
- qa validate: opus (NEXT_MODEL) → FAIL
- security code (round 1): opus (rule) → PASS
- engineer fix (round 1): opus (rule) → DONE
- qa validate (round 2): opus (rule) → PASS
- security code (round 2): opus (rule) → PASS
- engineer fix (round 2, N7 at user request): opus (rule) → DONE
## Gate 2 decisions (2026-11-05)
- ADRs 0001-0006: recommended option accepted for each (0005 E1 escaping wording fixed per security.md F5).
- Q2: AC32-AC35 kept. Q3: `different-content` -> block. Q4: malformed leader metadata -> `unsupported-schema` / block.
- Q5: status-screen copy in architecture.md 6.4 accepted. Q6: sample texts as proposed.
## Open questions
- Q1-Q9 resolved at Gate 1 (see "Decisions (Gate 1)" in spec.md). Architect to confirm Q4 details (display hints, Unicode normalisation) and may tighten the AC23 ID pattern.
- Design decisions for architect: D1-D6 and open questions 1-6 in design.md (library, not-found, single-book mode added).
- Post-design decisions (AC24-AC41) added to spec.md. AC32-AC35 are orchestrator recommendations the user may override at Gate 2.
- Architect/security: is `?src=<url>` restricted (allow-list of origins via config)? Env variable names and config validation (AC30).
- Gate 2: ADRs 0001-0006 (each needs a decision) and architecture.md section 12 Q1-Q6 (AC32-AC35 overrides, different-content outcome, malformed leader metadata, new status-screen copy, sample texts).
- Security plan review: PASS (0 critical, 0 high, 6 medium, 6 low); required controls C1-C11 in security.md are part of the plan.
## Deviations from plan
- zod `jitless` is set in `src/content/zod.ts`, which every schema module imports `z` from, instead of in `main.tsx` (P7): ES module order would build the schemas before `main.tsx`'s body runs.
- `react`, `react-dom` and `@sync-system/react` are devDependencies of the app (Vite bundles them), so `pnpm deploy --prod` leaves only zod in the runtime image, as section 4 intends.
- The reader Dockerfile also copies `apps/sync-server/package.json` (manifest only): `pnpm deploy` resolves the whole workspace graph (the client dev-depends on the server).
- `tsconfig.server.json` and the `build`/`typecheck`/`start` script additions land in chunk 13 (with the server), not chunk 2: before that it had no inputs.
- Extra small modules: `src/content/origin.ts` (canonical-origin rules shared by config and `?src`), `src/content/quote.ts` (40-char truncation), `src/content/zod.ts`; `src/i18n/index.tsx` (holds the provider, so `.tsx`).
- `fetchText` times out with its own `setTimeout` + `AbortController` (one signal for headers and body, caller signal forwarded) instead of `AbortSignal.timeout`, so the timeout is testable with fake timers.
- Origin check also rejects `*` in a host (WHATWG `URL` accepts it; in a CSP it is a wildcard).
- A malformed `?book` value is not echoed: "Book not found" with Details "The book ID in the link is not valid." (security C6). Non-http(s) schemes and URLs with credentials in `?src` are `src-invalid`.
- `vite preview` also sends the production security headers and injects config for `/` and `/library`.
- Swipes are recognised for touch and pen pointers only (a mouse drag selects text).
- Test file names differ slightly from section 8.1 (`app.test.tsx`, `status-screens.test.tsx`, `boundaries.node.test.ts`, `readme.node.test.ts`, `build-output.node.test.ts`); coverage is as listed.
- Chunk 4 was pushed with a lint error (unneeded type assertions in a test); fixed in the follow-up commit `fix(reader): drop unneeded type assertions in fingerprint test`.
- File layout differs slightly from architecture.md section 4 (QA N6, no behaviour impact): `PageView` lives in `ContentBlock.tsx`, `PageProgress` in `PageNav.tsx`, `LibraryItem` in `LibraryScreen.tsx`, and `boot()` doesn't set `document.title` (each screen sets it).
- Fix round 1 (QA N5): the `mixed-en-he` auto block was English apart from its first word, so instead of only tagging it `he` its text is now Hebrew (it still starts with Hebrew and resolves rtl). Both mixed samples have new fingerprints; no test pinned them.
- Fix round 1 (QA N3): the 1-second timeout uses a separate message `reasonTimeoutOne` rather than a plural helper.
- Low advisories: F7 (length check before regex), F8 (lone surrogates refused + README note), F9 (production warning + README), F11 (compose `read_only`, `cap_drop`, `no-new-privileges`, `restart`), F12 (README note) done. F10: HSTS documented for the proxy; Trusted Types not added (still open).
## QA verdict (round 1): FAIL
- 1 blocking finding: swipes are only detected over the article text, not the whole content region, so a swipe below the text on short pages does nothing (see the PR #20 QA comment).
- Checks: lint, typecheck, test (reader 500), build, audit, compose config/build/up: pass. CI: pass. AC1-AC41 (AC9 removed): all met; AC13 met with finding 1.
- Headless Chrome (production server, preview, dev, container): 0 CSP violations, proven with a positive control. Not verified: real phone, Safari/Firefox, screen readers, visual bidi by eye, native-speaker review of `he.ts`.
- Non-blocking notes N1-N6 in the comment (favicon 404, stale PR body, Hebrew plural for seconds, library h1 outside main, sample auto-block lang, file layout).
## Fix round 1
- QA 1 (blocking): swipe listeners and `touch-action: pan-y pinch-zoom` moved from `<article>` to `<main>`; tests for a swipe outside the text and for a mouse drag there.
- QA N1: `public/favicon.svg` plus `<link rel="icon">` (same origin, CSP `img-src 'self'`).
- QA N3: Hebrew singular for a 1-second timeout. QA N4: library `<h1>` inside `<main>`. QA N5: sample auto blocks carry their own `lang`.
- Security A2: `**/dist-server` in `.dockerignore`. Security A1 (Trusted Types) left for the user at Gate 3.
- Checks after the fixes: `pnpm lint` (eslint + prettier), `pnpm typecheck`, `pnpm test` (reader: 504 tests), `pnpm build`: pass.
## QA verdict (round 2): PASS
- Round-1 finding 1 fixed: touch swipes below the text on short pages turn the page at 390x800 in LTR and RTL documents, en and he UI, and in the container; mouse drag still excluded.
- N1 (favicon, 0 CSP violations across 38 loads incl. `/favicon.svg`), N2 (PR body), N3, N4, N5 verified. N5 deviation (Hebrew `mixed-en-he` auto block) accepted: AC14 and AC20 still hold.
- Checks: lint, typecheck, test (reader 504), build, audit, compose config/build/up: pass. CI 2/2 pass. AC1-AC41 (AC9 removed): all met.
- Non-blocking N7: `server/run.ts` clientError handler answers idle-connection request timeouts with 400 (Node default is 408, which browsers retry); seen once as a Chrome 400 error page. Suggested fix: 408 or silent close for `ERR_HTTP_REQUEST_TIMEOUT`.
## Fix round 2 (QA N7, at the user's request at Gate 3)
- `f62d15f`: the `clientError` handler moved to `server/client-error.ts`. `ERR_HTTP_REQUEST_TIMEOUT` now gets `408 Request Timeout` with `Connection: close` and the security headers (Node's default status, which browsers retry); a connection that timed out without sending a byte is closed silently. Unparseable requests still get `400` with the security headers (C1). A socket that is no longer writable is destroyed; the handler never throws.
- `run()` takes optional `timeouts` (headers 15 s, request 30 s, check interval 30 s by default, unchanged in production) so tests use 200/400/50 ms.
- New `test/server-client-error.node.test.ts`: idle socket closed with no response, unfinished headers -> 408 (not 400), garbage -> 400, `/health` still 200 after each, plus never-throws unit tests. The two timeout tests fail against the old handler.
- Checks: `pnpm lint` (eslint + prettier), `pnpm typecheck`, `pnpm test` (reader: 35 files / 509 tests), `pnpm build`: pass. Security A1 (Trusted Types) untouched; going to a follow-up issue.
## Verification notes
- `pnpm audit --audit-level=high`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (reader: 500 tests), `pnpm build`: pass.
- `docker compose config`, `docker compose build reader` and `sync-server`: pass. `docker compose up reader`: healthy, `/`, `/library`, `/health` 200; `READER_ENTRY=x` exits 1 with `Config error: ...`. Runtime image: `/app` root-owned, `USER node`, `node_modules` = zod only, no source maps.
- Headless Chrome against the production server: samples, library, "Book not found" and `src-not-allowed` render correctly under the CSP, Hebrew interface from the browser language; no console messages captured. Manual QA (section 8.2) still to do: swipe, zoom, screen readers, Safari/Firefox.
