# Security review (plan): #19 reading app content, RTL and fingerprint

- Mode: plan, round 1
- Reviewed: [`architecture.md`](architecture.md) (at `f6f0ea2`), ADRs
  [0001](../../decisions/0001-reading-app-framework.md)-[0006](../../decisions/0006-fetched-content-policy.md)
  (all Proposed), [`spec.md`](spec.md), existing `compose.yaml`,
  `.dockerignore`, `apps/sync-server/Dockerfile`
- **Verdict: PASS.** No critical or high findings. The plan already makes the
  safe choices (no server-side fetch, `?src` off by default with an exact-origin
  allow-list, strict schema, text-only rendering, strict CSP, in-memory file
  map). The required controls in section 4 close the gaps that the plan leaves
  open, and they become part of the plan.

## 1. Assets and trust boundaries

| Asset | Why it matters |
|---|---|
| Reader's browser session on the reader origin | XSS here can read the URL, later (item 8) the sync token and group state, and act as the reader |
| Trust in the deployment's name | A reading app that renders whatever a link points at is a phishing/defacement vehicle |
| Reader privacy | IP and timing leak to any host the browser fetches from |
| Reader server availability | One small public `node:http` process |
| Content identity (fingerprint) | Used by item 8 to warn/block on mismatch; not an authenticity proof |

Trust boundaries:

1. **URL query** (`?book`, `?src`) -> client router: attacker-controlled (anyone can craft a link).
2. **Fetched content** (`?src`) -> parser/validator/renderer: untrusted bytes from an allow-listed but third-party host.
3. **Operator env** -> server -> injected HTML config -> client: trusted operator, but the injection is an HTML-context sink.
4. **HTTP requests** -> reader server: anonymous internet.
5. **Leader metadata / display names** (item 8, from other users via the sync service) -> `compareContent` / `PlainText`: untrusted.
6. **Bundled content** -> build: repo-controlled, validated at build (AC38).

## 2. Threats (STRIDE, brief)

| # | Who | Can try to | Against | Plan's answer |
|---|---|---|---|---|
| S | Link author | Make the app show their text under the deployment's name | Readers | Allow-list, off by default (0006 option 1) |
| T | Content host / MITM on `http:` | Serve hostile JSON (markup, huge, deep, odd Unicode) | Renderer, tab | Strict schema, text nodes, byte cap, `https:` only except loopback |
| R | n/a | (no accounts, no state changes) | | |
| I | Link author | Learn reader IP/timing via `?src` to their host; reach LAN hosts from the reader's browser | Readers | Allow-list + CSP `connect-src`; `no-referrer`; `credentials: 'omit'` |
| D | Anyone | Crash or stall the server with a malformed request; freeze the tab with huge/deep content | Server, reader | In-memory map, limits, cap; **gap: request-parsing errors (F1)** |
| E | Link author / content author / other group member | Script execution via content, URL values, config injection, display names | Reader origin | `PlainText`, ESLint sink bans, JSON escaping, CSP without inline/eval |

## 3. Findings in the plan

Blocking: none. All findings are advisory, but F1-F6 come with a required
control in section 4 because the code would be High or Medium if built as
written.

| # | Severity | Location | Issue (attack scenario) | Fix |
|---|---|---|---|---|
| F1 | Medium | architecture.md 4 `server/handler.ts` ("matched on the decoded `pathname`") | `decodeURIComponent` throws `URIError` on `GET /%E0%A4%A`, and `new URL(req.url, base)` throws on some absolute-form targets (`GET http://[ HTTP/1.1`). A sync throw inside a `node:http` request listener is an uncaught exception: one anonymous request kills the process (restart loop if hit repeatedly). | C1: wrap parsing and the whole handler in `try/catch`; malformed target -> 400 `text/plain` with the security headers; any other error -> 500 without details. Add a `server.on('clientError')` handler that ends the socket with 400. Test both. |
| F2 | Medium | 0006 option 1, `src-policy.ts`, `server/headers.ts` | `READER_SRC_ORIGINS` is copied into the CSP header and into HTML. If entries are compared or emitted as raw strings, a value like `https://a.example; script-src *` or `https://a.example/` would weaken the CSP (header-injection of directives) or fail to match. On the client, comparing `?src` by string prefix, or resolving it against the page URL, opens `https://a.example.evil.net`, `https://a.example@evil.net`, `\`-tricks and relative URLs. | C2: parse each entry with `new URL`, require `entry === url.origin` (canonical, no trailing slash, no path/query/fragment/userinfo, no `*`, no `null` origin), reject anything else at startup; emit only the re-serialised origins. Parse `?src` with `new URL(raw)` **without a base** (relative values are `src-invalid`), refuse `username`/`password`, compare `url.origin` with `===` against the set, and pass `url.href` (not the raw string) to `fetch`. |
| F3 | Medium | 0006 limits, `fetch-text.ts` | A gzip-encoded body has a small `Content-Length` and a large decoded size; if the cap is only the header pre-check, or if the code falls back to `response.text()`/`.json()` when `response.body` is `null`, a 5 MiB cap becomes unbounded (tab OOM). If the timeout signal is only used for headers, a slow-drip body hangs forever. | C3: the cap counts decoded bytes read from `response.body.getReader()`; on overflow `reader.cancel()` and abort; `body === null` -> treat as empty text (never `text()`); the same combined signal covers the body read. Tests: lying/absent `Content-Length`, chunked over cap, slow body past the timeout. |
| F4 | Medium | architecture.md P2 / `parse.ts` (version gate before validation) | The gate reads `schemaVersion` from an unvalidated object. Using `in`, `obj.schemaVersion` on a non-plain object, or any spread/`Object.assign` of the parsed value before zod would let a file with a `"__proto__"` key or inherited properties affect the gate or (in later code) pollute prototypes. | C4: root must be `typeof === 'object'`, not `null`, not an array, `Object.getPrototypeOf(v) === Object.prototype`; read the version with `Object.hasOwn`; never spread, merge or copy parsed content or leader metadata before strict validation; canonicalise only the validated value. Keep the planned `__proto__` / `constructor` / `prototype` key tests (they must be rejected as unknown fields). |
| F5 | Medium | 0005 E1, `server/html.ts` | The config block is an HTML-context sink. The plan escapes correctly (`<`, `>`, `&`, U+2028/2029), but ADR 0005 E1 says "`<` is escaped as `<`" (lost escape), which an implementer could read as HTML-entity escaping; entities are **not** decoded inside `<script>`, so that breaks JSON, and skipping escaping lets an env value containing `</script><script>` inject markup. `publicConfig` must also never include values the client doesn't need. | C5: escape as JSON `<`, `>`, `&`, ` `, ` ` after `JSON.stringify`; `publicConfig` builds a new object from an explicit field list (no spread of env or of the config object); test that `</script><!--` in a value round-trips and that an unrelated env var (e.g. `TOKEN_SECRET=x`) never appears in the HTML. Fix the ADR wording when it is accepted. |
| F6 | Medium | architecture.md 5.4 rule 4, 6.4 (`src-not-allowed` details), `?book` not-found | Attacker-chosen strings from the URL (the `?book` value, the `?src` origin) are shown on status screens of a trusted app ("Book not found: call-+1-555-support-now"). Content spoofing only, no script, because text is rendered as text. | C6: render URL-derived values only through `PlainText`, truncated (plan: 40 chars), inside `<bdi>`; show the `?book` value only if it matches the content-ID pattern, else a generic "This link isn't valid"; never turn `?src` or any URL-derived value into a link (`href`/`src`). |
| F7 | Low | 0004 B1 regex, `resolve-entry.ts` | The content-ID regex is linear (anchored, bounded quantifiers, a single `.*` lookahead), so no ReDoS, but it also runs on raw `?book` values of any length. | Check `length <= 193` before running the regex on any input. |
| F8 | Low | 0004 D1, E1 | Lone surrogates (`"\ud800"`) are accepted by `JSON.parse`; RFC 8785 requires I-JSON (no lone surrogates). They do not collide (`JSON.stringify` escapes them) but are an interop edge for other implementations of the fingerprint. The fingerprint is integrity-for-consistency, not authenticity: a hostile leader can announce any fingerprint. | Reject strings with lone surrogates (`!str.isWellFormed()`) as `invalid-content`; state in the README that the fingerprint is not a signature and must never gate access. |
| F9 | Low | 0006 option 1 (`http:` for loopback) | An operator who leaves `http://localhost:3000` in production lets any link make readers' browsers call that port on **their own** machine (CORS still required, no credentials). | Log a startup warning when a loopback origin is configured with `NODE_ENV=production`; document "dev only" in the config table. |
| F10 | Low | 0006 headers, compose | No `Strict-Transport-Security` (TLS is terminated by the operator's proxy), no Trusted Types. | Document HSTS at the proxy in the README; optionally add `require-trusted-types-for 'script'` to the CSP (React 19 does not use sinks covered by it in this app) as hardening, after checking it causes no console violations. |
| F11 | Low | compose `reader` service | Hardening options not listed. | Add `read_only: true`, `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`, `restart: unless-stopped` (like `sync-server`); runtime image `USER node` with root-owned files as in the sync-server Dockerfile. |
| F12 | Low | `READER_SRC_MAX_BYTES` upper bound 50 MiB | A 50 MiB JSON parsed, validated and hashed on the main thread can freeze a phone's tab. Self-inflicted by the operator. | Keep default 5 MiB; document the trade-off next to the variable. |

### How other ADR options would change the risk

- **0006 option 2 (any HTTPS origin):** every deployment becomes a renderer for
  anyone's text under its name, readers' browsers contact attacker-chosen hosts
  (tracking), and intranet HTTPS hosts with permissive CORS become reachable;
  CSP `connect-src` would have to be `https:`. Rated **Medium** (no
  exfiltration path, content is still text-only), and would need a follow-up
  review plus an explicit user acceptance. Option 3 (same origin) is the
  lowest risk.
- **0006, if the server ever proxies `?src`:** that is real SSRF and needs a
  new plan review (private/loopback/link-local IP blocking after DNS
  resolution, rebinding protection, no redirects, response caps). The plan
  correctly keeps all fetching in the browser; required control C8 keeps it so.
- **0001 option 2 (Next.js):** SSR adds server-side rendering of untrusted
  content, server actions and a large dependency tree; would need a new review.
  Option 3 (nginx + `VITE_*`): build-time variables end up in the public
  bundle; anyone putting a secret in a `VITE_*` var leaks it.
- **0005 E2 (`/config.json`):** same exposure as E1, no injection sink; a fine
  alternative. **E3 (`VITE_*`):** see above.
- **0004 C2 (lenient schema):** unknown fields would flow through; with no
  merge/spread (C4) still safe, but loses the `__proto__`-as-error guarantee.
- **0004 E2 (NFC):** no security impact.

## 4. Required controls (part of the plan)

The engineer implements these; code-mode review checks each one.

- **C1 Server robustness.** Top-level `try/catch` in the request handler;
  malformed URL or percent-encoding -> 400; unexpected error -> 500 with a fixed
  body; `clientError` handler; never echo the path, query or headers in any
  response or log. Security headers on **every** response (200, 304, 400, 404,
  405, 500, `/health`).
- **C2 Origin handling.** As F2: canonical-origin validation of
  `READER_SRC_ORIGINS` at startup (error names the variable, as 0005), CSP
  built only from re-serialised origins, `?src` parsed without a base, exact
  `url.origin` set membership, `url.href` passed to `fetch`, `http:`/`https:`
  only, `http:` only for `localhost`/`127.0.0.1`/`[::1]`, empty list = disabled.
- **C3 Fetch.** Exactly the 0006 request options (`credentials: 'omit'`,
  `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`,
  `mode: 'cors'`); streamed decoded-byte cap with cancel; no `text()`/`json()`;
  fatal UTF-8 decode; one signal for headers and body.
- **C4 Untrusted JSON.** Plain-object root, `Object.hasOwn` version gate,
  `z.strictObject` at every level, no spread/merge before validation, canonical
  JSON only on validated data, same for `parseLeaderMetadata`.
- **C5 Config injection.** `<`/`>`/`&`/` `/` `
  escaping, explicit-field `publicConfig`, client re-validates with zod and
  shows "app isn't set up" on failure. No secret is ever added to the reader's
  env or config.
- **C6 Rendering.** All external strings (content, titles, URL values, error
  details, later display names AC18) only as React text children via
  `PlainText`; ESLint bans `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write` as planned; no URL-derived value in
  `href`/`src`; library links only `/?book=${encodeURIComponent(id)}` for
  validated IDs.
- **C7 CSP stays strict.** The production CSP in 0006 unchanged (no
  `'unsafe-inline'`, no `'unsafe-eval'`, no `data:`/`blob:`); zod `jitless`
  before any schema is built; `assetsInlineLimit: 0`; no modulepreload
  polyfill; test that `dist/index.html` has no inline `<script>` (except the
  `type="application/json"` config block) and no inline `style`/`on*`
  attributes; manual QA confirms zero CSP violations in the console.
- **C8 No server-side fetching.** The reader server never fetches `?src` or
  any URL. Any future proxy needs a new security plan review.
- **C9 No request logging, no secrets.** Server logs nothing per request
  (query strings carry URLs); config errors print only the offending reader
  variable; no `.env`, no config files in the image (`.dockerignore` already
  covers them).
- **C10 Docker.** Same pinned `node:24-alpine` digest, multi-stage,
  `pnpm deploy --prod`, runtime files root-owned, `USER node`, `HEALTHCHECK`,
  compose port `127.0.0.1:8081:8080` only; no source maps in `dist/` (Vite
  default `build.sourcemap: false`).
- **C11 Dependencies.** Only the deps listed in architecture.md 4; `vite` dev
  only and never in the runtime image or `CMD`; dev server keeps the default
  `server.host` (localhost); `pnpm audit --audit-level=high` clean.

## 5. What code mode will check

- gitleaks over the PR commits; semgrep on changed files; `pnpm audit`.
- C1-C11 above, file by file: `server/handler.ts`, `server/html.ts`,
  `server/headers.ts`, `server/static-files.ts`, `server/run.ts`,
  `src/content/src-policy.ts`, `fetch-text.ts`, `parse.ts`, `schema.ts`,
  `canonical-json.ts`, `metadata.ts`, `compare.ts`, `src/config/schema.ts`,
  `src/app/resolve-entry.ts`, `components/PlainText.tsx`, status screens,
  `eslint.config.js`, `Dockerfile`, `compose.yaml`, `vite.config.ts`.
- Tests exist for: malformed request target (400, process alive), CSP and
  headers on every status, CSP built from canonical origins and a rejected
  injection-style origin, `?src` bypass attempts (prefix/suffix hosts,
  userinfo, backslash, relative, `javascript:`/`data:`/`blob:`/`file:`,
  default-port forms, IDN), gzip/lying `Content-Length`/slow body,
  `__proto__` content and leader metadata, `</script>` in injected config,
  unrelated env var absent from HTML, markup in content and URL values renders
  as text.
- Built `dist/index.html` and response headers match the 0006 CSP.
- F7-F12 advisories: noted as fixed or still open in the code review.
