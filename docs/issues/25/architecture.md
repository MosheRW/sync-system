# Architecture: #25 reading app leader views and lifecycle prompts (PRD item 8b)

Inputs: `spec.md` (Gate 1 Q1-Q10, Gap 1, Gap 2, design decisions U5-U14),
`design.md` (sections 1-13, architect items D1-D9), `docs/conventions.md`,
ADRs 0001-0009 (all Accepted), `docs/issues/24/architecture.md` and
`security.md` (R1-R14 still apply), and the code at `e262a9b`:
`apps/reader`, `packages/client`, `packages/react`, `apps/sync-server`
(read only, to confirm server semantics).

## 1. Repo layout

- Layout: **monorepo** (pnpm workspace `apps/*`, `packages/*`), no
  submodules (`git submodule status` is empty), no linked repos.
- One issue, one branch (`feat/25-reading-app-leader-views`), one PR.

| Package | Path | Touched | Checks |
|---|---|---|---|
| Reader app | `apps/reader` | most of the work | `pnpm --filter @sync-system/reader typecheck test build`, `test:e2e` |
| Core client | `packages/client` | one small behaviour fix (P3, Gap 1) | `pnpm --filter @sync-system/client typecheck test build` |
| React bindings | `packages/react` | one new hook (P4) | `pnpm --filter @sync-system/react typecheck test build` |
| Protocol | `packages/protocol` | none | |
| Sync server | `apps/sync-server` | **none** (confirmed in section 3) | its tests stay green |
| Root | `docs/`, `.github/workflows/ci.yml` (unchanged), `compose.yaml` (unchanged) | docs | `pnpm lint`, `pnpm audit --audit-level=high` |

## 2. Decisions

**Decisions: none open.** No new dependency, no new storage, no styling or
transport choice: everything fits accepted ADRs 0001-0009. The technical
choices below are made in this plan (no real alternative worth an ADR) and
shown at Gate 2; the user questions are in section 17 (Q-A1, Q-A2).

| Item | Decided here |
|---|---|
| D1 banner slot | New `banner` slot in `ReadingScreen` plus a pure controller `src/group/banners.ts` (section 6) |
| D2 keep-alive copy | (a) handoff mode from a new react hook `useHandoffMode()` (P4); (b) reader-side "last chance" hint (section 8.3); (c) "someone else here" from `useRoster()` |
| D3 preview at a page | `usePreview().start(encodePosition(ownIndex))`, called when the now-leading dialog is dismissed (section 7.3) |
| D4 assertive channel | Second visually hidden region in `LiveAnnouncer`, `aria-live="assertive"` (section 6.4) |
| D5 name in the remove title | `ConfirmDialog.title` widens to `ReactNode` (`Dialog` already takes one) |
| D6 generated names | `rosterNameText(entry)` in `names.ts` from `generated` + `guestNumber`, no regex on roster entries |
| D7 row order | The roster array's own order (server admission order), never sorted by `joinedAt` (section 7.1) |
| D8 AC57 on the library | Yes: one in-memory signal reaches both pages (section 10) |
| D9 mismatched new leader | The reader keeps the last member-side content check result and ack in a ref; read at `nowLeading` (section 8.4) |
| E2E timers (spec Q8) | A second sync server for the lifecycle spec with `disconnectGraceSeconds: 5`, leader cut for 12 s (section 13.2) |

## 3. Server semantics confirmed (read only, no change)

**(a) Any later leader change invalidates an old take-back offer.** The
take-back slot is `record.displacedLeaderId`; `leader.takeBack` succeeds only
for that participant, else `NOT_ALLOWED`
(`apps/sync-server/src/lifecycle/leader-controls.ts` `takeBack`). Every
change of leader rewrites the slot:
- a handoff or take-back sets `displacedLeaderId: old` (the leader just
  replaced) in `lifecycle-service.ts` `handoff()`;
- a leader recovery (`superseded`) sets `displacedLeaderId: undefined`
  (`group-service.ts`, supersede path);
- the slot also goes when the holder leaves or is blocked (`group-service.ts`
  RC4, L3).

Every one of those leader changes sends `leader.changed` to every attached
participant except the new and the old leader (`announce()`, and the
supersede loop). A holder of an older offer is neither, so it gets
`leader.changed` and its slot is gone. The Gap 1 fix (P3) is therefore
exact: on `leader.changed`, the offer is stale.

Side finding (affects AC48, see **Q-A2**): `handoff()` also displaces the
interim leader on a **take-back** (`displacedLeaderId: old`, and
`leader.lost` carries `takeBackAvailable: record.displacedLeaderId === old`,
always true). So after the original leader takes the lead back, the interim
leader (often the vice) is offered take-back, and the two can pass the lead
back and forth (rate-limited per group). No server change is planned; the
reader decides what to show.

**(b) `keepalive.ack` is accepted during the inactivity pause.** When the
countdown runs out, `onDeadline` pauses the group (`pause(..., 'inactive')`)
and leaves `keepAlivePending: true`; the leader stays `record.leaderId` until
the grace ends. `keepalive.ack` goes through `asLeader` (passes: still the
leader), is free while a prompt is pending (`leader-controls.ts`
`leaderActivity`), and the facade counts it as activity
(`lifecycle.activity`), which ends an `inactive` pause (`unpause`, members get
`leader.online`) and answers the prompt (`keepalive.cleared`). After an
`auto` handoff it gets `NOT_LEADER` (the reader then follows AC47). Gap 2
stands: the leader gets no pause event; the run-out state is local.

Escalation (design F19 step 5): `record.escalated` is set only by a
`handoff_inactivity` and cleared by **any** counted activity of the new
leader (position update, `leader.activity`, `keepalive.ack`, any accepted
leader action). If still set when the next countdown ends, the group ends
with `inactivity` (no pause, no handoff).

**(c) The leader's client knows the handoff mode.** `LeaderState.handoff`
arrives with `group.created`, `group.resumed` (leader) and `leader.granted`
(`packages/protocol/src/messages.ts`, `LeaderState`), and the client keeps it
(`getLeaderState().handoff`, also after a handoff or take-back:
`#leaderData.reset(groupId, message.state)`). The react store has it in
`SyncState.leaderState`, but **no public hook exposes it**; P4 adds one.

Also confirmed:
- **Successor rule** (`succession.ts`): the vice if connected, else the
  earliest admitted connected member; never the displaced leader. The
  reader's "someone else here" (D2c) uses connected roster entries other
  than itself; it can't exclude the displaced leader (not on the wire), so
  the `auto` run-out line can be optimistic in that one case (risk, section
  15).
- **A displaced leader returning after a drop** resumes as a **member**
  (`resume.ts` `classifyToken`: the role comes from the record) and gets
  `takeback.offered`; the client emits `rejoined` with `role: 'member'`, not
  `leadershipLost`. The reader handles this (section 8.2, **Q-A1**).
- **Roster order** (D7): the server keeps admission order; the client keeps
  it (`LeaderData` is a `Map`; `roster.updated` replaces in place, new
  entries append). `joinedAt = now() - joinedAgoMs` is recomputed on every
  frame, so it jitters by network latency and shifts on every snapshot: it
  must not be a sort key.

## 4. Package additions

| # | Package | Change | Why |
|---|---|---|---|
| P3 | `packages/client` | (1) On `leader.changed` for the active group, if `takeBackAvailable` is true, set it to false (snapshot update; `leaderChanged` still emits after it). (2) When `takeBackLeadership()` is rejected by the server with `NOT_ALLOWED`, set `takeBackAvailable` to false before rejecting. No type change, no new event, no new log field. Tests in `client.lifecycle.test.ts`: offer then `leader.changed` clears it; `NOT_ALLOWED` clears it; `RATE_LIMITED` keeps it; `leader.changed` without an offer changes nothing; `takeback.offered` after a clear sets it again. README: the `takeBackAvailable` paragraph states both rules. | Gap 1 (spec), AC48 |
| P4 | `packages/react` | `useHandoffMode(): HandoffMode \| null` in `hooks/leader.ts`: the handoff mode of the group this client leads (`SyncState.leaderState?.handoff`), `null` when not leading. Exported from `index.ts`; README hook table row; `readme.test.ts` and `package.test.ts` already check every runtime export is documented. Tests in `leader.test.tsx`: created, granted, resumed, demoted -> null. | D2(a): the keep-alive run-out line in `auto` mode |

Nothing else is needed from the packages: `useRoster`, `useViceLeader`,
`useGroupLock`, `useMemberRemoval`, `usePreview`, `useKeepAlive`,
`useLeadership`, `useSyncEvent` and `useConnection` cover the rest.

**Server changes: none.**

## 5. Approach

8a's `GroupReading.tsx` (about 1000 lines) only **wires**; the 8b logic goes
into pure modules and small hooks in `src/group/`, the views into
`src/components/group/`, as in 8a:

- **Pure:** `banners.ts` (slot controller), `roster-view.ts` (order, counts,
  row text), `keep-alive.ts` (card state and copy choice), `leader-errors.ts`
  (action error table), `follow.ts` (new `demoted` event).
- **Hooks:** `use-banner-slot.ts`, `use-preview-mode.ts`,
  `use-leadership-flow.ts` (now leading, lost, take-back, changed, vice, lock
  notices), `use-retry-wait.ts` (rate-limit wait, generalised from 8a's
  `useWaitLeft`).
- **Views:** `BannerSlot`, `PreviewBanner`, `People` (counter, list, view),
  `KeepAliveCard`, `TakeBackCard`, `NowLeadingDialog`.

Alternatives rejected:
- **Logic inside `GroupReading` / `ReadingScreen`.** Already too large; the
  priority, queue and drop rules (design 2.3) are only testable as a pure
  reducer.
- **One generic "notice queue" for banners and overlay cards.** The overlay
  card priority (design 2.2) hides and restores cards that each have their
  own state (countdowns); a single `useMemo` choosing the top card is enough
  there. Banners need a queue (waiting, dropping, auto-hide); cards don't.
- **Server-side "you lost the lead while away" event, a pause event for the
  leader, or no take-back offer after a take-back.** All need server changes
  (against the constraint); the reader handles them (sections 8.2, 8.5).
- **Sorting the roster by `joinedAt`.** Jitters (section 3); the array order
  is the admission order already.

## 6. Banner slot and announcements (D1, D4, design 2)

### 6.1 Slot

`ReadingScreen` gets `banner?: ReactNode`, rendered first in the reading
column (`<main>`), before `notices`, in a wrapper with `position: sticky;
inset-block-start: 0` (under the sticky header, and under the code strip,
which is inside the header). Same place in the blocked layout (only the
group-ended notice can show there). On >= 1024 px it stays in the reading
column, not the panel (design 2.1 note).

8a's group-ended / left / removed / stored-group-gone notice **moves** into the
slot (row 1). The leader's codes notice and the "joining works again" notice
stay where 8a put them (`notices` on phones, top of the panel on large
screens).

### 6.2 Controller (`src/group/banners.ts`, pure)

```ts
type BannerRow = 1 | 3 | 4 | 5 | 6;            // design 2.3; row 2 (preview) is a mode, see below
type Banner =
  | { row: 1; kind: 'ended'; text: MessageKey }
  | { row: 3; kind: 'lost'; reason: LeadershipReason }          // sticky, warning
  | { row: 3; kind: 'refused' }                                 // sticky, warning (takeBackNotAllowed)
  | { row: 3; kind: 'changed'; reason: LeadershipReason }       // info, auto-hide
  | { row: 4; kind: 'vice'; on: boolean }                       // info, auto-hide
  | { row: 5; kind: 'lock'; locked: boolean }                   // info, auto-hide
  | { row: 6; kind: 'qr-pasted' };                              // sticky (U8)
interface BannerState { current: (Banner & { id: number }) | null; waiting: Partial<Record<BannerRow, Banner & { id: number }>>; nextId: number }
type BannerEvent =
  | { type: 'show'; banner: Banner }
  | { type: 'dismiss'; id: number } | { type: 'expire'; id: number }
  | { type: 'context'; ctx: { isLeader: boolean; isVice: boolean; locked: boolean; inGroup: boolean } }
  | { type: 'clear-member-notices' };          // now leading (design 2.5)
```

Rules (exactly design 2.3, 2.4):
1. `show` with a row number **<=** the current's (higher or equal priority)
   replaces it at once; the replaced one is discarded.
2. A lower-priority `show` waits, at most one per row (the latest replaces
   the waiting one of its row).
3. When the current goes (`dismiss`, `expire`), the highest waiting one
   shows.
4. `context` drops waiting and current banners that are no longer true:
   `lock` whose `locked` differs from the context; `vice` whose `on` differs
   from `isVice` or when `isLeader`; every row 3-5 banner when `isLeader`;
   everything except `qr-pasted` when `!inGroup` and the current isn't the
   ended notice (row 1 is the notice *of* the end).
5. **Preview** is not in the queue: the slot shows `current` if its row is 1,
   else the preview banner while `preview.active`, else `current`. Anything
   queued under preview waits (its auto-hide clock doesn't run).

`use-banner-slot.ts` holds the reducer (`useReducer`), feeds `context` from
the snapshot on every change, and returns `{ shown, show, dismiss, expire }`.
Each `show` also announces the banner text once (polite), except `ended`,
which 8a already announces.

### 6.3 Auto-hide (info notices only)

`NoticeBar` gains `autoHideMs?: number` and `onAutoHide?: () => void`. It
counts **visible time only** on `performance.now()`: the clock runs while the
document is visible, the pointer is not over the bar and focus is not inside
it (`pointerenter/leave`, `focusin/focusout`, `visibilitychange`), and is
checked by a 250 ms interval and on each of those events. 15 s for
`changed`, `vice`, `lock`; sticky notices pass no `autoHideMs`. No visual
timer. Reduced motion: no slide. `NoticeBar` also gets `tone="warning"`
(exists) for `lost` and `refused`.

### 6.4 Assertive announcements (D4, U13)

`LiveAnnouncer` renders a second visually hidden `<div aria-live="assertive"
aria-atomic="true">` (no `role="alert"`, so it doesn't double-announce).
`ReadingScreen` gets `announceAssertive?: { text, id } | null`, written into
it like the polite one. `use-announcer.ts` (8a `announce.ts`) gets a second
`announceAssertive` setter. Used only by the keep-alive card on appearance
and at run-out (design 9.2).

## 7. Leader views

### 7.1 Roster (AC38, AC39, AC61; design F14, 6.1-6.3)

`src/group/roster-view.ts` (pure):
- `orderRoster(roster)`: the entry with `role === 'leader'` first (only the
  leader ever has a roster, so that is the own row), then the rest **in array
  order**. Never re-sorted by state, role or `joinedAt` (U10, D7).
- `countRoster(roster)`: `here` = `connected && role !== 'leader'`, `away` =
  `!connected` (pending joiners aren't on the roster). Counter text key:
  `peopleCounter`, `peopleCounterNoAway`, `peopleCounterEmpty`.
- `rowDetails(entry, t)`: role, state and "Auto name" parts for line 2.

`names.ts`: `rosterNameText(entry, t, format)`: `generated` with a
`guestNumber` -> `format(t.guestName, { n })`; `generated` without one ->
`t.guestNameUnknown`; else `entry.displayName` verbatim. No regex on roster
entries (D6). The own-name helper `ownNameText` stays for `GroupState`
(which has no `guestNumber`).

Views (`src/components/group/People.tsx`):
- `PeopleCounter` (strip, < 1024 px): text button, numbers in `<bdi>`
  formatted with `Intl.NumberFormat(uiLang)`; not rendered until the first
  roster arrives (an empty roster array from `useRoster()` before the first
  `roster.snapshot` is "loading": the own row is always on a real roster);
  opens the People view.
- `RosterList`: `<section aria-labelledby>`, heading, counter line, `<ul>`
  of rows as design 6.2. Names through `PlainText` (`dir="auto"`, 2-line
  clamp in CSS). Row toggle `<button aria-expanded aria-controls
  aria-labelledby="<name-id> <details-id>">`: the accessible name is built
  from the rendered name and details elements, **not** an `aria-label`
  string, so the name never leaves a text node (#24 R7). One row open at a
  time (state in the list). `admittedSinceRecovery` -> line 3 marker, list
  only.
- `PeopleView`: a `GroupSheet` view `'people'` (new `SheetView` value) with
  Back to `'leader'`; the panel shows `RosterList` as its **last** section.
- The roster renders only when `isLeader` (the hook gives `[]` otherwise),
  so members and the vice never see it by construction.
- Live switch: 8a's `useMediaQuery(LARGE_SCREEN)` already drives strip vs
  panel; the counter lives in the strip and the list in the panel, so they
  switch with it. If focus was inside the panel list when it unmounts, focus
  goes to the counter (a `useLayoutEffect` in the list checks
  `contains(document.activeElement)` on unmount and calls a
  `focusCounter()` passed from `GroupReading`).

### 7.2 Leader controls (AC42-AC44, AC58; design F16-F18)

| Control | Hook call | Pending label | Where errors show |
|---|---|---|---|
| Make vice-leader | `useViceLeader().setVice.run(entry.participantId)` | `settingVice` | row action area |
| Remove as vice-leader | `clearVice.run()` | `clearingVice` | row action area |
| Remove from group | `useMemberRemoval().remove.run(participantId)` after the remove `ConfirmDialog` | `removing` | in the dialog |
| Lock / Unlock | `useGroupLock().lock.run()` / `unlock.run()` | `locking` / `unlocking` | under the button |

- `participantId` always comes from the **current roster entry** the row was
  rendered from, never from text. The action is offered only while that
  entry is on the roster; a row that disappears closes its action area and
  any open remove dialog for it (dialog closes with `errPersonGone` above the
  list, design 6.6/F17).
- `ActionState` is per action, not per row: the list keeps `pendingRow`
  (participant ID) to show the spinner on the right row and `aria-disabled`
  its siblings.
- Away member: **Make vice-leader** is `inactive` with `makeViceAway`
  (`aria-describedby`).
- The remove dialog title is `<>{before}<PlainText text={name} dir="auto"
  maxLength={32} />{after}</>` from `removeTitle` split on `{name}` (D5:
  `ConfirmDialog.title: ReactNode`).
- After a successful remove, focus moves to the next row toggle, else the
  previous, else the People heading (refs by participant ID). 8a's
  `codesChanged` handler already shows `codesMemberRemoved`.
- Announcements (polite): `announceVice` (name wrapped in U+2068/U+2069
  isolates in the string), `announceViceCleared`, `announceRemoved`,
  `announceLocked`, `announceUnlocked`.
- Lock line: `lockedLeaderLine` in `CodeStrip`, `LeaderDetails` (panel and
  leader sheet), from `useGroupLock().locked`; new leaders see the inherited
  state with no notice (F18.5).

**Error table** (`src/group/leader-errors.ts`, pure, design 7.10-7.11):
`leaderActionError(action, error) -> { key, params?, retryAfterMs?, close? }`
with `action` one of `setVice | clearVice | remove | lock | unlock | bring |
keepAlive | takeBack`. Common rows: `NOT_LEADER` -> `errNotLeader`
(`close: true` when the control is already gone); `NOT_CONNECTED`,
`CONNECTION_LOST`, `REQUEST_TIMEOUT` -> `errNetwork`; `RATE_LIMITED` ->
`errRateLimited` with `retryAfterMs` from `details` (else the no-time
variant); `NOT_IN_GROUP` -> no message; unknown -> `errServer`. Action rows
exactly as design 7.11. Names in `errViceAway` / `errPersonGone` are rendered
like the remove title (split around `{name}`, `PlainText` for the name), never
interpolated into a string that becomes markup.

`use-retry-wait.ts`: from a `retryAfterMs`, a local deadline
(`performance.now()`), a ticking countdown that recomputes on
`visibilitychange` (AC53); the action's button is `inactive` until 0, then
the message becomes `canTryNow` (8a). 8a's `useWaitLeft` is reimplemented on
it (same behaviour, tested by the existing join tests).

### 7.3 Preview mode (AC40, AC41; design F15, U6, U7, U14)

`src/group/use-preview-mode.ts` wraps `usePreview()`:
- `start()`: `preview.start(encodePosition(ownIndex))`. Nothing else is sent
  (the core sends a throttled `leader.activity`).
- **Page turns while previewing**: `GroupReading.pageChanged` checks a ref of
  `preview.active`; if active it calls `preview.move(encodePosition(index))`
  and **not** `updatePosition`.
- **Bring group here**: the core's `bringGroupHere()` ends the preview
  *before* sending, and its errors are synchronous. So the hook first checks
  `connection.status === 'connected'` and `isLeader`; if not, it shows
  `errNetwork` / `errNotLeader` in the banner and keeps the preview. Then it
  calls `bringGroupHere()`; on `{ ok: false }` it restarts the preview at the
  same page (`start(sameEncodedPosition)`) and shows the error. On success the
  page is already the target: no jump, announce `announceGroupMoved`. There
  is no reply for a position update, so there is **no pending state**: the
  action completes synchronously (AC58 is met by "never fails silently";
  the design's "Moving the group…" label is not used). A server rejection of
  the update is retried by the core's throttle (it re-queues `RATE_LIMITED`).
- **Return to group**: `returnToGroup()` -> decode the returned position ->
  `jumpRequest(groupIndex)`; announce `announcePreviewOff`.
- **Leader sends only real moves** (needed for AC41 "none on Return to
  group"): `pageChanged` sends `updatePosition` only when not previewing and
  the decoded group position differs from `index`. This also removes a
  redundant send after 8a's leader resume jump (no behaviour change for
  members).
- Indicator: `indicatorFor` gets `previewing` for a leader with
  `preview.active` (new `IndicatorKind` `'previewing'`, `indPreviewing`,
  announcement `announcePreviewOn`; leaving preview returns to `leading`
  without "You're leading", design 6.11).
- Entry: "Preview pages" in `LeaderDetails` (sheet and panel) with hint; in
  the panel it reads **Return to group** while previewing.
- Not persisted (F15.7): nothing goes to `sessionStorage`; after a reload the
  leader lands on the group's page (8a rule).
- The core ends the preview on demotion and group end (`#dropLeaderOnly`);
  the reader just follows `preview.active`.
- **U7**: see 8.1. **U14**: see 8.2.

## 8. Lifecycle flows (`src/group/use-leadership-flow.ts`)

One hook subscribes with `useSyncEvent` to `nowLeading`, `leadershipLost`,
`leaderChanged`, `takeBackOffered`, `rejoined`, `viceChanged`,
`lockChanged`, and reads `useLeadership()`, `useViceLeader().isVice`,
`useGroupLock().locked`. It owns: the now-leading dialog state, the
take-back card state, the "declined" flag, the escalation hint, and it calls
the banner slot's `show`.

### 8.1 Now leading (AC46; F22, U7, U11)

On `nowLeading { reason }`:
1. Banner `clear-member-notices`; the follow hook is inactive (phase
   `leader`), so the jump and late-join prompts are gone; the member sheet
   closes (8a effect keyed on `isLeader`, extended to `'member'` and
   `'people'` views as needed).
2. Open `NowLeadingDialog` (`Dialog`, `role="alertdialog"`, focus on the
   heading `tabindex=-1`, Esc = Start leading). Text: reason line
   (`nowLeadingDisconnect` / `Inactive` / `TakeBack`), `nowLeadingWhat`; if
   `ownIndex !== groupIndex` (group index decoded from the snapshot position;
   `null` counts as same page) `nowLeadingOffPage` with both page numbers in
   `<bdi>`; if the last member-side check was a mismatch (8.4)
   `nowLeadingMismatch`. A second `nowLeading` while open replaces the reason
   in place.
3. The 8a "You're leading the group." announcement is suppressed for this
   transition (`leadingAnnounced` set before the indicator effect runs).
4. On dismiss: if off-page, `preview.start(encodePosition(ownIndex))` (U7,
   D3); focus returns to the previously focused element if still connected,
   else the article.

### 8.2 Lead lost (AC47; F20, U14)

On `leadershipLost { reason, takeBackAvailable }`:
- Leader UI unmounts by `isLeader` (8a), plus: keep-alive card (the store
  clears the prompt), preview (the core ends it), remove / rotate / end
  confirmations, `'people'` and leader sheet views.
- Banner `{ row: 3, kind: 'lost', reason }` (sticky, warning; texts design
  7.8). If focus was inside something that closed, focus goes to its
  Dismiss (`autoFocus`, 8a F12.3).
- Follow: the follow hook gets a new start event **`demoted { groupIndex,
  ownIndex }`** (follow reducer, pure): same page -> `following`; different
  page -> `browsing` with **no** prompt and no countdown; the next
  `groupMoved` shows the jump prompt (U14). `useFollow` re-runs its start
  effect when the role goes leader -> member for the same membership (it
  tracks the role it started for), so a former leader never inherits a stale
  follow state.
- Take-back: see 8.5.

**Lost while away (Q-A1).** A leader cut off past the grace comes back by
`rejoined` with `role: 'member'` and no `leadershipLost`. The hook keeps the
last role it saw per group; on `rejoined` with `role: 'member'` after
`'leader'` it runs the same steps with reason `handoff_disconnect`
(`lostDisconnect`: "You were away too long, so someone else is leading
now."), then the `takeback.offered` that follows opens the card. After a full
page reload the reader doesn't know the tab led before; the take-back card
still appears (its text says "You led this group before").

### 8.3 Keep-alive (AC45, AC53; F19, U13, D2)

`src/group/keep-alive.ts` (pure):
`keepAliveView({ prompt, remainingMs, handoff, othersHere, lastChance })` ->
`{ state: 'counting' | 'last-chance' | 'paused', titleKey, bodyKey }`.
- `remainingMs` from `useCountdown(prompt.deadlineAt)` (epoch from the
  server's `countdownMs`, recomputed every tick and on `visibilitychange`,
  AC53).
- `paused` when `remainingMs === 0` and not `lastChance`. Body:
  `keepAlivePausedHandoff` when `handoff === 'auto'` (P4) **and**
  `othersHere > 0` (connected roster entries other than the leader), else
  `keepAlivePausedWait` (also when `handoff` is `null`).
- **Last chance (D2b)**: `lastChance` is a reader-side hint: set on
  `nowLeading` with `handoff_inactivity`, cleared when this tab sends any
  leader activity (a position update, a preview start or move, a leader
  action, a keep-alive answer) and on any other leadership change. The
  server clears its flag on exactly those activities, and all of them come
  from this tab, so the hint can only be wrong in one direction: a throttled
  or failed `leader.activity` the hint counted while the server didn't.
  Then the card says "pauses" and the group ends; 8a's `endedInactivity`
  notice explains. With `lastChance`, the body is `keepAliveBodyLast` and
  there is no `paused` state (the card stays at 0:00 until `group.ended`).

`KeepAliveCard` (overlay, top priority): countdown text in `<bdi
dir="ltr">`, `aria-live="off"`; bar like 8a's late-join bar (CSSOM
`setProperty`, no `style=` attribute; none with reduced motion); **Keep
going** -> `useKeepAlive().answer.run()` (pending `keepingGoing`); success
-> the prompt clears by `keepalive.cleared`, announce `announceKeptGoing`.
Cleared by other activity -> the card closes silently. Errors inline; the
countdown keeps running. Assertive announcements: on appearance
(`announceKeepAlive` / `announceKeepAliveLast`, time in words) and once at
`paused` (`announcePaused`).

### 8.4 Mismatched new leader (D9, U11)

`GroupReading` already computes `compare` and `acknowledged` while the user
is a member. A ref `lastMemberCheck` stores `{ compare, acknowledged }` on
every member render. At `nowLeading` the dialog shows `nowLeadingMismatch`
when that was `different-content`, `unsupported-schema`, or
`different-version` without ack. Becoming leader ends the mismatch block and
the version warning by phase (`leader`), so header and `PageNav` return and
"End group" is available.

### 8.5 Take-back (AC48; F21, Gap 1)

- Card shown when `useLeadership().takeBackAvailable && !declined &&
  isMember` and the last loss reason (if this tab saw it) was not
  `take_back` (**Q-A2**, recommended).
- **Take the lead** -> `takeBack.run()` (pending `takingBack`). Success
  -> the core emits `nowLeading { take_back }` -> 8.1.
- **Keep following** -> `declined = true` for this group. `declined` is
  reset only by the next `leadershipLost` of this tab (a new offer after a
  later handoff asks again); a reconnect that re-sends `takeback.offered`
  for the same slot does not.
- Offer withdrawn: P3 sets `takeBackAvailable` false on a later
  `leader.changed`, on `NOT_ALLOWED`, and the core resets it on group end or
  leave. The card closes with no message of its own.
- `NOT_ALLOWED` -> card closes (P3) and banner `{ kind: 'refused' }`
  (sticky). `RATE_LIMITED` and network errors stay inline.
- Overlay priority (design 2.2): keep-alive > take-back > late-join >
  jump. A `useMemo` picks the one card to render. A hidden card doesn't need
  to stay mounted: the late-join state lives in the follow reducer and its
  countdown is deadline-based, so it comes back with the right time. So that
  it can still expire while hidden (design 2.2 item 3), the expiry timer
  moves out of `LateJoinPrompt` into `use-follow.ts` (small refactor; the 8a
  late-join tests keep passing).

### 8.6 Member notices (AC49, AC60, AC44 member side)

- `leaderChanged { reason }` -> `{ kind: 'changed', reason }` (info, 15 s).
  Texts per reason (design 7.8), never a name.
- `isVice` false -> true -> `{ kind: 'vice', on: true }`; true -> false
  while still a member -> `{ kind: 'vice', on: false }`; dropped when the
  user became leader (rule 4). Member sheet line `memberViceLine` while
  `isVice`.
- `lockChanged` while a member -> `{ kind: 'lock', locked }`; member sheet
  line `lockedMemberLine` while `useGroupLock().locked`.

## 9. State and flow overview

```
snapshot / events --> use-leadership-flow --show--> use-banner-slot (banners.ts) --> BannerSlot
                  \-> use-preview-mode ----------------------- preview.active ------/
                  \-> keep-alive.ts -> KeepAliveCard  \
                  \-> take-back state -> TakeBackCard  >-- one overlay card (2.2) + ApprovalTray
                  \-> use-follow (follow.ts) -> Jump / LateJoin prompts /
GroupReading.pageChanged: previewing ? preview.move : (index != group ? updatePosition : nothing)
```

## 10. Pasted QR link notice (AC57; F24, D8, Q7)

- `deep-link.ts`: `stripLaterTickets(win, onIgnored?)`: after
  `takeQrTicket` strips a `#t=` fragment on `hashchange`, it calls
  `onIgnored()` **with no arguments** (the ticket never leaves the
  function, R3). Unchanged order: strip first.
- `src/group/pasted-link.ts`: `createPastedLinkSignal()` -> `{ notify,
  subscribe, count }` (a counter, nothing else). `main.tsx` creates it,
  passes `signal.notify` to `stripLaterTickets` and the signal to `App`,
  which puts it into `GroupEnv` (new field `pastedLinks`).
- `usePastedLinkNotice()` (`useSyncExternalStore` on the counter): reading
  page -> banner `{ kind: 'qr-pasted' }` (row 6, sticky); library page ->
  a sticky `NoticeBar` above the in-group notice (`LibraryScreen.notice`).
- Only with sync configured (`GroupEnv` exists); with sync off the fragment
  stays silent (8a F5). Not shown while a mismatch block or status screen is
  up (no slot there; the counter is read again when the slot appears, so it
  shows then).

## 11. Files

### Create

| Path | What |
|---|---|
| `apps/reader/src/group/banners.ts` | pure banner controller (6.2) |
| `apps/reader/src/group/use-banner-slot.ts` | reducer hook, context feeding, polite announce |
| `apps/reader/src/group/roster-view.ts` | order, counts, row details (7.1) |
| `apps/reader/src/group/leader-errors.ts` | leader action error table (7.2) |
| `apps/reader/src/group/use-retry-wait.ts` | rate-limit wait for buttons (7.2) |
| `apps/reader/src/group/use-preview-mode.ts` | preview wiring (7.3) |
| `apps/reader/src/group/keep-alive.ts` | keep-alive card state and copy (8.3) |
| `apps/reader/src/group/use-leadership-flow.ts` | now leading, lost, take-back, changed, vice, lock (8) |
| `apps/reader/src/group/pasted-link.ts` | AC57 signal (10) |
| `apps/reader/src/components/group/BannerSlot.tsx` | renders the shown banner or the preview banner |
| `apps/reader/src/components/group/PreviewBanner.tsx` | design 6.4 |
| `apps/reader/src/components/group/People.tsx` | `PeopleCounter`, `RosterList`, `PeopleView` body |
| `apps/reader/src/components/group/LifecycleCards.tsx` | `KeepAliveCard`, `TakeBackCard` |
| `apps/reader/src/components/group/NowLeadingDialog.tsx` | design 6.8 |
| `apps/reader/test/banners.test.ts`, `roster-view.test.ts`, `keep-alive.test.ts`, `leader-errors.test.ts`, `pasted-link.test.ts` | unit tests |
| `apps/reader/test/people.test.tsx`, `leader-controls.test.tsx`, `preview.test.tsx`, `keep-alive-card.test.tsx`, `leadership-flow.test.tsx`, `banner-slot.test.tsx`, `qr-pasted.test.tsx` | component tests |
| `apps/reader/e2e/lifecycle.spec.ts` | AC59 (13.2) |
| `apps/reader/e2e/fixtures/apps.lifecycle.json` | `dev-app` with the public dev key, `disconnectGraceSeconds: 5`, `defaultHandoff: "auto"` |

### Modify

| Path | Change |
|---|---|
| `apps/reader/src/group/GroupReading.tsx` | wire the hooks: banner slot, roster, controls, preview routing in `pageChanged`, overlay card choice, now-leading dialog, remove dialog, ended notice into the slot, `'people'` sheet view |
| `apps/reader/src/group/GroupLibrary.tsx` | AC57 notice on the library |
| `apps/reader/src/group/follow.ts`, `use-follow.ts` | `demoted` start event; restart on role change; late-join expiry timer in the hook |
| `apps/reader/src/group/phase.ts` | `previewing` indicator |
| `apps/reader/src/group/announce.ts` | assertive setter; `previewing` announcement |
| `apps/reader/src/group/names.ts` | `rosterNameText` (D6) |
| `apps/reader/src/group/deep-link.ts`, `src/main.tsx`, `src/app/App.tsx`, `src/group/SyncRoot.tsx`, `src/group/context.ts` | `onIgnored` callback and the `pastedLinks` signal in `GroupEnv` |
| `apps/reader/src/components/ReadingScreen.tsx` (+ `.module.css`) | `banner` slot (sticky), `announceAssertive` |
| `apps/reader/src/components/LiveAnnouncer.tsx` | assertive region |
| `apps/reader/src/components/group/controls.tsx` | `NoticeBar` `autoHideMs` / `onAutoHide` (visible time) |
| `apps/reader/src/components/group/ConfirmDialog.tsx` | `title: ReactNode` (D5) |
| `apps/reader/src/components/group/LeaderViews.tsx` | `CodeStrip` counter and lock line; `LeaderDetails` preview, lock, People row (sheet) / section (panel) |
| `apps/reader/src/components/group/GroupButton.tsx` | `previewing` state |
| `apps/reader/src/components/group/GroupSheet.tsx` | `'people'` view support (Back) if not already generic |
| `apps/reader/src/components/group/Prompts.tsx` | late-join prompt no longer owns its expiry timer |
| `apps/reader/src/components/group/JoinViews.tsx` | `useWaitLeft` on `use-retry-wait` |
| `apps/reader/src/components/group/group.module.css` | banner, preview banner, roster rows, cards (existing tokens only) |
| `apps/reader/src/i18n/en.ts`, `he.ts` | every design section 7 key (8b) |
| `apps/reader/test/helpers/fake-sync-client.ts` | settable roster and leader state, `preview.bringGroupHere` / `returnToGroup` that record, `lastPending` for the new leader calls |
| `apps/reader/test/group-logging.test.tsx` | 8b flows added (AC54) |
| `apps/reader/test/i18n.test.ts` | new keys present in both catalogs (existing check) |
| `apps/reader/e2e/global-setup.ts`, `e2e/helpers/servers.ts`, `e2e/helpers/fixtures.ts` | second stack (lifecycle sync server, direct and proxied readers, its own proxy); `startSyncServer(port, configPath)`; `cut` by stack name |
| `packages/client/src/client.ts`, `test/client.lifecycle.test.ts`, `README.md` | P3 |
| `packages/react/src/hooks/leader.ts`, `src/index.ts`, `test/leader.test.tsx`, `README.md` | P4 |
| `apps/reader/README.md` | docs chunk (section 14) |

## 12. Data model, contracts, Docker, headers

- **Data model:** none (no database). **Browser storage: unchanged** (ADR
  0009). Nothing new is stored: not the preview position, not names, not
  the roster, not the declined offer, not banners.
- **Wire contracts:** no new messages; the sync protocol is unchanged.
- **Package API:** P3 (behaviour of `GroupState.takeBackAvailable`, no type
  change), P4 (`useHandoffMode()`), section 4.
- **Reader contracts:** the position payload v1 is unchanged; the preview
  uses the same encoder and never sends it as a position.
- **Docker impact: none** (no image, compose or env change). The e2e config
  file is test-only and holds only the already public dev key.
- **CSP and Permissions-Policy: unchanged.** No new script, style, image or
  connect source; the keep-alive bar uses CSSOM `setProperty` like 8a's
  bars; icons are inline SVG elements (`aria-hidden`, `currentColor`); no
  `style=` attributes. The e2e CSP-violation guard covers the new screens.

## 13. Test plan

Vitest (jsdom) with the fake client unless marked **e2e**.

### 13.1 Per AC

| AC | Tests |
|---|---|
| AC38 | `roster-view.test.ts` (order own-first then array order, counts with and without away, empty); `people.test.tsx`: counter < 1024 px and list >= 1024 px (matchMedia stub), resize across 1024 switches live and moves focus from the list to the counter, counter opens People view, member and vice render no roster/counter, loading state before the first roster |
| AC39 | `people.test.tsx`: generated with `guestNumber` en "Guest 3" / he "אורח 3" + "Auto name"; chosen "Guest 3" verbatim, no tag, Latin in he; generated without number -> "Guest"; names `<b>x</b>`, `‮evil`, `דנה (Dana)`, 32-char Arabic: text only, isolated |
| AC40 | `preview.test.tsx`: start from sheet and panel; banner texts same page / different page with `<bdi>` numbers, en and he, RTL book; indicator Previewing; Return to group jumps to the group page; banner gone on demotion and on group end |
| AC41 | `preview.test.tsx` with the recording fake: `updatePosition` count 0 during preview turns; exactly 1 on Bring group here (with the previewed position); 0 on Return to group; `preview.move` recorded per turn |
| AC42 | `leader-controls.test.tsx`: make vice, replace vice, clear; away member inactive with hint; `NOT_ALLOWED`, `RATE_LIMITED` (countdown then `canTryNow`), `PARTICIPANT_NOT_FOUND` messages |
| AC43 | confirmation names the person (PlainText title), focus on Cancel, Esc returns focus; success removes row, focus to next/previous/heading, codes notice `codesMemberRemoved`; `BLOCK_LIST_FULL`, `CODES_EXHAUSTED`, `RATE_LIMITED` in dialog; `PARTICIPANT_NOT_FOUND` closes with message above list |
| AC44 | lock/unlock pending, lock line in strip/panel/sheet; member: banner on `lockChanged`, sheet line from `locked`, no banner when joined already locked; new leader sees inherited lock |
| AC45 | `keep-alive.test.ts` (state and copy table incl. `auto`/`frozen`/`null`, others 0/1, last chance); `keep-alive-card.test.tsx` with fake timers: countdown from `countdownMs`, `keepAliveCleared` closes silently, Keep going answers, run-out -> paused with the right line, Keep going still calls `answerKeepAlive` while paused, assertive announcement on appearance and at run-out only, clock jump + `visibilitychange` correct |
| AC46 | `leadership-flow.test.tsx` per reason: dialog text, focus on heading, Esc/Start leading closes, full leader view after (codes, QR button, roster, tray), off-page -> preview at own page, mismatch line, no duplicate "You're leading" announcement |
| AC47 | per reason incl. `superseded`: leader UI gone (strip, panel, QR, roster, tray, keep-alive card, preview, open confirmations), sticky warning banner, focus to Dismiss when focus was inside a closed part; previewing leader stays on its page as Not following and gets the jump prompt on the next move (U14); `rejoined` as member after leading -> `lostDisconnect` (Q-A1) |
| AC48 | card from `leadershipLost` and from `takeBackOffered`; accept -> `takeBackLeadership` -> now-leading `take_back`; Keep following doesn't come back for the same offer, a later loss asks again; withdrawn by `leader.changed` (P3 in the fake: `patchGroup({ takeBackAvailable: false })`), by end and leave; `NOT_ALLOWED` closes + sticky refused banner; `RATE_LIMITED` inline; card above jump/late-join prompts; no card after a `take_back` loss (Q-A2); client test for P3 |
| AC49 | member and vice: banner per reason, no names, polite, auto-hides after 15 s visible time, pauses on hover/focus/hidden tab (fake timers + `visibilitychange`) |
| AC50 | `i18n.test.ts` all new keys in both catalogs; components in `he` with `dir="rtl"` and an LTR book; numbers and counts isolated |
| AC51 | roster, remove title, vice/remove announcements, `errViceAway`, `errPersonGone` with the AC39 fixtures: text nodes only, `<bdi>`/FSI-PDI isolation, no `aria-label` containing a name |
| AC52 | focus table (design 9.1) per element; non-modal cards and banners never take focus; arrow keys turn pages with cards and banners up, not with the two dialogs open; **e2e** keyboard: now-leading dialog dismiss by Esc |
| AC53 | keep-alive and retry-wait countdowns with a mocked clock jump and `visibilitychange` |
| AC54 | `group-logging.test.tsx` extended: console spies through roster, vice, remove, lock, preview, keep-alive, now leading, lost, take-back, changed, QR pasted: nothing logged |
| AC55 | CI green (lint, typecheck, test, build, audit, e2e); `build-output.node.test.ts` still clean; README test updated |
| AC57 | `pasted-link.test.ts` (`stripLaterTickets` strips first, then calls `onIgnored()` with no arguments; non-ticket hashes don't); `qr-pasted.test.tsx`: banner on the reading page, `NoticeBar` on the library, sticky (no auto-hide), repeat replaces, silent with sync off, ticket text in no DOM text or attribute, no join call |
| AC58 | per action (vice set/clear, remove, lock/unlock, bring group here, keep going, take the lead): pending label while the fake's promise is open (bring: synchronous, error path keeps the preview), `NOT_LEADER`, `NOT_CONNECTED`, `RATE_LIMITED` with time, en and he; `leader-errors.test.ts` table-driven |
| AC59 | **e2e** `lifecycle.spec.ts` (13.2) |
| AC60 | vice notice on set and clear, member sheet line; no "no longer vice" when the clear is because they became leader |
| AC61 | marker line for `admittedSinceRecovery` in the list, never in the counter |

### 13.2 E2E (AC59, ADR 0008)

Second stack started by `global-setup.ts` (the existing stack and its
phone-lock check stay on the default 30 s grace, Gate 2 Q-A3 of #24):
- sync server on `apps/reader/e2e/fixtures/apps.lifecycle.json`
  (`disconnectGraceSeconds: 5`, `defaultHandoff: "auto"`, within the
  server's minimum 1 and ceilings, no server change), `NODE_ENV=development`,
  loopback, random `TOKEN_SECRET` (R11);
- a direct reader and a proxied reader (own TCP proxy, control `POST
  /cut/lifecycle/<ms>`).

`lifecycle.spec.ts` (desktop viewport >= 1024 px, so the roster list shows):
1. Leader (proxied) starts a group; vice and member (direct) join with codes.
2. Leader makes the vice from the roster (row -> Make vice-leader).
3. **Preview doesn't move a member:** leader Preview pages, turns 2 pages;
   member stays on its page for 3 s (page indicator unchanged, no jump
   prompt); Bring group here -> member moves within 2 s.
4. Cut the leader for **12 s** (> 5 s grace + reconnect slack).
5. Vice: "You're leading the group now" dialog with the disconnect reason,
   dismiss, indicator Leading.
6. Member: leader-changed banner "The leader lost connection…", then
   follows the vice's next page turn.
7. Original leader reconnects: lost-lead banner (Q-A1), take-back card,
   Take the lead -> now-leading dialog `take_back` -> indicator Leading;
   member follows its next turn; vice shows lost-lead `lostTakeBack` and
   **no** take-back card (Q-A2 recommendation).

Timing budget: about 40 s; test timeout 120 s; no retries (flaky timing is
a bug). Keep-alive is not in e2e (spec Q8: fake timers only).

### 13.3 Package tests

P3 in `packages/client/test/client.lifecycle.test.ts`; P4 in
`packages/react/test/leader.test.tsx`; README tests in both packages.

## 14. Docs impact

- `apps/reader/README.md`: new "Leader views and lifecycle prompts"
  subsection under Groups: people counter and list, vice-leader, remove,
  lock, preview (nothing is sent while previewing), keep-alive prompt and its
  paused state, now leading / lost lead / take-back / leader changed, the
  pasted QR link notice; the e2e section lists the lifecycle stack and its 5
  s grace.
- `packages/client/README.md`: `takeBackAvailable` cleared on a later
  `leader.changed` and on `NOT_ALLOWED` (P3).
- `packages/react/README.md`: `useHandoffMode()` row (P4).
- `docs/conventions.md`: **no change** (no new ADR, scopes unchanged).
- `docs/roadmap.md`: item 8 row is updated by `pm` at merge (project
  practice), not in this PR.

## 15. Risks and edge cases

- **Take-back ping-pong** (section 3, Q-A2): the server lets the interim
  leader take the lead back after a take-back. With the recommendation the
  reader doesn't offer it; a follow-up issue can make the server match the
  PRD ("original leader after a handoff").
- **Optimistic `auto` run-out line**: if the only other connected person is
  the displaced leader (not eligible), the card says "someone else will lead
  soon" but the group waits. Rare; the line is still not wrong about the
  pause.
- **Last-chance hint** (8.3) can say "pauses" when the group will end; the
  ended notice explains.
- **Roster order after a leader reconnect**: a fresh `roster.snapshot`
  reflects server order, where a re-admitted participant is at the end; rows
  can move once on reconnect (never on away/back/vice changes).
- **NOT_LEADER races**: an action in flight while the lead moves gets
  `NOT_LEADER`; the control is usually gone already (lost flow), else the
  inline `errNotLeader`.
- **Hidden tabs**: every countdown is deadline-based and recomputed on
  `visibilitychange`; auto-hide counts visible time only.
- **jsdom `<dialog>`** shim (8a) can hide focus bugs: the e2e covers the
  now-leading dialog with the keyboard.
- **E2E timing**: grace 5 s + client reconnect backoff; the 12 s cut leaves
  slack. Two stacks double setup time (about 2 s).
- **GroupReading size**: the plan moves 8b logic into hooks; the engineer
  should not grow `GroupReading.tsx` by more than the wiring.

## 16. Security-sensitive areas

Security-sensitive: yes

- **Group membership and roles from the client side:** remove member,
  vice-leader set/clear, lock/unlock, take-back (`People.tsx`,
  `use-leadership-flow.ts`, `GroupReading.tsx`). The server stays the only
  authority (#13 `authorizeLeader`); the reader sends participant IDs taken
  only from the current roster entry, never from text.
- **Realtime handler change in `packages/client`** (P3): `leader.changed`
  and the take-back rejection now change `takeBackAvailable`
  (`client.ts`). It can only *withdraw* an offer, never grant one.
- **New package API** (P4): `useHandoffMode()` exposes one leader-only enum
  (`auto`/`frozen`), `null` for non-leaders; no IDs, names or block list.
- **PII of possibly minors:** other participants' display names now render
  in the roster, the remove confirmation, announcements and error lines
  (#24 R7: `PlainText`, isolated, no `aria-label` strings with names,
  single-pass `format`, FSI/PDI in announcement strings). No name, ID,
  roster or preview position is stored or logged (AC54, R5, R9).
- **QR ticket path** (AC57): `stripLaterTickets` keeps stripping first;
  the new callback carries no data; no join from `hashchange` (Q7, R3).
- **Test config with the public dev key** (`e2e/fixtures/apps.lifecycle.json`):
  development only, loopback, random token secret (R11).
- Not touched: dependencies, CSP/Permissions-Policy, storage, server, tokens.

## 17. Questions for the user (Gate 2)

Recommendation first in each.

- **Q-A1. Lead lost while away.** A leader whose connection drops past the
  grace comes back as a member without a `leadershipLost` event (AC47 is
  written for "while connected"). Recommendation: show the same sticky
  lost-lead banner with "You were away too long, so someone else is leading
  now. You can keep reading with the group." (the design's
  `lostDisconnect` text), then the take-back card. Alternative: only the
  take-back card, no banner (the indicator change and the card explain it).
- **Q-A2. No take-back offer after a take-back.** The server offers
  take-back to whoever was displaced last, including the interim leader
  right after the original leader took the lead back, so the lead can pass
  back and forth. AC48 and the PRD speak of the original leader "after a
  handoff". Recommendation: the reader shows the take-back card only after a
  handoff loss (`handoff_disconnect`, `handoff_inactivity`), not after a
  `take_back` loss; open a follow-up issue to align the server. Alternative:
  show the card whenever the client says `takeBackAvailable` (server
  behaviour as is).

## 18. Implementer model

Implementer model: opus
Reason: security-sensitive (roles, removal, other people's names), a client
behaviour change, about 35 files, and a stateful set of interacting flows
(banner queue, overlay priority, preview routing, role changes, demoted
follow state, e2e with a second server stack).

## 19. Implementation chunks

All in this repo, scopes per `docs/conventions.md`. Each chunk carries its
tests and keeps `pnpm lint typecheck test build` green; i18n keys land with
the chunk that uses them.

1. `feat(client): withdraw a stale take-back offer` (P3)
2. `feat(react): add useHandoffMode for the leader's handoff mode` (P4)
3. `feat(reader): add the banner slot and an assertive announcer` (6; moves the ended notice; `NoticeBar` auto-hide)
4. `feat(reader): show the people in the group to the leader` (7.1; AC38, AC39, AC61)
5. `feat(reader): add vice-leader, remove and lock controls` (7.2; AC42-AC44, AC58 parts, member lock/vice notices AC60)
6. `feat(reader): add leader preview with bring group here` (7.3; AC40, AC41)
7. `feat(reader): add the keep-alive card and its paused state` (8.3; AC45, AC53)
8. `feat(reader): handle now leading, lost lead, take-back and leader changes` (8.1, 8.2, 8.4-8.6; AC46-AC49)
9. `feat(reader): tell the user when a pasted qr link is ignored` (10; AC57)
10. `test(reader): add end-to-end checks for handoff, take-back and preview` (13.2; AC59)
11. `docs(reader): document leader views and lifecycle prompts` (14; also the client and react README lines if not already in chunks 1-2)
