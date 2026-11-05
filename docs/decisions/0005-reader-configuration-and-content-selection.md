# 0005. Reader configuration, content selection and the library

- Status: Proposed
- Date: 2026-11-05
- Issue: #19

## Context

The URL picks the content (`?book=<contentId>` bundled, `?src=<url>` fetched,
AC25). Env config decides what happens with no parameter (library, error page,
default book, AC27), a deployment can serve one book only (AC29), the library
can be enabled or not (AC28, AC31), and invalid config is a startup error
(AC30, AC41). Bundled books are validated when the library index is built
and an invalid one fails the build (AC38, AC39). Open: env variable names,
whether single-book mode is a fourth value or a separate setting, what
"library enabled" means, the library URL and data source (designer D6), and
how config reaches a client-rendered app (0001).

## Options

### A. Single-book mode

1. **A fourth value of the entry setting: `READER_ENTRY=single-book`
   (recommended).** One setting answers "what does this deployment open?":
   `library` | `error` | `default-book` | `single-book`. Single-book ignores
   every URL parameter, so the other three answers do not apply to it; one
   setting cannot hold a contradictory pair.
2. A separate `READER_SINGLE_BOOK=<id>` overriding everything else: two
   settings that can contradict each other (single book plus
   `READER_ENTRY=library`), which then needs its own error rule.

### B. "Library enabled"

1. **`READER_LIBRARY=on|off`; default `on`, except `off` for single-book
   (recommended).** "Enabled" means: the `/library` page is served and every
   "Back to library" / "Go to library" link appears. Rules:
   `READER_ENTRY=library` requires `on`; `single-book` requires `off`;
   `on` with zero bundled books is an error (AC41). Independent of the entry
   mode otherwise, as AC28 requires (library enabled or not, in each mode).
2. Library enabled if and only if `READER_ENTRY=library`: simpler, but AC28
   and AC31 test the library enabled with the error and default-book modes,
   which this option cannot express.

### C. Library URL

1. **Fixed path `/library`; `/` with no parameter shows the library in place
   when `READER_ENTRY=library` (recommended).** Back links always point to
   `/library`, whatever the entry mode. Reading pages are `/?book=<id>` and
   `/?src=<url>`.
2. The library only at `/` with no parameter: then there is no library URL in
   the error and default-book modes, contradicting B1.

### D. Library data source

1. **Build-time index from a Vite plugin (recommended).** Bundled books live
   in `apps/reader/content/<namespace>/<slug>.json` (the path must equal the
   content ID). At build and dev-server start the plugin validates every
   file with the app's own validator (same code as runtime, AC38), checks
   IDs are unique and match their path, and fails the build on any error. It
   exposes a virtual module `virtual:reader-library` (entries: `contentId`,
   `title?`, `lang?`, effective document `dir`) and emits
   `library-index.json` (the same entries) for the server's config
   validation. Book bodies are loaded lazily with
   `import.meta.glob('/content/**/*.json', { query: '?raw' })`, so the raw
   text goes through the same parse/validate/fingerprint path as fetched
   content (AC2).
2. Runtime `fetch` of an index JSON: an extra request and a loading state on
   the library, and validation would be at runtime, contradicting AC38/AC39.

### E. How config reaches the client

1. **The reader server reads env at startup, validates it (with the bundled
   library index), and injects the public config into `index.html` as
   `<script type="application/json" id="reader-config">` (recommended).** No
   extra request, no loading flash, CSP-safe (a JSON script block is never
   executed; `<` is escaped as `<`). The dev and preview servers do the
   same through the Vite plugin, so `pnpm dev` with a bad env also fails to
   start. The client parses it with the same zod schema.
2. A `/config.json` request at boot: one more round trip and a loading state
   before anything renders.
3. Build-time `VITE_*` variables: changing config means rebuilding the image.

## Decision

A1, B1, C1, D1, E1. Environment variables (all optional):

| Variable                       | Values                                                  | Default                            | Rules                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `READER_ENTRY`                 | `library` \| `error` \| `default-book` \| `single-book` | `library`                          | unknown value: error                                                                                                                            |
| `READER_BOOK`                  | a bundled content ID                                    | none                               | required for `default-book` and `single-book`; must exist in the library index; set with `library`/`error`: error (it would be silently unused) |
| `READER_LIBRARY`               | `on` \| `off`                                           | `off` for `single-book`, else `on` | `library` with `off`: error; `single-book` with `on`: error; `on` with zero bundled books: error (AC41)                                         |
| `READER_UI_LANG`               | `auto` \| `en` \| `he`                                  | `auto`                             | see 0003                                                                                                                                        |
| `READER_SRC_ORIGINS`           | comma-separated origins                                 | empty (`?src` disabled)            | see 0006                                                                                                                                        |
| `READER_FETCH_TIMEOUT_SECONDS` | integer 1-120                                           | `15`                               | AC34                                                                                                                                            |
| `READER_SRC_MAX_BYTES`         | integer 1024-52428800                                   | `5242880` (5 MiB)                  | see 0006                                                                                                                                        |
| `PORT`, `HOST`                 | server listen address                                   | `8080`, `0.0.0.0`                  | server only                                                                                                                                     |

Values are trimmed; empty strings count as unset. Every error message names
the variable and the rule (`Config error: READER_BOOK "acme/x" is not a
bundled book`), and the server exits with code 1, like the sync server.

## Consequences

- One pure function `parseReaderConfig(env, libraryIds)` (shared by the
  server, the Vite plugin and tests) is the single source of the rules.
- The client trusts nothing it did not validate: it re-parses the injected
  config, and a missing/invalid block shows a fixed "app is not set up"
  status screen instead of a blank page.
- The library list is fixed per build; adding a bundled book means a rebuild
  (fits "bundled").
- `/library` is served only when the library is enabled (404 otherwise).
