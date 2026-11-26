# Architecture: #82 fix(release): narrow the ghcr token scope and pin buildkit in the server image step

Path: fast. Spec: [spec.md](spec.md). Source findings: M2, M3 in
[docs/issues/77/security.md](../77/security.md).

## Repo layout
- Layout: `monorepo` (pnpm workspaces, no submodules). One branch, one PR.
- Touched: root `RELEASING.md` (docs) and
  `apps/sync-server/test/release-files.test.ts` (vitest).
- Checks: `pnpm lint` (eslint, prettier, `scripts/release/check-links.ts`
  validates the new `#before-you-start` anchor), `pnpm typecheck`,
  `pnpm --filter @mosherw/sync-server test` (or root `pnpm test`).
- Not touched: `scripts/release/*` (#92 in parallel), `docs/roadmap.md`,
  steps 6/8 REL/IMG guards (#90), reader text beyond the BuildKit pin.

## Decisions
`Decisions: none open`. Pinning the BuildKit image by tag and digest follows
the existing `NODE_IMAGE` / `GITLEAKS_IMAGE` pattern in `RELEASING.md`
"Before you start" (bump in its own reviewed PR). No new dependency in the
repo: the image is already pulled implicitly by `docker buildx create`
today; this only fixes which one.

## Pinned BuildKit reference (resolved 2026-11-26)

```
moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c
```

- `v0.35.1` is the newest non-rc release tag on Docker Hub (tag list via
  `https://hub.docker.com/v2/repositories/moby/buildkit/tags?ordering=last_updated`;
  pushed 2026-11-19; `latest` and `buildx-stable-1` point to the same index
  today).
- Index digest verified three ways, all equal `sha256:baf6138e...0b4c`:
  1. `docker buildx imagetools inspect moby/buildkit:v0.35.1` (Docker 29.2.0):
     `MediaType: application/vnd.oci.image.index.v1+json`, `Digest:` above,
     with `attestation-manifest` entries.
  2. Registry API: `HEAD https://registry-1.docker.io/v2/moby/buildkit/manifests/v0.35.1`
     (anonymous pull token, `Accept: application/vnd.oci.image.index.v1+json`)
     → `docker-content-digest` above.
  3. Docker Hub API `GET /v2/repositories/moby/buildkit/tags/v0.35.1`
     → `"digest"` above, `media_type` OCI index.
- Platform manifests (for the PR record): `linux/amd64`
  `sha256:7583a0667093d941826bcd1d2878d6a360dfd08a82c93e6d6a6f6cce78801e12`,
  `linux/arm64`
  `sha256:dcd3c9ec3a20b8a38ef81bd2cc09e7e89d47d48b6dc29145755e18cc2c9cca26`.
- Provenance (`--format '{{json .Provenance}}'`): built from
  `https://github.com/moby/buildkit.git#refs/tags/v0.35.1`, commit
  `a8968b7a0ed010b1db5a65e09f1b1990c205cbe3`.

The engineer re-runs check 1 before committing and stops (`BLOCKED`) if the
digest differs.

## Approach
Docs + test only. Three edits to `RELEASING.md`, one test chunk.

1. **Step 6 GHCR token (M2).** Rewrite the GitHub bullet in
   "### 6. The server image" to match R4: create the **Tokens (classic)**
   token from `https://github.com/settings/tokens/new?scopes=write:packages`
   (that link ticks only `write:packages`, which adds `read:packages`);
   before generating it, check the scope list: only `write:packages` and
   `read:packages` may be ticked; GitHub's form can tick `repo` along with
   it: if `repo` is ticked, **untick `repo`** (a `repo` token could push
   code and move tags). Keep every phrase the existing test
   `needs a classic GHCR token ...` asserts (`**Tokens (classic)**`,
   `**untick `repo`**`, `only `write:packages` and `read:packages``,
   `fine-grained`, the GHCR error text, `never "No expiration"`) and the
   `ghp_` prefix sentence. The push block code is unchanged.
2. **BuildKit pin (M3).** Replace both prose commands
   `docker buildx create --use --name sync-release` (step 6 after the push
   block, R3 after the check block) with exactly:
   ```
   docker buildx create --use --name sync-release --driver docker-container --driver-opt image=moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c
   ```
   Add, in step 6 only (R3 links to it, no duplicated text in the reader
   section beyond the pinned command): if buildx reports that `sync-release`
   already exists, it may be an older builder on an unpinned BuildKit: run
   `docker buildx rm sync-release` and create it again; then
   `docker buildx inspect --bootstrap sync-release` and
   `docker inspect -f '{{.Config.Image}}' buildx_buildkit_sync-release0`
   must print the pinned reference. Also one sentence: the default builder
   (Docker Desktop's `docker` driver) uses the BuildKit built into Docker
   itself, which is updated with Docker, not by this pin.
3. **Bump note.** In "## Before you start", after the gitleaks bump
   paragraph: the `sync-release` builder's BuildKit image is pinned by tag
   and digest (the reference above); bump it in its own reviewed PR:
   `docker buildx imagetools inspect moby/buildkit:<vX.Y.Z>` on a release
   tag (never `latest`, `buildx-stable-1`, `master`, `nightly`, or an rc)
   shows the new index digest with `attestation-manifest` entries,
   `--format '{{json .Provenance}}'` shows the build from
   `https://github.com/moby/buildkit.git#refs/tags/<vX.Y.Z>`; replace the
   reference in every `docker buildx create` line (the release-files test
   requires them identical); record old/new index digests in the PR; on the
   host, `docker buildx rm sync-release` before the next release.

Rejected: a `BUILDKIT_IMAGE=` shell variable in the pinned block. The
commands are run ad hoc in prose, often in a resumed terminal where the
variable is unset; an unset variable would yield `image=` and silently fall
back to the default image. A literal reference in each command is safer and
the test enforces that the copies match.

## Files to change
- `RELEASING.md`: step 6 GitHub token bullet (scoped URL + scope check);
  step 6 and R3 `docker buildx create` lines pinned; step 6 stale-builder
  and verify sentences; BuildKit bump note in "Before you start".
- `apps/sync-server/test/release-files.test.ts`: new assertions (below).

## Contracts / data model / Docker
- Contracts: none. Data model: none.
- `Docker impact: none` for the repo's Dockerfiles/compose; the change only
  affects the maintainer's local buildx builder during a release.

## Docs impact
`RELEASING.md` is the deliverable (chunks 1-2). No README, protocol,
self-hosting or conventions change. `docs/roadmap.md` untouched.

## Risks / edge cases
- An existing `sync-release` builder from an earlier release keeps its old
  (unpinned) BuildKit; `create` errors on the name. Covered by the `rm` +
  `inspect` sentence.
- The pinned digest ages (BuildKit security fixes). Mitigated by the bump
  note; same residual as `NODE_IMAGE`.
- The pin only covers the `docker-container` builder; the default
  `docker` driver uses Docker's embedded BuildKit (stated in the doc).
- Hub tag `v0.35.1` could be re-pushed: the digest pin makes that
  irrelevant (pull by digest fails or gets the pinned bytes).
- Prettier may re-wrap the long inline command; keep it on one line inside
  backticks (prettier does not break inline code) and check the test's
  line-based match still holds.
- Concurrent #92 edits `scripts/release/*` only; #90 will touch step 6/8
  code blocks. This PR edits step 6 prose only, so the merge conflict risk
  with #90 is low (different paragraphs).

## Security-sensitive areas
Security-sensitive: yes
- Secrets/credentials handling: step 6 GHCR token scope (M2), text in
  `RELEASING.md` step 6.
- Supply chain / build-time dependency: the BuildKit image that performs
  the registry push with the session's credentials (M3), in step 6 and R3.

## Implementer model
Implementer model: opus
Reason: `Security-sensitive: yes` (credential scope and push-path supply
chain) rules out sonnet, although the edit is small and follows the R4 and
`NODE_IMAGE` patterns.

## Test plan (vitest, `apps/sync-server/test/release-files.test.ts`)
In `describe('RELEASING.md load-bearing lines ...')`:
- **AC1/AC2** `creates the step 6 GHCR token from the scoped URL and checks its scopes (#82, M2)`:
  `step('6. The server image')` contains
  `https://github.com/settings/tokens/new?scopes=write:packages`; flattened
  text matches `/if `repo` is ticked,\s+\*\*untick `repo`\*\*/` (or the exact
  final wording) and `only `write:packages` and `read:packages``; the URL
  and the scope check both come before the push block's ```` ```sh ````
  (index comparison). Existing `needs a classic GHCR token` test keeps
  passing unchanged.
- **AC3** `pins BuildKit by digest in every buildx create (#82, M3)`:
  - Lines of the whole doc containing `docker buildx create`: at least 2,
    one inside `step('6. The server image')` and one inside the reader
    `R3. Check the image` section (slice by heading as the reader describe
    does), and the substring count equals the line count (no line with two).
  - Each such line matches
    `/docker buildx create --use --name sync-release --driver docker-container --driver-opt image=(moby\/buildkit:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64})`/`
    and all captured references are identical.
  - Every `moby/buildkit` occurrence in the doc is followed by
    `:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}` (like the `node:24` test), except
    the bump note's `<vX.Y.Z>` placeholder, which is matched explicitly.
  - Step 6 contains `docker buildx rm sync-release` and
    `buildx_buildkit_sync-release0`.
- **AC4** `has a BuildKit bump note (#82, M3)`: the "## Before you start"
  section contains `imagetools inspect moby/buildkit:`, the pinned
  reference equal to the one in the create lines, and
  `refs/tags/`.
- **AC5** is these tests themselves.
- Full run: `pnpm lint`, `pnpm typecheck`, `pnpm test` green (check-links
  validates any new anchor). Manual: render the step 6 and R3 sections and
  confirm the command copy-pastes as one line.

## Implementation chunks
1. `docs(release): create the step 6 ghcr token from the scoped url` (M2 text in step 6)
2. `docs(release): pin the buildkit image of the release builder` (both create lines, stale-builder/verify sentences, bump note)
3. `test(release): assert the scoped ghcr url and the buildkit pin`

(Chunks 1-2 are the docs deliverable; there is no separate docs chunk.
The engineer updates `STATE.md` with the plan-approved flag in chunk 1 or
its own `docs(state)` commit.)
