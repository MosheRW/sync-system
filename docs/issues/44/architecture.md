# Architecture: #44 escape control characters in the reader's echoed config values

Path: fast
Repo layout: monorepo (pnpm workspace: `apps/reader`, `apps/sync-server`, `packages/*`). Only `apps/reader` and `docs/` are touched. Checks: `pnpm --filter` reader `test`, `lint`, `typecheck` (as in `apps/reader/package.json`).
Decisions: none open
Docs impact: `docs/startup-errors.md` (echo rules)
Docker impact: none

## Approach
The server's `shownText` (`apps/sync-server/src/config/apps-config.ts`) first replaces every match of `/[\u0000-\u001f\u007f-\u009f  ]/g` with `?`, then truncates by code point. Match it in the reader: escape first, then truncate. The replacement is 1:1 per code unit, so the 40-character cut is unchanged for clean values.

Change only `shown()` in `apps/reader/src/config/schema.ts`: `"${truncate(escapeControls(value))}"`. `shownUrl` already goes through `shown()`, so it is covered.
Do not change `truncate` in `content/quote.ts`: it is also used by content parse errors and `PlainText`, where `?` substitution would change unrelated output (PlainText renders real text with line breaks).

Share or duplicate: duplicate. `apps/reader` and `apps/sync-server` are separate apps with no shared runtime code for this, and `packages/*` are the sync client/protocol libraries. A new shared package or dependency is not worth one regex. Add a comment in the reader pointing at the server's `shownText` so the two stay in step.

Rejected: escaping inside `truncate` (side effects above); escaping after truncation (inconsistent with the server, and a cut could not split an escape anyway, but order should match).

## Files
- Modify `apps/reader/src/config/schema.ts`: add a local `escapeControls` (same character set as the server) and use it in `shown()`.
- Modify `apps/reader/test/config.test.ts`: new tests (below).
- Modify `docs/startup-errors.md`: echo rule says the reader replaces control characters and line separators with `?` before cutting at 40 characters.

## Contracts / data model
None. No new endpoints, messages or dependencies. Error message text is unchanged for values without control characters.

## Test plan (maps to acceptance criteria)
In `apps/reader/test/config.test.ts`, using the existing `problems()` helper on a bad value (e.g. `READER_PORT`, and `READER_SYNC_URL` for the `shownUrl` path):
- `\n`, `\r`, `\r\n`, U+2028, U+2029, `\u0000`, `\u001f`, `\u007f`, `\u0085`, `\u009f` in a value: each yields exactly one problem, the problem string contains no control or line-separator character, and the characters appear as `?`.
- A value `"1\nConfig error: fake"`: still exactly one problem entry; the text `Config error:` stays inside the quoted value.
- Escape-then-truncate: a value with a control character before position 40 is cut at 40 characters plus `…`, with `?` in place.
- Clean values and existing tests unchanged (existing suite passes). Run `startup-errors-doc.node.test.ts`.
Manual verification not needed.

## Risks
Low. A legitimate value with a tab or similar now shows `?`, which is intended and matches the server.

Security-sensitive: no
Reason: output hardening of an operator-facing log line only; no auth, input handling, schema, or dependency change. It does close a low log-injection finding (A1 from #36), so the engineer should treat the character set as exact.

Implementer model: sonnet
Reason: one-function change in a single file that follows an existing pattern (`shownText` in `apps/sync-server/src/config/apps-config.ts`), no contracts, no dependencies, no open decisions.

## Implementation chunks
1. `fix(reader): escape control characters in echoed config values`
2. `test(reader): cover control-character escaping in config errors`
3. `docs(startup-errors): state the reader's control-character escaping`
