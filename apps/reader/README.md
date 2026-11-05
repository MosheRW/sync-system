# Reading app (`@sync-system/reader`)

A JSON-driven reading app: it shows one text at a time as a sequence of pages,
handles right-to-left, left-to-right and mixed-direction text, and identifies
each text by its content ID and a fingerprint so a group can check it reads the
same thing. React 19 + Vite, served by a small Node server
([ADR 0001](../../docs/decisions/0001-reading-app-framework.md)).

Item 7 of the roadmap: content, direction and fingerprint. Group sync (joining,
following the leader, mismatch screens) comes in item 8.

## Run

Development (Vite dev server on `http://localhost:5173`, loopback only):

```sh
pnpm install
pnpm --filter @sync-system/reader dev
READER_UI_LANG=he pnpm --filter @sync-system/reader dev      # Hebrew interface
```

Production build and server (from the repo root):

```sh
pnpm --filter @sync-system/reader build    # dist/ (app) and dist-server/ (server)
PORT=8081 pnpm --filter @sync-system/reader start
pnpm --filter @sync-system/reader preview  # vite preview with the same config and headers
```

Docker (the `reader` service in the root `compose.yaml`, loopback port 8081):

```sh
docker compose up --build reader
docker compose ps reader            # STATUS shows (healthy)
open http://127.0.0.1:8081/         # the library
```

The dev server, `preview` and the production server all validate the
configuration at startup with the same rules; a bad value stops them with
`Config error: ...` lines (the server exits with code 1).

### Pages

| URL                  | Shows                                                           |
| -------------------- | --------------------------------------------------------------- |
| `/?book=<contentId>` | a bundled book, e.g. `/?book=samples%2Fpsalms-he`               |
| `/?src=<url>`        | a text fetched by the browser from an allowed origin            |
| `/library`           | the list of bundled books (only when `READER_LIBRARY=on`)       |
| `/`                  | depends on `READER_ENTRY` (library, "No book selected", a book) |
| `/health`            | `ok` (for health checks)                                        |

Each reading page shows exactly one book and has no link to other books. A
link with both `book` and `src` (or one of them twice) is an invalid link.
An unknown `?book` always shows "Book not found", never the default book.
In `single-book` mode every URL parameter is ignored and the configured book
opens.

The current page is not kept across a reload (item 8 will sync it).

### HTTPS is required

The fingerprint uses Web Crypto (`crypto.subtle`), which browsers offer only in
a secure context: HTTPS, or `localhost`/`127.0.0.1`. Served over plain HTTP on
a LAN address, every text is refused with "This app needs a secure (HTTPS)
connection". Put the server behind a TLS-terminating reverse proxy, and set
`Strict-Transport-Security` there (the reader server does not send HSTS
because it does not terminate TLS).

## Configuration

All settings are environment variables, all optional. Values are trimmed;
empty means unset. The browser receives only the public part (entry, book,
library, interface language, source origins, timeout, size cap) inside
`index.html`; `PORT` and `HOST` never leave the server, and no reader setting
is a secret. Never add a secret to the reader's environment.

| Variable                       | Values                                                  | Default                            | Example                       |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------- | ----------------------------- |
| `READER_ENTRY`                 | `library` \| `error` \| `default-book` \| `single-book` | `library`                          | `default-book`                |
| `READER_BOOK`                  | a bundled content ID                                    | none                               | `samples/psalms-he`           |
| `READER_LIBRARY`               | `on` \| `off`                                           | `off` for `single-book`, else `on` | `off`                         |
| `READER_UI_LANG`               | `auto` \| `en` \| `he`                                  | `auto` (browser languages)         | `he`                          |
| `READER_SRC_ORIGINS`           | comma-separated exact origins                           | empty: `?src` disabled             | `https://content.example.org` |
| `READER_FETCH_TIMEOUT_SECONDS` | integer 1-120                                           | `15`                               | `30`                          |
| `READER_SRC_MAX_BYTES`         | integer 1024-52428800                                   | `5242880` (5 MiB)                  | `1048576`                     |
| `PORT`                         | integer 0-65535                                         | `8080`                             | `8081`                        |
| `HOST`                         | listen address                                          | `0.0.0.0`                          | `127.0.0.1`                   |

Rules (each violation is a startup error naming the variable):

- `READER_ENTRY` decides what `/` with no parameter shows: `library` the
  library, `error` the "No book selected" page, `default-book` the book in
  `READER_BOOK`. `single-book` serves only `READER_BOOK` and ignores every URL
  parameter.
- `READER_BOOK` is required for `default-book` and `single-book`, must be a
  bundled book, and must not be set with `library` or `error` (it would be
  silently unused).
- `READER_LIBRARY=on` serves `/library` and shows "Go to library" / "Back to
  library" links on status pages. `READER_ENTRY=library` needs it `on`;
  `single-book` needs it `off`; `on` with zero bundled books is an error.
- `READER_SRC_ORIGINS` entries must be exact origins as browsers write them:
  `https://host` or `https://host:port`, lowercase, no trailing slash, path,
  query, user name, wildcard or default port (`:443`). `http:` is accepted only
  for `localhost`, `127.0.0.1` and `[::1]`, **for development only**: with
  `NODE_ENV=production` the server prints a warning, because any `?src` link
  could then make readers' browsers call that port on their own machine.
- `READER_SRC_MAX_BYTES`: keep the default unless you need more. A large
  file is parsed, validated and hashed on the reader's device; tens of
  megabytes can freeze a phone's browser tab.

### Interface language

The interface ships in English and Hebrew
([ADR 0003](../../docs/decisions/0003-interface-languages.md)). With `auto`
the first browser language whose primary subtag is `en` or `he` wins, else
English. The interface direction (`<html dir>`) follows the interface
language; the content keeps its own direction.

## Fetched content (`?src`)

`?src` is **off by default**
([ADR 0006](../../docs/decisions/0006-fetched-content-policy.md)). To enable it,
list each content host in `READER_SRC_ORIGINS`. Then:

- The `?src` value is parsed as an absolute URL (relative URLs, `javascript:`,
  `data:`, `blob:`, `file:` and URLs with a user name or password are
  refused). Its origin must equal a listed origin exactly; anything else shows
  "This text can't be opened here" and nothing is fetched.
- The browser fetches the file itself (the reader server never fetches
  anything) with `credentials: 'omit'`, `redirect: 'error'`,
  `referrerPolicy: 'no-referrer'` and `cache: 'no-store'`. A host that
  redirects (short links) must be listed by its final origin and linked
  directly.
- **CORS:** the content host must answer with
  `Access-Control-Allow-Origin` for the reader's origin (or `*`). Without it
  the browser blocks the response and the reader shows a network error.
- The body is read as a stream and refused past `READER_SRC_MAX_BYTES`
  (counting the decompressed bytes), and it must be UTF-8. The request and the
  body read share one timeout, `READER_FETCH_TIMEOUT_SECONDS`.
- The listed origins are also the only ones in the CSP `connect-src`, so the
  browser enforces the list as well.

Response headers on every response: a strict `Content-Security-Policy`
(`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
font-src 'self'; connect-src 'self' <READER_SRC_ORIGINS>; manifest-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src
'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin` and
`Permissions-Policy: camera=(), microphone=(), geolocation=()`. The server
logs nothing per request (query strings carry URLs).

## Content schema (version 1)

A content file is UTF-8 JSON
([ADR 0004](../../docs/decisions/0004-content-schema-v1-and-fingerprint.md)):

```ts
interface ContentDocument {
  schemaVersion: 1; // integer
  contentId: string; // "<namespace>/<slug>", see below
  title?: string; // 1-200 characters; line breaks collapse to spaces when shown
  lang?: string; // BCP 47 tag, e.g. "he", "en", "ar"
  dir?: 'ltr' | 'rtl'; // default "ltr"
  pages: Page[]; // 1-5000
}
interface Page {
  dir?: 'ltr' | 'rtl';
  lang?: string;
  blocks: Block[]; // 1-1000: a page with no blocks is invalid
}
interface Block {
  text: string; // 0-20000 characters; "\n" is a line break
  dir?: 'ltr' | 'rtl' | 'auto';
  lang?: string;
  type?: 'paragraph' | 'heading'; // default "paragraph"
}
```

Example:

```json
{
  "schemaVersion": 1,
  "contentId": "acme/psalms-he",
  "title": "תהילים",
  "lang": "he",
  "dir": "rtl",
  "pages": [
    {
      "blocks": [
        { "type": "heading", "text": "מזמור כ\"ג" },
        { "text": "מזמור לדוד, ה' רעי לא אחסר.\nבנאות דשא ירביצני." },
        { "dir": "ltr", "lang": "en", "text": "An English note inside a Hebrew book." }
      ]
    }
  ]
}
```

Limits (fixed per schema version, the same for bundled and fetched content):

| Limit                       | Value                  |
| --------------------------- | ---------------------- |
| Pages per file              | 1-5000                 |
| Blocks per page             | 1-1000                 |
| Characters per block `text` | 0-20000                |
| Characters in `title`       | 1-200                  |
| Characters in a `lang` tag  | 35                     |
| Content ID namespace / slug | 1-64 / 1-128           |
| Fetched file size (`?src`)  | `READER_SRC_MAX_BYTES` |

Characters are UTF-16 code units, as in JavaScript.

Validation is **strict**: any field not listed above (at any level, including
`__proto__`) makes the file invalid, as do unknown `dir` or `type` values,
wrong types, an empty `pages` list and a page with no blocks. Text containing
a lone UTF-16 surrogate (`"\ud800"` escapes without a pair) is invalid too.
If a key appears twice in one object, the last value wins (JSON parsing),
which also decides the fingerprint.

### Content ID

`<namespace>/<slug>`, both parts made of lowercase `a-z`, digits, `-` and `.`,
each starting and ending with a letter or digit, no `..` anywhere; namespace
1-64 characters, slug 1-128. A lowercase UUID is a valid slug
(`acme/123e4567-e89b-12d3-a456-426614174000`); uppercase is refused.

```
^(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?/[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$
```

### Schema-version policy

The app declares the schema versions it can render: currently **1 to 1**. The
version is checked before anything else in the file:

| `schemaVersion`                         | Result                                  |
| --------------------------------------- | --------------------------------------- |
| missing                                 | refused: "Missing schema version"       |
| not an integer >= 1 (`"1"`, `1.5`, `0`) | refused: "Schema version is not valid"  |
| above the supported range               | refused: "This text needs a newer app"  |
| below the supported range               | refused: "This text uses an old format" |
| in range                                | validated against that version's schema |

Nothing from a refused file is shown. Any change to the schema (a new field,
value or limit), and any change to the fingerprint algorithm, means a new
schema version; an app that does not know it refuses the file with "needs a
newer app" instead of silently ignoring what the author relies on.

## Fingerprint

The app computes the fingerprint of every text it loads; a file never declares
it.

1. Parse the file as JSON and validate it (above). Only a valid file gets a
   fingerprint.
2. Serialise the validated value in canonical form,
   [RFC 8785 (JSON Canonicalization Scheme)](https://www.rfc-editor.org/rfc/rfc8785):
   no whitespace; object keys sorted by UTF-16 code units; strings and numbers
   written exactly as ECMAScript `JSON.stringify` writes them.
3. Encode the canonical string as UTF-8 and hash it with SHA-256 (Web Crypto
   `crypto.subtle.digest`).
4. The fingerprint is the hash as 64 lowercase hexadecimal characters.

So the same content gives the same fingerprint whatever its whitespace or key
order, on any device. Every field counts, display hints included: changing
any text, `dir`, `lang`, `title`, `type`, page order or the schema version
changes the fingerprint. Text is **not** Unicode-normalised: a letter with a
combining mark (NFD) and its precomposed form (NFC) give different
fingerprints, as do a missing `dir` and an explicit `"dir": "ltr"`. The
fingerprint identifies the file, not how it looks.

The fingerprint is a consistency check, **not a signature**: anyone can
compute it, and a leader in a group can announce any value. Never use it to
grant or refuse access.

Test vector (`test/fixtures/fingerprint-vector.json`):

```json
{
  "schemaVersion": 1,
  "contentId": "acme/fingerprint-vector",
  "title": "שיר",
  "dir": "rtl",
  "lang": "he",
  "pages": [
    {
      "blocks": [
        { "text": "שלום, world.\nשורה שנייה", "type": "heading" },
        { "text": "English \"quoted\" text", "dir": "ltr", "lang": "en" }
      ]
    },
    { "blocks": [{ "text": "1948 - 2024.", "dir": "auto" }] }
  ]
}
```

Fingerprint: `a8672a8d9ccb84e903c9167de7dbe3d1a7b4cd42f00d53a3872687c1e7f58aee`

### Group metadata and comparison

A loaded text exposes `{ contentId, fingerprint, schemaVersion }`, the metadata
item 8 hands to `createGroup(metadata)`. Comparing a member's text with the
leader's metadata gives:

| Result               | When                                                                                  | Outcome |
| -------------------- | ------------------------------------------------------------------------------------- | ------- |
| `unsupported-schema` | the leader's metadata is malformed, or its schema version is outside this app's range | `block` |
| `different-content`  | content IDs differ                                                                    | `block` |
| `different-version`  | same content ID, different fingerprint                                                | `warn`  |
| `match`              | same content ID and fingerprint                                                       | `none`  |

Loading the leader's exact version by content ID and fingerprint is not
supported (the loader declares `versionLookup: false`).

## Direction rules

- Direction can be set on the document, a page and a block: `ltr` or `rtl`,
  plus `auto` on blocks only.
- A block's effective direction is its own, else its page's, else the
  document's, else `ltr`.
- `auto` takes the direction of the block's first strong character: a letter
  of a right-to-left script (Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan,
  Mandaic and the right-to-left scripts outside the BMP) or an RLM/ALM mark
  gives `rtl`; any other letter or an LRM mark gives `ltr`. Text inside
  isolates (LRI/RLI/FSI ... PDI) is skipped. Empty text and text with only
  digits, punctuation and spaces falls back to the page/document direction.
  (The app resolves `auto` itself, by Unicode code-point ranges, so every
  browser shows the same result.)
- Every block is its own element with its effective direction, aligned to its
  own start side; punctuation lands at the end of the block in its direction.
- **Page turns follow the document direction**, never a page's or a block's:
  in an RTL document "Next" is on the left, the right arrow key goes back, and
  a finger swipe from left to right goes forward. Space/Page Down turn the page
  at the bottom of a long page; Home/End go to the first/last page.
- The interface (header, buttons, status pages) has its own direction from
  the interface language. Titles shown inside the interface are isolated with
  the book's own direction.
- Line breaks (`\n`, and `\r\n`) inside a block are kept: poems and addresses
  render line by line. Spaces at line starts and ends are dropped and runs of
  spaces collapse.

### Writing mixed-direction text

The direction of a whole block is set by `dir`. Inside one block, the browser
places words by the Unicode bidirectional algorithm, which is usually right
(an English name inside a Hebrew sentence). When it is not, for example a
sentence that ends with a word in the other direction, or a number range, add
Unicode controls to the text:

- FSI (U+2068) ... PDI (U+2069) around an embedded phrase isolates it;
- RLM (U+200F) or LRM (U+200E) next to punctuation attaches it to the right
  side.

Schema v1 has no inline markup or spans.

## Adding a bundled book

1. Save the file as `apps/reader/content/<namespace>/<slug>.json`; the path
   must equal its `contentId` (`content/acme/psalms-he.json` holds
   `"contentId": "acme/psalms-he"`).
2. Run `pnpm --filter @sync-system/reader build` (or `dev`). Every bundled
   file is validated with the same code as at runtime; any invalid file,
   path mismatch or duplicate ID fails the build with a list of all problems,
   so a broken book is never shipped or listed.
3. It appears in the library (sorted by title) and at
   `/?book=<namespace>%2F<slug>`.

The samples in `content/samples/` are public domain (Psalms in Hebrew, the
opening of _Pride and Prejudice_) or written for this project.

## Development

```sh
pnpm --filter @sync-system/reader typecheck
pnpm --filter @sync-system/reader test
pnpm lint
```

Layout: `src/content` (schema, parser, fingerprint, loader, `?src` policy),
`src/direction`, `src/navigation`, `src/config`, `src/app` (boot, routing),
`src/components`, `src/i18n`, `plugins/library.ts` (build-time library index,
`virtual:reader-library`), `server/` (the production server). The app imports
the sync stack only through `@sync-system/react`; ESLint enforces it and bans
HTML sinks (`dangerouslySetInnerHTML`, `innerHTML`, ...): every external text
is rendered as plain text.
