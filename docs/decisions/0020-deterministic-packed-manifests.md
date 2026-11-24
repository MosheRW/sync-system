# 0020. Deterministic packed manifests (supersedes 0019)

- Status: Accepted (revised Gate 2, 2026-11-24: user chose the recommended D1,
  with security controls R1–R7 and advisories L1–L4 of
  [`docs/issues/53/security.md`](../issues/53/security.md))
- Date: 2026-11-23
- Issue: #53
- Supersedes: [0019](0019-release-tarball-reproducibility.md)

## Context

[ADR 0019](0019-release-tarball-reproducibility.md) (accepted, option A)
said the release tarballs are reproducible for the same commit in the
pinned image. It explained #37's second react value (`sha512-G3AJtSQ…`)
as a value from a run #37 did not record. QA round 1 of #53 showed that
this premise is wrong. The architect reproduced the finding
([`docs/issues/53/architecture.md`](../issues/53/architecture.md),
"Revision after QA r1"):

- In one container from the pinned image (fresh clone, one install and
  one build), 20 runs of `pnpm pack:check --out <new dir>` gave react
  `sha512-ZA0Bjbm…` 17 times and `sha512-G3AJtSQ…` 3 times. QA saw 9 and
  7 in 16 runs. Protocol and client were always identical.
- The two react tarballs differ only in `package/package.json`. In
  `devDependencies`, `@mosherw/sync-system-server` and
  `@mosherw/sync-system-protocol` swap places. File list, modes, mtimes and
  sizes are identical.
- Cause, in pnpm 10.28.0 (and still in 10.34.9, the latest 10.x):
  `createExportableManifest` builds each dependency map with
  `p-map-values`, which assigns `result[key] = await mapper(...)` in
  **promise completion order**. Plain ranges resolve without I/O, so
  they keep their source order and come first. Each `workspace:` range
  reads the target's `package.json` from disk, so those keys land in the
  order the reads finish. With one `workspace:` range in a map the order
  is fixed. With two or more it is a race. React is the only published
  package with two (`devDependencies`: protocol and server). Client has
  one per map, and protocol has none.
- pnpm 11 fixes this upstream: it uses `Promise.all(...)` and
  `Object.fromEntries`, which keep the source order.
- The parts of 0019 that still hold: both image digests share the same
  `linux/amd64` manifest, so the base image is not the cause. A build on
  another host OS changes the gzip header's OS byte. A Node or zlib bump
  can change the deflate output.

Step 4 of [`RELEASING.md`](../../RELEASING.md) stays safe. It compares
values within one build. `pack:check --out` hashes the bytes of the file
it writes and keeps. Step 4 recomputes the hash from that same file,
`npm publish <file>` uploads it unchanged, and `verify` checks the
registry's `dist.integrity` against `INTEGRITY.txt`. The race matters only
when two separate pack runs are compared: a rebuild, a post-bump baseline
(security advisory L2 of #53), or an independent second build (L7 of #37).

## Options

1. **D1. At most one `workspace:` range per dependency map, enforced by
   `pack:check` (recommended).** Remove react's unused
   `@mosherw/sync-system-protocol` devDependency. React's sources and tests
   never import it. `import.node.test.ts` builds `packages/protocol` by
   path, and protocol still arrives through the client. Add a pure check to
   `scripts/release/lib.ts` that runs before packing in `pack:check` and
   `release:dry-run`. It fails if a published package has two or more
   `workspace:` ranges in one of `dependencies`, `devDependencies`,
   `optionalDependencies` or `peerDependencies`, and it names #53 and this
   ADR.
   - Pros: removes the race at its trigger. Smallest change. No pnpm hook,
     no Dockerfile change, and the lockfile only loses three lines. Protocol
     and client values do not change, and react gets one stable value
     (checked 24 of 24 runs). A regression fails `pack:check` loudly
     instead of flipping a hash.
   - Cons: it constrains future manifests. If a published package ever
     needs two workspace ranges in one map, it must move to D2 or F. The
     packed order stays pnpm 10's order (workspace keys last), so moving to
     pnpm 11 will change the bytes once.
2. **D2. A `.pnpmfile.cjs` `beforePacking` hook that restores the source
   key order, plus a `pack:check` check that the packed order equals the
   source order.**
   - Pros: works for any number of workspace ranges. The output matches
     what pnpm 11 writes. Checked 24 of 24 runs.
   - Cons: project code that pnpm loads on every command, including
     installs. `pnpm-lock.yaml` gains `pnpmfileChecksum`. Without the file,
     `pnpm install --frozen-lockfile` fails, so both Dockerfiles must
     `COPY` it before the install. It needs its own ESLint block (CommonJS)
     and changes the client's value as well. It is more release-path
     surface for the same result today.
3. **E. Document the limit only.** Say that react's value can differ
   between pack runs of the same commit, and keep the within-one-build
   comparison.
   - Pros: docs only.
   - Cons: L2's "run the dry run twice, require identical values" cannot
     work for react. Any rebuild comparison needs a "one of two values"
     rule, which is weak evidence and invites mistakes. It leaves a known
     non-determinism in the release.
4. **F. Upgrade to pnpm 11**, which keeps the source order upstream.
   - Pros: no local workaround.
   - Cons: a major package-manager upgrade (lockfile, settings, `corepack`
     hash, CI and Dockerfiles) that is out of scope for a chore. It is a
     separate issue, and D1's check can be dropped after it.

## Decision

**D1** (chosen by the user at the revised Gate 2, 2026-11-24). It makes every pack run
of the same commit in the pinned image byte-identical with the smallest
change to the release path. It leaves the publish step as it is. It also
turns the trigger into a `pack:check` failure, so the race cannot come
back silently. D2 is the fallback if two workspace ranges in one map are
ever needed. F is the long-term fix.

The user also adopted the plan review's required controls R1–R7 and
advisories L1–L4 ([`docs/issues/53/security.md`](../issues/53/security.md)):

- **The guard** (R1, R2, L1 of the review) runs in `packAndCheck`, before
  packing, with no way to skip it. It counts every value that contains
  `workspace:` (pnpm's peer converter uses `includes`, so a compound peer
  range such as `"^1 || workspace:^"` counts too) in all four dependency
  maps of each published package's source manifest. It fails closed: a
  missing published package or a dependency field that is not a plain
  object is a problem too.
- **No pnpmfile** (R7, L4): `pack:check` also fails if `.pnpmfile.cjs`
  exists at the repo root or `npm_config_pnpmfile` /
  `npm_config_global_pnpmfile` is set, because a `beforePacking` hook could
  rewrite the packed manifest after every source-level check.
- **Lockfile** (R3): the only lockfile change is the removal of the
  three-line importer entry.
- **Provenance of a new digest** (R4, L2 of the review): the bump is its own
  PR, reviewed by a second person or session. `docker buildx imagetools
inspect` of the official `docker.io/library/node` tag shows the new index
  digest, with `attestation-manifest` entries and Docker Official Images
  provenance. `node --version` in the new image is listed in
  `https://nodejs.org/dist/index.json` and is not older than the current
  pin. The PR records the old and new index digests and the `linux/amd64`
  manifest digest.
- **Post-bump baseline** (R5, L3 of the review): run the
  [dry run](../../RELEASING.md#dry-run-qa) **twice** on the new digest, save
  the first `INTEGRITY.txt` before the second run, and require `diff` of the
  two files to print nothing. Those values are the new baseline; never
  compare them with the old digest's values.
- **Step 4, CI and the Dockerfiles stay unchanged** (R6).

## Consequences

- 0019 becomes `Superseded by 0020`. Its "host OS" and "Node/zlib bump"
  limits still hold and move into `RELEASING.md` "Known limits" as part of
  this decision.
- `pack:check` and `release:dry-run` fail on a published package with two
  `workspace:` ranges in one dependency map.
- React's packed manifest loses one devDependency entry. Consumers never
  install devDependencies, so this needs no changeset. React's integrity
  value changes once, to a single stable value.
- `RELEASING.md` says the values are identical across pack runs of the same
  commit in the pinned image on linux/amd64 (still not across host OSes or
  digests). The pin bump gains the provenance and two-run baseline checks.
- `pack:check` and `release:dry-run` fail when a pnpmfile is present.
- When the project moves to pnpm 11 (F), remove the check, and expect new
  values for client and react.
