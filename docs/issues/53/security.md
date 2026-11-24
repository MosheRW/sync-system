# Security review (plan): #53 revised plan, ADR 0020

- Mode: plan, round 1 of the revised plan (head `4f2fa5a`)
- Scope: [ADR 0020](../../decisions/0020-deterministic-packed-manifests.md),
  [architecture.md](architecture.md) "Revision after QA r1", ADR 0019's note,
  `scripts/release/{lib,pack-check,dry-run}.ts`, `packages/*/package.json`,
  `pnpm-lock.yaml`, `apps/*/Dockerfile`, `.github/workflows/ci.yml`,
  `RELEASING.md` (pin bullet, step 2, step 4, Known limits). I also read
  pnpm 10.28.0's `createExportableManifest` (corepack cache, `dist/pnpm.cjs`).
- Verdict: **PASS**. No critical or high findings. Four low advisories. The
  required controls below are part of the plan.

## Assets and trust boundaries

- **Published bytes**: the three tarballs `pack:check --out` writes, their
  `INTEGRITY.txt`, the step 4 publish container (`npm publish <file>`, npm
  token), and the release notes values that consumers use to verify.
- **Release gate code**: `scripts/release/lib.ts` and `pack-check.ts`. They
  run in the build container, which has no credentials.
- **Dependency graph**: `pnpm-lock.yaml`, and the pinned pnpm (corepack hash
  in `packageManager`).
- **Base image pin**: `node:24@sha256:9d26…` in `RELEASING.md`. The bump
  procedure is the trust decision for every later release.

## Threats (brief)

| Who / what | Could do | Covered by |
|---|---|---|
| Non-deterministic packing | Two pack runs of one commit give different react bytes. A maintainer or consumer then can't tell a benign flip from a tampered rebuild, and learns to ignore mismatches | D1 removes the trigger. The guard keeps it from coming back. The 32-run repeat is the evidence |
| A future manifest edit | Adds a second `workspace:` range, so the race returns silently | `checkWorkspaceRanges` in `pack:check` (R1, R2) |
| A pnpm hook (`.pnpmfile.cjs` `beforePacking`) | Rewrites the packed manifest after every source-level check | `checkManifest` on the packed manifest (partly). L4 |
| A malicious or mistaken digest bump | Swaps in an image with a different Node, zlib or toolchain | L1 and L2 in the pin procedure (R4, R5) |
| A lockfile edit | Smuggles in a re-resolution or a new package with the "remove one devDependency" change | R3 |

## Integrity chain under D1 (the main question)

It holds, and D1 does not change it. I checked:

- `packAndCheck` reads each kept file once (`readFileSync`). It parses that
  buffer and hashes the same buffer (`integrityLine`). The hashed bytes are
  the kept file.
- `pack:check --out` writes `INTEGRITY.txt` only when there are no problems.
  `dry-run.ts` does the same. Step 4 recomputes the sha512 from the copied
  files and diffs it against `INTEGRITY.txt`. `npm publish /release/<file>`
  uploads that file without repacking it. `verify` compares the registry's
  `dist.integrity`.
- D1 only adds a failure condition before `packAll`. Hashing, keeping,
  copying and publishing are unchanged. A failure exits 1 and writes no
  `INTEGRITY.txt`, so it fails closed.
- The race is real and confined as the architect says. In 10.28.0,
  `makePublishDependencies` uses `p-map-values`, which inserts keys in
  completion order. `replaceWorkspaceProtocol` awaits a disk read
  (`readAndCheckManifest`) only for `workspace:*|^|~` (and alias forms) and
  `workspace:./…`. Catalog and jsr conversions are synchronous. The top-level
  field order is safe: the three maps are assigned onto a copy that already
  has those keys, and `peerDependencies` is converted on its own afterwards.
  So the trigger is "two or more I/O-doing `workspace:` specs in one map".
  Today only react's `devDependencies` meets it.
- One caveat for the guard. `replaceWorkspaceProtocolPeerDependency` matches
  `depSpec.includes("workspace:")`, not `startsWith`. A peer range such as
  `"^1 || workspace:^"` also does I/O. See L1 and R2.

## Findings

No critical, high or medium findings.

| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| L1 | Low | architecture.md "Approach" step 2; `lib.ts` (new `checkWorkspaceRanges`) | The planned predicate is "values start with `workspace:`". For `peerDependencies`, pnpm's own converter uses `includes("workspace:")`, so a compound peer range could get past a `startsWith` guard and bring the race back with no error. The plan also doesn't say what happens when a `PUBLISHED` dir is missing from the input list, or when a dependency field isn't a plain object. Either case could make the check pass by default. Impact is reproducibility, not publish integrity, so this is low | Use `String(v).includes('workspace:')` for every map. It is conservative: it also counts specs that do no I/O, and that is fine. Iterate over `PUBLISHED` (by `dir`, and check `name`). Report a problem if a published package isn't found, or if a dependency field is present but isn't a plain object. See R2 |
| L2 | Low | ADR 0020 "Decision" L1; architecture.md step 3 pin bullet | "Attestation manifests present" and "`node --version` matches an official release" are too weak to be a provenance check. Any registry index can carry attestation manifests. A real version string doesn't prove the binary is official. The plan also doesn't tie the new digest to the official tag | Spell out the checks (R4): the digest is what `docker.io/library/node:24` (or the exact `24.x.y` tag) resolves to now, as shown by `docker buildx imagetools inspect`; the provenance names the Docker Official Images build; the version appears in `https://nodejs.org/dist/index.json` and is not older than the current pin; and the reviewer of the bump PR re-runs `inspect` themselves |
| L3 | Low | architecture.md step 3 (L2 text) and test plan step 4; `RELEASING.md` step 2 | "Run the dry run twice and require identical values" has a trap. Step 2 begins with `rm -rf "$H/out"`, so the second run deletes the first run's `INTEGRITY.txt`. If nobody saves it, the "comparison" is done from memory or the terminal scrollback | Before the second run, save the first run's file, for example `cp "$REL/out/INTEGRITY.txt" "$REL/integrity-run1.txt"`. Then compare by machine: `diff "$REL/integrity-run1.txt" "$REL/out/INTEGRITY.txt"` must print nothing. Each run uses a fresh container from the bundle, as step 2 already does. See R5 |
| L4 | Low | `pack-check.ts` (hardening, optional) | A pnpmfile `beforePacking` hook runs after every source-level check and can rewrite the packed manifest. That includes the root `.pnpmfile.cjs`, a `pnpmfile` / `global-pnpmfile` setting, and `npm_config_pnpmfile`. `checkManifest` checks only some packed fields (name, license, repository, `workspace:` and lifecycle scripts). Under D1 the project has no pnpmfile, so any pnpmfile that shows up is unexpected | Optional: make `pack:check` fail if `.pnpmfile.cjs` exists at the repo root, or if `npm_config_pnpmfile` / `npm_config_global_pnpmfile` is set. This states D1's "no hook" assumption as a check. If the user picks D2, drop this and use D2's order check instead |

Informational (no action): architecture.md says "the Dockerfiles already
copy … `packages/react/package.json`". Only `apps/reader/Dockerfile` does,
and the sync-server one does not copy react at all. Either way
`--frozen-lockfile` stays consistent after the lockfile change, so there is
no security impact.

## Required controls (the engineer implements these; QA and security check them)

- **R1. Guard placement.** `packAndCheck` runs `checkWorkspaceRanges` together
  with `checkPublishableSet`, before `packAll`, and returns
  `{ problems, integrity: [] }` when there are problems. That is the only
  entry point for `pack:check` (with and without `--out`), `release:dry-run`,
  CI's `Pack check` step and `RELEASING.md` step 2 (both modes). Add no flag,
  env variable or argument that skips it.
- **R2. Guard predicate.** It covers all four `DEPENDENCY_FIELDS`
  (`dependencies`, `devDependencies`, `optionalDependencies`,
  `peerDependencies`) of each `PUBLISHED` package's **source** manifest. It
  counts values where `String(v).includes('workspace:')` and reports at two
  or more in one map. It fails closed: it reports a missing published package
  and a non-object dependency field. The message names the package, the
  field, the dependency names, #53 and ADR 0020. Unit tests cover:
  - two in `devDependencies`, and two in `peerDependencies` including a
    compound peer range (`"^1 || workspace:^"`);
  - one per map accepted;
  - private packages ignored;
  - a missing published package reported;
  - `[]` for the real `workspacePackages()`.
- **R3. Lockfile.** Regenerate it with the pinned pnpm 10.28.0 (corepack).
  `git diff pnpm-lock.yaml` is exactly the removal of the three-line
  `'@mosherw/sync-system-protocol'` entry under `importers.packages/react.devDependencies`
  (`specifier: workspace:*`, `version: link:../protocol`). Nothing in
  `packages:` / `snapshots:` changes, and no `settings`, `overrides` or
  `pnpmfileChecksum` changes. `pnpm install --frozen-lockfile` and
  `pnpm audit --audit-level=high` pass in the pinned image. Any other diff:
  stop and report. Removing a `link:` entry adds no registry package, so
  there is no supply-chain exposure if the diff is exactly this.
- **R4. L1 in the pin bullet (prose; shell lines only use `node:24@sha256:…`).**
  - The bump is its own PR, and a second person (or a second session) reviews
    it.
  - `docker buildx imagetools inspect` of `docker.io/library/node:24` (or the
    exact `24.x.y` tag) shows the new index digest. The repository is the
    official `library/node`.
  - The index has `attestation-manifest` entries, and its provenance
    (`--format '{{json .Provenance}}'`) shows the Docker Official Images
    build.
  - `node --version` from a container of the new digest is listed in
    `https://nodejs.org/dist/index.json` and is not older than the current
    pin.
  - The PR records the old and new digest and the `linux/amd64` manifest
    digest.
- **R5. L2 in the pin bullet.** Run the step 2 block with `MODE=dry-run`
  twice on the new digest. Save the first `INTEGRITY.txt` before the second
  run (step 2 deletes `$REL/out`). The two runs must be byte-identical by
  `diff`. They become the new baseline, recorded in the bump PR, and are
  never compared with the old digest's values. Run this alone on the
  machine (the timing flake is noted in the plan).
- **R6. Step 4 unchanged.** The publish block, the token handling, the
  pinned digests, the Dockerfiles and CI are untouched by this PR (D1).
  `RELEASING.md` edits are limited to "Before you start" and "Known limits".
  The Known limits text must keep saying that integrity is verified within
  one build, by step 4. Cross-run identity is a property, not the check.
- **R7. No new release-path code execution.** No `.pnpmfile.cjs`, no new
  dependency, no lifecycle script (D1).

## D2 for the record (rejected; why it is the riskier option)

- A `.pnpmfile.cjs` is project code that pnpm loads with full Node privileges
  on **every** pnpm command: `install` in both Dockerfiles, CI, the step 2
  build container, and every developer machine. The release design
  (ADR 0016) keeps project code out of the publish step. A pnpmfile adds an
  always-on code-execution hook that has to be reviewed as release-path
  code.
- Its `readPackage` / `beforePacking` hooks can silently change resolved
  dependencies or the published manifest after every source-level check.
  `pnpmfileChecksum` in the lockfile only detects that the file changed. It
  does not say what the file does.
- It needs `COPY .pnpmfile.cjs` in both Dockerfiles. Without the file,
  `--frozen-lockfile` fails, which is good, but it widens the build context
  contract. It also changes client's value.
- If chosen anyway: CommonJS, no dependencies or I/O beyond reordering keys,
  a `pack:check` check that the packed order equals the source order, and
  that check applied to every published package. L4 then does not apply.

## What I will check in code mode

- R1 and R2 in `lib.ts` / `pack-check.ts`, and their tests. Confirm no new
  code path packs without `packAndCheck` (`grep` for `pnpm pack` and
  `packAll` callers).
- R3: the `pnpm-lock.yaml` diff, line by line. `pnpm audit`.
- `packages/react/package.json` diff: only the one devDependency removed.
  `files`, `exports`, `publishConfig` and scripts are unchanged (no
  lifecycle scripts).
- R4 and R5 wording in `RELEASING.md`, and the marker test. Step 4 is
  unchanged (R6). No `.pnpmfile.cjs` (R7).
- QA's evidence: 32/32 identical values for all three packages, the negative
  check (exit 1, no `INTEGRITY.txt`), and two dry runs compared with `diff`.
- Scanners: gitleaks on the PR range, semgrep on the changed files, and
  `npm audit` (the lockfile changed).
