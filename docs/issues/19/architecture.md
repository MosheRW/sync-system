# Architecture: #19 reading app content, text direction (RTL) and content fingerprint (PRD item 7)

Spec: [`spec.md`](spec.md) (AC1-AC41, AC9 removed). Design: [`design.md`](design.md)
(D1-D6 answered below). ADRs: [`docs/decisions/0001`-`0006`](../../decisions/)
(all `Proposed`, decided at Gate 2).

## 1. Repo layout

- Layout: **monorepo** (pnpm workspace `apps/*`, `packages/*`; `git submodule
  status` is empty; no turbo/nx). One issue, one branch, one PR. No other repo
  is affected, no linked issue.
- Touched:

| Path | Package | Change | Checks |
|---|---|---|---|
| `apps/reader` | `@sync-system/reader` (new, `private: true`) | all product code, tests, sample content, Dockerfile, README | `pnpm --filter @sync-system/reader typecheck test build` |
| root | `eslint.config.js`, `compose.yaml`, `.dockerignore` (unchanged, verified), `README.md`, `pnpm-lock.yaml` | lint block for the app, `reader` compose service, workspace table and run docs, lockfile | `pnpm lint`, `pnpm audit --audit-level=high`, `docker compose config` |
| `docs/` | `docs/conventions.md` (new), `docs/decisions/*` | ADRs accepted, conventions recorded | prettier ignores `docs/issues` only, so ADRs/conventions must pass `prettier --check` |

- `packages/*` and `apps/sync-server`: **no change**. The app depends on
  `@sync-system/react` (workspace) and uses only its exports (AC19). Item 7
  needs only the `JsonObject` type from it (AC8); `SyncProvider` arrives in
  item 8.

## 2. Decisions

Six ADRs, all `Proposed`. Each needs an explicit choice at Gate 2.

| ADR | Decision | Recommendation (runner-up) |
|---|---|---|
| [0001](../../decisions/0001-reading-app-framework.md) | Framework, location, SPA vs SSR, Docker timing | React 19 + Vite SPA in `apps/reader`, served by a minimal `node:http` server; Docker image and compose service **in item 7** (Next.js; Docker in item 9) |
| [0002](../../decisions/0002-styling-and-design-tokens.md) | Styling, design tokens (D1), fonts (D5) | CSS Modules + `tokens.css` custom properties, design.md tokens as written, system font stack (Tailwind; bundled fonts) |
| [0003](../../decisions/0003-interface-languages.md) | Interface languages and choice (D4) | `en` + `he`, from `navigator.languages`, fallback `en`, optional `READER_UI_LANG` pin; no i18n library |
| [0004](../../decisions/0004-content-schema-v1-and-fingerprint.md) | Schema v1, hints (D2), `lang` (D3), content-ID pattern (AC23), fingerprint coverage and normalisation (Q4) | Optional `title`, `lang` (3 levels), block `type: paragraph\|heading`; strict (unknown fields rejected); ID `ns/slug` with start/end rule, no `..`, 64/128 caps; fingerprint = SHA-256 of RFC 8785 canonical JSON of the whole file (covers hints); **no** Unicode normalisation |
| [0005](../../decisions/0005-reader-configuration-and-content-selection.md) | Env names, single-book mode, "library enabled", library URL and data (D6), config delivery, startup validation | `READER_ENTRY=library\|error\|default-book\|single-book`, `READER_BOOK`, `READER_LIBRARY=on\|off`; `/library` path; build-time index via Vite plugin; config injected into `index.html` by the server |
| [0006](../../decisions/0006-fetched-content-policy.md) | `?src` policy, size, CORS, CSP | Allow-list `READER_SRC_ORIGINS`, **disabled by default**; 5 MiB cap; `redirect: 'error'`; strict CSP whose `connect-src` is the allow-list |

Other choices made in this plan (no ADR, inside the ADRs above):

| # | Choice | Why |
|---|---|---|
| P1 | One content pipeline: raw text -> `JSON.parse` -> schema-version gate -> strict schema -> fingerprint. Bundled books are imported as raw strings (`?raw`), not as parsed JSON modules | AC2 "same result shape"; bundled and fetched content get identical validation and fingerprints |
| P2 | Schema version is checked **before** full validation | A v2 file with new fields says "needs a newer app" (AC3), not "invalid" |
| P3 | `auto` resolved by the app (first strong character, Unicode bidi rule P2 incl. skipping isolate runs; LRM/RLM/ALM count as strong) | design.md section 7; browsers differ on neutral fallback |
| P4 | No router library: `resolveEntry(config, location, library)` is a pure function; navigation between screens is full page loads (`<a href>`) | Two paths and two query params; links work without JS state |
| P5 | Interface language and direction set on `<html>` at boot; content `lang`/`dir` on the content `<article>` and per block | AC12, design.md section 6 |
| P6 | Different-content outcome is `block`; malformed leader metadata is `unsupported-schema` / `block` | AC15/AC17 define only `different-version`; see Gate 2 Q3, Q4 |
| P7 | zod runs with `z.config({ jitless: true })` set once in `src/main.tsx` | CSP without `'unsafe-eval'` (0006) |
| P8 | `.ts` pure modules have no React import; components are `.tsx` | Unit-test logic without the DOM |

## 3. Approach

A client-rendered React app in `apps/reader`, with all content logic in pure,
framework-free modules (`src/content`, `src/direction`, `src/navigation`,
`src/config`, `src/app/resolve-entry.ts`) and thin components on top.

```
URL + injected config --resolveEntry--> Route
  reading(source) --ContentLoader.load--> LoadResult --ok--> ReadingScreen
                                                    \--error--> StatusScreen (typed reason)
  library ------------------------------------------------------> LibraryScreen
  book-not-found | no-book | invalid-link | not-configured ----> StatusScreen
```

Production serving: `apps/reader/server` (Node 24, `node:http`, no framework)
reads env, validates it against `dist/library-index.json` (exit 1 on error),
loads every file under `dist/` into an in-memory map (the only files it will
ever serve), renders `index.html` once with the injected config, and answers
`GET`/`HEAD` with security headers. Dev (`vite`) and preview (`vite preview`)
use the same `parseReaderConfig` through the library plugin.

Alternatives rejected (beyond the ADRs):
- *Parsed JSON imports for bundled books*: Vite would re-serialise them, and
  bundled content would skip the version gate and raw-text path (P1).
- *Browser `dir="auto"`*: engine-dependent fallback for neutral text (P3).
- *React Router*: unnecessary for two paths; adds a dependency.
- *Static file serving with `sirv`/`serve-static`*: a dependency for what an
  in-memory allow-list does in a few lines with no path-traversal surface.
- *Page IDs in the schema*: the fingerprint makes page indexes stable (0004).

## 4. Files

All new files are under `apps/reader/` unless marked.

### Package and build
| File | What |
|---|---|
| `package.json` | `@sync-system/reader`, `private: true`, `type: module`. Scripts: `dev` (`vite`), `build` (`vite build && tsc -p tsconfig.server.json`), `preview` (`vite preview`), `start` (`node dist-server/server/main.js`), `typecheck` (`tsc -p tsconfig.json && tsc -p tsconfig.server.json --noEmit`), `test` (`vitest run`). `dependencies`: `@sync-system/react: workspace:*`, `react`, `react-dom` (^19.3), `zod` (^4.6.7). `devDependencies`: `vite` (^8.3, matching the lockfile), `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@types/react`, `@types/react-dom`, `@types/node`, `typescript` (same ranges as `packages/react`). |
| `tsconfig.json` | Extends base; `lib: ["ES2023", "DOM", "DOM.Iterable"]`, `jsx: "react-jsx"`, `types: ["node", "vite/client"]`, `module`/`moduleResolution: "Bundler"` for `src` (Vite resolves); includes `src`, `test`, `plugins`, `vite.config.ts`, `vitest.config.ts`. |
| `tsconfig.server.json` | Node build of `server/` + `src/config/` + `src/content/limits.ts` (pure, no DOM): `lib: ["ES2023"]`, `types: ["node"]`, NodeNext, `rootDir: "."`, `outDir: "dist-server"`. A DOM global in these files fails the build. |
| `vite.config.ts` | `oxc`/JSX automatic runtime, `css.modules`, `build.target: 'es2023'`, no inline assets that would need `data:` in CSP (`assetsInlineLimit: 0`), `build.modulePreload.polyfill: false` (no inline script), plugin `readerLibrary()`. Resolve condition `@sync-system/source` (workspace sources, like the other packages). |
| `vitest.config.ts` | Like `packages/react/vitest.config.ts`: source condition, `environment: 'jsdom'` by default, `test/**/*.test.{ts,tsx}`, `setupFiles: ['test/setup.ts']`; fingerprint and server tests opt into `// @vitest-environment node`. |
| `index.html` | Minimal shell: `<div id="root">`, `<script type="module" src="/src/main.tsx">`, placeholder comment `<!--reader-config-->` replaced by the server/plugin. No inline script or style. |
| `Dockerfile` | Multi-stage like `apps/sync-server/Dockerfile` (same pinned `node:24-alpine` digest, `corepack enable`, manifests first, `pnpm --filter @sync-system/reader... build`, `pnpm deploy --prod --legacy /out`), runtime copies `dist/`, `dist-server/`, `node_modules` (zod only), `USER node`, `EXPOSE 8080`, `HEALTHCHECK` via `node -e fetch('/health')`, `CMD ["node","dist-server/server/main.js"]`. |
| `README.md` | Section 9 (docs impact). |

### Content (pure, `src/content/`)
| File | What |
|---|---|
| `limits.ts` | Schema v1 limits (pages 5000, blocks/page 1000, text 20000, title 200, lang 35, namespace 64, slug 128) and `SUPPORTED_SCHEMA = { min: 1, max: 1 }`. |
| `content-id.ts` | `CONTENT_ID_PATTERN` (0004 B1), `isContentId(s)`, `contentIdIssue(s)` returning the specific reason (missing namespace, uppercase, character, part too long, empty part, `..`, edge character). |
| `schema.ts` | zod v1 schema, `z.strictObject` at every level (0004 C1); `ContentDocument`, `Page`, `Block` types; `lang` regex `^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$`. |
| `errors.ts` | `ContentError` discriminated union (section 5.2) and `isRetryable(error)` (fetch kinds only). |
| `parse.ts` | `parseContentText(text): ParseResult` = `JSON.parse` (catch -> `invalid-json`), must be a plain object, version gate (P2), strict schema; first zod issue mapped to `{ path: 'Page 3, block 2', code, detail }`, quoted values truncated to 40 chars. Shared by the loader and the library plugin. |
| `canonical-json.ts` | `canonicalJson(value: JsonValue): string`: RFC 8785 for the value types JSON.parse produces; keys sorted by UTF-16 code units (default `Array.prototype.sort` on strings), iterative or depth-bounded (schema bounds depth at 5). |
| `fingerprint.ts` | `computeFingerprint(value, subtle = globalThis.crypto?.subtle)`: `TextEncoder` -> `subtle.digest('SHA-256')` -> lowercase hex; throws typed `crypto-unavailable` if `subtle` is missing (non-secure context). |
| `metadata.ts` | `ContentMetadata { contentId, fingerprint, schemaVersion }` (assignable to `JsonObject` from `@sync-system/react`, compile-time check), `toGroupMetadata(content): JsonObject` (a fresh plain object, AC8), `parseLeaderMetadata(value: unknown)`. |
| `compare.ts` | `compareContent(local, leader: unknown, supported = SUPPORTED_SCHEMA): { result, outcome }` (section 5.3). |
| `src-policy.ts` | `checkSrc(raw: string, origins: readonly string[]): { ok: true, url } \| { ok: false, error }` (0006): WHATWG `URL`, `http:`/`https:` only, no credentials, exact origin match. |
| `fetch-text.ts` | `fetchText(url, { timeoutMs, maxBytes, signal, fetchImpl })`: request options from 0006, `AbortSignal.any([caller, AbortSignal.timeout])`, `Content-Length` pre-check, streamed read with cap, fatal UTF-8 decode; returns text or typed `network` / `http` (status) / `timeout` (seconds) / `too-large` / `aborted`. |
| `loader.ts` | `createContentLoader({ bundled, fetchImpl?, subtle?, config })` returning `ContentLoader` (section 5.1). Bundled: `virtual:reader-library` loaders; unknown ID -> `not-found`. |

### Direction and navigation (pure)
| File | What |
|---|---|
| `src/direction/first-strong.ts` | `firstStrongDirection(text): 'ltr' \| 'rtl' \| null` (P3). RTL = letters in Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic presentation forms and the SMP RTL ranges, plus RLM/ALM; LTR = any other `\p{L}` or LRM; skips text between LRI/RLI/FSI and matching PDI. |
| `src/direction/effective.ts` | `documentDir(doc)`, `pageDir(doc, page)`, `blockDir(doc, page, block)` (AC10, AC11 fallback), `effectiveLang` likewise. |
| `src/navigation/input-map.ts` | `mapKey(event-like, docDir, scrollState)` and `buttonSides(docDir)` -> `'next' \| 'previous' \| 'first' \| 'last' \| null`, exactly design.md section 5 table, incl. modifier/selection/input-focus rules. |
| `src/navigation/swipe.ts` | `classifySwipe(start, end, { width, durationMs, pointers, zoomed, selection }, docDir)`: 48 px, `\|dx\| > 1.5\|dy\|`, 600 ms or 30 % width rules. |
| `src/navigation/use-page-navigation.ts` | Hook: page index state (starts at 0, not persisted, AC35), `goTo`, `next`, `previous`, key listener on `document`, pointer listeners on the content region; exposes current index and `goTo(i)` for item 8 (design.md section 11). |

### Config and entry (pure)
| File | What |
|---|---|
| `src/config/schema.ts` | `parseReaderConfig(env, libraryIds): ReaderConfig` (0005 table; collects all problems, throws `ConfigError` listing them), `publicConfig(config)` (what the client gets: entry, book, library, uiLang, srcOrigins, fetchTimeoutSeconds, srcMaxBytes; no `PORT`/`HOST`), `parsePublicConfig(unknown)` for the client. |
| `src/config/config-error.ts` | `ConfigError` (pattern: `apps/sync-server/src/config/config-error.ts`). |
| `src/app/resolve-entry.ts` | `resolveEntry(config, { pathname, search }, libraryIds): Route` (section 5.4). |
| `src/app/boot.ts` | Reads `#reader-config` JSON from the document, `parsePublicConfig`, picks the UI language (0003), sets `<html lang dir>` and `document.title`. |

### Library build (Node, runs inside Vite)
| File | What |
|---|---|
| `plugins/library.ts` | Vite plugin `readerLibrary({ contentDir })`. `buildLibraryIndex(dir)` (exported, tested): walks `content/**/*.json`, `parseContentText` each, path must equal `<contentId>.json`, unique IDs, collects every error and throws one message listing them (AC38). Provides `virtual:reader-library` (`entries` sorted later in the UI, `loaders` from `import.meta.glob('/content/**/*.json', { query: '?raw', import: 'default' })`), emits `library-index.json`, and in `configureServer`/`configurePreviewServer` runs `parseReaderConfig(process.env, ids)` (fails start) and injects config via `transformIndexHtml`. Watches `content/` in dev. |
| `src/library/types.ts` | `LibraryEntry { contentId, title?, lang?, dir }` (shared with server). |
| `src/virtual-modules.d.ts` | Types for `virtual:reader-library`. |

### Server (Node)
| File | What |
|---|---|
| `server/main.ts` | `run(process.env)`; exit code from result (pattern: `apps/sync-server/src/main.ts`). |
| `server/run.ts` | `run(env, io)`: read `dist/library-index.json`, `parseReaderConfig`, build file map, render HTML, listen. Config errors print `Config error: ...` to stderr, exit code 1; never print env values other than the offending one. SIGTERM/SIGINT: close server, exit 0. |
| `server/static-files.ts` | `loadStaticFiles(distDir)`: every file under `dist/` (except `index.html`, `library-index.json`) -> `Map<urlPath, { body, contentType, cacheControl }>`; hashed assets `public, max-age=31536000, immutable`. MIME table for the extensions Vite emits; unknown extension -> `application/octet-stream`. |
| `server/html.ts` | `renderIndexHtml(template, publicConfig)`: replaces the placeholder with `<script type="application/json" id="reader-config">` + JSON with `<`, `>`, `&`, U+2028, U+2029 escaped. `Cache-Control: no-cache`. |
| `server/headers.ts` | `securityHeaders(config)`: the 0006 headers; `connect-src 'self'` plus the configured origins. |
| `server/handler.ts` | `GET`/`HEAD` only (else 405 with `Allow`); `/health` -> 200 `ok`; `/` -> index; `/library` -> index if library on, else 404; file map hit -> file; else 404 plain text. Path matched on the decoded `pathname` from `new URL(req.url, 'http://x')` against the map only; query never logged; no request logging. |

### UI (`src/`)
| File | What |
|---|---|
| `main.tsx` | `z.config({ jitless: true })`, `boot()`, `createRoot(...).render(<App/>)`; imports `styles/tokens.css`, `styles/global.css`. |
| `app/App.tsx` | Renders the route: `ReadingRoute` (load with `useContent`), `LibraryScreen`, or `StatusScreen` variants. |
| `app/use-content.ts` | Runs `loader.load(source, { signal })`, state `loading \| ready \| error`, `retry()`; aborts on unmount; loading indicator only after 300 ms, "still loading" after 8 s if timeout > 8 s. |
| `i18n/en.ts`, `i18n/he.ts`, `i18n/index.ts` | Typed messages (all copy from design.md sections 8, 8a plus section 6.4 below), `pickUiLanguage(navigatorLanguages, setting)`, `format`, `I18nProvider`/`useI18n`. |
| `components/ReadingScreen.tsx` (+ `.module.css`) | Header, `<main>` with `<article dir lang aria-label>`, `PageNav`, `LiveAnnouncer`, overlay layer and header end slot (empty, item 8). No library link (AC36). |
| `components/ReaderHeader.tsx` | Title in `<bdi dir lang>` (line breaks collapsed), counter in interface language. |
| `components/PageView.tsx`, `components/ContentBlock.tsx` | One element per block with effective `dir` and `lang`, `text-align: start`, `white-space: pre-line`, `\r\n` -> `\n` at render; `heading` blocks as `<h2>`, paragraphs as `<p>`. Text inserted as children only. |
| `components/PageNav.tsx`, `components/PageProgress.tsx` | Buttons placed and chevrons drawn by document direction; `aria-disabled` at ends; DOM order = visual order. |
| `components/LiveAnnouncer.tsx` | One polite region, "Page n of N", not on first load. |
| `components/StatusScreen.tsx` | Shared layout; heading focus on mount (`tabindex=-1`); optional primary action, optional secondary link, collapsed `<details>`. |
| `components/status-screens.tsx` | Mapping from `ContentError` / route kinds to copy, actions and details (section 6). |
| `components/LibraryScreen.tsx`, `components/LibraryItem.tsx` | `<h1>`, `<ul>` of row links `/?book=<encodeURIComponent(id)>`; sorted with `Intl.Collator(uiLang)` by title (fallback content ID). |
| `components/PlainText.tsx` | `PlainText({ text, dir?, lang?, maxLength? })`: the one way to show external strings (content, URL values, later sync display names, AC18). |
| `styles/tokens.css`, `styles/global.css` | design.md section 10 tokens, `prefers-color-scheme`, `prefers-reduced-motion`, `:lang(ar)` line height. |

### Sample content (`content/samples/`) (AC20)
| File | Content |
|---|---|
| `psalms-he.json` | RTL Hebrew, `title` in Hebrew, `lang: he`; public-domain Psalms text; a poem block with `\n`. |
| `pride-and-prejudice-en.json` | LTR English, public-domain excerpt. |
| `mixed-he-en.json` | RTL document: Hebrew paragraph ending `.` and `?`, Hebrew with an embedded English phrase and a number, an `ltr` English block, an `auto` block starting with English, an `auto` block `"1948 - 2024."`, an Arabic block (`lang: ar`), an RTL poem; a `heading` block. |
| `mixed-en-he.json` | LTR document with a Hebrew `title`, the reverse set (`rtl` Hebrew block, `auto` Hebrew block, LTR poem). |
| `untitled.json` | No `title`, no `lang` (library fallback to content ID). |

All text is public domain or written for the project (no licensed text).

### Tests (`test/`)
Listed in section 8. Fixtures in `test/fixtures/` (valid and invalid content,
including `library-invalid/` with one broken book for AC38, `library-empty/`
for AC41, and an Arabic-titled book).

### Modified (root)
| File | What |
|---|---|
| `eslint.config.js` | Block for `apps/reader/src/**/*.{ts,tsx}`: `no-restricted-imports` paths `@sync-system/server`, `@sync-system/protocol`, `@sync-system/client` (go through react, AC19; type re-exports exist) and patterns `@sync-system/*/src/*`, `**/packages/**`, `**/sync-server/**`, `node:*`; `no-restricted-syntax` for JSX attribute `dangerouslySetInnerHTML`; `no-restricted-properties` for `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`; `no-console`. A `server/**` and `plugins/**` block allows Node. Include `.tsx`/config files in the typed project service. |
| `compose.yaml` | Service `reader`: build `apps/reader/Dockerfile`, image `sync-system/reader:dev`, port `127.0.0.1:8081:8080`, env with defaults documented (entry `library`, `READER_SRC_ORIGINS` empty), healthcheck. No `depends_on` (item 7 does not connect to the sync server). |
| `README.md` | Workspace table row, "Reading app" section linking to `apps/reader/README.md`, compose usage. |
| `pnpm-lock.yaml` | New importer `apps/reader`. |
| `docs/conventions.md` (new, chunk 1) | Existing stack (pnpm 10, Node 24, TS 6, ESM, Vitest, zod, ESLint+Prettier, conventional commits) plus ADRs 0001-0006 as accepted. |

## 5. Contracts

### 5.1 Loader (AC2, AC8, AC17)
```ts
type ContentSource =
  | { kind: 'bundled'; contentId: string }
  | { kind: 'url'; url: string };            // raw ?src value, checked by src-policy

interface LoadedContent {
  source: 'bundled' | 'url';
  document: ContentDocument;                  // validated, as written in the file
  metadata: ContentMetadata;                  // { contentId, fingerprint, schemaVersion }
}
type LoadResult = { ok: true; content: LoadedContent } | { ok: false; error: ContentError };

interface ContentLoader {
  load(source: ContentSource, options?: { signal?: AbortSignal }): Promise<LoadResult>; // never rejects
  readonly capabilities: { readonly versionLookup: false };  // AC17: declared, not implemented
}
```

### 5.2 `ContentError` (AC3, AC4, AC5)
| `kind` | Fields | Category | Screen |
|---|---|---|---|
| `network` | | fetch (retry) | Can't load: network |
| `http` | `status` | fetch (retry) | Can't load: HTTP n |
| `timeout` | `seconds` | fetch (retry) | Loading took too long |
| `too-large` | `maxBytes` | refused | This file can't be opened |
| `src-not-allowed` | `origin` (truncated) | refused | Can't be opened here (6.4) |
| `src-invalid` | | refused | This link isn't valid (6.4) |
| `invalid-json` | | refused | This file can't be opened |
| `invalid-content` | `path`, `code`, `detail` | refused | This file can't be opened |
| `schema-version-missing` | | refused | This file can't be opened |
| `schema-version-invalid` | | refused | This file can't be opened |
| `schema-version-unsupported` | `version`, `min`, `max` | refused | needs a newer app (`version > max`) / old format (`< min`) |
| `crypto-unavailable` | | refused | Can't be opened here, Details "Needs HTTPS" (6.4) |
| `not-found` | `contentId` | (router normally catches it first) | Book not found |
| `aborted` | | internal, never shown | |

`schemaVersion` is valid only as an integer `>= 1`: missing key ->
`schema-version-missing`; `"1"`, `1.5`, `0`, `-1`, `null` -> `-invalid`.

### 5.3 Comparison (AC15-AC17)
```ts
type CompareResult = 'match' | 'different-content' | 'different-version' | 'unsupported-schema';
type Outcome = 'none' | 'warn' | 'block';
compareContent(local: ContentMetadata, leader: unknown, supported?): { result: CompareResult; outcome: Outcome };
```
Order: leader metadata invalid (not an object, bad ID, fingerprint not 64 hex,
version not a positive integer) -> `unsupported-schema`/`block` (P6);
leader version outside range -> `unsupported-schema`/`block`; IDs differ ->
`different-content`/`block` (P6); fingerprints differ -> `different-version`/`warn`;
else `match`/`none`. Pure; no I/O.

### 5.4 Routes (AC24-AC29, AC37, AC40)
`resolveEntry` (first rule that applies):
1. `entry=single-book` -> `reading(bundled READER_BOOK)` whatever the path or query.
2. `pathname=/library`: library on -> `library`; off -> continue as `/` (server returns 404 first; this is a defensive dev fallback).
3. More than one of `book`/`src`, or a repeated one (`?book=a&book=b`) -> `invalid-link` (AC37).
4. `book` present -> known ID -> `reading(bundled)`; else `book-not-found(id)` (also empty or malformed ID), in every mode (AC28).
5. `src` present -> `reading(url)` (policy check inside the loader).
6. No parameter -> `library` (entry `library`) / `no-book` (entry `error`) / `reading(bundled READER_BOOK)` (entry `default-book`) (AC27, AC40).

Every non-reading screen gets `libraryLink: config.library === 'on'` (AC28, AC31).

### 5.5 URLs and server responses
| Request | Response |
|---|---|
| `GET /`, `/?book=...`, `/?src=...` | 200 `index.html` with injected config |
| `GET /library` | 200 `index.html` if library on, else 404 |
| `GET /assets/<hashed>` | 200, immutable cache |
| `GET /health` | 200 `ok` (Docker healthcheck) |
| other path | 404 `text/plain` |
| other method | 405, `Allow: GET, HEAD` |

Injected config (public, never secret):
```json
{ "entry": "library", "book": null, "library": "on", "uiLang": "auto",
  "srcOrigins": [], "fetchTimeoutSeconds": 15, "srcMaxBytes": 5242880 }
```

### 5.6 Content schema
As in ADR 0004 (written into `apps/reader/README.md` with the limits table,
an example file, the version-range policy, the fingerprint algorithm, the
direction rules and the bidi authoring note).

No HTTP API or realtime message changes; the sync server is untouched.

## 6. UI notes for the engineer

### 6.1 Direction scopes
`<html lang={ui} dir={uiDir}>`; `<article dir={docDir} lang={doc.lang}>`;
each block element carries its effective `dir` (always explicit) and `lang`
when known. Titles inside chrome use `<bdi dir lang>`.

### 6.2 Navigation mapping
Exactly design.md section 5; one table-driven test covers every row for both
directions.

### 6.3 Removed from design.md by later decisions
`NoticeBar` (unknown book now always shows "Book not found") and the empty
library state (now a config error, AC41) are not built.

### 6.4 Status screens not drawn in design.md (proposed copy, designer to check in QA)
| Screen | Heading | Body | Action | Details |
|---|---|---|---|---|
| Invalid link (AC37) | "This link isn't valid" | "It names more than one text to open." | Go to library (if on) | `Use either ?book or ?src, not both.` |
| `src-invalid` | "This link isn't valid" | "The address of the text is not valid." | Back to library (if on) | `Reason: invalid address` |
| `src-not-allowed` | "This text can't be opened here" | "This app only opens texts from approved sources." | Back to library (if on) | `Source: <origin, 40 chars>` |
| `too-large` | "This file can't be opened" | "It is larger than this app accepts." | Back to library (if on) | `Larger than 5 MB.` |
| `crypto-unavailable` | "This text can't be opened here" | "This app needs a secure (HTTPS) connection." | none | `Web Crypto unavailable` |
| Not configured (missing/invalid injected config) | "This app isn't set up" | "Ask the person who runs it to check its settings." | none | none |

Fetch failures get **Try again** plus **Back to library** when on (AC31).
Refused files get **Back to library** when on, nothing otherwise.

## 7. Data model / Docker / Docs impact

- **Data model changes:** none. No database.
- **Docker impact:** new image `apps/reader/Dockerfile`, new compose service
  `reader` on `127.0.0.1:8081`. `.dockerignore` already excludes docs, `.env*`
  and `config/`; `apps/reader/content/` is included (needed by the build).
  Check: `docker compose config` and `docker compose build reader`.
- **Docs impact:** `apps/reader/README.md` (new: run, config table with every
  env variable, default and example, content schema v1 with limits and an
  example, schema-version policy, fingerprint algorithm and canonicalisation,
  direction rules, bidi authoring note, `?src` policy and CORS requirement,
  HTTPS requirement, adding a bundled book), root `README.md` (workspace table,
  reading-app section, compose), `docs/conventions.md` (new),
  `docs/decisions/0001-0006` (accepted). `docs/roadmap.md` is updated by the pm
  on merge.

## 8. Test plan

Runner: Vitest (jsdom default, node for fingerprint/server/plugin files),
Testing Library (`getByRole`, `fireEvent`); no new test dependency. Visual
bidi rendering is checked manually (section 8.2); jsdom does not lay out text.

### 8.1 Automated, by AC
| AC | Test file | What |
|---|---|---|
| AC1, AC32, AC23 | `content-schema.test.ts`, `content-id.test.ts` | valid v1 file; strict unknown fields (incl. own `__proto__` key); zero-block page -> `invalid-content` `Page n: has no blocks`; IDs valid (`acme/psalms-he`, `a/b`, `acme/<lowercase uuid>`, 64/128 caps) and invalid (no slash, uppercase, `_`, space, `..`, edge `-`, 65/129 chars, empty parts, two slashes, uppercase UUID) with the specific reason |
| AC2 | `loader.test.ts` | bundled and URL (fake `fetch`) give deep-equal `LoadedContent` shape and identical metadata for the same file |
| AC3, AC16 | `parse.test.ts`, `screens.test.tsx` | missing, `"1"`, `1.5`, `0`, `2` (too new), range `[2,3]` with `1` (too old): typed error, nothing from the file rendered (no title, no page) |
| AC4 | `parse.test.ts`, `reading-screen.test.tsx` | invalid JSON, wrong types, missing pages, `dir: "rlt"`, non-object root; text `<img src=x onerror=alert(1)>` and `<script>` render as literal text (no element created) |
| AC5, AC34 | `fetch-text.test.ts`, `screens.test.tsx` | network error, 404, 500, timeout (fake timers; default 15 s, override 3 s), Content-Length over cap, streamed over cap, invalid UTF-8; error screen shown, Try again re-runs the load |
| AC6, AC7 | `fingerprint.node.test.ts`, `canonical-json.test.ts` | known vector (fixed file -> fixed hex, also written in the README); reformatted and key-reordered file -> same; change of text, `dir`, page order, schema version, `title`, `lang`, `type` -> different; NFC vs NFD text -> different (E1); RFC 8785 sample vectors for strings/escapes |
| AC8 | `metadata.test.ts` | exact keys `contentId`, `fingerprint`, `schemaVersion`; plain JSON object; typed as `JsonObject` from `@sync-system/react` (type test) |
| AC10, AC11 | `direction.test.ts` | inheritance block > page > doc > `ltr`; `auto` with Hebrew, Arabic, English, mixed-starting-with-each, digits/punctuation only, empty, LRM/RLM first, isolate-wrapped first word |
| AC12 | `direction-scopes.test.tsx` | 4 combinations (UI en/he x content en/he): `<html dir>`, `<article dir>`, title `<bdi dir>`, block `dir`, Next button side |
| AC13 | `input-map.test.ts`, `swipe.test.ts`, `page-nav.test.tsx` | every row of design.md section 5 in both directions; page direction differing from document direction does not change mapping; ends do nothing; Shift+Arrow and input focus ignored |
| AC14, AC20 | `mixed-content.test.tsx` | render `mixed-he-en` and `mixed-en-he`: each block's `dir`, `text-align: start` class, auto block results; samples validate |
| AC15, AC17 | `compare.test.ts` | the four results, outcomes, malformed leader metadata, `loader.capabilities.versionLookup === false` |
| AC18 | `plain-text.test.tsx` + ESLint rule | display-name-like markup renders as text; lint fails on `dangerouslySetInnerHTML` (a lint fixture test via ESLint API) |
| AC19 | `boundaries.test.ts` + ESLint | no import of `@sync-system/server`/`protocol`/`client` or relative paths into `packages/` in `src` (scan) |
| AC21 | CI | `pnpm lint typecheck test build` |
| AC22 | `readme.test.ts` | README contains schema, version policy, fingerprint, direction sections and every env variable name (pattern: `packages/react/test/readme.test.ts`) |
| AC24, AC36 | `reading-screen.test.tsx` | no link to `/library` or any `<a>` in the reading screen, in all modes |
| AC25, AC37 | `resolve-entry.test.ts` | `?book`, `?src`, both, repeated, empty values |
| AC26, AC39 | `library-screen.test.tsx` | rows link to `/?book=<id>`; title isolation and `lang`; fallback to ID; language line; collator order |
| AC27, AC40 | `resolve-entry.test.ts` | no parameter in each mode -> library / no-book / default book; library never shown in error/default modes |
| AC28 | `resolve-entry.test.ts`, `screens.test.tsx` | unknown book in all 3 modes x library on/off: "Book not found", link only when on, never the default book |
| AC29 | `resolve-entry.test.ts`, `config.test.ts` | single-book ignores `?book`, `?src`, both, and `/library`; library forced off |
| AC30, AC41 | `config.test.ts`, `server-run.node.test.ts`, `library-plugin.node.test.ts` | each rule of the 0005 table (bad value, missing/unknown/stray `READER_BOOK`, library/entry conflicts, zero books with library on, bad origins, bad numbers); server `run()` returns exit 1 with `Config error:`; dev plugin start fails |
| AC31 | `screens.test.tsx` | refused and fetch-failure screens with library on/off: links/buttons present or absent |
| AC33 | `content-block.test.tsx` | `\n` kept in text node, `pre-line` class, `\r\n` normalised; title line breaks collapsed |
| AC35 | `use-page-navigation.test.tsx` | remount starts at page 1; nothing written to storage |
| AC38 | `library-plugin.node.test.ts` | `buildLibraryIndex(test/fixtures/library-invalid)` throws naming the file and reason; ID/path mismatch and duplicate ID throw; valid dir yields the expected entries |
| 0006 | `src-policy.test.ts`, `server-handler.node.test.ts` | origin exact match, `http:` only for loopback, credentials, `javascript:`/`data:` refused, empty list disables; CSP contains the origins; headers on every response; 404/405; `/library` 404 when off; injected JSON escapes `</script>` |

### 8.2 Manual verification (QA)
- `pnpm --filter @sync-system/reader dev` and `docker compose up reader`:
  open each sample in Chrome/Firefox (and Safari if available), LTR and Hebrew
  UI (`READER_UI_LANG=he`): alignment, punctuation at block ends, poems, nav
  mirroring, swipe on a phone or devtools touch emulation, 200 % zoom, dark
  mode, reduced motion, VoiceOver/NVDA page announcement.
- Bad env (`READER_ENTRY=x`) -> container exits 1 with a clear message.
- `?src` against a local CORS-enabled file server listed in
  `READER_SRC_ORIGINS` (`http://localhost:<port>`).
- Response headers in devtools; no CSP violations in the console.

## 9. Risks and edge cases

- **Web Crypto in tests**: `crypto.subtle.digest` in jsdom may reject a
  `Uint8Array` from jsdom's realm. Fingerprint tests run in the node
  environment; component tests inject a loader or a `subtle` stub.
- **Secure context**: `crypto.subtle` is undefined over plain HTTP on a
  non-localhost host; self-hosters on a LAN IP over HTTP get
  `crypto-unavailable`. Documented prominently.
- **Vite 8 JSX/oxc options** differ from Vite 5-7 (`esbuild`): use the Vite 8
  option names; verify the build emits no inline script (CSP) by a test that
  scans `dist/index.html`.
- **zod JIT and CSP**: without `jitless`, zod probes `new Function` and the
  browser logs a CSP violation. P7 sets it before any schema is built
  (schemas are built lazily or after `z.config`).
- **First-strong detection** is a code-point-range approximation of the
  Unicode bidi classes; documented, tests cover the scripts we support.
- **`?src` CORS**: most content hosts need `Access-Control-Allow-Origin`; the
  README says so, and the error is `network` (browsers hide CORS details).
- **`redirect: 'error'`** breaks hosts that redirect (e.g. short links); the
  operator lists the final origin.
- **Large bundled books** load lazily per book, but each still parses and
  hashes on the main thread; the 20k-char/1000-block/5000-page limits bound it.
- **Duplicate JSON keys** silently resolve to the last value before hashing
  (documented, 0004).
- **`?book=` with `/`**: IDs contain `/`; links use `encodeURIComponent`, and
  `URLSearchParams` decodes either form.
- **Item 8 coupling**: header end slot, overlay layer and `goTo(i)` are left
  in place; no sync code in item 7.

## 10. Security-sensitive areas

Security-sensitive: yes

- **Untrusted input / fetched content**: `?src` fetching (`src/content/src-policy.ts`,
  `fetch-text.ts`, `loader.ts`): origin allow-list, redirects, credentials,
  size cap, timeout, UTF-8 decoding; JSON parsing and strict validation
  (`parse.ts`, `schema.ts`); prototype keys (`__proto__`).
- **Rendering of untrusted text** (XSS): content, URL-derived values in
  Details, titles, future display names (AC18): `PlainText`, ESLint bans on
  HTML sinks, config injection escaping in `server/html.ts`.
- **New HTTP server** (`server/*`): path handling (in-memory allow-list),
  methods, security headers and CSP, no request logging (query strings hold
  URLs), startup config validation.
- **Configuration**: `READER_SRC_ORIGINS` parsing; the injected config is
  public by design (no secrets in it, ever).
- **Dependencies**: new direct `vite` (dev), `react`/`react-dom`/`zod` in a new
  package (already in the lockfile), `@sync-system/react` (workspace).
- **Docker**: new image (non-root, pinned base, loopback-only compose port).

## 11. Implementer model

Implementer model: opus
Reason: security-sensitive (untrusted fetched content, new HTTP server, CSP), six ADRs, new app with ~60 files and new dependencies.

## 12. Gate 2 questions (recommendation first)

- **Q1. ADRs 0001-0006**: choose each (section 2).
- **Q2. AC32-AC35** (orchestrator recommendations): keep zero-block pages
  invalid, line breaks preserved, 15 s timeout, no position across reload.
  The plan assumes all four.
- **Q3. `different-content` outcome**: `block` (recommended; following a
  position in another text is meaningless) or `warn`.
- **Q4. Malformed leader metadata**: treat as `unsupported-schema` / `block`
  (recommended) or as `different-content`.
- **Q5. New status screens** (section 6.4): accept the proposed copy, or send
  them to the designer first.
- **Q6. Sample texts**: public-domain Psalms (Hebrew), Pride and Prejudice
  excerpt (English), and project-written mixed samples. Confirm, or supply
  texts.

## 13. Implementation chunks

All in this repo, branch `feat/19-reading-app-content`. Tests ship in the
same commit as the code they cover.

1. `docs(adr): accept 0001-0006 reading app decisions` (ADRs -> `Accepted`
   with the user's Gate 2 choices, `docs/conventions.md` created)
2. `build(reader): scaffold reading app package` (package.json, tsconfigs,
   vite/vitest config, `index.html`, empty `App`, ESLint block, lockfile,
   test setup)
3. `feat(reader): add content schema v1 and content id validation`
4. `feat(reader): add canonical json and sha-256 fingerprint`
5. `feat(reader): add direction resolution with first-strong detection`
6. `feat(reader): add content comparison and group metadata`
7. `feat(reader): add content loader with src policy and capped fetch`
8. `feat(reader): add sample content and build-time library index`
9. `feat(reader): add reader config parsing and entry resolution`
10. `feat(reader): add design tokens, interface messages and status screens`
11. `feat(reader): add reading screen with mirrored page navigation`
12. `feat(reader): add library screen and app routing`
13. `feat(reader): add static server with config injection and security headers`
14. `build(reader): add docker image and compose service`
15. `docs(reader): document content schema, fingerprint, direction and config`
