# State: #24 feat: reading app sync UX: join and follow (PRD item 8a)
- Path: full
- Phase: validation
- Spec approved at Gate 1: yes (2026-11-06, "Accept all")
- Split: AC38-AC49 moved to #25 (8b, depends on this issue; no branch yet)
- Branch: feat/24-reading-app-sync-ux
- PR: #26
- Plan approved by user: yes (Gate 2, 2026-11-07)
- Gate 2 decisions (2026-11-07, "Approve all"): ADR 0007 `lean-qr` 2.7.4 Accepted; ADR 0008 Playwright, Chromium only, CI job `e2e` Accepted; ADR 0009 tokens, pointer and position in `sessionStorage` per tab Accepted; Q-A1 compose reuses `dev-app`, no server change; Q-A2 per-tab storage (a new tab doesn't resume, reopen-closed-tab does); Q-A3 25 s phone-lock test, README advises `disconnectGraceSeconds` 45; security L3: a QR ticket in a tab with a group asks once "Leave your current group and join this one?"; R1-R14 mandatory.
- Security-sensitive: yes (security plan review PASS, docs/issues/24/security.md: 0 critical, 0 high, 1 medium, 10 low; required controls R1-R14)
- Review rounds: 3
- QA verdict (round 1, 2026-11-08): FAIL, 44/44 criteria met, checks failed on a flaky reader test; findings 1-3 (flaky `resume.test.tsx` assertion, QR takes up to 10 s to reappear on phones, `leaveFailed` never shown) and 4-6 (lint warnings, dead `announceFollowingTo`, root README compose command). PR review comment: https://github.com/MosheRW/sync-system/pull/26#pullrequestreview-5816972463
- QA verdict (round 2, 2026-11-11): BLOCKED on CI infrastructure, no code findings. Every round-1 finding and security low verified fixed; lint 0 warnings, typecheck, build, audit pass; `pnpm test` 3/3 runs green (react 222, reader 849); e2e 4/4 locally; 44/44 criteria met; browser: QR reopen 41 ms with the same ticket and 0 `qr.issue`, re-issue at 24.1 s of a 30 s ticket, nothing issued while hidden, rotate/expiry drop the kept ticket, leaveFailed shown, L3 switch stays on the new group. CI `check` green; CI `e2e` failed 3 times at "Install Chromium" (runner DNS to the Ubuntu apt mirrors, no test ran; workflow unchanged, same image passed on 2026-11-08). Counts as PASS once `e2e` is green on the PR head, no new QA round needed. PR review comment: https://github.com/MosheRW/sync-system/pull/26#pullrequestreview-5861841587
- QA verdict (round 3, delta `a13e450..ed40f18`, 2026-11-11): PASS. A1 (`8d2be2c`) and A2 (`ca426c9`) verified with their tests; the A1 deviation is correct: every revoking reason (rotated, resumed, member_removed, superseded) drops or refuses the parked ticket, `door_failures` still keeps it. lint, typecheck, build, audit pass; `pnpm test` pass (react 226, reader 860), react + reader 3 more runs green; e2e 4/4 locally; browser: QR reopen 35-53 ms with the same ticket and 0 `qr.issue`, after "Get new codes" while hidden the old QR never rendered. CI on ed40f18: `check` green; `e2e` failed at "Install Chromium" (runner DNS), green on one rerun of each run (PR 43060002664, push 43059991423); all 4 checks green. 44/44 criteria met.
- Design decisions: U1-U4 accepted (2026-11-06, "Accept all"), recorded in spec.md
- Last updated by: qa
## Model log
- pm groom: opus (orchestrator: broad scope) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (orchestrator: new flows) → DONE
- architect plan: opus (default) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (Implementer model line) → DONE
- qa validate: opus (NEXT_MODEL) → FAIL
- security code (round 1): opus (rule) → PASS
- engineer fix (round 1): opus (rule) → DONE
- qa validate (round 2): opus (rule) → BLOCKED (CI e2e runner infrastructure; no code findings)
- security code (round 2): opus (rule) → PASS (2 new lows A1, A2; advisory)
- engineer fix (round 2, A1/A2 at user request at Gate 3): opus (rule) → DONE
- qa validate (round 3, delta): opus (rule) → PASS
## Fix round 1 (2026-11-11, engineer)
QA findings 1-6 and security lows 1-3, one commit each (plus one bug found on the way):
- QA 1, flaky notice assertion: `c0f072a` (`getNotice()` helper queries the notice bar, not the live region; also used for "Your group has ended.").
- QA 2, QR up to 10 s on phones: `18a8d14` (`QrTicketController` parks the last unexpired ticket on hide and shows it at once on show; nothing issued while hidden; re-issue on the 80 % schedule; dropped on expiry, revoking codes change, lost connection or lead, group switch). react + reader tests with fake timers.
- QA 3, `leaveFailed` never shown: `1f28d57` (member sheet, mismatch block, version warning; one test each).
- QA 4, unused eslint directives: `089a748`.
- QA 5, dead `announceFollowingTo`: `127ef99` (removed from en, he and the design table: design 9 announces only "Page n of N" on a followed move).
- QA 6, compose command: `de1848a` (root and reader READMEs).
- Found while fixing security 1: `01a10ca` (after L3 "Join this group" the resume hook resumed the old group and, on a gone answer, forgot the new group's pointer).
- Security 1, `GROUP_FULL` / failed L3 switch token: `279eaa7` (`forgetStoredGroup`; `GROUP_FULL` in the gone-codes test checks no token remains).
- Security 2, password in a refused URL: `415ad74` (user info replaced by `***`).
- Security 3, dead `[::1]`: `93f811e`.
Checks: `pnpm lint` 0 errors 0 warnings; `pnpm typecheck` pass; `pnpm test` pass (protocol 207, sync-server 1145, client 569, react 222, reader 849), reader suite 3 more runs all green; `pnpm build` pass; `pnpm audit --audit-level=high` clean; e2e 4/4 (QR link to Following 280 ms, code submit 168 ms, leader move 17 ms, 25 s phone lock passes).
## Fix round 2 (2026-11-11, engineer)
At Gate 3 the user chose "Fix now" for the security round 2 lows. One commit each, each with a test:
- A1, revoked QR ticket parked inside the release tick: `8d2be2c`. The controller keeps the latest revoking code change (group and code generation) even with no consumer; `#park()` and `#unpark()` refuse a ticket issued under an older code generation of that group. Test: each revoking reason fired between the last consumer going and the 0 ms release timer, fake timers; the old ticket is not rendered even once on show and a new one is issued. Same commit: the controller comment and `packages/react/README.md` no longer say "forgotten on expiry" (an expired parked ticket is discarded when the QR is shown again and never shown after expiry).
- A2, password with an unencoded `/`, `?`, `#`, `\` or `@` printed in a config error: `ca426c9`. `shownUrl` replaces everything up to the last `@` of the whole value with `***` and keeps only an `http(s)`/`ws(s)` scheme (in `user:pass@host` the "scheme" is the user name). Tests: all five characters, four scheme spellings for `READER_SYNC_URL`, and `READER_SRC_ORIGINS`.
Checks: `pnpm lint` 0 errors 0 warnings; `pnpm typecheck` pass; `pnpm test` pass (protocol 207, sync-server 1145, client 569, react 226, reader 860), react and reader suites 3 more runs all green; `pnpm build` pass; `pnpm audit --audit-level=high` clean; e2e 4/4 locally (QR link to Following 513 ms, code submit 163 ms, leader move 52 ms, 25 s phone lock passes).
## Measured (AC56, e2e against the real sync server)
- Local (Windows, Chromium headless): QR deep link to Following 200-220 ms; code submit to Following (method A, door code included) 130-148 ms; leader move to both members 13-16 ms.
- CI `e2e` job (ubuntu-latest, run 42400662557): 149 ms, 140 ms, 22 ms.
- AC35: leader connection cut for 25 s through the TCP proxy; leader back Leading with no prompt, member saw the grace state and followed the next move (passes locally and in CI).
## Open questions
- None for the user.
- U4: Hebrew strings for a native-speaker review are listed in the QA review comment (round 1).
## Deviations from plan
- Chunk placement: the browser config result union and the sync-invalid details landed in chunk 5 (planned 9); all en/he group copy in chunk 9; the item 7 compare and a member view in chunk 13 (block and warn UI in 16); member Leave in 16-17 (planned 18).
- `securityHeaders({ srcOrigins, syncUrl })` takes the checked sync URL and re-derives the origin inside `server/headers.ts` (plan named the field `syncOrigin`).
- `READER_SYNC_APP_VERSION` is capped at 64 characters (the sync server refuses longer versions); the plan said 256.
- R1 also tightened `checkAllowedOrigin`: `READER_SRC_ORIGINS` no longer accepts `http://[::1]:port` (a CSP source can't hold IPv6 literals); test and README updated.
- Files: one `components/group/group.module.css`; views grouped in `GroupSheet.tsx`, `LeaderViews.tsx`, `CreateGroupForm.tsx`, `JoinViews.tsx`, `MismatchViews.tsx`, `Prompts.tsx`, `controls.tsx` (Button, BackButton, NoticeBar; item 7 had no NoticeBar); orchestration in `group/GroupReading.tsx` and `group/GroupLibrary.tsx` with hooks `use-join.ts`, `use-qr-landing.ts`, `use-resume.ts`, `use-follow.ts` and helpers `announce.ts`, `context.ts`, `browser.ts`, `use-media-query.ts` (no `use-group-session.ts`).
- No separate `tsconfig.e2e.json`: `e2e/` and `playwright.config.ts` are in `apps/reader/tsconfig.json` (ESLint's project service needs them there).
- R3 `hashchange`: a ticket pasted into an open tab is stripped and dropped (not treated as a landing).
- L3 "Join this group": the stored group is resumed and then left (a leader's group is ended, as a leader can't leave), the pointer forgotten, then `joinByQr` runs.
- Resume treats `GROUP_FULL` as gone (pointer forgotten, one notice). Leave while not connected forgets the group locally (pointer, and the token through the client's `forgetGroup`).
- Library in a group: a notice with Open the group's book and, for members, Leave group in the header (the leader ends from the reading page, with its confirmation).
- e2e: the TCP proxy holds new connections during a cut (dropped packets, like a locked phone) instead of refusing them, so the reconnect lands when the network returns; the QR deep link is built from the ticket the leader's client received (no QR image decoding).
- Fix round 1: the parked QR ticket is a private field of the controller, never in the store state, so it isn't visible in React state while hidden (the #15 "ticket drop when no consumer is mounted" now means "dropped from the state"); `packages/react/README.md` updated.
- Fix round 1: the URL redaction also covers `READER_SRC_ORIGINS` entries (same helper, same leak); the reader README's compose command was fixed too.
- Fix round 1: `01a10ca` is outside the listed findings: a real L3 bug found while testing security finding 1.
- Fix round 2, A1: the check is "issued under a code generation older than the latest revoking change", not the suggested `parked.codesGeneration === client.getJoinCodes()?.generation`: `door_failures` moves the code generation but keeps QR tickets valid (server D12), so strict equality would drop a valid parked ticket after a door-code rotation (the existing "door_failures while hidden keeps the parked ticket" test).
- Extra commits between chunks: `b7d97e4` (prettier on the fake client, CI lint), `6d5e124` (flaky restore test: wait for effects), `23307d9` (a lint error pushed with chunk 16).
