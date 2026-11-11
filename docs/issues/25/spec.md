Issue: https://github.com/MosheRW/sync-system/issues/25

# feat: reading app leader views and lifecycle prompts (PRD item 8b)

Scope: 8b of PRD item 8 (split agreed at Gate 1 of #24, Q1). Depends on #24
(8a: join and follow, merged in PR #26). AC numbers AC38-AC49 are kept from
#24 for traceability; the cross-cutting AC50-AC55 of #24 apply to every
screen added here; new criteria start at AC57 (AC56 is #24's e2e timing check).

## Problem / motivation
After #24 a group can be created, joined and followed, but the leader has no
view of who is in the group and no way to use the leader tools the server and
packages already provide (#13 item 5, #15 item 6): preview mode, vice-leader,
remove, lock. The lifecycle moments the PRD requires are also invisible in the
reading app: the keep-alive prompt before the inactivity limit, "you're now
leading" after a handoff or take-back, the notice to a leader who lost the
lead, the take-back offer to a returning leader, and the leader-changed notice
to members. Without them a leader can't keep an idle group alive, a new leader
doesn't know they are leading, and a group can end or change hands without
anyone understanding why.

#24 also left one accepted silent path: a QR ticket pasted into an already open
tab is stripped and dropped without a word (#24 security R3 / L2, comment on
this issue).

Source: PRD "Product 2: the sync service" (Roles, Leader view, Timers, Group
lifecycle). Deferred here from #13 (item 5), #15 (item 6) and #24 (8a).

## Constraints
- No sync-server code change. Any that turns out to be needed is raised as an
  open question first.
- The reading app integrates only through `@sync-system/client` and
  `@sync-system/react`; adding a missing hook or a small client helper or fix
  to those packages is allowed (#24 Decision Q7), each listed in the plan.
- All text from the sync service (display names) is plain text, rendered with
  `PlainText` / React text children and bidi-isolated (`docs/conventions.md`).
- en and he with RTL (ADR 0003), CSS Modules and tokens (ADR 0002), strict CSP
  (ADR 0006), per-tab `sessionStorage` (ADR 0009), Playwright e2e (ADR 0008).
- The 8a layout reserves a "Members" slot in `GroupPanel` /
  `LeaderGroupView` / `MemberGroupView`, a banner slot under the header (one
  banner at a time) and the overlay prompt layer (keep-alive and take-back take
  precedence over the jump prompt), and `GroupButton` stays the single entry
  point for group actions (`docs/issues/24/design.md` section 11). 8b builds
  into those slots.
- Hebrew uses "המוביל" for "the leader" (#24 U4).

## What the packages already provide (checked on `main` at 87aa682)
| Need | `@sync-system/react` | `@sync-system/client` |
|---|---|---|
| Roster (leader only) | `useRoster()` | `RosterEntry` `{participantId, displayName, generated, guestNumber?, role, connected, joinedAt, admittedSinceRecovery?}`, `rosterChanged` |
| Vice-leader | `useViceLeader()` `{viceId, isVice, setVice, clearVice}` | `setViceLeader`, `clearViceLeader`, `viceChanged` |
| Lock | `useGroupLock()` `{locked, lock, unlock}` | `lockGroup`, `unlockGroup`, `lockChanged`, `GroupState.locked` (members too) |
| Remove | `useMemberRemoval()` `{blockList, remove}` | `removeMember` (errors `PARTICIPANT_NOT_FOUND`, `NOT_ALLOWED`, `BLOCK_LIST_FULL`, `CODES_EXHAUSTED`, `RATE_LIMITED`) |
| Preview | `usePreview()` `{active, groupPosition, previewPosition, start, move, end, bringGroupHere, returnToGroup}` | `LeaderPreview` (throttled `leader.activity`, at most 1 per 10 s; ends on demotion) |
| Keep-alive | `useKeepAlive()` `{prompt: {countdownMs, deadlineAt}, answer}` | `keepAlive`, `keepAliveCleared`, `answerKeepAlive` |
| Leadership | `useLeadership()` `{role, isLeader, takeBackAvailable, lastChange, dismiss, takeBack}` | `nowLeading` (`handoff_disconnect`, `handoff_inactivity`, `take_back`), `leadershipLost` (+ `superseded`), `leaderChanged`, `takeBackOffered`, `takeBackLeadership` |
| Leader lifecycle (members) | `useLeaderStatus()` | `LeaderLifecycle` online / offline / inactive with `graceEndsAt` |

Gaps found (resolved at Gate 1, see Decisions): the client never withdraws
`takeBackAvailable` when the take-back slot moves to someone else (fixed in
`packages/client`, Gap 1), and the leader gets no event when its own keep-alive
countdown runs out (no package change, Gap 2).

## User stories
- As a **leader**, I want to always see how many people are in my group, and
  on a large screen who they are, so that I know who I'm reading with.
- As a **leader**, I want to look ahead in the book without moving everyone,
  and then either bring the group there or go back, so that I can prepare
  without disturbing the group.
- As a **leader**, I want to pick a vice-leader, remove someone disruptive and
  lock the group, so that I stay in control of who is in it and who takes over.
- As a **leader who has been reading quietly for a long time**, I want a clear
  prompt before the group times out, so that one tap keeps it going.
- As a **member who suddenly becomes leader**, I want a clear moment that tells
  me I'm leading now and why, so that I know the group is following me.
- As a **leader who lost the lead**, I want to be told and, when I come back
  after a handoff, to be offered the lead back, so that I'm never confused about
  my role.
- As a **member**, I want a short notice when the leader changes or the group
  is locked, so that I understand what's happening.
- As **someone who pasted a QR link into an open tab**, I want to be told why
  nothing happened, so that I know how to join.
- As a **Hebrew-speaking user**, I want all of the above in Hebrew and
  right-to-left.

## Acceptance criteria

### Leader views
- [ ] AC38. A leader always sees who is in the group while leading: a member
  counter below the roster breakpoint, and a list of names with role (leader,
  vice-leader, member) and connected / offline state at and above it. The
  layout follows the viewport width (breakpoint chosen by the designer, Q2),
  not the device type, and switches live when the window is resized across the
  breakpoint. The counter's meaning (Q10) is stated in words, not a bare number.
  The roster is never shown to members or the vice-leader. Tested at both sizes
  and when resizing across the breakpoint.
- [ ] AC39. Generated names (`generated: true`) are shown in a localized form
  in he and en built from `guestNumber` (as 8a does for the user's own name).
  A chosen name that only looks generated (for example a member who typed
  "Guest 3") is shown verbatim and can be told apart from a real generated name
  (#13 L8; how is the designer's choice). Tested in en and he, with a
  generated name, a look-alike chosen name, and markup / RTL / mixed-direction
  names.

### Preview mode (leader)
- [ ] AC40. A leader can browse without moving the group (preview mode, through
  `usePreview`; entry by the designer, Q1). While previewing, the banner slot
  shows both positions in words, for example "Group is on page 12, you're
  viewing page 15", with "Bring group here" (moves the group to the previewed
  page with one position update) and "Return to group" (goes back to the
  group's page without moving the group). Page numbers use the reader's page
  numbering, are bidi-isolated, and are correct in RTL books and in the he
  interface. The preview ends, and its banner disappears, when the user stops
  leading or the group ends. Tested.
- [ ] AC41. While previewing, no position update is sent (members don't move
  and get no jump prompt); only the client's throttled leader activity is sent.
  Tested with a recording fake client (no `updatePosition` during preview,
  exactly one on "Bring group here", none on "Return to group").

### Leader controls
- [ ] AC42. From the roster, the leader can make one connected member the
  vice-leader and clear it; the roster shows who it is. Choosing a new
  vice-leader replaces the old one. A refused change (offline member,
  `NOT_ALLOWED`, `RATE_LIMITED`) has its own message. Tested.
- [ ] AC43. From the roster, the leader can remove a member (connected or
  offline) after a confirmation that names the person (plain text) and says
  they can't come back to this group and that all codes and the QR code will
  change. After removal the person leaves the roster and the new codes show
  (8a AC9, reason `member_removed`). `BLOCK_LIST_FULL`, `CODES_EXHAUSTED` and
  `RATE_LIMITED` each have their own message. Tested.
- [ ] AC44. The leader can lock and unlock the group from the group controls.
  While locked, the leader sees in words that nobody new can join; members see
  that the group is locked (from `GroupState.locked`). Unlocking clears both.
  Tested for leader and member.

### Lifecycle prompts
- [ ] AC45. Before the inactivity limit ends, the leader gets an in-app
  keep-alive prompt in the overlay layer with a countdown from the server's
  duration (`countdownMs`) and one action to keep the group going
  (`answerKeepAlive`). Any leader activity (a page move, a preview move, a
  leader action) also clears it (`keepAliveCleared`). It is announced to screen
  readers and stays correct after the tab was in the background. If the
  countdown reaches zero unanswered, the prompt changes to "The group is
  paused" with the same "Keep going" action (it still resumes the group) and,
  in `auto` mode, says the lead will pass to someone else soon. This run-out
  state is driven on the client by the countdown reaching zero from the
  server's `countdownMs`; the server sends the leader no pause event and none
  is needed (Gap 2). If the lead passes, AC47 applies. Tested with fake
  timers.
- [ ] AC46. A participant who becomes leader by handoff (`handoff_disconnect`,
  `handoff_inactivity`) or take-back (`take_back`) gets a clear, focused
  "you're now leading" moment that says why, which they must dismiss. After it
  they have the full leader view: codes, QR, roster, pending approvals and the
  leader controls. Tested per reason.
- [ ] AC47. A leader who loses the lead while connected (any `leadershipLost`
  reason, including `superseded`) is told in words that they're no longer
  leading; their leader controls, codes, QR, roster, approvals, keep-alive
  prompt and preview disappear, and they continue as a member. Tested per
  reason.
- [ ] AC48. An original leader who is back in the group after a handoff gets a
  prompt asking whether to take the lead back. Accepting calls
  `takeBackLeadership` and leads to AC46 (`take_back`); declining keeps them a
  member and does not ask again for the same offer. The prompt goes away when
  the offer is no longer valid (group ended, they left, or a later
  `leader.changed` withdraws it, Gap 1: the small `packages/client` fix clears
  `takeBackAvailable`). A `NOT_ALLOWED` reply closes the prompt with "You can't
  take the lead back any more"; `RATE_LIMITED` has its own message. Tested.
- [ ] AC49. Members (and the vice-leader) see a short, non-blocking notice in
  the banner slot when the leader changes (`leaderChanged`), worded per reason
  and without naming participants. Tested.

### Additions in 8b
- [ ] AC57. When a QR ticket link (`#t=...`) is pasted into a tab that is
  already open and is ignored (the `hashchange` path of #24 R3), the user sees
  a short notice telling them how to join (for example "Open the link again to
  join"), instead of nothing. The ticket is still stripped from the URL first
  and is never stored, logged or used (notice only, no join from `hashchange`; Q7). Tested.
- [ ] AC58. Every leader action added here (vice-leader set / clear, remove,
  lock / unlock, bring group here, keep-alive answer, take-back) shows a
  pending state while in flight, never fails silently, and maps `NOT_LEADER`
  (the lead moved during the action), `NOT_CONNECTED` and `RATE_LIMITED` (with
  the retry time from the server's duration) to user-facing messages in en and
  he. Tested per action.
- [ ] AC59. An end-to-end test (ADR 0008, Playwright, against the real sync
  server and reader) covers: the leader drops for longer than the grace period
  in `auto` handoff mode; the vice-leader gets "you're now leading" and leads;
  the other member sees the leader-changed notice and follows the new leader;
  the original leader returns, gets the take-back prompt, accepts, and leads
  again. It also checks that a leader preview doesn't move a member. Scope and
  timer settings per Q8 (decisions below).
- [ ] AC60. (Q5) A participant who is made vice-leader sees a short
  notice that they'll lead if the leader drops, and a notice when that is
  cleared (`viceChanged`). Tested.
- [ ] AC61. (Q6) In the roster list, a member with
  `admittedSinceRecovery` is marked in words (for example "joined while the
  group was restoring") so the leader can review and remove them if needed.
  Tested.

### Cross-cutting (from #24, apply to every screen, prompt and banner here)
- [ ] AC50. Every new string exists in en and he; every new view, prompt and
  banner is laid out RTL in the he interface independent of the book's
  direction; page numbers and counts are bidi-isolated. Tested.
- [ ] AC51. Display names in the roster, the remove confirmation and any notice
  are rendered as plain text through `PlainText` and bidi-isolated, never as
  HTML. Tested with markup, RTL and mixed-direction names.
- [ ] AC52. Every prompt, dialog and roster control is keyboard operable, moves
  focus sensibly and is announced to screen readers. Prompts that need no
  immediate action (leader-changed, lock state, AC57) don't steal focus from
  reading; "you're now leading" (AC46) and the remove confirmation do take
  focus and return it when closed. Tested.
- [ ] AC53. Countdowns (keep-alive, grace) use durations from the server, not
  absolute server timestamps, and stay correct after the tab was in the
  background. Tested.
- [ ] AC54. The reader never logs codes, tickets, tokens, display names,
  participant IDs or positions, including the preview position (console or
  reader server). Tested with a recording logger over the new flows.
- [ ] AC55. Lint, typecheck, tests, build, audit and the e2e job pass in CI.
  No CSP or Permissions-Policy change is expected for 8b; any change is
  justified in the plan. The reader README describes the leader views and
  lifecycle prompts briefly.

## Out of scope
- Everything delivered in #24 (8a), except where an AC above changes it (AC57).
- Any sync-server code change (open question if one turns out to be needed).
- A roster, member count or names for members or the vice-leader (the client
  gives the roster to the leader only).
- Voluntary handing over of the lead by the leader (not in the PRD; #13 Q2.5).
- Native push notifications, accounts, chat, analytics, inviting previous
  members (PRD future work); Redis, public docs, changelog, release (item 9).
- Parked follow-ups #9, #12, #21, #27 (Hebrew header bidi) and #28
  (native-speaker Hebrew review) stay separate (see Q9 for #28).
- Visual design (breakpoint, preview entry, wording) and package API details:
  designer and architect.

## Dependencies
- #24 (8a), merged: the slots in `docs/issues/24/design.md` section 11, the
  group views, `NoticeBar`, `LiveAnnouncer`, `PlainText`, the deep-link
  `hashchange` handler (`apps/reader/src/group/deep-link.ts`) and the e2e setup
  (`apps/reader/e2e`).
- #13 (item 5) server behaviour and #15 (item 6) hooks listed above.

## Decisions (Gate 1, 2026-11-11: "Accept all")
All recommendations for Q1-Q10 were accepted as written.
- Q1. Preview entry: an explicit "Preview" control in the leader's group controls; page turns are private while on; leave via "Return to group" or "Bring group here". Final wording and placement to the designer.
- Q2. Roster breakpoint: reuse `--bp-lg` (1024 px); list at and above, counter below. Final choice to the designer.
- Q3. Stale take-back offer: see Gap 1 below.
- Q4. Keep-alive run-out: the prompt changes to "The group is paused" with the same "Keep going" action and, in `auto` mode, says the lead will pass to someone else soon; AC47 applies if the lead passes. Driven on the client, see Gap 2. The architect confirms `keepalive.ack` is accepted during the inactive pause.
- Q5. Vice-leader is told: yes, **AC60 is in scope** (short notice on being made and cleared as vice-leader).
- Q6. Recovery marker: yes, **AC61 is in scope** (text marker in the roster list view only).
- Q7. AC57: a notice only; the pasted ticket stays ignored (no join from `hashchange`, no new security review).
- Q8. E2E scope (AC59): handoff, now-leading, leader-changed, take-back and preview-doesn't-move, against the real server with a shortened grace from the e2e app config (within the server ceilings, no server change). Keep-alive is tested with fake timers only. Timer values are the architect's choice.
- Q9. Hebrew review: 8b doesn't wait for #28; QA lists the new he strings in its review comment, and at Gate 3 they join #28's scope with a comment there. The designer picks the he term for "vice-leader" in line with U4.
- Q10. Counter: people connected now, excluding the leader, plus the number offline when there are any, for example "5 here, 2 away".
- Gap 1 (stale take-back offer): the proposed fix is accepted. A small change in `packages/client`: a later `leader.changed` clears an open take-back offer, and a `NOT_ALLOWED` reply closes the prompt with "You can't take the lead back any more". No server change. The architect confirms the server semantics (that any later leader change invalidates the old offer).
- Gap 2 (no pause event for the leader's client when the keep-alive runs out): no new event and no package change. User: "if the leader's browser is inactive - it probably dont care about that already." The keep-alive prompt's run-out state (Q4: "The group is paused" plus "Keep going") is driven on the client by the countdown reaching zero from the server's duration.

## Open questions
None for the user. Left to the architect / designer:
- Confirm against the server that any later leader change invalidates the old take-back offer (Gap 1), and that `keepalive.ack` is accepted during the inactive pause (Q4).
- Preview entry, breakpoint and wording (designer); timer values for e2e (architect).
