# 0004. Content schema v1, content ID format and fingerprint

- Status: Proposed
- Date: 2026-11-05
- Issue: #19

## Context

Every content file declares a schema version and a content ID; the app
computes a fingerprint so a leader and members can confirm they read the same
thing (AC1, AC3, AC6-AC8, AC23). Gate 1 fixed: SHA-256 over canonical JSON
(sorted keys, no insignificant whitespace), hex, via Web Crypto; always
computed by the app, never declared by the file (Q3, Q4); default direction
`ltr`, `auto` on blocks only (Q9); minimal display hints only if needed (Q5).
Open for this ADR: which display hints (designer D2), `lang` (D3), the exact
content ID pattern and length cap (AC23), whether display hints and Unicode
normalisation are covered by the fingerprint (Q4), and how strict validation
is about unknown fields.

## Options

### A. Display hints and `lang` (D2, D3)

1. **Optional document `title`, optional `lang` (document, page, block),
   optional block `type: "paragraph" | "heading"`; no visual hints
   (recommended).** `title` names the book in the header, the article and the
   library; `lang` lets screen readers pick the right voice; `heading` lets
   screen-reader users jump by heading. Colours, fonts and sizes stay in the
   app's tokens.
2. `title` and `lang` only; `type` later. Smaller, but adding a field later
   needs a schema version bump (see C).
3. Visual hints (font size, alignment, colours) now. Rejected by Q5.

### B. Content ID pattern (AC23)

1. **`<namespace>/<slug>`, each part lowercase `a-z`, `0-9`, `-`, `.`;
   starts and ends with a letter or digit; no `..`; namespace 1-64
   characters, slug 1-128 (recommended).** A lowercase UUID (36 characters)
   is a valid slug. Regex:
   `^(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?/[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$`.
   Uppercase UUIDs are rejected like any uppercase (authors lowercase them).
2. Same characters, no start/end rule: allows IDs like `-a/.b`, which read
   badly in URLs and file names.

### C. Unknown fields

1. **Strict: any field not in the schema is a validation error
   (recommended).** The schema version is the only extension mechanism: a new
   field means a new version, so an older app says "needs a newer app"
   instead of silently ignoring something the author relies on.
2. Lenient: ignore unknown fields. Two files that differ only in an ignored
   field would render the same but fingerprint differently (or the same,
   if ignored fields are stripped), which is confusing either way.

### D. What the fingerprint covers (Q4)

1. **The whole parsed file in canonical form, after validation succeeds
   (recommended).** Canonical form is RFC 8785 (JSON Canonicalization Scheme,
   JCS): object keys sorted by UTF-16 code units, no whitespace, strings
   serialised as `JSON.stringify` does, numbers in ECMAScript form (the schema
   has only one number, the integer `schemaVersion`). The canonical string is
   UTF-8 encoded and hashed with `crypto.subtle.digest('SHA-256')`; output is
   64 lowercase hex characters. Because validation is strict (C1), the whole
   file is schema fields only, so display hints (`title`, `lang`, `type`) are
   covered: changing them changes the fingerprint.
2. Hash a normalised model (defaults filled in, e.g. a missing `dir` replaced
   by `ltr`): files that render identically get the same fingerprint, but the
   fingerprint is then no longer "a hash of the file" and changes whenever the
   app's normalisation changes.

### E. Unicode normalisation (Q4)

1. **None (recommended).** Text is hashed exactly as decoded (code points
   unchanged, `\r\n` kept as written). NFC/NFD normalisation reorders
   combining marks by canonical combining class, which is known to reorder
   Hebrew points (niqqud) and cantillation marks in ways authors did not
   intend; and two differently encoded texts may render differently, so a
   different fingerprint is the honest answer.
2. NFC before hashing: equal-looking text from different editors matches,
   at the cost above.

## Decision

A1, B1, C1, D1, E1. Schema v1 (TypeScript notation, `?` = optional):

```ts
interface ContentDocument {
  schemaVersion: 1; // integer; supported range [1, 1]
  contentId: string; // B1 pattern
  title?: string; // 1-200 UTF-16 code units; line breaks collapse to spaces when shown
  lang?: string; // BCP 47 syntax, max 35 chars
  dir?: 'ltr' | 'rtl'; // default 'ltr'
  pages: Page[]; // 1-5000
}
interface Page {
  dir?: 'ltr' | 'rtl';
  lang?: string;
  blocks: Block[]; // 1-1000 (a page with zero blocks is invalid, AC32)
}
interface Block {
  text: string; // 0-20000 UTF-16 code units; "\n" is a line break (AC33)
  dir?: 'ltr' | 'rtl' | 'auto';
  lang?: string;
  type?: 'paragraph' | 'heading'; // default 'paragraph'
}
```

The limits are fixed per schema version, documented in the app README, and
apply to bundled and fetched content alike (fetched content also has a byte
cap, see 0006). Pages have no IDs in v1: with a matching fingerprint the page
index is stable, and item 8 syncs `{ page: index }` inside the opaque position.

## Consequences

- Any new field, value or limit change means schema version 2 and a new
  supported range; apps on 1 then block those files with "needs a newer app"
  (AC3).
- Files that render identically can fingerprint differently (a missing `dir`
  vs `"dir": "ltr"`, or composed vs decomposed letters). Documented as
  intended: the fingerprint identifies the file, not its rendering.
- Duplicate JSON keys follow `JSON.parse` (last wins) before canonicalisation;
  documented, and authors' tools rarely emit them.
- Web Crypto `crypto.subtle` exists only in secure contexts (HTTPS or
  `localhost`); the app must be served over HTTPS (documented, and a typed
  `crypto-unavailable` refusal otherwise).
- The algorithm is versioned with the schema: changing canonicalisation or
  hash means a new schema version.
