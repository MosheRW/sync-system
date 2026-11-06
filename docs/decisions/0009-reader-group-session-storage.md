# 0009. Where the reader keeps group tokens, the group pointer and the reading position

- Status: Proposed
- Date: 2026-11-06
- Issue: #24

## Context

#24 AC34-AC37 ask that a reload, closing and reopening the tab, or a phone
lock bring a member or leader back to the same group, role and page without
codes, and that the reading position survives a reload (Decision Q3:
position per book in `sessionStorage`).

Three things must be stored:

1. **Participant tokens** (and a leader's recovery data). `@sync-system/client`
   keeps them in its own document; the `storage` option picks
   `localStorage` (default), memory, or any custom store such as
   `sessionStorage`. Tokens are credentials: a current leader's token lets
   its holder take over the lead (client README, XSS caveat).
2. **Which group this tab is in** (the group ID and the tab's follow mode),
   so the reader knows, before connecting, that it should connect and
   resume, and which group to resume. `checkTokens()` cannot replace it: it
   needs a connection first, is rate limited (10 per minute), and with a
   shared store it lists every tab's groups.
3. **The reading position** per book (Q3, decided: `sessionStorage`).

Risks: with a store shared by all tabs, a second tab on the same book
resumes the first tab's token and the first tab gets `replaced`; tokens that
outlive the tab stay readable by any script on the origin for up to the
group's max session time.

## Options

1. **Everything in `sessionStorage` (recommended).** Tokens through the
   client's `storage` option, the group pointer and the positions under
   `reader:v1:*` keys. Covers reload, phone lock (a discarded tab keeps its
   `sessionStorage`) and "reopen closed tab" (browsers restore the tab's
   `sessionStorage`). Each tab is its own participant; two tabs never
   displace each other except a duplicated tab (which copies the storage
   and then gets the `replaced` notice, design F11.7). Tokens die with the
   tab. Con: opening the reader in a **new** tab (not a restored one) after
   closing the old one does not return to the group; the member rejoins with
   the code.
2. **Tokens in `localStorage` (client default) and a pointer in both
   stores.** A new tab on the same book also resumes. Cons: a second open tab
   on the same book silently takes the group from the first one; tokens and
   the group ID persist on the device after the tab is closed (shared
   devices, XSS window); needs a rule for which of several stored groups to
   resume.
3. **Tokens in memory only.** Smallest exposure. Con: fails AC34 (a reload
   loses the group).

## Decision

Proposed: **option 1**. The client gets `storage: <safe sessionStorage
wrapper>` (falls back to `'memory'` when `sessionStorage` throws); the
reader stores `reader:v1:group@<sync host>` (group pointer) and
`reader:v1:page:<contentId>:<fingerprint>` (position), both versioned JSON,
validated on read and discarded when invalid.

## Consequences

- "Closing and reopening the tab" in AC34 is met through the browser's tab
  restore; a brand-new tab needs the code again (documented in the README).
- No group data persists on the device after the tab is gone.
- The group ID sits in `sessionStorage` next to the token, which already
  contains it; it is never logged, put in a URL or sent anywhere else.
- Item 7's "no reading position across reload" (conventions, AC35 of #19)
  is superseded for the reading app.
