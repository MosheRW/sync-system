# State: #7 Harden token recovery (follow-up to #5)
- Path: fast
- Phase: validation
- Branch: fix/7-token-recovery-hardening
- PR: #8
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 2
- Last updated by: qa

## Notes
- Follow-up to #5 (PRD item 3), merged in PR #6 (a9cfa02). GitHub issue numbers are not PRD item numbers.
- Spec: docs/issues/7/spec.md (25 acceptance criteria covering L1-L5, A1, A3, A4).
- Out of scope: A2 (history only), A5 (safe, no fix needed).
- Plan: docs/issues/7/architecture.md (10 planned commits, no new dependencies, no protocol change). Security-sensitive: yes, so security plan review is due before Gate 2.
- Security plan review (round 1): PASS, see docs/issues/7/security.md. 0 critical, 0 high, 1 medium (M1, made required control R5: a storage read failure must not drop dirty marks), 5 low (L-1 drop while resume pending can still reset attempts; L-2 one client can use up the per-app tokens.check budget; L-3 validate `previous` secret too; L-4 residual cross-tab case accepted; L-5 aggregate inbound memory note). Required controls R1-R8.
- Advisory for Gate 2: client-side fallback texts in packages/client/src/errors.ts for RATE_LIMITED / NOT_LEADER are left unchanged (spec scopes A1 to the server). Superseded at Gate 2: aligned in this PR (see deviations).
- Implementation: all 10 planned commits plus one extra (client text alignment). Required controls R1-R8 implemented. Approved advisories L-1, L-2, L-4, L-5 implemented (L-3 is part of R1). Checks: pnpm lint, typecheck, test (protocol 42, server 602, client 468), build and audit --audit-level=high all exit 0; lockfile unchanged.
- QA round 1 (head 415c584): PASS. lint, typecheck, test (protocol 42, server 602, client 468), build, audit --audit-level=high all exit 0 (2 pre-existing moderate advisories); CI 2/2 pass; acceptance criteria 25/25 met; engineer deviations judged acceptable. Non-blocking notes: AC6 no-timers test does not exhaust the per-app budget; pre-existing moderate audit advisories. Review comment posted on PR #8.
- QA round 2 (head 8ee7612, Gate 3 fix round): PASS. pnpm install --frozen-lockfile, lint, typecheck, test (protocol 42, server 602, client 471), build, pnpm audit (0 vulnerabilities) and audit --audit-level=high all exit 0; CI 2/2 pass; acceptance criteria 25/25 met. Verified lint still works with minimatch 11.0.4 (typed and client-scoped rules fire, server glob scoping and dist ignores apply). L-a, L-b and QA-1 resolved. Non-blocking nit: garbled test title at packages/client/test/token-store.test.ts:487. Review comment posted on PR #8.

## User decisions (Gate 1)
- D1 (L2): per-app tokens.check budget 600/min, fixed constant, on top of the per-connection limit; no global budget.
- D2 (L3): inbound queued-bytes cap, fixed constant 4 x maxPayload next to the 32-message cap; not configurable; MAX_BUFFERED_BYTES unchanged.
- D3 (L4): only "a resume timeout is not a stable connection"; no give-up-after-N, no stableAfterMs > requestTimeoutMs validation.
- D4 (A1): per-action error texts (not generic) for RATE_LIMITED (position update, tokens.check) and NOT_LEADER (position update, group.end, blocklist.set); codes unchanged.

## User decisions (Gate 2)
- Plan approved, with required controls R1-R8 (incl. R5 / M1 and R1 with L-3).
- Approved advisories added: L-1 (no stability reset while the automatic resume is pending), L-2 (one warn log per window per app + README note), L-4 (optional narrowing of the residual cross-tab case, no format change), L-5 (README states aggregate inbound memory).
- Client error texts aligned with the server in this PR.

## Open questions
- none

## Deviations from plan
- Extra commit `fix(client): align RATE_LIMITED and NOT_LEADER texts with the server`: approved at Gate 2, outside the spec's A1 scope (server only) and AC21's "no other error text changes". The client picks the per-request text by `SyncClientError.request` (`ACTION_MESSAGES` in packages/client/src/errors.ts); without a known request it keeps the position-update text. Local NOT_LEADER errors from `endGroup()` and `updatePosition()` now carry `request`. Client README error table updated.
- L-1 folded into commit 6: a private `#autoResume` marker (compared by identity, cleared in `#teardown`) set while the automatic group.resume is unsettled; `#connectionLost` skips the stability reset when it is set or the drop is a client-side group.resume REQUEST_TIMEOUT.
- L-2 folded into commit 3 (`tokens_check_app_budget_exhausted` warn, namespace only, at most once per `TOKENS_CHECK_WINDOW_MS` per app; state cleared in `GroupService.close()`) and commit 10 (README note).
- L-4 folded into commit 7: each dirty mark also records whether the storage key existed at the failed write; if it existed and is missing now, storage wins. README states what remains (a group with no stored entry whose write failed: always when the key did not exist then, otherwise only if some tab wrote the document again before this tab's next storage operation).
- R5 detail: besides keeping marks on a failed read, a mark made while the read failed uses the last storage state this store saw (`#known`, updated on every successful read and write), so a failed delete during a failed read never marks the group as "had no stored entry" (which would let rule 3 bring the old token back).
- `rawByteLength` is exported from `ws/connection.ts` (for a unit test). `ERROR_TEXT` and `ACTION_ERROR_TEXT` are exported from `ws/error-messages.ts` (for the table test).
- README aggregate inbound figure is 10000 x 224 KiB, about 2.1 GiB (2.3 GB); the security review's "~2.2 GiB" rounded the same number.
- Fix round (Gate 3 findings, requested by the user after round 1 PASS/PASS):
  - L-a (e25479b): dirty marks made before the store ever read or wrote storage successfully are memory-wins (`DirtyMark.memoryWins`, `#storageSeen`): a removal stays removed and an unsaved token stays until a successful write. R5 unchanged (a failed read never drops or changes a mark). Regression tests in packages/client/test/token-store.test.ts (2 failed before the fix). Client README cross-tab limits list the new remaining case (such a change wins over other tabs' changes until the next successful write).
  - L-b (56c71a6): `pnpm.overrides` `minimatch: ^11.0.1` in package.json (resolves 11.0.4). No direct bump fixes GHSA-g3hv-75wg-m249: eslint 9/10, @eslint/config-array and @typescript-eslint/typescript-estree still depend on minimatch 3.x/10.x. All consumers use the `Minimatch` class or the named `minimatch` export, which v11 keeps; lint runs and still reports errors. `pnpm audit`: no known vulnerabilities.
  - QA-1 (e8103ae): the AC6 close test now exhausts the per-app budget (600) and one live connection's per-connection limit, checks the budget state is non-empty, then asserts after close: scheduler pending 0, both limiters and the warning map empty (fails if `close()` stops clearing the app limiter).
  - Checks: pnpm install --frozen-lockfile, lint, typecheck, test (protocol 42, server 602, client 471), build, pnpm audit (0 vulnerabilities) all exit 0.
