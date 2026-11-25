# Spec: #44 fix(reader): escape control characters in echoed config values

Issue: https://github.com/MosheRW/sync-system/issues/44 (follow-up to #36 / PR #43, security finding A1, low)

## Problem
The reader's `shown()` (`apps/reader/src/config/schema.ts`, via `truncate` in `quote.ts`) prints a truncated `READER_*` value without escaping control characters. A newline (or `\r`, U+2028) in a value can fake an extra `Config error:` line. Pre-existing; needs control of the environment to trigger.

## Fix
- Apply the same escaping as the server's `shownText` inside `shown()`: control and line-separator characters are replaced with `?`.
- Add a test for this.
- If the wording changes, update the echo rule in `docs/startup-errors.md`.

## Acceptance criteria
- [ ] A `READER_*` value containing `\n`, `\r`, U+2028 or other control characters produces exactly one `Config error:` line per problem.
- [ ] A test covers the escaping in `shown()`.
- [ ] Existing reader config tests pass.
- [ ] `docs/startup-errors.md` matches the echo rule if its wording changed.

## Out of scope
- A2 (Q24, truncated echo) stays accepted. It is not part of this issue.
