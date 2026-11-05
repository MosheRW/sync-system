Issue: https://github.com/MosheRW/sync-system/issues/24

# feat: reading app sync UX: joining, prompts, connection indicator and leader views (PRD item 8)

## Problem / motivation
Items 1-7 delivered the sync server, the core client (`@sync-system/client`), the React hooks (`@sync-system/react`) and a reading app (`apps/reader`) that renders content and fingerprints it, but the reading app does not connect to a group yet. Nobody can create a group, join one, follow a leader or see a leader view. Without this item the PRD's success criteria can't be met or measured:

| Criterion | Target |
| --- | --- |
| Opening the app to following the leader | under 15 s |
| Members' screens update after the leader moves | under 1 s |
| Leader whose phone locks briefly | returns to the same group, still leading |

Items 4, 5, 6 and 7 explicitly deferred their UI here:
- #10 (item 4): code entry screens, showing the group code and door code at all times, QR rendering and camera scanning (and any QR library), the deep-link route for QR tickets, the approval UI, the "joined in under 15 s" end-to-end check.
- #13 (item 5): indicator states (AC28), names as plain text (AC38), preview helper UI (AC41), keep-alive prompt, "you're now leading", take-back prompt, roster, counter / list views, preview banner, lock / remove controls.
- #15 (item 6, Q9): hooks exist for every leader action; the screens are item 8.
- #19 (item 7, Q1/Q2, AC35): the content mismatch warn / block UI built on the pure `compare`, sending content metadata `{contentId, fingerprint, schemaVersion}` on `createGroup(metadata)` and reading it on join, and keeping the reading position across reload.

Source: PRD "Product 1: the reading app" (Follower experience, Content mismatch), "Product 2: the sync service" (Joining, Roles, Leader view, Timers, Group lifecycle), "Goals and success criteria".

## Constraints
- No sync-server code changes unless unavoidable; any that turn out necessary are raised as open questions first.
- The reading app integrates only through `@sync-system/client` and `@sync-system/react` (item 7 AC19). Adding a missing hook to `packages/react` or `packages/client` is allowed (see Q7).
- All text from the sync service (display names, leader content IDs) and from content is rendered as plain text only (`PlainText`, React text children), per `docs/conventions.md`.
- Interface in `en` and `he` with RTL (ADR 0003); styling with tokens (ADR 0002); CSP and security headers from ADR 0006 stay strict and are only widened as much as this item needs.
- Item 7's rule "one book per reading page, no in-app book switching" (item 7 AC24) still holds unless the user changes it (Q4).

## User stories
- As a **leader with no training**, I want to start a group for the book I'm reading in a few taps, choosing how people join, so that the group is running in seconds.
- As a **leader in a room**, I want the codes and a QR code on my screen at all times, so that people can join by hearing the codes or scanning.
- As a **leader using approval**, I want a clear prompt for each person asking to join, so that I decide who gets in.
- As a **joiner**, I want to enter codes or scan a QR code and land on the leader's page, so that I'm following in under 15 seconds.
- As a **joiner who made a mistake**, I want a clear message for a wrong code, an expired QR code, a refused request or a locked group, so that I know what to do next.
- As a **member**, I want to browse freely and get a prompt to jump back when the leader moves, so that I'm never pulled away mid-sentence but never lost.
- As a **member**, I want to see whether I'm following, reconnecting or waiting for an offline leader, so that I trust what's on screen.
- As a **member with different content**, I want to be warned or blocked when my book isn't the leader's, so that I don't follow a position in a different text.
- As a **leader**, I want to see who is in the group (a counter on a phone, names on a laptop), so that I know when everyone has arrived.
- As a **leader**, I want to look ahead without moving the group, and then bring the group there or go back, so that I can prepare.
- As a **leader**, I want a keep-alive prompt before the group times out, so that a quiet but real session isn't closed on me.
- As a **member who suddenly becomes leader**, I want an unmistakable "you're now leading" moment, so that I know the group now follows me.
- As an **original leader who comes back**, I want to be asked whether to take the lead back, so that I can resume without a fight.
- As a **leader**, I want to name a vice-leader, remove someone, lock the group and end it, so that I stay in control.
- As **anyone whose phone locked or who reloaded**, I want to come back to the same group, role and page without codes, so that a short interruption costs nothing.
- As a **Hebrew-speaking user**, I want every new screen and prompt in Hebrew and right-to-left, so that the app feels native.

## Acceptance criteria
Tag `[8a]` / `[8b]` marks the proposed split (Q1). If the user keeps one issue, the tags are ignored.

### Sync configuration
- [ ] AC1. `[8a]` The reader connects to a sync server configured by deployment config (server URL, API key, app version; names for the architect). The CSP `connect-src` allows exactly that server's origin in addition to today's sources. Invalid sync config is a startup / config error with a clear message, like item 7 AC30. Tested.
- [ ] AC2. `[8a]` When sync is not configured, the reader works exactly as in item 7 (no group controls, no connection attempts). Tested. (Q8)
- [ ] AC3. `[8a]` A dev / compose setup lets a developer run the reader against the local sync server with a registered reader app, documented in the reader README. (Config only; see Q9.)
- [ ] AC4. `[8a]` A server that rejects the app version shows an "update required" screen; a server whose protocol the client refuses shows its own error screen. Neither leaves a blank or half-working reading screen. Tested.

### Creating a group (leader)
- [ ] AC5. `[8a]` From a reading page, a user can create a group for the book on that page. Before creating, they choose: the join method(s) among those the app allows (A and B can't be combined, per #10 Q1.3), the handoff mode (automatic handoff or stay frozen until I return, per the PRD), and an optional display name. Defaults are preselected so creating needs no choices at all. Tested for each allowed method.
- [ ] AC6. `[8a]` `createGroup` is sent with the loaded content's metadata object `{contentId, fingerprint, schemaVersion}` from item 7 AC8, unchanged. Tested.
- [ ] AC7. `[8a]` A display name is optional, 1-32 characters after trimming under the #13 AC35 rule; an invalid name gets a clear inline message before anything is sent, and a blank name means a generated one. Tested with valid, too long, control / bidi characters and blank names.

### Showing codes and QR (leader)
- [ ] AC8. `[8a]` For a method A group, the leader's screen shows the group code and the door code at all times while leading, in any view (reading, preview, roster), on every screen size. For B the group code, for C the alphanumeric code. Tested per method.
- [ ] AC9. `[8a]` Codes update on screen when they change (door-code rotation after wrong guesses, leader rotation, recreation with new codes), and the leader is told in words that they changed. Tested for each change reason the client reports.
- [ ] AC10. `[8a]` The leader can rotate all codes (`rotateCodes`), with a confirmation that old codes and QR codes stop working. Tested.
- [ ] AC11. `[8a]` When door-code joining is paused (#10 AC29), the leader sees that joining by code is paused and until when (from a server duration). Tested.
- [ ] AC12. `[8a]` For a method D group, the leader can show a QR code that encodes a deep link to the reader with the ticket in the URL fragment (never the query string, #10 AC43). The QR is re-issued before the ticket expires while shown, and is not issued while hidden. Tested (deep link content, fragment placement, refresh, hidden state).
- [ ] AC13. `[8a]` Codes and QR are shown only to the current leader: never to members or the vice-leader (#10 Q2.3, #13 AC7), and they disappear from a leader who loses the lead. Tested.

### Joining (member)
- [ ] AC14. `[8a]` A user can join by method A: group code, then the door code when the server asks for it (`DOOR_CODE_REQUIRED`), with an optional display name. Tested.
- [ ] AC15. `[8a]` A user can join by method B: group code, then a waiting screen that shows they're waiting for the leader's approval, with the time left (server duration) and a cancel action (`cancelJoin`). Tested: approved, denied, timed out, cancelled.
- [ ] AC16. `[8a]` A user can join by method C: one 8-character code, case-insensitive, look-alike characters handled as the client normalizes them. Tested.
- [ ] AC17. `[8a]` A user can join by method D by scanning the leader's QR code with the phone's camera (system camera opening the deep link) and, if the user chooses in Q2, with an in-app scanner. Opening the deep link joins the group (`joinByQr`) and then removes the ticket from the address bar and history. Tested with a valid, expired and invalid ticket.
- [ ] AC18. `[8a]` Code input fields accept pasted codes, ignore spaces and dashes, use a numeric keypad for digit codes on phones, and are laid out left-to-right digit order in the Hebrew interface. Tested.
- [ ] AC19. `[8a]` Every typed join error the client exposes (at least `CODE_NOT_FOUND`, `DOOR_CODE_WRONG`, `JOIN_PAUSED` with retry time, `JOIN_DENIED`, `APPROVAL_TIMEOUT`, `APPROVAL_QUEUE_FULL`, `QR_INVALID`, `QR_EXPIRED`, `RATE_LIMITED`, `GROUP_LOCKED`, group full if exposed) has its own user-facing message in en and he, with a next step. No error echoes the code or ticket. Tested per error.

### Approval (leader, method B)
- [ ] AC20. `[8a]` The leader gets an in-app prompt for each pending join request showing the requester's name (plain text), with approve and deny. Several pending requests are all reachable; a withdrawn or timed-out request disappears. The prompt doesn't block reading or navigation. Tested.

### Content metadata and mismatch
- [ ] AC21. `[8a]` On join (and on resume), the reader reads the group's metadata and runs item 7's `compare` against the loaded content before following. Tested for every outcome.
- [ ] AC22. `[8a]` `different-content` and `unsupported-schema` (including malformed leader metadata) show a block screen: the member does not follow and sees why and what to do (leave the group, or open the right book where Q4 allows). Tested.
- [ ] AC23. `[8a]` `different-version` shows a warning the member must acknowledge; they can continue following or leave. Tested.
- [ ] AC24. `[8a]` Leader content IDs shown on mismatch screens are plain text and bidi-isolated. Tested with an ID containing markup-like text.

### Following
- [ ] AC25. `[8a]` A member on the group's page moves with the leader automatically. Measured: the member's page changes within 1 s of the leader's move on a local setup (PRD target). Tested (integration test against a real server, or the e2e check of AC56).
- [ ] AC26. `[8a]` A member can browse freely. While they're on a page other than the group's, a leader move shows an in-app prompt to jump to the group's page; jumping makes them follow again. The prompt always shows the latest group page, never stacks, and does not move the member by itself. Tested.
- [ ] AC27. `[8a]` The jump prompt and every member-side page reference use only the group's official position. A leader's preview page never reaches members (it is never sent; #13 AC30). Tested that a leader preview produces no member prompt.
- [ ] AC28. `[8a]` A late joiner whose page differs from the group's gets a prompt with a countdown; when it ends they jump to the group's page; they can jump now or stay. Countdown length per Q5. Tested with fake timers.
- [ ] AC29. `[8a]` The position payload the reader sends is defined and versioned in the reader (format for the architect). A received position that is malformed or out of range for the loaded content is ignored without crashing and is not followed. Tested.

### Connection indicator
- [ ] AC30. `[8a]` A connection indicator is visible on the reading screen while in a group and shows every state of the client's indicator (`following`, `leading`, `reconnecting`, `leader_offline`, `leader_grace` with the remaining grace counted down from a server duration, `awaiting_approval`). Each state has distinct text (not colour alone) in en and he and is announced to screen readers when it changes. Tested per state.
- [ ] AC31. `[8a]` A member who is browsing away from the group's page can tell they are not currently following (indicator or prompt). Tested.

### Leaving and group end
- [ ] AC32. `[8a]` A member can leave the group; the leader can end the group after a confirmation. Tested.
- [ ] AC33. `[8a]` When a group ends, everyone still attached sees a group-ended screen or notice with the reason in words: ended by the leader, max session time, inactivity, leader timed out, removed (shown to the removed member only, with no other detail). The book stays readable afterwards (solo). Tested per reason.

### Survival across reload and phone lock
- [ ] AC34. `[8a]` After a reload, closing and reopening the tab, or a phone lock, a member or leader returns to the same group with the same role without entering codes, as long as the group is live (token resume through the packages). Tested.
- [ ] AC35. `[8a]` A leader whose connection drops for less than the grace period (phone lock) comes back still leading, with no prompt and no role change; members meanwhile see "leader offline" with the grace countdown. Tested against a real server with the configured grace (lock duration per Q6).
- [ ] AC36. `[8a]` The reading position survives a reload and phone lock: a solo reader returns to their page; a member returns to the group's page, or to their own page with the jump prompt (per Q3); a leader returns to the group's page. Mechanism per Q3. Tested. (Supersedes item 7 AC35 for the reading app.)
- [ ] AC37. `[8a]` A stored group that is gone (ended, unknown) is forgotten silently or with a short notice, never retried in a loop. Tested.

### Leader views
- [ ] AC38. `[8b]` A leader always sees who is in the group: a member counter on small screens, a list of names with role and connected state on large screens. The layout follows the viewport size (breakpoint by the designer), not device type. Tested at both sizes and when resizing across the breakpoint.
- [ ] AC39. `[8b]` Generated names (`generated: true`) are shown in a localized form in he and en. Tested.

### Preview mode (leader)
- [ ] AC40. `[8b]` A leader can browse without moving the group (preview mode, via the client preview helper). While previewing, a banner shows both positions in words, for example "Group is on page 12, you're viewing page 15", with "Bring group here" (moves the group to the previewed page) and "Return to group" (goes back without moving the group). Page numbers use the reader's page numbering and are correct in RTL books and the he interface. Tested.
- [ ] AC41. `[8b]` While previewing, no position update is sent; leader activity is (throttled, by the client). Tested.

### Leader controls
- [ ] AC42. `[8b]` The leader can designate one vice-leader from the roster and clear it; the roster shows who it is. Tested.
- [ ] AC43. `[8b]` The leader can remove a member from the roster after a confirmation that says the person can't come back and codes will change. A failure (for example a full block list) has its own message. Tested.
- [ ] AC44. `[8b]` The leader can lock and unlock the group; while locked, the leader sees that nobody new can join and members see the group is locked. Tested.

### Lifecycle prompts
- [ ] AC45. `[8b]` Before the inactivity limit ends, the leader gets an in-app keep-alive prompt with a countdown (from the server's duration) and one action to keep the group going. Any leader activity also clears it. It is announced to screen readers. Tested with fake timers.
- [ ] AC46. `[8b]` A participant who becomes leader by handoff (disconnect or inactivity) or take-back gets a clear, focused "you're now leading" moment that says why, which they must dismiss; afterwards they have the full leader view, codes and pending approvals. Tested per reason.
- [ ] AC47. `[8b]` A leader who loses the lead while connected is told they're no longer leading, and their leader controls, codes and QR disappear. Tested.
- [ ] AC48. `[8b]` An original leader who returns after a handoff gets a prompt asking whether to take the lead back; accepting calls take-back, declining keeps them a member. The offer goes away if it is no longer valid. Tested.
- [ ] AC49. `[8b]` Members see a short notice when the leader changes. Tested.

### Quality, language, accessibility, security
- [ ] AC50. `[8a][8b]` Every new string exists in en and he; every new screen, prompt and banner is laid out right-to-left in the he interface, independent of the content's direction (item 7 AC12). Codes, QR deep links and numbers are bidi-isolated. Tested.
- [ ] AC51. `[8a][8b]` Display names and any text from the sync service are rendered as plain text through `PlainText` and bidi-isolated, never as HTML. Tested with markup, RTL and mixed-direction names.
- [ ] AC52. `[8a][8b]` Every prompt and dialog is keyboard operable, moves focus sensibly, and is announced to screen readers; prompts that need no immediate action don't steal focus from reading. Tested.
- [ ] AC53. `[8a][8b]` Countdowns use durations from the server, not absolute server timestamps (#13 AC42), and stay correct after the tab was in the background. Tested.
- [ ] AC54. `[8a][8b]` The reader never logs codes, tickets, tokens, display names or positions (console or reader server). Tested with a recording logger.
- [ ] AC55. `[8a][8b]` Lint, typecheck, tests, build and audit pass in CI; the CSP and Permissions-Policy change only as far as this item needs (for example `connect-src` for the sync server, and camera only if Q2 picks an in-app scanner), each change justified in the plan. The reader README documents the sync config and the join / leader flows.
- [ ] AC56. `[8a]` An end-to-end check (automated if Q10 allows) measures, on a local setup with the real sync server: opening the app from a QR deep link or code entry to following the leader in under 15 s of app time (excluding human typing), and a member update under 1 s after a leader move. The measured numbers are recorded in the PR.

## Out of scope
- Any sync-server code change (open question if one turns out to be needed).
- Loading the leader's exact content version by content ID and fingerprint (item 7 Q7, future work).
- Native push notifications (PRD: all prompts in-app).
- Inviting members of a previous group, accounts, chat, analytics (PRD future work).
- Redis, public docs, changelog, release (item 9).
- Parked follow-ups #9, #12, #21 (Trusted Types) stay separate, unless the architect finds #21 cheaper to do together with the CSP change here.
- Visual design and library choices: designer and architect decide (screens, breakpoints, QR library, scanner approach).

## Open questions
Each has a recommendation first; the user decides at Gate 1.

1. **Split item 8?** Recommended: **yes, two issues.**
   - **8a: join and follow** (AC1-AC37, AC50-AC56): sync config, create group, codes and QR display, join flows A-D, approval prompt, mismatch, following and prompts, indicator, leave / end, group-ended screens, reload and phone-lock survival, e2e timing.
   - **8b: leader views and lifecycle** (AC38-AC49, plus AC50-AC55 for its own screens): roster counter / list, preview banner, vice-leader, remove, lock, keep-alive prompt, "you're now leading", lost-lead notice, take-back prompt, leader-changed notice.
   Why: 56 ACs is about twice the size of item 7, which already needed 3 review rounds. 8a alone delivers the PRD's three success criteria and is what a user needs first; 8b builds on 8a's screens and has its own design questions (preview entry, breakpoints). The QR dependency (security review) lands in 8a, keeping 8b free of dependency risk. Alternative A: one issue (one design pass, one long PR, slower review). Alternative B: three issues, moving QR rendering and scanning to its own 8c so the dependency and CSP review stand alone; reasonable if Q2 picks an in-app scanner. If the user accepts the split, the pm moves the `[8b]` ACs to a new issue and this issue becomes 8a.
2. **QR rendering and scanning.** Recommended: **render QR codes with one small, well-maintained, dependency-free library (choice and audit by the architect, security plan review required since it is a new runtime dependency), and rely on the phone's own camera app to scan (the QR is a deep link), with no in-app scanner in v1.** This keeps `Permissions-Policy: camera=()` and needs no camera library. Alternative: an in-app scanner (`BarcodeDetector` where available plus a scanning library as fallback), which needs `camera=(self)`, a permission prompt and a second dependency. Alternative: write a QR encoder in-house (no dependency, more code to test).
3. **Reading-position persistence.** Recommended: **keep the current page per book (content ID plus fingerprint) in the browser's `sessionStorage`**, so a reload or phone lock keeps the page in that tab but nothing outlives the tab. In a group, the group's position wins for a following member and for the leader; a member who had browsed away returns to their own page with the jump prompt. Alternative: `localStorage` (survives closing the tab, but stays on shared devices); alternative: the page in the URL (shareable, but leaks into history and conflicts with the QR fragment).
4. **Joining when the open book is not the leader's book.** Recommended: **the QR deep link carries the leader's book selection (`?book=` or the allow-listed `?src=`, nothing in single-book mode) with the ticket in the fragment, so scanners land on the right book; code joins happen from a reading page and block on `different-content` (AC22).** Also offer "Join a group" on the library page and, after joining, open the leader's book when its content ID is a bundled book. This is navigation to another reading page, not in-app switching, so item 7 AC24 still holds. Alternative: join only from a reading page (simpler, but someone who opens the app at the library can't join by code without first guessing the book).
5. **Late-joiner countdown length.** Recommended: **10 seconds**, as a reader config value with that default. The jump prompt for browsing members has no timeout. Alternative: 5 s (faster, easy to miss) or a sync-server app setting (server change, not recommended).
6. **How long can a leader's phone stay locked and still count as "returning"?** (PRD open question.) Recommended: **30 seconds, equal to the default `disconnectGraceSeconds` (30 s, ceiling 120 s)**; the reader's registered app uses the default, and AC35 is tested with it. A deployment that wants longer raises the grace in its app config (up to the env ceiling). After the grace, an automatic-handoff group has handed off and the returning leader gets the take-back prompt (AC48). Alternative: 60 s (set the reader app's grace to 60; members wait longer when a leader really leaves).
7. **Missing package APIs.** Recommended: **if the architect finds a flow the hooks don't cover, adding hooks or small client helpers in `packages/react` / `packages/client` is in scope here** (not a server change), each listed in the plan. Alternative: open a separate package issue first (slower).
8. **Reader without sync config.** Recommended: **sync is optional; with no sync server configured the reader is item 7's solo reader (AC2).** Alternative: sync config required (simpler code path, but breaks existing deployments and solo use).
9. **Registering the reader with the sync server.** Recommended: **add a reader app entry to `config/apps.dev.json` and `config/apps.example.json` and wire compose so the reader reaches the sync server.** This is configuration, not server code. Note: the API key ships in the browser bundle and is therefore public by nature; it identifies the app, it is not a secret (to be confirmed by the security plan review). Alternative: leave registration to the operator (harder to run and test).
10. **End-to-end check.** Recommended: **an automated browser test against the real sync server and reader (tool chosen by the architect as a dev dependency, run in CI or as a documented script)** to measure AC56 and cover the key flows. Alternative: a scripted manual check by QA with headless Chrome, as in item 7 (no new dev dependency, not repeatable in CI).
11. **Preview mode entry.** Recommended: **leave to the designer** (for example an explicit "preview" toggle vs. any leader navigation while holding a control). Recorded so the designer answers it.
