# State: #15 feat: React/Next package (PRD item 6)
- Path: full
- Phase: validation
- Branch: feat/15-react-package
- PR: #16 (ready for review)
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 1
- Last updated by: qa
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan (round 1): opus (rule) → PASS
- engineer implement: opus (architect `Implementer model: opus`) → DONE (13 chunks, all checks green)
- qa review (round 1): opus (NEXT_MODEL) → PASS (checks 10/10, ACs 29/29; 1 advisory: QR rate-limit wait reset on revoking codesChanged)
## Gate 2 decisions (user, 2026-11-05)
- Plan approved as written.
- Q-A accepted: `setJoiningEnabled` = lock/unlock of all joining; "expiry" =
  QR ticket `expiresAt` and code generation; README states codes still work
  after unlock, so a leaked code needs rotation.
- Q-B accepted: approval `paused` = `JOIN_PAUSED`.
- Q-C accepted: member vice flag tracked from provider mount, event-only,
  reset on group change or end.
- Q-D accepted: `useStoredGroups` auto-check opt-in `checkOnConnect`, default off.
- Every security control R1-R14 (security.md, incl. M1-M4 and L1-L7) is required.
## Security controls → commits
- R1 (QR re-issue on rotated/resumed/member_removed/superseded, not door_failures/created; client README line): 0084584 (`qr-controller.ts`, `qr.test.tsx` per reason), f3b4c49 (client README)
- R2 (refresh() coalesced: in flight, rate-limit wait, 10 s floor; loop tests): 0084584
- R3 (leader-only data gated on leading the current group; block list keyed by group; leader action values reset on role/group change; demotion/4004/end/A->B tests): a5598c1 (store + store tests), 0ed83cd (`useCreateGroup` value), 0084584 (`rotate`/`setJoiningEnabled`), b1c9bc9 (all leader actions + hook-level R3 tests)
- R4 (README: never remount/re-key to retry; stable key; `<Activity>`; README test): f3b4c49
- R5 (one idle-guarded automatic connect; fatal-reason fake-timer tests; source scan): 81ac93d (provider), 61a51af (`connection.test.tsx` per fatal reason), cfb5f1f (AC22 removal test), 946e219 (scan)
- R6 (deep-frozen SERVER_STATE/IDLE_SNAPSHOT; inert null-client store, no timers, no join flow; test): a5598c1
- R7 (`useSyncClient()` null until mounted, both modes; README warning): 61a51af, f3b4c49
- R8 (README: `enabled: false` when hidden, `visibilitychange` example in app code): 0084584 (`enabled` option), f3b4c49
- R9 (finite checks, 10 s floor, 60 s cap on `retryAfterMs`, 2^31-1 clamp, no expired/stale ticket exposed): a5598c1 (`host.ts` clamp), 0084584
- R10 (ESLint globals and imports; source scans; fixed-string errors): 30968c1 (ESLint block), 81ac93d (fixed messages), 946e219 (scans)
- R11 (README: one owned provider per app/storage namespace): f3b4c49
- R12 (README untrusted text and credentials; URL validation): f3b4c49
- R13 (devDependencies only, runtime deps exactly `@sync-system/client`, lockfile, no allow-build change, `pnpm audit --audit-level=high` clean): 30968c1; audit re-run before ready: clean
- R14 (obviously fake test keys): 81ac93d, 8135aff, 529f0d4 (`test-key-react-...`)
## Open questions
- none
## Deviations from plan
- Extra commit `docs(state): record gate 2 decisions for #15` before chunk 1
  (records the Gate 2 decisions in STATE.md and architecture.md sections 8
  and 13, incl. the R1/R2 corrections to the QR rules).
- `EMPTY_STORE` lives in `store.ts`, not `server-state.ts` (avoids a circular
  import; `server-state.ts` keeps only the frozen literals).
- Extra pure module `src/to-sync-error.ts` (`toSyncError`, re-exported from
  `action.ts`) so the store can use it without importing React code.
- The QR controller is created by the store (`store.qr`) instead of a plugin
  hook; StrictMode detach/attach of the store does not stop it (its
  consumers' ref-counted release does).
- `useMemberRemoval().blockList` comes from the core `getLeaderState().blockList`
  plus the latest `remove`/`addToBlockList` result for the led group, not
  from the async `getBlockList(groupId)` storage read (same data, synchronous,
  and gated like every leader-only part, R3).
- `useLeaderCodes().joinPaused` is `{ retryAt } | null` as planned; the store
  keeps the group ID with it internally (`JoinPausedState`).
- `usePreview().bringGroupHere()` returns an `ActionResult<void>` instead of
  `void`, so the core's synchronous `updatePosition` errors do not throw
  from an event handler.
- `QrTicket` is exported both as the component and as the core ticket type
  (type alias in `components/qr-ticket.ts`); TypeScript rejects two separate
  exports with one name.
- Test helpers: `test/helpers/all-hooks.tsx` (every hook, for the SSR,
  hydration and logging tests) and a jsdom-only `cleanup` in `test/setup.ts`.
  Extra tests `store.test.ts`, `action.test.tsx`, `logging.test.tsx`.
