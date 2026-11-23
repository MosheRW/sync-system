# 0019. How far the release tarballs are reproducible

- Status: Accepted (Gate 2, 2026-11-23: user chose the recommended A)
- Date: 2026-11-23
- Issue: #53
- Note (2026-11-23, QA round 1 of #53): the premise below is wrong. The
  react tarball is **not** reproducible across pack runs in the pinned
  image: pnpm 10 writes its two `workspace:` devDependencies in a racy
  order. [ADR 0020](0020-deterministic-packed-manifests.md) (Proposed)
  supersedes this ADR. The status becomes `Superseded by 0020` when 0020
  is accepted. The text below is left as it was decided.

## Context

The three published tarballs are built in the step 2 build container of
[`RELEASING.md`](../../RELEASING.md), and their `sha512` integrity values
are compared **within that one build** (step 4 recomputes them from the
same files). No second, independent build is compared (security advisory
L7 of #37, not adopted).

In #37's QA (A3) the react tarball's integrity differed between a "CI"
container on `node:24` and the step 2 container on
`node:24@sha256:9d26…`, while protocol and client matched. #53 looked for
the cause ([`docs/issues/53/architecture.md`](../issues/53/architecture.md)).
What it found:

- The two images are the same on this host. `node:24` locally was
  `node@sha256:a2bdd7da…`, and the pin is `node@sha256:9d266751…`. Both are
  multi-platform indexes that point to the **same** `linux/amd64` manifest
  (`sha256:aca79828…`, identical layers). They differ only in the arm64
  entry and its attestation. Node 24.22.3, npm 11.19.1, corepack 0.36.0 and
  pnpm 10.28.0 (from `packageManager`) are the same in both.
- Built the same way in both images (minimal build, test-first CI order,
  `pnpm release:dry-run` order, and the full `RELEASING.md` step 2 block
  run as written), all three tarballs are byte-identical, react included
  (`sha512-ZA0Bjbm…`). The `G3AJtSQ…` value from #37 does not come back
  on any documented build path. #37's round 1 QA notes say its step 2 run
  stopped at `pnpm test`, so that value came from a run that #37 did not
  record. It did not come from the image.
- `pnpm pack` output is otherwise deterministic. Entry order, modes (0644),
  mtimes (fixed 1985-10-26), uid/gid 0 and the gzip mtime (0) are all fixed.
  The only thing that changed between environments was the gzip header's OS
  byte. A build on the Windows host writes `0x0a` and Linux writes `0x03`,
  which changes the sha512 of **all three** tarballs, while their tar
  content stays byte-identical.
- A Node version bump (a new image digest) can also change the bytes. Node
  ships its own zlib (1.3.2.1 in the image, 1.3.1 on the host), and the
  deflate output is not promised to stay the same across zlib versions.

So the build is already reproducible for the same commit in the same
pinned image. It is not reproducible across host operating systems, and it
is not promised across Node image bumps.

## Options

1. **A. Document the scope (recommended).** Say in `RELEASING.md` what the
   integrity values are reproducible across: the same commit in the
   pinned image on a Linux/amd64 Docker engine. Say what breaks them: a
   host-OS build (gzip OS byte) or a digest bump (Node/zlib). Extend the pin
   update procedure: re-run the dry run after a bump and expect new values.
   - Pros: docs only, no change to the bytes that get published, matches
     how the release works today (one build, values compared within it).
   - Cons: a future L7-style second build would still need care.
2. **B. A plus a compression-independent content digest.** `pack:check`
   also writes the sha512 of each **uncompressed** tar to a separate file
   (not `INTEGRITY.txt`, which step 4 parses), so two builds can be
   compared even across gzip implementations or host OSes.
   - Pros: makes an L7-style comparison possible later without
     byte-identical gzip.
   - Cons: release script and test changes for a comparison nobody runs
     today (L7 was not adopted). It is one more value to explain, and it
     touches the release tooling, which needs a review.
3. **C. Normalize the gzip stream** (force the OS byte, or recompress with
   one fixed implementation) so the `.tgz` is identical on every host.
   - Pros: identical tarballs everywhere.
   - Cons: post-processes the bytes npm publishes, depends on zlib
     internals that can still change, and fixes a case (host builds) that
     the release never uses.

## Decision

**A** (accepted at Gate 2, 2026-11-23, by the user). The release builds
only in the pinned container and compares integrity only within that build,
and there the output is already reproducible. The open problem was the unexplained #37 value, not the build.
B is the cheap follow-up if an independent second build is ever adopted
(L7). C is not worth it.

## Consequences

- `RELEASING.md` states the reproducibility scope under "Known limits" and
  the pin bullet in "Before you start" gains the after-bump check.
- A marker test keeps that statement in place.
- Comparing integrity values from a host build, or from a different image
  digest, is documented as not meaningful.
- If L7 is adopted later, revisit with option B.
