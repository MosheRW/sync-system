# Architecture: #53 chore(release): investigate react tarball hash differences across node:24 images

Path: fast. Branch: `chore/53-react-tarball-hash`. PR: #62.

> **Revised after QA round 1 FAIL (2026-11-23).** The round 1 premise
> ("the build is byte-reproducible in the pinned image, react included")
> is wrong. ADR 0019 (option A, accepted and implemented in `c4c5fbc` and
> `0f4a1e5`) rests on it. This revision corrects the root cause and
> proposes [ADR 0020](../../decisions/0020-deterministic-packed-manifests.md),
> which supersedes 0019. The fix lands as new commits on top of the
> existing ones, with no rewrite. The round 1 investigation is kept at the
> end as evidence: its image and host-OS findings still hold.

## Repo layout

Single repo, a pnpm workspace monorepo (`pnpm-workspace.yaml`, no
submodules, no `.pnpmfile.cjs`). This revision touches:

- `packages/react` (`package.json`) and `pnpm-lock.yaml`.
- `scripts/release` (`lib.ts`, `pack-check.ts`, `pack-check.test.ts`).
- `RELEASING.md` ("Before you start" pin bullet and "Known limits" only, not
  step 4), `docs/conventions.md`, `docs/decisions/0019-…` and `0020-…`.
- `apps/sync-server/test/release-files.test.ts` (marker test).

Checks: `pnpm lint` (ESLint, Prettier, `docs:links`), `pnpm typecheck`,
`pnpm test` (it includes `node --test scripts/release/*.test.ts`),
`pnpm build`, `pnpm smoke`, `pnpm pack:check`. No other repo is affected.
`docs/roadmap.md` and `RELEASING.md` step 4 belong to #52 (PR #61) and are
not touched.

## Revision after QA r1: the real root cause

### Reproduction (local Docker, pinned image, no bind mounts)

Setup: container `a53r-build` from
`node:24@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496`.
A `git bundle` of `caf48dc` was copied in with `docker cp` and cloned (LF
endings). Then `corepack enable`, `pnpm install --frozen-lockfile` and
`pnpm build`, once. After that, `pnpm pack:check --out /o$i` ran 20 times,
each into a new directory:

| Package | Values in 20 runs |
|---|---|
| protocol | `aF3olqA9…` 20/20 |
| client | `hA7xJimQ…` 20/20 |
| react | `ZA0BjbmI…` 17/20, `G3AJtSQn…` 3/20 (runs 1, 10 and 11) |

QA saw 9 and 7 in 16 runs. So the flip rate varies with timing, but both
values come from the **same** build.

### Diff of the two react tarballs

- Same size (66929 bytes), identical `tar -tzv` listings (names, modes,
  owners, mtimes).
- `diff -r` of the unpacked trees: only `package/package.json`, lines
  49–50. In `devDependencies`, `"@mosherw/sync-system-server": "1.0.0"` and
  `"@mosherw/sync-system-protocol": "1.0.0"` swap places. Both are the
  **last** two keys. Every plain-range key keeps its source order in front
  of them.

### Where the non-determinism comes from

pnpm 10.28.0 (`dist/pnpm.cjs`, `createExportableManifest`, used by
`pnpm pack` and `pnpm publish`):

```js
async function makePublishDependencies(dir, dependencies, { modulesDir, convertDependencyForPublish }) {
  // ...
  return await pMapValues(async (depSpec, depName) => convertDependencyForPublish(depName, depSpec, dir, modulesDir), dependencies);
}
// p-map-values@1.0.0
async function pMapValue(mapper, obj) {
  const result = {};
  await Promise.all(Object.entries(obj).map(async ([key, value]) => {
    result[key] = await mapper(value, key, obj); // inserted in completion order
  }));
  return result;
}
```

- Each key is inserted when its conversion **finishes**. A plain range
  returns without I/O, so it finishes in source order, first. A
  `workspace:` range awaits `readAndCheckManifest` (a disk read of the
  target's `package.json`), so those keys land in the order the reads
  complete.
- One `workspace:` range in a map gives a fixed order. Two or more give a
  race. In the published packages, only react's `devDependencies` has two
  (`protocol` and `server`). React's `dependencies` and client's
  `dependencies` and `devDependencies` have one each, and protocol has none.
  This is why only react flips.
- pnpm 10.34.9, the latest 10.x, has the same code. pnpm 11.29.0 changed it
  to `Promise.all(...)` with `Object.fromEntries(...)`, which keeps the
  source order. pnpm has no setting that changes this in 10.x. The only
  local hook is a `.pnpmfile.cjs` `beforePacking(pkg, dir)` hook (option D2).
- `publishConfig` cannot help. pnpm's `overridePublishConfig` copies only
  entry-point fields (`exports`, `main`, `types`, …), not dependency maps.
  Dropping `devDependencies` from the packed manifest would also need a
  hook or a post-pack rewrite.

### Does devDependencies need to be in the published package.json?

No. Consumers never install a dependency's devDependencies. `npm publish
<tarball>` uploads the manifest exactly as packed, and pnpm 10 has no switch
to omit the field. React's `@mosherw/sync-system-protocol` devDependency is
not used at all:

- `packages/react/src` and `test` never import it.
- `test/import.node.test.ts` builds `packages/protocol` by path.
- The client provides protocol at runtime.

Checked in the same container: with the entry removed and
`pnpm install --no-frozen-lockfile` run (the lockfile loses 3 lines in the
`packages/react` importer, and `--frozen-lockfile` then passes), react
typecheck passes, react tests pass (21 files, 227 tests), the build is
green, and the reader typecheck is green. The packed manifest keeps the
server key, which no consumer installs.

### Fix candidates, measured (same container, 24 pack runs each)

| Variant | protocol | client | react |
|---|---|---|---|
| Today (`caf48dc`) | 1 value | 1 value | **2 values** (17/3 in 20) |
| D1: drop react's unused protocol devDependency | `aF3olqA9…` 24/24 (unchanged) | `hA7xJimQ…` 24/24 (unchanged) | `miMW9yo6…` 24/24 |
| D2: `.pnpmfile.cjs` `beforePacking` restores source order | `aF3olqA9…` 24/24 | `q6Yt0d14…` 24/24 (changed) | `KKL96OJg…` 24/24 |

D2 side effects, observed:

- `pnpm-lock.yaml` gains `pnpmfileChecksum`.
- `pnpm install --frozen-lockfile` **fails** (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`)
  when the file is missing. Both `apps/*/Dockerfile` copy only
  `package.json`, the lockfile and the workspace manifests before
  `pnpm install`, so they would need to `COPY .pnpmfile.cjs` too.

### Is step 4 (publish) still safe?

Yes. The race is between separate pack runs, never inside one:

- `pack:check --out` (and `release:dry-run`) hashes the bytes of the file
  it just wrote and keeps (`packAndCheck`: `readFileSync`, then
  `integrityLine`).
- Step 4 copies those same files into the publish container and recomputes
  the sha512 from them (`diff` against `INTEGRITY.txt`).
- `npm publish /release/<file>` uploads that file unchanged (no repack).
- `verify` then compares the registry's `dist.integrity` with
  `INTEGRITY.txt`.

The hashed file is the published file. What breaks is any comparison
**across** pack runs:

- a rebuild of the same commit;
- the post-bump baseline (security L2);
- the "reproducible for the same commit in the pinned image" claim that
  `c4c5fbc` and `0f4a1e5` added to `RELEASING.md`, `docs/conventions.md`,
  ADR 0019 and the marker test;
- any future independent second build (L7 of #37).

### What still holds from round 1

- Both digests resolve to the same `linux/amd64` manifest, so the base
  image is not the cause.
- The host-OS gzip byte and the Node/zlib-bump limits are real and affect
  all three tarballs.
- The `G3AJtSQ…` value in #37 was **not** from an unrecorded run. It is
  simply the other outcome of this race.

## Decisions

- [ADR 0020](../../decisions/0020-deterministic-packed-manifests.md)
  (Proposed, supersedes 0019): the options are D1, at most one `workspace:`
  range per dependency map, enforced by `pack:check` (**recommended**);
  D2, a `.pnpmfile.cjs` `beforePacking` hook; E, document the limit only;
  F, pnpm 11. The user decides at Gate 2.
- ADR 0019 stays Accepted, with a note at the top that its premise was
  disproved. Chunk 1 sets it to `Superseded by 0020`. Per
  `docs-conventions`, an accepted decision is superseded, not edited.

## Approach (D1, recommended)

1. **Remove the trigger.** Drop `"@mosherw/sync-system-protocol":
   "workspace:*"` from `packages/react/package.json` `devDependencies`, and
   update the lockfile with `pnpm install` (not frozen). The diff should be
   only the importer entry, 3 lines.
2. **Guard it.** In `scripts/release/lib.ts`, add a pure
   `checkWorkspaceRanges(packages: readonly WorkspacePackage[]): string[]`.
   For each `PUBLISHED` package's **source** manifest, and for each of
   `dependencies`, `devDependencies`, `optionalDependencies` and
   `peerDependencies` (the existing `DEPENDENCY_FIELDS`), it reports a
   problem when two or more values start with `workspace:`, for example
   `packages/react: devDependencies has 2 workspace: ranges
   (@mosherw/a, @mosherw/b); pnpm 10 packs them in a racy order (#53, ADR
   0020)`. Private packages are not checked, since they are never packed.
   `packAndCheck` in `pack-check.ts` calls it together with
   `checkPublishableSet`, **before** `packAll`, and returns early on
   problems. `release:dry-run` goes through `packAndCheck`, so it is
   covered too.
3. **Correct the docs.**
   - `RELEASING.md` "Known limits": replace the 0019 bullet. The three
     values are identical across pack runs of the same commit in the pinned
     image on a linux/amd64 engine. This holds because `pack:check` rejects
     two `workspace:` ranges in one dependency map (pnpm 10 orders those
     keys by I/O completion). A host-OS build (gzip OS byte) or a new
     digest (Node's zlib) still changes all three. Link ADR 0020 and #53.
   - `RELEASING.md` "Before you start", pin bullet, rewritten in prose
     (no bare `node:24` in shell blocks, because of the L1 marker test):
     - Bump the digest in its own reviewed PR (L1).
     - Check the new index with `docker buildx imagetools inspect` (the
       official `node` repository, with attestation manifests present)
       (L1).
     - `node --version` in the new image must match an official Node.js
       release (L1).
     - Run the [dry run](#dry-run-qa) **twice** on the new digest. The
       three values must be identical between the runs, and they become the
       new baseline. Do not compare them with the old digest's values (L2).
   - `docs/conventions.md`: the "Tarball reproducibility" row now points to
     0020 and states the rule ("at most one `workspace:` range per
     dependency map in a published package; values identical across pack
     runs in the pinned image").
4. **Marker test.** Change the existing #53 test in
   `apps/sync-server/test/release-files.test.ts`:
   - Known limits must contain `workspace:`, `gzip`, `host OS`, `zlib`
     and `(docs/decisions/0020-deterministic-packed-manifests.md)`.
   - The pin bullet must contain `[dry run](#dry-run-qa)`, `twice`,
     `identical`, `own` (its own PR) and `node --version`.

Rejected:

- **D2.** It adds a pnpmfile that runs on every pnpm command,
  `pnpmfileChecksum` in the lockfile, two Dockerfile `COPY` changes and an
  ESLint block, and it changes client's value. That is more release-path
  surface for the same result. It is the fallback if two workspace ranges
  in one map are ever needed.
- **E.** It leaves react non-reproducible, and L2 cannot work for it.
- **F.** A major package-manager upgrade; it belongs in a separate issue.
- **Post-processing the tarball** (rewrite `package.json` after pack): it
  changes the bytes after `pnpm pack`, the same objection as 0019's C.

## Files to create / modify

- `docs/decisions/0020-deterministic-packed-manifests.md`: new, Proposed
  (this commit). Chunk 1 sets it to Accepted.
- `docs/decisions/0019-release-tarball-reproducibility.md`: a note at the
  top (this commit). Chunk 1 sets the status to `Superseded by 0020`.
- `docs/conventions.md`: the "Tarball reproducibility" row now points to
  0020. Prettier may reflow the table.
- `packages/react/package.json`: remove the protocol devDependency.
- `pnpm-lock.yaml`: the `packages/react` importer loses that entry.
- `scripts/release/lib.ts`: add `checkWorkspaceRanges`.
- `scripts/release/pack-check.ts`: call it before packing. Extend the
  header comment with #53.
- `scripts/release/pack-check.test.ts`: unit tests (see the test plan).
- `RELEASING.md`: the pin bullet and the Known limits bullet.
- `apps/sync-server/test/release-files.test.ts`: change the #53 marker
  test.
- `docs/issues/53/STATE.md`: phase updates.

Data model changes: none. Contracts (API, realtime): none.

Docker impact: none. The images are unchanged, and the Dockerfiles already
copy `pnpm-lock.yaml` and `packages/react/package.json`, which stay
consistent.

Docs impact: `RELEASING.md`, `docs/conventions.md`, ADR 0019 (status) and
ADR 0020.

No changeset: devDependencies are never installed by consumers, so nothing
is user-visible. React's integrity value changes once, at the next pack.

## Risks / edge cases

- **The race could have another trigger.** Only `workspace:` conversions
  do I/O in pnpm 10.28.0:
  - `catalog:` resolves synchronously from the settings;
  - `jsr:` is a string rewrite;
  - peerDependencies go through the same `makePublishDependencies`, so the
    check covers them too.
  The N≥32 repeat in the test plan is the empirical guard.
- **pnpm upgrades.** A pnpm 10.x bump keeps the same code (10.34.9
  checked). pnpm 11 changes the key order once (workspace keys go back to
  their source position), so client and react values change. That
  belongs to the pnpm 11 issue, which may also drop the check.
- **The lockfile edit must be minimal.** Run `pnpm install` without
  `--frozen-lockfile` on the pinned pnpm 10.28.0 (corepack). Any diff
  beyond the 3-line importer change is a red flag; stop and report it.
- **L1 marker test.** It rejects a bare `node:24` in shell blocks, so the
  new pin text stays in prose. Any shell line names
  `node:24@sha256:…`.
- **`docs:links`.** The new ADR links and `#dry-run-qa` must resolve.
- **#52 (PR #61).** It edits step 4 and `docs/roadmap.md`. This plan
  touches "Before you start" and "Known limits" only, so a conflict is
  unlikely.
- **Timing.** A heavy parallel build on the same machine made one
  heartbeat test flaky in round 1, so run step 2 alone.

## Security

Security-sensitive: yes

- **Release tooling:** `scripts/release/lib.ts` and `pack-check.ts` are the
  gate in front of the bytes that get published. The new check only adds a
  failure condition before packing. It does not change how tarballs are
  hashed, kept or published.
- **Published manifest content:** react's packed `package.json` loses one
  devDependency entry.
- **Dependency graph and lockfile:** one workspace devDependency is
  removed. Nothing is added or upgraded.
- **Release procedure docs:** the digest-bump procedure gains security
  advisories L1 (provenance: own PR, `imagetools inspect`, official
  `node --version`) and L2 (two identical dry runs as the baseline).
- **Not touched:** the step 4 publish block, the token handling, the
  pinned digests, the Dockerfiles and CI.

Run the security plan review before Gate 2.

## Implementer model

Implementer model: opus
Reason: the plan is security-sensitive (release tooling, lockfile, a
published manifest), it follows a failed QA round, and the Docker
verification (N≥32 repeated packs, two step 2 dry runs) needs care. The
code itself is small and follows `checkPublishableSet` in `lib.ts`.

## Test plan

| AC / finding | Check |
|---|---|
| Cause identified and written down | This revision, and ADR 0020 Context (QA re-runs the diff) |
| QA r1: react flips between pack runs | Docker repeat below: 32 of 32 identical, all three packages |
| Regression guard | `pack-check.test.ts`: `checkWorkspaceRanges` rejects 2 `workspace:` ranges in `devDependencies` and in `peerDependencies`; accepts 1 per map; ignores private packages; returns `[]` for the real `workspacePackages()` |
| Limit documented in `RELEASING.md` | The changed marker test in `release-files.test.ts` |
| Security L1 and L2 in the pin procedure | Same marker test (`own`, `node --version`, `twice`, `identical`) |
| React still works without the devDependency | `pnpm typecheck`, `pnpm test` (react: 21 files) and `pnpm smoke` green |

Commands (engineer, then QA). Use local Docker with no bind mounts and a
`git bundle` copied in with `docker cp`. Prefix containers `e53-` or
`qa53-`, and remove them afterwards:

1. Fresh clone in `node:24@sha256:9d266751…` with a Redis sidecar and
   `CI=true`: `pnpm install --frozen-lockfile && pnpm audit --audit-level=high
   && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm smoke`.
   Everything must be green.
2. In the same container, run `pnpm pack:check --out /packs/$i` for
   `i=1..32`, each into a new directory (do not use a `/p*` glob in `rm`,
   because it matches `/proc`). Then
   `cat /packs/*/INTEGRITY.txt | sort | uniq -c` must print exactly three
   lines, each with the count 32. With today's flip rate (15–45 %), 32 equal
   runs by chance have a probability below 0.6 %. Also unpack one react
   tarball and check that `devDependencies` has no
   `@mosherw/sync-system-protocol`.
3. Negative check: temporarily add a second `workspace:*` devDependency to
   `packages/react/package.json`. `pnpm pack:check` must exit 1 with the
   #53 / ADR 0020 message. Revert the change.
4. L2 as documented: run the `RELEASING.md` step 2 block with
   `MODE=dry-run` **twice**, on its own. The three printed integrity lines
   must be identical between the two runs. Then run step 4 up to the token
   prompt and abort it.

## Implementation chunks (fix round on top of `caf48dc`, no rewrite)

1. `docs(adr): accept 0020 deterministic-packed-manifests`: 0020 becomes
   Accepted with the user's choice, 0019 becomes `Superseded by 0020`, and
   the `docs/conventions.md` row changes.
2. `build(react): drop the unused protocol devDependency`: the
   `packages/react/package.json` and `pnpm-lock.yaml` changes.
3. `fix(release): reject two workspace ranges in one dependency map`:
   `lib.ts`, `pack-check.ts` and `pack-check.test.ts`. This comes after
   chunk 2 so that the real-workspace test is green in every commit.
4. `docs(release): correct the tarball reproducibility scope`: the
   `RELEASING.md` pin bullet (L1, L2) and the Known limits bullet, together
   with the marker test change. This is the docs chunk.

If the user picks **D2** instead: chunk 2 becomes
`build(release): restore source key order when packing`. It adds
`.pnpmfile.cjs`, the lockfile `pnpmfileChecksum`, `COPY .pnpmfile.cjs` in
both Dockerfiles before `pnpm install`, and an ESLint CommonJS block. Chunk
3 then checks "packed dependency key order equals source order" instead.
Docker impact becomes "both Dockerfiles".

If the user picks **E**: chunks 2 and 3 are dropped. Chunk 4 states that
react can differ between pack runs and that L2 is "compare protocol and
client; react may show one of two values". This is not recommended.

---

## Appendix: round 1 investigation (partly disproved)

Kept as evidence. The images, host-OS and tarball-format findings still
hold. The conclusion that container builds are byte-identical for react
is **wrong**. Those runs happened to land on the same side of the race.

### Round 1 investigation

#### What #37 reported (QA A3, PR #50)

- "CI" container, `node:24`: react `sha512-ZA0Bjbm…`.
- Step 2 container, `node:24@sha256:9d26…`: react `sha512-G3AJtSQ…`.
- Protocol and client matched. The same report also says that the round 1
  step 2 run "stopped at `pnpm test` on the pre-existing failure", so it
  never reached `pack:check` or `release:dry-run` as written.

#### Images (local Docker Desktop, linux/amd64)

| | `node:24` (local tag) | Pinned (`RELEASING.md`) |
|---|---|---|
| Index digest | `sha256:a2bdd7dabee64357fd6291fe621977c33cda500d13e15dca3e0e92c9a3c9f3b1` | `sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496` |
| linux/amd64 manifest | `sha256:aca79828f8a4…` | `sha256:aca79828f8a4…` (the same) |
| Layers (`RootFS.Layers`) | identical | identical |
| Created | 2026-11-11T18:42:59Z | 2026-11-11T18:42:59Z |
| node / npm / corepack | 24.22.3 / 11.19.1 / 0.36.0 | 24.22.3 / 11.19.1 / 0.36.0 |
| pnpm (corepack, `packageManager`) | 10.28.0 | 10.28.0 |
| zlib (`process.versions.zlib`) | 1.3.2.1-motley | 1.3.2.1-motley |
| Debian, git, tar, gzip | 12.15, 2.39.5, 1.34, 1.12 | the same |

The two index manifests differ only in the `linux/arm64/v8` entry and its
attestation manifest. Remote `node:24` today resolves to the pinned
`9d266751…`. The local `node:24` tag still pointed at the earlier index
`a2bdd7da…`, so the two digests needed for the reproduction were both
present. On an amd64 host, **both names run the same image**, so the base
image cannot be the cause.

#### Builds (same commit `a947a6b`, fresh clone from a `git bundle` copied in with `docker cp`, no bind mounts)

| Run | Image | Flow | protocol | client | react |
|---|---|---|---|---|---|
| a53-tag | `a2bdd7da…` | install, build, `pack:check --out` | `aF3olqA9…` | `hA7xJimQ…` | `ZA0BjbmI…` |
| a53-pin | `9d266751…` | the same | `aF3olqA9…` | `hA7xJimQ…` | `ZA0BjbmI…` |
| a53-test | `9d266751…` | install, `pnpm test`, build, `pack:check --out` (CI order) | `aF3olqA9…` | `hA7xJimQ…` | `ZA0BjbmI…` |
| a53-dryrun | `9d266751…` | install, build, smoke, `release:dry-run` | `aF3olqA9…` | `hA7xJimQ…` | `ZA0BjbmI…` |
| step 2 (tag) | `a2bdd7da…` | the `RELEASING.md` step 2 block as written, `MODE=dry-run`, Redis sidecar, `CI=true` | `aF3olqA9…` | `hA7xJimQ…` | `ZA0BjbmI…` |
| step 2 (pin) | `9d266751…` | the same | `aF3olqA9…` | `hA7xJimQ…` | `ZA0BjbmI…` |
| host | Windows, Node 24.18.0, zlib 1.3.1 | fresh clone, install, build, `pack:check --out` | `zkhaF6rM…` | `frAV6x0x…` | `s52J7yBi…` |

The react value in every container run is `ZA0Bjbm…`, the value #37 got in
its CI container. `G3AJtSQ…` does not come back on any documented build
path.

Full container values (all runs):

```
mosherw-sync-system-protocol-1.0.0.tgz sha512-aF3olqA9VI4WSktbukEstXjcGX0z0EJnBYxmPYT8WmFQL6DKryOG1BdyLHT8Dr1lkCj1v7bLnXpeXhcdCEw6GA==
mosherw-sync-system-client-1.0.0.tgz sha512-hA7xJimQQ2mvfrLsXn/8gmxkDiFsMIp1ag6qEAuAeJeF9qzmD7ul+033xe8KqA1jLoCoIxgYn1OTkBRQQBplsg==
mosherw-sync-system-react-1.0.0.tgz sha512-ZA0BjbmI5omutqayQfouVb1wKb2A7LncUdwEuxqrlZqhywNP/AKlNEPzdPqOiG/b3ubAx8EBPaD8MY4IMb6Log==
```

Side note: the first pinned step 2 run, started in parallel with the tag
run, failed one timing test (`heartbeat.test.ts` "keeps a client that
answers pings", 418 ms) under the double load. The rerun on its own was
green (protocol 215/215, server green) and printed the values above. This
does not affect the finding. It is worth knowing that step 2 should not
share the machine with another heavy build.

#### Tarball contents

- Container builds (all digests and flows): the `.tgz` files are
  byte-identical (the same sha512).
- Host build vs container build: unpacked trees are identical
  (`diff -r`), `tar -tzv` listings are identical, and the **uncompressed
  tar streams are identical**. The `.tgz` files differ in exactly one byte,
  offset 9: the gzip header OS field, `0x03` (Unix) in the container and
  `0x0a` on Windows. Sizes are equal (protocol 49342, client 125130, react
  66929 bytes).
- `pnpm pack` already fixes everything else. Entry order is stable, files
  are `-rw-r--r--`, owner `0/0`, mtime `1985-10-26 11:15`, gzip MTIME 0 and
  XFL 0. The packed `package.json` fields are the same.

#### Conclusion

- The base image is **not** the cause. Both digests share the amd64 image,
  and the build is byte-reproducible across them and across every flow
  tried, react included.
- Nothing react-specific is non-deterministic. React builds with plain
  `tsc` like the other two, with no bundler, minifier or generated files.
- The `G3AJtSQ…` value from #37 came from a run that #37 did not record (its
  step 2 run stopped at `pnpm test`, by its own notes). It cannot be
  reproduced and cannot be traced further from the record.
- Two real limits do exist. Both affect **all three** tarballs, not only
  react:
  1. **Host OS:** zlib writes the OS byte into the gzip header, so a
     Windows-host build hashes differently from a Linux container build.
  2. **Node/zlib bump:** a new image digest can ship a different zlib
     whose deflate output differs (the host's 1.3.1 already differs from the
     image's 1.3.2.1 by version; here the stream happened to match).

