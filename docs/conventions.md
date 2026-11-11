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
`compose`, `ci` (also used without a scope: `ci: ...`).

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
