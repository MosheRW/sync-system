# Security review (plan): #92 release:dry-run for an already-published version

Reviewed: [architecture.md](architecture.md) (commit 50668fc), [spec.md](spec.md),
`scripts/release/dry-run.ts`, `lib.ts`, `pack-check.ts`, and `RELEASING.md`
steps 2, 4, 5, R2 and "Dry run (QA)".

**Verdict: PASS**: critical 0, high 0, medium 0, low 4 (plus one
non-security note). The required controls below are part of the plan.

## Assets and trust boundaries

- **Asset:** the integrity of the published npm tarballs and of the QA signal
  "this branch reproduces what is on npm". `release:dry-run` gates nothing by
  itself (step 4 publishes the step 2 tarballs of `MODE=release`), but a false
  "ok" would hide a diverged or tampered release from QA.
- **Boundary 1:** the build container (step 2, no credential) to
  `https://registry.npmjs.org` over TLS. The registry response is untrusted
  input.
- **Boundary 2:** the process environment and `.npmrc` (could carry a
  registry override or, on a developer host, a token). The new code must not
  read either.
- No secret is in scope: step 2 has no token and no `.npmrc` (RELEASING.md
  lines 23-25, 938-941). The step 4 publish flow is not changed.

## Threats (STRIDE, brief)

| Threat | Who / how | Plan's answer |
|---|---|---|
| Spoofing | Env or `.npmrc` points the check at another registry that returns a matching hash | Fixed constant origin, no env/`.npmrc` read, `redirect: 'error'` |
| Tampering | Registry or a MITM returns a crafted body | TLS; only `dist.integrity` read, shape-checked; mismatch fails |
| Repudiation / silent skip | A lookup error is read as "not published" or "matches", so a check is skipped | Only `404` means not published, and `404` falls back to the stricter `npm publish --dry-run`; everything else fails the run |
| Information disclosure | A token sent with the request | `fetch` never reads `.npmrc`; no auth header; anonymous public read |
| DoS | Hanging or huge response | 15 s timeout, 1 MiB cap, no retry |
| Elevation | Untrusted text printed to the terminal | Only the regex-checked integrity is printed |

## Findings in the plan

Fail-closed design, URL construction, redirect and timeout handling,
credential isolation and the comparison itself are sound:

- **Fail closed:** correct. Only `404` leads to "not published", and that
  path runs today's `npm publish --dry-run`, which itself contacts the registry
  and refuses an existing version. So a stale or wrong `404` still fails.
  Every other outcome throws.
- **The comparison proves identity:** `dist.integrity` is the SRI sha512 that
  npm computed over the exact uploaded tarball bytes. Equal SHA-512 values of
  the full `.tgz` bytes mean byte-identical tarballs (no practical collision).
  Requiring a single `sha512-` value (no `sha1-`, no multi-hash list) prevents
  a downgrade to a weaker algorithm. Residual trust: the registry's answer
  about its own content, the same trust step 5 already places in
  `npm view ... dist.integrity`. npm versions are immutable, so no stale `200`
  with an old hash can occur.
- **Loss from skipping `npm publish --dry-run` on the published path:** none.
  npm already accepted those exact bytes when they were published.

| # | Severity | Location | Issue / attack scenario | Fix (required control) |
|---|---|---|---|---|
| L1 | Low | architecture.md "Lookup details" | The version endpoint resolves dist-tags: `GET /@types%2Fnode/latest` returns `200` (checked live while reviewing). Today the version regex blocks this, but a later loosening of the regex, or a registry-side alias or normalisation, would compare against the wrong version's hash. That could give a false match or a confusing mismatch. | **C7**: after parsing, require `body.name === name` and `body.version === version` (exact strings), else throw. |
| L2 | Low | "Lookup details", 1 MiB cap | If the cap is built as `await res.text()` and then checks length, or trusts `Content-Length` only, the whole body is buffered first, so the cap does nothing. Low risk: the endpoint is a fixed TLS origin. | **C5**: read `res.body` as a stream, count bytes, and cancel and throw once the total exceeds 1 MiB. A `Content-Length` over the cap may fail early, but the streamed count is authoritative. Keep the same timeout signal over the body read. |
| L3 | Low | Error line `registry lookup ... failed: <reason>` | Node's `JSON.parse` errors and `statusText` can echo registry-controlled bytes, so terminal escape sequences or misleading text could reach the QA log. | **C8**: `<reason>` is built from fixed strings plus the numeric status, or the error `name` / `code` for network errors. Never include body text, `statusText`, or `JSON.parse` / `fetch` messages verbatim. |
| L4 | Low | `fetch` TLS | `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment would turn off certificate checks for this one supply-chain read. The step 2 container doesn't set it; a developer host might. | Advisory: if `process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'`, throw before fetching. |
| N1 | Note (not security) | RELEASING.md R2 (reader release) | R2 runs step 2 with `MODE=dry-run`. After #92, a reader tag whose `packages/*` changed without a version bump fails with an integrity mismatch, where today it fails with "cannot publish over". The R2 operator may then be tempted to bypass checks. | Out of #92's scope (spec limits RELEASING.md edits). Architect/orchestrator: decide whether R2 needs a follow-up. |

## Required controls (the engineer must implement them; I check them in code mode)

- **C1 Fail closed:** `lookupPublished` returns `{ published: false }` only for
  `status === 404`. It returns `{ published: true, integrity }` only for
  `status === 200` with a body that passes all shape checks. Every other
  outcome throws: rejection, abort/timeout, any other status (including
  3xx/304), invalid JSON, oversize, bad shape. `dryRunPackages` does not catch
  and downgrade lookup errors to "skip" or "ok". After an error, no `ok` line
  and no `INTEGRITY.txt` echo print, and the exit code is non-zero.
- **C2 Fixed origin:** `REGISTRY = 'https://registry.npmjs.org'` constant. No
  read of `npm_config_registry`, `npm_config_*`, `.npmrc` or any other env for
  the URL. A test sets `npm_config_registry` and asserts the URL is unchanged.
- **C3 URL input validation:** the version must match
  `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` before use, and the throw happens before
  `fetch`. The name must be one of `PUBLISHED`; encode only the scope slash as
  `%2F`. Assert that the built `URL` has origin `REGISTRY` and the exact
  expected pathname. Use the same version string for the tarball file name
  and the lookup.
- **C4 Request options:** `redirect: 'error'`, `credentials` not set,
  no `Authorization` header or any header besides `Accept`,
  `signal: AbortSignal.timeout(15_000)`, no retry loop.
- **C5 Streamed size cap** (L2).
- **C6 Shape check:** `dist.integrity` is a string matching
  `^sha512-[A-Za-z0-9+/]+={0,2}$` (one value). Compare with strict string
  equality to the local `sha512Integrity(bytes)` of the exact file in
  `.release-out`. No `shasum`/sha1 fallback.
- **C7 Echo check** of `name` and `version` (L1).
- **C8 Sanitized error reasons** (L3); print the registry integrity only after
  C6 passes.
- **C9 Tests never touch the network:** `dry-run.ts` keeps the
  `import.meta.main` guard. Tests inject `fetchImpl`, `lookup` and
  `publishDryRun`, and no default `fetch` is reached on import (`pnpm test`
  runs inside the step 2 container).
- **C10 No new dependency**, and `npm publish --dry-run` args unchanged
  (`--ignore-scripts`, argument array, no shell).

## What I will check in code mode

- C1 to C10 above in the diff of `dry-run.ts` and `lib.ts`, and the tests for
  each error class in the plan's test table plus the C2 and C7 tests.
- No token, `.npmrc` or env read was added. No change to step 4 or `pack-check.ts`.
- The RELEASING.md "Dry run (QA)" item 1 text states that a registry error or
  mismatch fails the run, with no advice to skip the check.
- gitleaks on the PR commits, semgrep on the changed files, `npm audit`
  (high), as far as these tools are installed (gitleaks and semgrep were
  not on PATH at plan time).
