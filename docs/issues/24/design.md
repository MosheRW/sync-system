# Design: #24 reading app sync UX: join and follow (PRD item 8a)

Scope: 8a only (AC1-AC37, AC50-AC56). It covers creating a group, showing
codes and the QR code, joining by methods A-D, approval, the content
mismatch screens, following and browsing, the jump prompt and the late-joiner
countdown, the connection indicator, leaving and ending, group-ended reasons,
and resuming after a reload or phone lock.

Not designed here (#25, 8b): the roster, preview mode and its banner, the
vice-leader, remove, lock, the keep-alive prompt, "you're now leading", the
lost-lead notice, the take-back prompt and the leader-changed notice. The
layout leaves room for them (section 11).

This design extends `docs/issues/19/design.md` (item 7) and doesn't replace
it. Tokens, `StatusScreen`, `NoticeBar`, `LiveAnnouncer`, `PlainText`, the
header layout and the copy style all carry over. Accepted ADRs 0002
(CSS Modules plus `tokens.css`, logical properties) and 0003 (`en` and `he`,
no i18n library, `format()` with `{n}` placeholders) apply unchanged.

---

## 1. Users and context

| User | Goal | Context |
|---|---|---|
| Leader, untrained (teacher, prayer leader, study-group host) | Start a group in seconds; keep codes visible to the room | Phone or tablet, often standing in front of people, one hand, talking at the same time |
| Joiner in the room | Get onto the leader's page in under 15 s | Own phone, hears codes read aloud or scans a QR code with the phone's camera |
| Member | Read along, look ahead or back without getting lost | Phone, screen may lock, mobile network may drop |
| Member with a different copy | Know why following isn't possible, and what to do instead | Same |
| Leader using approval (B) | Let the right people in without stopping the reading | Same as the leader above; prompts must not block page turns |
| Hebrew-interface user | Every new screen in Hebrew and RTL; codes still read left to right | Same |
| Screen-reader and keyboard user | Hear state changes (following, reconnecting) and reach every prompt | VoiceOver, TalkBack, desktop keyboard |

Attention: the reading text stays the focus. Group chrome is small, always
visible, and never covers text without a reason. Only two things take focus
on their own: the content-mismatch screens and confirmations the user opened.

## 2. Flows

Taps are counted from the reading page. Steps marked **(goal)** are where the
user's goal is met.

### F0. Sync configured or not (AC1, AC2, AC4)
1. No sync config: the reader is item 7's solo reader. No Group button, no
   indicator, no "Join a group" on the library page, no connection attempt
   (AC2).
2. Invalid sync config: item 7's "This app isn't set up" `StatusScreen`
   (AC30 pattern), with Details `Sync settings are not valid.` (AC1).
3. Valid config: the reading header gets the **Group** button (section 5.1).
   The client connects lazily: on the first Start or Join, on a QR deep link,
   or at load when a stored group token exists (F11). A solo reader who never
   touches Group never connects.
4. The server rejects the app version, or the client refuses the server's
   protocol: the **Update required** or **Groups unavailable** screen
   (section 6.12). Both offer **Read without a group**, which returns to the
   solo reading screen with the Group button hidden for this page load. The
   screen is never blank or half-working (AC4).

### F1. Create a group (leader) (AC5-AC13)
1. Reading page: tap **Group** (1 tap). The Group sheet opens on its start view
   (section 6.2).
2. Tap **Start a group** (2). The Start view shows the book's title, "How
   people join", "If you lose connection" and an optional name. Everything is
   preselected (section 6.3), so no choice is required.
3. Tap **Start group** (3). The button shows "Starting…" (spinner, aria-disabled).
   `createGroup` is sent with the loaded content's metadata, unchanged (AC6).
   - Name invalid: inline field error before anything is sent (AC7); focus
     moves to the field.
   - Connection, busy or server error: form-level error above the button
     (section 7.4); the choices are kept; **Start group** retries.
   - Update required: F0 step 4.
4. **(goal)** The sheet switches to "Your group is ready": large codes and,
   for method D, the QR code (section 6.5). The indicator shows **Leading**.
   The code strip (phone, tablet) or the Group panel (>= 1024 px) appears and
   stays (AC8).
5. Tap **Start reading** or close the sheet. Codes stay in the strip or panel.
   The leader reads. Every page turn moves the group.

### F2. Join by code: methods A, B and C (AC14-AC16, AC18, AC19)
The joiner doesn't need to know the method. The client classifies the code:
6 digits means A or B, and 8 characters means C. The server answers with
`DOOR_CODE_REQUIRED` (A), the approval wait (B) or admission (C).

1. Reading page: **Group** → **Join a group** (2 taps). Library page:
   **Join a group** (1 tap, F4).
2. Type or paste the code, add an optional name, then tap **Join**. The
   button shows "Joining…".
   - Empty or wrong format (client check): field error, nothing sent.
   - Name invalid: field error, nothing sent.
3. Branches by server answer:
   - **C, or A/B admitted straight away**: go to step 5.
   - **A (`DOOR_CODE_REQUIRED`)**: the Door code view (section 6.7). It shows
     the group code read-only with a **Change** link. Type the door code, tap
     **Join**. `DOOR_CODE_WRONG`: field error, the field is cleared, focus
     goes to it. `JOIN_PAUSED`: error with a countdown, and **Join** is
     aria-disabled until the countdown ends.
   - **B (awaiting approval)**: the Waiting view (F3).
   - **Any error**: the message from section 7.4 above the button. The code
     stays in the field, which is focused and selected. No error echoes the
     code (AC19).
4. Cancel or back at any point: **Back** returns to the start view; closing
   the sheet keeps nothing (no half-joined state) except a pending approval
   (F3).
5. Admitted: the content check runs (F6).
   - `match`: go to step 6.
   - Anything else: F6.
6. **(goal)** Position: the member jumps to the group's page straight away
   (fresh joiner) or gets the late-joiner countdown (F8). The sheet closes,
   the indicator shows **Following**, and a polite announcement says "Following
   the group to page 7 of 12."

### F3. Waiting for approval: method B (AC15, AC30)
1. The Waiting view: "Waiting for the leader", the time left (server
   duration, counted down locally), **Cancel request**.
2. The joiner may close the sheet and keep reading solo. The indicator shows
   **Waiting for approval**; tapping it reopens the Waiting view.
3. Outcomes:
   - Approved: F2 step 5. If the sheet is closed, the indicator changes to
     **Following** and the change is announced.
   - Denied (`JOIN_DENIED`), timed out (`APPROVAL_TIMEOUT`), group full: the
     Join view reopens with the message (section 7.4); the code is kept so a
     retry is one tap. If the sheet was closed, it opens again, because the
     result needs an answer (focus goes to the message).
   - **Cancel request**: `cancelJoin`, back to the Join view, no message.
   - Connection lost while waiting: the request is gone (the server drops
     it). The Join view shows "Can't reach the group service…", and **Join**
     sends a new request.

### F4. Join from the library (AC19, Decision Q4)
1. Library page: **Join a group** in the header (section 6.10). It opens the
   Group sheet straight on the Join view (no Start option: starting needs a
   book).
2. As F2 steps 2-4 and F3.
3. Admitted: the app reads the group's content ID.
   - It's a bundled book: "Opening the group's book…", then navigate to that
     book's reading page (`?book=<id>`, a real navigation; item 7 AC24 holds).
     The membership carries over through the stored token (F11). On arrival,
     the content check (F6) and positioning (F8) run.
   - It isn't bundled (fetched content, an unknown ID, or malformed metadata):
     the "This app doesn't have the group's book" view (section 6.9) with
     **Leave group**. Leaving returns to the library.

### F5. Join by QR: method D (AC12, AC17, AC19)
1. The leader shows the QR code (strip **QR** button, panel or "ready" view).
2. The joiner points the phone's camera app at it and opens the link. The link
   is the reader's address with the leader's book selection (`?book=` or
   allow-listed `?src=`, nothing in single-book mode) and the ticket in the
   fragment.
3. The reader loads the book as in item 7 (bundled: instant; `?src`: Loading
   state). The ticket is read from the fragment and **removed from the address
   bar and history immediately**, before loading finishes and before any
   error screen, whatever the outcome.
4. The Group sheet opens on "Joining the group…" (section 6.8), sends
   `joinByQr` and then follows F2 steps 5-6. The total is zero taps after
   opening the link.
5. Errors:
   - `QR_EXPIRED`, `QR_INVALID`, others: "Couldn't join the group" with the
     message, **Join with a code** (opens the Join view) and **Read on my
     own** (closes the sheet; the book stays open solo).
   - The book itself fails (not found, fetch failure, refused): item 7's
     status screens. No group join is attempted, and the ticket is already
     gone from the URL.
   - Sync not configured on this deployment: the fragment is removed and
     ignored; solo reading.

### F6. Content check and mismatch (AC21-AC24)
Runs after every admission and every resume (F11), before any position is
applied. It uses item 7's `compare`.

| Outcome | Screen | Following |
|---|---|---|
| `match` | none | starts |
| `different-version` | **Version warning** dialog (section 6.11): **Follow anyway** or **Leave group** | starts only after **Follow anyway** |
| `different-content` | **Different book** block (section 6.11) | never |
| `unsupported-schema`, malformed leader metadata | **Can't follow** block (section 6.11) | never |

Block screen actions:
- **Leave group** (primary): leave, and return to solo reading of the current
  book with the "You left the group." notice.
- **Open the group's book** (secondary): shown only when the group's content
  ID is a bundled book and the app isn't in single-book mode. It's a
  navigation to that book's page, staying in the group (Decision Q4; the same
  path as F4). See open question U2.

While blocked, the member stays in the group (the indicator shows **Not
following**, never **Following**). Received positions are ignored. If the
group ends meanwhile, the block is replaced by the solo book with the
group-ended notice.

The acknowledgement of the version warning lasts for this group on this book
for the tab's lifetime (it's not asked again on resume after a reload, as long
as the fingerprint pair is unchanged). Architect: keep it in `sessionStorage`
with the position.

### F7. Following and browsing (AC25-AC27, AC29, AC31)
A member is in one of two modes:

| Mode | Meaning | Indicator |
|---|---|---|
| following | On the group's page; moves with the leader | **Following** (or a connection state, section 5.2) |
| browsing | Turned pages on their own | **Not following** |

Transitions:
1. following → browsing: the member turns a page themselves (button, key,
   swipe). Announced once: "Not following the group." The jump prompt doesn't
   appear yet; it appears on the next leader move (AC26).
2. browsing → following: the member taps **Go to page N** (jump prompt or
   sheet), or turns pages until they reach the group's page, or the leader
   moves onto the member's current page.
3. While following, a leader move turns the page with the normal page
   animation in the direction of travel; the existing announcer says "Page 8
   of 12". The reading scroll resets to the top as for any page turn.
4. While browsing, a leader move shows (or updates) the **jump prompt**
   (section 6.13): "The group is on page 9. [Go to page 9] [Stay here]". The
   prompt never moves the member, has no timeout, never stacks (one prompt,
   always the latest page) and is announced politely once per update.
   **Stay here** hides it until the next leader move.
5. Positions only ever come from the group's official position (AC27). A
   malformed or out-of-range position is ignored silently: no prompt, no
   move, no error shown (AC29).
6. The leader turns pages normally; nothing extra is shown to the leader.

### F8. Positioning after join: the late-joiner countdown (AC28)
After admission and a `match` (or **Follow anyway**):
1. The group has no position yet: stay on the current page, mode following.
2. The member's page equals the group's: mode following, no prompt.
3. **Fresh joiner** (hasn't turned a page since this book opened in this tab,
   for example arrived by QR or just opened the book): jump straight to the
   group's page, with no countdown. See open question U1.
4. Otherwise (the member was reading somewhere else): the **late-joiner
   prompt** (section 6.14): "The group is on page 7. Going there in 10 s."
   with **Go now** and **Stay here**. The duration comes from reader config
   (default 10 s).
   - Countdown ends: jump, mode following, announce "Following the group to
     page 7 of 12."
   - **Go now**: the same, at once.
   - **Stay here**, or the member turns a page themselves: the prompt closes
     and the mode is browsing (the jump prompt from F7 takes over on the next
     leader move).
   - The leader moves during the countdown: the page number in the prompt
     updates; the countdown keeps running and doesn't restart.

### F9. Leader approval prompt (AC20)
1. A join request arrives. The **Approval tray** (section 6.15) appears above
   the page navigation: "Dana wants to join · [Deny] [Let in]". It doesn't
   take focus and doesn't block reading, page turns or swipes.
2. Several requests: the oldest is shown, with "2 more waiting · Show all".
   **Show all** expands the tray into a list (max 50 % of the viewport,
   scrolls). Each row has its own buttons.
3. Let in or deny: the row shows a spinner, then disappears. Focus moves to
   the next row's **Let in** button, or back to where it was before the tray
   if it's empty (never to `body`).
4. A request withdrawn, timed out or cancelled by the joiner disappears
   silently. If it had focus, focus moves as in step 3.
5. Failure (network): the row stays with an inline "Couldn't answer this
   request. Try again."
6. The tray is for the leader only and disappears with the lead (AC13).

### F10. Codes: changes, rotation and pause (AC9-AC11)
1. **Codes change** (rotation by the leader, door-code failures, removal,
   superseded, recreation on resume): the strip or panel shows the new codes
   at once. A **codes notice** (section 6.6) under the strip says why, in
   words. It's announced politely and stays until dismissed or replaced by
   the next change. `created` shows no notice.
2. **Get new codes** (Group sheet or panel): a confirmation dialog
   (section 6.16), "The current codes and QR code will stop working. People
   already in the group stay in." Confirm: "Getting new codes…", then the new
   codes plus the `rotated` notice. Failure: an inline error; the old codes
   still work.
3. **Door-code joining paused**: the strip and panel show "Joining with the
   door code is paused. 4:59 left." under the codes, counted down from the
   server duration, then "Joining with the door code works again." (announced,
   auto-hidden after 10 s).

### F11. Resume after a reload, closing and reopening the tab, or a phone lock (AC34-AC37)
1. The page loads the book (item 7). The current page is restored from
   `sessionStorage` for this book (content ID plus fingerprint); a solo reader
   lands on their page (AC36).
2. A stored group token exists: the indicator shows **Reconnecting…** at once,
   with no sheet and no codes prompt. The book is readable meanwhile.
3. Resumed with the same role:
   - **Leader**: codes and strip return (the last codes are shown while
     reconnecting; they're still valid). The page is the group's page (they're
     the same thing for a leader). Recreated with new codes: the `resumed`
     codes notice.
   - **Member**: the content check (F6), then:
     - was following: jump to the group's page silently (announced);
     - was browsing: stay on their own page and show the jump prompt
       (Decision Q3), with no countdown.
   - **Member parked** (`waiting`, the leader is recreating): the indicator
     shows **Leader offline**; the page stays.
4. **Phone lock** (short drop, under the grace period): the same as step 3
   without the reload. The leader returns still leading, with no prompt and no
   role change (AC35). Members meanwhile see **Waiting for leader · 0:24**
   (`leader_grace`) or **Leader offline**.
5. **Stored group gone** (ended, unknown, expired token): a `NoticeBar` once,
   "Your group has ended.", and the token is forgotten. No retry loop
   (AC37). Solo reading continues on the restored page.
6. **The client gives up reconnecting** (connection closed, `gave_up`): the
   indicator shows **Not connected · Try again** (section 5.2). The group
   isn't forgotten; **Try again** reconnects.
7. **Opened in another tab** (`replaced`): this tab shows the replaced notice
   and becomes solo. The other tab keeps the group.

### F12. Leave and end (AC32, AC33)
1. Member: **Group** (indicator) → **Leave group**. No confirmation (it
   affects only them; rejoining needs a code, which the room has).
   "Leaving…", then solo reading on the same page with "You left the group."
2. Leader: **Group** → **End group** → confirmation "End the group for
   everyone?" → **End group**. "Ending…", then solo reading with "You ended
   the group." The strip and panel disappear.
3. The group ends for any other reason: a `NoticeBar` under the header with
   the reason (section 7.8), announced politely, with **Dismiss**. The book
   stays open and readable on the current page (AC33). Any open sheet, prompt,
   tray or countdown closes. Focus, if it was inside one of them, moves to the
   notice's **Dismiss** button.
4. `removed`: only "You were removed from the group." with no other detail.

### F13. Leader loses the lead (AC13 only)
The 8b notices aren't designed here. The 8a rule: the moment the client
reports this user isn't the leader, the strip, panel, QR, approval tray and
leader-only sheet actions disappear, and the indicator shows the member state.
The QR stops being refreshed.

## 3. Screens and components

| Component | New / reused / changed | Purpose |
|---|---|---|
| `ReadingScreen` | changed | Fills the item 7 slots: header end slot, overlay layer; adds the code-strip slot and the panel column |
| `ReaderHeader` | changed | End slot holds `GroupButton`; may wrap to two rows (section 4) |
| `GroupButton` | new | The Group entry point and the connection indicator in one control (5.1, 5.2) |
| `CodeStrip` | new | Leader only, < 1024 px: codes, QR button, pause line, codes notice |
| `GroupPanel` | new | Leader only, >= 1024 px: codes, QR, actions, 8b slot |
| `CodeDisplay` | new | One code, grouped, LTR-isolated, two sizes |
| `GroupSheet` | new | Modal: bottom sheet on phones, dialog on larger screens; hosts the views below |
| `StartView`, `CreateGroupForm`, `GroupReadyView`, `LeaderGroupView`, `MemberGroupView`, `JoinForm`, `DoorCodeView`, `WaitingView`, `QrJoinView`, `GroupBookMissingView` | new | Views inside `GroupSheet` |
| `CodeField` | new | Text input for codes (AC18) |
| `NameField` | new | Optional display name (AC7) |
| `QrCodeView` | new | The QR image with its states |
| `ApprovalTray` | new | Non-modal region for join requests |
| `JumpPrompt` | new | Non-modal "group is on page N" prompt |
| `LateJoinPrompt` | new | `JumpPrompt` variant with a countdown |
| `MismatchBlock` | new | Uses the `StatusScreen` layout inside the reading screen's main region |
| `VersionWarnDialog` | new | Modal acknowledgement |
| `ConfirmDialog` | new | Rotate codes, end group |
| `NoticeBar` | reused (item 7) | Group-ended reasons, left, group gone |
| `StatusScreen` | reused | Update required, groups unavailable, invalid sync config |
| `LiveAnnouncer` | reused, extended | Same polite region carries group announcements (section 9) |
| `PlainText` | reused | Display names, titles, content IDs |
| `LibraryScreen` | changed | Header gets **Join a group**; an in-group notice |

## 4. Layouts

All wireframes show the English interface; the Hebrew interface mirrors every
interface element (section 8). Codes stay left to right in both.

### 4.1 Member, phone (< 640 px)
```
+------------------------------------------+
| [Title of the book…]  3 / 12 [● Following]|  ReaderHeader 48 px
+------------------------------------------+
|                                          |
|  Block text, block text, block text      |
|  …                                       |
|                                          |
|  +------------------------------------+  |  overlay layer: JumpPrompt or
|  | The group is on page 9.            |  |  LateJoinPrompt, docked at the
|  | [Stay here]        [Go to page 9]  |  |  bottom of main, above PageNav
|  +------------------------------------+  |
+------------------------------------------+
| [====------------------------]           |
| [ ‹ Previous ]            [ Next › ]     |  PageNav
+------------------------------------------+
```
- The `GroupButton` sits at the header's inline end. The title truncates
  first; the counter and the indicator never truncate. When they don't fit
  (narrow phone, 200 % zoom, long Hebrew state), the header wraps: the
  indicator moves to a second row at the inline end, and the header grows
  (no fixed 48 px height then).
- Prompts are docked cards, not floating toasts: full width minus
  `--space-4` margins, `--color-surface` background, hairline border,
  `--radius-md`, `--shadow-raised`. The text under the card stays scrollable;
  the main region gets bottom padding equal to the card's height so the last
  line of text can be scrolled into view.

### 4.2 Leader, phone and tablet (< 1024 px)
```
+------------------------------------------+
| [Title of the book…]  3 / 12  [● Leading]|  ReaderHeader
+------------------------------------------+
| Group 482 913   Door 205 118     [ QR ]  |  CodeStrip 44 px, sticky with
+------------------------------------------+  the header (always visible)
| ⓘ New codes are ready. The old… [Dismiss]|  codes notice (only after a change)
+------------------------------------------+
|                                          |
|  Block text…                             |
|                                          |
|  +------------------------------------+  |
|  | Dana wants to join                 |  |  ApprovalTray (B only)
|  | 2 more waiting · Show all          |  |
|  |                  [Deny] [Let in]   |  |
|  +------------------------------------+  |
+------------------------------------------+
| [ ‹ Previous ]            [ Next › ]     |
+------------------------------------------+
```
Strip content by the group's methods:

| Methods | Strip |
|---|---|
| A (+D) | `Group 482 913   Door 205 118   [QR]` |
| B (+D) | `Group 482 913   [QR]` |
| C (+D) | `Code K7MQ 9XPR   [QR]` |
| A + C (+D) | two rows: `Group 482 913  Door 205 118` / `Code K7MQ 9XPR   [QR]` |
| D only | `People join with the QR code   [Show QR code]` |

- Codes are never truncated or hidden. If the strip doesn't fit on one row it
  wraps; the QR button stays at the inline end of the last row.
- 640-1023 px: the same strip with `CodeDisplay` at the large-strip size
  (`--text-code`, section 10), centred to the content column.
- Pause line (F10.3) is a second line inside the strip, `--text-sm`, warning
  icon plus text, `--color-warning`.

### 4.3 Leader, large screens (>= 1024 px)
```
+--------------------------------------------------------------------------+
| [Title of the book…]                              3 / 12     [● Leading] |
+-----------------------------------------------------+--------------------+
|                                                     | Your group         |
|   Block text, block text, block text block text     |                    |
|   block text.                                       | Group code         |
|                                                     |  482 913           |
|   Block text…                                       | Door code          |
|                                                     |  205 118           |
|                                                     |                    |
|                                                     | +----------------+ |
|                                                     | |   ▓▓  ▓▓ ▓▓    | |  QR (when shown)
|                                                     | |   ▓ ▓▓  ▓ ▓    | |
|                                                     | +----------------+ |
|                                                     | Scan to join       |
|                                                     | [Hide QR code]     |
|                                                     |                    |
|                                                     | (8b: members)      |
|                                                     |                    |
|                                                     | [Get new codes]    |
|                                                     | [End group]        |
+-----------------------------------------------------+--------------------+
| [ ‹ Previous ]                    [ Next › ]        |
+-----------------------------------------------------+
```
- `GroupPanel` is an `<aside>` at the interface's inline end (right in `en`,
  left in `he`), `--size-panel` wide, `--color-surface`, hairline border on
  its inline-start side, full height between header and bottom, scrolls on
  its own. The reading column keeps its 66ch cap and centres in the remaining
  space. `PageNav` spans the reading column only.
- Codes at `--text-code-lg`. The QR, when shown, fills the panel width minus
  padding (about 16rem); its quiet zone is part of the white square.
- The QR is hidden by default (it isn't issued while hidden, AC12); **Show QR
  code** shows it in place. The choice is remembered for the tab
  (`sessionStorage`) so a reload doesn't hide it again.
- Approval requests and the codes notice appear at the top of the panel, not
  in the overlay, on large screens.
- No collapse control in 8a: codes must stay visible.

### 4.4 GroupSheet
- Phone (< 640 px): a bottom sheet, full width, rounded top corners
  (`--radius-lg`), max height 90dvh, content scrolls, sticky footer for the
  primary action. Backdrop `--color-backdrop`. A grab handle is decorative
  only (dragging isn't required; Close and Esc close it).
- >= 640 px: a centred dialog, `max-inline-size: --measure-sheet`, same
  content.
- Header row: **Back** (in sub-views, chevron pointing to the interface
  start), the view title (`<h2>`), **Close** (X icon, labelled).
- Slide-up 200 ms with `--easing`; reduced motion: no slide.

### 4.5 QR sheet (phone and tablet)
```
+------------------------------------------+
| ‹ Back        Scan to join            ✕  |
+------------------------------------------+
|        +------------------------+        |
|        |                        |        |
|        |     (QR, white box)    |        |  min(18rem, 80vw, 55dvh)
|        |                        |        |
|        +------------------------+        |
|   Open your phone's camera and point     |
|   it at the code.                        |
|                                          |
|   Group 482 913      Door 205 118        |  codes repeated, large
+------------------------------------------+
```
The **QR** strip button opens the `GroupSheet` straight on this view. Closing
it hides the QR (stops issuing tickets). While it's open, the screen-wake
behaviour is the browser's default (no wake lock in 8a).

## 5. The Group button and connection indicator

### 5.1 GroupButton anatomy
A single button in the header end slot. Its visible text is the indicator
state; activating it opens the `GroupSheet` on the view for the current state.

```
Not in a group:   [ ⧉ Group ]
In a group:       [ ● Following ]   [ ◐ Reconnecting… ]   [ ● Leading ]
```
- Pill shape: `--radius-pill`, min height `--size-target` (44 px), inline
  padding `--space-3`, `--text-sm` / 600, a 10 px status dot (or icon) before
  the text.
- Accessible name: the visible text plus ", group options" (`groupButtonName`).
  For example "Following, group options". It isn't a live region itself
  (section 9).
- States: default, hover (`--color-surface-2`), focus-visible (focus ring),
  active (`--color-surface-2`).

### 5.2 Indicator states (AC30, AC31)

| State (source) | Dot / icon | Text en | Text he | Announcement on change |
|---|---|---|---|---|
| no group | group icon, `--color-text-muted` | Group | קבוצה | none |
| `following` (client) and mode following | filled dot `--color-positive` | Following | עם הקבוצה | "Following the group." |
| `following` and mode browsing (reader) | hollow dot `--color-text-muted` | Not following | לא בעמוד הקבוצה | "Not following the group." |
| `leading` | filled dot `--color-accent` | Leading | בהובלתך | "You're leading the group." (first time per group only) |
| `reconnecting` | spinning ring `--color-warning` (static ring with reduced motion) | Reconnecting… | מתחברים מחדש… | "Connection lost. Reconnecting…" |
| back from `reconnecting` to `following` or `leading` | as the target state | as target | as target | "Back with the group." |
| `leader_offline` | hollow dot `--color-warning` | Leader offline | המוביל לא מחובר | "The leader is offline." |
| `leader_grace` | hollow dot `--color-warning` plus countdown | Waiting for leader · 0:24 | ממתינים למוביל · 0:24 | "The leader is away. Waiting up to 24 seconds." (once, on entry) |
| back to `following` from `leader_offline` or `leader_grace` | as target | as target | as target | "The leader is back." |
| `awaiting_approval` | hourglass icon `--color-text-muted` | Waiting for approval | ממתינים לאישור | "Waiting for the leader to let you in." |
| joining (reader, a join or QR join in flight) | spinning ring `--color-text-muted` | Joining… | מצטרפים… | none (the sheet speaks) |
| not connected (reader: closed `gave_up` with a group still stored) | crossed dot `--color-danger` | Not connected | אין חיבור | "Can't reach the group. Use Group to try again." |

- Text always carries the state; colour and dot shape only repeat it (not
  colour alone).
- The `leader_grace` countdown comes from the server duration
  (`graceEndsAt` is local time computed from a duration, AC53). It's
  recomputed from the clock on every tick and on `visibilitychange`, so it's
  right after the tab was in the background. Format: section 7.1. At 0 it
  shows `0:00` until the client reports the next state.
- The not-connected state's sheet view has **Try again** (`retry`) as the
  primary action, plus **Leave group**.
- In the `he` interface the countdown is an LTR isolate inside the RTL text:
  `ממתינים למוביל · ⁦0:24⁩`.

## 6. Views and components: specs and states

### 6.1 Shared sheet rules
- Every view has one `<h2>` title. On open, focus goes to the first field
  (forms) or to the title (`tabindex="-1"`, information views).
- Primary action is the sheet footer's end-side button (`--color-accent`);
  secondary actions are outlined buttons or text buttons.
- Buttons in flight: spinner plus "…ing" label, `aria-disabled="true"`,
  width kept. Buttons are never `disabled` (they stay focusable and
  explainable).
- A form-level error is a `role="alert"` box above the footer: danger icon,
  `--color-danger` text on `--color-danger-subtle`, hairline danger border.
- Field errors: text under the field in `--color-danger`, linked by
  `aria-describedby`, the field gets `aria-invalid="true"`, and focus moves to
  the first invalid field on submit.

### 6.2 StartView (no group, reading page)
```
Read together                                   ✕
Start a group so others follow your page,
or join someone else's group.

[        Start a group         ]   (primary, full width)
[        Join a group          ]   (secondary, full width)
```
State: only default. If the app's allowed methods (`hello.ok`) aren't known
yet, both buttons work; the connection happens on the next step.

### 6.3 CreateGroupForm (StartView → Start a group)
```
‹ Back           Start a group                  ✕
Book: [Title of the book]

How people join
  [x] Group code
        (•) With a door code
            People enter two codes.
        ( ) I let each person in
            You approve every request.
  [ ] One code with letters
        8 letters and digits.
  [x] QR code
        People scan it with their phone's camera.

If you lose connection
  (•) Pass the lead to someone else
      After a short wait, another member leads so the group can go on.
  ( ) Pause the group until I'm back
      Nobody else leads. The group waits for you.

Your name (optional)
[                                  ]
Others in the group see it. Leave it empty to get a name like Guest 3.

------------------------------------------------
                                 [ Start group ]
```
- Only the methods the app allows are shown (from `hello.ok`; until it's
  known, a short "Loading options…" line with a spinner replaces the
  fieldsets; the connection starts when this view opens).
- A and B are one checkbox ("Group code") with a radio pair, so they can
  never be combined (#10 Q1.3). If only one of A and B is allowed, the radio
  pair is replaced by its hint line.
- **Defaults** (no choice needed): QR code on if D is allowed; then one code
  method: A if allowed, else C, else B. If only one method is allowed at all,
  the "How people join" fieldset is replaced by one line, "People join with:
  QR code".
- Handoff default: the app's default from the server if exposed, else
  "Pass the lead to someone else" (`auto`, the server default).
- Validation on submit: no method selected gives "Choose at least one way to
  join." on the fieldset; the name rules are in 6.17.
- The book line shows the document title (isolated, `PlainText`) or the
  content ID as fallback, like the library row.
- States: default, loading options, submitting ("Starting…"), field error,
  form error (section 7.4), update required (switches to section 6.12).

### 6.4 CodeDisplay
- Groups the characters: 6 digits as `3+3` (`482 913`), 8 characters as
  `4+4` (`K7MQ 9XPR`). The gap is visual (CSS gap between two spans), not a
  space character, so copying gives the code without a space.
- `dir="ltr"`, its own isolate (`<bdi dir="ltr">` or `unicode-bidi: isolate`),
  `font-variant-numeric: tabular-nums`, `letter-spacing: 0.04em`, weight 600,
  `--color-text`.
- A label before it (`Group`, `Door`, `Code` in the strip; full labels in the
  panel and sheets) in `--color-text-muted`.
- Accessible text: `aria-label` spells characters with spaces ("Group code: 4
  8 2 9 1 3") so screen readers don't read "four hundred eighty-two
  thousand"; the visual text is `aria-hidden`.
- Sizes: strip `--text-code` (phone 1.125rem, >= 640 px 1.5rem), large
  `--text-code-lg` (2.5rem) in the panel, ready view and QR sheet.
- Changed state: on a code change the new value gets a 2 s
  `--color-accent-subtle` background fade (none with reduced motion; the
  codes notice carries the message either way).

### 6.5 GroupReadyView and LeaderGroupView
GroupReadyView (right after creating):
```
Your group is ready                             ✕
Share these with the people joining. They stay
at the top of your screen.

Group code   482 913
Door code    205 118
[QR code, shown automatically if D is on]
Scan to join

------------------------------------------------
                               [ Start reading ]
```
LeaderGroupView (indicator tapped while leading, < 1024 px):
- Title "Your group"; the codes at large size; **Show QR code** (D); your
  name ("Your name: Dana", `PlainText`); the pause line if paused; **Get new
  codes** (secondary); **End group** (danger outlined); a reserved slot for
  8b between the codes and the actions.
- On >= 1024 px the panel shows all of this, and the indicator opens the
  same view in a dialog (for keyboard users who look for it there).

### 6.6 CodeStrip and codes notice
- Strip: `--color-surface`, hairline bottom border, min height
  `--size-strip`, inline padding as the header, `role="region"` with the
  label "Group codes".
- **QR** button: 44 px target, QR icon plus the text "QR" (accessible name
  "Show QR code").
- Codes notice: a `NoticeBar` variant directly under the strip (or at the top
  of the panel): info icon, text, **Dismiss**. `role="status"`. One at a time;
  a new change replaces it.
- When the leader isn't connected (`reconnecting`), the strip stays, codes
  unchanged, and the QR button still works (it shows the offline QR state).

### 6.7 JoinForm and DoorCodeView
```
‹ Back           Join a group                   ✕

Code
[ 4 8 2 9 1 3                       ]   ← dir=ltr, numeric keypad
The code the leader gives you.
[My code has letters]                   ← only when C is also allowed

Your name (optional)
[                                  ]
Others in the group see it. Leave it empty to get a name like Guest 3.

------------------------------------------------
                                        [ Join ]
```
DoorCodeView:
```
‹ Back          Enter the door code             ✕
This group also needs a door code. Ask the
leader for it.

Group code  482 913   [Change]
Door code
[                                  ]
------------------------------------------------
                                        [ Join ]
```
- **Change** returns to JoinForm with the code kept.
- States for both: default, field error, submitting ("Joining…"), form error,
  paused (error with countdown, **Join** aria-disabled until 0, then the error
  text changes to "You can try again now."), rate limited (the same with its
  countdown if the server gives one).

### 6.8 CodeField (AC18)
- `<input type="text">` always (never `type="number"`), `dir="ltr"`,
  `autocomplete="off"`, `autocorrect="off"`, `spellcheck="false"`, `enterkeyhint="go"`,
  `font-variant-numeric: tabular-nums`, `--text-code` size, text aligned
  left in both interface directions (it's LTR content).
- Keyboard: `inputmode="numeric"` when the app allows A or B; `inputmode="text"`
  with `autocapitalize="characters"` when only C is allowed. When C and A/B are
  both allowed, the numeric keypad is the default and a text button "My code
  has letters" switches the field to text input (and back: "My code is only
  digits"). Switching keeps the value and the focus.
- Paste: accepted as is. Spaces and dashes are ignored (the client's
  normalisation); lowercase is accepted. Shown as typed (no live
  reformatting, which fights the caret).
- `maxlength` is the protocol's input cap, not 6 or 8, so a pasted code with
  spaces isn't cut off.
- Door code field: always numeric, the same rules.

### 6.9 QrJoinView and GroupBookMissingView
QrJoinView states:

| State | Title | Body | Actions |
|---|---|---|---|
| joining | Joining the group… | (spinner) | none; Close cancels and reads solo |
| failed | Couldn't join the group | the error message (section 7.4) | **Join with a code** (primary), **Read on my own** |
| joined | sheet closes | | |

GroupBookMissingView (library joins, F4): title "This app doesn't have the
group's book", body "Leave the group, then scan the leader's QR code to open
the same book.", Details: group's book ID (isolated, truncated to 40
characters). Action: **Leave group**.

### 6.10 Library page additions
- The header's inline end gets **Join a group** (secondary button, 44 px).
  It's absent with no sync config and in single-book mode (there's no library
  then).
- In a group, the library shows a `NoticeBar`: "You're in a group reading
  [title]." with **Open the group's book** (bundled) or no action (not
  bundled), and the Group button replaces **Join a group** so the user can
  leave.

### 6.11 Mismatch screens (AC22-AC24)
**MismatchBlock** (`different-content`, `unsupported-schema`): the
`StatusScreen` layout rendered inside the reading screen's `main` in place of
the article. The header (with the indicator **Not following**) and `PageNav`
are hidden: there's nothing to navigate while blocked.

| Part | Different book | Can't follow |
|---|---|---|
| Icon | neutral | neutral |
| Heading | This group is reading a different book | This app can't follow this group |
| Body | You can't follow it with this book. Open the group's book, or leave the group. (no-open variant: … Leave the group to keep reading on your own.) | The group's book uses a format this app doesn't read. Update the app, or leave the group. |
| Actions | **Leave group** (primary), **Open the group's book** (secondary, when allowed) | **Leave group** |
| Details | `Group's book ID: acme/psalms-hh` | `Group's schema version 2. This app reads version 1.` or `The group sent book details this app can't read.` |

- The leader's content ID is plain text, `dir="ltr"`, isolated, truncated to
  40 characters with an ellipsis (AC24); markup-like text shows as text.
- Focus moves to the heading (as on every status screen).

**VersionWarnDialog** (`different-version`): a modal `role="alertdialog"`.
```
Your copy is a different version
It's the same book, but the text isn't identical to the
leader's. Pages may not match exactly.
                       [Leave group]  [Follow anyway]
```
- Focus starts on the heading; Tab cycles inside. Esc doesn't dismiss it: a
  choice is required, so the dialog stays open.
- **Follow anyway**: F8 positioning. **Leave group**: F12 step 1.

### 6.12 Update required and groups unavailable (AC4)
`StatusScreen` (full screen, replaces the reading screen):

| Part | Update required (`APP_VERSION_TOO_OLD`) | Groups unavailable (`PROTOCOL_TOO_OLD`, `SERVER_UNSUPPORTED`) |
|---|---|---|
| Heading | Update the app to use groups | Groups aren't available |
| Body | This version can't connect to the group service. Reload to get the latest version. | The group service doesn't work with this version of the app. Ask the person who runs it to update it. |
| Primary | **Reload** | **Read without a group** |
| Secondary | **Read without a group** | none |
| Details | `Minimum app version: 2.1.0` (only if given) | `Group service protocol version 3.` (only if given) |

When it happens inside the Start or Join flow, the sheet closes and this
screen shows. **Read without a group** returns to the book on the same page.

### 6.13 JumpPrompt (AC26, AC27, AC31)
```
+--------------------------------------------+
| The group is on page 9.                    |
| [Stay here]                [Go to page 9]  |
+--------------------------------------------+
```
- `role="region"` with the label "Group page", inside the overlay layer. Not
  modal, doesn't take focus.
- Updates in place on every leader move (one prompt, latest page).
- **Go to page N** uses the reading screen's "go to page" action, so the page
  announcement and animation work as for a normal turn.
- Hidden when the member reaches the group's page by any means.
- In DOM order it comes after the article and before `PageNav`, so keyboard
  users reach it with a few Tabs from the content.

### 6.14 LateJoinPrompt (AC28)
```
+--------------------------------------------+
| The group is on page 7.                    |
| Going there in 8 s.        [====------]    |
| [Stay here]                    [Go now]    |
+--------------------------------------------+
```
- The bar shrinks from the interface end to the start (`--color-accent`,
  4 px); reduced motion: no bar, the seconds text only.
- The duration comes from reader config; the timer uses a monotonic clock
  and is recomputed on `visibilitychange` (if the tab was hidden past the end,
  the jump happens when it becomes visible).
- Screen readers: one polite announcement on appearance ("The group is on
  page 7. Going there in 10 seconds. Use Stay here to keep your page.");
  the seconds aren't announced each tick (`aria-live` off on the countdown
  text).
- Doesn't take focus.

### 6.15 ApprovalTray (AC20)
- `role="region"`, label "Join requests"; not modal, no focus steal.
- Collapsed: the oldest request. The name in `PlainText`, isolated
  (`dir="auto"` on its own `<bdi>`), at most 2 lines then ellipsis, with the
  full name in the accessible name. A missing name shows "Someone wants to
  join".
- "2 more waiting · Show all" (a text button) expands to a list of all
  requests in arrival order; "Show less" collapses.
- Buttons: **Deny** (outlined) and **Let in** (primary), each 44 px; their
  accessible names include the name ("Let Dana in", "Deny Dana").
- Row states: default, answering (spinner, both buttons aria-disabled),
  failed (inline error, buttons active again), gone (removed).
- A new request is announced politely: "Dana wants to join." It doesn't
  move focus.
- On >= 1024 px it's at the top of `GroupPanel` instead of the overlay.

### 6.16 ConfirmDialog
Modal `role="alertdialog"`, title, body, **Cancel** and the action. Focus
starts on **Cancel** (the safe choice); Esc cancels. The destructive action
(End group) uses the danger button style; Get new codes uses the primary
style.

### 6.17 NameField (AC7)
- Label "Your name (optional)", hint as above. `autocomplete="nickname"`,
  `maxlength` is the protocol's input cap (larger than 32, so a long paste
  can be explained rather than silently cut), `dir="auto"`.
- Checked on submit after trimming, with the same rule as the client (#13
  AC35):
  - blank: valid, a generated name;
  - over 32 characters: "Use 32 characters or fewer.";
  - control or bidi-control characters: "Remove hidden or special characters
    from the name.";
  - server `INVALID_DISPLAY_NAME`: the same message.
- A generated `Guest N` name is shown localised ("Guest 3" / "אורח 3").

### 6.18 MemberGroupView (indicator tapped while a member)
```
You're in a group                               ✕
Group's book: [Title]
Your name: Dana
The group is on page 9.          (when browsing)
[Go to page 9]                   (when browsing)
(8b slot)
                                  [Leave group]
```
- Leader offline or grace: one extra line, the indicator text and the time.
- Not connected: **Try again** (primary) above **Leave group**.
- Awaiting approval: this view is the WaitingView instead.

## 7. Microcopy (en and he)

Style follows item 7: short sentences that say what to do next. Hebrew uses
impersonal or plural forms ("אפשר", "כדאי", "מצטרפים") so it isn't gendered,
except "המוביל", the generic form for "the leader" (see open question U4).
Never "room", "token", "ticket", "fingerprint", "schema" or "metadata" in
headings or bodies; technical words only in Details. Key names are
suggestions for `src/i18n/en.ts` and `he.ts`.

### 7.1 Time formats
| Key | en | he | Use |
|---|---|---|---|
| `durationSeconds` | {s} s | {s} שנ׳ | visible countdowns under 60 s |
| `durationClock` | {m}:{ss} | {m}:{ss} | visible countdowns of 60 s or more |
| `secondsLong` | {n} seconds | {n} שניות | announcements |
| `secondsLongOne` | 1 second | שנייה אחת | announcements |
| `minutesLong` | {n} minutes | {n} דקות | announcements, rounded up |
| `minutesLongOne` | 1 minute | דקה אחת | announcements |

Every time value is an LTR isolate. Numbers use `Intl.NumberFormat(uiLang)`
(Latin digits for both languages).

### 7.2 Entry, sheet, create
| Key | en | he |
|---|---|---|
| `groupButton` | Group | קבוצה |
| `groupButtonName` | {state}, group options | {state}, אפשרויות קבוצה |
| `close` | Close | סגירה |
| `back` | Back | חזרה |
| `cancel` | Cancel | ביטול |
| `dismiss` | Dismiss | סגירה |
| `startTitle` | Read together | קריאה משותפת |
| `startIntro` | Start a group so others follow your page, or join someone else's group. | אפשר לפתוח קבוצה כדי שאחרים יעקבו אחרי העמוד שלך, או להצטרף לקבוצה של מישהו אחר. |
| `startGroup` | Start a group | פתיחת קבוצה |
| `joinGroup` | Join a group | הצטרפות לקבוצה |
| `bookLabel` | Book: | ספר: |
| `loadingOptions` | Loading options… | טוענים אפשרויות… |
| `methodsLegend` | How people join | איך מצטרפים |
| `methodGroupCode` | Group code | קוד קבוצה |
| `methodA` | With a door code | עם קוד כניסה |
| `methodAHint` | People enter two codes. | מקלידים שני קודים. |
| `methodB` | I let each person in | באישור שלי לכל מצטרף |
| `methodBHint` | You approve every request. | כל בקשה מחכה לאישור שלך. |
| `methodC` | One code with letters | קוד אחד עם אותיות |
| `methodCHint` | 8 letters and digits. | 8 אותיות וספרות. |
| `methodD` | QR code | קוד QR |
| `methodDHint` | People scan it with their phone's camera. | סורקים אותו במצלמת הטלפון. |
| `methodsOnly` | People join with: {method} | מצטרפים באמצעות: {method} |
| `methodsRequired` | Choose at least one way to join. | יש לבחור לפחות דרך הצטרפות אחת. |
| `handoffLegend` | If you lose connection | אם החיבור שלך יתנתק |
| `handoffAuto` | Pass the lead to someone else | להעביר את ההובלה למישהו אחר |
| `handoffAutoHint` | After a short wait, another member leads so the group can go on. | אחרי המתנה קצרה מישהו אחר בקבוצה מוביל, והקבוצה ממשיכה. |
| `handoffFrozen` | Pause the group until I'm back | לעצור את הקבוצה עד שאחזור |
| `handoffFrozenHint` | Nobody else leads. The group waits for you. | אף אחד אחר לא מוביל. הקבוצה מחכה לך. |
| `nameLabel` | Your name (optional) | השם שלך (לא חובה) |
| `nameHint` | Others in the group see it. Leave it empty to get a name like Guest 3. | חברי הקבוצה יראו אותו. אפשר להשאיר ריק ולקבל שם כמו אורח 3. |
| `nameTooLong` | Use 32 characters or fewer. | עד 32 תווים. |
| `nameInvalidChars` | Remove hidden or special characters from the name. | יש להסיר מהשם תווים נסתרים או מיוחדים. |
| `guestName` | Guest {n} | אורח {n} |
| `startGroupSubmit` | Start group | פתיחת הקבוצה |
| `starting` | Starting… | פותחים… |
| `createFailed` | Couldn't start the group. Try again. | לא הצלחנו לפתוח את הקבוצה. כדאי לנסות שוב. |

### 7.3 Leader: codes, QR, rotation, pause, end
| Key | en | he |
|---|---|---|
| `groupReadyTitle` | Your group is ready | הקבוצה מוכנה |
| `groupReadyBody` | Share these with the people joining. They stay at the top of your screen. | כדאי לשתף את הפרטים האלה עם המצטרפים. הם נשארים בראש המסך. |
| `startReading` | Start reading | להתחיל לקרוא |
| `yourGroupTitle` | Your group | הקבוצה שלך |
| `codesRegion` | Group codes | קודי הקבוצה |
| `groupCodeLabel` | Group code | קוד קבוצה |
| `doorCodeLabel` | Door code | קוד כניסה |
| `alphaCodeLabel` | Code | קוד |
| `groupCodeShort` | Group | קבוצה |
| `doorCodeShort` | Door | כניסה |
| `codeSpoken` | {label}: {spelled} | {label}: {spelled} |
| `qrOnlyStrip` | People join with the QR code | מצטרפים עם קוד ה-QR |
| `qrButton` | QR | QR |
| `showQr` | Show QR code | הצגת קוד QR |
| `hideQr` | Hide QR code | הסתרת קוד QR |
| `qrTitle` | Scan to join | סורקים ומצטרפים |
| `qrHint` | Open your phone's camera and point it at the code. | פותחים את המצלמה בטלפון ומכוונים אותה אל הקוד. |
| `qrImageName` | QR code to join this group | קוד QR להצטרפות לקבוצה |
| `qrLoading` | Making a QR code… | יוצרים קוד QR… |
| `qrError` | Can't show a QR code right now. People can still join with a code. | אי אפשר להציג קוד QR כרגע. עדיין אפשר להצטרף עם קוד. |
| `qrErrorOnly` | Can't show a QR code right now. | אי אפשר להציג קוד QR כרגע. |
| `qrOffline` | The QR code will refresh when you're back online. | קוד ה-QR יתחדש כשהחיבור יחזור. |
| `yourName` | Your name: {name} | השם שלך: {name} |
| `newCodes` | Get new codes | קודים חדשים |
| `rotateConfirmTitle` | Get new codes? | ליצור קודים חדשים? |
| `rotateConfirmBody` | The current codes and QR code will stop working. People already in the group stay in. | הקודים וקוד ה-QR הנוכחיים יפסיקו לעבוד. מי שכבר בקבוצה נשאר בה. |
| `rotateConfirm` | Get new codes | ליצור קודים חדשים |
| `rotating` | Getting new codes… | יוצרים קודים חדשים… |
| `rotateFailed` | Couldn't get new codes. The current ones still work. Try again. | לא הצלחנו ליצור קודים חדשים. הקודים הנוכחיים עדיין עובדים. כדאי לנסות שוב. |
| `codesRotated` | New codes are ready. The old ones no longer work. | יש קודים חדשים. הקודים הקודמים כבר לא עובדים. |
| `codesDoorFailures` | Someone entered a wrong door code too many times, so there's a new door code. | הוזן קוד כניסה שגוי יותר מדי פעמים, ולכן יש קוד כניסה חדש. |
| `codesMemberRemoved` | The codes changed after someone was removed. | הקודים השתנו אחרי שמישהו הוסר מהקבוצה. |
| `codesSuperseded` | The group's codes changed. | קודי הקבוצה השתנו. |
| `codesResumed` | Your group was restarted with new codes. | הקבוצה הופעלה מחדש עם קודים חדשים. |
| `joinPausedLeader` | Joining with the door code is paused. {time} left. | ההצטרפות עם קוד כניסה מושהית. נותרו {time}. |
| `joinResumedLeader` | Joining with the door code works again. | אפשר שוב להצטרף עם קוד כניסה. |
| `endGroup` | End group | סיום הקבוצה |
| `endConfirmTitle` | End the group for everyone? | לסיים את הקבוצה לכולם? |
| `endConfirmBody` | Everyone stops following. They can keep reading on their own. | כולם יפסיקו לעקוב. אפשר להמשיך לקרוא לבד. |
| `ending` | Ending… | מסיימים… |
| `endFailed` | Couldn't end the group. Try again. | לא הצלחנו לסיים את הקבוצה. כדאי לנסות שוב. |

### 7.4 Join: form, door code, waiting, QR, errors (AC14-AC19)
| Key | en | he |
|---|---|---|
| `joinTitle` | Join a group | הצטרפות לקבוצה |
| `codeLabel` | Code | קוד |
| `codeHint` | The code the leader gives you. | הקוד שמקבלים מהמוביל. |
| `codeHasLetters` | My code has letters | יש בקוד אותיות |
| `codeDigitsOnly` | My code is only digits | בקוד יש רק ספרות |
| `codeEmpty` | Enter the code. | יש להזין את הקוד. |
| `codeFormat` | A code is 6 digits, or 8 letters and digits. | קוד הוא 6 ספרות, או 8 אותיות וספרות. |
| `joinSubmit` | Join | הצטרפות |
| `joining` | Joining… | מצטרפים… |
| `doorTitle` | Enter the door code | הזנת קוד כניסה |
| `doorBody` | This group also needs a door code. Ask the leader for it. | בקבוצה הזו צריך גם קוד כניסה. אפשר לבקש אותו מהמוביל. |
| `doorEmpty` | Enter the door code. | יש להזין את קוד הכניסה. |
| `doorFormat` | The door code is 6 digits. | קוד הכניסה הוא 6 ספרות. |
| `changeCode` | Change | שינוי |
| `canTryNow` | You can try again now. | אפשר לנסות שוב עכשיו. |
| `waitingTitle` | Waiting for the leader | ממתינים למוביל |
| `waitingBody` | The leader needs to let you in. You can keep reading while you wait. | המוביל צריך לאשר את ההצטרפות. אפשר להמשיך לקרוא בזמן ההמתנה. |
| `waitingTimeLeft` | {time} left | נותרו {time} |
| `cancelRequest` | Cancel request | ביטול הבקשה |
| `qrJoiningTitle` | Joining the group… | מצטרפים לקבוצה… |
| `qrJoinFailedTitle` | Couldn't join the group | ההצטרפות לקבוצה נכשלה |
| `joinWithCode` | Join with a code | הצטרפות עם קוד |
| `readOnMyOwn` | Read on my own | לקרוא לבד |
| `openingGroupBook` | Opening the group's book… | פותחים את הספר של הקבוצה… |
| `groupBookMissingTitle` | This app doesn't have the group's book | הספר של הקבוצה לא נמצא באפליקציה |
| `groupBookMissingBody` | Leave the group, then scan the leader's QR code to open the same book. | אפשר לצאת מהקבוצה ולסרוק את קוד ה-QR של המוביל כדי לפתוח את אותו ספר. |
| `libraryInGroup` | You're in a group reading {title}. | הקבוצה שלך קוראת את {title}. |

Join and create errors. Every one ends with a next step and none repeats the
code, ticket or any server text.

| Code (client) | Key | en | he | Where focus goes |
|---|---|---|---|---|
| `CODE_NOT_FOUND`, `INVALID_JOIN_CODE` from the server | `errCodeNotFound` | That code didn't work. Check it with the leader and try again. | הקוד לא עבד. כדאי לבדוק אותו מול המוביל ולנסות שוב. | code field |
| `DOOR_CODE_WRONG` | `errDoorWrong` | That door code didn't work. Check it with the leader and try again. | קוד הכניסה לא עבד. כדאי לבדוק אותו מול המוביל ולנסות שוב. | door field (cleared) |
| `JOIN_PAUSED` with time | `errJoinPaused` | Joining with this code is paused. Try again in {time}. | ההצטרפות עם הקוד הזה מושהית. אפשר לנסות שוב בעוד {time}. | message |
| `JOIN_PAUSED` without time | `errJoinPausedNoTime` | Joining with this code is paused. Try again in a few minutes. | ההצטרפות עם הקוד הזה מושהית. כדאי לנסות שוב בעוד כמה דקות. | message |
| `JOIN_DENIED` | `errJoinDenied` | The leader didn't let you in. Talk to the leader, then try again. | המוביל לא אישר את ההצטרפות. אפשר לדבר איתו ולנסות שוב. | message |
| `APPROVAL_TIMEOUT` | `errApprovalTimeout` | The leader didn't answer in time. Ask them to check their screen, then try again. | המוביל לא ענה בזמן. אפשר לבקש ממנו לבדוק את המסך ולנסות שוב. | message |
| `APPROVAL_QUEUE_FULL` | `errQueueFull` | Too many people are waiting to join right now. Try again in a minute. | יותר מדי אנשים ממתינים להצטרף כרגע. כדאי לנסות שוב בעוד דקה. | message |
| `QR_INVALID` | `errQrInvalid` | This QR code doesn't work. Scan the leader's code again, or join with a code. | קוד ה-QR הזה לא עובד. אפשר לסרוק שוב את הקוד של המוביל, או להצטרף עם קוד. | heading |
| `QR_EXPIRED` | `errQrExpired` | This QR code has expired. Scan the leader's current code, or join with a code. | תוקף קוד ה-QR פג. אפשר לסרוק את הקוד העדכני של המוביל, או להצטרף עם קוד. | heading |
| `RATE_LIMITED` with time | `errRateLimited` | Too many tries. Try again in {time}. | יותר מדי ניסיונות. אפשר לנסות שוב בעוד {time}. | message |
| `RATE_LIMITED` without time | `errRateLimitedNoTime` | Too many tries. Wait a moment, then try again. | יותר מדי ניסיונות. כדאי לחכות רגע ולנסות שוב. | message |
| `GROUP_LOCKED` | `errGroupLocked` | This group isn't letting new people in right now. Ask the leader. | הקבוצה לא מקבלת מצטרפים חדשים כרגע. אפשר לפנות למוביל. | message |
| `GROUP_FULL` (also an approval ending in `group_full`) | `errGroupFull` | This group is full. Ask the leader. | הקבוצה מלאה. אפשר לפנות למוביל. | message |
| `JOIN_METHOD_NOT_ALLOWED`, `JOIN_METHOD_UNAVAILABLE` | `errMethod` | This group doesn't take this kind of code. Ask the leader which code to use. | הקבוצה לא מקבלת קוד מהסוג הזה. אפשר לשאול את המוביל באיזה קוד להשתמש. | message |
| `ALREADY_IN_GROUP` | `errAlreadyInGroup` | You're already in a group. Leave it first. | כבר יש לך קבוצה. יש לצאת ממנה קודם. | message |
| `INVALID_DISPLAY_NAME` | `nameInvalidChars` | (as 7.2) | (as 7.2) | name field |
| `NOT_CONNECTED`, `CONNECTION_LOST`, `REQUEST_TIMEOUT`, `NO_WEBSOCKET`, `RECONNECT_FAILED`, `HANDSHAKE_TIMEOUT` | `errNetwork` | Can't reach the group service. Check your connection, then try again. | אין חיבור לשירות הקבוצות. כדאי לבדוק את החיבור ולנסות שוב. | message |
| `APP_CONNECTION_LIMIT`, `CODES_EXHAUSTED` | `errBusy` | The group service is busy. Try again in a minute. | שירות הקבוצות עמוס. כדאי לנסות שוב בעוד דקה. | message |
| `INTERNAL_ERROR`, anything unknown | `errServer` | Something went wrong on the group service. Try again. | משהו השתבש בשירות הקבוצות. כדאי לנסות שוב. | message |
| `INVALID_API_KEY` | `errSetup` | Groups aren't set up correctly in this app. Ask the person who runs it. | הקבוצות לא מוגדרות נכון באפליקציה. אפשר לפנות למי שמפעיל אותה. | message |
| `APP_VERSION_TOO_OLD`, `PROTOCOL_TOO_OLD`, `SERVER_UNSUPPORTED` | (section 6.12 screen) | | | heading |
| `JOIN_CANCELLED` | (no message: the user cancelled) | | | code field |

### 7.5 Mismatch, update required
| Key | en | he |
|---|---|---|
| `mismatchContentTitle` | This group is reading a different book | הקבוצה קוראת ספר אחר |
| `mismatchContentBody` | You can't follow it with this book. Open the group's book, or leave the group. | אי אפשר לעקוב אחריה עם הספר הזה. אפשר לפתוח את הספר של הקבוצה, או לצאת מהקבוצה. |
| `mismatchContentBodyNoOpen` | You can't follow it with this book. Leave the group to keep reading on your own. | אי אפשר לעקוב אחריה עם הספר הזה. אפשר לצאת מהקבוצה ולהמשיך לקרוא לבד. |
| `openGroupBook` | Open the group's book | פתיחת הספר של הקבוצה |
| `groupBookIdLabel` | Group's book ID: | מזהה הספר של הקבוצה: |
| `mismatchSchemaTitle` | This app can't follow this group | האפליקציה לא יכולה לעקוב אחרי הקבוצה הזו |
| `mismatchSchemaBody` | The group's book uses a format this app doesn't read. Update the app, or leave the group. | הספר של הקבוצה בפורמט שהאפליקציה לא קוראת. אפשר לעדכן את האפליקציה או לצאת מהקבוצה. |
| `mismatchSchemaDetails` | Group's schema version {version}. This app reads version {supported}. | גרסת הסכמה של הקבוצה: {version}. האפליקציה קוראת גרסה {supported}. |
| `mismatchMalformedDetails` | The group sent book details this app can't read. | הקבוצה שלחה פרטי ספר שהאפליקציה לא מצליחה לקרוא. |
| `mismatchVersionTitle` | Your copy is a different version | העותק שלך בגרסה אחרת |
| `mismatchVersionBody` | It's the same book, but the text isn't identical to the leader's. Pages may not match exactly. | זה אותו ספר, אבל הטקסט לא זהה לזה של המוביל. ייתכן שהעמודים לא יתאימו בדיוק. |
| `followAnyway` | Follow anyway | לעקוב בכל זאת |
| `leaveGroup` | Leave group | יציאה מהקבוצה |
| `leaving` | Leaving… | יוצאים… |
| `leaveFailed` | Couldn't leave the group. Try again. | לא הצלחנו לצאת מהקבוצה. כדאי לנסות שוב. |
| `updateTitle` | Update the app to use groups | יש לעדכן את האפליקציה כדי להשתמש בקבוצות |
| `updateBody` | This version can't connect to the group service. Reload to get the latest version. | הגרסה הזו לא יכולה להתחבר לשירות הקבוצות. טעינה מחדש תביא את הגרסה העדכנית. |
| `updateDetails` | Minimum app version: {version} | גרסת אפליקציה מינימלית: {version} |
| `reload` | Reload | טעינה מחדש |
| `readWithoutGroup` | Read without a group | לקרוא בלי קבוצה |
| `serverUnsupportedTitle` | Groups aren't available | קבוצות לא זמינות |
| `serverUnsupportedBody` | The group service doesn't work with this version of the app. Ask the person who runs it to update it. | שירות הקבוצות לא עובד עם הגרסה הזו של האפליקציה. אפשר לבקש ממי שמפעיל אותו לעדכן אותו. |
| `serverProtocolDetails` | Group service protocol version {version}. | גרסת הפרוטוקול של שירות הקבוצות: {version}. |
| `syncConfigInvalidDetails` | Sync settings are not valid. | הגדרות הסנכרון לא תקינות. |

### 7.6 Following, prompts, member view
| Key | en | he |
|---|---|---|
| `memberGroupTitle` | You're in a group | הצטרפת לקבוצה |
| `groupBookLabel` | Group's book: | הספר של הקבוצה: |
| `groupOnPage` | The group is on page {n}. | הקבוצה בעמוד {n}. |
| `goToPage` | Go to page {n} | מעבר לעמוד {n} |
| `stayHere` | Stay here | להישאר כאן |
| `goNow` | Go now | לעבור עכשיו |
| `lateJoinCountdown` | Going there in {time}. | עוברים לשם בעוד {time}. |
| `jumpRegion` | Group page | עמוד הקבוצה |
| `announceLateJoin` | The group is on page {n}. Going there in {time}. Use Stay here to keep your page. | הקבוצה בעמוד {n}. עוברים לשם בעוד {time}. כדי להישאר בעמוד הנוכחי יש לבחור "להישאר כאן". |
| `announceJump` | The group is on page {n}. | הקבוצה בעמוד {n}. |

### 7.7 Indicator and announcements
| Key | en | he |
|---|---|---|
| `indFollowing` | Following | עם הקבוצה |
| `indNotFollowing` | Not following | לא בעמוד הקבוצה |
| `indLeading` | Leading | בהובלתך |
| `indReconnecting` | Reconnecting… | מתחברים מחדש… |
| `indLeaderOffline` | Leader offline | המוביל לא מחובר |
| `indLeaderGrace` | Waiting for leader · {time} | ממתינים למוביל · {time} |
| `indAwaiting` | Waiting for approval | ממתינים לאישור |
| `indJoining` | Joining… | מצטרפים… |
| `indDisconnected` | Not connected | אין חיבור |
| `announceFollowing` | Following the group. | עוקבים אחרי הקבוצה. |
| `announceNotFollowing` | Not following the group. | לא עוקבים אחרי הקבוצה. |
| `announceLeading` | You're leading the group. | הקבוצה בהובלתך. |
| `announceReconnecting` | Connection lost. Reconnecting… | החיבור נותק. מתחברים מחדש… |
| `announceBack` | Back with the group. | החיבור לקבוצה חזר. |
| `announceLeaderOffline` | The leader is offline. | המוביל לא מחובר. |
| `announceLeaderGrace` | The leader is away. Waiting up to {time}. | המוביל לא זמין. ממתינים עד {time}. |
| `announceLeaderBack` | The leader is back. | המוביל חזר. |
| `announceAwaiting` | Waiting for the leader to let you in. | ממתינים לאישור המוביל. |
| `announceAdmitted` | You're in. Following the group. | ההצטרפות אושרה. עוקבים אחרי הקבוצה. |
| `announceDisconnected` | Can't reach the group. Use Group to try again. | אין חיבור לקבוצה. אפשר לנסות שוב דרך כפתור הקבוצה. |

### 7.8 Approval tray, group ended, notices
| Key | en | he |
|---|---|---|
| `approvalRegion` | Join requests | בקשות הצטרפות |
| `approvalRequest` | {name} wants to join | בקשת הצטרפות מ{name} |
| `approvalSomeone` | Someone wants to join | בקשת הצטרפות חדשה |
| `approve` | Let in | אישור |
| `approveName` | Let {name} in | אישור ההצטרפות של {name} |
| `deny` | Deny | דחייה |
| `denyName` | Deny {name} | דחיית ההצטרפות של {name} |
| `approvalMore` | {n} more waiting | עוד {n} ממתינים |
| `approvalMoreOne` | 1 more waiting | עוד בקשה אחת ממתינה |
| `showAll` | Show all | הצגת הכול |
| `showLess` | Show less | הצגת פחות |
| `approvalFailed` | Couldn't answer this request. Try again. | לא הצלחנו לענות לבקשה. כדאי לנסות שוב. |
| `announceRequest` | {name} wants to join. | בקשת הצטרפות מ{name}. |
| `endedByLeader` | The leader ended the group. You can keep reading. | המוביל סיים את הקבוצה. אפשר להמשיך לקרוא. |
| `endedByYou` | You ended the group. | סיימת את הקבוצה. |
| `leftGroup` | You left the group. | יצאת מהקבוצה. |
| `endedMaxSession` | The group reached its time limit and ended. You can keep reading. | הקבוצה הגיעה למגבלת הזמן שלה והסתיימה. אפשר להמשיך לקרוא. |
| `endedInactivity` | The group ended after a long time with no activity. You can keep reading. | הקבוצה הסתיימה אחרי זמן רב ללא פעילות. אפשר להמשיך לקרוא. |
| `endedLeaderTimeout` | The group ended because the leader didn't come back. You can keep reading. | הקבוצה הסתיימה כי המוביל לא חזר. אפשר להמשיך לקרוא. |
| `endedRemoved` | You were removed from the group. | הוסרת מהקבוצה. |
| `endedReplaced` | This group is open in another tab or device, so this tab left it. | הקבוצה פתוחה בכרטיסייה או במכשיר אחר, ולכן הכרטיסייה הזו יצאה ממנה. |
| `endedRejoinFailed` | Couldn't get back into the group. It may have ended. | לא הצלחנו לחזור לקבוצה. ייתכן שהיא הסתיימה. |
| `storedGroupGone` | Your group has ended. | הקבוצה שלך הסתיימה. |

Mapping of `GroupEndedReason` to copy: `ended_by_leader` → `endedByLeader`;
`left` → `endedByYou` (the leader's own `endGroup`) or `leftGroup` (a member);
`max_session` → `endedMaxSession`; `inactivity` → `endedInactivity`;
`leader_timeout` → `endedLeaderTimeout`; `removed` (and connection closed with
reason `removed`) → `endedRemoved`; `replaced` → `endedReplaced`;
`rejoin_failed` → `endedRejoinFailed`, except a resume at page load whose
token is gone or expired → `storedGroupGone`; `closed` → no notice.

Hebrew note: `approvalRequest` attaches "מ" directly to the name, which is an
isolate; with a Latin name this renders as `מ⁨Dana⁩` and reads correctly.
QA's native-speaker check should confirm it, or use "בקשת הצטרפות: {name}".

## 8. RTL and bidi (AC50, AC51)

- Every new screen, sheet, prompt, strip, panel and notice follows the
  **interface** direction (`<html dir>`), independent of the content's
  direction (item 7 AC12). Use logical properties only: the panel is at the
  inline end, the Back chevron points to the inline start, the Close button
  is at the inline end, the countdown bar shrinks toward the inline start.
- `PageNav` keeps item 7's document-direction rule. The JumpPrompt's **Go to
  page** doesn't carry a direction arrow (it's not "next").
- **Isolated values** (each in its own `<bdi>` or an element with `dir` and
  `unicode-bidi: isolate`):

| Value | Direction | Notes |
|---|---|---|
| Group code, door code, alphanumeric code (display and input) | `ltr` | digit order is always left to right (AC18) |
| Times and countdowns | `ltr` | `0:24`, `10 s` |
| Page numbers in prompts | inherited, but in their own isolate | numbers next to Hebrew punctuation |
| Display names (own name, join requests) | `auto` (first-strong) | `PlainText`; never HTML (AC51) |
| Book titles | the document's `dir` and `lang` | as item 7 |
| Leader content IDs on mismatch screens | `ltr` | truncated to 40 characters (AC24) |
| Version strings in Details | `ltr` | |

- Code inputs use `dir="ltr"` and `text-align: left` in both interfaces. Their
  labels and hints stay in the interface direction above and below.
- Mixed example, `he` interface, a Hebrew name and an English name in the
  tray: `בקשת הצטרפות מ⁨דנה⁩` and `בקשת הצטרפות מ⁨Dana Lee⁩`; neither
  reorders the surrounding words.
- Test fixtures: names `<b>x</b>`, `‮evil`, `דנה (Dana)`, `Dana 2`, a
  32-character Arabic name; a content ID with `<script>`-like text.

## 9. Accessibility and focus

### Live announcements
- One polite region (item 7's `LiveAnnouncer`) for page turns, indicator
  changes, codes changes, new join requests and jump-prompt updates. If two
  messages arrive together, the later replaces the earlier. A leader move
  that turns a following member's page announces only "Page 8 of 12"; the
  indicator change, if any, comes after it and doesn't replace it.
- An assertive region (`role="alert"`) only for form errors inside the sheet
  and for the ApprovalTray's failure line. Nothing else interrupts.
- Countdowns are never announced each second. Each one is announced once
  when it appears.

### Focus rules (AC52)
| Element | Takes focus on appear? | Focus on close |
|---|---|---|
| GroupSheet (user opened) | yes: first field, or the view title | back to the GroupButton (or the strip's QR button if opened there) |
| GroupSheet opened by the app (QR landing, approval result) | yes: the title or the message | the article |
| VersionWarnDialog, MismatchBlock | yes: heading | n/a (choice replaces the screen) |
| ConfirmDialog | yes: Cancel | the button that opened it |
| JumpPrompt, LateJoinPrompt | no | if focus was inside when it closes, to the article |
| ApprovalTray | no | per F9 step 3 |
| Codes notice, group-ended NoticeBar | no | after Dismiss, to the article |
| Update required, groups unavailable | yes: heading (StatusScreen) | |

- Modal sheets and dialogs use the native `<dialog>` with `showModal()`
  (inert background, Esc closes except VersionWarnDialog), `aria-labelledby`
  on the title.
- Arrow-key page turns are disabled while a modal is open, and inside any
  text input (item 7 rule, now including the code fields).
- Tab order on the reading screen: header (title, counter, GroupButton), code
  strip (leader), codes notice, article, overlay prompts or tray, PageNav. On
  >= 1024 px the panel comes after PageNav in DOM order but is a labelled
  `<aside>` (landmark "Your group"), so screen-reader users can jump to it.

### Other
- All controls are real buttons or links, 44 x 44 px minimum.
- No state depends on colour alone (section 5.2).
- The QR image has an accessible name ("QR code to join this group") and the
  codes next to it, so a blind leader can still read the codes out.
- Reduced motion: no sheet slide, no countdown bar, no code highlight fade,
  static spinners (item 7 rule).
- 200 % zoom: the header and strip wrap, never truncate codes or states; the
  sheet scrolls with its footer sticky.
- `document.title` stays the book title; it isn't changed by group state.

## 10. Visual design: tokens reused and added

### Reused (`apps/reader/src/styles/tokens.css`)
All colour tokens; `--font-ui`; `--text-sm`, `--text-md`, `--text-lg`,
`--text-xl` with their line heights; weights; `--space-*`; `--radius-sm`,
`--radius-md`; `--hairline`, `--focus-ring`; `--size-header`, `--size-nav`,
`--size-target`, `--size-icon`; `--measure-text`, `--measure-status`;
`--duration-fast`, `--easing`. Components reused: `StatusScreen`,
`LoadingScreen` spinner style, `NoticeBar` pattern, `LiveAnnouncer`,
`PlainText`, item 7's primary and secondary button styles.

### Added (flagged: changing tokens is a design decision, ADR 0002)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-positive` | `#1E7A3C` | `#81C995` | following / leading dot |
| `--color-warning` | `#8A5A00` | `#FDD663` | reconnecting, leader offline/away, pause line text and icon |
| `--color-accent-subtle` | `#E8F0FC` | `#1B2A41` | code-change highlight, selected option background |
| `--color-danger-subtle` | `#FCEDEC` | `#3A1F1D` | form error box background |
| `--color-on-danger` | `#FFFFFF` | `#121416` | text on danger buttons (End group confirm) |
| `--color-qr-dark` | `#000000` | `#000000` | QR modules (fixed in both themes) |
| `--color-qr-light` | `#FFFFFF` | `#FFFFFF` | QR background and quiet zone (fixed) |
| `--color-backdrop` | `rgb(0 0 0 / 40%)` | `rgb(0 0 0 / 60%)` | modal backdrop |
| `--shadow-raised` | `0 4px 16px rgb(0 0 0 / 16%)` | `0 4px 16px rgb(0 0 0 / 50%)` | sheets, dialogs, docked prompts |
| `--text-code` | 1.125rem (phone), 1.5rem (>= 640 px) | | codes in the strip and inputs |
| `--text-code-lg` | 2.5rem, line height 1.2 | | codes in panel, ready view, QR sheet |
| `--radius-lg` | 16px | | sheet top corners |
| `--radius-pill` | 999px | | GroupButton |
| `--size-strip` | 2.75rem | | CodeStrip min height |
| `--size-panel` | 20rem | | GroupPanel width |
| `--size-qr` | `min(18rem, 80vw, 55dvh)` | | QR square in sheets (panel: its width) |
| `--measure-sheet` | 28rem | | dialog width >= 640 px |
| `--duration-sheet` | 200ms (0 with reduced motion) | | sheet slide |
| `--z-chrome` / `--z-overlay` / `--z-modal` | 2 / 3 / 10 | | header/nav, prompts, dialogs |

Contrast (WCAG relative luminance, computed):

| Pair | Light | Dark |
|---|---|---|
| positive / surface (dot, 3:1 needed) | 5.0:1 | 8.5:1 |
| warning / surface (text, 4.5:1 needed) | 5.5:1 | 11.8:1 |
| text / accent-subtle | 15.0:1 | 12.0:1 |
| accent / accent-subtle | 5.3:1 | 6.9:1 |
| danger / danger-subtle (text) | 5.7:1 | 6.3:1 |
| on-danger / danger | 6.5:1 | 7.7:1 |
| qr-dark / qr-light | 21:1 | 21:1 |

The QR always renders dark on light with a quiet zone of 4 modules, because
many camera apps fail on inverted codes. In dark mode it sits in a white
square with `--radius-md` corners outside the quiet zone.

### Breakpoints
Unchanged: `--bp-sm` 640 px, `--bp-lg` 1024 px. 8a uses `--bp-lg` for the
`GroupPanel` (item 7 reserved it for this).

## 11. Reserved for 8b (#25), not designed here
- `GroupPanel` and `LeaderGroupView`/`MemberGroupView`: a "Members" slot
  between the codes and the actions (roster counter and list, vice-leader,
  remove, lock).
- A banner slot directly under the header, above the code strip, for the
  preview banner and leader-changed / lost-lead / now-leading notices. Only
  one banner at a time; 8a's codes notice sits below it.
- The overlay layer stacks at most one prompt card above the ApprovalTray;
  8b's keep-alive and take-back prompts go into the same layer and take
  precedence over the jump prompt.
- `GroupButton` stays the single entry point for all group actions.

## 12. Acceptance criteria mapping

| AC | Where it shows up |
|---|---|
| AC1 | F0: no-config solo reader; invalid config → "This app isn't set up" with `syncConfigInvalidDetails` |
| AC2 | F0 step 1: no Group button, no library join, no connection |
| AC3 | none (dev config and README) |
| AC4 | 6.12 Update required / Groups unavailable screens with Reload and Read without a group |
| AC5 | 6.3 CreateGroupForm: methods (A/B radio), handoff, name, defaults; F1 |
| AC6 | F1 step 3 (no UI; metadata sent unchanged) |
| AC7 | 6.17 NameField rules and messages |
| AC8 | 4.2 CodeStrip (< 1024 px), 4.3 GroupPanel (>= 1024 px), table per method; 6.4 CodeDisplay |
| AC9 | F10.1, 6.6 codes notice, copy `codesRotated`…`codesResumed` |
| AC10 | F10.2, 6.16 ConfirmDialog, `rotateConfirm*` |
| AC11 | F10.3 pause line with countdown in strip and panel |
| AC12 | 4.3, 4.5, 6.5: QR shown on demand, refreshed silently, hidden = not issued; QR states (`qrLoading`, `qrError`, `qrOffline`) |
| AC13 | F13: strip, panel, QR and tray only for the current leader |
| AC14 | F2 + 6.7 DoorCodeView |
| AC15 | F3 + WaitingView, time left, Cancel request |
| AC16 | F2: one code field, classification by the client; 6.8 letters toggle |
| AC17 | F5: camera app → deep link → QrJoinView; ticket removed first |
| AC18 | 6.8 CodeField: paste, spaces and dashes ignored, numeric keypad, LTR in `he` |
| AC19 | 7.4 error table, en and he, next step, focus target, no echo |
| AC20 | F9 + 6.15 ApprovalTray |
| AC21 | F6 runs after admission and resume, before positioning |
| AC22 | 6.11 MismatchBlock: different book, can't follow |
| AC23 | 6.11 VersionWarnDialog |
| AC24 | 6.11 Details, 8 bidi table: content ID plain text, LTR isolate, truncated |
| AC25 | F7 step 3 (auto-follow with the page animation) |
| AC26 | F7 step 4 + 6.13 JumpPrompt |
| AC27 | F7 step 5 (official position only) |
| AC28 | F8 + 6.14 LateJoinPrompt (10 s from config); open question U1 |
| AC29 | F7 step 5 (ignored silently) |
| AC30 | 5.2 indicator state table, text per state, announcements |
| AC31 | 5.2 "Not following" + JumpPrompt + MemberGroupView |
| AC32 | F12 steps 1-2 |
| AC33 | F12 step 3 + 7.8 ended copy and reason mapping |
| AC34 | F11 steps 1-3 |
| AC35 | F11 step 4; members see `leader_grace` countdown |
| AC36 | F11 step 1 and 3 (positions per role) |
| AC37 | F11 step 5 `storedGroupGone` once, no retry loop |
| AC50 | section 7 (every string in en and he), section 8 |
| AC51 | 6.15, 6.17, 8: names through `PlainText`, isolated |
| AC52 | section 9 focus table |
| AC53 | 5.2, 6.14: countdowns from durations, recomputed on visibility change |
| AC54 | none (no visible UI); copy never includes codes, names in logs is the architect's concern |
| AC55 | none (CI); README documents join flows using this copy |
| AC56 | F2 and F5 tap counts; fresh-joiner rule (F8 step 3) keeps the countdown out of the 15 s path |

## 13. Decisions needed (for the architect)

The design system is decided (ADR 0002); no new ADR is needed for styling.
Points for the plan:

- **D1. New tokens** (section 10). Add them to `tokens.css`; the token
  file's header says changing tokens is a design decision, so list them in
  the plan.
- **D2. `<dialog>` for sheets and dialogs.** Native `showModal()` gives the
  inert background and focus handling without a dependency; check it against
  the CSP and the test environment (jsdom's `<dialog>` support is partial).
- **D3. Reader-side state** that isn't in the client: the following/browsing
  mode, "fresh joiner" (no page turn since the book opened in this tab), the
  version-warning acknowledgement, and the QR shown/hidden choice; all per
  tab in `sessionStorage` next to the position (AC36).
- **D4. Membership across the library → book navigation** (F4, F6 "Open the
  group's book"): the token resume at the new page must restore the group
  without a visible re-join. If that isn't feasible, the alternative is an
  in-app route change; the design works with either as long as the indicator
  shows Reconnecting… at most briefly.
- **D5. Generated name localisation**: the client says `generated: true`;
  the reader needs the number to show "אורח 3". Decide how it's extracted.
- **D6. Grace duration in the create form**: if the app's grace seconds are
  available from `hello.ok` limits, `handoffAutoHint` can say "After {time}"
  instead of "After a short wait". Optional.

## 14. Open questions (for the user)

Recommendation first in each.

- **U1. Countdown for fresh joiners.** Recommendation: someone who just
  opened the book (by QR, or joined without turning a page in this tab) goes
  straight to the group's page, and the 10 s countdown applies only to
  members who were already reading somewhere else. Reason: the countdown is
  there to protect a reader's own place; a fresh joiner has none, and a 10 s
  wait would put the 15 s "open to following" target (AC56) at risk.
  Alternative: everyone whose page differs gets the countdown, as AC28 reads
  literally.
- **U2. "Open the group's book" on the different-book block.** Recommendation:
  offer it when the group's book is bundled (and not in single-book mode), so
  a code joiner who opened the wrong book is one tap away from following.
  The membership is kept; it's a navigation, not in-app switching. AC22 allows
  it "where Decision Q4 allows". Alternative: only **Leave group** on reading
  pages; "Open the group's book" only after a library join.
- **U3. Member leave without confirmation.** Recommendation: no confirmation
  for a member leaving (it affects only them and the room has the code); the
  leader's End group is confirmed (AC32). Alternative: confirm both.
- **U4. Hebrew "leader".** Recommendation: the generic "המוביל" in all
  strings, which is short and common in Hebrew interfaces; QA's
  native-speaker check reviews it. Alternative: neutral constructions
  everywhere ("מי שמוביל את הקבוצה"), which are longer and harder to fit in
  the indicator.
