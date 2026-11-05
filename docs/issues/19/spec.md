Issue: https://github.com/MosheRW/sync-system/issues/19

# feat: reading app content, text direction (RTL) and content fingerprint (PRD item 7)

## Problem / motivation
The PRD's reading app does not exist yet (`apps/` holds only `sync-server`). Items 1-6 delivered the sync server, the core client and the React package; items 7-8 build the reading app on top of them. Item 7 is the content half: a JSON-driven renderer that handles RTL, LTR and mixed-direction text, and the identity of a content file (schema version, content ID, fingerprint) so a leader and members can confirm they read the same thing. Without it the sync service has no real customer and item 8 (sync UX) has nothing to show.

Source: PRD "Product 1: the reading app" -> Content, Text direction, Content mismatch; "Version checks" (content schema row); goal "JSON-driven reading app that supports RTL, LTR and mixed-direction content". Items 4, 5 and 6 defer to item 7: reading-app content, RTL, fingerprint, and escaping display names (#13 AC38).

## User stories
- As a **reader**, I want the app to show a sequence of pages from a JSON file, so that I can read any supported text.
- As a **Hebrew/Arabic reader**, I want RTL text, RTL page order and reversed swipes, so that the book feels natural.
- As a **reader of a mixed-language book**, I want direction set per document, page and block (or detected automatically), so that English quotes in a Hebrew book render correctly.
- As a **user of a Hebrew interface reading English content** (or the reverse), I want interface direction and content direction to be independent, so that neither breaks the other.
- As a **client app developer / content author**, I want every content file to declare a schema version and content ID, and to have a fingerprint, so that the app can refuse files it cannot render and identify exactly what is being read.
- As a **group leader**, I want the app to provide my content metadata (content ID, fingerprint, schema version), so that members can verify they have the same content.
- As a **group member**, I want to be told when my content differs from the leader's, so that I am not silently following a position in a different text.

## Acceptance criteria
Content loading and schema
- [ ] AC1. A content file is JSON with a declared schema version, a content ID, and an ordered list of pages, each holding blocks of text. The schema is written down and versioned in the repo.
- [ ] AC2. The app can load content bundled with it, and content fetched from a URL, through one loader interface that returns the same result shape for both.
- [ ] AC3. The app declares the range of schema versions it can render. A file whose version is outside the range, missing, or not a valid version is blocked with a clear, typed reason; nothing partially renders.
- [ ] AC4. Malformed content (invalid JSON, wrong types, missing pages, unknown direction values) is rejected by validation with a typed error and does not crash the app. Fetched content is treated as untrusted input: text is rendered as plain text, never as HTML or script.
- [ ] AC5. A fetch failure (network error, non-2xx, timeout) yields a typed, user-visible error state, not a blank screen.

Fingerprint
- [ ] AC6. The fingerprint is a hash of the content file computed over a defined canonical form, so the same content gives the same fingerprint regardless of whitespace or key order, and the same value on any device. The fingerprint is always computed by the app and never declared by the file. The algorithm (SHA-256 over canonical JSON, hex, via Web Crypto) and canonicalisation are documented.
- [ ] AC7. Any change to text, direction, page order or schema version changes the fingerprint; a change that is only JSON formatting does not (tests for both).
- [ ] AC8. The loaded-content result exposes `contentId`, `fingerprint` and `schemaVersion` as a metadata object ready to hand to the sync client's group metadata (what `createGroup(metadata)` already carries). The server is not changed and never reads it.
- AC9. (Removed at Gate 1, Q3.)

Text direction
- [ ] AC10. Direction can be set at document, page and block level with values `ltr`, `rtl` and (blocks only) `auto`. The effective direction of a block is block, else page, else document, else the default `ltr`.
- [ ] AC11. A block with `auto` takes its direction from its own text (first strong character); an empty or direction-neutral block falls back to its page/document direction. Tested with Hebrew, Arabic, English, mixed and neutral-only text.
- [ ] AC12. Content direction is independent of interface direction: an RTL interface with LTR content and the reverse both work, each applied only to its own area (tests for all four combinations).
- [ ] AC13. Page-turn direction follows the document direction: in an RTL document "next" moves leftward, "previous" rightward, and swipe gestures are reversed relative to LTR; keyboard and next/previous controls follow the same mapping. It is the document's direction, not the current page's or block's.
- [ ] AC14. Mixed-direction content (an RTL document with LTR blocks and the reverse) renders each block in its own direction with correct alignment and punctuation placement, verified with sample content in tests.

Content mismatch (logic and API only; screens and prompts belong to item 8)
- [ ] AC15. A pure, tested comparison function takes local content metadata and the leader's metadata (content ID, fingerprint, schema version) and returns one of: `match`, `different-content` (content ID differs), `different-version` (same ID, fingerprint differs), `unsupported-schema` (leader's schema version outside the app's range).
- [ ] AC16. `unsupported-schema` blocks reading that content (consistent with AC3).
- [ ] AC17. For `different-version` the comparison yields the outcome `warn`, or `block` when the leader's schema version is unsupported. The policy is warn/block only in v1. The loader may declare a version-lookup capability (not supported by default) for later, but nothing implements loading by content ID + fingerprint. The schema starts at version 1 and the supported range is 1 only.
- [ ] AC18. Display names and any other text coming from the sync service are rendered as plain text, escaped (closes #13 AC38 for the reading app).

Integration and quality
- [ ] AC19. The reading app integrates with the sync stack only through the packages (client, react), never through server internals or relative imports into other packages' source.
- [ ] AC20. Sample content (at least one RTL Hebrew, one LTR English, one mixed) is included, used by the tests and as the bundled content.
- [ ] AC21. Lint, typecheck, build and tests pass in CI like the other packages. DOM access is safe if the chosen framework renders on the server (architect decides).
- [ ] AC22. A README for the app documents the content schema, schema-version range policy, fingerprint algorithm and direction rules.
- [ ] AC23. The content ID is a required string of the form `<namespace>/<slug>`. Namespace and slug each use lowercase letters, digits, `-` and `.` only, with a documented length cap (the architect may tighten the exact pattern). A UUID is accepted as the slug. Schema validation rejects IDs that do not match the documented format with a typed error. Tests cover valid IDs, invalid IDs (missing namespace, uppercase, disallowed characters, over-length, empty parts) and UUID-slug IDs.

## Out of scope
- Item 8: code entry, QR display and scanning, approval prompt, connection indicator, keep-alive, "you're now leading", roster/counter/list and preview banner views, the follower "jump to group's page" prompt and late-joiner countdown, the joining flow in the UI.
- Item 9: Redis, public docs, changelog, release, health endpoint, semver.
- User-uploaded content and its upload flow (PRD future work). Only validation of fetched content is in scope.
- Any server change; the server never reads content, metadata or position.
- Choice of UI framework, packaging and Docker service for the app (architect decides via ADR at Gate 2).
- Item 8 (additions): the screens and prompts that show a content mismatch (warn/block UI), and sending the metadata on `createGroup` and reading it on join.
- Future work: loading the leader's exact version by content ID + fingerprint, and a content server that stores multiple versions (only the optional capability declaration in AC17 is in scope).
- Future work: once the upload feature is developed, the content source/server assigns content IDs and authors no longer pick them. The user wants this done as soon as uploads are built.

## Decisions (Gate 1)
1. **Q1, mismatch UI: accepted.** Item 7 owns the pure comparison, loader behaviour and a result/state API (AC15-AC17). Item 8 owns the screens and prompts that show mismatches.
2. **Q2, metadata wiring: accepted.** Item 7 provides the metadata object (AC8) and the compare function only. Item 8 sends the metadata on `createGroup` and reads it on join.
3. **Q3, fingerprint location: accepted.** Always computed by the app over a canonical form; the file never declares it. AC9 removed (numbering kept stable).
4. **Q4, algorithm: accepted.** SHA-256 over canonical JSON (sorted keys, no insignificant whitespace), hex, via Web Crypto. The architect confirms whether display-hint fields and Unicode normalisation are covered.
5. **Q5, display design: accepted.** The schema holds text and direction, plus a minimal versioned set of display hints only if needed. Richer display design comes later.
6. **Q6, app package: accepted.** The architect decides framework, location and the Docker service via ADR at Gate 2.
7. **Q7, old-version lookup: decided.** Warn/block only in v1. Loading the leader's exact version by content ID + fingerprint is deferred (AC17 rewritten). For `different-version` the outcome is `warn`, or `block` when the leader's schema version is unsupported. Schema starts at version 1; supported range is 1 only.
8. **Q8, content ID: modified by the user.** Required namespaced string `<namespace>/<slug>`; a UUID is accepted as the slug (AC23). Rationale: apps are already isolated on the server per the PRD, so collisions only matter within one app. Without a namespace, two different works sharing an ID would be misreported as `different-version` instead of `different-content`. Future: once uploads exist, the content source/server assigns IDs (see Out of scope).
9. **Q9, default direction: accepted.** Default is `ltr`; `auto` is allowed on blocks only.

## Open questions
- None remaining from Gate 1. The architect confirms the points listed in Q4 and may tighten the AC23 pattern.
