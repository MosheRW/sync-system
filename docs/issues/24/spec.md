Issue: https://github.com/MosheRW/sync-system/issues/24

# feat: reading app sync UX: join and follow (PRD item 8a)

Scope: 8a of PRD item 8 (split agreed at Gate 1, Q1). The leader views and lifecycle prompts (AC38-AC49) moved to #25 (8b), which depends on this issue.

## Problem / motivation
Items 1-7 delivered the sync server, the core client (`@sync-system/client`), the React hooks (`@sync-system/react`) and a reading app (`apps/reader`) that renders content and fingerprints it, but the reading app does not connect to a group yet. Nobody can create a group, join one, follow a leader or see a leader view. Without this issue the PRD's success criteria can't be met or measured:

| Criterion | Target |
| --- | --- |
| Opening the app to following the leader | under 15 s |
| Members' screens update after the leader moves | under 1 s |
| Leader whose phone locks briefly | returns to the same group, still leading |

Items 4, 5, 6 and 7 explicitly deferred their UI here:
- #10 (item 4): code entry screens, showing the group code and door code at all times, QR rendering and camera scanning (and any QR library), the deep-link route for QR tickets, the approval UI, the "joined in under 15 s" end-to-end check.
- #13 (item 5): indicator states (AC28), names as plain text (AC38), preview helper UI (AC41), keep-alive prompt, "you're now leading", take-back prompt, roster, counter / list views, preview banner, lock / remove controls.
- #15 (item 6, Q9): hooks exist for every leader action; the join / follow screens are here (8a), the leader-side views are #25 (8b).
- #19 (item 7, Q1/Q2, AC35): the content mismatch warn / block UI built on the pure `compare`, sending content metadata `{contentId, fingerprint, schemaVersion}` on `createGroup(metadata)` and reading it on join, and keeping the reading position across reload.

Source: PRD "Product 1: the reading app" (Follower experience, Content mismatch), "Product 2: the sync service" (Joining, Roles, Leader view, Timers, Group lifecycle), "Goals and success criteria".

## Constraints
- No sync-server code changes unless unavoidable; any that turn out necessary are raised as open questions first.
- The reading app integrates only through `@sync-system/client` and `@sync-system/react` (item 7 AC19). Adding a missing hook to `packages/react` or `packages/client` is allowed (Decision Q7).
- All text from the sync service (display names, leader content IDs) and from content is rendered as plain text only (`PlainText`, React text children), per `docs/conventions.md`.
- Interface in `en` and `he` with RTL (ADR 0003); styling with tokens (ADR 0002); CSP and security headers from ADR 0006 stay strict and are only widened as much as this item needs.
- Item 7's rule "one book per reading page, no in-app book switching" (item 7 AC24) still holds (Decision Q4).

## User stories
- As a **leader with no training**, I want to start a group for the book I'm reading in a few taps, choosing how people join, so that the group is running in seconds.
- As a **leader in a room**, I want the codes and a QR code on my screen at all times, so that people can join by hearing the codes or scanning.
- As a **leader using approval**, I want a clear prompt for each person asking to join, so that I decide who gets in.
- As a **joiner**, I want to enter codes or scan a QR code and land on the leader's page, so that I'm following in under 15 seconds.
- As a **joiner who made a mistake**, I want a clear message for a wrong code, an expired QR code, a refused request or a locked group, so that I know what to do next.
- As a **member**, I want to browse freely and get a prompt to jump back when the leader moves, so that I'm never pulled away mid-sentence but never lost.
- As a **member**, I want to see whether I'm following, reconnecting or waiting for an offline leader, so that I trust what's on screen.
- As a **member with different content**, I want to be warned or blocked when my book isn't the leader's, so that I don't follow a position in a different text.
- As **anyone whose phone locked or who reloaded**, I want to come back to the same group, role and page without codes, so that a short interruption costs nothing.
- (Leader-side stories moved to #25, 8b.)
- As a **Hebrew-speaking user**, I want every new screen and prompt in Hebrew and right-to-left, so that the app feels native.

## Acceptance criteria
### Sync configuration
- [ ] AC1. The reader connects to a sync server configured by deployment config (server URL, API key, app version; names for the architect). The CSP `connect-src` allows exactly that server's origin in addition to today's sources. Invalid sync config is a startup / config error with a clear message, like item 7 AC30. Tested.
- [ ] AC2. When sync is not configured, the reader works exactly as in item 7 (no group controls, no connection attempts). Tested. (Decision Q8)
- [ ] AC3. A dev / compose setup lets a developer run the reader against the local sync server with a registered reader app, documented in the reader README. (Config only; Decision Q9.)
- [ ] AC4. A server that rejects the app version shows an "update required" screen; a server whose protocol the client refuses shows its own error screen. Neither leaves a blank or half-working reading screen. Tested.

### Creating a group (leader)
- [ ] AC5. From a reading page, a user can create a group for the book on that page. Before creating, they choose: the join method(s) among those the app allows (A and B can't be combined, per #10 Q1.3), the handoff mode (automatic handoff or stay frozen until I return, per the PRD), and an optional display name. Defaults are preselected so creating needs no choices at all. Tested for each allowed method.
- [ ] AC6. `createGroup` is sent with the loaded content's metadata object `{contentId, fingerprint, schemaVersion}` from item 7 AC8, unchanged. Tested.
- [ ] AC7. A display name is optional, 1-32 characters after trimming under the #13 AC35 rule; an invalid name gets a clear inline message before anything is sent, and a blank name means a generated one. Tested with valid, too long, control / bidi characters and blank names.

### Showing codes and QR (leader)
- [ ] AC8. For a method A group, the leader's screen shows the group code and the door code at all times while leading, in any view, on every screen size. For B the group code, for C the alphanumeric code. Tested per method.
- [ ] AC9. Codes update on screen when they change (door-code rotation after wrong guesses, leader rotation, recreation with new codes), and the leader is told in words that they changed. Tested for each change reason the client reports.
- [ ] AC10. The leader can rotate all codes (`rotateCodes`), with a confirmation that old codes and QR codes stop working. Tested.
- [ ] AC11. When door-code joining is paused (#10 AC29), the leader sees that joining by code is paused and until when (from a server duration). Tested.
- [ ] AC12. For a method D group, the leader can show a QR code that encodes a deep link to the reader with the ticket in the URL fragment (never the query string, #10 AC43). The QR is re-issued before the ticket expires while shown, and is not issued while hidden. Tested (deep link content, fragment placement, refresh, hidden state).
- [ ] AC13. Codes and QR are shown only to the current leader: never to members or the vice-leader (#10 Q2.3, #13 AC7), and they disappear from a leader who loses the lead. Tested.

### Joining (member)
- [ ] AC14. A user can join by method A: group code, then the door code when the server asks for it (`DOOR_CODE_REQUIRED`), with an optional display name. Tested.
- [ ] AC15. A user can join by method B: group code, then a waiting screen that shows they're waiting for the leader's approval, with the time left (server duration) and a cancel action (`cancelJoin`). Tested: approved, denied, timed out, cancelled.
- [ ] AC16. A user can join by method C: one 8-character code, case-insensitive, look-alike characters handled as the client normalizes them. Tested.
- [ ] AC17. A user can join by method D by scanning the leader's QR code with the phone's own camera app opening the deep link. There is no in-app scanner in v1 and `Permissions-Policy: camera=()` stays (Decision Q2). Opening the deep link joins the group (`joinByQr`) and then removes the ticket from the address bar and history. Tested with a valid, expired and invalid ticket.
- [ ] AC18. Code input fields accept pasted codes, ignore spaces and dashes, use a numeric keypad for digit codes on phones, and are laid out left-to-right digit order in the Hebrew interface. Tested.
- [ ] AC19. Every typed join error the client exposes (at least `CODE_NOT_FOUND`, `DOOR_CODE_WRONG`, `JOIN_PAUSED` with retry time, `JOIN_DENIED`, `APPROVAL_TIMEOUT`, `APPROVAL_QUEUE_FULL`, `QR_INVALID`, `QR_EXPIRED`, `RATE_LIMITED`, `GROUP_LOCKED`, group full if exposed) has its own user-facing message in en and he, with a next step. No error echoes the code or ticket. Tested per error.

### Approval (leader, method B)
- [ ] AC20. The leader gets an in-app prompt for each pending join request showing the requester's name (plain text), with approve and deny. Several pending requests are all reachable; a withdrawn or timed-out request disappears. The prompt doesn't block reading or navigation. Tested.

### Content metadata and mismatch
- [ ] AC21. On join (and on resume), the reader reads the group's metadata and runs item 7's `compare` against the loaded content before following. Tested for every outcome.
- [ ] AC22. `different-content` and `unsupported-schema` (including malformed leader metadata) show a block screen: the member does not follow and sees why and what to do (leave the group, or open the right book where Decision Q4 allows). Tested.
- [ ] AC23. `different-version` shows a warning the member must acknowledge; they can continue following or leave. Tested.
- [ ] AC24. Leader content IDs shown on mismatch screens are plain text and bidi-isolated. Tested with an ID containing markup-like text.

### Following
- [ ] AC25. A member on the group's page moves with the leader automatically. Measured: the member's page changes within 1 s of the leader's move on a local setup (PRD target). Tested (integration test against a real server, or the e2e check of AC56).
- [ ] AC26. A member can browse freely. While they're on a page other than the group's, a leader move shows an in-app prompt to jump to the group's page; jumping makes them follow again. The prompt always shows the latest group page, never stacks, and does not move the member by itself. Tested.
- [ ] AC27. The jump prompt and every member-side page reference use only the group's official position. A leader's preview page never reaches members (it is never sent; #13 AC30). Tested that a leader preview produces no member prompt.
- [ ] AC28. A late joiner whose page differs from the group's gets a prompt with a countdown; when it ends they jump to the group's page; they can jump now or stay. The countdown is 10 s by default, a reader config value (Decision Q5). Tested with fake timers.
- [ ] AC29. The position payload the reader sends is defined and versioned in the reader (format for the architect). A received position that is malformed or out of range for the loaded content is ignored without crashing and is not followed. Tested.

### Connection indicator
- [ ] AC30. A connection indicator is visible on the reading screen while in a group and shows every state of the client's indicator (`following`, `leading`, `reconnecting`, `leader_offline`, `leader_grace` with the remaining grace counted down from a server duration, `awaiting_approval`). Each state has distinct text (not colour alone) in en and he and is announced to screen readers when it changes. Tested per state.
- [ ] AC31. A member who is browsing away from the group's page can tell they are not currently following (indicator or prompt). Tested.

### Leaving and group end
- [ ] AC32. A member can leave the group; the leader can end the group after a confirmation. Tested.
- [ ] AC33. When a group ends, everyone still attached sees a group-ended screen or notice with the reason in words: ended by the leader, max session time, inactivity, leader timed out, removed (shown to the removed member only, with no other detail). The book stays readable afterwards (solo). Tested per reason.

### Survival across reload and phone lock
- [ ] AC34. After a reload, closing and reopening the tab, or a phone lock, a member or leader returns to the same group with the same role without entering codes, as long as the group is live (token resume through the packages). Tested.
- [ ] AC35. A leader whose connection drops for less than the grace period (phone lock) comes back still leading, with no prompt and no role change; members meanwhile see "leader offline" with the grace countdown. Tested against a real server with the configured grace (lock duration 30 s, equal to the default `disconnectGraceSeconds`, Decision Q6).
- [ ] AC36. The reading position survives a reload and phone lock: a solo reader returns to their page; a member returns to the group's page, or to their own page with the jump prompt (Decision Q3); a leader returns to the group's page. The current page is stored per book (contentId + fingerprint) in `sessionStorage`; the group's position wins for a following member and the leader. Tested. (Supersedes item 7 AC35 for the reading app.)
- [ ] AC37. A stored group that is gone (ended, unknown) is forgotten silently or with a short notice, never retried in a loop. Tested.

### Leader views and lifecycle (moved to 8b)

- [ ] AC38-AC49. Moved to #25 (8b), Q1: roster, preview mode, vice-leader / remove / lock, keep-alive, "you're now leading", lost-lead notice, take-back prompt, leader-changed notice. Numbers kept for traceability; not part of this issue.

### Quality, language, accessibility, security
- [ ] AC50. Every new string exists in en and he; every new screen, prompt and banner is laid out right-to-left in the he interface, independent of the content's direction (item 7 AC12). Codes, QR deep links and numbers are bidi-isolated. Tested.
- [ ] AC51. Display names and any text from the sync service are rendered as plain text through `PlainText` and bidi-isolated, never as HTML. Tested with markup, RTL and mixed-direction names.
- [ ] AC52. Every prompt and dialog is keyboard operable, moves focus sensibly, and is announced to screen readers; prompts that need no immediate action don't steal focus from reading. Tested.
- [ ] AC53. Countdowns use durations from the server, not absolute server timestamps (#13 AC42), and stay correct after the tab was in the background. Tested.
- [ ] AC54. The reader never logs codes, tickets, tokens, display names or positions (console or reader server). Tested with a recording logger.
- [ ] AC55. Lint, typecheck, tests, build and audit pass in CI; the CSP and Permissions-Policy change only as far as this item needs (for example `connect-src` for the sync server, and `camera=()` unchanged), each change justified in the plan. The reader README documents the sync config and the join flows.
- [ ] AC56. An end-to-end check (an automated browser test, Decision Q10) measures, on a local setup with the real sync server: opening the app from a QR deep link or code entry to following the leader in under 15 s of app time (excluding human typing), and a member update under 1 s after a leader move. The measured numbers are recorded in the PR.

## Out of scope
- Any sync-server code change (open question if one turns out to be needed).
- Leader views and lifecycle prompts, tracked in #25 (8b): roster counter / list, preview mode and banner, vice-leader, remove, lock, keep-alive prompt, "you're now leading", lost-lead notice, take-back prompt, leader-changed notice (AC38-AC49).
- Loading the leader's exact content version by content ID and fingerprint (item 7 Q7, future work).
- Native push notifications (PRD: all prompts in-app).
- Inviting members of a previous group, accounts, chat, analytics (PRD future work).
- Redis, public docs, changelog, release (item 9).
- Parked follow-ups #9, #12, #21 (Trusted Types) stay separate, unless the architect finds #21 cheaper to do together with the CSP change here.
- Visual design and library choices: designer and architect decide (screens, breakpoints, QR library, scanner approach).

## Decisions (Gate 1, 2026-11-06: "Accept all")
All recommendations were accepted as written.
- Q1. Split: yes. This issue is 8a (join and follow); AC38-AC49 moved to #25 (8b).
- Q2. QR: render with one small dependency-free library (architect chooses and audits; security plan review required); scan with the phone's own camera via the deep link; no in-app scanner; camera stays `()`.
- Q3. Reading position: per book (contentId + fingerprint) in `sessionStorage`; in a group the group's position wins for a following member and the leader; a member who browsed away returns to their own page with the jump prompt.
- Q4. Book mismatch: the QR deep link carries the leader's book selection (`?book=` or allow-listed `?src=`, nothing in single-book mode) with the ticket in the fragment; code joins block on `different-content`; "Join a group" is offered on the library page and the leader's book is opened after joining when it is a bundled book (navigation, not in-app switching).
- Q5. Late-joiner countdown: 10 s, reader config value; the jump prompt for browsing members has no timeout.
- Q6. Phone lock: 30 s, equal to the default `disconnectGraceSeconds`; longer only via the reader app's config (up to the env ceiling).
- Q7. Missing package APIs: adding hooks or small client helpers to `packages/react` / `packages/client` is in scope, each listed in the plan; no server change.
- Q8. Sync is optional; with no sync server configured the reader is item 7's solo reader (AC2).
- Q9. Add a reader app entry to `config/apps.dev.json` and `config/apps.example.json` and wire compose; the API key is public by nature (security plan review confirms).
- Q10. End-to-end check: an automated browser test against the real sync server and reader (tool chosen by the architect).
- Q11. Preview mode entry: now belongs to #25 (8b); the 8b designer answers it.

## Open questions
None for the user. Left to the architect / designer / security plan review:
- QR library choice and audit (Q2), the browser test tool (Q10), the position payload format (AC29), config variable names (AC1).
- Confirmation by the security plan review that the public API key in the bundle is acceptable (Q9).
