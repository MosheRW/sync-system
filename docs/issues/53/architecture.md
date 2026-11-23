# Architecture: #53 chore(release): investigate react tarball hash differences across node:24 images

Path: fast. Branch: `chore/53-react-tarball-hash`.

## Repo layout

Single repo, a pnpm workspace monorepo (`pnpm-workspace.yaml`, no
submodules). The issue touches only release docs and one marker test:
`RELEASING.md`, `docs/decisions/`, `docs/conventions.md` and
`apps/sync-server/test/release-files.test.ts`. Checks: `pnpm lint` (includes
`docs:links` and prettier) and `pnpm --filter @mosherw/sync-system-server test`.
No other repo is affected.

## Investigation: the root cause

### What #37 reported (QA A3, PR #50)

- "CI" container, `node:24`: react `sha512-ZA0Bjbm…`.
- Step 2 container, `node:24@sha256:9d26…`: react `sha512-G3AJtSQ…`.
- Protocol and client matched. The same report also says that the round 1
  step 2 run "stopped at `pnpm test` on the pre-existing failure", so it
  never reached `pack:check` or `release:dry-run` as written.

### Images (local Docker Desktop, linux/amd64)

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

### Builds (same commit `a947a6b`, fresh clone from a `git bundle` copied in with `docker cp`, no bind mounts)

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

### Tarball contents

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

### Conclusion

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

## Decisions

- [ADR 0019](../../decisions/0019-release-tarball-reproducibility.md)
  (Proposed): how far the release tarballs are reproducible. Options:
  A, document the scope (recommended); B, A plus a compression-independent
  content digest; C, normalize gzip. The user decides at Gate 2.

## Approach (option A)

The base image is already pinned by digest, with an update procedure, in
`RELEASING.md` "Before you start" (#37, L1). The marker test
`pins both containers by digest (L1)` enforces it. Pinning is not new work,
so the plan only states the reproducibility scope:

1. `RELEASING.md` "Known limits": add one bullet. The integrity values are
   reproducible for the same commit in the pinned image on a linux/amd64
   engine (tag names that resolve to the same amd64 manifest give the same
   bytes). A build on another host OS (the gzip OS byte) or on a new digest
   (Node's bundled zlib) gives different values for all three tarballs, so
   values are compared only within one build and one digest. Link ADR 0019
   and #53.
2. `RELEASING.md` "Before you start", pin bullet: after a bump, run the
   [dry run](#dry-run-qa) and expect new integrity values. Do not compare
   them with the values from the old digest. Prose only. Any shell line
   that names the image keeps `node:24@sha256:…`, because the L1 marker test
   rejects a bare `node:24` in shell blocks.
3. Marker test in `apps/sync-server/test/release-files.test.ts`, in the
   existing "states the residual risk and the known limits" test: the
   Known limits section mentions the gzip/host-OS limit and links ADR 0019.

Rejected: B (release script change for an L7 comparison that is not
adopted) and C (rewrites the published bytes). Pinning a new or different
digest: not needed, and it would change the release image for no reason.

If the user picks **B** at Gate 2: also add to `scripts/release/lib.ts` a
`contentDigestLine(file, bytes)` (sha512 of `gunzipSync(bytes)`).
`pack-check.ts` then writes `CONTENT.txt` next to `INTEGRITY.txt` (with
`--out` only; `INTEGRITY.txt` keeps its format because step 4 parses it).
`dry-run.ts` copies it, `pack-check.test.ts` covers it, and the step 2
block prints it. This adds an `opus` engineer round and a release-tooling
review.

### Staying clear of #52

#52 (`fix/52-releasing-docker-ps-block`) edits `RELEASING.md` step 4 and
`docs/roadmap.md`. This plan touches only the "Before you start" pin bullet
and "Known limits" (far from step 4) and does not touch
`docs/roadmap.md`. Whichever PR merges second rebases cleanly or with a
trivial merge.

## Files to create / modify

- `docs/decisions/0019-release-tarball-reproducibility.md`: new ADR,
  Proposed (this commit). Accepted in chunk 1.
- `docs/conventions.md`: one row in "Packages, license and release (#37)":
  release tarball reproducibility scope, link 0019.
- `RELEASING.md`: the pin bullet in "Before you start" and one "Known
  limits" bullet.
- `apps/sync-server/test/release-files.test.ts`: extend the known-limits
  marker test.
- `docs/issues/53/STATE.md`: phase updates.

Data model changes: none. Contracts (API, realtime): none.
Docker impact: none (no image, digest or compose change).
Docs impact: `RELEASING.md`, `docs/conventions.md`, ADR 0019.

## Risks / edge cases

- Prettier reflows Markdown tables, so run `pnpm lint` after editing
  `docs/conventions.md`.
- `docs:links`: the new links (`docs/decisions/0019-…` from
  `RELEASING.md`, the anchor `#dry-run-qa`) must resolve.
- The L1 marker test fails if a shell block gains a bare `node:24`. Keep the
  new text in prose.
- Merge conflict with #52: low, because the sections are separate.

## Security

Security-sensitive: no

The plan changes release documentation and a marker test only. It changes
no pinned digest, no command in a credential block, no token handling, no
dependency and no script. It clarifies that integrity values are compared
within one build, which is how step 4 already works. Option B would touch
release tooling that produces the integrity file. If the user picks B,
re-judge it as sensitive and run the security plan review.

## Implementer model

Implementer model: opus
Reason: ADR 0019 is open until Gate 2 (rule: no open ADRs for sonnet).
Once A is chosen, the work is docs plus one marker assertion, following
the existing `release-files.test.ts` pattern, and sonnet would suffice.

## Test plan (local Docker, no bind mounts)

| AC | Check |
|---|---|
| Cause identified and written down | This document, "Investigation", and ADR 0019 Context (reviewed by QA against the commands below) |
| Limit documented in `RELEASING.md` | The marker test passes. Read "Known limits" and the pin bullet |
| Pin and update procedure documented | Already present (L1 marker test); the after-bump dry-run note added |

Commands (QA):

1. Fresh clone in `node:24@sha256:9d266751…` with Redis sidecar, `CI=true`:
   `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`
   (all green, including `release-files.test.ts`).
2. Optional re-check of the finding: run the `RELEASING.md` step 2 block in
   dry-run mode twice (container names prefixed, e.g. `qa53-`), once per
   digest that shares the amd64 manifest. The three integrity lines must
   match between the runs.

## Implementation chunks

1. `docs(adr): accept 0019 release-tarball-reproducibility`: status
   Accepted with the user's choice, plus the `docs/conventions.md` row.
2. `docs(release): document the tarball reproducibility scope`: the
   `RELEASING.md` pin bullet and Known limits bullet, together with the
   marker assertion that guards them in `release-files.test.ts`. Keeping
   them in one commit means no commit has a red test. This is the docs
   chunk.
