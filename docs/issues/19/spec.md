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
- [ ] AC6. The fingerprint is a hash of the content file computed over a defined canonical form, so the same content gives the same fingerprint regardless of whitespace or key order, and the same value on any device. The algorithm and canonicalisation are documented.
- [ ] AC7. Any change to text, direction, page order or schema version changes the fingerprint; a change that is only JSON formatting does not (tests for both).
- [ ] AC8. The loaded-content result exposes `contentId`, `fingerprint` and `schemaVersion` as a metadata object ready to hand to the sync client's group metadata (what `createGroup(metadata)` already carries). The server is not changed and never reads it.
- [ ] AC9. If the format lets a file declare its own fingerprint (see Q3), the declared value is verified against the computed one and a mismatch is a typed error. Dropped if Q3 resolves to "always computed".

Text direction
- [ ] AC10. Direction can be set at document, page and block level with values `ltr`, `rtl` and (blocks only, see Q9) `auto`. The effective direction of a block is block, else page, else document, else a documented default.
- [ ] AC11. A block with `auto` takes its direction from its own text (first strong character); an empty or direction-neutral block falls back to its page/document direction. Tested with Hebrew, Arabic, English, mixed and neutral-only text.
- [ ] AC12. Content direction is independent of interface direction: an RTL interface with LTR content and the reverse both work, each applied only to its own area (tests for all four combinations).
- [ ] AC13. Page-turn direction follows the document direction: in an RTL document "next" moves leftward, "previous" rightward, and swipe gestures are reversed relative to LTR; keyboard and next/previous controls follow the same mapping. It is the document's direction, not the current page's or block's.
- [ ] AC14. Mixed-direction content (an RTL document with LTR blocks and the reverse) renders each block in its own direction with correct alignment and punctuation placement, verified with sample content in tests.

Content mismatch (logic and API only; presentation is Q1/Q2)
- [ ] AC15. A pure, tested comparison function takes local content metadata and the leader's metadata (content ID, fingerprint, schema version) and returns one of: `match`, `different-content` (content ID differs), `different-version` (same ID, fingerprint differs), `unsupported-schema` (leader's schema version outside the app's range).
- [ ] AC16. `unsupported-schema` blocks reading that content (consistent with AC3).
- [ ] AC17. For `different-version`: if the content source can serve the leader's exact version, the loader can load it by content ID + fingerprint; if the source does not keep old versions, the outcome is `warn`, or `block` when that version's schema is no longer supported. The source's capability is declared by the loader, not guessed. (Scope depends on Q7.)
- [ ] AC18. Display names and any other text coming from the sync service are rendered as plain text, escaped (closes #13 AC38 for the reading app).

Integration and quality
- [ ] AC19. The reading app integrates with the sync stack only through the packages (client, react), never through server internals or relative imports into other packages' source.
- [ ] AC20. Sample content (at least one RTL Hebrew, one LTR English, one mixed) is included, used by the tests and as the bundled content.
- [ ] AC21. Lint, typecheck, build and tests pass in CI like the other packages. DOM access is safe if the chosen framework renders on the server (architect decides).
- [ ] AC22. A README for the app documents the content schema, schema-version range policy, fingerprint algorithm and direction rules.

## Out of scope
- Item 8: code entry, QR display and scanning, approval prompt, connection indicator, keep-alive, "you're now leading", roster/counter/list and preview banner views, the follower "jump to group's page" prompt and late-joiner countdown, the joining flow in the UI.
- Item 9: Redis, public docs, changelog, release, health endpoint, semver.
- User-uploaded content and its upload flow (PRD future work). Only validation of fetched content is in scope.
- Any server change; the server never reads content, metadata or position.
- Choice of UI framework, packaging and Docker service for the app (architect/ADR; see Q6).
- A content server that stores multiple versions; only the app's ability to ask for one is in scope.

## Open questions (for Gate 1)
1. **Q1. Where does the mismatch warning/block UI live (7 or 8)?** The PRD puts "Content mismatch" under Product 1, but UX around joining belongs to item 8. Proposal: item 7 owns the pure comparison, loader behaviour and a result/state API (AC15-AC17); item 8 owns the screens and prompts that show it. Confirm or move the UI into 7.
2. **Q2. Who sends and receives group metadata?** The client already carries `metadata` on `createGroup` and `group.joined`. Does item 7 wire the app to send the leader's content metadata on group creation and read it on join (thin integration, no UI), or does that wait for item 8 where the join flow is built? Proposal: item 7 provides the metadata object (AC8) and compare function only; item 8 does the wiring.
3. **Q3. Fingerprint stored in the file or computed by the app?** The PRD says "a hash of the file". A hash cannot sit inside the file it hashes without a defined exclusion. Proposal: always computed over a canonical form (AC6); the file declares only content ID and schema version; AC9 is dropped. Alternative: the content source serves the fingerprint beside the file.
4. **Q4. Algorithm and canonicalisation.** Proposal: SHA-256 over canonical JSON (sorted keys, no insignificant whitespace), hex, via Web Crypto so it works in browser and Node. Architect to confirm, including whether it covers display-design fields and Unicode normalisation.
5. **Q5. What does "display design" in JSON cover?** The PRD says text and display design both come from JSON. Is theming/typography (fonts, sizes, colours, spacing) in item 7's schema, or text and direction only? Proposal: text and direction plus a minimal versioned set of display hints only if needed; richer design later.
6. **Q6. Reading app package.** It does not exist yet (`apps/` has only `sync-server`). Framework, location, whether the Docker service lands here or in item 9, and SPA vs server-rendered are for the architect (ADR at Gate 2), not decided here.
7. **Q7. Old-version lookup.** AC17 needs a content source that can serve a specific version. Bundled content has one version. Is "load by ID + fingerprint" required in v1, or only the warn/block policy, with lookup left to a later item? Also confirm the starting schema version and supported range (proposal: version 1, range 1 only).
8. **Q8. Content ID.** Proposal: a free string authored in the file, uniqueness is the author's responsibility. Confirm.
9. **Q9. Default direction and `auto` level.** Proposal: default `ltr` when nothing is declared; `auto` allowed on blocks only, as the PRD says.
