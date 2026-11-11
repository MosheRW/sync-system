# Design: #25 reading app leader views and lifecycle prompts (PRD item 8b)

Scope: AC38-AC49 and AC57-AC61, with the cross-cutting AC50-AC55 of #24
applied to every new screen. Text spec only (no mockups); wireframes are
plain-text sketches of the English interface.

This design **extends `docs/issues/24/design.md`** (cited below as "8a
section N") and doesn't replace it. Everything 8a defines carries over:
`GroupButton`, `GroupSheet`, `CodeStrip`, `GroupPanel`, `NoticeBar`,
`ConfirmDialog`, `Dialog`, the docked prompt card, `LiveAnnouncer`,
`PlainText`, the copy style (8a section 7) and the focus rules (8a section 9).
ADR 0002 (CSS Modules, `tokens.css`, logical properties) and ADR 0003 (`en`
and `he`, `format()` with `{n}` placeholders) apply unchanged. Hebrew uses
"המוביל" for "the leader" (#24 U4).

Gate 1 decisions used here: Q1 (explicit Preview control), Q2 (`--bp-lg`),
Q4 (keep-alive run-out on the client), Q5 (AC60), Q6 (AC61), Q7 (AC57 notice
only), Q9 (he term for vice-leader, below), Q10 (counter wording), Gap 1
(stale take-back offer cleared, `NOT_ALLOWED` message).

---

## 1. Users and context

| User | Goal in 8b | Context |
|---|---|---|
| Leader | Know who's there, look ahead privately, keep control (vice, remove, lock), keep an idle group alive with one tap | Phone or tablet in front of a room, or a laptop; attention on the text and the room |
| Member who suddenly leads | Understand at once that they lead and why; not move everyone by accident | Was reading or browsing; didn't ask for this |
| Leader who lost the lead | Understand why the controls vanished; take the lead back if offered | Often just came back from a phone lock or a dropped network |
| Vice-leader | Know they're the backup | Reading as a member |
| Member | Understand a leader change or a lock without being interrupted | Reading |
| Someone who pasted a QR link into an open tab | Know why nothing happened and what to do | Desktop or phone browser |
| Screen-reader and keyboard users, Hebrew-interface users | Same as above, in their language and direction | As 8a |

Attention rule (unchanged from 8a): reading stays the focus. In 8b only two
things take focus on their own: the "you're now leading" moment (AC46) and the
remove confirmation the leader opened (AC52). Everything else is announced
without moving focus.

## 2. Where things go: slots, layers and priority

8b fills the slots 8a reserved (8a section 11). This section is the single
rule for what wins when several things want the same place.

### 2.1 The four places

| Place | What it is | Holds (8b) | Takes focus |
|---|---|---|---|
| **M. Modal layer** | Native `<dialog>` via the existing `Dialog`, one at a time | Now-leading dialog (6.8), remove confirmation (6.6) | yes |
| **O. Overlay layer** | Docked cards at the bottom of the reading column (8a 4.1), at most **one prompt card**, plus the ApprovalTray below it on phones | Keep-alive card (6.7), take-back card (6.10), and 8a's late-join and jump prompts | no |
| **B. Banner slot** | A new slot at the **top of the reading column**, sticky under the header (and under the code strip when present), on every width and for every role. **One banner at a time.** 8a's group-ended notice and the member-side codes notices move into it | Preview banner (6.4), lost-lead notice, take-back refused notice, leader-changed notice, vice-leader notice, lock notice, QR-pasted notice | no |
| **S. Status lines** | Lines inside `CodeStrip` (< 1024 px) and `GroupPanel` (>= 1024 px), not a slot; several can show together | Lock line (leader), 8a's pause line; plus the people counter in the strip | no |

Notes:
- The banner slot sits in the reading column on large screens too (not in the
  panel), because the preview banner is about the page being read. 8a's
  leader codes notice and approval tray stay at the top of `GroupPanel` on
  large screens, as in 8a 4.3; on phones the codes notice stays directly
  under the strip, below the banner slot.
- The banner is `position: sticky` at the top of the reading column so the
  preview banner stays visible while a long page is scrolled.

### 2.2 Overlay card priority (one card)

Highest first. A higher card hides a lower one; the lower one comes back
unchanged when the higher one closes (it is hidden, not discarded).

1. **Keep-alive** (leader only)
2. **Take-back** (member only)
3. **Late-join countdown** (member, 8a 6.14). While hidden by take-back, its
   countdown keeps running; if it ends while hidden the jump happens as in
   8a, then the take-back card stays.
4. **Jump prompt** (member, 8a 6.13)

Keep-alive is leader-only and the others are member-only, so in practice the
only real competition is take-back over the late-join or jump prompt. The
member can still reach "Go to page N" from the member sheet (8a 6.18) while
take-back is showing. The ApprovalTray is leader-only and sits below the
keep-alive card on phones (in the panel on large screens, 8a 6.15).

### 2.3 Banner priority (one banner)

Highest first.

| # | Banner | Role | Kind | Ends |
|---|---|---|---|---|
| 1 | Group-ended / left / removed (8a F12, 7.8) | anyone | sticky notice | Dismiss |
| 2 | **Preview banner** (AC40) | leader | mode banner | preview ends |
| 3 | **Leadership notice**: lost-lead (AC47), take-back refused (AC48), leader-changed (AC49) | member | sticky notice (lost-lead, refused) or info notice (leader-changed) | Dismiss, or auto-hide (2.4) |
| 4 | **Vice-leader notice** (AC60) | member | info notice | Dismiss or auto-hide |
| 5 | **Lock notice** (AC44, member side) | member | info notice | Dismiss or auto-hide |
| 6 | **QR-pasted notice** (AC57) | anyone | info notice | Dismiss or auto-hide |

Rules:
1. A new banner with **higher or equal** priority than the current one
   replaces it at once. Equal priority means newer news on the same subject
   (for example two leader changes in a row): the latest wins and the older
   one is discarded.
2. A new banner with **lower** priority waits. At most one waiting banner per
   row of the table (the latest of its kind). When the current banner goes, the
   highest waiting one shows.
3. A waiting banner that is no longer true is dropped before it shows: a lock
   notice when the lock state has changed back, a vice notice when the user's
   vice state has changed back or they became leader, any member-side notice
   when the user became leader, everything except the QR-pasted notice when the
   group ended.
4. The preview banner is a mode, not news: it is never queued behind anything
   but the group-ended notice (which can't coexist with it: preview ends with
   the group).

### 2.4 Lifetime of info notices (see U8)
- **Sticky notices** (group-ended, lost-lead, take-back refused) stay until
  Dismiss or until replaced. They explain a change of the user's own role or
  membership, which they must not miss.
- **Info notices** (leader-changed, vice-leader, lock, QR-pasted) hide by
  themselves after **15 s** visible time, with **Dismiss** available
  throughout. The timer pauses while the pointer is over the banner or focus is
  inside it, and while the tab is hidden (it counts visible time only). The
  same information stays available elsewhere: the indicator, the member sheet
  (lock and vice lines), and the live announcement already made.

### 2.5 What clears what (role changes)

| Event | Closes / clears | Then shows |
|---|---|---|
| **Lead lost** (`leadershipLost`, AC47) | keep-alive card, preview (and its banner), roster and leader controls, code strip, panel, QR, approvals, any leader confirmation (remove, rotate, end), the leader sheet view | lost-lead banner (row 3); take-back card if offered (AC48) |
| **Now leading** (`nowLeading`, AC46) | take-back card, late-join and jump prompts, member sheet, waiting member-side banners (rows 3-5; a showing one too) | now-leading dialog, then the full leader view |
| **Group ended** | everything in O, B (except ended notice and a waiting QR notice), M, the sheet | 8a group-ended notice |
| **Offer withdrawn** (Gap 1, `takeBackAvailable` false, left) | take-back card | nothing new (a leader-changed banner usually arrives with it) |

Focus when a focused element disappears in any of these: as 8a F12.3, to the
**Dismiss** button of the banner that explains it (lost-lead, ended), or to the
article when there is no such banner. Never to `body`.

## 3. Flows

Taps are counted from the reading page. **(goal)** marks where the goal is met.

### F14. Leader sees who is in the group (AC38, AC39, AC61)
1. **< 1024 px**: the code strip shows the **people counter** at its inline
   end before the QR button: "5 here, 2 away" (Q10: connected now, excluding
   the leader; "away" only when there are any). **(goal: always visible)**
2. Tapping the counter (1 tap) opens the `GroupSheet` on the **People** view
   (6.3), the same list as on large screens, with its controls. See U5.
   Back returns to the leader view; Close returns to reading.
3. **>= 1024 px**: `GroupPanel` shows the **People** section with the full
   list (6.2). **(goal)** The counter is not shown there; the list heading
   carries the count.
4. The layout follows the viewport width (`--bp-lg`, 1024 px) through the
   existing `use-media-query`; resizing across 1024 px switches live between
   counter and list. Focus inside the panel list when the window shrinks moves
   to the counter in the strip; nothing is lost (an open row's state is not
   kept).
5. Roster updates (`rosterChanged`) update the counter and list in place. Rows
   keep their order (6.2), so a row never jumps under the pointer.
6. The roster is never rendered for members or the vice-leader (the client
   doesn't give it to them). The member sheet has no people section.

### F15. Preview mode (AC40, AC41)
1. Leader: **Group** → **Preview pages** (2 taps on phones; 1 on large screens,
   where the button is in the panel). The sheet closes. `usePreview().start()`.
2. The indicator changes to **Previewing**. The banner slot shows the
   **preview banner** (6.4): "Preview is on. Turn pages; the group stays on
   page 12." with **Return to group**. Announced: "Preview on. The group stays
   on page 12."
3. The leader turns pages with the usual controls (buttons, keys, swipe). Each
   turn is `preview.move` (no position update; the client sends only its
   throttled leader activity, AC41). The banner reads "The group is on page
   12. You're viewing page 15." with **Return to group** and **Bring group
   here**.
4. Exits:
   - **Bring group here** (1 tap): button shows "Moving the group…"; one
     position update to the previewed page; on success preview ends, the
     indicator returns to **Leading**, the banner goes, announce "The group
     moved to page 15." **(goal)**
   - **Return to group** (1 tap): local only; preview ends; the page turns to
     the group's page with the normal page animation; announce "Back on the
     group's page." Nothing is sent. **(goal)**
   - The leader turns pages back onto the group's page: the banner returns to
     the same-page text (step 2); preview stays on until a button is used.
   - The lead is lost: preview ends without a position update; see F20 step 3
     for where the user lands.
   - The group ends: preview ends with everything else (2.5).
5. Errors on **Bring group here** (inline in the banner, `role="alert"`, the
   preview stays on, the button is active again): see 7.11. `NOT_LEADER` ends
   preview through F20.
6. While reconnecting, the banner stays; **Bring group here** stays active and
   reports the network error if used (it's queued nowhere).
7. Preview is not resumed after a reload: the leader comes back on the group's
   page (8a F11 rule for leaders), not previewing.

### F16. Vice-leader (AC42, AC60)
1. Leader opens People (F14) → activates a member's row (the row toggle, 6.2)
   → **Make vice-leader** (3 taps on phones, 2 on large screens).
2. The button shows "Making vice-leader…"; on success the row's role reads
   **Vice-leader**, any previous vice row reads **Member** (a new choice
   replaces the old), the action area closes and focus returns to the row
   toggle. Announce "Vice-leader now: Dana." **(goal)**
3. An away member's **Make vice-leader** is shown inactive (`aria-disabled`)
   with the hint "Only someone who's here can be vice-leader." (error
   prevention). If the server still refuses (`NOT_ALLOWED`, the member went
   away meanwhile), the inline message says so (7.11).
4. On the vice row: **Remove as vice-leader** → "Removing as vice-leader…" →
   role reads **Member**; announce "There's no vice-leader now."
5. **The person made vice** (AC60) sees the vice notice in the banner slot:
   "You're the vice-leader. If the leader drops, you'll lead the group." and
   the member sheet shows "Your role: vice-leader." When cleared: "You're no
   longer the vice-leader." (not shown when the clear is because they became
   leader, 2.3 rule 3).

### F17. Remove a member (AC43)
1. People → row toggle → **Remove from group** (3 taps on phones, 2 on large
   screens). Available for connected and away members, not for the leader's
   own row.
2. The **remove confirmation** opens (6.6), naming the person, and takes focus
   (on **Cancel**, the safe choice, 8a 6.16).
3. **Remove** → "Removing…". On success the dialog closes, the row disappears,
   the new codes show at once with 8a's `codesMemberRemoved` codes notice
   (8a AC9), announce "Dana was removed from the group." Focus moves to the
   next row's toggle, else the previous row's, else the People heading.
   **(goal)**
4. **Cancel** or Esc: focus returns to the **Remove from group** button.
5. Errors stay in the dialog (`role="alert"` line, dialog stays open, the
   action is active again) except: `PARTICIPANT_NOT_FOUND` closes the dialog
   and shows the inline row-area message "Dana has already left the group."
   at the list top; `NOT_LEADER` closes everything through F20. Table 7.11.
6. The removed person gets 8a's "You were removed from the group." (8a F12
   step 4), unchanged.

### F18. Lock and unlock (AC44)
1. Leader: **Group** → **Lock group** (2 taps on phones; 1 on large screens).
   No confirmation: it's reversible and affects nobody already in.
2. "Locking…", then the button becomes **Unlock group**, and a lock line shows
   in the strip and panel: "Locked: nobody new can join." Announce "The group
   is locked." **(goal)** The codes stay visible (they work again after
   unlocking).
3. **Unlock group** → "Unlocking…" → the line goes; announce "The group is open
   to new people again."
4. **Members** see the lock notice in the banner slot on each change: "The
   leader locked the group. Nobody new can join." / "The leader unlocked the
   group. New people can join again." The member sheet shows "The group is
   locked. Nobody new can join." whenever `GroupState.locked` is true (also
   for someone who joined a locked group by approval; they get no banner for
   a state that didn't change while they were in).
5. A new leader after a handoff sees the inherited lock state as the lock line
   and an **Unlock group** button, with no extra notice.
6. Errors inline under the button (7.11).

### F19. Keep-alive (AC45, AC53)
1. `keepAlive` arrives: the **keep-alive card** (6.7) appears in the overlay,
   above the tray. "Still reading? The group pauses in 1:00 unless you keep it
   going." with **Keep going** and a shrinking bar. Not modal, no focus move.
   Announced once, **assertively** (see U13): "The group pauses in 1 minute.
   Turn a page or use Keep going to keep it going."
2. The countdown is computed from the server's `countdownMs` against a
   monotonic clock, re-evaluated every tick and on `visibilitychange` (AC53).
3. Answers:
   - **Keep going**: "Keeping the group going…", `answerKeepAlive`; on success
     the card closes, announce "The group keeps going." **(goal)**
   - Any leader activity (page turn, preview turn, a leader action) clears it
     through `keepAliveCleared`: the card closes silently (the user acted, no
     announcement). This is also the keyboard path: an arrow-key page turn
     answers it without reaching the button.
4. **Run-out** (the local countdown reaches 0 unanswered, Gap 2): the same card
   changes in place to "The group is paused" with the same **Keep going**
   action. Its second line depends on what will happen (D2):
   - `auto` mode and at least one other person here (from the roster): "Someone
     else will lead soon. Keep going to stay the leader."
   - otherwise (`frozen`, or nobody else here, or mode unknown): "The group
     waits for you. Keep going to carry on."
   Announce once, assertively: "The group is paused. Use Keep going to carry
   on." The bar is gone. **Keep going** still resumes the group (architect
   confirms `keepalive.ack` during the pause, spec Q4); success announces
   "The group keeps going."
5. **Last chance** (the user leads because of a missed keep-alive,
   `nowLeading` reason `handoff_inactivity`, #13 AC22): the countdown line
   says "The group ends in 1:00 unless you keep it going."; at run-out the
   group ends with reason `inactivity` and 8a's ended notice shows (no paused
   state). D2 confirms the client can know this.
6. The lead passes during or after the countdown: F20 (the card closes).
7. Errors inline in the card (7.11); the card stays and the countdown keeps
   running.

### F20. Lead lost while connected (AC47)
1. `leadershipLost` (any reason, including `superseded`): everything in the
   "Lead lost" row of 2.5 closes at once. The indicator changes from
   **Leading** to the member state.
2. The **lost-lead banner** (sticky) says why, per reason (7.9), and ends "You
   can keep reading with the group." Announced politely.
3. Where the user lands:
   - Not previewing: stays on the page (it is the group's page): mode
     **Following**.
   - Previewing: stays on the previewed page in mode **Not following**; the
     jump prompt appears on the next leader move (8a F7). No surprise jump.
     See U14.
4. If the offer is open (`takeBackAvailable`), the take-back card (F21)
   appears in the overlay at the same time. The banner explains; the card asks.

### F21. Take the lead back (AC48)
1. The original leader is back as a member with an offer (`takeBackAvailable`
   from `leadershipLost` or `takeBackOffered`). The **take-back card** (6.10):
   "Take the lead back? You led this group before. You can lead it again."
   **Keep following** / **Take the lead**. Not modal, no focus move; announced
   politely once.
2. **Take the lead** → "Taking the lead…" → `takeBackLeadership` → success
   gives `nowLeading` (`take_back`) → F22. **(goal)**
3. **Keep following** → the card closes; it doesn't come back for this offer
   (`dismiss`). A new offer (after a later handoff) asks again.
4. Offer no longer valid (group ended, they left, a later `leader.changed`
   cleared it, Gap 1): the card closes without a message of its own.
5. Errors (7.11): `NOT_ALLOWED` closes the card and shows the sticky banner
   "You can't take the lead back any more." `RATE_LIMITED` and network errors
   stay inline in the card.
6. The card has priority over the jump and late-join prompts (2.2).

### F22. "You're now leading" (AC46)
1. `nowLeading` (`handoff_disconnect`, `handoff_inactivity`, `take_back`):
   everything in the "Now leading" row of 2.5 closes; the **now-leading
   dialog** (6.8) opens and takes focus (on its heading).
2. It says why (per reason) and what changed: "Everyone follows your page
   now. Your codes and the people in the group are under Group."
3. If the user's page is not the group's page (they were browsing), the dialog
   adds "You're on page 15 and the group is on page 12. Your page turns won't
   move the group until you choose." and, on dismissal, the user is put in
   **preview** at their page (F15 step 3 banner). Nothing moves until they
   choose **Bring group here** or **Return to group**. See U7.
4. **Start leading** (or Esc) dismisses. Focus returns to where it was before
   the dialog if that element still exists, else to the article. The full
   leader view is there: strip or panel with codes, QR, people, pending
   approvals and leader controls. **(goal)**
5. The 8a "You're leading the group." announcement is not made on top of the
   dialog (the dialog speaks).
6. Mismatched book (the user was blocked or warned by the content check and
   becomes leader anyway): see U11.

### F23. Leader changed, seen by members (AC49)
1. `leaderChanged` to a member or the vice-leader: an info banner, worded per
   reason, never naming anyone (7.9). Announced politely, no focus move.
2. The member keeps following the group; the next position comes from the new
   leader as usual.
3. A displaced leader gets the lost-lead banner instead (F20), not this one.

### F24. QR link pasted into an open tab (AC57)
1. The `hashchange` path strips the `#t=` fragment first (unchanged #24 R3)
   and drops the ticket. Then the **QR-pasted notice** shows in the banner
   slot: "That link wasn't used. To join with it, open it in a new tab or scan
   the QR code again." Announced politely, no focus move.
2. Shown only when sync is configured (with no sync config the fragment is
   meaningless and stays silent, 8a F5). On the library page it shows as a
   `NoticeBar` at the top of the list (same text). While a mismatch block or a
   status screen is up, it isn't shown (no banner slot there).
3. Pasting again replaces the notice (equal priority) and restarts its timer.

## 4. Screens and components

| Component | New / changed / reused | Purpose |
|---|---|---|
| `ReadingScreen` | changed | New `banner` slot at the top of the reading column, sticky; renders before `notices` |
| `BannerSlot` (reader-side controller) | new | Holds one banner, the waiting queue and the rules in 2.3-2.4 |
| `NoticeBar` | reused, extended | All 8b notices; new `tone="mode"` look for the preview banner only via `PreviewBanner`; adds optional auto-hide (2.4) |
| `PreviewBanner` | new | Both positions, Return to group, Bring group here |
| `GroupButton` | changed | New indicator state `previewing` |
| `CodeStrip` | changed | People counter button; lock line |
| `PeopleCounter` | new | "5 here, 2 away" button in the strip |
| `RosterList` | new | The list, its rows and the per-row action area; used in the panel and the People view |
| `PeopleView` | new | `GroupSheet` view hosting `RosterList` on phones and tablets |
| `LeaderDetails` (`GroupPanel`, `LeaderGroupView`) | changed | Preview pages, Lock/Unlock, lock line, People section (panel) or People row (sheet) |
| `MemberGroupView` | changed | Lock line, vice line |
| `ConfirmDialog` | reused | Remove confirmation (title takes a node so the name is `PlainText`) |
| `KeepAliveCard` | new | Overlay card with countdown and run-out state |
| `TakeBackCard` | new | Overlay card |
| `NowLeadingDialog` | new | Modal on `Dialog`, `role="alertdialog"` |
| `LiveAnnouncer` | reused, extended | Adds an assertive channel used only by the keep-alive card (U13) |
| `PlainText` | reused | Every display name |

## 5. Layouts

All sketches show `en`; `he` mirrors every interface element (section 8).

### 5.1 Leader, phone and tablet (< 1024 px)
```
+------------------------------------------+
| [Title of the book…]  3 / 12  [● Leading]|  ReaderHeader
+------------------------------------------+
| Group 482 913   Door 205 118             |  CodeStrip (wraps)
| [5 here, 2 away]                  [ QR ] |  counter + QR on the last row
| 🔒 Locked: nobody new can join.          |  lock line (only when locked)
+------------------------------------------+
| ◧ The group is on page 12. You're        |  banner slot (sticky):
|   viewing page 15.                       |  preview banner
|   [Return to group]  [Bring group here]  |
+------------------------------------------+
| ⓘ The codes changed after someone was…   |  8a codes notice (when any)
+------------------------------------------+
|  Block text…                             |
|  +------------------------------------+  |
|  | Still reading?                     |  |  overlay: keep-alive card
|  | The group pauses in 0:48 unless    |  |
|  | you keep it going.   [====------]  |  |
|  |                     [Keep going]   |  |
|  +------------------------------------+  |
|  | Dana wants to join  [Deny][Let in] |  |  ApprovalTray (8a)
|  +------------------------------------+  |
+------------------------------------------+
| [ ‹ Previous ]            [ Next › ]     |
+------------------------------------------+
```
- The strip keeps 8a's rule: codes are never truncated; it wraps. The counter
  and the QR button share the last row, the counter at the inline start of
  that row, QR at the inline end. If everything fits on one row (wide tablet,
  short codes), the order is codes, counter, QR.
- The lock line and 8a's pause line are full-width lines under the codes, lock
  first.

### 5.2 Leader, large screens (>= 1024 px)
```
+---------------------------------------------------------------------------+
| [Title of the book…]                              3 / 12   [◌ Previewing] |
+-----------------------------------------------------+---------------------+
| ◧ The group is on page 12. You're viewing page 15.  | Your group          |
|          [Return to group]  [Bring group here]      | (tray, codes notice)|
+-----------------------------------------------------+ Group code 482 913  |
|                                                     | Door code  205 118  |
|   Block text, block text…                           | [Show QR code]      |
|                                                     | 🔒 Locked: nobody…  |
|                                                     | Your name: Dana     |
|                                                     | [Preview pages]     |
|                                                     | [Unlock group]      |
|                                                     | [Get new codes]     |
|                                                     | [End group]         |
|                                                     | ------------------- |
|                                                     | People (7)          |
|                                                     | 5 here, 2 away      |
|                                                     | Dana (you)          |
|                                                     |  Leader · Here      |
|                                                     | Yossi            ⌄  |
|                                                     |  Vice-leader · Here |
|                                                     | Guest 3          ⌄  |
|                                                     |  Member · Away ·    |
|                                                     |  Auto name          |
+-----------------------------------------------------+---------------------+
```
- The People section is the **last** section of the panel, after the actions.
  8a placed the slot between codes and actions; 8b moves it below because the
  list can be long, and the actions (especially **End group**) must stay at a
  predictable place. The panel scrolls on its own (8a 4.3); there is no nested
  scroll area.
- The panel's heading row "People (7)" counts every row including the leader;
  the line under it is the counter wording (Q10), so the meaning is in words.
- While previewing, **Preview pages** in the panel reads **Return to group**
  (the same action as the banner), so the panel never offers to start what's
  already on.

### 5.3 Leader sheet (`LeaderGroupView`, < 1024 px)
```
Your group                                      ✕
Group code   482 913
Door code    205 118
[Show QR code]
🔒 Locked: nobody new can join.
Your name: Dana
People        5 here, 2 away     [Show people ›]
[        Preview pages        ]   Turn pages without moving the group.
[        Unlock group         ]
[        Get new codes        ]
[        End group            ]   (danger outlined)
```
- **Show people** opens the People view (`PeopleView`) with **Back**. Its
  chevron points to the interface end (mirrored in `he`).
- Hints sit under their button as `--text-sm` muted text, linked by
  `aria-describedby`.

### 5.4 People view (sheet, < 1024 px)
```
‹ Back          People in the group             ✕
5 here, 2 away
------------------------------------------------
Dana (you)
  Leader · Here
------------------------------------------------
Yossi                                          ⌄
  Vice-leader · Here
------------------------------------------------
Guest 3                                        ^
  Member · Away · Auto name
  ⓘ Joined while the group was restoring
  [Make vice-leader]  (inactive)
  Only someone who's here can be vice-leader.
  [Remove from group]
------------------------------------------------
```
Full-height sheet on phones, dialog >= 640 px (8a 4.4). The list scrolls inside
the sheet's body.

### 5.5 Member
- Banner slot as 5.1 (leader-changed, lost-lead, vice, lock and QR notices).
- Overlay: take-back card, else 8a's late-join or jump prompt.
- `MemberGroupView` (8a 6.18) adds, in its 8b slot, in this order and only when
  true: "Your role: vice-leader." and "The group is locked. Nobody new can
  join." (lock icon). No people list.

## 6. Components: specs and states

### 6.1 PeopleCounter (strip, < 1024 px)
- A text-style button (`styles.textButton` look), min 44 px target,
  `--text-sm` / 600, a people icon before the text. The numbers are `<bdi>`
  isolates formatted with `Intl.NumberFormat(uiLang)`.
- Visible text: `peopleCounter` ("5 here, 2 away"), `peopleCounterNoAway` ("5
  here") when nobody is away, `peopleCounterEmpty` ("Nobody here yet") when
  nobody else is in the group.
- Accessible name: `peopleCounterName` ("People: 5 here, 2 away. Show
  people").
- Counts: **here** = roster entries with `connected: true` except the leader's
  own entry; **away** = entries with `connected: false`. Pending joiners are
  not counted (they're in the tray).
- Not a live region. Count changes are not announced (too chatty in a room
  that's arriving); the list and the tray carry joins.
- States: default, hover/focus-visible/active as 8a buttons; **loading** (no
  roster yet, right after create, resume or now-leading): the counter is not
  rendered (the strip shows codes only) until the first roster arrives;
  **reconnecting**: shows the last counts unchanged.

### 6.2 RosterList and its rows
Shared by the panel's People section and `PeopleView`.

- `<section aria-labelledby>` with heading `peopleTitle` ("People in the
  group", `<h3>` in the panel, the sheet view's `<h2>` in the sheet), then the
  counter line (plain text, same wording as 6.1), then a `<ul>`.
- **Order**: the leader's own row first, then everyone else in admission order
  (`joinedAt`, oldest first). Order never changes when someone goes away,
  comes back or becomes vice; only joins (append) and removals/leaves change
  it. See U10.
- **Row anatomy** (`<li>`, min height `--size-row-with-line`, hairline bottom
  border):
  - Line 1: the name. `PlainText`, `dir="auto"` in its own isolate, at most 2
    lines then ellipsis (the full name stays in the accessible name). Own row:
    `ownRow` ("{name} (you)").
  - Line 2 (`--text-sm`, `--color-text-muted`): role · state · marker, joined
    with " · ": role (`roleLeader` / `roleVice` / `roleMember`), state
    (`stateHere` / `stateAway`), and `autoNameTag` ("Auto name") for
    `generated: true`. Away rows also get a hollow dot before line 2 (shape,
    not colour alone, repeats the text).
  - Line 3, only with `admittedSinceRecovery`: info icon plus
    `recoveryMarker` ("Joined while the group was restoring"), `--text-sm`,
    `--color-warning` (AC61; list only, never the counter).
- **Generated names** (AC39): `generated: true` shows `guestName` localised
  from `guestNumber` ("Guest 3" / "אורח 3"), in `--color-text-muted`, plus the
  "Auto name" tag in line 2. A chosen name that only looks generated ("Guest
  3" typed by a member) shows verbatim in `--color-text`, with no tag; in the
  `he` interface it also stays Latin "Guest 3" while the real one reads
  "אורח 3". Text (the tag) is the distinguishing mark; colour only repeats it.
  `generated: true` without a `guestNumber` shows `guestNameUnknown`
  ("Guest" / "אורח") with the tag.
- **Row toggle** (all rows except the own row): the whole name area is a
  `<button aria-expanded aria-controls>` with accessible name `rowOptions`
  ("Options for Dana, vice-leader, here"), a chevron at the inline end
  (rotates when open; no rotation with reduced motion). One row open at a
  time; opening another closes the first.
- **Action area** (inside the `<li>`, under line 3, inline padding as the row):
  - **Make vice-leader** (secondary) for a member who is here, with hint
    `makeViceHint` ("If you drop, the vice-leader leads."). For an away member
    the button is `inactive` with the hint `makeViceAway` instead.
  - **Remove as vice-leader** (secondary) on the vice row instead.
  - **Remove from group** (danger outlined) on every row except the own row.
    Opens 6.6.
  - Inline result line (`role="alert"`) under the buttons for failures.
- **States** of the list: loading (`peopleLoading` with spinner, no rows),
  empty (own row plus `peopleEmpty` "Nobody else is here yet. Share the codes
  so people can join."), populated, reconnecting (last rows kept, a muted
  line `peopleStale` "Can't update the list while you're offline." under the
  counter line; actions stay active and report the network error if used),
  row action pending (that button shows spinner and its pending label, the
  row's other buttons `aria-disabled`), row error (inline line, buttons active
  again).
- A row whose person leaves or is removed while its action area is open
  disappears; focus, if inside, moves as F17 step 3.

### 6.3 PeopleView (sheet)
`GroupSheet` view, title `peopleTitle`, Back to `LeaderGroupView`. Focus on
open: the title (information view, 8a 6.1). Holds `RosterList`. If the user
stops leading while it's open, the sheet closes (2.5).

### 6.4 PreviewBanner (AC40, AC41)
- `role="region"`, label `previewRegion` ("Preview"). Not a live region
  itself; announcements go through `LiveAnnouncer` (section 9).
- Look: a "mode" banner, distinct from info notices: `--color-accent-subtle`
  background, `--hairline` border in `--color-accent` at the block end, a
  preview icon (an eye) in `--color-accent` at the inline start, text
  `--color-text` (contrast 15.0:1 light / 12.0:1 dark, from 8a). Padding
  `--space-3` `--space-4`; buttons 44 px.
- Text:
  - same page: `previewSamePage` ("Preview is on. Turn pages; the group stays
    on page 12.") with **Return to group** only (Bring group here would do
    nothing).
  - different page: `previewPositions` ("The group is on page 12. You're
    viewing page 15.") with **Return to group** (secondary) and **Bring group
    here** (primary), primary at the inline end.
- Page numbers: the reader's 1-based page numbering, each in its own `<bdi>`,
  `Intl.NumberFormat(uiLang)`.
- On narrow widths the buttons wrap under the text, each full width at
  < 640 px.
- States: same page, different page, bringing (Bring group here pending
  "Moving the group…", Return to group `aria-disabled`), error (inline
  `role="alert"` line under the buttons; both buttons active), gone (preview
  ended).

### 6.5 Lock control and lock lines (AC44)
- Leader button in `LeaderDetails`: **Lock group** (secondary) with hint
  `lockHint`; when locked **Unlock group** (secondary) and no hint. Pending
  "Locking…" / "Unlocking…". Not `aria-pressed`: the label says the action.
- Lock line (strip, panel, leader sheet): lock icon plus `lockedLeaderLine`,
  `--text-sm`, `--color-text` (not warning: it's the leader's choice, not a
  problem). Not a live region; the change is announced once (section 9).
- Member line (member sheet): lock icon plus `lockedMemberLine`.
- Member notice: info `NoticeBar` in the banner slot, `noticeLocked` /
  `noticeUnlocked`.

### 6.6 Remove confirmation (AC43)
`ConfirmDialog` (8a 6.16), `role="alertdialog"`, tone `danger`:
```
Remove Dana?
They can't come back to this group. All codes and
the QR code will change, so give the new ones to
anyone still joining.
                              [Cancel]  [Remove]
```
- The name in the title is `PlainText`, `dir="auto"`, isolated, at most 32
  characters (it can't be longer). A generated name shows localised ("Remove
  Guest 3?"). The title is the dialog's accessible name, so the name is read
  out.
- Focus starts on **Cancel**; Esc cancels; focus returns to **Remove from
  group** (F17).
- States: default, removing ("Removing…", Cancel `aria-disabled`), error
  (`role="alert"` line above the buttons, buttons active again).

### 6.7 KeepAliveCard (AC45, AC53)
```
+--------------------------------------------+
| Still reading?                             |
| The group pauses in 0:48 unless you keep   |
| it going.                  [=====-------]  |
|                               [Keep going] |
+--------------------------------------------+
run-out:
+--------------------------------------------+
| ⚠ The group is paused                      |
| Someone else will lead soon. Keep going to |
| stay the leader.                           |
|                               [Keep going] |
+--------------------------------------------+
```
- 8a docked card look (`styles.card`), `role="region"`, label
  `keepAliveRegion`. Title `--text-md` / 600.
- Countdown text: `durationClock` (m:ss) from 60 s up, `durationSeconds`
  below; an LTR isolate; `aria-live="off"` (never announced per tick).
- Bar: as 8a's late-join bar (`countdownBar`), shrinking toward the inline
  start; none with reduced motion.
- Run-out look: warning icon and title in `--color-warning`, hairline border
  in `--color-warning`; background unchanged.
- **Keep going** is primary, at the inline end. Pending "Keeping the group
  going…".
- States: counting, counting-last-chance (F19 step 5 copy), answering,
  paused (run-out), error (inline `role="alert"` line, button active, countdown
  continues), gone.

### 6.8 NowLeadingDialog (AC46)
```
You're leading the group now
The leader lost connection, so the lead passed to you.
Everyone follows your page now. Your codes and the
people in the group are under Group.
[You're on page 15 and the group is on page 12. Your
 page turns won't move the group until you choose.]   (only if different)
                                    [Start leading]
```
- `Dialog`, `role="alertdialog"`, `aria-labelledby` the title,
  `aria-describedby` the body. Focus on open: the heading (`tabindex="-1"`),
  so the whole message is read before the button. Tab reaches **Start
  leading**. Esc = Start leading (dismissing is the only choice).
- One reason line per reason (7.8). Page numbers isolated.
- Width `--measure-sheet`, centred; on phones the same bottom-sheet look as
  `GroupSheet` (8a 4.4).
- Only one at a time; a second `nowLeading` while it's open replaces the
  reason text in place.

### 6.9 Info and sticky notices (lost-lead, refused, leader-changed, vice, lock, QR)
- `NoticeBar` (8a 6.6) in the banner slot: info icon, text, **Dismiss**,
  `role="status"`. Lost-lead and take-back refused use `tone="warning"`
  (warning icon), the rest `tone="info"`.
- Auto-hide per 2.4 for info notices; no visual timer.
- Dismiss: focus to the article (8a rule).

### 6.10 TakeBackCard (AC48)
```
+--------------------------------------------+
| Take the lead back?                        |
| You led this group before. You can lead it |
| again.                                     |
| [Keep following]          [Take the lead]  |
+--------------------------------------------+
```
- Docked card, `role="region"`, label `takeBackRegion`. **Take the lead**
  primary at the inline end, **Keep following** secondary.
- States: offered, taking ("Taking the lead…", Keep following
  `aria-disabled`), error (inline `role="alert"`, buttons active), gone.

### 6.11 GroupButton: new `previewing` state
| State | Dot / icon | en | he | Announcement on change |
|---|---|---|---|---|
| `previewing` (leader, preview active) | hollow dot `--color-accent` | Previewing | תצוגה מקדימה | `announcePreviewOn` (F15) |

Leaving preview returns to `leading` with no extra "You're leading"
announcement (the preview exit announcement covers it).

## 7. Microcopy (en and he)

Style as 8a section 7: short, says what to do next, no "room", "token",
"ticket", "roster", "participant". Hebrew uses impersonal or plural forms
except "המוביל" (U4). **Vice-leader in Hebrew: "סגן המוביל"** (Q9; built on
U4's "המוביל"; see U12). Placeholders: `{n}`, `{name}`, `{time}`, `{here}`,
`{away}`, `{group}`, `{view}`, `{counter}`. `{name}` is always a `PlainText`
isolate, `{time}` an LTR isolate, numbers isolates (section 8). Keys are
suggestions for `src/i18n/en.ts` and `he.ts`. All are new unless marked
"reused".

### 7.1 Indicator and preview
| Key | en | he |
|---|---|---|
| `indPreviewing` | Previewing | תצוגה מקדימה |
| `previewStart` | Preview pages | תצוגה מקדימה של עמודים |
| `previewStartHint` | Turn pages without moving the group. | אפשר לדפדף בלי להזיז את הקבוצה. |
| `previewRegion` | Preview | תצוגה מקדימה |
| `previewSamePage` | Preview is on. Turn pages; the group stays on page {n}. | התצוגה המקדימה פעילה. אפשר לדפדף, והקבוצה נשארת בעמוד {n}. |
| `previewPositions` | The group is on page {group}. You're viewing page {view}. | הקבוצה בעמוד {group}. מוצג לך עמוד {view}. |
| `bringGroupHere` | Bring group here | להעביר את הקבוצה לכאן |
| `bringingGroup` | Moving the group… | מעבירים את הקבוצה… |
| `returnToGroup` | Return to group | חזרה לעמוד הקבוצה |
| `announcePreviewOn` | Preview on. The group stays on page {n}. | התצוגה המקדימה פעילה. הקבוצה נשארת בעמוד {n}. |
| `announcePreviewOff` | Back on the group's page. | חזרה לעמוד הקבוצה. |
| `announceGroupMoved` | The group moved to page {n}. | הקבוצה עברה לעמוד {n}. |

### 7.2 People
| Key | en | he |
|---|---|---|
| `peopleCounter` | {here} here, {away} away | {here} כאן, {away} לא כאן |
| `peopleCounterNoAway` | {here} here | {here} כאן |
| `peopleCounterEmpty` | Nobody here yet | עדיין אין כאן אף אחד |
| `peopleCounterName` | People: {counter}. Show people | משתתפים: {counter}. הצגת המשתתפים |
| `showPeople` | Show people | הצגת המשתתפים |
| `peopleLabel` | People | משתתפים |
| `peopleTitle` | People in the group | המשתתפים בקבוצה |
| `peopleHeadingCount` | People ({n}) | משתתפים ({n}) |
| `peopleLoading` | Loading the people in the group… | טוענים את רשימת המשתתפים… |
| `peopleEmpty` | Nobody else is here yet. Share the codes so people can join. | עדיין אין כאן משתתפים נוספים. אפשר לשתף את הקודים כדי שיצטרפו. |
| `peopleStale` | Can't update the list while you're offline. | אי אפשר לעדכן את הרשימה בזמן שאין חיבור. |
| `ownRow` | {name} (you) | {name} (אני) |
| `roleLeader` | Leader | המוביל |
| `roleVice` | Vice-leader | סגן המוביל |
| `roleMember` | Member | משתתף |
| `stateHere` | Here | כאן |
| `stateAway` | Away | לא כאן |
| `autoNameTag` | Auto name | שם אוטומטי |
| `guestName` (reused) | Guest {n} | אורח {n} |
| `guestNameUnknown` | Guest | אורח |
| `recoveryMarker` | Joined while the group was restoring | הצטרפות בזמן שחזור הקבוצה |
| `rowOptions` | Options for {name}, {details} | אפשרויות עבור {name}, {details} |
| `makeVice` | Make vice-leader | מינוי לסגן המוביל |
| `makeViceHint` | If you drop, the vice-leader leads. | אם החיבור שלך יתנתק, סגן המוביל יוביל. |
| `makeViceAway` | Only someone who's here can be vice-leader. | רק מי שנמצא כאן יכול להיות סגן המוביל. |
| `settingVice` | Making vice-leader… | ממנים… |
| `clearVice` | Remove as vice-leader | ביטול המינוי לסגן המוביל |
| `clearingVice` | Removing as vice-leader… | מבטלים את המינוי… |
| `removeMember` | Remove from group | הסרה מהקבוצה |
| `announceVice` | Vice-leader now: {name}. | סגן המוביל עכשיו: {name}. |
| `announceViceCleared` | There's no vice-leader now. | אין עכשיו סגן מוביל. |
| `announceRemoved` | {name} was removed from the group. | {name}: ההסרה מהקבוצה הושלמה. |

`{details}` in `rowOptions` is line 2 of the row as text ("vice-leader,
here, auto name"), lowercased in `en`.

### 7.3 Remove confirmation
| Key | en | he |
|---|---|---|
| `removeTitle` | Remove {name}? | להסיר את {name}? |
| `removeBody` | They can't come back to this group. All codes and the QR code will change, so give the new ones to anyone still joining. | לא תהיה אפשרות לחזור לקבוצה הזו. כל הקודים וקוד ה-QR ישתנו, ולכן צריך למסור את החדשים למי שעוד מצטרף. |
| `removeConfirm` | Remove | הסרה |
| `removing` | Removing… | מסירים… |

### 7.4 Lock
| Key | en | he |
|---|---|---|
| `lockGroup` | Lock group | נעילת הקבוצה |
| `lockHint` | Nobody new can join until you unlock it. People in the group stay in. | אף אחד חדש לא יוכל להצטרף עד שהקבוצה תיפתח. מי שכבר בקבוצה נשאר בה. |
| `unlockGroup` | Unlock group | פתיחת הקבוצה |
| `locking` | Locking… | נועלים… |
| `unlocking` | Unlocking… | פותחים… |
| `lockedLeaderLine` | Locked: nobody new can join. | הקבוצה נעולה: אף אחד חדש לא יכול להצטרף. |
| `lockedMemberLine` | The group is locked. Nobody new can join. | הקבוצה נעולה. אף אחד חדש לא יכול להצטרף. |
| `noticeLocked` | The leader locked the group. Nobody new can join. | המוביל נעל את הקבוצה. אף אחד חדש לא יכול להצטרף. |
| `noticeUnlocked` | The leader unlocked the group. New people can join again. | המוביל פתח את הקבוצה. אפשר שוב להצטרף אליה. |
| `announceLocked` | The group is locked. | הקבוצה נעולה. |
| `announceUnlocked` | The group is open to new people again. | הקבוצה פתוחה שוב למצטרפים חדשים. |

### 7.5 Keep-alive
| Key | en | he |
|---|---|---|
| `keepAliveRegion` | Keep the group going | המשך הקבוצה |
| `keepAliveTitle` | Still reading? | עדיין קוראים? |
| `keepAliveBody` | The group pauses in {time} unless you keep it going. | הקבוצה תיעצר בעוד {time} אם לא ממשיכים. |
| `keepAliveBodyLast` | The group ends in {time} unless you keep it going. | הקבוצה תסתיים בעוד {time} אם לא ממשיכים. |
| `keepGoing` | Keep going | להמשיך |
| `keepingGoing` | Keeping the group going… | ממשיכים… |
| `keepAlivePausedTitle` | The group is paused | הקבוצה עצרה |
| `keepAlivePausedHandoff` | Someone else will lead soon. Keep going to stay the leader. | בקרוב מישהו אחר יוביל. כדי להמשיך להוביל, יש לבחור "להמשיך". |
| `keepAlivePausedWait` | The group waits for you. Keep going to carry on. | הקבוצה מחכה לך. כדי להמשיך, יש לבחור "להמשיך". |
| `announceKeepAlive` | The group pauses in {time}. Turn a page or use Keep going to keep it going. | הקבוצה תיעצר בעוד {time}. כדי להמשיך אפשר לדפדף או לבחור "להמשיך". |
| `announceKeepAliveLast` | The group ends in {time}. Turn a page or use Keep going to keep it going. | הקבוצה תסתיים בעוד {time}. כדי להמשיך אפשר לדפדף או לבחור "להמשיך". |
| `announcePaused` | The group is paused. Use Keep going to carry on. | הקבוצה עצרה. כדי להמשיך יש לבחור "להמשיך". |
| `announceKeptGoing` | The group keeps going. | הקבוצה ממשיכה. |

Announcements use the long time forms (`minutesLong`, `secondsLong`, 8a 7.1).

### 7.6 Now leading
| Key | en | he |
|---|---|---|
| `nowLeadingTitle` | You're leading the group now | הקבוצה בהובלתך עכשיו |
| `nowLeadingDisconnect` | The leader lost connection, so the lead passed to you. | החיבור של המוביל נותק, וההובלה עברה אליך. |
| `nowLeadingInactive` | The leader was inactive for a long time, so the lead passed to you. | המוביל לא היה פעיל זמן רב, וההובלה עברה אליך. |
| `nowLeadingTakeBack` | You took the lead back. | ההובלה חזרה אליך. |
| `nowLeadingWhat` | Everyone follows your page now. Your codes and the people in the group are under Group. | כולם עוקבים עכשיו אחרי העמוד שלך. הקודים ורשימת המשתתפים נמצאים בכפתור הקבוצה. |
| `nowLeadingOffPage` | You're on page {view} and the group is on page {group}. Your page turns won't move the group until you choose. | מוצג לך עמוד {view}, והקבוצה בעמוד {group}. הדפדוף לא יזיז את הקבוצה עד שבוחרים להעביר אותה. |
| `nowLeadingMismatch` | Your copy of the book isn't the same as the group's, so pages may not match for the others. | העותק שלך של הספר שונה מזה של הקבוצה, ולכן ייתכן שהעמודים לא יתאימו לשאר המשתתפים. |
| `startLeading` | Start leading | להתחיל להוביל |

### 7.7 Take-back
| Key | en | he |
|---|---|---|
| `takeBackRegion` | Take the lead back | החזרת ההובלה |
| `takeBackTitle` | Take the lead back? | לחזור להוביל? |
| `takeBackBody` | You led this group before. You can lead it again. | ההובלה של הקבוצה הזו הייתה שלך. אפשר לחזור להוביל אותה. |
| `takeBackYes` | Take the lead | לחזור להוביל |
| `takingBack` | Taking the lead… | מחזירים את ההובלה… |
| `takeBackNo` | Keep following | להמשיך לעקוב |
| `takeBackNotAllowed` | You can't take the lead back any more. | כבר אי אפשר לחזור להוביל. |
| `announceTakeBack` | You can take the lead back. Use Take the lead or Keep following. | אפשר לחזור להוביל. יש לבחור "לחזור להוביל" או "להמשיך לעקוב". |

### 7.8 Leader changed (members) and lost lead (former leader)
| Reason | Members (`leaderChanged`) key / en / he | Former leader (`leadershipLost`) key / en / he |
|---|---|---|
| `handoff_disconnect` | `changedDisconnect` / The leader lost connection, so someone else is leading now. / החיבור של המוביל נותק, ולכן מישהו אחר מוביל עכשיו. | `lostDisconnect` / You were away too long, so someone else is leading now. You can keep reading with the group. / לא היה חיבור זמן רב מדי, ולכן מישהו אחר מוביל עכשיו. אפשר להמשיך לקרוא עם הקבוצה. |
| `handoff_inactivity` | `changedInactive` / The leader was inactive, so someone else is leading now. / המוביל לא היה פעיל, ולכן מישהו אחר מוביל עכשיו. | `lostInactive` / You were inactive too long, so someone else is leading now. You can keep reading with the group. / לא הייתה פעילות זמן רב מדי, ולכן מישהו אחר מוביל עכשיו. אפשר להמשיך לקרוא עם הקבוצה. |
| `take_back` | `changedTakeBack` / The previous leader is leading again. / המוביל הקודם חזר להוביל. | `lostTakeBack` / The previous leader took the lead back. You can keep reading with the group. / המוביל הקודם חזר להוביל. אפשר להמשיך לקרוא עם הקבוצה. |
| `superseded` | `changedSuperseded` / The group's leader changed. / המוביל של הקבוצה התחלף. | `lostSuperseded` / Someone else is leading this group now. You can keep reading with the group. / מישהו אחר מוביל את הקבוצה עכשיו. אפשר להמשיך לקרוא עם הקבוצה. |

The banner text is also the polite announcement.

### 7.9 Vice-leader (the person) and QR-pasted
| Key | en | he |
|---|---|---|
| `noticeViceOn` | You're the vice-leader. If the leader drops, you'll lead the group. | מינו אותך לסגן המוביל. אם החיבור של המוביל יתנתק, ההובלה תעבור אליך. |
| `noticeViceOff` | You're no longer the vice-leader. | המינוי שלך לסגן המוביל בוטל. |
| `memberViceLine` | Your role: vice-leader. | התפקיד שלך: סגן המוביל. |
| `noticeQrPasted` | That link wasn't used. To join with it, open it in a new tab or scan the QR code again. | הקישור לא שימש להצטרפות. כדי להצטרף, אפשר לפתוח אותו בכרטיסייה חדשה או לסרוק שוב את קוד ה-QR. |

### 7.10 Shared error strings for leader actions (AC58)
| Key | en | he |
|---|---|---|
| `errNotLeader` | You're not leading any more, so nothing changed. | ההובלה כבר לא שלך, ולכן שום דבר לא השתנה. |
| `errViceAway` | {name} isn't here, so they can't be vice-leader. | {name} לא כאן, ולכן אי אפשר למנות לסגן המוביל. |
| `errPersonGone` | {name} has already left the group. | {name} כבר לא בקבוצה. |
| `errBlockListFull` | You can't remove anyone else from this group. Lock it instead to keep new people out. | אי אפשר להסיר עוד משתתפים מהקבוצה הזו. אפשר לנעול אותה כדי שאנשים חדשים לא יצטרפו. |
| `errRemoveCodes` | Couldn't make new codes, so nobody was removed. Try again in a minute. | לא הצלחנו ליצור קודים חדשים, ולכן אף אחד לא הוסר. כדאי לנסות שוב בעוד דקה. |
| `errNetwork` (reused) | Can't reach the group service. Check your connection, then try again. | (8a) |
| `errRateLimited` (reused) | Too many tries. Try again in {time}. | (8a) |
| `errRateLimitedNoTime` (reused) | Too many tries. Wait a moment, then try again. | (8a) |
| `errServer` (reused) | Something went wrong on the group service. Try again. | (8a) |

### 7.11 Error mapping per action (AC42, AC43, AC48, AC58)
`RATE_LIMITED` always uses the server's retry duration in `{time}` (else the
no-time variant); while it counts down, the action's button is `inactive`
and the message changes to `canTryNow` (8a) at 0. `NOT_CONNECTED`,
`CONNECTION_LOST`, `REQUEST_TIMEOUT` → `errNetwork`. Unknown codes →
`errServer`. `NOT_IN_GROUP` → no message (the group-ended flow handles it).
`NOT_LEADER` → if the lead-lost flow already removed the control, nothing more
(the lost-lead banner explains); if the control is still on screen (race),
`errNotLeader` inline.

| Action | Where the message shows | Action-specific codes |
|---|---|---|
| Make vice-leader | row action area | `NOT_ALLOWED` → `errViceAway`; `PARTICIPANT_NOT_FOUND` → `errPersonGone` (row goes when the roster updates) |
| Remove as vice-leader | row action area | `PARTICIPANT_NOT_FOUND` → `errPersonGone` |
| Remove | remove confirmation | `BLOCK_LIST_FULL` → `errBlockListFull`; `CODES_EXHAUSTED` → `errRemoveCodes`; `PARTICIPANT_NOT_FOUND` → dialog closes, `errPersonGone` above the list; `NOT_ALLOWED` (own row; prevented in UI) → `errServer` |
| Lock / unlock | under the button | none |
| Bring group here | preview banner | none |
| Keep going | keep-alive card | none |
| Take the lead | take-back card | `NOT_ALLOWED` → card closes, sticky banner `takeBackNotAllowed`; `NOT_LEADER` not applicable |

## 8. RTL and bidi (AC50, AC51)

- Every new banner, card, dialog, list and line follows the **interface**
  direction (`<html dir>`), independent of the book's direction. Logical
  properties only: icons at the inline start of banners and cards, primary
  buttons at the inline end, the row chevron at the inline end, the "Show
  people" chevron pointing to the inline end, keep-alive bar shrinking toward
  the inline start.
- Preview page turns keep item 7's document-direction rule for `PageNav`
  (RTL books turn the other way); the banner's page numbers are the reader's
  numbering, the same numbers `PageNav` shows, isolated in both interfaces.
- Isolates (in addition to 8a section 8):

| Value | Direction | Where |
|---|---|---|
| Display names | `auto`, `PlainText` | roster rows, remove title, `announceVice`, `announceRemoved`, `errViceAway`, `errPersonGone`, row accessible names |
| Counts | inherited, own isolate | counter, `People ({n})` |
| Page numbers | inherited, own isolate | preview banner, now-leading off-page line, announcements |
| Countdowns | `ltr` | keep-alive card |

- Mixed example, `he` interface: `סגן המוביל עכשיו: ⁨Dana Lee⁩.`;
  `להסיר את ⁨דנה (Dana)⁩?`; `הקבוצה בעמוד ⁨12⁩. מוצג לך עמוד ⁨15⁩.`
- Test fixtures: names `<b>x</b>`, `‮evil`, `דנה (Dana)`, a chosen `Guest 3`,
  a generated Guest 3, a 32-character Arabic name.

## 9. Accessibility and focus (AC52)

### 9.1 Focus

| Element | Takes focus on appear? | Focus on close |
|---|---|---|
| Now-leading dialog | **yes**: its heading | back to where focus was, else the article |
| Remove confirmation | **yes**: Cancel | Remove from group (cancel); next row toggle / previous / People heading (removed) |
| People view (sheet, user opened) | yes: title (8a rule) | the counter or Show people button that opened it |
| Preview banner | no | after Return / Bring: the article |
| Keep-alive card, take-back card | no | if focus was inside: the article |
| All notices in the banner slot | no | Dismiss: the article |
| Row action area | no (opened by the user on the toggle; focus stays on the toggle) | toggle |
| Leader UI removed by lead loss | n/a | lost-lead banner's Dismiss (2.5) |

- Tab order on the reading screen (8a 9 plus 8b): header, code strip
  (codes, counter, QR), lock/pause lines, **banner slot**, codes notice,
  article, overlay (card, then tray), `PageNav`; on >= 1024 px the panel
  (`<aside>` "Your group") after `PageNav`, with the People section last.
- Arrow-key page turns stay active while a non-modal card or banner shows,
  and turn preview pages while previewing. They are off while the now-leading
  dialog or remove confirmation is open (modal rule, 8a).

### 9.2 Announcements
- Polite (`LiveAnnouncer`, later replaces earlier, page announcements win as
  in 8a): preview on/off/moved, vice set/cleared, removed, lock/unlock (leader),
  every banner text, take-back offered, kept going.
- **Assertive** (new channel, U13): only `announceKeepAlive` /
  `announceKeepAliveLast` on appearance and `announcePaused` at run-out. It is
  time-critical: missing it can end or hand over the group.
- Never announced: counter changes, each countdown tick, roster connect/away
  changes.

### 9.3 Other
- Every control is a real button, 44 x 44 px minimum.
- No state by colour alone: away has text and a hollow dot; auto names have a
  tag; the recovery marker is text; preview has the indicator text and banner.
- Reduced motion: no keep-alive bar, no chevron rotation, no banner slide.
- 200 % zoom: strip, banner and cards wrap; nothing truncates except names
  (2 lines, full name in the accessible name).

## 10. Visual design

### Reused (`apps/reader/src/styles/tokens.css`, `components/group/`)
Tokens: all colour tokens including 8a's `--color-positive`, `--color-warning`,
`--color-accent-subtle`, `--color-danger-subtle`, `--shadow-raised`;
`--text-sm`/`--text-md` and weights; `--space-*`; `--radius-md`; `--hairline`;
`--size-target`, `--size-row-with-line`, `--size-dot`, `--size-panel`,
`--measure-sheet`; `--z-overlay`, `--z-modal`; durations and easing.
Components: `Button` (variants, `pending`, `inactive`), `NoticeBar`,
`ConfirmDialog`, `Dialog`, `GroupSheet`, the card and countdown-bar classes in
`group.module.css`, `PlainText`, `LiveAnnouncer`, `use-media-query`,
`countdown.ts` (`useCountdown`, `formatClock`, `formatShort`), `names.ts`
(`ownNameText` generalised for any roster entry).

### Added
**No new tokens.** New contrast pairs, all from existing tokens:

| Pair | Light | Dark |
|---|---|---|
| text / accent-subtle (preview banner) | 15.0:1 | 12.0:1 (8a) |
| accent / accent-subtle (preview icon, 3:1) | 5.3:1 | 6.9:1 (8a) |
| warning / surface (recovery marker, run-out title) | 5.5:1 | 11.8:1 (8a) |
| text-muted / surface (row line 2, generated name) | as item 7 (AA) | as item 7 |

Icons (inline SVG, `aria-hidden`, `currentColor`, 1em): eye (preview),
people (counter), lock (lock lines), warning and info (existing).

### Breakpoints
`--bp-lg` (1024 px) for counter vs list (Q2), the same breakpoint as the
panel, so "panel visible" and "list visible" are one rule. `--bp-sm` (640 px)
for full-width banner buttons.

## 11. Acceptance criteria mapping

| AC | Where it shows up |
|---|---|
| AC38 | F14; 5.1 counter in the strip; 5.2 panel People section; 5.4 People view; 6.1 counter wording (Q10); 6.2 role and state per row; live switch at `--bp-lg`; members never see it |
| AC39 | 6.2 generated names localised from `guestNumber` + "Auto name" tag; chosen look-alike verbatim; 8 fixtures |
| AC40 | F15; 6.4 PreviewBanner (both positions in words, isolated numbers); 6.11 `previewing` indicator; entry `previewStart` in sheet and panel (Q1); ends on lead loss / group end (2.5) |
| AC41 | F15 steps 3-4 (no position update while previewing; one on Bring group here; none on Return to group) |
| AC42 | F16; 6.2 row action area; inactive for away members; 7.11 messages |
| AC43 | F17; 6.6 remove confirmation (named, can't come back, codes and QR change); codes notice `codesMemberRemoved`; 7.11 |
| AC44 | F18; 6.5 lock button, leader lock line, member notice and sheet line |
| AC45 | F19; 6.7 KeepAliveCard: server duration, cleared by activity, assertive announcement, background-safe, run-out "The group is paused" with Keep going and the `auto` line |
| AC46 | F22; 6.8 NowLeadingDialog per reason, takes focus, must be dismissed; full leader view after |
| AC47 | F20; 2.5 "Lead lost" row; 7.8 lost-lead banner per reason incl. `superseded` |
| AC48 | F21; 6.10 TakeBackCard; decline not asked again; withdrawn silently (Gap 1); `takeBackNotAllowed`; rate limit inline |
| AC49 | F23; 7.8 leader-changed banner per reason, no names |
| AC50 | section 7 (every string en + he), section 8 |
| AC51 | 6.2, 6.6, 7 placeholders, 8 isolates: names through `PlainText` everywhere |
| AC52 | 9.1 focus table: only now-leading and remove confirmation take focus |
| AC53 | F19 step 2, 6.7 (duration-based, recomputed on `visibilitychange`) |
| AC54 | none visible; the announcements and banners never contain codes or positions beyond page numbers shown on screen; logging is the architect's |
| AC55 | none (CI); README section on leader views uses this copy |
| AC57 | F24; 7.9 `noticeQrPasted`, banner priority 6 |
| AC58 | 6.x pending labels per action; 7.10-7.11 error mapping per action |
| AC59 | flows F14-F23 give the e2e its visible checkpoints: now-leading dialog, leader-changed banner, take-back card, preview banner (member doesn't move) |
| AC60 | F16 step 5; 7.9 vice notices; member sheet `memberViceLine` |
| AC61 | 6.2 line 3 `recoveryMarker` in the list only |

## 12. Decisions needed (for the architect)

The design system is decided (ADR 0002); no styling ADR is needed and no
tokens are added.

- **D1. Banner slot.** A new `banner` slot in `ReadingScreen` (sticky, top
  of the reading column, all widths) and a reader-side controller for the
  priority, queue, drop and auto-hide rules (2.3, 2.4). 8a's group-ended
  notice and member-side notices move into it; the leader's codes notice
  stays where 8a put it.
- **D2. What the leader's client knows for the keep-alive copy.** (a) The
  group's handoff mode for the current leader, including after a handoff or
  take-back (`hello.ok` default vs the group's actual mode). (b) Whether this
  leader gained the lead through a missed keep-alive, so the "ends in" copy
  (F19 step 5) is right; if the client can't know it reliably, use the normal
  copy and let 8a's `inactivity` ended notice explain afterwards. (c) "At
  least one other person here" from the roster. Unknown mode falls back to
  `keepAlivePausedWait`.
- **D3. Preview start at a page** (U7): `usePreview().start()` then `move()`
  to the new leader's current page right after `nowLeading`, without a
  position update. Confirm with `LeaderPreview`.
- **D4. Assertive announcement channel** in `LiveAnnouncer` (U13), used only
  by the keep-alive card.
- **D5. `ConfirmDialog` / `Dialog` title as a node**, so the name in the
  remove title is `PlainText`, not a string.
- **D6. Generated-name helper**: generalise `ownNameText` to any roster entry
  (`generated` + `guestNumber`), no `Guest N` regex on roster entries.
- **D7. Row order** (U10) needs `joinedAt` stable across `rosterChanged`
  snapshots; confirm it doesn't shift on reconnect.
- **D8. AC57 on the library page**: the `hashchange` handler must reach the
  library's notice too, or the notice is reading-page only.
- **D9. Mismatched new leader** (U11): what the reader knows about the
  content check at the moment of `nowLeading`.

## 13. Open questions (for the user)

Recommendation first in each.

- **U5. Phone leaders reach the full list through the counter.**
  Recommendation: the counter in the strip opens a People view in the Group
  sheet with the same list and controls as the large-screen panel; otherwise
  a phone leader couldn't make a vice-leader or remove anyone (AC42, AC43 say
  "from the roster"). AC38's "counter below the breakpoint" stays true for the
  always-visible layout. Alternative: the leader tools are large-screen only.
- **U6. Where "Preview pages" lives.** Recommendation: in the leader's Group
  sheet and the panel (Q1: "in the leader's group controls"), 2 taps on
  phones. Alternative: also a small eye button in the code strip (1 tap), at
  the cost of a busier strip.
- **U7. A new leader who isn't on the group's page starts in preview.**
  Recommendation: yes. After "You're now leading", the user stays on their
  page in preview, and the banner offers Bring group here / Return to group,
  so their next page turn doesn't yank everyone to wherever they were browsing.
  Alternatives: (a) move them to the group's page on dismiss; (b) do nothing
  special (their next turn moves the group).
- **U8. Info notices hide by themselves.** Recommendation: leader-changed,
  vice-leader, lock and QR-pasted notices hide after 15 s of visible time
  (paused on hover/focus and in a background tab), with Dismiss; lost-lead and
  "can't take the lead back" stay until dismissed. Reason: members read for
  long stretches and a stale banner costs reading space; the same facts stay
  in the indicator and the member sheet. Alternative: all stay until
  dismissed, as 8a's codes notice.
- **U9. Telling generated names apart** (AC39). Recommendation: a text tag
  "Auto name" in the row's second line plus muted name colour for generated
  names; chosen names verbatim with no tag. Alternative: a symbol prefix on
  generated names (shorter, but needs a legend).
- **U10. Roster order.** Recommendation: the leader's own row first, then
  join order, never re-sorted by state, so rows don't jump under the pointer
  while the leader is about to tap. Alternative: here before away, vice first.
- **U11. A participant who can't follow the group's book becomes leader**
  (blocked by "different book" or with an unacknowledged version warning).
  Recommendation: they become leader as the server decides; the now-leading
  dialog adds "Your copy of the book isn't the same as the group's, so pages
  may not match for the others." and they lead with their own book (End group
  stays available). There's no way to hand the lead on (out of scope).
  Alternative: treat it as a server/protocol follow-up (exclude mismatched
  members from handoff), which this issue can't do without a server change.
- **U12. Hebrew for "vice-leader".** Recommendation: "סגן המוביל", built on
  U4's "המוביל"; it joins #28's native-speaker review with the other new he
  strings. Alternative: "מוביל משנה" (shorter, less common).
- **U13. Keep-alive is announced assertively.** Recommendation: yes, only the
  keep-alive appearance and run-out; it's the one 8b moment where missing it
  ends or hands over the group, and the card doesn't take focus. Alternative:
  polite, like every other 8b announcement.
- **U14. Lead lost while previewing.** Recommendation: the user stays on the
  page they were viewing, as a member who is not following, and gets the jump
  prompt on the next leader move. Alternative: jump them to the group's page
  at once.
