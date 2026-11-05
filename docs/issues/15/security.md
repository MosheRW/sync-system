# Security review (plan): #15 React/Next package `@sync-system/react`

Mode: plan, round 1. Reviewed: `spec.md` (29 ACs, Gate 1 Q1-Q10),
`architecture.md` (D1-D12, sections 5-16, Gate 2 Q-A to Q-D), the core client
(`packages/client/src/client.ts`, `errors.ts`, `README.md`), the server's code
rotation paths (`apps/sync-server/src/joins/join-service.ts`, `codes.ts`), and
the earlier notes for this item in `docs/issues/3/security.md` (M5, L2, L3, L7,
R2-L6), `docs/issues/10/security.md` (L6, Q-B, Q-D) and
`docs/issues/13/security.md` (RC12).

**Verdict: PASS.** No critical or high finding. 4 medium and 7 low findings,
all with a concrete control below. The controls R1-R14 are part of the plan.

The plan already gets the hard parts right: the client is created only in an
effect (no client, socket or timer on the server), `getServerSnapshot` is one
constant, the only automatic `connect()` is guarded by `status === 'idle'`
(the core never returns to `idle`, and its own `connect()` applies backoff
after `closed(fatal|gave_up)` and the R2-L6 socket gap), StrictMode is handled
by a deferred close, actions never reject, and the package logs nothing.

## 1. Assets and trust boundaries

Assets held in browser memory by this package:
- `groupId` (bearer capability, #3 L3), in the snapshot, `useGroup`,
  `useStoredGroups`, events and action results.
- Join codes (`useLeaderCodes`, `codesChanged` payloads, `CreatedGroup`,
  `rotate` results) and QR tickets (bearer, time-limited, #10 L6).
- Leader-only data: roster (participant IDs, display names), pending join
  requests, leader recovery state, block list, keep-alive prompt, preview.
- The API key inside the owned client's options (not secret: it ships in the
  browser bundle; the core keeps it in a private field).

Boundaries:
1. **Server -> browser (protocol):** all server text (`serverMessage`,
   `details`), display names, group `metadata` and `position` (set by the
   leader, another user) are untrusted.
2. **SSR server -> browser:** the same modules run on a shared Node process
   per request (Next "use client" modules are still server-rendered).
3. **Package -> app code:** state handed to the app may reach DevTools, error
   reporters, analytics. The package controls only what it logs and keeps.
4. **App -> package:** apps can misuse escape hatches (`useSyncClient`,
   provider `key` remounts, `refresh()` in loops).
5. **Supply chain:** new devDependencies (React, jsdom, Testing Library).

## 2. Threats (STRIDE, short)

| | Threat | Plan status |
|---|---|---|
| S | A client created or connected on the SSR server, shared by all requests (#3 L7) | Mitigated (D1, effects only; constant server snapshot; SSR test with traps and timer count). Module-scope client in `client` mode stays an app responsibility (accepted, README). |
| T | Cross-request or cross-provider mutation of module singletons (`EMPTY_STORE`, `SERVER_STATE`) | Partly specified: L1 / R6. |
| R | n/a (no server logic) | |
| I | Credentials in logs, URLs, error messages | Mitigated (D12, ESLint, console spies, README). Hardening L3 / R10. |
| I | Credentials in React state / DevTools | Inherent, accepted (section 5). |
| I | Leader-only data kept after demotion / removal / group end | Partly specified: M3 / R3. |
| I | Server text or metadata rendered as HTML | Package renders no markup (D6, render props). README: L7 / R12. |
| D | Retry storm after fatal close (#3 M5) | Mitigated (D4, core backoff, source scan + fake-timer tests). Bypass by remount: M4 / R4. |
| D | Two live clients / leaked socket under StrictMode or remount | Mitigated (D3, tests AC6). Two owned providers: L6. |
| D | QR `qr.issue` budget exhaustion or flood close 4008 (ends the leader's group, #3) | Partly: timer floor 10 s and single flight are in; manual `refresh()` unbounded: M2 / R2. |
| D | Stale (revoked) QR ticket shown after a full code rotation | **Gap:** M1 / R1. |
| E | Member using leader actions | Server authorizes by ownership (#10 R12); hooks pass the core's `NOT_LEADER`. No package-side trust. |

## 3. Findings

Blocking (critical/high): **none.**

### Medium (advisory, but each has a required control)

**M1. The QR controller ignores `member_removed` and `superseded`, which
revoke every outstanding ticket.**
Location: architecture.md section 8 ("Other reasons (`door_failures`,
`member_removed`, ...) do nothing"); spec AC18; `packages/client/README.md`
"Leader API" (written in #10, before #13 added these reasons).
*Scenario:* the leader removes a disruptive member. The server claims a full
new code set (`commitFullSet`, `ticketGeneration = generation` in
`codes.ts`), so the QR on screen is now invalid, but the controller keeps
showing it as `ready` until the 80 % timer, which can be many minutes away
(tickets may live up to the 24 h ceiling, #10 L6). Everyone scanning gets
`QR_INVALID` exactly when the leader is managing the room. The same happens
after a server-restart supersede (`superseded`). Availability, and the
package holds a revoked credential as "ready". The #10 Q-B condition was
"re-issue on `codesChanged`".
*Fix (R1):* on `codesChanged` with reason `rotated`, `resumed`,
`member_removed` or `superseded`: clear the timer, bump the generation, set
`loading` with `ticket: null`, issue now. Only `door_failures` (same ticket
generation, and attacker-triggerable every 5 wrong door codes) and `created`
skip it. Test each reason. Correct the one line in
`packages/client/README.md` (docs only, the plan already edits that file).

**M2. Manual `refresh()` has no client-side floor.**
Location: section 8 (`refresh()`: "manual issue (same single flight)"),
`useQrTicket().refresh`, `<QrTicket>`.
*Scenario:* single flight bounds concurrency, not rate. An app that calls
`refresh()` in an effect without deps, on every render, or on a held key
sends `qr.issue` back to back at round-trip speed. The server answers
`RATE_LIMITED`; a sustained flood risks the per-connection flood close 4008,
which ends the leader's group (#3).
*Fix (R2):* `refresh()` is a no-op while a request is in flight, while a
`RATE_LIMITED` wait is pending, and within 10 s of the last issue unless the
ticket was revoked (generation bump) or is missing/expired. Test: 100
`refresh()` calls in one tick and in a 1 s loop -> at most one `issueQrTicket`
per 10 s.

**M3. Leader-only data can outlive the role in the store and in action
state.**
Location: section 6 (identity-keeping caches for codes "by generation",
roster, join requests, leader state; resets listed only for `keepAlive`,
`isVice`, `joinPaused`, `lastError`); section 5.3 (`useMemberRemoval().blockList`
has no stated source or reset); D8 (`ActionState.value`).
*Scenario:* the core drops codes, roster, requests, recovery state and preview
on demotion, removal (4004) and group end (#13 RC12, `#dropLeaderOnly`). If the
store keeps a previous value when the core now returns `null`/`[]` (an
identity-keeping cache compared by generation can do this), a demoted or
removed leader's UI and any error reporter that serializes app state keep the
old group's codes and roster. Separately, `useCreateGroup().value`
(`CreatedGroup` with codes), `rotate.value` (`JoinCodes`) and
`remove.value`/`blockList` stay in component state after the role or group is
gone, outside the store's reset logic.
*Fix (R3):* on every rebuild, leader-only parts are derived from the core
getters and gated on the current snapshot (`active`, `role === 'leader'`,
same `groupId`); when not leading they are the shared empty constants, never
a cached value. Identity is kept only against a previous value of the same
`groupId`. `blockList` is keyed by `groupId`, read via `getBlockList(groupId)`
only while leading, and dropped with the rest. Leader action hooks reset
their `value` when the active group ID changes or the role leaves `leader`.
Tests: demotion (`leadershipLost`), removal (close 4004), group end, and
group A -> group B each leave no codes, roster, requests, leader state, block
list, QR ticket or keep-alive prompt of the old group in `store.getState()`
or in leader action hook values.

**M4. Remounting the provider to "retry" bypasses the backoff.**
Location: D10 ("To change URL/key, remount with a React `key`"), section 7
("Effect re-run after a real close: a fresh client is created").
*Scenario:* the core's M5 / R2-L6 protection lives in the client instance.
A new client starts with a failure streak of 0. An app that changes the
provider `key` on `closed(fatal)` (an easy "fix" for an "update required"
screen), or keys on an unstable value, or toggles an `<Activity>` around the
provider, gets one new socket and handshake per remount with no delay. After
a `minAppVersion` bump every outdated install does this at once: the #3 M5
storm, reintroduced one layer up.
*Fix (R4):* README, in the no-auto-retry section: `key` only for a deliberate
configuration change, with a stable value; never remount or re-key to retry
after a fatal close or removal (use `useConnection().retry()`, which keeps the
backoff); `<Activity>`/hide-show recreates the client. Test (doc-level is
enough): `readme.test.ts` checks the sentence exists.

### Low (hygiene)

**L1. Module singletons must be inert.** Section 4 (`server-state.ts`:
`EMPTY_STORE` is a `SyncStore` with its own `QrTicketController`).
`EMPTY_STORE` is shared by every SSR request and by every owned provider before
its client exists. If any mutator (`recordJoin`, `dismissLeadership`,
`previewChanged`, `checkStoredGroups`, `qr.acquire/refresh`) writes to it, one
request or provider sees another's state, or a timer starts at module level.
*Fix (R6):* `SERVER_STATE` and `IDLE_SNAPSHOT` are deep-frozen; every mutator
and the QR controller on a null-client store are no-ops that create no timer;
actions on it return `NOT_CONNECTED` without recording a join flow. Test: call
every action and mutator on `EMPTY_STORE`, then `getState() === SERVER_STATE`
and `vi.getTimerCount() === 0`.

**L2. `useSyncClient()` in `client` mode on the server.** Section 5.3 says
null on the server, but in `client` mode the store holds the app's client even
during SSR and hydration. *Fix (R7):* return `null` until the provider's
effects ran (mounted flag), in both modes, on server and during hydration.
README: this escape hatch bypasses the package's no-auto-retry guarantees
(never call `connect()`/`close()` from render or a state-driven effect).

**L3. Restriction and scan gaps.** Section 4 ESLint block, section 9 scan.
Add `WebSocket`, `fetch`, `XMLHttpRequest`, `sessionStorage`, `indexedDB` and
`history` to `no-restricted-globals` (the package must not open its own
connections or touch URLs; `host.ts` is the only `globalThis` reader).
Extend `package.test.ts` scans: no `dangerouslySetInnerHTML`, `innerHTML`,
`eval`, `new Function`; `.resumeGroup(`, `.joinByCode(`, `.joinByQr(`,
`.checkTokens(` only inside action callbacks / the opt-in check. Provider and
hook error messages are fixed strings (hook name only), never interpolating
props, options or state (R10).

**L4. QR minting while not visible.** #10 Q-D accepted an automatic timer "if
it stops when the app says the QR is hidden". The controller runs while a
consumer is mounted and `enabled`. *Fix (R8):* README shows passing
`enabled={false}` (or unmounting) when the QR is not on screen, including a
`visibilitychange` example in app code (the package itself must not read
`document`).

**L5. Server-controlled timer inputs.** `expiresInMs` (via `expiresAt`) and
`details.retryAfterMs` come from the server. *Fix (R9):* guard with
`Number.isFinite`, apply the 10 s floor, cap `retryAfterMs` waits at 60 s and
every delay at 2^31-1; never expose a ticket whose `expiresAt` has passed or
whose generation is stale as `ready` or as `error.ticket`.

**L6. Two owned providers on the same storage.** Two `options`-mode providers
in one page (a common mistake: one per route segment) create two clients that
resume the same stored group and displace each other, bounded only by the
core's backoff. *Fix (R11):* README: one owned provider per app and storage
namespace; share it with `client` mode or context.

**L7. More untrusted text than names and `serverMessage`.** Group `metadata`
and `position` are leader-controlled JSON shown to members. *Fix (R12):*
README credentials/untrusted-text section names them: render as text, never
as HTML, and validate any URL taken from them (`https:` only, no
`javascript:`) before `href`/`src`.

## 4. Inherent / accepted risks (not findings)

- **Credentials in React state and DevTools.** Codes, tickets and `groupId`
  are visible to React DevTools and to any script in the origin. Any code in
  the origin can read them from the client anyway; the package cannot hide
  state it must render. Accepted with the README statement (AC27) and the
  ticket drop when no consumer is mounted.
- **Module-scope client passed in `client` mode.** The package cannot prevent
  it; `getServerSnapshot` never reads it, effects never run on the server, and
  the README forbids it (#3 L7).
- **API key in options.** Not a secret (it ships in the bundle). In the App
  Router, options passed from a server component end up in the RSC payload,
  which is the same exposure. The README's `providers.tsx` pattern is fine.
- **Late provider mount misses one-off events** (Q-C, D11): UI only; every
  leader action is authorized by the server.
- **First client render shows idle** (hydration): no data exposure.
- **React 18.3 untested** (Q2): same APIs; no security-relevant difference.

## 5. Gate 2 questions: security view

- **Q-A (`setJoiningEnabled` = lock/unlock):** agree. Lock is stronger than
  per-method toggling (`GROUP_LOCKED`: nobody new is admitted by any method).
  Condition: README says codes and tickets stay valid and work again after
  unlock, so a leaked code needs `rotate`, not just a lock.
- **Q-B (`paused` = `JOIN_PAUSED`):** agree. `retryAt` comes from the core's
  own-property-checked `details` (#3 L1). Display only.
- **Q-C (`isVice` from mount on):** agree. UI hint only; the server decides
  handoff. Condition (already in the plan): reset on group change or end.
- **Q-D (`checkOnConnect` opt-in, default false):** agree, preferred. No
  network call the app did not ask for; with it on, one check per connected
  session plus the core's `REQUEST_IN_PROGRESS` and the server's 10/min keep
  flapping connections bounded.

## 6. Required controls (part of the plan)

| # | Control | Commit (section 16) |
|---|---|---|
| R1 | QR re-issue on `codesChanged` `rotated`, `resumed`, `member_removed`, `superseded` (drop ticket, bump generation, issue now); not on `door_failures`/`created`; test per reason; fix the client README line (M1) | 8, 13 |
| R2 | `refresh()` coalesced: no-op in flight, during a `RATE_LIMITED` wait, and within 10 s of the last issue unless revoked/expired; loop test (M2) | 8 |
| R3 | Leader-only store parts derived from core getters gated on current leader role and `groupId`; block list keyed by group; leader action `value` reset on role/group change; tests for demotion, 4004, end, A -> B (M3) | 2, 9, 10 |
| R4 | README: no remount / `key` change to retry; `key` stable and only for config changes; `<Activity>` recreates the client; README test (M4) | 13 |
| R5 | Keep D4 exactly: one automatic `connect()` site, `idle`-guarded; the fatal-reason fake-timer tests and source scan of section 9 (AC7, AC22) | 3, 12 |
| R6 | `SERVER_STATE`/`IDLE_SNAPSHOT` deep-frozen; null-client store fully inert (no-op mutators, no timers, no recorded join flow); test (L1) | 2 |
| R7 | `useSyncClient()` returns `null` until mounted, both modes, server and hydration; README warning (L2) | 4 |
| R8 | README: QR `enabled={false}`/unmount when hidden, `visibilitychange` example in app code (L4) | 13 |
| R9 | Timer inputs finite-checked, floored at 10 s, `retryAfterMs` capped at 60 s, all capped at 2^31-1; no expired or stale-generation ticket exposed (L5) | 8 |
| R10 | ESLint globals and source scans of L3; fixed-string error messages (no props/options/state in messages) | 1, 12 |
| R11 | README: one owned provider per app/storage namespace (L6) | 13 |
| R12 | README untrusted text: names, `serverMessage`, `metadata`, `position`; text only; URL validation (L7); `groupId`, codes, tickets are credentials (AC27) | 13 |
| R13 | Dependencies: new packages devDependencies only (runtime `dependencies` exactly `@sync-system/client`); caret ranges as in the repo; lockfile committed; no `onlyBuiltDependencies` / allow-build changes (pnpm 10 blocks install scripts; none of the new packages needs one); `pnpm audit --audit-level=high` clean before ready (AC29) | 1 |
| R14 | Test fixtures use obviously fake keys and secrets (pattern of `packages/client/test/helpers/real-server.ts`), nothing that looks like a real credential | 11 |

## 7. What I will check in code mode

- gitleaks over the PR range, semgrep on changed files, `pnpm audit
  --audit-level=high` and the lockfile diff (only the expected packages, no
  install scripts enabled).
- `provider.ts`: client created only in an effect; deferred close cancelled on
  StrictMode remount; `idle` guard; no `connect()`/`close()` elsewhere; mode
  switch error text; `INVALID_OPTIONS` handled without retry.
- `store.ts`: leader-only gating (R3), inert `EMPTY_STORE` (R6), every event
  listener removed on detach, no retained ticket or codes after reset.
- `qr-controller.ts`: R1, R2, R9; generation checks on every async result;
  timers cleared on stop, detach and client change; StrictMode single issue.
- Every hook: no action from render, store change or event (only user
  callbacks); `useSyncEvent` unsubscribes; `useSyncAction` never rejects and
  keeps no arguments (codes, tickets) in state.
- SSR / hydration / import tests really trap `window`, `document`,
  `WebSocket`, `localStorage` and count timers; `"use client"` placement.
- No `console`, logger, URL building, `dangerouslySetInnerHTML` in `src`;
  README statements for R4, R7, R8, R11, R12 and the no-auto-retry rule.
