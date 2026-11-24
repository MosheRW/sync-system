# 0022. Secret-scan suppressions

- Status: Accepted (Gate 2, 2026-11-24: user chose the recommended option 1)
- Date: 2026-11-24
- Issue: #65

## Context

`RELEASING.md` step 0 requires a clean `gitleaks git --redact` over the full
history before the repo goes public. With the pinned
`zricethezav/gitleaks:v8.24.0` (default rules) the scan of 730 commits
reports 16 `generic-api-key` findings. Each was checked by hand at its
commit (`docs/issues/65/architecture.md`, "Evidence"):

- 15 are test-only fixture constants in `apps/sync-server/test/*` and
  `packages/client/test/*`. Most follow the repo's fixture style
  (`SENTINEL-...`, `...-0123456789-0123456789`); two are random-looking
  base64 `TOKEN_SECRET` values that appear in no file outside their own
  test, in any commit.
- 1 is `TOKEN_HEADER_SEGMENT` in `apps/sync-server/src/tokens/jwt.ts:10`, the
  public base64url of `{"alg":"HS256","typ":"JWT"}`.

History is not rewritten (#37 Gate 2), and the spec forbids editing the code
or tests to dodge the scanner. So the findings must be suppressed. Future
test fixtures will trip the generic rule again, and the security reviewer
scans every PR range with gitleaks, so the choice is also a standing policy.

## Options

1. **Per-finding fingerprints in a committed `.gitleaksignore`.** One line
   per finding (`<commit>:<file>:<rule>:<line>`), grouped under `#`
   comments. Gitleaks reads it from the scanned repo's root by default (also
   for the PR-range scan), so no extra flag is needed.
   Pros: each suppression is exact and reviewed; a real secret committed
   later in a test file still fails the scan; no config to keep in step with
   gitleaks' default rules. Cons: a new fixture that trips the rule needs a
   new line, which can only be written after the commit exists (a follow-up
   commit in the same PR); the file grows over time.
2. **`.gitleaks.toml` extending the default config with a path allowlist**
   (`[extend] useDefault = true`, allowlist `(^|/)test/`). Pros: no
   maintenance for future fixtures. Cons: every test directory becomes a
   blind spot for real secrets (a pasted real token or `.env` in `test/`
   passes); `jwt.ts` still needs a fingerprint; a config file changes which
   rules run, so a reviewer has to read it with care.
3. **`.gitleaks.toml` with a value-pattern allowlist** for the fixture
   style (`SENTINEL-`, `0123456789-0123456789`), plus fingerprints for the
   rest (the two base64 secrets and `jwt.ts`). Pros: future fixtures that
   follow the style need nothing. Cons: two mechanisms; anyone can make a
   real secret pass by adding the marker; still needs fingerprints.
4. **Fingerprints for history plus inline `gitleaks:allow` comments for new
   fixtures.** Pros: no SHA needed for new lines, visible in the diff. Cons:
   two mechanisms; the comment travels with the line, so a later edit that
   puts a real value on that line is not flagged.

## Decision

**1** (accepted at Gate 2, 2026-11-24). The scan is a release gate; it
should fail closed on anything new, and the cost (one reviewed line per new
fixture hit) is small because the scan runs by hand at release time and per
PR by the security reviewer. A test keeps the file's scope narrow: every
entry must name a file under a `test/` directory or the one `jwt.ts` header
line, and its rule must be `generic-api-key` (security plan review M1).
Suppressing any other rule (for example `private-key`, `npm-access-token`,
`github-pat`) needs an amendment of this ADR first.

## Consequences

- `.gitleaksignore` is committed at the repo root with the 16 fingerprints.
- When a PR adds a fixture that the scan flags, the PR adds its fingerprint
  in a separate commit, and the security reviewer checks the value is a
  test value. Fingerprints depend on commit SHAs: a squash or rebase merge
  changes them, so a hit that only exists on `main` after a squash needs its
  own line then (this repo merges with merge commits, which keep SHAs).
- `docs/conventions.md` records the rule; `RELEASING.md` step 0 runs the
  pinned scan, which picks the file up with no flag.
