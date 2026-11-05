# 0006. Fetched content (`?src=<url>`): origin policy, limits and headers

- Status: Proposed
- Date: 2026-11-05
- Issue: #19

## Context

`?src=<url>` makes the reader's browser fetch a JSON file named by whoever
wrote the link (AC25). That file is untrusted input (AC4, PRD future work on
uploads). Risks: a link that points readers at arbitrary or hostile content
under this deployment's name (phishing-like misuse of a trusted reading app);
tracking (the third-party host sees each reader's IP and timing); the browser
reaching hosts on the reader's local network (the fetch is client-side, so
this is not server-side SSRF, but a link can still aim at `http://192.168.x`);
oversized or deeply nested files (memory, freezes); script injection through
text. Fetch failures must give typed errors (AC5) and a 15 s default timeout
(AC34).

## Options

1. **Allow-list of origins in config, `?src` disabled by default
   (recommended).** `READER_SRC_ORIGINS=https://content.example.org,https://cdn.example.net`.
   Each entry must be an exact origin (`scheme://host[:port]`, no path, query,
   credentials or wildcard); `https:` only, `http:` only for `localhost`,
   `127.0.0.1`, `[::1]` (dev). A `?src` URL is parsed with WHATWG `URL`;
   its origin must equal an entry exactly; URLs with credentials or a scheme
   other than `http(s)` are refused. Empty or unset: every `?src` link shows
   "can't be opened here". The same list feeds the CSP `connect-src`, so the
   browser enforces it as well.
2. Any HTTPS origin. Maximum flexibility for future uploads, but every
   deployment becomes a renderer for anyone's content under its name, and
   readers' browsers contact arbitrary hosts.
3. Same origin only. Safe, but then `?src` is just a second way to load
   files the operator already hosts.

Content limits (with option 1 or 2):

- Byte cap `READER_SRC_MAX_BYTES` (default 5 MiB): `Content-Length` above the
  cap is refused before reading; the body is read as a stream and aborted
  once the cap is passed (servers can lie or omit the header).
- Strict decoding: `TextDecoder('utf-8', { fatal: true })` (a leading BOM is
  dropped); invalid UTF-8 is `invalid-json`.
- Structural limits from the schema (0004): pages, blocks, text lengths. JSON
  nesting is bounded by the strict schema, and the byte cap bounds
  `JSON.parse` work.
- Request: `credentials: 'omit'`, `redirect: 'error'` (a redirect cannot
  leave the allowed origin), `referrerPolicy: 'no-referrer'`,
  `cache: 'no-store'`, `mode: 'cors'`; timeout via `AbortSignal.timeout`
  (`READER_FETCH_TIMEOUT_SECONDS`, default 15). The content host must send
  `Access-Control-Allow-Origin` for the reader's origin (documented). The
  `Content-Type` is not checked (raw file hosts often send `text/plain`).

Response headers from the reader server (all responses):
`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' <READER_SRC_ORIGINS>; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()` (item 8 will
need `camera=(self)` for QR scanning). zod runs with `jitless: true` in the
app so validation never needs `'unsafe-eval'`.

## Decision

Option 1 with the limits and headers above. Text from content (and later
from the sync service, AC18) is rendered only as React text nodes; ESLint
forbids `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML` and
`insertAdjacentHTML` in the app.

## Consequences

- Operators who want `?src` must list each content host; an allow-list
  change is a container restart (no rebuild).
- Future uploads (PRD future work) fit by adding the upload store's origin.
- A wildcard or "any HTTPS" mode can be added later by a new ADR if a
  deployment needs it.
- Readers on a disallowed link see a fixed status screen; nothing is fetched.
