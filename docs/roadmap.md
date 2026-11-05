# Roadmap: PRD progress

This is the one-page overview of where the project stands against `docs/PRD Group Reading Sync.md`.

## How to resume

1. Read this file.
2. Read `docs/issues/<N>/STATE.md` of the active issue.
3. The workflow (agents, gates, board) is in `.claude/CLAUDE.md`.

Numbering: "item N" means PRD item N of 9, as used in the specs. GitHub issue and PR numbers differ from item numbers.

## Items

| Item | Scope                                                                                                   | Issues   | PRs    | Status                   | Docs                               |
| ---- | ------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------ | ---------------------------------- |
| 1    | Sync server core and monorepo scaffold                                                                  | #1       | #2     | Done (merged 2026-11-01) | `docs/issues/1/`                   |
| 2    | Framework-free core client package                                                                      | #3       | #4     | Done (merged 2026-11-01) | `docs/issues/3/`                   |
| 3    | Participant tokens, token rejoin, restart recovery, plus hardening                                      | #5, #7   | #6, #8 | Done (merged 2026-11-02) | `docs/issues/5/`, `docs/issues/7/` |
| 4    | Join methods A-D (door code, approval, alphanumeric code, QR)                                           | #10      | #11    | Done (merged 2026-11-04) | `docs/issues/10/`                  |
| 5    | Roles, timers and group lifecycle                                                                       | #13      | #14    | Done (merged 2026-11-05) | `docs/issues/13/`                  |
| 6    | React/Next package with hooks over the core client                                                      | #15      | #16    | Done (merged 2026-11-05) | `docs/issues/15/`                  |
| 7    | Reading app content: content, text direction (RTL), content fingerprint                                 | none yet | none   | Not started              | none yet                           |
| 8    | Reading app sync UX: code entry, QR, approval prompt, connection indicator, keep-alive and leader views | none yet | none   | Not started              | none yet                           |
| 9    | Redis storage, public docs, changelog and release (health endpoint, config errors, semver)              | none yet | none   | Not started              | none yet                           |

Scope of items 7-9 is taken from the PRD ("Product 1: the reading app", "Deliverables and operations") and the item 4, 5 and 6 specs, which defer work to them. The scope will be fixed in each item's own spec.

## Parked follow-ups

- #9 `fix(client): harden forgetAllGroups cut-off against clock skew (follow-up to #7)`: open.
- #12 `fix(server): limit group creation and live groups per app (follow-up to #10)`: open.

## Key accepted decisions

- Join by group ID was removed; the only ways in are codes, QR tickets and token resume: `docs/issues/10/spec.md`.
- Recovery recreates a group only after a server restart; a group that empties ends after the grace hold (D15, Q-G): `docs/issues/13/architecture.md`.
- Removing a member closes their socket with code 4004 (Q-A, D6): `docs/issues/13/architecture.md`.
- The React package stays `private: true` until the release item (Q10): `docs/issues/15/spec.md`.
- The protocol version stays 1 until releases start in item 9: `docs/issues/13/spec.md`.

## Updating this file

The pm updates this file whenever an item's PR merges: status, merge date, issue and PR numbers, and any new parked follow-ups.
