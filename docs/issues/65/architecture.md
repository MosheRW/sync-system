# Architecture: #65 fix release namespace, npm identity wording, gitleaks false positives

Path: fast. Spec: [`spec.md`](spec.md).

## Repo layout

`single`-checkout pnpm monorepo (no submodules, no other repo involved).
Touched: root docs (`README.md`, `RELEASING.md`, `SECURITY.md`,
`docs/*`), the four group `CHANGELOG.md` files, a new root
`.gitleaksignore`, and `apps/sync-server/test/release-files.test.ts`.
Checks: `pnpm lint` (Prettier and `check-links` cover the docs),
`pnpm typecheck`, `pnpm test`, plus the pinned gitleaks scan.

## Decisions

- [ADR 0022](../../decisions/0022-secret-scan-suppressions.md) (Proposed):
  how secret-scan false positives are suppressed. Recommended: **option 1**,
  per-finding fingerprints in a committed `.gitleaksignore`, scope enforced by
  a test. Alternatives: path allowlist in `.gitleaks.toml` (2), value-pattern
  allowlist plus fingerprints (3), fingerprints plus inline `gitleaks:allow`
  for new fixtures (4).

Decided here (no ADR needed, they are factual corrections):

- **Historical records under `docs/issues/*` are not touched** (they record
  what was believed at the time; spec default).
- **ADR 0017 is amended, not rewritten**: the three places that name the Docker
  Hub repo or login user are corrected in place, a `- Amended by: #65` header
  line and a closing `## Amendment (#65, 2026-11-24)` section record what
  changed and why. The decision (A1, B1, C1, D1) is unchanged.
- **ADR 0016 gets the same kind of amendment** for its sentence "`npm whoami`
  must print `mosherw`" (the spec's "similar wording elsewhere").
- **`docs/roadmap.md`**: the 9c Gate 1 entry is a dated record, so its
  `docker.io/...` name is corrected and marked "(namespace corrected by #65)"
  rather than silently rewritten.
- **GHCR login stays `-u mosherw`** (GitHub user MosheRW). **Docker Hub login
  becomes `-u moshewin`** (assumption: `moshewin` is the Docker Hub *user*,
  not an org; see Questions).
- **Gitleaks image pinned by tag and digest** in `RELEASING.md`, like the
  Node image: `zricethezav/gitleaks:v8.24.0@sha256:2bcceac45179b3a91bff11a824d0fb952585b429e54fc928728b1d4d5c3e5176`
  (the multi-arch index digest; `docker buildx imagetools inspect` shows
  amd64, arm64 and a provenance attestation). Verified: the scan with this
  reference and the 16 fingerprints reports `no leaks found`.

## Approach

1. **Docker Hub namespace.** Replace every `docker.io/mosherw/sync-system-server`
   and Docker Hub `mosherw/sync-system-server` with
   `docker.io/moshewin/sync-system-server` / `moshewin/sync-system-server`
   outside `docs/issues/`. `ghcr.io/mosherw/...` and `@mosherw/...` stay.
2. **npm identity.** Two kinds of fix:
   - Step 0 checklist wording: `npm whoami` prints **your** npm user
     (`moshe-winberg`); `npm org ls mosherw` lists you as `owner`;
     `npm access list packages @mosherw` stays (the test pins it).
   - **Functional bug in step 4** (found while planning, not in the spec):
     the publish block runs
     `[ "$(docker exec "$C" npm whoami)" = mosherw ] || { echo 'npm whoami is not mosherw'; exit 1; }`.
     With a token of user `moshe-winberg` this always fails, so the first
     publish could never pass this line. It becomes
     `= moshe-winberg` with the matching message. (Not `npm org ls`: a
     granular publish token may lack org read permission, and the check must
     not need more token scope.)
3. **Gitleaks.** Commit `.gitleaksignore` (16 fingerprints below, grouped
   under `#` comments: "test fixtures" and "public JWT header constant").
   Gitleaks reads `.gitleaksignore` from the scanned repo's root with no flag
   (verified on a clone in the container, working dir `/`). Step 0 gets the
   exact command, Git Bash safe like the dry run's `cygpath` pattern:

   ```sh
   ( set -euo pipefail
     export MSYS_NO_PATHCONV=1
     D="$(pwd)"; if command -v cygpath >/dev/null; then D="$(cygpath -m "$D")"; fi
     docker run --rm -v "$D:/repo:ro" "$GITLEAKS_IMAGE" git /repo --redact
   )
   ```

   with `GITLEAKS_IMAGE='zricethezav/gitleaks:v8.24.0@sha256:2bcc...5176'`
   set in "Before you start" next to `NODE_IMAGE` (one place to bump), and
   the text: run from the repo root on an up-to-date `main`; it must print
   `no leaks found`; a new finding is either a real secret (stop: rotate it,
   history is not rewritten without a decision) or a test value (add its
   fingerprint per ADR 0022 in a reviewed PR).
4. **Regression test** in `apps/sync-server/test/release-files.test.ts`
   (existing pattern: "no credentials or old names in tracked files"):
   - no tracked file outside `docs/issues/` contains `docker.io/mosherw` or a
     `mosherw/sync-system-server` not preceded by `ghcr.io/` or `@`
     (ADR 0017's amendment note must therefore say "the namespace `mosherw`"
     without the full old reference);
   - the step 6 block logs in with `docker login docker.io -u moshewin` and
     tags `docker.io/moshewin/sync-system-server`;
   - the publish block compares `npm whoami` to `moshe-winberg`; step 0
     contains `npm org ls mosherw`;
   - step 0 runs gitleaks with an image pinned as
     `zricethezav/gitleaks:v8.24.0@sha256:<64 hex>` and `--redact`, read-only
     mount (`:/repo:ro`);
   - `.gitleaksignore`: every non-comment, non-blank line matches
     `^[0-9a-f]{40}:[^:]+:[a-z0-9-]+:\d+$`, and its file is under a `test/`
     directory, or it is exactly the `jwt.ts` line 10 entry (ADR 0022 scope).
   No test pins Docker Hub names today; `scripts/release/pack-check.test.ts`
   only pins npm package names and needs no change.

Rejected: rewriting history (decided against at #37); editing fixtures or
`jwt.ts` (out of scope); exempting ADR 0017 from the name check instead of
correcting it (the operator-facing name would stay wrong in an accepted ADR).

## Files to create / modify

| Path | Change |
|---|---|
| `.gitleaksignore` (new) | 16 fingerprints with `#` group comments |
| `docs/decisions/0022-secret-scan-suppressions.md` (new, this PR) | Proposed → Accepted in chunk 1 |
| `docs/conventions.md` | Server image row → `docker.io/moshewin/...`; new row "Secret scan" (pinned gitleaks, `.gitleaksignore` fingerprints, ADR 0022) |
| `docs/decisions/0017-server-image-publishing.md` | Correct lines 12, 69 (login user for Docker Hub), 103; `Amended by` header; amendment section |
| `docs/decisions/0016-versioning-and-npm-release.md` | `npm whoami` sentence → `moshe-winberg`, member/owner of org `mosherw`; amendment section |
| `RELEASING.md` | `GITLEAKS_IMAGE` in "Before you start"; step 0 npm wording, Docker Hub repo name, scan block; step 4 `whoami` check; step 6 Docker Hub login user, tags, inspect, token scope text (line 362) |
| `README.md` | Package table mirror name (line 16) |
| `SECURITY.md` | Mirror name (lines 12-13) |
| `docs/operator-guide.md` | Registry table (line 21), upgrade note (lines 724-725) |
| `docs/roadmap.md` | 9c Gate 1 entry: corrected name, marked "(namespace corrected by #65)" |
| `apps/sync-server/CHANGELOG.md`, `packages/client/CHANGELOG.md`, `packages/protocol/CHANGELOG.md`, `packages/react/CHANGELOG.md` | Mirror name in the unreleased 1.0.0 entry |
| `apps/sync-server/test/release-files.test.ts` | Regression tests above |

Not touched: `docs/issues/35/*`, `docs/issues/37/*`, `.changeset/config.json`,
package names, the Dockerfile, `compose*.yaml` (the uncommitted user edit to
`compose.yaml` must not be staged).

Data model changes: none. Contracts: none.
Docker impact: none to images or compose; only the push target and the
documented scan image change.
Docs impact: the files above are all docs; no separate docs chunk beyond them.

## Evidence (gitleaks v8.24.0, 730 commits, `--redact`)

Every flagged line was read at its commit (values not reproduced here). All
16 are `generic-api-key`:

| Fingerprint | Kind |
|---|---|
| `09c7cacfc5432e2293a101649d0e40e009aa52f6:apps/sync-server/src/tokens/jwt.ts:generic-api-key:10` | public JWT header constant (decodes to `{"alg":"HS256","typ":"JWT"}`) |
| `1119d8e1f6919094852ddcfa75c3141afb0913f2:apps/sync-server/test/main-redis.redis.test.ts:generic-api-key:11` | `SENTINEL-tok-...` test token secret |
| `1119d8e1f6919094852ddcfa75c3141afb0913f2:apps/sync-server/test/main-redis.redis.test.ts:generic-api-key:39` | `SENTINEL-key-...` test API key |
| `2b568db042d5c68f3ead74fafc319211acd5c3f6:apps/sync-server/test/main.test.ts:generic-api-key:13` | `SENTINEL-main-key-...` |
| `424ea82b134cbe27ad7dd13a992aa69ae72f044f:packages/client/test/ssr-import.test.ts:generic-api-key:70` | `test-api-key-ssr-...` |
| `445aab3742a8d3c0cd0535341e0d3eca39fa3224:apps/sync-server/test/restart-process.int.test.ts:generic-api-key:12` | base64 test token secret; appears in no other file in any commit |
| `a84b9fd333203531d042387366a59ce042e76285:apps/sync-server/test/config-cases.ts:generic-api-key:21` | `SENTINEL-APIKEY-other-...` |
| `ab49e772807b7b83b96ad36745c9b054ce09d6bd:packages/client/test/integration/ws-safety.int.test.ts:generic-api-key:50` | `test-api-key-ws-safety-...` |
| `ab49e772807b7b83b96ad36745c9b054ce09d6bd:packages/client/test/integration/ws-safety.int.test.ts:generic-api-key:71` | same value |
| `ac7f8f98f8b22081e606616e14442b4f2ac90fd1:apps/sync-server/test/privacy.int.test.ts:generic-api-key:17` | `SENTINEL-BADKEY-...` |
| `b21afe95ce9274d36a8f813b79ba1a009ac7ea58:apps/sync-server/test/apps-config.test.ts:generic-api-key:11` | `key-a-0123456789-...` |
| `b21afe95ce9274d36a8f813b79ba1a009ac7ea58:apps/sync-server/test/apps-config.test.ts:generic-api-key:12` | `key-b-0123456789-...` |
| `b9fd00a13d628451d6b20fd1e756743d131a3e4e:apps/sync-server/test/multi-process.redis.test.ts:generic-api-key:14` | base64 test token secret under a "Test-only values" comment; appears in no other file in any commit |
| `e2522ada1c463ded5aca4db76600dcbf1b498ea6:apps/sync-server/test/load.test.ts:generic-api-key:17` | `key-a-0123456789-...` |
| `e2522ada1c463ded5aca4db76600dcbf1b498ea6:apps/sync-server/test/load.test.ts:generic-api-key:18` | `key-b-0123456789-...` |
| `ee1859dab9fd304bcb0bf16b4f10e8164d3882c9:apps/sync-server/test/main.test.ts:generic-api-key:16` | `SENTINEL-tok-...` |

With exactly these 16 lines (with or without `#` comments) the scan reports
`no leaks found`, both via `-i` and from a root `.gitleaksignore` without a
flag.

## Risks / edge cases

- The engineer's own commits are scanned too: no commit may add a
  secret-shaped literal (the fingerprint file holds none). The final check
  re-runs the full scan on the branch.
- A fingerprint suppresses one line of one commit only; if a flagged fixture
  is moved or copied in a later commit, it is a new finding (correct
  fail-closed behaviour, handled per ADR 0022).
- `.gitleaksignore` is itself an attack surface (hiding a real secret): kept
  narrow by the scope test and reviewed by `security` in every PR that
  touches it.
- Docker Hub login user `moshewin` is an assumption from the repo URL.
- Prettier formats Markdown tables; run `pnpm format` before committing docs.

## Security

Security-sensitive: yes

- Secret-scan suppression (`.gitleaksignore`, ADR 0022): what the release
  gate's secret scan stops reporting.
- Release credential checks: the `npm whoami` gate in the publish block and
  the Docker Hub login user (which account the tokens are used with).
- Supply chain: a new pinned third-party image (gitleaks) run over the repo
  (read-only mount, no network need, no credentials passed).

## Implementer model

Implementer model: opus
Reason: security-sensitive (secret-scan suppression, release credential
gates), an open ADR, and about 14 files across docs and a release test.

## Test plan

| AC | Check |
|---|---|
| No Docker Hub `mosherw` left outside `docs/issues/` | new tracked-files test; `git grep -n "docker.io/mosherw"` empty outside `docs/issues/` |
| Known files updated | the same test plus review of the listed files |
| GHCR and npm names unchanged | existing tests (package names, changesets, `@mosherw` scope); `git grep -c "ghcr.io/mosherw"` same count as on `main` |
| ADR 0017 amendment | review: `Amended by` line, amendment section, decision text unchanged |
| npm wording | new test asserts `moshe-winberg` in the publish check and `npm org ls mosherw` in step 0 |
| `.gitleaksignore`, clean full scan | run the pinned command from step 0 on the branch: `no leaks found`, exit 0; new scope test |
| Step 0 documents the pinned scan | new test (pinned reference with digest, `--redact`, `:ro`) |
| Existing release checks pass | `pnpm lint`, `pnpm typecheck`, `pnpm test` (the repo's local Docker CI if used for other PRs) |

## Implementation chunks

1. `docs(adr): accept 0022 secret-scan suppressions` (status per the user's
   Gate 2 choice; `docs/conventions.md` "Secret scan" row)
2. `chore(release): add gitleaksignore for reviewed false positives`
3. `fix(release): use the moshewin docker hub namespace` (RELEASING.md step 0
   and step 6, README, SECURITY, operator guide, conventions image row,
   CHANGELOGs, roadmap entry, ADR 0017 amendment)
4. `fix(release): check the real npm user before publishing` (step 0
   wording, step 4 `whoami` check, ADR 0016 amendment)
5. `docs(release): run the pinned gitleaks scan in step 0`
6. `test(release): guard registry names, npm user and gitleaks scope`

If the user picks option 2, 3 or 4 of ADR 0022, chunk 2 changes to match
(`.gitleaks.toml` and/or a convention note) and chunk 6's scope test follows
the chosen rule.
