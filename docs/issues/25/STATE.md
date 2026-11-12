# State: #25 feat: reading app leader views and lifecycle prompts (PRD item 8b)
- Path: full
- Phase: validation
- Branch: feat/25-reading-app-leader-views
- PR: #31
- Spec approved at Gate 1: yes (2026-11-11, "Accept all", plus the two gap decisions)
- Design decisions: U5-U14 accepted (2026-11-11), U8 changed: the pasted QR link notice stays until dismissed
- Plan approved by user: yes (Gate 2, 2026-11-11, "Approve all")
- Gate 2 decisions: no ADRs. Q-A1: a leader who drops past the grace and returns as a member sees the sticky lost-lead banner (`lostDisconnect`), then the take-back card. Q-A2: the take-back card shows only after a handoff loss (`handoff_disconnect` / `handoff_inactivity`), not after a `take_back` loss; server follow-up for M1 is #32. Security R15-R24 are mandatory (L1-L6 through them; L4: the remove dialog shows the row's details line). "Bring group here" has no pending state; a failure keeps the preview and shows the error in the banner.
- Security-sensitive: yes (roles, removal, take-back client change, other participants' names; see architecture.md section 16)
- Review rounds: 2
- QA verdict (round 1, head bd6b8cd): BLOCKED on CI only, no code findings. Locally green: audit, lint, typecheck, test (reader suite 3x, 1010/1010), build, e2e 5/5, real-browser pass en + he (25/25). AC 22/23 met; AC55 not verifiable because the CI jobs `check` and `e2e` never started (GitHub Actions billing / spending limit). Becomes PASS once CI re-runs green on bd6b8cd. All 21 commits signed. 102 new he strings listed in the PR #31 review for #28.
- QA verdict (round 2, head 704fb96): PASS. Local CI run in place of GitHub Actions (user decision 2026-11-12; Actions billing): fresh clone of 704fb96, each job in its own `node:24` container (Debian 12), Node 24.22.3, pnpm 10.28.0. `check` 6/6 green (audit clean; tests 3163: protocol 207, sync-server 1145, client 574, react 227, reader 1010), `e2e` 4/4 green (5/5 Playwright, 47.3 s; handoff 5.38 s, bring 36 ms, QR 200 ms). AC 23/23 met (AC55 via the local run). Fix-round delta verified: the client R16 test fails under the member-keeps-recovery mutation (reverted); the reader Q-A1 test asserts on the injected MemoryStorage. All 25 commits signed.
- Last updated by: qa
## Model log
- pm groom: opus (orchestrator: broad lifecycle scope, same as #24) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (NEXT_MODEL: new flows, no existing pattern) → DONE
- designer update (U-decisions): opus (same run) → DONE
- pm update-spec (design decisions): sonnet (default) → DONE
- architect plan: opus (default; NEXT_MODEL opus) → DONE
- security plan: opus (rule) → PASS (0 critical, 0 high, 1 medium, 6 low; required controls R15-R24 in security.md)
- engineer implement: opus (Implementer model line; security-sensitive) → DONE (chunks 1-11; lint, typecheck, test, build, audit and e2e green)
- qa validate: opus (NEXT_MODEL) → BLOCKED (CI not run: Actions billing; no code findings)
- security code (round 1): opus (rule) → PASS (1 low)
- engineer fix (round 1, security low at user request): opus (rule) → DONE
- qa validate (round 2, delta + local CI): opus (rule: round 2) → PASS
## Fix round 1
- Input: security code review round 1 PASS with one low (R16, Q-A1 storage check could not fail), fixed at the user's request. QA round 1: BLOCKED on CI only, no code findings.
- `9c9eaf9 test(client)`: `packages/client/test/client.rejoin.test.ts`, a leader with stored recovery data drops, rejoins, and the server answers `group.joined` as member; the stored entry is the member token only, with no `recovery` and no codes blob. Put in the rejoin file (not resume) because Q-A1 is the automatic reconnect path. Checked to fail when the token store keeps recovery for member tokens (mutation reverted).
- `dda1f61 test(reader)`: the Q-A1 test in `apps/reader/test/leadership-flow.test.tsx` now asserts on the app's injected `MemoryStorage` (seeded with the pointer a joined tab has), not global `sessionStorage`: the pointer is still there and no stored value holds the group or door code. The token half stays with the client test.
- Checks: `pnpm lint`, `pnpm typecheck` green; client test 574/574, reader test 1010/1010. Full CI to be run locally by the orchestrator (Actions billing).
## Open questions
- Gate 2: Q-A1 and Q-A2 decided (see Gate 2 decisions).
- Resolved by the architect: D1-D9 (architecture.md section 2); server semantics for Gap 1 and keepalive.ack during the pause confirmed (section 3).
- Security M1 (Q-A2): server follow-up issue #32 opened by the pm (security.md R17).
## Implementation status
- Chunks 1-11 of architecture.md section 19 committed and pushed; PR #31 marked ready.
- E2E (`pnpm --filter @sync-system/reader test:e2e`, 5 passed, 48 s total), measured
  2026-11-11 on Windows/Chromium: lifecycle spec 16.9 s (budget about 40 s); handoff to the vice
  5.47 s after the cut (5 s grace); Bring group here to the member 27 ms (limit 2 s); member held
  still 3.0 s during preview; take-back card 14 ms after the leader's reconnect was seen. #24
  timings unchanged: QR link to Following 199 ms, code entry 169 ms, leader move 14 ms.
## Deviations from plan
- Gate 2 decisions recorded in their own `docs(state)` commit before chunk 1 (not inside chunk 1).
- Extra file `apps/reader/src/components/group/Template.tsx` (`Template` fills `{placeholders}` with React nodes in one pass, `Num` isolates a number): used for every template holding a name, number or time (R15).
- Banner slot offset: `inset-block-start: var(--header-block-size)`, the header height measured with a `ResizeObserver` and set through the CSSOM, so the sticky banner sits under the sticky header instead of behind it (plan said `0`).
- `useAnnouncer()` is used twice in `GroupReading` (polite and assertive) instead of a second setter in `announce.ts`.
- `ActionErrorLine` (controls.tsx) and `useActionError` (use-retry-wait.ts) render and hold the inline leader errors with their clamped wait; `ConfirmDialog` also got `detail` (L4 details line), `confirmInactive` and a node `error`; `Dialog` got `describedBy` (design 6.8).
- The last-chance hint is cleared by leader actions through `onActivity` props on `RosterList` and `LockControl`.
- Not added: `rowOptions` (row names come from `aria-labelledby`, plan 7.1) and `bringingGroup` (no pending state, Gate 2).
- The People list heading is "People (n)" in both the panel and the sheet view.
- The 8b console-spy test (AC54) landed with chunk 9, after the last flow existed.
- E2E: one loopback control for both stacks (`/cut/<ms>`, `/cut/lifecycle/<ms>`, ms a bounded integer up to 60000); `cutLeader` moved into `e2e/helpers/fixtures.ts`.
- R16 storage after the Q-A1 path: the reader test checks the app's injected tab storage holds no codes; the member token without recovery data is covered in the client's rejoin test (fix round 1).
