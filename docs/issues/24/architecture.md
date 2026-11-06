# Architecture: #24 reading app sync UX: join and follow (PRD item 8a)

Inputs: `spec.md` (Gate 1 Q1-Q11, design decisions U1-U4), `design.md`
(sections 1-13, D1-D6), `docs/conventions.md`, ADRs 0001-0006,
`docs/issues/19/architecture.md` and `security.md` (C1-C11 still apply), and
the code in `apps/reader`, `packages/client`, `packages/react`,
`config/apps.*.json` and `compose.yaml` at `7acc53b`.

## 1. Repo layout

- Layout: **monorepo** (pnpm workspace `apps/*`, `packages/*`), no
  submodules (`git submodule status` is empty), no linked repos.
- One issue, one branch (`feat/24-reading-app-sync-ux`), one PR.

| Package | Path | Touched | Checks |
|---|---|---|---|
| Reader app | `apps/reader` | most of the work | `pnpm --filter @sync-system/reader typecheck test build`, new `test:e2e` |
| Core client | `packages/client` | 2 small additive changes (P1, P2) | `pnpm --filter @sync-system/client typecheck test build` |
| React bindings | `packages/react` | re-exports only (P2) | `pnpm --filter @sync-system/react typecheck test build` |
| Protocol | `packages/protocol` | none | |
| Sync server | `apps/sync-server` | **none** | its tests must stay green |
| Root | `compose.yaml`, `.github/workflows/ci.yml`, `docs/` | config, CI job, docs | `pnpm lint`, `pnpm audit --audit-level=high`, `docker compose config` |

## 2. Decisions

Three ADRs, status Proposed, for Gate 2:

| ADR | Choice | Recommendation | Runner-up |
|---|---|---|---|
| [0007](../../decisions/0007-qr-code-rendering-library.md) | QR rendering library | `lean-qr` 2.7.4 (MIT, 0 deps, 3.6 KB gz, active), drawn as React SVG | `qr` (paulmillr) |
| [0008](../../decisions/0008-end-to-end-browser-tests.md) | End-to-end browser test tool | Playwright Test, Chromium only, separate CI job | Vitest browser mode |
| [0009](../../decisions/0009-reader-group-session-storage.md) | Where tokens, group pointer and position live | All in `sessionStorage` (per tab) | Tokens in `localStorage` |

Decided in this plan without an ADR (no real alternative worth a record, or
fixed by an existing ADR): config variable names (section 4), the position
payload (section 6), `<dialog>` for modals (D2), no change to
`Permissions-Policy`, Trusted Types (#21) stays a separate follow-up
(section 5.3).

## 3. Approach

The reader gets one `SyncRoot` around the routes when sync is configured. It
renders the react package's `<SyncProvider options=... autoConnect=...>`
once per page load, so every route shares one client (react README: one
owned provider per app). Every sync call goes through `@sync-system/react`
hooks (item 7 AC19; the boundaries test keeps enforcing it).

Reader-specific logic lives in a new feature folder `src/group/` as **pure
modules** (position codec, follow reducer, phase derivation, storage codecs,
deep-link builder and parser, error mapping, name rules) plus a few hooks
that wire them to the package hooks. Components live in
`src/components/group/`. `ReadingScreen` and `LibraryScreen` only get slots
filled and a few props; the follow logic is not inside them.

The client connects lazily (design F0.3): at load only when a group pointer
or a QR ticket is present (`autoConnect` computed once at boot), otherwise on
the first Start or Join (`useConnection().connect()` from the user action).
A solo reader who never touches Group never connects (AC2-like behaviour
inside a configured deployment).

Alternatives rejected:
- **In-app route changes (SPA router) to keep one socket across library ->
  book (D4).** Item 7 fixed "one route per page load" and "no in-app book
  switching" (item 7 AC24, Decision Q4). Resume by token after a real
  navigation works (section 8) and keeps that rule; the indicator shows
  Reconnecting for well under a second locally.
- **Follow logic inside `ReadingScreen`.** It would mix group rules into the
  item 7 component and make the reducer hard to test; the reducer is pure and
  `ReadingScreen` stays presentational.
- **Server changes** (an Origin check, a reader dev key in `DEV_API_KEYS`,
  `guestNumber` in the join reply): none is needed; see Q-A1 and D5.

## 4. Sync configuration (AC1-AC4)

### 4.1 Environment variables

Sync is **on** exactly when `READER_SYNC_URL` is set (non-empty). Everything
else follows the item 7 rules in `src/config/schema.ts` (collect every
problem, one `ConfigError`, `Config error: <problem>` lines, exit 1; quote
only the offending reader variable, truncated; never the API key).

| Variable | Default | Rule |
|---|---|---|
| `READER_SYNC_URL` | unset (sync off) | WHATWG URL; `wss:`, or `ws:` only for `localhost`, `127.0.0.1`, `[::1]` (the client's own rule); no user name or password, no query, no fragment; path allowed (the server's is `/ws`). Stored as the parsed `href`. In `NODE_ENV=production` a `ws:` loopback URL gives a startup **warning** (like `READER_SRC_ORIGINS`). |
| `READER_SYNC_API_KEY` | required when the URL is set; error when set without the URL | 32-256 characters (the server's minimum and the client's maximum), visible ASCII `!`-`~` only. **Public by nature** (it ships in the bundle, Q9); never printed in errors (the message names the variable and the rule only). |
| `READER_SYNC_APP_VERSION` | the reader's version, `READER_VERSION` in `src/config/version.ts` (a test keeps it equal to `package.json`; works in both the Vite and the server build) | Semver `MAJOR.MINOR.PATCH[-pre][+build]`, at most 256 characters. Lets an operator match a server's `minAppVersion`; normally left unset. |
| `READER_SYNC_LATE_JOIN_SECONDS` | `10` | Integer 0-60 (Decision Q5). `0`: a late joiner jumps at once (no countdown). |

Rejected combinations (each a `Config error`): key without URL; URL without
key; any of the other two `READER_SYNC_*` without the URL.

### 4.2 Public config and browser validation

`PublicConfig` gains one field, built from an explicit field list in
`publicConfig()` (C5):

```ts
sync: { url: string; apiKey: string; appVersion: string; lateJoinSeconds: number } | null
```

`parsePublicConfig` validates it with the same rules (`z.strictObject`,
refined with the URL and key checks). The result becomes a small union:
`{ ok: true, config }`, `{ ok: false, reason: 'sync' }` (everything else
valid, only `sync` wrong) or `{ ok: false, reason: 'config' }`. `sync`
failure shows item 7's "This app isn't set up" screen with Details
`syncConfigInvalidDetails` (design F0.2); the server can't normally produce
it (it validated at startup), so this is defence in depth.

`sync: null` (AC2): no `SyncRoot`, no Group button, no "Join a group", no
socket, a QR fragment is stripped and ignored. Tested by asserting that no
`WebSocket` is constructed (a spy on the global) across all routes.

### 4.3 Client options built from it

```ts
{
  url: sync.url, apiKey: sync.apiKey, appVersion: sync.appVersion,
  storage: safeSessionStorage(),   // ADR 0009; 'memory' if sessionStorage throws
  // no logger (AC54), default reconnect and timeouts
}
```

### 4.4 Update required / protocol refused (AC4)

`useUpdateRequired()` drives the design 6.12 screens: `kind: 'app'` ->
"Update the app" (Details `minAppVersion` when given); `protocol` and
`server_unsupported` -> "Groups aren't available". Both replace the routes'
output (a full `StatusScreen`), never a half-rendered reading screen.
**Read without a group** sets a page-load flag `groupsDisabled` that hides
every group control and returns to the book on the same page (the client is
already `closed(fatal)`; nothing reconnects, react README rule). `INVALID_API_KEY`
and `HANDSHAKE_REJECTED` (also fatal) show `errSetup` in the sheet and
the indicator's not-connected state, with no retry button that loops (retry
goes through the core backoff).

### 4.5 Dev and compose (AC3, Decision Q9)

- `compose.yaml`, service `reader`: add `READER_SYNC_URL:
  ws://127.0.0.1:8080/ws` (the browser connects from the host to the
  loopback-published sync port), `READER_SYNC_API_KEY:
  dev-only-insecure-api-key-change-me-please` (the existing public dev key of
  the `dev-app` registration, see Q-A1) and commented
  `READER_SYNC_LATE_JOIN_SECONDS`. The reader image sets
  `NODE_ENV=production`, so it prints the `ws:` loopback warning; the comment
  says that's expected locally.
- `pnpm --filter @sync-system/reader dev` reads the same variables from the
  environment (the Vite plugin already uses `parseReaderConfig`).
- `config/apps.example.json` already has a reader-shaped entry
  (`reading-app`, methods A and D); the README points to it. With Q-A1
  option 1, `config/apps.dev.json` is unchanged.

## 5. Headers: CSP and Permissions-Policy (AC55)

### 5.1 CSP

One change: `connect-src` adds the sync server's **origin**.

```
connect-src 'self' <READER_SRC_ORIGINS...> <sync origin>
```

- Justification: the browser opens a WebSocket to the sync server, which is
  a different origin from the reader (other host or port); without it the
  CSP blocks the socket. `'self'` doesn't cover it.
- The origin is derived from the validated `READER_SYNC_URL`
  (`scheme://host[:port]`, `ws:` or `wss:`), re-checked and re-serialised in
  `server/headers.ts` like the `?src` origins (C2), so a malformed value can
  never add a directive. The path is not part of the source expression, so
  the whole server origin is allowed; that's the narrowest form CSP offers
  for WebSockets and the server listens only on `/ws` anyway.
- Nothing else changes: the QR is drawn as inline SVG elements created by
  React (no `img-src data:`, ADR 0007); countdown bars animate with CSS
  classes and a custom property set through the CSSOM
  (`element.style.setProperty`, which CSP allows), never a `style=` attribute
  in markup; no new script or style source.
- `securityHeaders(srcOrigins)` becomes `securityHeaders({ srcOrigins,
  syncOrigin })` for the server and the Vite preview server alike.

### 5.2 Permissions-Policy

**Unchanged**: `camera=(), microphone=(), geolocation=()`. There is no
in-app scanner (Q2); the phone's camera app opens the deep link. No wake
lock in 8a (design 4.5), so nothing to allow.

### 5.3 Trusted Types (#21)

Kept separate. `require-trusted-types-for 'script'` needs a check of every
React and Vite code path in a real browser; the e2e harness this issue adds
makes #21 easier afterwards, but folding it in here widens the risk of this
PR. Recommendation recorded for #21: reuse the e2e CSP-violation check.

## 6. Position payload (AC27, AC29)

The leader sends, and members accept, exactly:

```json
{ "v": 1, "pageIndex": 3 }
```

- `v`: payload version, the integer `1`. `pageIndex`: zero-based index into
  the loaded book's `pages` (the same index as `usePageNavigation`).
- Encoder `encodePosition(index)` in `src/group/position.ts` builds a fresh
  object with exactly these two keys (well under the 4096-byte default
  `maxMessageBytes`).
- Decoder `decodePosition(value, pageCount)` (untrusted input, C4 style):
  plain object (`isPlainObject`), exactly the keys `v` and `pageIndex` as own
  properties, `v === 1`, `pageIndex` a safe integer with `0 <= pageIndex <
  pageCount`. Anything else returns `null` and is **ignored**: no move, no
  prompt, no error, no log (AC29, design F7.5).
- Versioning: a breaking change bumps `v`. A reader accepts only versions it
  knows; an unknown `v` is ignored like a malformed value, so an old member
  never jumps to a misread page. Additive optional keys need a new `v` too
  (strict key set), so the format stays exact. It's documented in the reader
  README ("Group position format") as the reader's contract with other
  readers; the sync server never reads it.
- Members use only the group's official position: the snapshot's `position`
  of the active group (`usePosition()`), which the client updates from
  `position.updated`. A leader preview never sends a position (#13 AC30,
  client guarantee); the reader never calls `usePreview` in 8a. Tested:
  `client.preview.move()` on the leader produces no member prompt (AC27).
- Leader sending: on every page change of the leader's own screen (user turn
  or jump) while the group is `active` and the role is `leader`,
  `usePosition().updatePosition(encodePosition(index))`. The client's
  throttle coalesces fast turns (trailing send), so no reader throttle.
  `createGroup(metadata, encodePosition(currentIndex), options)` sends the
  starting page.

## 7. Reader-side group and follow state machine (AC21-AC31, AC50-AC53)

### 7.1 Phases (derived, `src/group/phase.ts`, pure)

`derivePhase(input)` from the snapshot (`useSyncSnapshot` via narrow
selectors), the join flow (`useJoinApproval().flow`), the update-required
value and reader-local state (resume status, compare result, ack,
`groupsDisabled`). One value drives the header indicator, the sheet's view
and which overlays exist:

| Phase | When | Indicator (design 5.2) |
|---|---|---|
| `off` | `sync: null` or `groupsDisabled` | none |
| `solo` | no group (`null`, `ended` after its notice) | Group |
| `blocked-update` | `useUpdateRequired()` non-null | screen 6.12 |
| `joining` | a create/join/QR call in flight | Joining… |
| `awaiting` | snapshot `awaiting_approval` | Waiting for approval |
| `resuming` | pointer present, resume not settled yet | Reconnecting… |
| `checking` | member admitted (active), compare not yet run | Reconnecting… (brief, synchronous in practice) |
| `mismatch-block` | compare `different-content` or `unsupported-schema` | Not following |
| `mismatch-warn` | compare `different-version`, not acknowledged | Not following |
| `member` | member, compare `match` or acknowledged | from `indicatorOf` + follow mode |
| `leader` | role `leader` | from `indicatorOf` (`leading`, `reconnecting`) |
| `disconnected` | connection `closed` (`gave_up`, or non-update fatal) with a pointer | Not connected |

Member indicator: `useSyncIndicator()` gives `following`, `reconnecting`,
`leader_offline`, `leader_grace`; when it is `following` and the follow mode
is `browsing`, the reader shows **Not following** (AC31). `leader_grace`
counts down from the group state's `leader.graceEndsAt` (local epoch ms the
client computed from the server's duration, AC53).

### 7.2 Follow reducer (`src/group/follow.ts`, pure)

State: `{ mode: 'following' | 'browsing', groupIndex: number | null,
jump: { index } | null, late: { index, deadline } | null }`.

| Event | Effect |
|---|---|
| `admitted { groupIndex, ownIndex, fresh, lateJoinMs }` (after `match` or Follow anyway) | no group position: `following`, stay. Same page: `following`. `fresh` (U1) or `lateJoinMs === 0`: `following` + `jumpTo(groupIndex)`. Else `late = { index: groupIndex, deadline: now + lateJoinMs }`, mode `following` pending (AC28). |
| `resumed { groupIndex, ownIndex, storedMode }` | `storedMode === 'browsing'` and pages differ: `browsing` + `jump` prompt (Decision Q3, no countdown). Else `following` + `jumpTo(groupIndex)` (silent, announced). |
| `groupMoved { index }` (decoded official position changed) | `following`: `jumpTo(index)`. `browsing`: `jump = { index }` (one prompt, latest page, never stacks, no timeout); if `index === ownIndex`: `following`, prompt gone. During `late`: update `late.index`, deadline unchanged (design F8). |
| `userTurned { ownIndex }` (button, key, swipe) | cancels `late`; `following` -> `browsing` (announce once); reaching `groupIndex` -> `following`, prompt gone. |
| `goToGroup` (Go to page N, Go now) | `jumpTo(groupIndex)`, `following`, prompts gone. |
| `stayHere` | `late` or `jump` closed, mode `browsing`; next `groupMoved` shows the jump prompt again. |
| `lateExpired` (timer) | `jumpTo(late.index)`, `following`. |

`jumpTo` is an output effect the hook performs with `nav.goTo(index)`
(so the page animation and "Page n of N" announcement work as for a normal
turn, design F7.3). The hook never feeds its own `goTo` back as
`userTurned`: `usePageNavigation` gets a `source` on each move
(`'user' | 'app'`) and an `onMove(index, source)` callback.

`fresh` (U1, spec refinement of AC28) = no `userTurned` since this page load
**and** no restored position for this book. A QR landing is always fresh.

The late countdown uses `performance.now()` deadlines and is re-evaluated on
every tick and on `visibilitychange`: if the tab was hidden past the
deadline, the jump happens when it is visible again (design 6.14, AC53).

### 7.3 Leader side

- Codes: `useLeaderCodes()` (codes only while leading, so AC13 holds by
  construction: the package drops them on demotion). Code changes:
  `useSyncEvent('codesChanged', e => notice(e.reason))` maps `rotated`,
  `door_failures`, `member_removed`, `superseded`, `resumed` to the design
  7.3 strings; `created` shows none (AC9).
- Rotation: `rotate.run()` after `ConfirmDialog` (AC10).
- Pause: `joinPaused.retryAt` (local epoch ms from the server's duration),
  countdown via `useCountdown` (AC11, AC53); "works again" notice on
  `joinResumed` or when it clears.
- QR: `useQrTicket({ enabled })` with `enabled = qrVisible &&
  documentVisible && isLeader` (AC12: not issued while hidden; re-issue
  handled by the package). The deep link is built from the ticket (section 9.2).
- Approvals: `useJoinRequests()` drives `ApprovalTray` (AC20): requests in
  arrival order, `approve.run(id)` / `deny.run(id)`, a withdrawn or timed-out
  request disappears because the package removes it on `joinWithdrawn`.
- End: `useGroupExit().end` after `ConfirmDialog` (AC32).
- Leader lost (8a rule, design F13): when `isLeader` turns false, the strip,
  panel, QR (and its timer, by unmounting the consumer) and tray unmount.

### 7.4 Join flows (AC14-AC19)

- Code entry: `normalizeJoinCode` + `classifyJoinCode` (re-exported, P2)
  decide the client-side field error before sending (`codeEmpty`,
  `codeFormat`). `useJoinByCode().run(code, { doorCode?, displayName? })`.
  `DOOR_CODE_REQUIRED` switches to the door-code view; `DOOR_CODE_WRONG`
  clears that field.
- Approval: `useJoinApproval().flow` (`waiting` with `expiresAt`, `denied`,
  `withdrawn`, `failed`) and `cancel.run()` (AC15).
- QR: section 9.
- Every error goes through one table `src/group/errors.ts`:
  `ClientErrorCode -> { key, focus, retryAfterMs? }`, exactly design 7.4,
  with `errServer` as the fallback for unknown codes (AC19). Messages are
  static strings plus a formatted duration; no code, ticket, server
  message or name is ever interpolated.
- Display names: `resolveDisplayName` (re-exported, P2) gives the same answer
  as the client and server (AC7): blank -> generated, `{ ok: false }` ->
  `nameInvalidChars` or, when the trimmed length is over 32 code points,
  `nameTooLong`. A server `INVALID_DISPLAY_NAME` maps to the same message.
  The field `maxlength` is `MAX_DISPLAY_NAME_INPUT_LENGTH` (128).
- Generated names (D5): the group state has `displayName` and `generated`.
  When `generated` is true and the name matches `^Guest ([1-9][0-9]{0,5})$`,
  the reader shows `format(t.guestName, { n })`; otherwise the raw name as
  plain text. No package or server change.
- Create form defaults (AC5): methods from `connected.joinMethods` (design
  6.3 defaults, A and B one checkbox plus radio so they can't combine). The
  handoff default is `connected.defaultHandoff` (P1), else `auto`. D6: the
  `auto` hint uses `limits.disconnectGraceSeconds` ("After {time}…", new key
  `handoffAutoHintTime`); the generic hint stays as fallback.

### 7.5 Content check (AC21-AC24)

After every admission (join, approval, QR, resume as member) and before any
position is applied: `compareContent(localMetadata, group.metadata)` (item 7,
unchanged). `match` -> follow; `different-version` -> `VersionWarnDialog`
unless the pointer's `ack` equals the leader's fingerprint (design F6);
`different-content`, `unsupported-schema` -> `MismatchBlock` (header and
`PageNav` hidden, positions ignored while blocked). The leader's content ID
on these screens comes from `parseLeaderMetadata` only (never the raw
object), shown with `PlainText`, `dir="ltr"`, isolated, truncated to 40
characters (AC24). Malformed metadata shows `mismatchMalformedDetails`.
"Open the group's book" (U2) appears only when the leader's content ID is a
bundled ID and the entry mode isn't `single-book`; it navigates to
`bookHref(id)` keeping the pointer (section 8.3).

### 7.6 Leave, end, group ended (AC32, AC33, AC37)

- Member leave: `useGroupExit().leave.run()`, no confirmation (U3).
- `useGroupEnded()` reasons map to design 7.8. `left` is `endedByYou` for the
  leader's own end and `leftGroup` for a member's leave (the reader knows
  which action it ran). `replaced` -> `endedReplaced`. `rejoin_failed`
  during a page-load resume -> `storedGroupGone`; later -> `endedRejoinFailed`.
  `closed` -> no notice. `removed` -> only `endedRemoved` (AC33).
- On any end except `closed`: forget the pointer (section 8), close sheets,
  prompts, tray and countdowns, move focus per design F12.3. The book stays
  open on the current page.

### 7.7 Focus, announcements, dialogs (AC52, D2)

- Modals use native `<dialog>` + `showModal()` through one `Dialog`
  component (`aria-labelledby`, Esc handling, focus return to the opener or
  to the article). `VersionWarnDialog` cancels Esc (`cancel` event
  `preventDefault`).
- jsdom's `<dialog>` support is partial: `test/setup.ts` adds a minimal
  `showModal` / `close` shim (toggles `open`, fires `close`). Inertness and
  real focus trapping are verified in the e2e suite (Chromium).
- Page-turn keys are ignored while a modal dialog is open or the target is
  inside one (extend `isEditable` in `use-page-navigation.ts`).
- Group announcements reuse the single polite `LiveAnnouncer` (design 9):
  `ReadingScreen` takes an `announce` channel so group messages and page
  announcements share one region; the page announcement wins when both
  happen at once.

## 8. Resume and `sessionStorage` design (AC34-AC37, ADR 0009)

### 8.1 Keys (all JSON, versioned, validated with zod on read; invalid is deleted)

| Key | Value | Written | Deleted |
|---|---|---|---|
| `sync-system:v1:<namespace>@<host>` | the client's token document (client-owned) | by the client | by the client |
| `reader:v1:group@<sync host>` | `{ v: 1, groupId: string (<= 256), mode: 'following' \| 'browsing', ack: string (64 hex) \| null, qrShown: boolean }` | on create, join, approval, QR join, resume success; on mode change, ack, QR toggle | on group end (any reason but `closed`), leave, end, resume failure with a "gone" code |
| `reader:v1:page:<contentId>:<fingerprint>` | `{ v: 1, pageIndex: number }` | on every page change (solo and in a group) | never (dies with the tab) |

`<sync host>` is the URL's `host`, so changing servers never resumes into the
wrong one. All access goes through `src/group/session-store.ts`, which
catches every storage exception (private mode, quota) and treats failure as
"nothing stored".

### 8.2 Page load

1. `main.tsx` (before anything else): QR fragment intake (section 9.1).
2. Book loads (item 7). The page index starts at the stored
   `reader:v1:page` value for this book when valid for its page count, else
   0 (`usePageNavigation(total, dir, ref, { initialIndex })`). Solo readers
   land on their page (AC36).
3. Pointer present -> `autoConnect` true and phase `resuming` (indicator
   Reconnecting… at once, no sheet, book readable).
4. On the first `connected`, `useStoredGroups().resume.run(groupId)` (no
   `checkTokens`). Results:
   - success, `active`: role leader -> `jumpTo(group position)` (group wins,
     AC36); member -> content check, then the `resumed` reducer event with
     the stored mode (Decision Q3);
   - success, `waiting` (member parked, leader recreating): Leader offline;
     page stays;
   - `TOKEN_NOT_FOUND`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `GROUP_ENDED`,
     `PARTICIPANT_BLOCKED`, `GROUP_FULL`: forget the pointer, one
     `storedGroupGone` notice, solo (AC37). Never retried;
   - network errors (`CONNECTION_LOST`, `REQUEST_TIMEOUT`, `NOT_CONNECTED`):
     retried on the next `connected`, at most 3 attempts per page load, then
     the `disconnected` phase with **Try again** (user action) and **Leave
     group**. No loop.
5. Phone lock without a reload: nothing in the reader; the client rejoins on
   its own (`rejoining` -> `active`, `rejoined` event). The reader treats
   `rejoined` like a resume for the member (content check is skipped when
   the metadata is unchanged; positions apply per the reducer). The leader
   stays leading with no prompt (AC35).

### 8.3 Library -> book (F4, U2) and other navigations (D4)

Before a deliberate navigation (`location.assign(bookHref(id))`), the reader
writes the pointer with `mode: 'following'`, calls
`useConnection().disconnect()` (closes the socket cleanly, tokens kept; the
resulting `ended(closed)` does not clear the pointer), then navigates. The
book page resumes by token as in 8.2, so membership carries over with no
visible re-join. The member arrives fresh, so it jumps straight to the
group's page (U1).

## 9. QR: deep link, intake and rendering (AC12, AC17)

### 9.1 Intake (`src/group/deep-link.ts`, called first in `main.tsx`)

- If `location.hash` starts with `#t=`: take the rest, then **immediately**
  `history.replaceState(history.state, '', location.pathname +
  location.search)`, before boot, before the book loads and before any error
  screen (design F5.3). This happens even when sync is off (then the ticket
  is dropped).
- The value is accepted only if `isQrTicketShape` (re-exported, P2: length
  <= 256, base64url pattern); otherwise it is dropped and the joiner gets
  `errQrInvalid` in the QR join view (only when sync is on).
- The ticket lives in memory only (a prop to `App`), is passed once to
  `useJoinByQr().run(ticket, { displayName? })` and is never stored, logged
  or put anywhere else (client README rule).
- If the route doesn't resolve to a reading page (book not found, fetch
  refused or failed), no join is attempted (design F5.5).

### 9.2 Deep link built by the leader

`buildJoinLink(origin, route, ticket)`:
`<origin>/?book=<encodeURIComponent(id)>#t=<ticket>` for a bundled book,
`<origin>/?src=<encodeURIComponent(url)>#t=<ticket>` for fetched content
(already allow-listed, Q4), `<origin>/#t=<ticket>` in single-book mode.
`origin` is `location.origin`. The ticket is only ever in the fragment
(#10 AC43). Unit-tested for each mode and for the fragment placement.

### 9.3 Rendering

`QrCodeView` calls `lean-qr`'s `generate(link, { minCorrectionLevel: M })`
inside `useMemo`, converts the bitmap to one SVG `path` `d` string (runs of
dark modules per row), and renders `<svg role="img" aria-label=...>` with a
4-module quiet zone, fixed QR colours (D1) and `shape-rendering="crispEdges"`.
States from `useQrTicket().state`: `loading` (`qrLoading`), `ready`,
`error`/`unavailable` (`qrError` / `qrErrorOnly`), and the leader's
`reconnecting` (`qrOffline`). A link that doesn't fit a QR code is caught
(`generate` throws) and shown as `qrError`.

## 10. Package additions (no server change)

| # | Package | Change | Why |
|---|---|---|---|
| P1 | `packages/client` | Add `defaultHandoff: HandoffMode` to the `connected` `ConnectionState` and to `ConnectedInfo` (copied from `hello.ok`, which already carries it). Additive; tests in `client.handshake.test.ts` and the snapshot/indicator tests. | Create form's handoff default (design 6.3, AC5) |
| P2 | `packages/client`, then `packages/react` | Re-export from `@sync-system/protocol`: `normalizeJoinCode`, `classifyJoinCode`, `isDoorCode`, `isQrTicketShape`, `resolveDisplayName` (+ type `ResolvedDisplayName`, `JoinCodeKind`), and the constants `MAX_JOIN_CODE_INPUT_LENGTH`, `MAX_DISPLAY_NAME_INPUT_LENGTH`, `MAX_DISPLAY_NAME_LENGTH`, `MAX_QR_TICKET_LENGTH`. Both READMEs list them; a package test checks the re-exports are the protocol's functions. | AC7, AC16, AC18, AC19: the reader must apply the client's exact rules before sending, and may import only `@sync-system/react` (item 7 AC19) |

Everything else the reader needs exists: `useCreateGroup`, `useJoinByCode`,
`useJoinByQr`, `useJoinApproval`, `useStoredGroups`, `useLeaderCodes`,
`useQrTicket`, `useJoinRequests`, `useGroupExit`, `useGroupEnded`,
`useLeaderStatus`, `useLeadership`, `usePosition`, `useSyncIndicator`,
`useConnection`, `useUpdateRequired`, `useSyncEvent`.

**Server changes: none.** Notes for the record (not blocking): the server
doesn't check the WebSocket `Origin` header (the API key is public, so it
wouldn't add protection; item 9 can revisit).

## 11. Files

### Create (`apps/reader`)

| Path | What |
|---|---|
| `src/group/position.ts` | `encodePosition`, `decodePosition` (v1 payload) |
| `src/group/follow.ts` | pure follow reducer (7.2) |
| `src/group/phase.ts` | pure phase derivation (7.1) |
| `src/group/session-store.ts` | safe `sessionStorage` wrapper, pointer and page codecs (zod), client `storage` adapter |
| `src/group/deep-link.ts` | `takeQrTicket(location, history)`, `buildJoinLink` |
| `src/group/errors.ts` | client error code -> message key, focus target, retry time |
| `src/group/names.ts` | name check via `resolveDisplayName`, generated-name localisation |
| `src/group/countdown.ts` | `useCountdown(targetMs, clock)` with `visibilitychange` recompute |
| `src/group/SyncRoot.tsx` | builds client options, `SyncProvider`, update-required gate, `groupsDisabled` |
| `src/group/use-group-session.ts` | resume, pointer writes, phase, ended handling |
| `src/group/use-follow.ts` | wires reducer to `usePosition` and page navigation; leader sending |
| `src/group/use-document-visible.ts` | visibility for `useQrTicket({ enabled })` |
| `src/components/group/GroupButton.tsx` (+ `.module.css`) | Group entry point and indicator (5.1, 5.2) |
| `src/components/group/CodeDisplay.tsx`, `CodeStrip.tsx`, `GroupPanel.tsx` (+ css) | leader codes (AC8-AC11) |
| `src/components/group/GroupSheet.tsx` (+ css) and views `StartView`, `CreateGroupForm`, `GroupReadyView`, `LeaderGroupView`, `MemberGroupView`, `JoinForm`, `DoorCodeView`, `WaitingView`, `QrJoinView`, `GroupBookMissingView` | sheet and its views |
| `src/components/group/CodeField.tsx`, `NameField.tsx` | inputs (AC7, AC18) |
| `src/components/group/QrCodeView.tsx` | QR rendering (ADR 0007) |
| `src/components/group/ApprovalTray.tsx`, `JumpPrompt.tsx`, `LateJoinPrompt.tsx` (+ css) | non-modal regions |
| `src/components/group/Dialog.tsx`, `ConfirmDialog.tsx`, `VersionWarnDialog.tsx`, `MismatchBlock.tsx` | modals and block screen |
| `src/components/group/UpdateScreens.tsx` | 6.12 screens on `StatusScreen` |
| `test/helpers/fake-sync-client.ts` | scripted `SyncClientLike` for component tests |
| `test/*.test.ts(x)` | see section 13 |
| `e2e/*.spec.ts`, `e2e/helpers/{servers,tcp-proxy,measure}.ts`, `playwright.config.ts`, `tsconfig.e2e.json` | e2e suite (ADR 0008) |

### Modify

| Path | Change |
|---|---|
| `apps/reader/src/config/schema.ts` | `READER_SYNC_*` parsing, `sync` in `PublicConfig`, `publicConfig`, browser schema, result union |
| `apps/reader/server/headers.ts` | `securityHeaders({ srcOrigins, syncOrigin })`, `connect-src` |
| `apps/reader/server/run.ts`, `plugins/library.ts` | pass the sync origin to the headers |
| `apps/reader/tsconfig.json` (+ new `tsconfig.e2e.json`) | include `e2e` in type checking |
| `apps/reader/src/config/version.ts` (new) | `READER_VERSION` constant, tested against `package.json` |
| `apps/reader/src/main.tsx` | QR intake first; pass ticket and pointer presence to `App` |
| `apps/reader/src/app/boot.ts`, `App.tsx` | config result union; `SyncRoot` around routes when sync is on; injectable client for tests |
| `apps/reader/src/components/ReadingScreen.tsx`, `ReaderHeader.tsx`, `ReadingScreen.module.css` | fill header slot, overlay, strip slot, panel column (>= 1024 px), shared announcer, hide header/nav when blocked |
| `apps/reader/src/navigation/use-page-navigation.ts` | `initialIndex`, move `source`, `onMove`, ignore keys in open modal |
| `apps/reader/src/components/LibraryScreen.tsx` (+ css) | "Join a group", in-group notice |
| `apps/reader/src/components/status-screens.tsx` | sync-invalid details |
| `apps/reader/src/i18n/en.ts`, `he.ts` | every design section 7 key, plus `handoffAutoHintTime` |
| `apps/reader/src/styles/tokens.css` | D1 tokens (design section 10 table) |
| `apps/reader/test/setup.ts` | `<dialog>` shim |
| `apps/reader/package.json` | dev deps `lean-qr` (exact), `@playwright/test` (exact); script `test:e2e` |
| `packages/client/src/state.ts`, `client.ts`, `index.ts`, `README.md` | P1, P2 |
| `packages/react/src/index.ts`, `README.md` | P2 re-exports |
| `compose.yaml` | reader sync env (4.5) |
| `.github/workflows/ci.yml` | `e2e` job (ADR 0008) |
| `eslint.config.js` | lint `apps/reader/e2e` (Node globals; the HTML-sink bans still apply to `src`) |
| `pnpm-lock.yaml` | two dev dependencies |
| `apps/reader/README.md`, `README.md`, `docs/conventions.md`, `docs/roadmap.md` | docs chunk |

## 12. Data model, contracts, Docker

- Data model: none (no database). Browser storage is section 8.
- Contracts: no new wire messages; the sync protocol is unchanged. New
  reader-level contracts: the position payload v1 (section 6), the deep link
  `/?book=|?src=...#t=<ticket>` (section 9.2), the env variables (section 4).
- Docker impact: **image unchanged** (new deps are dev-only and bundled;
  runtime still only zod). `compose.yaml` gets the reader's sync variables.
  `docker compose config` must pass.
- CI: new `e2e` job (install, Playwright Chromium, build, `test:e2e`),
  15-minute timeout, no secrets, read-only token, actions pinned by SHA like
  the `check` job.

## 13. Test plan per AC

Unit/component tests run in Vitest (jsdom) with the fake client unless
marked **e2e** (Playwright against the built reader server and a real sync
server, `config/apps.dev.json`, `NODE_ENV=development`).

| AC | Tests |
|---|---|
| AC1 | `config.test.ts`: each `READER_SYNC_*` rule, combinations, key never in messages, warning for `ws:` loopback in production; `server-*.test.ts`: CSP has the exact sync origin, re-serialised, absent when off; browser schema rejects a bad `sync` -> "isn't set up" with sync details |
| AC2 | `app.test.tsx`: `sync: null` on library, reading, QR fragment: no Group button, no "Join a group", `WebSocket` spy never constructed, fragment still stripped |
| AC3 | `docker compose config` (CI-less manual check in the PR) and README test (`readme.node.test.ts` lists the new variables) |
| AC4 | `update-screens.test.tsx`: `APP_VERSION_TOO_OLD`, `PROTOCOL_TOO_OLD`, `SERVER_UNSUPPORTED` screens, Read without a group returns to the same page with controls hidden, no reconnect |
| AC5 | `create-group.test.tsx`: options per allowed-method set, A/B never both, defaults need no choice, handoff default from `defaultHandoff`; client test for P1 |
| AC6 | `create-group.test.tsx`: fake client receives `toGroupMetadata(...)` unchanged and `encodePosition(current)` |
| AC7 | `names.test.ts` + form test: valid, 33 chars, control/bidi chars, blank -> generated, server `INVALID_DISPLAY_NAME`; nothing sent on invalid |
| AC8 | `code-strip.test.tsx`: per method set A, B, C, A+C, D-only; strip below 1024 px and panel above (matchMedia stub) |
| AC9 | `codes-notice.test.tsx`: each `codesChanged` reason, `created` silent, announced |
| AC10 | confirm dialog then `rotateCodes`, failure keeps old codes |
| AC11 | pause line from `joinPaused.retryAt` with fake timers, resumed notice |
| AC12 | `deep-link.test.ts` (each mode, ticket only in fragment); `qr-view.test.tsx`: `useQrTicket` enabled only when shown and visible, hidden state issues nothing, re-render on new ticket |
| AC13 | leader -> member transition removes strip, panel, QR, tray; member never renders codes |
| AC14 | `join.test.tsx`: `DOOR_CODE_REQUIRED` -> door view -> admitted; wrong door code clears field |
| AC15 | waiting view with countdown; approved, denied, timeout, cancelled (`cancelJoin` called) |
| AC16 | 8-char code lowercase, with dashes and look-alikes normalized by `normalizeJoinCode` |
| AC17 | `deep-link.test.ts`: intake strips the hash before anything else; valid, expired (`QR_EXPIRED`), invalid (shape and `QR_INVALID`); **e2e**: scan-link landing joins and URL has no fragment, `history.length` entry has none |
| AC18 | `code-field.test.tsx`: paste with spaces, `inputmode`, `dir="ltr"`, letters toggle |
| AC19 | `join-errors.test.tsx`: table-driven over every listed code, en and he, focus target, rendered text never contains the code or ticket |
| AC20 | `approval-tray.test.tsx`: several requests, show all, approve/deny, withdrawn disappears, focus moves to next or back, no focus steal, names as text |
| AC21 | `content-check.test.tsx`: compare runs before any `goTo` on join and resume (spy order) |
| AC22 | block screens for `different-content`, `unsupported-schema`, malformed; positions ignored while blocked; Open the group's book only when bundled and not single-book |
| AC23 | version warning: Follow anyway starts following; Leave leaves; ack remembered across a simulated reload |
| AC24 | leader content ID `<script>alert(1)</script>/x` renders as text, `ltr`, isolated, truncated |
| AC25 | follow reducer unit tests; **e2e**: member page changes within 1 s of the leader's move (measured, recorded in the PR) |
| AC26 | reducer + `jump-prompt.test.tsx`: browsing member gets one prompt, latest page, never moves alone, Stay here |
| AC27 | leader `client.preview.move()` in the fake produces no member event; reducer ignores anything but `usePosition` |
| AC28 | `late-join.test.tsx` with fake timers: countdown 10 s (config), Go now, Stay here, user turn cancels, leader move updates page not deadline, hidden-tab expiry jumps on visible; fresh joiner jumps with no countdown (U1); `0` seconds jumps at once |
| AC29 | `position.test.ts`: wrong `v`, extra keys, negative, non-integer, `>= pageCount`, arrays, prototype tricks -> `null`; component test: no move, no prompt, no throw |
| AC30 | `group-button.test.tsx`: every indicator state's text en/he and announcement; grace countdown from `graceEndsAt` |
| AC31 | browsing member shows Not following |
| AC32 | member leave without confirm; leader end with confirm |
| AC33 | ended notices per reason; `removed` shows only its line; book stays readable on the same page |
| AC34 | `resume.test.tsx`: pointer -> autoConnect -> `resumeGroup(groupId)` -> same role; **e2e**: `page.reload()` for a member and a leader returns without codes |
| AC35 | **e2e** through a TCP proxy in front of the sync server: cut the leader's connection for 25 s (under the 30 s grace, see Q-A3), leader returns still leading with no prompt, member saw Waiting for leader with a countdown |
| AC36 | `session-store.test.ts` codecs; solo reload restores page; member following returns to group page; member browsing returns to own page with jump prompt; leader returns to group page |
| AC37 | each "gone" code forgets the pointer and shows the notice once; network failure retries at most 3 times then Try again; no timer loop (fake timers) |
| AC50 | `i18n.test.ts` extended: every key in both catalogs; components render `dir` from the interface in `he` while content is `ltr`; codes, times, IDs isolated |
| AC51 | names `<b>x</b>`, `‮evil`, `דנה (Dana)`, mixed: text only, `bdi`/`dir="auto"` |
| AC52 | focus tests per design 9 table; prompts don't take focus; Esc rules; **e2e** keyboard-only create and join |
| AC53 | countdown tests with a mocked clock jump and `visibilitychange` |
| AC54 | `logging.test.tsx`: spy on every `console` method through create, join, resume, errors; nothing logged; reader server tests already assert no per-request logs |
| AC55 | CI green; `build-output.node.test.ts` still clean; **e2e** fails on any `securitypolicyviolation` event or CSP console error |
| AC56 | **e2e** `timing.spec.ts`: QR deep link to Following, and code entry (excluding typing, measured from submit) to Following, each under 15 s; leader move to member page under 1 s; numbers printed and copied into the PR |

## 14. Docs impact

- `apps/reader/README.md`: "Groups" section: sync variables with defaults
  and examples, the public API key note, dev setup with compose and
  `pnpm dev`, join flows (A-D, QR deep link with the ticket in the
  fragment), the position payload v1 contract, storage per tab (ADR 0009),
  CSP `connect-src` change, running `test:e2e`.
- `README.md` (root): compose now wires the reader to the sync server; link
  to the reader's Groups section.
- `packages/client/README.md`, `packages/react/README.md`: P1, P2.
- `docs/conventions.md`: rows for ADR 0007, 0008, 0009 (first chunk); the
  "no reading position across reload" rule updated (superseded by ADR 0009
  and AC36); commit scopes add `e2e`, `ci`, `compose` if used.
- `docs/roadmap.md`: item 8 row: issues #24 (8a) and #25 (8b), PR number.

## 15. Risks and edge cases

- **Phone lock longer than the grace.** The leader comes back as a member
  (auto handoff) or the group waits (frozen). With the default 30 s grace a
  30 s lock is a race (the reconnect backoff adds up to a few seconds); see
  Q-A3.
- **Half-open sockets after unlock.** A member listens only; a dead link is
  noticed when the OS reports it (client README). The indicator may show
  Following while stale until then. Out of scope (item 5's keep-alive is
  leader-side); noted for QA.
- **Duplicate tab** copies `sessionStorage`; the newer tab resumes and the
  older one gets `replaced` (design F11.7). Tested in e2e.
- **Long `?src` URLs** make dense QR codes; a link that doesn't fit shows
  `qrError` and codes still work.
- **StrictMode** double effects: the resume runs once per page load (a ref
  guard), the provider and QR controller already handle StrictMode.
- **jsdom `<dialog>`** shim could hide focus bugs; covered by e2e.
- **Ticket in history:** `replaceState` runs before React renders; the e2e
  test checks `location.hash` is empty right after load and that the ticket
  never appears in `document.referrer` of any request (`Referrer-Policy:
  no-referrer` already).

## 16. Security-sensitive areas

Security-sensitive: yes

- New dependency in the browser bundle (`lean-qr`, ADR 0007) and a dev
  dependency that downloads a browser in CI (`@playwright/test`, ADR 0008).
- CSP `connect-src` widened to the sync origin (`server/headers.ts`,
  `src/config/schema.ts`): origin derivation and re-serialisation.
- Public config injection gains `sync.apiKey` (public by design, Q9; the
  review confirms) and `sync.url` (`server/html.ts` escaping unchanged, C5).
- User input: join codes, door codes, display names (`CodeField`,
  `NameField`, `src/group/names.ts`); QR tickets from the URL fragment
  (`src/group/deep-link.ts`, `main.tsx`); positions and metadata from other
  users (`position.ts`, `compare.ts`); names from other users
  (`ApprovalTray`, plain text, isolated).
- Credentials in the browser: participant tokens and the group ID in
  `sessionStorage` (`session-store.ts`, ADR 0009); QR tickets in memory and
  in the leader's QR only; codes on the leader's screen only (AC13).
- Logging: no code, ticket, token, name, group ID or position in any log
  (AC54).
- The #19 controls C1-C11 still apply; C5's "no secret in the reader's env"
  holds because the API key is not a secret.

## 17. Implementer model

Implementer model: opus
Reason: security-sensitive, two new dependencies, package API additions, ~60
files, three ADRs, and a stateful follow/resume design with many edge cases.

## 18. Questions for the user (Gate 2)

Recommendation first in each.

- **Q-A1. Dev registration of the reader (Decision Q9).** Recommendation:
  the compose reader uses the existing `dev-app` registration in
  `config/apps.dev.json` (all methods A-D, its public dev key is already
  refused outside development and test), and `config/apps.example.json`
  keeps its existing `reading-app` entry as the reader's example; **no
  server change**. Alternative: add a separate `reader` entry with a new
  dev key to `apps.dev.json`; that needs a one-line **server change** (the
  new key added to `DEV_API_KEYS` in `apps/sync-server/src/config/dev-key.ts`
  plus its test), otherwise a committed key would be accepted in production.
- **Q-A2. ADR 0009, storage.** Recommendation: tokens, the group pointer and
  the position all in `sessionStorage` (per tab). "Closing and reopening the
  tab" (AC34) then works through the browser's reopen-closed-tab and tab
  restore, not by opening a brand-new tab. Alternative: tokens in
  `localStorage` so a new tab also returns, at the cost of tabs taking the
  group from each other and tokens persisting on the device.
- **Q-A3. Phone-lock length (Decision Q6).** Recommendation: test AC35 with a
  25 s drop against the default 30 s grace, and document that a deployment
  wanting a full 30 s lock to be safe sets the reader app's
  `disconnectGraceSeconds` to 45 (reconnect backoff needs a few seconds).
  Alternative: test exactly 30 s (flaky by design).
- **ADR 0007** (QR library: `lean-qr`) and **ADR 0008** (e2e: Playwright,
  Chromium only, separate CI job): accept as recommended, or pick the
  runner-up.

## 19. Implementation chunks

All in this repo, scopes per `docs/conventions.md`.

1. `docs(adr): accept 0007 0008 0009 and record them in conventions`
2. `feat(client): expose the app's default handoff mode on connect` (P1)
3. `feat(client): re-export join code, ticket and display-name helpers` (P2)
4. `feat(react): re-export join input helpers and limits` (P2)
5. `feat(reader): add sync settings and allow the sync origin in the csp`
6. `build(compose): connect the reader to the local sync server`
7. `feat(reader): add position payload v1 and per-tab session storage`
8. `feat(reader): strip qr tickets from the url fragment at startup`
9. `feat(reader): add the sync root with lazy connect and update screens`
10. `feat(reader): add group tokens, dialog primitives and the group button`
11. `feat(reader): add create group and the leader code strip and panel`
12. `feat(reader): render leader qr codes with lean-qr` (adds the dependency)
13. `feat(reader): add join by code, door code and approval waiting`
14. `feat(reader): add qr deep-link joining and joining from the library`
15. `feat(reader): add the leader approval tray`
16. `feat(reader): add content check, mismatch block and version warning`
17. `feat(reader): add following, jump prompt and late-joiner countdown`
18. `feat(reader): resume groups after reload and handle leave and end`
19. `test(reader): add playwright end-to-end checks against the sync server` (adds the dependency)
20. `ci: run the reader end-to-end checks`
21. `docs(reader): document groups, sync settings and the position format`

Each `feat(reader)` chunk carries its own unit/component tests and keeps
`pnpm lint typecheck test build` green.
