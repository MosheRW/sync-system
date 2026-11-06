# Security review (plan): #24 reading app sync UX: join and follow (8a)

- Mode: plan, round 1
- Reviewed: [`architecture.md`](architecture.md) (at `64e2b98`),
  [`spec.md`](spec.md), [`design.md`](design.md), ADRs
  [0007](../../decisions/0007-qr-code-rendering-library.md),
  [0008](../../decisions/0008-end-to-end-browser-tests.md),
  [0009](../../decisions/0009-reader-group-session-storage.md) (Proposed),
  [0006](../../decisions/0006-fetched-content-policy.md) (Accepted),
  [`#19 security.md`](../19/security.md) (C1-C11), the earlier server reviews
  (`docs/issues/1/security.md`, `docs/issues/10/security.md`), and the code
  the plan touches: `apps/reader/server/headers.ts`,
  `apps/reader/src/content/origin.ts`, `apps/reader/src/config/schema.ts`,
  `apps/sync-server/src/config/dev-key.ts`,
  `apps/sync-server/src/limits/constants.ts`, `config/apps.*.json`,
  `compose.yaml`, `.github/workflows/ci.yml`,
  `packages/client` (token storage, removal, logging),
  `packages/protocol/src/join.ts`.
- **Verdict: PASS.** No critical or high findings. The plan makes the safe
  choices in every sensitive area: tokens per tab in `sessionStorage`, the
  QR ticket only in the fragment and stripped first, a strict and exact
  position decoder, leader metadata through `parseLeaderMetadata`, text-only
  rendering, no client logger, only `connect-src` widened, and no server
  change. One medium (the public API key, accepted by design, needs
  deployment controls) and ten lows. The required controls in section 4
  become part of the plan.
- The recommended options are the safest or equal-safest in each decision.
  Section 5 lists what changes if the user picks an alternative; one
  alternative (Q-A1 option 2 without its server change) would be **High**.

## 1. Assets and trust boundaries

| Asset | Why it matters |
|---|---|
| Participant tokens (leader token with recovery data) | A current leader's token lets its holder take over the lead, end the group, see codes and approve joiners (client README) |
| QR tickets | Bearer credential: anyone holding one joins the group until it expires (default 300 s) |
| Join codes, door codes | Admit people; shown only to the leader |
| Group ID in the pointer | Not a join capability any more (since #10 joining needs a code or ticket; resume needs a token), but it links a tab to a group |
| Reader API key (`READER_SYNC_API_KEY`) | Public by nature (ships in the page); selects the app's config and limits on the shared sync server |
| Availability of the app's namespace | Per-app budgets (connections, join attempts, door failures) are shared by every reader user |
| Members' screens | A leader moves members' pages; members trust the content check |
| Privacy (users may be minors) | Names, reading position, which group a tab is in |

Trust boundaries:

1. **URL** (`?book`, `?src`, `#t=<ticket>`) -> reader: anyone can craft a link.
2. **Sync server messages** -> reader: authenticated as the app, but the app
   key is public, so other group members (leader metadata, positions, display
   names) are untrusted users.
3. **Operator env** (`READER_SYNC_*`) -> reader server -> CSP header and the
   injected config block: trusted operator, but HTML and header sinks.
4. **Same-origin scripts** -> `sessionStorage`: any XSS on the reader origin
   reads the tokens.
5. **npm registry / Playwright CDN** -> bundle and CI.
6. **Shared device**: the next person using the same browser profile.

## 2. Threats (STRIDE, brief)

| | Who | Can try to | Plan's answer |
|---|---|---|---|
| S | Anyone | Act as "the reader app" with the key from the page source | Accepted by design (#1, #10): keys select config, they are not access control. M1 |
| S | Link author | Make a victim join their group with zero taps (crafted `#t=` link) | Ticket must be valid for a group the attacker leads; impact is a forced join. L3 |
| S | Joiner | Pose as someone the leader trusts in the approval tray | Names are plain text; generated names have no `displayName` in a join request, so a chosen "Guest 3" can't pass as an anonymous request |
| T | Hostile leader | Send malformed positions or metadata to crash or misdirect members | Strict `decodePosition`, `parseLeaderMetadata` (C4), content check before any move |
| T | Operator typo | Inject a CSP directive through `READER_SYNC_URL` | Re-serialised origin, **but `;` and `,` survive `URL.origin`** (verified). L1 |
| R | n/a | No accounts, no audit trail by design | |
| I | Network / history | Read the ticket from history, Referer, logs | Fragment only, `replaceState` before boot, `Referrer-Policy: no-referrer`, fragments are never sent in requests. Residue in global history and camera apps: L2 |
| I | XSS on the origin | Read tokens from `sessionStorage` | Strict CSP (`script-src 'self'`, no inline, no eval), ESLint HTML-sink bans, text-only rendering. Trusted Types still separate: L7 |
| I | Next user of a shared device | Resume the previous person's group | Tokens die with the tab (ADR 0009), except a restored tab. L6 |
| I | Logs | Codes, tickets, tokens, names, positions in console or server logs | No client logger, AC54 test. R9 |
| D | Script with the public key | Use up the app's join, door-failure and connection budgets | Server per-app budgets; no per-IP limits in the app. M1 |
| D | Hostile leader | Flood members with moves | Server leader rate limit (`maxLeaderUpdatesPerSecond`); the reader never queues prompts |
| E | Member | Send positions, see codes, approve | Server role checks; the reader shows codes, QR and tray only while leading (AC13) |

## 3. Findings in the plan

Blocking: none.

| # | Severity | Location | Issue (attack scenario) | Fix |
|---|---|---|---|---|
| M1 | Medium | architecture.md 4.1 (`READER_SYNC_API_KEY`), 10 ("Server changes: none"), spec Q9 | The key is in every page's config block. Anyone can script the sync server as the reader app: hold the app's `maxConnections`, spend the per-app join budget (600/min) and the per-app wrong-door budget (60/min), so real readers get `RATE_LIMITED` or join pauses during a lesson. Same accepted risk as #1 and #10 (no per-IP limits in the app); this issue makes it concrete for the first real browser app. **Q9 confirmed: shipping the key is acceptable** because it is not access control: joining needs a code or ticket, leader actions need a token. | R2: document the key as public (identifies, doesn't authorize); give the reader its own registration in production with tight per-app limits; per-IP connection and message limits at the reverse proxy (already the server README's advice); never reuse a key meant to be private for another client; rotation is a config change and restart of both services (no rebuild). |
| L1 | Low | architecture.md 5.1 ("re-checked and re-serialised ... so a malformed value can never add a directive"); existing `src/content/origin.ts` `checkAllowedOrigin` | WHATWG `URL` keeps `;`, `,` and `'` in hosts: `new URL('wss://a;b/ws').origin === 'wss://a;b'`. Re-serialising alone doesn't stop a value from ending the `connect-src` directive (`;`) or starting a second policy (`,`). Only the operator controls the value and no value without spaces can loosen the policy today, so this is hygiene; the same gap exists for `READER_SRC_ORIGINS`. Also `ws://[::1]:8080` is not a valid CSP host source (no IPv6 literals), so the browser drops it and the socket is blocked (fails closed). | R1: after parsing, require the hostname to match a strict host pattern (`^[a-z0-9-]+(\.[a-z0-9-]+)*$` or a dotted IPv4) before it reaches the CSP; apply the same check in `checkAllowedOrigin`. Reject `[::1]` for `READER_SYNC_URL` (or document that it can't work under CSP). Tests: `wss://a;b`, `wss://a,b`, `wss://a'b`, `wss://*.x`, `wss://u:p@x`, `wss://x/ws?k=1`, `wss://x/ws#f`, `ws://example.com`. |
| L2 | Low | architecture.md 9.1, 15 ("Ticket in history") | `replaceState` cleans the session history entry, but the URL with the ticket can remain in places the page can't reach: the camera app's scan history, the browser's global history / address-bar suggestions on some browsers, and a tab where the user pastes a second `#t=` link (a fragment-only change fires `hashchange`, not a reload, so `main.tsx` intake doesn't run and the ticket stays in the address bar). The ticket is reusable until it expires. | R3: also handle `hashchange` (strip; then treat like a landing or ignore it); keep `qrTicketSeconds` short (README: default 300 s, don't raise it for the reader); leader rotation revokes outstanding tickets (already). The e2e check covers `location.hash` and `history`; global history is out of reach and accepted. |
| L3 | Low | design F5 step 4 ("zero taps"), architecture.md 8.2 / 9.1 | A crafted link `https://reader/?book=x#t=<attacker's ticket>` makes whoever opens it join the attacker's group with no confirmation; the attacker then sees "someone joined" and moves the victim's page (only within a matching book). Also undefined: a ticket landing in a tab that already has a group pointer (both `resuming` and `joining` at once). | Keep zero taps (it's the product requirement); R3 adds an explicit rule: if a pointer is present when a ticket arrives, resume is skipped and the user is asked once ("Leave your current group and join this one?") or the ticket is ignored; never two flows at once, never leave a group silently. The architect picks one; test it. |
| L4 | Low | architecture.md 7.4, design `CodeField`/`NameField` | Browsers save typed form values (autofill history) and some send field text to cloud spell checkers; on a shared device a door code or group code could be suggested to the next user. | R8: code and door-code fields `autocomplete="off"`, `spellcheck={false}`, `autoCorrect="off"`, `autoCapitalize="off"`; submit through a handler with `preventDefault()` (`form-action 'none'` stays as backstop, so a GET submit can never put a code in the URL); clear code fields after admission or leave. |
| L5 | Low | ADR 0008, architecture.md 12 (CI), 13 | Playwright traces, screenshots and videos record URLs with `#t=`, codes on screen and WebSocket frames with tokens. With an ephemeral dev server, dev key and dev token secret these are worthless, but an artifact upload makes them public on a public repo, and the habit carries over. `playwright install --with-deps` runs `apt-get` with sudo on the runner (acceptable on a throwaway GitHub runner). | R11: no artifact upload by default (or only on failure, `retention-days: 3`); e2e uses only the committed dev key and a dev or per-run random `TOKEN_SECRET`; test servers and the TCP proxy bind `127.0.0.1`. |
| L6 | Low | ADR 0009 option 1 | `sessionStorage` dies with the tab, but "reopen closed tab" and browser session restore bring it back; on a shared computer the next user can restore the tab and resume as the previous member or leader while the group lives. | R5: Leave and End remove the token and pointer (client already drops the token on `group.ended` except `replaced`; the reader forgets the pointer; test both); README: on a shared device, leave the group before walking away. |
| L7 | Low | architecture.md 5.3 | Trusted Types (#21) stays separate. This PR is the first to keep a credential (leader token) on the reader origin, so an XSS now has a concrete prize. Likelihood stays low: `script-src 'self'`, no inline, no eval, ESLint sink bans, text-only rendering. | Accept the split; record in #21 that its priority rose with #24 and that the e2e CSP-violation check is the test harness for it. No change here. |
| L8 | Low | architecture.md 8.1 pointer codec (`groupId: string (<= 256)`) | Looser than the server's group ID format; a tampered pointer is only a local problem, but strict codecs make "invalid is deleted" meaningful. | R5: validate `groupId` with the server's exact format (43 base64url characters, as in #1 L3), `ack` `^[0-9a-f]{64}$`, `pageIndex` a safe non-negative integer, `z.strictObject`. |
| L9 | Low | design 7.8 (`approvalRequest` "{name} wants to join") | If `format()` substitutes placeholders repeatedly, a name like `{n}` or `{time}` is re-expanded; if it ever returns markup, a name becomes HTML. | R7: single-pass substitution of only the known keys; the result is a React text child (or an array of text/`<bdi>` nodes), never HTML; test a name `{n}` and `<b>x</b>`. |
| L10 | Low | architecture.md 4.5, Q-A1 option 1 | The reader accepts the public dev key in any environment. If a deployment copies the compose values, the sync server refuses it in production (#1 M6, `checkDevKeys`), so the failure is visible but confusing. | R2: the reader prints a startup **warning** (not an error: the compose reader image runs with `NODE_ENV=production`) when `READER_SYNC_API_KEY` equals a known public dev key and `NODE_ENV=production`. |

Not findings (checked):

- **No WebSocket `Origin` check on the server.** Agreed with the plan: no
  cookies or ambient credentials, the key is public, so cross-site socket
  hijacking gains nothing (#1 note).
- **`READER_SYNC_APP_VERSION`** is a client claim, not a control; anyone can
  claim any version. Fine: `minAppVersion` is a compatibility gate.
- **Leader preview never reaching members** is a client guarantee (#13
  AC30); the reader never calls `usePreview` in 8a. Fine.
- **Duplicated tab** copies the leader token; the newer tab resumes and the
  older gets `replaced` (token kept, not resumed). Same identity, same
  person; fine.
- **P1, P2** (package additions): one field copied from `hello.ok` and pure
  re-exports of protocol functions. No new wire message, no logging change,
  no new trust. Fine with R14.
- **Q-A3** (25 s test against a 30 s grace; 45 s suggested for deployments):
  no security impact.
- **`lean-qr` 2.7.4** (registry checked 2026-11-06): MIT, 0 dependencies, no
  install scripts, one maintainer, integrity
  `sha512-tlMPFfqh...BFnQ==`. **`@playwright/test` 1.65.0** -> `playwright`
  -> `playwright-core`, no further dependencies, no install scripts. pnpm 10
  runs no dependency lifecycle scripts unless allow-listed.

## 4. Required controls (part of the plan)

The engineer implements these; code-mode review checks each one. The #19
controls C1-C11 still apply unchanged.

- **R1 Sync URL and CSP.** A dedicated `checkSyncUrl` (not
  `checkAllowedOrigin`, which only allows `http(s)`): WHATWG parse without a
  base; `wss:`, or `ws:` only for `localhost` / `127.0.0.1`; no username,
  password, query or fragment; hostname matches the strict host pattern of
  L1 (rejects `*`, `;`, `,`, quotes, IPv6 literals); the CSP gets only
  `url.origin` re-derived in `server/headers.ts` from the validated value.
  Tighten `checkAllowedOrigin` with the same host pattern. `connect-src` is
  the **only** CSP change; no sync origin when sync is off (tested); the
  `ws:` loopback production warning as planned.
- **R2 API key.** Validation as planned (32-256 visible ASCII); the value is
  never in an error, warning, log or URL (sent only in the hello, as the
  client does today). README: the key is public and identifies the app; use
  a dedicated registration with tight per-app limits; per-IP limits at the
  reverse proxy; never reuse a private key; rotation = config change and
  restart. Startup warning for a public dev key with `NODE_ENV=production`
  (L10). Q-A1: option 1 (reuse `dev-app`, no server change).
- **R3 QR ticket intake.** In `main.tsx`, before React, any `await`, any
  network request or any error screen: if the fragment starts with `#t=`,
  take it and `history.replaceState(history.state, '', pathname + search)`,
  whether sync is on or off and whether the shape is valid. Also on
  `hashchange`. The ticket lives only in memory, is used for one
  `joinByQr` and then dropped; never in `sessionStorage`, error text,
  announcements, `aria-label`s (the QR's label says "QR code to join", not
  the link), `title`, logs or any other URL. A ticket landing in a tab with
  a pointer follows the one rule the architect picks (L3). e2e: hash empty
  after load, no history entry with `#t=`.
- **R4 Deep link builder.** Built only from validated values:
  `encodeURIComponent` of the validated content ID, the `?src` value is the
  allow-list-checked `url.href`, `location.origin` as base, ticket only after
  `#t=`. Unit test for each mode, including that the ticket never appears
  before `#`.
- **R5 Storage (ADR 0009).** Tokens only through the `sessionStorage` wrapper
  (fallback `'memory'`), never `localStorage` (test: `localStorage` stays
  empty through create, join, resume). All reader keys through
  `session-store.ts`, strict zod codecs with the exact formats of L8,
  invalid values deleted, every storage exception caught. Never stored:
  codes, door codes, tickets, other people's names, leader metadata. After
  leave, end, any `ended` reason other than `closed`/`replaced`, and every
  "gone" resume code: no pointer and no token for that group remain
  (tested; call `forgetGroup(groupId)` where the client doesn't already
  remove it).
- **R6 Untrusted group data.** `decodePosition` exactly as section 6
  (`isPlainObject` with prototype check, own keys exactly `v` and
  `pageIndex`, `v === 1`, safe integer in range), ignored silently; the
  prototype-trick tests stay. Leader metadata only through
  `parseLeaderMetadata` (C4), never spread or merged. "Open the group's
  book" navigates using the **local** catalogue's ID found by lookup, never
  the leader's string. Leader content IDs: `PlainText`, `dir="ltr"`,
  isolated, truncated to 40. Positions and metadata are ignored while
  blocked or before the content check.
- **R7 Names and service text.** Display names, content IDs and any server
  text only as React text children via `PlainText`, bidi-isolated (`<bdi>`
  or FSI/PDI), never in `href`, `src`, `style` or class names. Message
  formatting single-pass with known keys only (L9). Error messages are
  static strings plus a formatted duration (as planned); server message text
  is never shown.
- **R8 Inputs.** `CodeField`, door-code field: `inputMode` per design,
  `maxLength` from the protocol constants, `autocomplete="off"`,
  `spellcheck={false}`, `autoCorrect="off"`, `autoCapitalize="off"`,
  `dir="ltr"`; `normalizeJoinCode` / `classifyJoinCode` only for UX (the
  server stays authoritative); submit via handler with `preventDefault()`;
  fields cleared after admission or leave. `NameField`: `maxLength` 128,
  `resolveDisplayName` before sending, nothing sent on invalid.
- **R9 No logging (AC54).** No `logger` option; ESLint `no-console` as an
  error for `apps/reader/src`; no `window.onerror` / `unhandledrejection` /
  `reportError` forwarding; the AC54 console-spy test through create, join
  (all methods), resume, errors and end; reader server per-request logging
  stays absent (C9).
- **R10 Dependencies.** `lean-qr` and `@playwright/test` pinned exactly
  (no `^`/`~`), lockfile with integrity, `pnpm install --frozen-lockfile`;
  neither added to pnpm's built-dependencies allow-list; `lean-qr` imported
  only in `QrCodeView.tsx` from its main entry (no `extras/*`, which include
  data-URL and HTML helpers); nothing from `@playwright/test` or `e2e/`
  imported by `src/` (a build-output test that the bundle has no
  `playwright` string, or a lint boundary); runtime image unchanged (zod
  only); `pnpm audit --audit-level=high` clean. Any later swap to an ADR
  0007 alternative must use a raw-matrix API, never an HTML string or data
  URL.
- **R11 CI e2e job.** Workflow-level `permissions: contents: read` kept;
  `persist-credentials: false`; actions pinned by SHA; triggers stay `push`
  and `pull_request` (never `pull_request_target`); no secrets; servers and
  the TCP proxy bind `127.0.0.1`; dev key and dev or random token secret
  only; artifacts as L5.
- **R12 Headers.** `Permissions-Policy` unchanged (`camera=()`); no new
  script, style, img or font source; no `style=` attributes in markup (CSSOM
  `setProperty` only); QR as React SVG elements; e2e fails on any
  `securitypolicyviolation` and on CSP console errors; `build-output`
  test still clean.
- **R13 Compose.** The `reader` service gets only `READER_*` variables (no
  `TOKEN_SECRET`, no `env_file` shared with `sync-server`); comments say the
  key is the public dev key and that the `ws:` warning is expected locally.
- **R14 Package additions.** P1 copies one validated enum field; P2 are
  re-exports of the same function objects (tested by identity); no new
  client log events containing codes, tickets or names.

## 5. How the alternatives would change the verdict

| Decision | Recommended | Alternative | Security effect |
|---|---|---|---|
| ADR 0007 QR library | `lean-qr` | `qr` (paulmillr) | Equal (0 deps, no scripts); larger. Still PASS. |
| | | `qrcode-generator` | PASS only if the raw module API is used; its `createSvgTag` / `createDataURL` outputs would need `innerHTML` or `img-src data:`, which break C6/C7 (that use would be **High**). |
| | | `uqr` | Equal; pre-1.0, quiet. PASS. |
| | | Vendored Nayuki | No supply chain; we own fixes. PASS. |
| | | `qrcode` (soldair) | 3 deps including `yargs`: more supply chain for no gain. Not recommended. |
| ADR 0008 e2e tool | Playwright | Vitest browser mode | Same Playwright download underneath. PASS. |
| | | Puppeteer | More npm dependencies. PASS, not recommended. |
| ADR 0009 storage | all `sessionStorage` | tokens in `localStorage` | **Medium**: tokens and the group ID outlive the tab on shared (school) devices; the next user of the browser profile resumes as the previous person, as leader too (codes, approvals, end). A second tab silently takes the group. Would need: forget on leave/end, an explicit "leave on this device" action calling `forgetAllGroups`, README warning. Still PASS (not blocking), but worse. |
| | | memory only | Lowest risk; fails AC34. |
| Q-A1 dev registration | reuse `dev-app` | new `reader` dev key | Requires adding the key to `DEV_API_KEYS` (a server change, against the spec constraint). **Without that change it is High**: a committed key would be accepted in production. With it, equal. Prefer option 1. |
| Q-A3 lock length | 25 s test, 45 s documented | exact 30 s | No security effect. |
| #21 Trusted Types | separate | fold in | Slightly stronger now, more risk of breaking this PR. Separate is fine (L7). |

## 6. What code mode will check

- gitleaks over the PR commits (the dev key is a known public value; any
  other key-like string is a finding); semgrep on changed files; `pnpm audit
  --audit-level=high`.
- R1-R14, file by file: `src/config/schema.ts`, `src/content/origin.ts`,
  `server/headers.ts`, `server/run.ts`, `plugins/library.ts`,
  `server/html.ts` (C5 unchanged), `src/main.tsx`, `src/group/deep-link.ts`,
  `session-store.ts`, `position.ts`, `names.ts`, `errors.ts`,
  `use-group-session.ts`, `use-follow.ts`, `SyncRoot.tsx`,
  `components/group/*` (especially `QrCodeView`, `CodeField`, `NameField`,
  `ApprovalTray`, `MismatchBlock`), i18n formatting, `eslint.config.js`,
  `apps/reader/package.json`, `pnpm-lock.yaml`, `compose.yaml`,
  `.github/workflows/ci.yml`, `playwright.config.ts`, `e2e/helpers/*`,
  `packages/client` and `packages/react` diffs.
- Tests exist for: CSP origin injection attempts (L1 list), no sync origin
  when off, key never in config errors, fragment stripped before render and
  on `hashchange`, ticket absent from DOM text and attributes, `localStorage`
  empty, pointer and token gone after leave/end/gone codes, position
  decoder rejections, metadata prototype tricks, names with markup, bidi
  controls and `{n}`, console silent (AC54), e2e zero CSP violations.
- The pinned versions and integrity of `lean-qr` and `@playwright/test` in
  the lockfile; no install scripts allowed; `lean-qr` import confined to
  one module; no Playwright code in `dist/`.
- L1-L10 advisories: noted as fixed or still open.
