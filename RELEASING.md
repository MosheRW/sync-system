# Releasing

How the maintainer releases the three npm packages and the server image, by
hand, without GitHub Actions. The decisions behind it are
[ADR 0016](docs/decisions/0016-versioning-and-npm-release.md) (versions, npm)
and [ADR 0017](docs/decisions/0017-server-image-publishing.md) (image); the
version rules are [`docs/versioning.md`](docs/versioning.md).

**Only the maintainer runs Phase B.** Agents and automation prepare the
release PR and run the [dry run](#dry-run-qa); they never tag, publish, push
an image or create a GitHub release.

## The rule

Code that runs project dependencies never sees a credential, and the place
that holds a credential runs no project code. Three places:

| Place                 | Runs                                                                           | Credentials                                  |
| --------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| The host              | `git tag`, `git bundle`, `docker`, the image build and push                    | your git login; the registry tokens (step 6) |
| The build container   | install, audit, lint, typecheck, test, build, smoke, `pack:check`              | none, ever                                   |
| The publish container | `npm publish` of three checked tarballs; no clone, no install, no project code | the npm token only (step 4)                  |

## Before you start

- Docker with `buildx` (Docker Desktop is fine), `git`, `gh` (logged in),
  `bash`. On Windows use Git Bash; every block below starts with
  `export MSYS_NO_PATHCONV=1` so container paths such as `/release/...` are
  not rewritten, and converts host paths with `cygpath -m`.
- **Paste each block as one piece and only that block.** Each credential
  block is one `( set -euo pipefail; ... )` subshell, so its `trap ... EXIT`
  cleanup runs when the block ends (or fails), not when the terminal closes.
  Never turn on shell tracing (`-x`) in a block: it would print the token.
- The container images are pinned by digest. Bump the Node image only on
  purpose, like this ([ADR 0020](docs/decisions/0020-deterministic-packed-manifests.md)):
  - Make the bump its own PR, reviewed by a second person (or a second
    session) who re-runs the checks below.
  - Run `docker buildx imagetools inspect docker.io/library/node:24` (or the
    exact `24.x.y` tag). It must show the new index digest from the
    official `library/node` repository, the index must have
    `attestation-manifest` entries, and `--format '{{json .Provenance}}'`
    must show the Docker Official Images build.
  - `node --version` in a container of the new digest must be listed in
    `https://nodejs.org/dist/index.json` and must not be older than the
    current pin.
  - Replace the digest in every block (and in this file's dry run). Record
    the old and new index digests and the `linux/amd64` manifest digest in
    the PR.
  - Run the [dry run](#dry-run-qa)'s step 2 block (`MODE=dry-run`) **twice**
    on the new digest, each run on its own (nothing else heavy on the machine). Step 2 deletes
    `$REL/out`, so save the first file before the second run with
    `cp "$REL/out/INTEGRITY.txt" "$REL/integrity-run1.txt"`, then
    `diff "$REL/integrity-run1.txt" "$REL/out/INTEGRITY.txt"` must print
    nothing. The two runs must be identical. Their values are the new
    baseline; record them in the PR. Never compare them with the old
    digest's values: a new image can ship a different zlib (see
    [Known limits](#known-limits)).

```sh
# the Node 24 image, pinned by digest (bump deliberately, see above)
NODE_IMAGE='node:24@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496'
```

## Phase A: the release PR

1. Every user-visible change adds a changeset (`pnpm changeset`) in its PR.
2. On a release branch: `pnpm changeset version`. It bumps the fixed group
   (protocol, client, react, server) to one version and writes the
   `CHANGELOG.md` files. Commit them with the message
   `chore(release): version packages for X.Y.Z`.
3. Review the versions and changelogs, run the [dry run](#dry-run-qa), and
   merge the PR. What `main` then says is exactly what gets released.

## Phase B: release (maintainer only, after the merge)

Set these in your shell first (none of them is a secret):

```sh
export V=1.0.0                 # the version the release PR set
export PR=0                    # replace 0 with the release PR number
export REL="$(mktemp -d)"      # outside the repo: bundle and checked tarballs
```

### 0. First release only: ownership checklist (before the repo goes public)

Do all of this **before** the repository is made public:

- [ ] npm: `npm whoami` prints `mosherw`, and the account owns the scope
      (`npm access list packages @mosherw`). Account 2FA is on for
      **"Authorization and writes"** (a security key if available, else
      TOTP), recovery codes are stored offline, and the account's Access
      Tokens page lists **no** token (no classic and no older granular
      tokens).
- [ ] Docker Hub: the public repository `mosherw/sync-system-server` exists
      under your account.
- [ ] GHCR: the `ghcr.io/mosherw` namespace is your GitHub account.
- [ ] Run `gitleaks git --redact` over the full history (it must find
      nothing), and check the repo settings (Actions secrets, environments,
      deploy keys) and the issue and PR comments for secrets.
- [ ] History is **not** rewritten (decided at #37 Gate 2: the personal
      author email stays in old commits). `git config user.email` is the
      GitHub noreply address. `.claude.zip` is untracked.
- [ ] Enable GitHub private vulnerability reporting (Settings, Security;
      see [`SECURITY.md`](SECURITY.md)).
- [ ] Then make the repository public. The package metadata links to it.

### 1. Tag on the host

With your normal git credentials; nothing goes into a container. This is
the only git write of the release.

```sh
( set -euo pipefail
  [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  git fetch origin
  M="$(gh pr view "$PR" --json mergeCommit --jq .mergeCommit.oid)"
  [[ "$M" =~ ^[0-9a-f]{40}$ ]] || { echo 'the PR has no merge commit'; exit 1; }
  git merge-base --is-ancestor "$M" origin/main
  for p in packages/protocol packages/client packages/react apps/sync-server; do
    git show "$M:$p/package.json" | grep -q "\"version\": \"$V\"" || { echo "$p is not $V"; exit 1; }
  done
  git tag -a "v$V" "$M" -m "v$V"
  git push origin "v$V"
  echo "export M=$M"
)
```

Run the printed `export M=...` line: later steps check every build against
this commit.

### 2. Build container (no credential)

Builds and checks the tagged commit from a `git bundle` (objects and refs
only: no remote, no credential), with a Redis sidecar for the Redis tests,
then keeps the three checked tarballs and prints their integrity lines.

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  NODE_IMAGE='node:24@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496'
  REDIS_IMAGE='redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335'
  REF="${REF:-v$V}"; MODE="${MODE:-release}"
  [[ "$M" =~ ^[0-9a-f]{40}$ ]] || { echo 'set M (step 1)'; exit 1; }
  H="$REL"; if command -v cygpath >/dev/null; then H="$(cygpath -m "$REL")"; fi
  rm -rf "$H/out" "$H/release.bundle"
  git bundle create "$H/release.bundle" "$REF"
  trap 'docker rm -f sync-release-build sync-release-redis >/dev/null 2>&1 || true; docker network rm sync-release-net >/dev/null 2>&1 || true' EXIT
  docker network create sync-release-net >/dev/null
  docker run -d --name sync-release-redis --network sync-release-net "$REDIS_IMAGE" \
    redis-server --requirepass ci-only-redis-password --save '' --appendonly no --maxmemory-policy noeviction >/dev/null
  docker create --name sync-release-build --network sync-release-net -w / \
    -e CI=true -e SYNC_TEST_REDIS_URL=redis://:ci-only-redis-password@sync-release-redis:6379 \
    -e REF="$REF" -e SHA="$M" -e MODE="$MODE" "$NODE_IMAGE" bash -c '
      set -euo pipefail
      git clone --quiet --branch "$REF" /release.bundle /src
      cd /src
      test "$(git rev-parse HEAD)" = "$SHA"
      test -z "$(git status --porcelain)"
      corepack enable
      export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
      pnpm install --frozen-lockfile
      pnpm audit --audit-level=high
      pnpm lint
      pnpm typecheck
      pnpm test
      pnpm build
      pnpm smoke
      if [ "$MODE" = dry-run ]; then
        pnpm release:dry-run
        mkdir /out && cp .release-out/* /out/
      else
        pnpm pack:check --out /out
      fi
      cat /out/INTEGRITY.txt' >/dev/null
  docker cp "$H/release.bundle" sync-release-build:/release.bundle
  docker start -a sync-release-build
  docker cp sync-release-build:/out "$H/out"
  echo '--- keep these three lines (paste them into the release notes draft):'
  cat "$H/out/INTEGRITY.txt"
)
```

`corepack enable` checks the pnpm download against the `sha512` in the root
`package.json`. The tests run with `CI=true`, so the Redis suites cannot be
skipped. Keep the three printed `sha512-...` lines.

`pnpm test` includes the CI workflow check, which accepts the paused state
of [ADR 0018](docs/decisions/0018-ci-workflow-while-actions-is-blocked.md)
(the `# CI paused (#54):` marker in `.github/workflows/ci.yml`). While the
workflow is paused, this build container is the only full CI run of the
release commit: it must finish green, and there is no GitHub check to fall
back on.

### 3. Create the npm token (right before step 4, never earlier)

On npmjs.com: Access Tokens, Generate New Token, **Granular Access Token**:

- Name `sync-system-release-vX.Y.Z`.
- Expiration: **the shortest custom date offered (1 day)**; 7 days only if
  the form offers no custom date.
- Packages and scopes: **Read and write**, "Only select packages and
  scopes": the three packages from the second release on. For the first
  release (the packages do not exist yet) select the `@mosherw` scope; if
  the form cannot limit a name that does not exist yet, use "All packages"
  (the account owns no other packages, step 0) and note which you used.
- Organizations: no access.
- Allowed IP ranges: your host's current public IPv4 address as `/32` (and
  its IPv6 range if your host reaches npm over IPv6). The publish container
  leaves through the host's NAT, so the address matches. Skip this only if
  the form lacks it, and note that.
- **Bypass two-factor authentication: on.** This is required: the token
  publishes without a one-time password. It is the trade-off accepted for
  ADR 0016 option E2; the limits above and step 5 keep its life short.

Creating the token needs your account 2FA. Before copying it, turn off
clipboard sync across devices (Windows: Settings, System, Clipboard). Copy
the token from the page straight into the step 4 prompt: never into a file,
a password manager, a note or a chat. Right after the paste, clear the
clipboard and the clipboard history (Windows: Win+V, Clear all).

### 4. Publish container (the npm token only)

A fresh container that runs no project code receives only the three
tarballs and `INTEGRITY.txt`. Every check runs **before** the token exists
anywhere. The token goes in once, over `docker exec -i` standard input,
into a mode-600 `/root/.npmrc` of this container, and nowhere else: not in
a command line, an environment variable of a container, a host file or the
shell history. Paste only the first block below:

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  NODE_IMAGE='node:24@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496'
  [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  C=sync-release-publish
  H="$REL"; if command -v cygpath >/dev/null; then H="$(cygpath -m "$REL")"; fi
  # Cleanup on every exit path (failed check, failed publish, Ctrl-C, Ctrl-D,
  # end of block). Each command may fail without skipping the next.
  trap 'unset NPM_TOKEN; docker exec "$C" npm logout >/dev/null 2>&1 || true; docker rm -f "$C" >/dev/null 2>&1 || true' EXIT
  docker run -d --rm --name "$C" "$NODE_IMAGE" sleep infinity >/dev/null
  docker cp "$H/out/." "$C:/release"

  # Checks before the token exists. File names are literal, never read from
  # INTEGRITY.txt or the directory.
  EXPECTED="INTEGRITY.txt
mosherw-sync-system-client-$V.tgz
mosherw-sync-system-protocol-$V.tgz
mosherw-sync-system-react-$V.tgz"
  [ "$(docker exec "$C" sh -c 'ls -A /release | LC_ALL=C sort')" = "$EXPECTED" ] || { echo 'unexpected files in /release'; exit 1; }
  [ -z "$(docker exec "$C" find /release -mindepth 1 ! -type f)" ] || { echo 'not only regular files'; exit 1; }
  manifest () { # $1 package name, $2 tarball file name
    docker exec "$C" sh -c 'tar -xOzf "/release/$1" package/package.json | node -e "
      const m = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\"));
      if (m.name !== process.argv[1] || m.version !== process.argv[2]) process.exit(1);" "$2" "$3"' \
      sh "$2" "$1" "$V" || { echo "$2: packed name or version is wrong"; exit 1; }
  }
  manifest @mosherw/sync-system-protocol "mosherw-sync-system-protocol-$V.tgz"
  manifest @mosherw/sync-system-client "mosherw-sync-system-client-$V.tgz"
  manifest @mosherw/sync-system-react "mosherw-sync-system-react-$V.tgz"
  docker exec "$C" node -e '
    const { createHash } = require("crypto"); const { readFileSync } = require("fs");
    for (const f of process.argv.slice(1)) console.log(f.split("/").pop() + " sha512-" + createHash("sha512").update(readFileSync(f)).digest("base64"));' \
    "/release/mosherw-sync-system-protocol-$V.tgz" "/release/mosherw-sync-system-client-$V.tgz" "/release/mosherw-sync-system-react-$V.tgz" > "$H/recomputed.txt"
  diff "$H/recomputed.txt" "$H/out/INTEGRITY.txt" || { echo 'integrity differs from INTEGRITY.txt'; exit 1; }
  cat "$H/recomputed.txt"
  read -r -p 'Are these the three lines you kept from step 2? Type yes: ' SAME
  [ "$SAME" = yes ] || exit 1

  # The token: the only hop. read -rs does not echo; printf is a shell
  # builtin, so the token is in no process's argument list.
  read -rs -p 'npm token: ' NPM_TOKEN; echo
  [ -n "${NPM_TOKEN:-}" ] || { echo 'no token'; exit 1; }
  case "$NPM_TOKEN" in npm_*) ;; *) echo 'not an npm granular token'; exit 1 ;; esac
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" | docker exec -i "$C" sh -c 'umask 077 && cat > /root/.npmrc'
  unset NPM_TOKEN
  [ "$(docker exec "$C" npm whoami)" = mosherw ] || { echo 'npm whoami is not mosherw'; exit 1; }

  publish () { # $1 package name, $2 tarball file name; a re-run skips what is already there
    if docker exec "$C" npm view "$1@$V" version >/dev/null 2>&1; then echo "$1@$V already published, skipped"; return 0; fi
    docker exec "$C" npm publish "/release/$2" --access public --ignore-scripts
  }
  publish @mosherw/sync-system-protocol "mosherw-sync-system-protocol-$V.tgz"
  publish @mosherw/sync-system-client "mosherw-sync-system-client-$V.tgz"
  publish @mosherw/sync-system-react "mosherw-sync-system-react-$V.tgz"
  docker exec "$C" npm logout >/dev/null 2>&1 || true
  docker exec "$C" rm -f /root/.npmrc

  verify () { # $1 package name, $2 tarball file name: anonymous registry read
    want="$(grep "^$2 " "$H/out/INTEGRITY.txt" | cut -d' ' -f2)"
    for attempt in 1 2 3 4 5 6; do
      got="$(docker exec "$C" npm view "$1@$V" dist.integrity 2>/dev/null || true)"
      if [ -n "$want" ] && [ "$got" = "$want" ]; then echo "$1@$V dist.integrity ok"; return 0; fi
      sleep 10
    done
    echo "$1@$V: dist.integrity differs from the checked tarball: INCIDENT (deprecate, revoke, report)"; return 1
  }
  verify @mosherw/sync-system-protocol "mosherw-sync-system-protocol-$V.tgz"
  verify @mosherw/sync-system-client "mosherw-sync-system-client-$V.tgz"
  verify @mosherw/sync-system-react "mosherw-sync-system-react-$V.tgz"
)
```

Run this check separately, after the block above has finished (do not paste it together with that block):

```sh
docker ps -a --filter name=sync-release-publish   # must list no container
```

`npm publish <tarball>` publishes the bytes `pack:check` verified: pnpm
already replaced the `workspace:*` ranges with the exact version and applied
`publishConfig.exports` when it packed them. Releases always publish these
tarballs by path, never from the workspace and never with Changesets.

If the block stopped after a partial publish, the cleanup already ended the
token's session: start again at **step 3 with a new token**; the re-run
skips what is already published. Step 5 revokes every token created.

### 5. Revoke the npm token (now, before the image push)

On npmjs.com, Access Tokens: delete `sync-system-release-vX.Y.Z` (and any
other token created for this release). Do this even if the cleanup logged
out. The page must list **no** token afterwards. Revoke within minutes; the
expiry is only the backstop.

### 6. The server image (on the host)

Build from a fresh clone of the tag, check it, then push one multi-platform
build with the same tags to both registries.

Check first (no credential):

```sh
export IMG="$(mktemp -d)"
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  [[ "$M" =~ ^[0-9a-f]{40}$ ]] || { echo 'set M (step 1)'; exit 1; }
  SRC_URL="${SRC_URL:-https://github.com/MosheRW/sync-system.git}"; REF="${REF:-v$V}"
  D="$IMG"; if command -v cygpath >/dev/null; then D="$(cygpath -m "$IMG")"; fi
  git clone --quiet --branch "$REF" --depth 1 "$SRC_URL" "$D/src"
  [ "$(git -C "$D/src" rev-parse HEAD)" = "$M" ] || { echo 'the clone is not the release commit'; exit 1; }
  [ -z "$(git -C "$D/src" status --porcelain)" ] || { echo 'the clone is not clean'; exit 1; }
  docker buildx build --platform linux/amd64 --load -f "$D/src/apps/sync-server/Dockerfile" \
    --label "org.opencontainers.image.version=$V" --label "org.opencontainers.image.revision=$M" \
    -t "sync-release-check:$V" "$D/src"
  trap 'docker rm -f sync-release-health >/dev/null 2>&1 || true' EXIT
  docker create --name sync-release-health -e NODE_ENV=development -e SYNC_CONFIG_PATH=/tmp/apps.json "sync-release-check:$V" >/dev/null
  docker cp "$D/src/config/apps.dev.json" sync-release-health:/tmp/apps.json
  docker start sync-release-health >/dev/null
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if H="$(docker exec sync-release-health node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null)"; then break; fi
    sleep 1
  done
  echo "$H"
  echo "$H" | grep -q "\"version\":\"$V\"" || { echo '/health version is not the tag'; exit 1; }
  docker inspect -f '{{json .Config.Labels}}' "sync-release-check:$V"
)
```

Create two tokens, each with the shortest expiry offered: a GitHub
**classic** personal access token with only `write:packages`, and a Docker
Hub personal access token limited to the `mosherw/sync-system-server`
repository if offered (else "Read & Write"). Then push. The registry logins
use a temporary `DOCKER_CONFIG`, and the `trap` is set before the first
login so both logouts and the removal of the config run on every exit:

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  [[ "$M" =~ ^[0-9a-f]{40}$ ]] || { echo 'set M (step 1)'; exit 1; }
  [[ "$V" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"
  D="$IMG"; if command -v cygpath >/dev/null; then D="$(cygpath -m "$IMG")"; fi
  CFG="$(mktemp -d)"; if command -v cygpath >/dev/null; then CFG="$(cygpath -m "$CFG")"; fi
  export DOCKER_CONFIG="$CFG"
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true; docker logout docker.io >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
  read -rs -p 'GHCR token (write:packages): ' T; echo
  printf '%s' "$T" | docker login ghcr.io -u mosherw --password-stdin
  unset T
  read -rs -p 'Docker Hub token: ' T; echo
  printf '%s' "$T" | docker login docker.io -u mosherw --password-stdin
  unset T
  docker buildx build --platform linux/amd64,linux/arm64 --push \
    -f "$D/src/apps/sync-server/Dockerfile" \
    --label "org.opencontainers.image.version=$V" --label "org.opencontainers.image.revision=$M" \
    -t "ghcr.io/mosherw/sync-system-server:$V" -t "ghcr.io/mosherw/sync-system-server:$MAJOR.$MINOR" \
    -t "ghcr.io/mosherw/sync-system-server:$MAJOR" -t ghcr.io/mosherw/sync-system-server:latest \
    -t "docker.io/mosherw/sync-system-server:$V" -t "docker.io/mosherw/sync-system-server:$MAJOR.$MINOR" \
    -t "docker.io/mosherw/sync-system-server:$MAJOR" -t docker.io/mosherw/sync-system-server:latest \
    "$D/src"
  docker buildx imagetools inspect "ghcr.io/mosherw/sync-system-server:$V"
  docker buildx imagetools inspect "docker.io/mosherw/sync-system-server:$V"
)
```

Record the manifest-list `Digest:` both inspections print (it is the same
image). If the default builder cannot build two platforms, run
`docker buildx create --use --name sync-release` once and repeat the block.

After the block, check that no registry login is left on the host. Use
your platform's credential helper (Docker Desktop: `docker-credential-desktop
list`; Windows: `docker-credential-wincred list`; macOS:
`docker-credential-osxkeychain list`) and look at `~/.docker/config.json`:
neither may show `ghcr.io` or `index.docker.io`. If one does, run
`docker logout <registry>`.

Then **revoke both registry tokens** (GitHub, Settings, Developer settings,
Personal access tokens; Docker Hub, Account settings, Personal access
tokens).

### 7. GitHub release notes

Write `notes.md`: the version's section from `apps/sync-server/CHANGELOG.md`
(the same text as in the packages' changelogs), then the three integrity
lines kept from step 2 and the image's manifest-list digest from step 6, so
users can pin and compare:

```md
**Verify**

npm `dist.integrity`:

- mosherw-sync-system-protocol-X.Y.Z.tgz sha512-...
- mosherw-sync-system-client-X.Y.Z.tgz sha512-...
- mosherw-sync-system-react-X.Y.Z.tgz sha512-...

Image `ghcr.io/mosherw/sync-system-server:X.Y.Z` (and docker.io): `sha256:...`
```

```sh
gh release create "v$V" --title "v$V" --notes-file notes.md
```

### 8. After the release

- First release only: set the GHCR package `sync-system-server` public
  (GitHub, Packages, Package settings). On npmjs.com set each of the three
  packages' **Publishing access** to "**Require two-factor authentication or
  a granular access token with bypass 2FA enabled**". That is the setting
  this process needs: publishing without a token needs a one-time password,
  and only a granular token with bypass 2FA publishes without one. Do not
  use "Require two-factor authentication and disallow tokens" (it would
  refuse the step 3 token) and never "Don't require two-factor
  authentication".
- Every release: `rm -rf "$REL" "$IMG"`, and check that the npm Access
  Tokens page and both registries' token lists hold nothing from this
  release.

## Dry run (QA)

The same steps without a tag, a token, a login, a push or a publish (AC54).
From the repo, on the release PR's branch:

```sh
export V=1.0.0 REL="$(mktemp -d)"
export REF="$(git rev-parse --abbrev-ref HEAD)" M="$(git rev-parse HEAD)" MODE=dry-run
```

1. Run the **step 2** block. With `MODE=dry-run` the build container runs
   `pnpm release:dry-run` (`npm publish <tarball> --dry-run` for each
   checked tarball, no token, no `.npmrc`) and prints the three integrity
   lines.
2. Run the **step 4** block up to the token prompt, answer `yes` to the
   integrity question, then abort at `npm token:` with Ctrl-D (no token
   involved). `docker ps -a --filter name=sync-release-publish` must then
   list no container.
3. Run step 6's **check** block from your local clone instead of GitHub:
   `export IMG="$(mktemp -d)" SRC_URL="file://$(if command -v cygpath >/dev/null; then cygpath -m "$(pwd)"; else pwd; fi)"`
   first. Git Bash needs the `cygpath -m` form because the block sets
   `MSYS_NO_PATHCONV=1`. The block then clones `$REF`, checks `M`, builds
   `linux/amd64` with `--load` and checks that `/health` reports `V`. Do not
   run the push block.

## Residual risk

- The tarballs are built in the build container, so a compromised
  development dependency could still change `dist/` before packing and print
  matching integrity values. `pack:check` limits which files ship, not their
  content. The two-container split removes credential theft and
  self-republishing; content integrity rests on the frozen, audited
  lockfile, as in CI. (Comparing the hashes with an independent second build
  was considered and not adopted.)
- The npm token is a bearer credential that publishes without a one-time
  password. It is exposed on the npmjs.com page, the clipboard, one host
  shell variable and the publish container, and it is bounded by the package
  or scope limit, the IP allowlist, the short expiry and revocation within
  minutes (step 5). A host compromised during those minutes could use it.
- Registry tokens are exposed the same way, briefly, on the host; they are
  scoped, short-lived and revoked after the release.

## Known limits

- No npm provenance (`npm audit signatures` shows the packages as unsigned),
  and no image signature or SBOM. The release notes' integrity values and
  digest are the way to verify.
- Moving to automation later, once GitHub Actions is available: npm trusted
  publishing (OIDC) with `--provenance` from a workflow replaces the step 3
  token; `docker/build-push-action` with provenance and SBOM attestations
  replaces step 6's push. The checks (`pack:check`, `smoke`) stay the same.
- The tarball integrity values are identical across pack runs of the same
  commit in the pinned image on a linux/amd64 Docker engine (tag names that
  resolve to the same linux/amd64 manifest give the same bytes). This holds
  because `pack:check` refuses a published package with two `workspace:`
  ranges in one dependency map (pnpm 10 writes those keys in the order its
  disk reads finish, which made react's value flip between runs) and
  refuses any pnpmfile. A build on another host OS (the gzip header's OS
  byte) or in a new image digest (Node's bundled zlib) still gives
  different values for all three tarballs, while their content stays the
  same. The integrity check itself stays within one build: step 4
  recomputes the values from the same files that step 2 hashed. Identity
  across runs is a property, used for the post-bump baseline, not the check
  ([ADR 0020](docs/decisions/0020-deterministic-packed-manifests.md), #53).
- Every `pnpm pack` the release scripts run (`pack:check`,
  `release:dry-run`, `smoke`) passes `--config.ignore-pnpmfile=true`, so no
  pnpmfile hook can rewrite a packed `package.json`, whichever route names
  it: a root `.pnpmfile.cjs`, `pnpmfile` or `global-pnpmfile` in `.npmrc`
  or `pnpm-workspace.yaml`, a `configDependencies` pnpm plugin, an env var,
  or a user or global rc file. `pack:check` also still fails early on a root
  `.pnpmfile.cjs` or a pnpmfile env var (either spelling, `-` or `_`). That
  includes a `pnpmfile` set in `.npmrc` or `pnpm-workspace.yaml`: `pnpm run`
  exports it to the script as `npm_config_pnpmfile`, so `pnpm pack:check`
  fails closed on it too (a test pins this, so a pnpm change that drops the
  export shows up). What
  this does not cover: the outer `pnpm pack:check`, `pnpm smoke` and
  `pnpm install` processes themselves still load a configured pnpmfile or
  config-dependency plugin and run its code (it cannot change the packed
  bytes, but it can change files). So a release-PR reviewer treats any diff
  that adds a `pnpmfile`, `globalPnpmfile` or `global-pnpmfile` setting, a
  `.pnpmfile.cjs`, or a `configDependencies` entry as release-relevant and
  checks it before the merge
  ([ADR 0021](docs/decisions/0021-pack-with-pnpmfiles-ignored.md), #63).
