# Security review (plan): #9 fix(client): harden forgetAllGroups cut-off against clock skew

Mode: plan. Reviewed: [architecture.md](architecture.md), [spec.md](spec.md),
`packages/client/src/token-store.ts` (`removeAll()`, `#read()`, `#write()`,
`#mark()`), `packages/client/README.md` (`forgetAllGroups()` caveats),
[#7 security.md](../7/security.md) (R5, R7, R8).

**Result: PASS.** No critical or high findings. Two low advisories. Every
option of D1 (A, B, C, D) is acceptable from a security point of view under
the controls below; B is the one I recommend too.

## 1. Assets and trust boundaries
- **Asset:** group session tokens in client storage (`localStorage` /
  AsyncStorage key per server and app). Whoever holds a token can resume
  the group as that participant (a leader token also carries the recovery
  blob).
- **Goal of `forgetAllGroups()`:** "log out" on a shared device; no token
  stored before the call should be resumable afterwards.
- **Boundaries:** tab A vs other tabs of the same origin (shared storage,
  no live sync); device clock (seconds) vs server clock (`iat`). Both are
  local; no network input, route, message or schema is involved.
- **Not a boundary:** anything that can write the storage key directly
  (same-origin script, device owner) already has every token; the cut-off
  is not a defence against it.

## 2. Threats (STRIDE, short)
| | Threat | Plan answer |
|---|---|---|
| I | After a doubly failed forget, a token stored by another tab just before the call survives because the device clock is behind the server (privacy on a shared device) | Margin `M` (options B/C) covers skew up to `M`; option A leaves it (documented residual) |
| T | A second doubly failed forget after the clock stepped back lowers the cut-off, so tokens the first call should drop survive | `Math.max`, never lowered (all options). Sound |
| T | A failed read moves or clears the cut-off or the marks (#7 R5) | Cut-off set only in `removeAll()`'s doubly failed branch; `#read()` returns early on a failed read before touching `#removeAllCutoff`; no change to `#read`, `#mark`, `#storageWins`, `#write`. Sound (verified against the current code) |
| D | The margin drops a token another tab stores within `M` s after the failed call; user must rejoin | Availability only, local, needs the same rare double failure; this tab's own tokens are unaffected (in-memory entries are not filtered, a successful write clears the cut-off). Accepted trade-off, stated in the README |
| D | Option D: a stored entry with a huge `iat` lifts the cut-off far into the future | Only someone who can write storage can plant it, and they can already delete every token; effect ends at the next successful write. Not a finding |
| S, R, E | None: no auth, role, route or identity change |

## 3. Findings

### Critical / High (blocking)
None.

### Medium
None.

### Low (advisory)

**L-a. The cut-off (and the dirty marks) live only in this tab's memory.**
Location: README `forgetAllGroups()` caveat bullet (around line 565);
architecture.md "Docs impact".
Scenario: after a doubly failed forget, tab A is reloaded before any write
succeeds; the cut-off is gone and the old tokens still in storage come back
on the next load. Pre-existing (#7), not changed by this issue, and needs
broken storage. The README says "it remembers the time of the call" without
saying where.
Fix: while editing that bullet, add a few words: "in this tab's memory
only; reloading the tab before a successful write loses it". Optional; does
not block.

**L-b. Residual skew larger than the margin.**
Location: architecture.md D1.
Scenario: with a device clock more than `M` seconds behind (or with option
A, any amount), the window of surviving tokens remains. Out of scope per
spec (no skew detection).
Fix: the README must state the margin value and that a larger difference
can still keep an older token (planned in chunk 3; listed so code review
checks it).

## 4. D1 options: security view
| Option | Acceptable? | Notes / extra controls |
|---|---|---|
| A (monotonic only) | Yes | Fixes the overwrite. Skew residual stays Low (L-b); README must still state the clock caveat and that the cut-off never moves back. |
| **B (monotonic + 60 s)** | **Yes, recommended** | Best privacy/availability balance for the realistic skew of synced or slightly drifting clocks. Controls C1-C7. |
| C (monotonic + 300 s) | Yes | Same controls with 300. Larger lost-token window, little privacy gain over B (does not cover hours or time zone errors). No security objection. |
| D (floor at highest seen `iat`) | Yes, as an addition to A or B | Extra controls C8. It only raises the cut-off, so it cannot weaken anything; small gain. |

## 5. Required controls (part of the plan)
| ID | Control | Test / check |
|---|---|---|
| C1 | The cut-off is only raised, never lowered: `max(existing, new)`; it is cleared (`undefined`) only by a successful `removeItem` or a successful `setItem`, as today. | AC1 tests (clock back, clock forward) |
| C2 | #7 R5 holds: the cut-off is set only in `removeAll()`'s branch where both delete and read failed; a failed read in `#read()` / `#readStored()` / `#mark()` never sets, raises, lowers or clears it and never changes a mark. No change to `#read`, `#mark`, `#storageWins`, `#write` beyond comments. | Existing R5 / L-c tests unchanged and green; new AC3 test (clock forward, failed `load()`, then recovery keeps `iat = T_s + M + 1`) |
| C3 | The margin is a fixed, non-negative integer constant in `token-store.ts`. Not read from options, storage, server frames or env; not exported from `src/index.ts`. | Code review |
| C4 | Integer seconds kept: `Math.floor(now() / 1000) + M`; the comparison stays strictly `iat > cutoff`. | Boundary tests at `cutoff` (dropped) and `cutoff + 1` (kept) |
| C5 | This tab's own tokens are never filtered by the cut-off (only stored entries read from storage are). | AC2 "own tab" test |
| C6 | #7 R7: no new log call or log field; never log the cut-off, an `iat`, a token or a group ID. | Code review / diff |
| C7 | #7 R8: no new dependency, lockfile unchanged; `pnpm audit --audit-level=high` exits 0. README states the margin (or "none" for A), that the cut-off never moves back, and the cost (a token another tab stores within `M` s after the failed call is dropped). | Diff of `pnpm-lock.yaml`, README review |
| C8 | Only if D is chosen: the floor uses `iat` from entries this store validated (`#readEntry` / its own writes), is combined with `max`, and is computed without a new storage read. | Unit test: highest known `iat` above `now + M` becomes the cut-off |

## 6. What I will check in code mode
- `removeAll()` diff: `max` on the cut-off, margin per the user's D1, no other
  branch touched; `#read()` early return on a failed read unchanged.
- Tests for C1, C2, C4, C5 (and C8 if D) exist and assert storage contents,
  not only memory.
- No new logging (C6); no dependency or lockfile change (C7);
  `src/index.ts` unchanged (C3).
- README bullet: margin value, never-lowered, the cost, the larger-skew
  residual (L-b); L-a wording if taken. Changeset is a patch.
- Scanners: gitleaks, semgrep on changed files, `pnpm`/`npm audit`.
