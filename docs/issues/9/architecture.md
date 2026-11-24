# Architecture: #9 fix(client): harden forgetAllGroups cut-off against clock skew

Path: fast. Spec: [spec.md](spec.md). Follow-up to #7 (advisory L-e, PR #8).

## Repo layout
- Layout: `monorepo` (pnpm workspace, `packages/*` and `apps/*`; no
  submodules, `git submodule status` is empty).
- Touched package: `packages/client` only (`@mosherw/sync-system-client`).
  Checks: `pnpm --filter @mosherw/sync-system-client test` and `typecheck`,
  then the root `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Plus one `.changeset/*.md` file at the root (the client is published; the
  fixed group means protocol, client, react and server all get the patch).

## Where the bug is
`TokenStore.removeAll()` (`packages/client/src/token-store.ts`, the `else`
branch around line 499) runs when `forgetAllGroups()` fails to delete the key
**and** the fallback read fails. It sets

```ts
this.#removeAllCutoff = Math.floor(now() / 1000);
```

and `#read()` then drops every stored entry with `iat <= cutoff` until a
successful write or remove clears it (#7 L-c). Two weaknesses:

1. **Overwrite.** A second doubly failed call replaces the cut-off. If the
   device clock stepped back in between, the cut-off goes down and tokens the
   first call should drop survive.
2. **Skew.** The cut-off is device time, `iat` is server time. With the
   device `D` seconds behind the server, tokens issued in the last `D`
   seconds before the call (stored by another tab) survive.

## Decisions

`Decisions: 1, decided (D1 = B, user at Gate 2).` No ADR: it is one numeric constant inside
an existing, already-accepted mechanism (#7 L-c), not a stack, storage or
dependency choice; `docs-conventions` reserves ADRs for those. The choice is
recorded here and in the README.

### D1. Skew margin on the cut-off: yes or no, how large?

**Decided at Gate 2 (user): B**, monotonic cut-off plus a 60 s margin;
no option D floor.

The margin `M` is **added** to the device time: `cutoff = floor(now/1000) + M`.
It covers a device clock up to `M` seconds behind the server. Its cost: a
token another tab stores in the `M` seconds **after** the failed call (by
this device's clock) is also dropped, and removed from storage at this tab's
next successful write. The other tab keeps its in-memory copy, but after a
reload that group cannot be resumed; the user rejoins with a code. Tokens
**this** tab stores after the call are never affected: the cut-off only
filters what is read from storage, and this tab's next successful write
clears it.

Both failure modes need the same rare trigger (delete and read both failing
in this tab). Then the question is which error is worse on a shared device:
a token that should be forgotten survives a "log out" (privacy, the reason
`forgetAllGroups()` exists), or a token joined in the same minute is lost
(an inconvenience, fixed by rejoining).

| Option | What | Pros | Cons |
|---|---|---|---|
| A | Monotonic only, no margin | Smallest change; never drops a token issued after the call (with correct clocks) | Fixes weakness 1 only; any device clock behind the server keeps the tokens of that window |
| **B (recommended)** | Monotonic + **60 s** margin | Covers the common skew (unsynced or slightly drifting clocks are usually seconds, rarely more than a minute); the lost-token window is one minute right after a failed log-out, when a new join in another tab is unlikely | A join in another tab within 60 s after the failed call is dropped; one existing test changes (`NOW_S + 5` becomes past the margin) |
| C | Monotonic + 5 min margin | Covers badly set clocks (minutes off) | Five-minute window for losing another tab's new token; still does not cover hours of skew or a wrong time zone setting, so it buys little over B |
| D | Monotonic + floor at the highest `iat` this store has seen (`max(now, maxKnownIat)`) | No cost: every known `iat` was issued before the call | Those groups are already marked dirty, so it only helps unseen groups and only as far as the store's newest token reaches; extra code for a small gain. Can be combined with A or B if wanted |

**Recommendation: B, 60 seconds.** Monotonic cut-off plus a fixed,
exported constant `FORGET_CUTOFF_MARGIN_SECONDS = 60`. Not configurable: a
new option would be API surface for a corner case, and the README states the
value. Trade-off accepted: a token another tab stores within one minute after
a doubly failed forget is dropped, in exchange for a forget that also holds
on a device whose clock is up to a minute behind.

If the user picks A, chunk 2 below is dropped and the docs chunk only says
the cut-off never moves back. If C, the constant is 300 and the texts say
"five minutes".

## Approach
In `removeAll()`, `else` branch only:

```ts
const cutoff = Math.floor(now() / 1000) + FORGET_CUTOFF_MARGIN_SECONDS;
this.#removeAllCutoff = Math.max(this.#removeAllCutoff ?? cutoff, cutoff);
```

- **Monotonic:** a later doubly failed call only ever raises the cut-off. It
  is still cleared (set to `undefined`) only by a successful `removeItem` or
  a successful write, as today.
- **R5 (#7 security.md) still holds, unchanged code paths:** `#read()` on a
  failed read returns the in-memory copy and touches neither `#dirty` nor
  `#removeAllCutoff`; `#mark()` with a failed read keeps an existing mark.
  The cut-off is set only in `removeAll()`'s doubly failed branch (the
  designed L-c behaviour), never by a read. No change to `#read`, `#mark`,
  `#storageWins` or `#write`.
- Stored document format, `iat` semantics and the public API are unchanged.
- Update the class doc comment (L-c bullet) and the `#removeAllCutoff`
  comment: "the highest `iat` second of the failed calls plus the margin;
  never lowered".

Rejected: reading server time (e.g. a server timestamp on frames) to correct
skew: out of scope per spec, and the protocol deliberately sends durations,
not clock times (`docs/protocol.md`). Option D: see the table.

## Files to create / modify
- `packages/client/src/token-store.ts`: add exported
  `FORGET_CUTOFF_MARGIN_SECONDS`; monotonic + margin cut-off in `removeAll()`;
  update the two doc comments.
- `packages/client/test/token-store.test.ts`: new tests (below); the existing
  "keeps a strictly newer token ... (L-c)" test uses
  `NOW_S + FORGET_CUTOFF_MARGIN_SECONDS + 1` instead of `NOW_S + 5`.
- `packages/client/README.md`: the `forgetAllGroups()` cut-off bullet
  (around line 565): never moves back, the 60 s margin, what it costs.
- `.changeset/<slug>.md`: `'@mosherw/sync-system-client': patch`, one line.

Not exported from the package index (`src/index.ts` unchanged): the constant
is internal; tests import it from `../src/token-store.js`.

## Data model / contracts / Docker
- Data model: none (in-memory field only; stored document unchanged).
- Contracts: none (no protocol, API or message change).
- `Docker impact: none`.

## Docs impact
- `packages/client/README.md`: the clock caveat bullet under
  `forgetAllGroups()`.
- `.changeset/`: one patch changeset (user-visible behaviour change).
- `docs/conventions.md`, protocol, operator guide: none. `docs/roadmap.md`:
  not touched by this issue.

## Risks / edge cases
- Fake timers: `now()` is `Date.now()`, which `vi.useFakeTimers` /
  `vi.setSystemTime` control; `fakeToken()` takes `iat` and its other times
  from `Date.now()`, so set the clock before creating tokens, and keep `exp`
  in the future after moving the clock back (prune uses `now()` too).
- Clock moving forward between two doubly failed calls simply raises the
  cut-off: intended, same as a single later call.
- `iat` has one-second resolution; the comparison stays `iat > cutoff`
  (strictly later survives), so the boundary tests use `cutoff` and
  `cutoff + 1`.
- Device clock **ahead** of the server already drops recent tokens; the
  margin adds 60 s to that window. Documented in the README.

## Security-sensitive areas
Security-sensitive: yes
- Session tokens on the client: what survives `forgetAllGroups()` (log out
  on a shared device) when storage fails, in
  `packages/client/src/token-store.ts` `removeAll()`. Must keep #7 R5 (a
  failed read never changes marks or the cut-off) and R7 (no new log field
  carries a token or ID; no new logging planned at all) and R8 (no new
  dependency).
- No new input handling, endpoints, messages, schema, crypto or dependencies.

## Implementer model
Implementer model: opus
Reason: the plan is `Security-sensitive: yes` (token retention after log-out,
#7 R5 must hold) and has one open decision (D1), so the rules exclude
`sonnet`, even though the change itself is a few lines.

## Test plan (Vitest, `packages/client/test/token-store.test.ts`, `describe` with the L-c tests)
| AC | Test |
|---|---|
| AC1 (never lowers) | Fake clock at `T`. Tab B stores X with `iat = T_s - 30`. Tab A: remove and get fail, `removeAll()`. Clock set back to `T - 10 min`; `removeAll()` doubly fails again. Reads and writes recover; tab A `load()` is empty and its next `saveToken(C)` leaves only `C` in storage (X dropped). Fails on today's code. |
| AC1 (raises) | Same, clock moved **forward** 10 min between the calls; a token with `iat` between the first and second cut-off is dropped. |
| AC2 (margin, if B/C) | Fake clock at `T`, doubly failed `removeAll()`. Tab B then stores X with `iat = T_s + FORGET_CUTOFF_MARGIN_SECONDS` (a server clock ahead of the device) and Y with `iat = T_s + FORGET_CUTOFF_MARGIN_SECONDS + 1`. After recovery tab A drops X and keeps Y, and its next write stores Y but not X. |
| AC2 (own tab) | After the doubly failed call, tab A itself `saveToken`s a token with `iat = T_s + 1`: it is kept in memory and written (write succeeds and clears the cut-off). |
| AC3 (R5) | Existing R5 / L-c tests stay green unchanged. New: after a doubly failed `removeAll()`, move the clock forward 10 min and run `load()` with get still failing; then recover: Y with `iat = T_s + M + 1` is still kept (a failed read did not move the cut-off). |
| AC4 | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` at the root; lockfile unchanged. README drift guard (`readme.test.ts`) still green. |

## Implementation chunks
1. `fix(client): never lower the forgetAllGroups cut-off` — `Math.max`
   in `removeAll()`, comment update, AC1 tests.
2. `fix(client): add a clock skew margin to the forget cut-off` — constant
   (per D1), margin in the cut-off, AC2/AC3 tests, existing L-c test moved
   past the margin. (Dropped if D1 = A.)
3. `docs(client): document the forget cut-off margin` — README bullet and
   the patch changeset.
