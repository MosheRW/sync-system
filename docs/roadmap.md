# Roadmap: PRD progress

This is the one-page overview of where the project stands against `docs/PRD Group Reading Sync.md`.

## How to resume

1. Read this file.
2. Read `docs/issues/<N>/STATE.md` of the active issue.
3. The workflow (agents, gates, board) is in `.claude/CLAUDE.md`.

Numbering: "item N" means PRD item N of 9, as used in the specs. GitHub issue and PR numbers differ from item numbers.

## Items

| Item | Scope                                                                                                                                                                                 | Issues        | PRs           | Status                                                                                                                                                                                                                          | Docs                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1    | Sync server core and monorepo scaffold                                                                                                                                                | #1            | #2            | Done (merged 2026-11-01)                                                                                                                                                                                                        | `docs/issues/1/`                                        |
| 2    | Framework-free core client package                                                                                                                                                    | #3            | #4            | Done (merged 2026-11-01)                                                                                                                                                                                                        | `docs/issues/3/`                                        |
| 3    | Participant tokens, token rejoin, restart recovery, plus hardening                                                                                                                    | #5, #7        | #6, #8        | Done (merged 2026-11-02)                                                                                                                                                                                                        | `docs/issues/5/`, `docs/issues/7/`                      |
| 4    | Join methods A-D (door code, approval, alphanumeric code, QR)                                                                                                                         | #10           | #11           | Done (merged 2026-11-04)                                                                                                                                                                                                        | `docs/issues/10/`                                       |
| 5    | Roles, timers and group lifecycle                                                                                                                                                     | #13           | #14           | Done (merged 2026-11-05)                                                                                                                                                                                                        | `docs/issues/13/`                                       |
| 6    | React/Next package with hooks over the core client                                                                                                                                    | #15           | #16           | Done (merged 2026-11-05)                                                                                                                                                                                                        | `docs/issues/15/`                                       |
| 7    | Reading app content: content schema v1, fingerprint, RTL and mixed direction, library page and content selection, plus the `apps/reader` app with Docker                              | #19           | #20           | Done (merged 2026-11-05)                                                                                                                                                                                                        | `docs/issues/19/`                                       |
| 8    | Reading app sync UX: 8a join and follow (#24); 8b leader views and lifecycle prompts (#25)                                                                                            | #24, #25      | #26, #31      | Done (8a merged 2026-11-11, 8b merged 2026-11-12)                                                                                                                                                                               | `docs/issues/24/`, `docs/issues/25/`                    |
| 9    | 9a Redis storage: restart survival, server-side block lists, several instances (#35); 9b health, readiness and config errors (#36); 9c public docs, changelog and first release (#37) | #35, #36, #37 | #38, #40, #43 | 9a done (PR 1 #38 merged 2026-11-12 as 46f4af3; PR 2 #40 merged 2026-11-15 as 1865f02; #35 and #39 closed); 9b done (PR #43 merged 2026-11-18 as 0d1dba3; #36 closed); 9c (#37) in grooming on `feat/37-docs-changelog-release` | `docs/issues/35/`, `docs/issues/36/`, `docs/issues/37/` |

Scope of items 7-9 is taken from the PRD ("Product 1: the reading app", "Deliverables and operations") and the item 4, 5 and 6 specs, which defer work to them. The scope will be fixed in each item's own spec.

## Parked follow-ups

- #9 `fix(client): harden forgetAllGroups cut-off against clock skew (follow-up to #7)`: open.
- #12 `fix(server): limit group creation and live groups per app (follow-up to #10)`: open.
- #21 `fix(reader): enforce trusted types in the csp (follow-up to #19)`: open. Priority rose with #24 (the reader now holds participant tokens); the #24 e2e CSP-violation check is its test harness (security L7).
- #27 Hebrew header bidi bugs (follow-up to #19): open. QA saw it again in 8b (#25).
- #28 native-speaker review of the Hebrew strings (follow-up to #24): open. The 102 Hebrew strings added in 8b (#25) are in its scope, including the vice-leader term "סגן המוביל".
- #32 `fix(server): offer take-back only after a handoff loss (follow-up to #25)` (security M1): open.
- #44 `fix(reader): escape control characters in echoed config values (follow-up to #36)` (security A1, low): open. The A2 finding (the truncated echo of non-secret values, Q24) is accepted, not a follow-up.
- #41 `fix(server): share join-attempt limits across instances through redis (follow-up to #35)` (security F22, Q-B6): open.
- #42 `fix(server): treat a just-started instance as live when picking a successor (follow-up to #35)` (C12): open. A peer sees a new instance as live only after its next heartbeat, and the S4 `oldAttached` and successor pick read the live cache. Needs architect and security.

## Key accepted decisions

- Join by group ID was removed; the only ways in are codes, QR tickets and token resume: `docs/issues/10/spec.md`.
- Recovery recreates a group only after a server restart; a group that empties ends after the grace hold (D15, Q-G): `docs/issues/13/architecture.md`.
- Removing a member closes their socket with code 4004 (Q-A, D6): `docs/issues/13/architecture.md`.
- The React package stays `private: true` until the release item (Q10): `docs/issues/15/spec.md`.
- The protocol version stays 1 until releases start in item 9: `docs/issues/13/spec.md`.
- Item 7 ADRs 0001-0006 are accepted: `docs/decisions/0001-reading-app-framework.md`, `0002-styling-and-design-tokens.md`, `0003-interface-languages.md`, `0004-content-schema-v1-and-fingerprint.md`, `0005-reader-configuration-and-content-selection.md`, `0006-fetched-content-policy.md`.
- Content IDs are namespaced (`<namespace>/<slug>`); once uploads exist, the server assigns IDs (Q8): `docs/issues/19/spec.md`.
- A content mismatch only warns or blocks; looking up the leader's exact version is deferred (Q7): `docs/issues/19/spec.md`.
- Loading content from `?src` is off by default and limited to an allow-list: `docs/issues/19/spec.md`, `docs/decisions/0006-fetched-content-policy.md`.
- Item 8 ADRs 0007-0009 are accepted: `docs/decisions/0007-qr-code-rendering-library.md` (`lean-qr` for QR codes), `0008-end-to-end-browser-tests.md` (Playwright e2e, Chromium, a separate CI job), `0009-reader-group-session-storage.md` (per-tab `sessionStorage` for tokens, the group pointer and the position).
- Item 8 was split at Gate 1 into 8a (join and follow, #24) and 8b (leader views and lifecycle prompts, #25): `docs/issues/24/spec.md`.
- Position payload is v1 `{v:1,pageIndex}`: `docs/issues/24/`.
- A QR ticket goes in the URL fragment and is stripped at startup: `docs/issues/24/`.
- The reader API key is public; production needs its own registration and per-IP proxy limits (security M1): `docs/issues/24/`.
- Item 8b adds no new ADRs: `docs/issues/25/architecture.md`.
- The take-back card shows only after a handoff loss (Q-A2); the server-side fix is #32: `docs/issues/25/STATE.md`.
- A leader who drops past the grace sees the lost-lead banner, then the take-back card (Q-A1): `docs/issues/25/STATE.md`.
- The keep-alive run-out is driven by the client countdown, with no server pause event (Gate 1 Gap 2): `docs/issues/25/spec.md`.
- Notice lifetimes (U8): the pasted QR link notice, the lost-lead banner and "can't take back" stay until dismissed: `docs/issues/25/design.md`.
- CI for #31 was run locally in Docker in place of GitHub Actions because of a billing block (2026-11-12): `docs/issues/25/STATE.md`.
- Item 9 was split at Gate 1 (2026-11-12) into 9a Redis storage including several instances (#35, AC1-AC32), 9b health, readiness and config errors (#36, AC33-AC42) and 9c docs, changelog and release (#37, AC43-AC56), run in that order: `docs/issues/35/spec.md`.
- License: GPL-3.0, SPDX `GPL-3.0-only`; it also covers the client and React packages; a later relicense to MIT stays simple only while the user is the sole copyright holder (Q3): `docs/issues/35/spec.md`.
- Packages are published under the user's npm scope `@mosherw` (three packages `@mosherw/sync-system-protocol`, `@mosherw/sync-system-client` and `@mosherw/sync-system-react` (Q4, Q16); image registry and repo visibility are 9c Gate 1 questions (Q17, Q18): `docs/issues/35/spec.md`.
- Docs: Markdown in the repo only; no GitHub wiki for now, may be reconsidered later (Q13, Q19): `docs/issues/35/spec.md`.
- Item 9 defaults accepted at Gate 1: Redis client `redis` (node-redis, ADR at Gate 2), Changesets with one fixed version group, first release 1.0.0 with protocol version 1 (minimum 1), a full grace after a restart, per-instance limits, `/health` liveness plus `GET /ready`; #32, #12 and #21 are fixed before 9c: `docs/issues/35/spec.md`.
- Item 9a ADRs 0010-0014 are accepted at Gate 2 (2026-11-12): `docs/decisions/0010-redis-client-and-supported-servers.md` (`@redis/client` 6.3.1 pinned, Redis and Valkey 7.2+), `0011-group-atomicity-with-redis.md`, `0012-cross-instance-event-delivery.md` (applied in PR 2), `0013-persistent-group-timers.md`, `0014-behaviour-while-redis-is-unreachable.md`.
- #35 is delivered as two PRs: PR 1 #38 (single-instance Redis, restart survival; merged 2026-11-12 as 46f4af3, `Refs #35`) and PR 2 #40 (several instances; merged 2026-11-15 as 1865f02, `Closes #35`, `Closes #39`): `docs/issues/35/STATE.md`.
- CI for #38 was run locally in Docker in place of GitHub Actions because of a billing block (2026-11-12): node:24 and a pinned redis:7.2.17-alpine: `docs/issues/35/STATE.md`.
- CI for #40 was run locally in Docker in place of GitHub Actions because of a billing block (2026-11-15): node:24, pinned redis:7.2.17-alpine, no bind mounts: `docs/issues/35/STATE.md`.
- PR 2 of #35 decisions (Gates 2 and 3): the cluster limits are fixed constants (Q-B5); a Redis outage longer than 10 s closes group sessions with 1001; upgrading from PR 1 means stopping every instance: `docs/issues/35/STATE.md`.
- Item 9b decisions at Gate 1 (2026-11-15): unknown look-alike env variables fail startup, the user overriding the warn recommendation (Q20); the version is read from `package.json` at runtime (Q21); `/ready` returns 503 from the start of shutdown (Q22) and while Redis is unreachable, fenced or pub/sub is unhealthy (Q23); the reader has no `/ready` (Q25): `docs/issues/36/STATE.md`, `docs/issues/36/spec.md`.
- ADR 0015 accepted at Gate 2 (2026-11-15): option 1, ten prefixes plus `_CEILING`, a `READER_` check in the reader, and "did you mean" suggestions: `docs/decisions/0015-unknown-environment-variables.md`, `docs/issues/36/STATE.md`.
- `docs/startup-errors.md` is the startup-error list; tests check it in both directions (every produced message is listed, every listed message is produced): `docs/issues/36/STATE.md`.
- CI for #43 was run locally in Docker in place of GitHub Actions because of a billing block (2026-11-18): `docs/issues/36/STATE.md`.

## Inherited by item 8b (#25): done

- Done: 8b used the members slot and the banner slot left by the 8a design: `docs/issues/24/design.md`, `docs/issues/25/design.md`.
- Done: a short notice shows when a QR ticket pasted into an already open tab is ignored (AC57): `docs/issues/25/spec.md`.

## Updating this file

The pm updates this file whenever an item's PR merges: status, merge date, issue and PR numbers, and any new parked follow-ups.
