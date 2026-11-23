# Project conventions

The project's accepted choices in one page. Accepted ADRs in
[`docs/decisions/`](decisions/) hold the reasoning; this file holds the
result. Change a choice with a new ADR, never by editing this file alone.

## Repository and tooling

| Area            | Choice                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------- |
| Layout          | pnpm workspace monorepo: `packages/*` libraries, `apps/*` deployables; no submodules          |
| Runtime         | Node 24 (`.nvmrc`), ESM (`"type": "module"`) everywhere                                       |
| Package manager | pnpm 10 via corepack (`packageManager` in the root `package.json`)                            |
| Language        | TypeScript 6, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`                    |
| Validation      | zod 4 at every boundary (wire messages, env, content files); `jitless` where a CSP applies    |
| Tests           | Vitest 4 per package (`test/**/*.test.ts[x]`); jsdom and Testing Library for React code       |
| Lint and format | ESLint 9 (typescript-eslint, type-checked) and Prettier 3 (`pnpm lint` runs both)             |
| CI              | `pnpm audit --audit-level=high`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`     |
| Docker          | Multi-stage images on the pinned `node:24-alpine` digest, `USER node`, loopback compose ports |
| Commits         | Conventional Commits, one logical chunk per commit (`.claude/rules/git-commits.md`)           |

Commit scopes in use: `protocol`, `server`, `client`, `react`, `reader`,
`adr`, `spec`, `design`, `architecture`, `security`, `state`, `docs`,
`compose`, `ci` (also used without a scope: `ci: ...`), `storage` (the sync
server's storage layer, `apps/sync-server/src/storage`), `release` (release
tooling in `scripts/release` and `.changeset`, #37).

## Reading app (`apps/reader`, #19)

| Decision                                 | Choice                                                                                                                                                                        | ADR                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Framework and serving                    | React 19 + Vite SPA in `apps/reader`, served by a minimal `node:http` server; own Dockerfile and compose service `reader`                                                     | [0001](decisions/0001-reading-app-framework.md)                      |
| Styling                                  | CSS Modules + one global `tokens.css` of CSS custom properties (design.md tokens); logical properties; system font stack, no web fonts                                        | [0002](decisions/0002-styling-and-design-tokens.md)                  |
| Interface languages                      | `en` and `he`, picked from `navigator.languages`, fallback `en`, optional `READER_UI_LANG` pin; no i18n library                                                               | [0003](decisions/0003-interface-languages.md)                        |
| Content schema                           | Schema v1: optional `title`, `lang` at 3 levels, block `type: paragraph \| heading`; strict (unknown fields rejected); content ID `namespace/slug` (64/128 caps)              | [0004](decisions/0004-content-schema-v1-and-fingerprint.md)          |
| Fingerprint                              | SHA-256 over RFC 8785 canonical JSON of the whole validated file, lowercase hex; no Unicode normalisation                                                                     | [0004](decisions/0004-content-schema-v1-and-fingerprint.md)          |
| Configuration and selection              | `READER_ENTRY=library\|error\|default-book\|single-book`, `READER_BOOK`, `READER_LIBRARY=on\|off`; library at `/library`; build-time index; config injected into `index.html` | [0005](decisions/0005-reader-configuration-and-content-selection.md) |
| Fetched content (`?src`)                 | Disabled by default; exact-origin allow-list `READER_SRC_ORIGINS`; 5 MiB cap; `redirect: 'error'`; strict CSP whose `connect-src` is the allow-list                           | [0006](decisions/0006-fetched-content-policy.md)                     |
| Content mismatch outcome                 | `different-content` blocks; malformed leader metadata is `unsupported-schema` and blocks; `different-version` warns                                                           | [architecture.md](issues/19/architecture.md) (Gate 2 Q3, Q4)         |
| Content rules kept at Gate 2 (AC32-AC35) | Zero-block pages invalid; line breaks preserved; 15 s configurable fetch timeout; the reading position across reload is now kept per tab (superseded by ADR 0009, #24 AC36)   | [spec.md](issues/19/spec.md)                                         |

Rules that follow from these choices:

- External text (content, titles, URL values, later sync display names) is
  rendered only as React text children; `dangerouslySetInnerHTML`,
  `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` are
  banned by ESLint in the app.
- Components use `var(--token)` values, never raw colours or spacing.
- The reader server never fetches a URL on behalf of a client (no proxy).
- The reader's CSP enforces Trusted Types with no policy
  (`require-trusted-types-for 'script'; trusted-types 'none'`, #21): no
  policy exists and `trusted-types 'none'` forbids creating one. Adding a
  policy needs a named policy in the CSP (never `*`, `default` or
  `'allow-duplicates'`), a README note and a security plan review.

## Reading app groups (`apps/reader`, #24)

| Decision                                            | Choice                                                                                                                                                       | ADR                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| QR code rendering                                   | `lean-qr` 2.7.4, pinned exactly, imported only in `QrCodeView.tsx` from its main entry; drawn as a React SVG `<path>` (no `data:` URL, no HTML string)       | [0007](decisions/0007-qr-code-rendering-library.md)    |
| End-to-end browser tests                            | Playwright Test, Chromium only, pinned exactly; tests in `apps/reader/e2e`, script `test:e2e` outside `pnpm test`; separate CI job `e2e`                     | [0008](decisions/0008-end-to-end-browser-tests.md)     |
| Group storage in the browser                        | Participant tokens, the group pointer and the reading position in `sessionStorage`, per tab; a brand-new tab doesn't resume, reopen-closed-tab does          | [0009](decisions/0009-reader-group-session-storage.md) |
| Dev registration (Gate 2 Q-A1)                      | Compose's reader uses the existing public `dev-app` key from `config/apps.dev.json`; no server change                                                        | [architecture.md](issues/24/architecture.md)           |
| Phone-lock length (Gate 2 Q-A3)                     | The e2e phone-lock check drops the leader for 25 s against the default 30 s grace; deployments that need a full 30 s lock set `disconnectGraceSeconds` to 45 | [architecture.md](issues/24/architecture.md)           |
| QR ticket in a tab already in a group (security L3) | The resume is skipped and the user is asked once: "Leave your current group and join this one?"; never two flows at once, never leaving a group silently     | [security.md](issues/24/security.md)                   |

Rules that follow from these choices:

- The sync API key in the page is public: it identifies the app and grants
  nothing on its own.
- A QR ticket lives only in memory: stripped from the URL fragment before
  anything else runs, never stored, logged or put in another URL.
- The CSP widens only `connect-src`, by the sync server's origin.

## Sync server storage (`apps/sync-server`, #35)

| Decision                       | Choice                                                                                                                                                                                                                                                                                                                                                                                                      | ADR                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Redis client and servers       | `@redis/client` 6.3.1, pinned exactly, loaded only by a dynamic `import()` when `REDIS_URL` is set; Redis 7.2+ and Valkey 7.2+, one endpoint                                                                                                                                                                                                                                                                | [0010](decisions/0010-redis-client-and-supported-servers.md)                  |
| Group atomicity                | One unit of work per locked group task (read once, commit once) plus an effect outbox flushed after the commit, for both stores; a fenced Redis lease lock is added for several instances                                                                                                                                                                                                                   | [0011](decisions/0011-group-atomicity-with-redis.md)                          |
| Cross-instance delivery        | One pub/sub channel per instance plus an attachment registry in the group document (applied with several instances)                                                                                                                                                                                                                                                                                         | [0012](decisions/0012-cross-instance-event-delivery.md)                       |
| Group timers                   | A due-time sorted set, a Lua lease claim, a 1 s poll and a 30 s lease; dispatch by timer kind with plain data; `setTimeout` behind the same interface in memory                                                                                                                                                                                                                                             | [0013](decisions/0013-persistent-group-timers.md)                             |
| While Redis is unreachable     | The group's local sessions close with `1001`, upgrades get 503, disconnects are replayed on reconnect; no protocol change, no fallback to memory                                                                                                                                                                                                                                                            | [0014](decisions/0014-behaviour-while-redis-is-unreachable.md)                |
| Delivery and Gate 2 rules (9a) | Two PRs (one instance first); key TTL = max-session deadline + 5 s; a restart never shortens a running grace or hold below `disconnectGraceSeconds`; eviction policy other than `noeviction` is a startup warning                                                                                                                                                                                           | [architecture.md](issues/35/architecture.md) (Gate 2 Q-A1-Q-A6)               |
| Several instances (9a PR 2)    | Group lease 10 s, renewed every 3 s, 5 s wait then busy (`1001` to the requester only), 30 s hold cap; instance liveness 15 s, heartbeat 5 s, self-fence after 10 s; orphan sweep every 5 s; fixed constants, not env. The attachment registry is its own key `P:a`; effects are published inside the commit script with a commit sequence, and a task first waits for earlier effects sent to its instance | [architecture.md](issues/35/architecture.md) (Gate 2 Q-B2, Q-B4, Q-B5, Q-B10) |

Rules that follow from these choices:

- Every Redis key is built in `storage/redis/keys.ts`, which checks the format
  of each part; Lua scripts are constant strings with every dynamic value in
  `KEYS`/`ARGV`.
- Every value read from Redis is schema-checked; on the recovery path an
  invalid value fails closed (treated as ended or closed).
- `REDIS_URL` and its parts never appear in a log line, `Config error`,
  `Startup error` or inspect output.
- Several instances: every group-scoped commit checks the group lease and the
  instance's liveness key first; who owns a membership is decided from the
  registry under the lease (the local check may only deny); liveness for
  removals is read from Redis, never from a cache; every pub/sub message is
  schema-checked and applied only to the session with the same attach ID.

## Sync server config and health (#36)

| Decision                         | Choice                                                                                                                                                                                                                                                                     | ADR                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Unknown look-alike env variables | A set name starting with `MAX_`, `TOKEN_`, `REDIS_`, `SYNC_`, `JOIN_`, `QR_`, `APPROVAL_`, `DISCONNECT_`, `KEEP_ALIVE_`, `INACTIVITY_` or ending with `_CEILING` that is not a known variable is a `Config error`; `SYNC_TEST_*` and platform link names are never flagged | [0015](decisions/0015-unknown-environment-variables.md)   |
| Reader env variables             | Same rule with the single family `READER_`                                                                                                                                                                                                                                 | [0015](decisions/0015-unknown-environment-variables.md)   |
| Config echo rule (Gate 2 Q-3)    | The server prints no raw value; it may print validated integers, namespaces matching the pattern, the config file path and JSON key names (escaped, cut), env names (cut at 48) and `errno` codes                                                                          | [architecture.md](issues/36/architecture.md) (Gate 2 Q-3) |
| Invalid ceiling (Gate 2 Q-4)     | Only the app comparisons that need an invalid ceiling are skipped; the run still exits 1                                                                                                                                                                                   | [architecture.md](issues/36/architecture.md) (Gate 2 Q-4) |
| Shutdown drain (Gate 2 Q-6)      | None: `/ready` is 503 from the start of `close()`, which stops the listener at once                                                                                                                                                                                        | [architecture.md](issues/36/architecture.md) (Gate 2 Q-6) |

Rules that follow from these choices:

- Every config problem of one run is printed, one `Config error:` line each,
  then the process exits 1. Nothing that depends on config runs before the
  whole config loaded without a problem.
- `known-vars.ts` (server and reader) is the one list of known names; adding a
  variable means adding it there.

## Sync server group creation limits (`apps/sync-server`, #12)

| Decision                   | Choice                                                                                                                                                                                                                                                                         | ADR                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Create limits (Gate 2 Q-1) | Per connection: a sliding window in the process. Per app: one token bucket for every instance, checked with the live-group cap in one step; its sustained rate is derived, `min(maxRate, (cap / 2 - burst) / (maxSessionMinutes + 5 s))`, so creates hold at most half the cap | [architecture.md](issues/12/architecture.md) (Gate 2 Q-1) |
| Configuration (Gate 2 Q-2) | Env variables in the `MAX_` family, defaults as constants: `MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE` (6), `MAX_GROUP_CREATE_BURST_PER_APP` (120), `MAX_GROUP_CREATES_PER_APP_PER_MINUTE` (120), `MAX_LIVE_GROUPS_PER_APP` (10 000), with cap > 2 x burst                   | [architecture.md](issues/12/architecture.md) (Gate 2 Q-2) |
| Cap error (Gate 2 Q-3)     | `APP_GROUP_LIMIT` with `details.maxLiveGroups` (the configured cap, never the count)                                                                                                                                                                                           | [architecture.md](issues/12/architecture.md) (Gate 2 Q-3) |
| Recreations (Gate 2 Q-4)   | Counted, never refused, never charged                                                                                                                                                                                                                                          | [architecture.md](issues/12/architecture.md) (Gate 2 Q-4) |
| Refusal logs (Gate 2 Q-5)  | One `warn` per app per minute per instance, `namespace` only                                                                                                                                                                                                                   | [architecture.md](issues/12/architecture.md) (Gate 2 Q-5) |

## Packages, license and release (#37)

| Decision                 | Choice                                                                                                                                                                                                                                                                                                                          | ADR                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Package names            | Published: `@mosherw/sync-system-protocol`, `@mosherw/sync-system-client`, `@mosherw/sync-system-react`. Private: `@mosherw/sync-system-server`, `@mosherw/sync-system-reader`. Source export condition `@mosherw/sync-system-source`. No `@sync-system/` scope remains                                                         | [0016](decisions/0016-versioning-and-npm-release.md) |
| License                  | GPL-3.0, SPDX `GPL-3.0-only`, in every `package.json`; full text in the root `LICENSE` and in each published package. The GPL also covers the client and React packages and the bundles that ship them                                                                                                                          | [spec.md](issues/37/spec.md) (Q3)                    |
| Versioning and changelog | Changesets, one fixed group of protocol, client, react and server (`privatePackages.version: true, tag: false`, reader ignored), built-in changelog generator; the version bump happens in a reviewed release PR; internal deps `workspace:*` (published as the exact version)                                                  | [0016](decisions/0016-versioning-and-npm-release.md) |
| Git tags                 | One annotated `vX.Y.Z` per release, created on the maintainer's host on the verified merge commit; no git credential in any container                                                                                                                                                                                           | [0016](decisions/0016-versioning-and-npm-release.md) |
| npm publish              | By hand: `npm publish <tarball> --access public --ignore-scripts` of the three `pack:check`-verified tarballs, from a fresh publish container that runs no project code; never `pnpm -r publish`, `changeset publish` or `npm login`                                                                                            | [0016](decisions/0016-versioning-and-npm-release.md) |
| npm authentication (E2)  | A per-release granular access token (read and write, the `@mosherw` packages only, shortest expiry up to 7 days, IP allowlist, bypass 2FA), read on the host with `read -rs`, piped over `docker exec -i` stdin into the publish container's mode-600 `/root/.npmrc`, removed by a host `trap`, revoked right after the publish | [0016](decisions/0016-versioning-and-npm-release.md) |
| Server image             | Built on the host with `docker buildx` from a fresh clone of the tag; `ghcr.io/mosherw/sync-system-server` (canonical) and `docker.io/mosherw/sync-system-server` (mirror); tags `X.Y.Z`, `X.Y`, `X`, `latest`; `linux/amd64` and `linux/arm64`; OCI labels; `LICENSE` in `/app`                                                | [0017](decisions/0017-server-image-publishing.md)    |
| Registry credentials     | A temporary `DOCKER_CONFIG`, `read -rs` + `--password-stdin` logins, a `trap` that logs out of both registries and removes the config; least-scope, short-expiry tokens revoked after the release                                                                                                                               | [0017](decisions/0017-server-image-publishing.md)    |

Rules that follow from these choices:

- The non-private workspace packages are exactly the three published names;
  root, server and reader stay `private: true` (tested).
- Every user-visible change adds a `.changeset/*.md` file in its PR.
- Agents never publish packages, push images, tag or create releases; the
  maintainer follows `RELEASING.md`.
