# Security review (plan): #25 reading app leader views and lifecycle prompts (8b)

- Mode: plan, round 1
- Reviewed: [`architecture.md`](architecture.md) (at `d4388ed`),
  [`spec.md`](spec.md), [`design.md`](design.md), the #24 baseline
  ([`../24/security.md`](../24/security.md), R1-R14, L1-L10), ADR
  [0009](../../decisions/0009-reader-group-session-storage.md), the QR-ticket
  rules in [`docs/conventions.md`](../../conventions.md), and the code the
  plan touches or relies on: `packages/client/src/client.ts` (`leader.changed`,
  `takeback.offered`, `takeBackLeadership`, `#onGranted`, `#onLost`, member
  resume `#admitted`), `packages/client/src/preview.ts`,
  `packages/react/src/store.ts` and `hooks/leader.ts` (leader-only data),
  `packages/protocol/src/join.ts` (`normalizeDisplayName`),
  `apps/reader/src/group/deep-link.ts`, `GroupReading.tsx` (`pageChanged`,
  leader-only teardown), `components/PlainText.tsx`,
  `apps/reader/e2e/helpers/servers.ts`, `apps/sync-server/src/config/dev-key.ts`,
  both Dockerfiles, `.dockerignore`, `apps/reader/server/headers.ts`.
- **Verdict: PASS.** No critical or high findings. The plan adds no
  dependency, no storage, no wire message, no server change, and no
  CSP/Permissions-Policy change. The server stays the only authority for every
  new leader action; the client change (P3) can only withdraw an offer; the
  new hook (P4) exposes one leader-only enum. One medium (a pre-existing server
  behaviour the plan surfaces, Q-A2) and six lows. The required controls in
  section 4 become part of the plan; #24 R1-R14 still apply.

## 1. Assets and trust boundaries

| Asset | Why it matters |
|---|---|
| The lead of a group | Sees codes and QR, approves joiners, removes (blocks) people, moves everyone's page, ends the group |
| Take-back offer (`takeBackAvailable`) | A UI hint for a server-side right (`displacedLeaderId`); the server decides |
| Roster: display names, participant IDs, connection state, `admittedSinceRecovery` | Other people's data, possibly minors; leader-only |
| Join codes, QR tickets | Rotate on remove (8a AC9); bearer credentials |
| Leader's preview position | What the leader browses privately (AC41) |
| Participant tokens in `sessionStorage` (ADR 0009) | Leader token carries recovery data (codes) |

Trust boundaries (as #24, plus):

1. **Sync server messages -> reader**: roster names come from other users
   (validated by the server with `normalizeDisplayName`, which forbids bidi
   controls; the client receive schema only caps length).
2. **Reader UI -> sync server**: every leader action (vice, remove, lock,
   take-back, keep-alive, bring group here) is authorised by the server
   (`authorizeLeader`, `takeBack` checks `displacedLeaderId`). Reader gating is
   UX, not access control.
3. **URL fragment (`hashchange`) -> reader**: a pasted `#t=` link (AC57).
4. **Test config -> e2e sync server**: `apps.lifecycle.json` with the public
   dev key.

## 2. Threats (STRIDE, brief)

| | Who | Can try to | Plan's answer |
|---|---|---|---|
| S | Member | Pose as another member in the roster (same or look-alike name, chosen "Guest 3") | `rosterNameText` from `generated`/`guestNumber`, "Auto name" tag (AC39); actions bound to `participantId` of the row, never text. L4 |
| T | Member | Inject markup or bidi tricks through a display name into roster, remove title, announcements, error lines | `PlainText` (`<bdi>`), split-around-`{name}` rendering, FSI/PDI in announcement strings, server forbids `Bidi_Control`. L1 |
| T | Hostile interim leader | Take the lead back again after the original leader took it back (ping-pong) | Server allows it (section 3 of the plan); reader hides the card (Q-A2). M1 |
| R | n/a | No accounts or audit trail by design | |
| I | Demoted leader's screen | Keep seeing roster, codes, QR, open remove dialog after losing the lead (AC47) | Store drops leader data when `lead === null`; UI gated on `isLeader`. R16 |
| I | Members | Learn the leader's preview page (a stray `updatePosition` during preview) | `pageChanged` routes to `preview.move` while previewing (AC41). L3 |
| I | Logs | Names, participant IDs, positions, codes, tickets in console (AC54) | No client logger, ESLint `no-console`, P3 adds no log field, console-spy test. R19 |
| I | URL / DOM | Pasted ticket shown or kept | Strip first, `onIgnored()` with no arguments, counter only. R20 |
| D | Hostile server data | Huge `retryAfterMs` / `countdownMs` freezing buttons or countdowns | Server-sourced durations; L2 |
| D | Cross-origin opener | Spam `hashchange` to show the AC57 notice | `Cross-Origin-Opener-Policy: same-origin` severs the opener; notice only. Not a finding |
| E | Member | Run leader actions | Server role checks; reader offers them only while `isLeader` |
| E | Former leader | Keep leader recovery data (codes) in storage after losing the lead while away (Q-A1) | Member resume stores the member token with no recovery data (`#admitted`). R16 test |

## 3. Findings in the plan

Blocking: none.

| # | Severity | Location | Issue (attack scenario) | Fix |
|---|---|---|---|---|
| M1 | Medium | architecture.md 3 (side finding), 8.5, 15, Q-A2; server `lifecycle-service.ts` `handoff()` | Server behaviour from #13, surfaced by this plan: after the original leader takes the lead back, the interim leader (whoever auto handoff picked: the vice, else the earliest admitted connected member) is the new `displacedLeaderId` and can call `leader.takeBack` again. A hostile member who once got the lead by auto handoff can keep re-seizing it (rate-limited per group), and each time see codes, approve joiners and remove people, including the original leader. The reader-side suppression in Q-A2 is UX only: a scripted client with the public key (#24 M1) calls `leader.takeBack` anyway, and after a reload the reader shows the card again. The original leader can remove the person while leading, so impact is disruption, not data access beyond what the interim lead already had. | **Open a server follow-up issue now (whatever the user picks for Q-A2):** take-back only for the leader displaced by a *handoff* (`handoff_disconnect`, `handoff_inactivity`), never for one displaced by `take_back`; `leader.lost` for a `take_back` carries `takeBackAvailable: false`. Q-A2 recommendation is fine for the UI meanwhile (R17). |
| L1 | Low | architecture.md 7.2 (`announceVice` with U+2068/U+2069 in the string), 7.1 (`PlainText`) | Bidi isolation in announcement strings and in `<bdi>` depends on the name having no bidi controls of its own: an unmatched PDI (U+2069) inside the name would close the isolate early. Today the server forbids `Bidi_Control` and `Cf` in names (`normalizeDisplayName`), but the client's roster schema only caps length, so the reader relies entirely on the server. | Defence in depth (R15): before wrapping a name in FSI/PDI for an announcement string, drop bidi control characters (`\p{Bidi_Control}`) from it; test with a name containing U+2069 and U+202E. |
| L2 | Low | architecture.md 7.2 `use-retry-wait.ts`, 8.3 `useCountdown(prompt.deadlineAt)` | `retryAfterMs` (error `details`) and `countdownMs` come from the server. A wrong or hostile value (huge, negative, `NaN`) could keep a leader button `inactive` for hours or show a nonsense countdown. Availability of the UI only; the server is ours. | Clamp both: finite, `>= 0`, `retryAfterMs <= 10 min` (else the no-time variant `errRateLimited`), `countdownMs` within the server's ceiling; test `NaN`, `-1`, `1e12`. |
| L3 | Low | architecture.md 7.3 ("checks a ref of `preview.active`") | If the ref is a React-state mirror written by an effect, a page turn in the same tick as `start()` or right after `nowLeading` (before the off-page preview starts on dismiss, 8.1 step 4) can reach `updatePosition`, moving members and revealing the leader's private page (AC41, U7). | Route by the core's live state (`client.preview.active` read synchronously in `pageChanged`), not a state mirror; while the now-leading dialog is open, send nothing (page keys are off by AC52, but programmatic moves aren't). Tests: turn in the same tick as `start()`; no `updatePosition` between `nowLeading` and dismiss for an off-page new leader. |
| L4 | Low | architecture.md 7.2 remove dialog, design 6.6 | Display names are not unique; two "Dana" rows or a chosen "Guest 3" look-alike can make the leader remove the wrong person from the dialog (the dialog shows only the name, truncated to 32). The action is bound to the right `participantId`, so this is a UX-level spoof, not an authorisation bug. | In the remove dialog show the row's line 2 (role, state, "Auto name") under the title; keep the target as the `participantId` captured when the dialog opened and close it (`errPersonGone`) if that entry leaves the roster (as planned). |
| L5 | Low | architecture.md 7.1 (`aria-controls`, `aria-labelledby="<name-id> <details-id>"`, "refs by participant ID") | If element IDs are built from participant IDs, those IDs land in DOM attributes (visible to any extension or a screenshot of devtools) for no reason; the same habit tends to add `title={name}` on clamped names. Not a log leak (AC54 covers logs), hygiene only. | Build DOM IDs with React `useId()` plus the row index; participant IDs only as React `key`s and in JS maps; no `title`, `aria-label` or `data-*` attribute holding a name or participant ID (R15). |
| L6 | Low | architecture.md 4 P3 (2) | `takeBackLeadership()` rejecting with `NOT_ALLOWED` clears `takeBackAvailable` "before rejecting". If the reply arrives after the client moved to another group (leave and join), an unguarded clear could patch the wrong group's snapshot. Fail-safe (only withdraws), so Low. | Clear only when the active group is still the one the request was sent for (`groupId` captured at call time) and `status === 'active'`; test leave-then-reply. |

Not findings (checked):

- **P3 direction.** `leader.changed` and `NOT_ALLOWED` can only set
  `takeBackAvailable` to `false`; only the server's `takeback.offered` sets it
  `true`. Plan section 3 is correct: every leader change rewrites
  `displacedLeaderId` and sends `leader.changed` to the holder. Withdraw-only
  is fail-safe even if a case were missed (the server still answers
  `NOT_ALLOWED`).
- **P4.** `SyncState.leaderState` is `null` whenever `leadingGroupId` is
  `null` (`store.ts`), so `useHandoffMode()` is `null` for members and the
  vice by construction. It must return the enum only, never the
  `LeaderState` object (which holds the block list): R18.
- **Roster gating.** `useRoster()` is `EMPTY_LIST` unless leading; members and
  the vice never receive a roster from the server either.
- **Q-A1 storage.** A leader who returns as a member through `#admitted`
  gets `saveToken(reply.token, undefined, ...)`: the leader token and its
  recovery data (codes) are replaced. The reader's "last role seen" is in
  memory only.
- **Remove and codes rotation.** Removal rotates codes and revokes tickets on
  the server; a stale QR still on screen fails closed. 8a's `codesChanged`
  handler shows the new codes. No new path.
- **AC57.** Strip-then-notify order kept; `onIgnored()` carries nothing; the
  signal is a counter; no join from `hashchange` (Q7). COOP `same-origin`
  prevents a cross-origin opener from driving `hashchange`.
- **E2E fixture** `apps/reader/e2e/fixtures/apps.lifecycle.json` with the
  public `dev-app` key: the sync server refuses a dev key unless `NODE_ENV` is
  exactly `development` or `test` (`checkDevKeys`), so the file cannot work in
  production. It is in the Docker build context (not under `config/`, so
  `.dockerignore`'s `**/config/apps*.json` doesn't exclude it) but only in
  build stages; the runtime images copy `dist`/`dist-server` or the
  `pnpm deploy` output of the server. Fine.
- **Dependencies, CSP, Permissions-Policy, storage, server, tokens:** none
  changed. `pnpm audit --audit-level=high` stays in CI.

## 4. Required controls (part of the plan)

#24 R1-R14 and #19 C1-C11 still apply unchanged. New for 8b:

- **R15 Names and roster data.** Every display name (roster rows, remove
  title, `errViceAway`, `errPersonGone`, announcements) is a React text child
  through `PlainText` or a string with FSI/PDI; translated templates are split
  around `{name}` and the name is never passed through `format` into a string
  that becomes markup; announcement strings use single-pass `format` (#24
  R7/L9) and strip `\p{Bidi_Control}` from the name before wrapping (L1). No
  name or participant ID in any `aria-label`, `title`, `data-*` or element
  `id` (L5); accessible names come from `aria-labelledby` to rendered text.
  Tests: `<b>x</b>`, `{n}`, U+202E, U+2069, `דנה (Dana)`, 32-char Arabic.
- **R16 Leader-only UI follows the snapshot role.** Roster, People view,
  counter, codes, QR, approval tray, vice/remove/lock controls, remove and
  rotate confirmations, keep-alive card and preview banner render only under
  `isLeader` from the current snapshot (or hooks that are empty for
  non-leaders), in the same render as the role change; never from
  reader-local flags (`lastRole`, dialog state). On demotion (`leadershipLost`
  and the Q-A1 `rejoined` path) reader-local leader state is cleared:
  `pendingRow`, remove-dialog target, row refs by ID, `'people'`/`'leader'`
  sheet views. Tests per AC47 reason including `superseded` and the Q-A1 path;
  after the Q-A1 path `sessionStorage` holds a member token with no recovery
  data.
- **R17 Take-back.** Card shown only from `useLeadership().takeBackAvailable`
  (server-driven) and the reader's own suppression rules (Q-A2, `declined`);
  the reader never shows it from a reader-local guess. Reader suppression is
  UX only: the server follow-up issue of M1 is opened before Gate 3.
- **R18 Package changes.** P3: only ever sets `takeBackAvailable` to `false`;
  the `NOT_ALLOWED` clear is guarded by the request's `groupId` and an active
  group (L6); no new log event or log field. P4: `useHandoffMode()` returns
  `'auto' | 'frozen' | null` only, derived from `leaderState?.handoff`;
  `null` for members and the vice (tested).
- **R19 No logging (AC54).** No `console.*` (ESLint `no-console` stays an
  error), no logger passed to the client, no error forwarding; the console-spy
  test covers roster, vice, remove, lock, preview (start, move, bring,
  return), keep-alive, now leading, lost (both paths), take-back, leader
  changed and QR pasted. Server error `message` text is never shown; errors map
  through `leaderActionError` only.
- **R20 Pasted QR link (AC57).** `stripLaterTickets` calls `takeQrTicket`
  (strip with `replaceState`) **before** `onIgnored()`, which takes no
  arguments; the signal holds a counter only; the ticket is never stored,
  logged, announced, rendered, or used for a join; the notice text has no part
  of the link. Tests: hash empty after the event, ticket in no DOM text or
  attribute, no `joinByQr` call, a throwing listener doesn't stop the strip.
- **R21 Preview (AC41).** `pageChanged` routes by the core's live preview
  state (L3); `updatePosition` is called only when not previewing and the
  page differs from the group's; `bringGroupHere()` is the one send; the
  preview position is never stored (`sessionStorage` unchanged) or logged.
  Recording-fake tests as planned plus the L3 race tests.
- **R22 Server-sourced durations.** `retryAfterMs` and `countdownMs` clamped
  and validated (L2).
- **R23 E2E lifecycle stack.** `apps.lifecycle.json` holds exactly one app:
  `dev-app` with the committed public dev key, `disconnectGraceSeconds: 5`,
  `defaultHandoff: "auto"`, and no other relaxed limit; no other key-like
  value. The second sync server runs with `NODE_ENV=development`, a random
  `TOKEN_SECRET` per run, `HOST=127.0.0.1`; the second TCP proxy and its
  `/cut/...` control endpoint bind `127.0.0.1` only and parse `<ms>` as a
  bounded integer. No artifact upload change (#24 R11). Nothing under `e2e/`
  is imported by `src/`.
- **R24 No change to headers, storage, dependencies.** CSP and
  Permissions-Policy unchanged; no `style=` attributes (keep-alive bar via
  CSSOM `setProperty`); inline SVG icons only; no new `package.json`
  dependency in any package; lockfile unchanged except workspace metadata.

## 5. Open user questions: security effect

| Question | Recommended | Alternative | Security effect |
|---|---|---|---|
| Q-A1 lead lost while away | Lost-lead banner then take-back card | Card only, no banner | None either way. The banner is generic (no names). Requirement for both: R16 teardown runs on the `rejoined` path too, and the "last role seen" stays in memory. PASS. |
| Q-A2 take-back after a `take_back` loss | Card only after a handoff loss + server follow-up issue | Card whenever `takeBackAvailable` | Equal on the server side: the ping-pong right exists either way (M1) and a scripted client can use it. The recommendation reduces accidental ping-pong in the UI. The **server follow-up issue is required in both cases** (R17). PASS. |

## 6. What code mode will check

- gitleaks over the PR commits (the dev key in `apps.lifecycle.json` is the
  known public value; anything else key-like is a finding); semgrep on changed
  files; `pnpm audit --audit-level=high`.
- R15-R24 and #24 R3, R5, R7, R9, R12 file by file:
  `packages/client/src/client.ts` (P3 handlers, guard, no log), 
  `packages/react/src/hooks/leader.ts` and `index.ts` (P4),
  `apps/reader/src/group/{use-leadership-flow,use-preview-mode,banners,use-banner-slot,roster-view,leader-errors,use-retry-wait,keep-alive,pasted-link,deep-link,names,announce,follow,use-follow}.ts`,
  `GroupReading.tsx`, `GroupLibrary.tsx`, `main.tsx`, `App.tsx`,
  `SyncRoot.tsx`, `context.ts`, `components/group/{People,LifecycleCards,NowLeadingDialog,BannerSlot,PreviewBanner,ConfirmDialog,LeaderViews,controls}.tsx`,
  `LiveAnnouncer.tsx`, i18n templates with `{name}`, e2e helpers and the
  fixture.
- Grep: no `console.`, no `dangerouslySetInnerHTML`, no `style=`, no
  `localStorage`, no name or participant ID in `aria-label`/`title`/`id`;
  no `sessionStorage` write outside `session-store.ts`; `package.json` and
  `pnpm-lock.yaml` dependency diff empty; `headers.ts` unchanged.
- Tests exist for: P3 (both clears, guard, `RATE_LIMITED` keeps), P4 `null`
  for non-leaders, AC47 teardown per reason and Q-A1 path (including storage),
  AC41 recording fake plus the L3 race, AC51 fixtures plus U+2069, AC54
  console spy over every new flow, AC57 strip-first and no-data callback, L2
  clamps.
- M1: the server follow-up issue exists and is linked from the PR.
