# State: #24 feat: reading app sync UX: join and follow (PRD item 8a)
- Path: full
- Phase: implementation
- Spec approved at Gate 1: yes (2026-11-06, "Accept all")
- Split: AC38-AC49 moved to #25 (8b, depends on this issue; no branch yet)
- Branch: feat/24-reading-app-sync-ux
- PR: #26
- Plan approved by user: yes (Gate 2, 2026-11-07)
- Gate 2 decisions (2026-11-07, "Approve all"): ADR 0007 `lean-qr` 2.7.4 Accepted; ADR 0008 Playwright, Chromium only, CI job `e2e` Accepted; ADR 0009 tokens, pointer and position in `sessionStorage` per tab Accepted; Q-A1 compose reuses `dev-app`, no server change; Q-A2 per-tab storage (a new tab doesn't resume, reopen-closed-tab does); Q-A3 25 s phone-lock test, README advises `disconnectGraceSeconds` 45; security L3: a QR ticket in a tab with a group asks once "Leave your current group and join this one?"; R1-R14 mandatory.
- Security-sensitive: yes (security plan review PASS, docs/issues/24/security.md: 0 critical, 0 high, 1 medium, 10 low; required controls R1-R14)
- Review rounds: 0
- Design decisions: U1-U4 accepted (2026-11-06, "Accept all"), recorded in spec.md
- Last updated by: engineer
## Model log
- pm groom: opus (orchestrator: broad scope) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (orchestrator: new flows) → DONE
- architect plan: opus (default) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (Implementer model line) → DONE
## Measured (AC56, e2e against the real sync server)
- Local (Windows, Chromium headless): QR deep link to Following 200-220 ms; code submit to Following (method A, door code included) 130-148 ms; leader move to both members 13-16 ms.
- CI `e2e` job (ubuntu-latest, run 42400662557): 149 ms, 140 ms, 22 ms.
- AC35: leader connection cut for 25 s through the TCP proxy; leader back Leading with no prompt, member saw the grace state and followed the next move (passes locally and in CI).
## Open questions
- None for the user.
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
- Extra commits between chunks: `b7d97e4` (prettier on the fake client, CI lint), `6d5e124` (flaky restore test: wait for effects), `23307d9` (a lint error pushed with chunk 16).
