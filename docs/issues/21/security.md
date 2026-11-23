# Security review (plan): #21 fix(reader): enforce trusted types in the csp

Mode: plan. Reviewed: [spec.md](spec.md), [architecture.md](architecture.md),
`apps/reader/server/headers.ts`, `apps/reader/e2e/helpers/fixtures.ts`,
`apps/reader/src/content/zod.ts`, `packages/protocol/src/jitless.ts`,
source finding F10 in [`docs/issues/19/security.md`](../19/security.md).

**Result: PASS** (0 critical, 0 high, 0 medium, 2 low advisories).

## 1. Assets and trust boundaries

- **Asset:** participant tokens in the reader's `sessionStorage` (#24) and
  the integrity of the shared reading position. A DOM XSS in the reader
  origin could read the tokens and act as the participant (or leader).
- **Boundary:** untrusted content enters the page from `?src` book origins
  (ADR 0006) and from the sync server (WebSocket messages). Both are parsed
  by zod schemas and rendered by React as text; no HTML sink is used.
- **Control being added:** browser-enforced Trusted Types, a
  defence-in-depth layer on top of the existing strict CSP (no inline
  script, no eval, `'self'` only). The single CSP source is
  `contentSecurityPolicy()` in `apps/reader/server/headers.ts`; no `<meta>`
  CSP exists, so there is no second policy to keep in sync.

## 2. Threats (STRIDE, brief)

| Threat | Who / how | Effect of this change |
|---|---|---|
| Tampering / Elevation (DOM XSS) | Hostile book content or a future code bug reaching `innerHTML`, `srcdoc`, `script.src`, `eval` etc. | Sink assignment of a plain string throws in Chromium; the attack fails closed. |
| Policy laundering | Injected or future code calls `trustedTypes.createPolicy('default', …)` to turn strings into trusted values. | Blocked by `trusted-types 'none'`: no policy name, including `default`, can be created. |
| Denial of service (self-inflicted) | A dependency (React, zod JIT, Vite runtime) hits a sink on a code path the tests don't reach, breaking the app for users. | Mitigated by the bundle sink tripwire and the guarded e2e tour; residual risk on unreached paths is availability, not confidentiality. |
| Info disclosure | None new: no new input, endpoint, data, log or dependency. | n/a |

## 3. Findings in the plan

No critical, high or medium findings. The design choices are the secure
ones: `require-trusted-types-for 'script'` plus `trusted-types 'none'`
(zero policies, no `*`, no `'allow-duplicates'`), constant directives that
no input reaches (C2 re-serialisation unaffected), CSP on every response
including 4xx/5xx/`clientError` (C1 unchanged). I checked the
investigation claims against the tree: no `serviceWorker.register`,
`new Worker`, `importScripts`, `innerHTML`, `dangerouslySetInnerHTML`,
`createPolicy` or string `setTimeout` in `apps/reader/src` or
`packages/*/src`; zod `jitless` is set in `src/content/zod.ts` and via
`buildJitless` in `packages/protocol`.

| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| L1 | Low | `apps/reader/e2e/helpers/fixtures.ts` (existing guard), architecture section 5 | The guard reads `window.__csp` only at teardown and skips pages that are already closed (`if (page.isClosed()) continue`). A Trusted Types violation on a page a spec closes itself, or one that navigates away (new document resets `__csp`), is never reported, so AC3 could pass with a real violation. | When extending the guard, also forward each `securitypolicyviolation` to the test side as it happens (e.g. `page.exposeBinding('__cspReport', …)` called from the init-script listener, or a `console.error` the existing console listener catches) instead of relying only on the teardown read. |
| L2 | Low | architecture section 5, `build-output.node.test.ts` tripwire | The tripwire lists HTML sinks but not script-URL/script sinks that Trusted Types also covers: `serviceWorker.register`, `setAttribute('src'`/`'srcdoc'`, `.src=` on a created `script`, string `setTimeout`/`setInterval`, `javascript:` URLs. Today none exist, so this is only future-proofing. | Add `serviceWorker.register`, `javascript:` and a `createElement("script")` check to the tripwire's forbidden list (the React `<script>` site stays in the known-site allowance). |

## 4. Required controls (part of the plan)

The engineer must implement all of these; code mode will check each one.

- **C1** `contentSecurityPolicy()` emits exactly `require-trusted-types-for 'script'`
  and `trusted-types 'none'`, each once, as constant strings, for every
  combination of `?src` origins and sync URL. No `*`, no
  `'allow-duplicates'`, no policy names.
- **C2** No Trusted Types policy is created anywhere (app or tests that run
  in the app page); no `default` policy, no sanitiser dependency added.
  No new dependency at all.
- **C3** The header reaches every response kind already covered by the
  existing C1 (200 HTML, static assets, 404, 4xx/5xx, `clientError`); the
  e2e header check covers at least `/`, one asset and a 404.
- **C4** The e2e guard fails on: any `securitypolicyviolation` event
  (including `require-trusted-types-for` / `trusted-types`), any CSP or
  Trusted Types console error, and any uncaught `TypeError` naming
  `TrustedHTML` / `TrustedScript` / `TrustedScriptURL`. The guard must not
  be weakened or given an allow-list for any violation; a violation caused
  by test tooling is reported as a deviation.
- **C5** A positive control on an unguarded page proves Chromium enforces
  both directives (`innerHTML` string assignment throws;
  `trustedTypes.createPolicy` throws).
- **C6** The bundle tripwire fails on any new sink site or any
  `createPolicy`/`trustedTypes` reference (plus L2 if adopted).
- **C7** zod stays `jitless` (reader `src/content/zod.ts` and
  `buildJitless`); the engineer confirms locally (not committed) that
  disabling it makes the e2e guard fail.
- **C8** README and `docs/conventions.md` state: no policy exists,
  `trusted-types 'none'` forbids creating one, and adding one requires a
  named policy, a README note and a security plan review.
- **C9** AC3 evidence comes from the full Playwright run against the built
  reader in the local Docker CI (fresh clone, no bind mounts); results
  summarised on the PR.

## 5. What code mode will check

- Diff of `headers.ts`: only the two constant directives added; C2
  origin re-check logic untouched.
- Unit tests assert C1 (presence, once each, no `*`/`'allow-duplicates'`)
  with and without origins/sync URL.
- `fixtures.ts`: C4 implemented without allow-lists; L1 addressed or noted.
- `trusted-types.spec.ts`: C3 and C5 present; the tour covers library, each
  bundled book, paging, unknown book, 404, QR.
- Tripwire (C6) and that no `createPolicy`, `innerHTML`,
  `dangerouslySetInnerHTML`, `eval`/`new Function` were introduced in
  source.
- No dependency or lockfile change; gitleaks, semgrep (changed files) and
  `npm audit --audit-level=high` if installed.
- README/conventions wording (C8) and the posted local-CI e2e result (C9).
