# Architecture: #92 fix(release): release:dry-run cannot run for an already-published version

Path: fast. Spec: [spec.md](spec.md).

## Repo layout

`monorepo` (pnpm workspace, no submodules). Touched: the root release
tooling only, `scripts/release/` (no package under `packages/*` or `apps/*`
changes, so no changeset). Checks: root `pnpm lint`, `pnpm typecheck`,
`pnpm test` (which runs `node --test "scripts/release/*.test.ts"`).

Decisions: none open (no ADR; ADR 0020/0021 stay as they are).

## Approach

`release:dry-run` keeps packing and checking exactly as today
(`packAndCheck` into `.release-out`, `INTEGRITY.txt`). Then, per published
package in publish order, it asks the npm registry whether the exact
`<name>@<version>` exists:

| Registry answer for `GET https://registry.npmjs.org/<@scope%2Fname>/<version>` | Outcome |
|---|---|
| `404` | **Not published**: run `npm publish <tgz> --dry-run --ignore-scripts --access public` exactly as today. |
| `200` with a JSON body whose `dist.integrity` is one `sha512-<base64>` value | **Published**: skip `npm publish --dry-run`; compare the local tarball's `sha512-...` with `dist.integrity` (exact string equality). Equal: print `<file>: <name>@<version> already on npm, integrity matches`. Different: record a problem. |
| Anything else: network error, DNS failure, timeout (15 s), any other status (3xx, 401, 403, 429, 5xx), a redirect, invalid JSON, a body over 1 MiB, `dist.integrity` missing, not a string, or not a single `sha512-` value | **Error**: print `release:dry-run: registry lookup for <name>@<version> failed: <reason>`, set exit code 1, stop. Never treated as "not published" and never as "matches". |

Only a `404` means "not published", and that case falls back to today's
stricter path, where `npm publish --dry-run` itself contacts the registry
and fails if the version exists after all (for example a CDN lag). So a
lookup problem can never skip a check silently: every non-`404`,
non-valid-`200` answer fails the run.

At the end: any integrity mismatch prints
`release:dry-run: <file>: local sha512-A differs from the published sha512-B of <name>@<version>`
(plus a hint: check out the released tag, or bump the version) and sets
exit code 1; `release:dry-run: ok (nothing was published)` and the
`INTEGRITY.txt` lines print only when every package passed. Mixed states
(some packages published, some not, after a partial step 4) are handled per
package.

Lookup details (fail closed, minimal surface):
- Registry URL is the constant `https://registry.npmjs.org` (the registry
  step 4 publishes to). It does **not** read `npm_config_registry`, `.npmrc`
  or any env, so the environment cannot point the check at another
  registry.
- Package names come only from `PUBLISHED`; the version from the packed
  manifest, validated against `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` before it
  goes into the URL (otherwise error). The scope slash is encoded as `%2F`.
- `fetch` (Node 24 global, no new dependency) with `redirect: 'error'`,
  `cache: 'no-store'`, `Accept: application/json`,
  `signal: AbortSignal.timeout(15_000)`, no credentials or auth headers.
- The registry body is parsed as untrusted data: only `dist.integrity` is
  read, shape-checked with
  `^sha512-[A-Za-z0-9+/]+={0,2}$`; it is printed only after that check.

Injectable for tests: the decision logic takes its side effects as
parameters, so tests never touch the network or npm:
`lookupPublished(name, version, fetchImpl = fetch)` and
`dryRunPackages(entries, { lookup, publishDryRun })`, where `main()` wires
the real `lookupPublished` and the real `run(npmCommand(), ...)` call.
`dry-run.ts` gets an `if (import.meta.main) main();` guard (the pattern of
`pack-check.ts`) so the test can import it.

Alternatives rejected:
- `npm view <name>@<version> dist.integrity` (as RELEASING.md step 5 does):
  `run()` inherits stderr, so "not found" (`E404`) and "registry
  unreachable" can only be told apart by changing `run` or parsing stderr
  text; npm also honours `npm_config_registry`. `fetch` gives an exact
  status code and is trivially mockable.
- `npm publish --dry-run` with `--force` or a temp version: changes what is
  checked and does not compare bytes with what users install.
- Skipping published packages without a comparison: hides a tampered or
  diverged release, fails AC2.

## Files to create / modify

- `scripts/release/lib.ts`: add `sha512Integrity(bytes)` (the
  `sha512-<base64>` value); `integrityLine` uses it (output unchanged).
- `scripts/release/dry-run.ts`: export `REGISTRY`, `registryVersionUrl`,
  `parsePublishedIntegrity`, `lookupPublished` (result
  `{ published: false } | { published: true; integrity: string }`, throws on
  every error), `dryRunPackages`; `main()` uses them; `import.meta.main`
  guard; header comment updated (#92).
- `scripts/release/dry-run.test.ts` (new): tests below, mocked `fetch`
  and injected `publishDryRun`.
- `RELEASING.md`: only item 1 of "Dry run (QA)" (the step 2 dry-run text).
  Step 6 and every other section untouched (another session edits step 6).

`pack-check.ts` does not change. `docs/roadmap.md` is not touched.

## Contracts

No API or realtime contract. External read: the npm registry's public
version document (`GET /<@scope%2Fname>/<version>`, anonymous), of which
only `dist.integrity` is used. CLI contract of `pnpm release:dry-run`: exit
0 only if every package either passed `npm publish --dry-run` (unpublished)
or matched the published integrity; `.release-out` and `INTEGRITY.txt` are
unchanged in content and format, so step 2's `cp .release-out/* /out/` and
`cat /out/INTEGRITY.txt` keep working.

Docker impact: none (the step 2 build container already has network:
`pnpm install` and today's `npm publish --dry-run` both reach the registry).

Docs impact: `RELEASING.md` "Dry run (QA)" item 1 (what `release:dry-run`
does for a published version, and that a mismatch or registry error fails
the run). No `docs/conventions.md` change.

## Risks / edge cases

- **Byte reproducibility**: the comparison only means something where the
  tarball is reproducible, i.e. in the pinned step 2 container (ADR 0020,
  0021). On another host a mismatch may be an environment difference; the
  mismatch hint says to run it through the step 2 block.
- **Branch ahead of the release with the same version**: changed package
  code without a version bump now fails the dry run (intended, AC2); the
  hint says to bump the version or check out the tag.
- **Just-published version not visible yet (404)**: falls back to
  `npm publish --dry-run`, which fails loudly; re-run later.
- **Rate limit / registry outage**: fails the run (no retry loop; the QA
  re-runs). Acceptable for a manual QA step.
- Old packages with only `shasum` and no `sha512` integrity: not our case
  (all versions are new); treated as an error, never as a match.

## Security-sensitive areas

Security-sensitive: yes
- New outbound network read (registry `fetch`) in `scripts/release/dry-run.ts`:
  fixed origin, no redirects, timeout, size cap, no credentials, URL built
  from the constant package list and a validated version.
- Supply-chain check: the published-version path replaces
  `npm publish --dry-run` with an integrity comparison; it must fail closed
  on every registry error (only `404` means "not published").
- Untrusted registry JSON is parsed and partly printed (shape-checked first).
- No dependency change, no token, no `.npmrc`, no change to the real publish
  flow (step 4).

Implementer model: opus
Reason: security-sensitive (fail-closed registry lookup in a supply-chain
check), even though the change is small and follows `pack-check.ts`'s
pattern.

## Test plan

`scripts/release/dry-run.test.ts` (Node `node:test`, picked up by
`node --test "scripts/release/*.test.ts"` in `pnpm test`). No test touches
the network or npm: `fetch` is a stub returning `new Response(...)` or
rejecting; `publishDryRun` and `lookup` are recording stubs.

| Test | AC |
|---|---|
| `registryVersionUrl('@mosherw/sync-system-client', '1.0.0')` is `https://registry.npmjs.org/@mosherw%2Fsync-system-client/1.0.0`; an invalid version (`1.0`, `../x`, `1.0.0/..`) throws | 1, 2 |
| `lookupPublished`: `404` gives `{ published: false }`; `200` with a valid `dist.integrity` gives `{ published: true, integrity }`; the stub sees the URL, `redirect: 'error'`, no auth header | 1, 3 |
| `lookupPublished` throws (never returns "not published") for: `fetch` rejecting (network error), an abort/timeout, `500`, `503`, `429`, `403`, `301`, invalid JSON, oversized body, missing `dist`, non-string or non-`sha512` `dist.integrity` | 1, 2 |
| `dryRunPackages`, published and matching: no `publishDryRun` call, no problems, "integrity matches" line | 1, 4 |
| `dryRunPackages`, published and different: a mismatch problem naming the file and both values, no `publishDryRun` call | 2 |
| `dryRunPackages`, not published: `publishDryRun` called once per package with exactly `['publish', <out>/<file>, '--dry-run', '--ignore-scripts', '--access', 'public']`, in publish order | 3 |
| `dryRunPackages`, mixed (protocol published and matching, client and react not): one comparison, two publish dry runs | 1, 3 |
| `dryRunPackages`, `lookup` throws for one package: the error propagates (run fails), no package is reported ok after it | 2 |
| `sha512Integrity` equals the value in `integrityLine` for the same bytes | 1, 2 |

Manual check (QA, needs network, not in `pnpm test`): on the `v1.0.0` tag
with `MODE=dry-run`, run the step 2 block: it must pass and print three
"already on npm, integrity matches" lines. On the release PR branch of an
unpublished version it must still run `npm publish --dry-run` three times.

## Implementation chunks

1. `fix(release): compare published integrity in release:dry-run`
   (`lib.ts` helper, `dry-run.ts` lookup, decision logic and main guard)
2. `test(release): cover release:dry-run for a published version`
   (`dry-run.test.ts`)
3. `docs(release): describe release:dry-run for a published version`
   (`RELEASING.md` "Dry run (QA)" item 1 only)
