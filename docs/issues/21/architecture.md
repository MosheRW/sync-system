# Architecture: #21 fix(reader): enforce trusted types in the csp

Spec: [spec.md](spec.md). Source: finding F10 / advisory A1 in
[`docs/issues/19/security.md`](../19/security.md). Path: fast.

## 1. Repo layout

- Layout: **monorepo** (pnpm workspaces, no submodules, no other repos).
- Touched package: `apps/reader` only (path `apps/reader`, default branch
  `main`). Checks: `pnpm --filter @sync-system/reader typecheck`,
  `pnpm --filter @sync-system/reader test`, `pnpm build`,
  `pnpm --filter @sync-system/reader test:e2e`; root `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm audit --audit-level=high`.
- Docs: `apps/reader/README.md`, `docs/conventions.md`.

## 2. Decisions

Decisions: none open. No ADR: the investigation below shows the app needs
**zero** Trusted Types policies, so there is no policy-name choice to make.

## 3. Investigation: does anything need a policy?

A production build (`vite build`, current branch head) was grepped for every
Trusted Types sink (`innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`createContextualFragment`, `DOMParser`, `document.write`, `srcdoc`,
`setHTMLUnsafe`, `eval`, `Function(`, string `setTimeout`, `importScripts`,
`Worker(`, `createElement('script')`, `script.src`) and for
`trustedTypes`/`createPolicy`. Findings:

| Source | Sink in the bundle | Reached by the app? |
|---|---|---|
| React DOM 19 | `div.innerHTML = '<script></script>'` | Only when a `<script>` element is rendered. The app renders none. |
| React DOM 19 | `el.innerHTML = props.dangerouslySetInnerHTML.__html` | Only with `dangerouslySetInnerHTML`, which ESLint bans in the reader and `packages/react` (README "Development"; `packages/react/test/package.test.ts`). |
| React DOM 19 | `img.src`, `<script>` `src` reads in hydration/resource code | `img.src` is not a TT sink; the script paths are not reached (no `<script>` rendered, no SSR hydration). |
| zod 4 | `Function('')` eval probe | Skipped when `jitless` is on. The reader sets it in `src/content/zod.ts`; `packages/protocol` builds its schemas through `buildJitless`. The existing e2e CSP guard already proves the probe never runs (it would be a `script-src` eval violation today). |
| Vite 8 output | dynamic `import()` of book chunks, `link rel=modulepreload` | Not TT sinks (`import()` and `link.href` are not checked). No inline script, no `script.src` assignment. |
| lean-qr 2.7.4 (main entry) | none | QR is a React SVG `<path d>` (ADR 0007); `toSvgDataURL` is already asserted absent from the bundle. |
| `trustedTypes` / `createPolicy` | none | No dependency creates a policy. |

Conclusion: **no policy is needed**. The CSP gets
`require-trusted-types-for 'script'` (AC1) and `trusted-types 'none'`.

Why also `trusted-types 'none'` (AC2 allows it: it lists exactly the
required policy names, which is none): it makes
`trustedTypes.createPolicy()` throw for any name, including `default`, so
injected or future code cannot mint a policy that launders strings into the
sinks. No `*`, no `'allow-duplicates'`. If a future dependency needs a
policy, the build tripwire (section 7) and the e2e guard fail and the
change must name the policy explicitly (README rule, section 6).

Alternatives rejected:
- `require-trusted-types-for 'script'` alone: also meets AC1, but leaves
  policy creation open (a `default` policy created by injected code would
  silently defeat the enforcement). No cost to closing it.
- A `default` or named policy with a sanitiser: nothing needs it; it would
  add a dependency (DOMPurify) or hand-written sanitising code for no sink.
- Report-only first (`Content-Security-Policy-Report-Only`): the app has no
  report endpoint, and the e2e guard is the measurement.

## 4. Approach

`contentSecurityPolicy()` in `apps/reader/server/headers.ts` appends two
constant directives after `object-src 'none'`:

```
require-trusted-types-for 'script'; trusted-types 'none'
```

They are constants (no input reaches them), so the existing re-check and
re-serialise logic for origins (security C2) is unchanged. Every response
already carries the CSP (security C1), including 4xx/5xx and
`clientError` responses, so no other server file changes. The Vite dev
server sends no CSP; unchanged (out of scope).

Browsers without Trusted Types ignore both directives (spec: out of scope,
no polyfill).

## 5. Files to create / modify

| File | Change |
|---|---|
| `apps/reader/server/headers.ts` | Append the two directives; extend the doc comment (#21, F10). |
| `apps/reader/test/server-handler.node.test.ts` | Update the exact CSP string in "sends the CSP with the configured origins"; new tests in "CSP construction": contains `require-trusted-types-for 'script'` and `trusted-types 'none'` with and without sync and `?src` origins, exactly once each, and no `'allow-duplicates'` (AC1, AC2, AC4). |
| `apps/reader/test/build-output.node.test.ts` | New tripwire: the bundle has no `createPolicy`/`trustedTypes`, `outerHTML`, `insertAdjacentHTML`, `createContextualFragment`, `DOMParser`, `document.write`, `srcdoc`, `setHTMLUnsafe`, `importScripts`, `new Worker`; `innerHTML` appears only in React DOM's known sites (assert the count of `innerHTML=` assignments equals the 3 known React sites, so a new one fails). |
| `apps/reader/e2e/helpers/fixtures.ts` | Guard also catches Trusted Types: console regex `/Content Security Policy|Trusted ?Type|requires 'Trusted/i`, and a `pageerror` listener that records errors whose message names `TrustedHTML`, `TrustedScript` or `TrustedScriptURL` (an uncaught TT `TypeError`). `securitypolicyviolation` events already land in `__csp` (`violatedDirective` is `require-trusted-types-for` or `trusted-types`). |
| `apps/reader/e2e/trusted-types.spec.ts` (new) | (a) the served CSP header of `/`, an asset, a 404 contains both directives; (b) positive control on an **unguarded** page (`browser.newPage()`, not `pages.open()`): `document.body.innerHTML = 'x'` throws and `trustedTypes.createPolicy('x', {})` throws, proving Chromium enforces them; (c) guarded tour of the non-group flows: `/library`, open each bundled book (incl. `psalms-he`, mixed-direction samples), page forward/back, an unknown book (error screen), a 404 path, and the QR view. Group flows are already covered by `groups`, `lifecycle` and `phone-lock` specs, which now run under the stricter guard. |
| `apps/reader/README.md` | Chunk 1: add the two directives to the CSP string in "Fetched content" (the `readme.node.test.ts` check requires every directive to be documented, so this must ship with the code). Docs chunk: a "Trusted Types" paragraph and the e2e section wording (section 6). |
| `docs/conventions.md` | One rule under the reader rules: Trusted Types enforced with no policies; adding one needs a named policy, a README note and a security plan review. |

Not changed: `server/handler.ts`, `server/html.ts`, `server/static-files.ts`,
`src/**`, dependencies, Dockerfile, compose, CI workflow.

## 6. Contracts, data, Docker, docs

- Data model changes: none.
- Contracts: the HTTP `Content-Security-Policy` header gains two directives.
  No API or realtime message changes.
- Docker impact: none (same server, same image contents).
- Docs impact: `apps/reader/README.md` (CSP string; new "Trusted Types"
  paragraph after the response-headers paragraph: what is enforced, that no
  policy exists and `trusted-types 'none'` forbids creating one, that React
  `<script>` rendering and `dangerouslySetInnerHTML` are not used, zod must
  stay `jitless`, browsers without TT ignore it, and how to add a policy if
  ever needed; "End-to-end checks": "zero CSP and Trusted Types
  violations"), `docs/conventions.md` (one rule line).

## 7. Risks / edge cases

- **A hidden sink on a path the e2e doesn't reach** (e.g. an error branch).
  Mitigations: the static bundle tripwire (section 5) catches any new sink
  site at build time; the guarded tour covers error and 404 screens.
- **zod JIT re-enabled** (e.g. `buildJitless` restores `jitless: false`
  before the reader's schemas parse): today's e2e already fails on an eval
  violation; with TT the failure is the same directive family. The
  engineer checks the guard reports such a case (temporarily disabling
  `jitless` locally must make the e2e fail; revert, not committed).
- **Playwright's own injected code** runs in an isolated world and is not
  subject to the page's TT; `addInitScript` and `page.evaluate` go through
  CDP, not `eval`. If a violation's source turns out to be Playwright
  tooling, the engineer reports it as a deviation; the guard is not
  weakened.
- **Future React upgrade** adding sinks: the build tripwire's known-site
  count fails and forces a review.
- **Browser support**: older or non-supporting browsers ignore the
  directives; no behaviour change there.
- `trusted-types 'none'` makes any future `createPolicy` throw at runtime:
  intended, documented in README and conventions.

## 8. Security-sensitive areas

Security-sensitive: yes

- Security headers / CSP (`apps/reader/server/headers.ts`): a defence-in-depth
  control against DOM XSS for a page that holds participant tokens in
  `sessionStorage` (#24). A mistake (e.g. `trusted-types *`, a permissive
  `default` policy) would weaken the control. No new input, endpoint,
  dependency or data handling.

## 9. Implementer model

Implementer model: opus
Reason: security-sensitive plan (CSP control); the work itself is small and
follows the existing CSP tests and e2e guard, but the hard rule applies.

## 10. Test plan

| AC | Verification |
|---|---|
| AC1 | `server-handler.node.test.ts`: exact header string and `toContain("require-trusted-types-for 'script'")`, with and without `?src` origins and sync URL (`sync-config.node.test.ts` cases still pass). |
| AC2 | Same file: `trusted-types 'none'` present once; no `*`, no `'allow-duplicates'`. README documents "no policy". |
| AC3 | Playwright (ADR 0008) against the **built** reader and sync servers in Chromium: the new `trusted-types.spec.ts` (header, positive control, non-group tour) plus the existing `groups`, `lifecycle`, `phone-lock` specs, all under the extended guard that fails on any `securitypolicyviolation` event, CSP/TT console error or TT page error. Plus the `build-output.node.test.ts` sink tripwire. |
| AC4 | The unit tests above (and the e2e header check). |
| AC5 | `readme.node.test.ts` (every CSP directive documented, unchanged logic) and a new assertion that the README names `require-trusted-types-for` and `trusted-types 'none'` in a Trusted Types paragraph. |
| AC6 | Full local CI (below). |

**How AC3 runs (GitHub Actions is billing-blocked):** the local Docker CI,
as for #25 and #12. Copy a fresh clone of the PR head (including `.git`)
into containers, no bind mounts:

1. `check` job: `node:24` container + `redis:7.2.17-alpine` (pinned
   digest from `ci.yml`) on a private network with `SYNC_TEST_REDIS_URL`
   set: `corepack enable && pnpm install --frozen-lockfile && pnpm audit
   --audit-level=high && pnpm lint && pnpm typecheck && pnpm test && pnpm
   build`.
2. `e2e` job: a separate `node:24` container (Debian, so
   `playwright install --with-deps chromium` works; no Redis needed, the
   e2e sync servers use memory): `pnpm install --frozen-lockfile && pnpm
   build && pnpm --filter @sync-system/reader exec playwright install
   --with-deps chromium && pnpm --filter @sync-system/reader test:e2e`.
   Expected: all specs green (5 existing + the new ones), zero violations.

Known pre-existing failure: `repo-hygiene.test.ts` "CI workflow ... runs on
push and pull_request" (workflow triggers commented out while Actions is
blocked); it fails identically on `main` and is not touched.

Manual (optional, QA): open the built app in desktop Chrome, DevTools
console, walk library -> book -> group start/join; no "requires
'TrustedHTML' assignment" messages.

## 11. Implementation chunks

1. `fix(reader): enforce trusted types in the csp`
   (`headers.ts`, exact-string update in `server-handler.node.test.ts`, CSP
   string in `apps/reader/README.md` so `readme.node.test.ts` stays green)
2. `test(reader): assert trusted types directives and a sink-free bundle`
   (`server-handler.node.test.ts` new cases, `build-output.node.test.ts`
   tripwire)
3. `test(reader): fail e2e on trusted types violations`
   (`e2e/helpers/fixtures.ts`, new `e2e/trusted-types.spec.ts`)
4. `docs(reader): document trusted types enforcement`
   (README "Trusted Types" paragraph and e2e wording, `readme.node.test.ts`
   assertion, `docs/conventions.md` rule)
