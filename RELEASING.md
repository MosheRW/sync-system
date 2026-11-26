# Releasing

How the maintainer releases the three npm packages and the server image, by
hand, without GitHub Actions. The decisions behind it are
[ADR 0016](docs/decisions/0016-versioning-and-npm-release.md) (versions, npm)
and [ADR 0017](docs/decisions/0017-server-image-publishing.md) (image); the
version rules are [`docs/versioning.md`](docs/versioning.md).

The reading app's image has its own standalone release: see
[Reader image release](#reader-image-release).

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
  `bash`.
- **The blocks are bash, never PowerShell or cmd.** There
  `( set -euo pipefail`, `$V` and `read -rs` mean something else or nothing
  (PowerShell stops with `ParserError: Missing closing ')'`). On Windows run
  them in Git Bash. From a PowerShell terminal, start bash in it first:
  `& "C:\Program Files\Git\bin\bash.exe" -l` (the prompt changes to `$`),
  then paste the [Phase B setup](#phase-b-release-maintainer-only-after-the-merge)
  and the blocks there. Alternative: save one block to a `.sh` file
  **outside the repo** and run `& "C:\Program Files\Git\bin\bash.exe" <file>`.
  A script does not see variables exported in another shell, so start the
  file with the Phase B setup lines (and `M`, see
  [Resume in another terminal](#resume-in-another-terminal)). Never write a
  token into such a file: blocks read tokens only at their prompt. Delete
  the file after the release.
- Every block starts with `export MSYS_NO_PATHCONV=1` so container paths
  such as `/release/...` are not rewritten in Git Bash, and converts host
  paths with `cygpath -m`.
- **Paste a token only right after its token prompt is visible.** If the
  block has already stopped (a failed check, Ctrl-C), the paste lands at the
  shell prompt, and PowerShell writes it to its history file at once. If a
  token is ever pasted at a shell prompt (PowerShell or bash), revoke it now,
  create a new one, and remove the line from the history file (PowerShell:
  the file `(Get-PSReadLineOption).HistorySavePath` names; bash:
  `history -d <number>`, and `~/.bash_history`).
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
# the secret scanner for step 0, pinned by tag and digest
GITLEAKS_IMAGE='zricethezav/gitleaks:v8.24.0@sha256:2bcceac45179b3a91bff11a824d0fb952585b429e54fc928728b1d4d5c3e5176'
```

Bump the gitleaks image the same way, in its own reviewed PR:
`docker buildx imagetools inspect zricethezav/gitleaks:<tag>` shows the new
index digest, and the step 0 scan with the new reference still prints
`no leaks found`.

The `sync-release` builder of [step 6](#6-the-server-image-on-the-host)
runs a BuildKit image pinned by tag and digest:
`moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c`.
When you start each release, check the
[moby/buildkit security advisories](https://github.com/moby/buildkit/security/advisories):
if the pinned version is affected, bump it first, in its own PR. Bump it
only in its own reviewed PR: `docker buildx imagetools inspect moby/buildkit:<vX.Y.Z>`
on a release tag (never `latest`, `buildx-stable-1`, `master`, `nightly`
or an rc) must show the new index digest with `attestation-manifest`
entries, and `--format '{{json .Provenance}}'` must show the build from
`https://github.com/moby/buildkit.git#refs/tags/<vX.Y.Z>`. Replace the
reference in every `docker buildx create` line (the release-files test
requires them identical), record the old and new index digests in the PR,
and on the host run `docker buildx rm sync-release` before the next
release.

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
unset REF MODE SRC_URL M                # left over from a dry run in this terminal
export V=1.0.0                          # the version on main
export PR=0                             # the merged PR to release, see "Which PR" below
export REL="$HOME/sync-release-$V"      # outside the repo; the same in every terminal
export IMG="$REL/image"                 # the step 6 clone
( set -euo pipefail
  [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  [ ! -L "$REL" ] || { echo "$REL is a symlink"; exit 1; }
  mkdir -p "$REL" && chmod 700 "$REL"
)
```

`$REL` holds the bundle, the checked tarballs and the step 6 clone. It is
fixed per version, so a new terminal finds the same folder. It is outside
the working copy as long as the repo is not checked out at `$HOME` itself.
Nothing secret is ever written there: the npm token goes only into the
publish container, and the registry logins only into step 6's temporary
`DOCKER_CONFIG`. `chmod 700` keeps other users out on Linux and macOS; on
Windows it does nothing in Git Bash, and the user profile's permissions do
that.

### Which PR

`PR` is the **merged PR whose merge commit you release**. Normally that is
the release PR of Phase A. When there is no separate release PR (the
versions reached `main` through another PR), or other PRs were merged after
it, use the newest merged PR on `main`: 1.0.0 was the merge commit of #68
(`d37f1b3`), not of the PR that set the versions. List the candidates:

```sh
gh pr list --state merged --base main --limit 10 --json number,title,mergedAt,mergeCommit \
  --jq '.[] | "\(.number) \(.mergedAt) \(.mergeCommit.oid[0:7]) \(.title)"'
```

Step 1 refuses a merge commit that is not on `origin/main` or where any of
the four `package.json` files is not at `V`, so a wrong pick stops there.

### Resume in another terminal

Every block reads `V`, `PR`, `REL`, `IMG` and (from step 2 on) `M` from the
shell, and a new terminal has none of them. Run the
[Phase B setup](#phase-b-release-maintainer-only-after-the-merge) lines
again with the same `V` and `PR`, then, if step 1 is done, take `M` from the
tag step 1 made (in the same clone; never run step 1 again):

```sh
export M="$(git rev-parse "refs/tags/v$V^{commit}")"
( set -euo pipefail
  [[ "$M" =~ ^[0-9a-f]{40}$ ]] || { echo "no tag v$V here: run step 1 first"; exit 1; }
  git fetch origin
  git merge-base --is-ancestor "$M" origin/main || { echo 'M is not on origin/main'; exit 1; }
  echo "M=$M: it must equal the M in the release notes draft; stop if it differs"
)
```

A token never survives a block, so a resume always starts the credential
step again (step 3 for npm, the step 6 push block) with a new token.

### 0. First release only: ownership checklist (before the repo goes public)

Do all of this **before** the repository is made public:

- [ ] npm: signed in on the host for these checks only, `npm whoami`
      prints **your** npm user `moshe-winberg` (`mosherw` is the npm
      organization that owns the scope, not a user),
      `npm org ls mosherw` lists `moshe-winberg` as `owner`, and
      `npm access list packages @mosherw` shows the scope's packages.
      Account 2FA is on for **"Authorization and writes"** (a security key
      if available, else TOTP) and recovery codes are stored offline.
      End the checks with `npm logout`, then check that the account's
      Access Tokens page lists **no** token (no classic, no older granular
      tokens and no session left by these checks).
- [ ] Docker Hub: `moshewin` is your Docker Hub **username** (Account
      settings), not an organization; step 6 logs in with `-u moshewin`.
      The public repository `moshewin/sync-system-server` exists under that
      account. The old Docker Hub namespace `mosherw` is held only as an
      empty placeholder against look-alikes: never push to it.
- [ ] GHCR: the `ghcr.io/mosherw` namespace is your GitHub account.
- [ ] Scan the full history for secrets with the pinned gitleaks image
      (`GITLEAKS_IMAGE` from [Before you start](#before-you-start)). Run
      the block from the repo root on an up-to-date `main`. The repo is
      mounted read-only, the container has no network and gets no
      credentials, and `--redact` keeps any value out of the output. It
      must print `no leaks found`. Gitleaks reads the reviewed false
      positives from the root `.gitleaksignore` with no flag. A new
      finding is either a real secret (stop: rotate it; history is not
      rewritten without a decision) or a test value (add its fingerprint
      in a reviewed PR, per
      [ADR 0022](docs/decisions/0022-secret-scan-suppressions.md)).

      ```sh
      ( set -euo pipefail
        export MSYS_NO_PATHCONV=1
        [[ "${GITLEAKS_IMAGE:-}" =~ ^zricethezav/gitleaks:v[0-9.]+@sha256:[0-9a-f]{64}$ ]] || { echo 'set GITLEAKS_IMAGE (Before you start)'; exit 1; }
        D="$(pwd)"; if command -v cygpath >/dev/null; then D="$(cygpath -m "$D")"; fi
        docker run --rm --network none -v "$D:/repo:ro" "$GITLEAKS_IMAGE" git /repo --redact
      )
      ```

- [ ] Check the repo settings (Actions secrets, environments, deploy keys)
      and the issue and PR comments for secrets.
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
this commit. Note `M` in the release notes draft too; a
[resumed terminal](#resume-in-another-terminal) compares against it.

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
  [ "$(docker exec "$C" npm whoami)" = moshe-winberg ] || { echo 'npm whoami is not moshe-winberg'; exit 1; }

  publish () { # $1 package name, $2 tarball file name; a re-run skips what is already there
    if docker exec "$C" npm view "$1@$V" version >/dev/null 2>&1; then echo "$1@$V already published, skipped"; return 0; fi
    docker exec "$C" npm publish "/release/$2" --access public --ignore-scripts
  }
  publish @mosherw/sync-system-protocol "mosherw-sync-system-protocol-$V.tgz"
  publish @mosherw/sync-system-client "mosherw-sync-system-client-$V.tgz"
  publish @mosherw/sync-system-react "mosherw-sync-system-react-$V.tgz"
  docker exec "$C" npm logout >/dev/null 2>&1 || true
  docker exec "$C" rm -f /root/.npmrc
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

### 5. Revoke the npm token, then verify the registry

On npmjs.com, Access Tokens: delete `sync-system-release-vX.Y.Z` (and any
other token created for this release). Do this **now**, right after the
`docker ps -a` check, even if the cleanup logged out. The page must list
**no** token afterwards. Revoke within minutes; the expiry is only the
backstop.

Then verify (anonymous, re-run any time). The block needs no token, so it
runs after the revocation: npm can take minutes to show a new package (at
1.0.0 the packages of the new scope took about 2-3 minutes), and the token
must not stay alive while you wait. Each attempt is a fresh container with
no token, no environment variable, no volume and no standard input;
`--prefer-online` stops npm from serving a cached "not found" again. The
block waits about 5 minutes (30 attempts, 10 s apart). "Not visible yet"
(`E404`, or an empty answer) is **not** an incident: run the block again a
few minutes later. Only a registry value that differs from the checked
tarball is an INCIDENT. Re-running is safe at any time: it only reads. It
must print three `ok` lines before you go on to step 6.

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  NODE_IMAGE='node:24@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496'
  [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  H="$REL"; if command -v cygpath >/dev/null; then H="$(cygpath -m "$REL")"; fi
  verify () { # $1 package name, $2 tarball file name: anonymous registry read, no credential
    want="$(awk -v f="$2" '$1 == f { print $2 }' "$H/out/INTEGRITY.txt")"
    [ -n "$want" ] || { echo "no line for $2 in INTEGRITY.txt (a local problem, not an incident)"; exit 1; }
    echo "$2 expected $want"
    for attempt in $(seq 30); do
      if got="$(docker run --rm "$NODE_IMAGE" npm view "$1@$V" dist.integrity --prefer-online 2>"$H/verify-stderr.txt")"; then
        if [ "$got" = "$want" ]; then echo "$1@$V dist.integrity ok"; return 0; fi
        if [ -n "$got" ]; then
          echo "$1@$V: dist.integrity differs from the checked tarball: INCIDENT (deprecate, revoke, report)"; exit 1
        fi
        echo "$1@$V not visible yet (empty answer), attempt $attempt of 30"
      elif grep -q E404 "$H/verify-stderr.txt"; then
        echo "$1@$V not visible yet (E404), attempt $attempt of 30"
      else
        echo "$1@$V: registry not reachable, attempt $attempt of 30"
      fi
      sleep 10
    done
    echo "$1@$V is not visible on the registry yet (not an incident): run this block again in a few minutes"; exit 1
  }
  verify @mosherw/sync-system-protocol "mosherw-sync-system-protocol-$V.tgz"
  verify @mosherw/sync-system-client "mosherw-sync-system-client-$V.tgz"
  verify @mosherw/sync-system-react "mosherw-sync-system-react-$V.tgz"
)
```

Compare the three `expected` values the block prints with the three lines
in the release notes draft. Only the stdout of `npm view` is compared, so an
npm notice or warning (stderr) never counts as a different value.

### 6. The server image (on the host)

Build from a fresh clone of the tag, check it, then push one multi-platform
build with the same tags to both registries.

Check first (no credential). It deletes an old clone before cloning, so it can
always be run again:

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  [[ "$M" =~ ^[0-9a-f]{40}$ ]] || { echo 'set M (step 1)'; exit 1; }
  [ -n "${IMG:-}" ] && [ "$IMG" = "${REL:-}/image" ] || { echo 'set REL and IMG (Phase B setup)'; exit 1; }
  SRC_URL="${SRC_URL:-https://github.com/MosheRW/sync-system.git}"; REF="${REF:-v$V}"
  D="$IMG"; if command -v cygpath >/dev/null; then D="$(cygpath -m "$IMG")"; fi
  rm -rf "$D/src"
  mkdir -p "$D"
  git clone --quiet --branch "$REF" --depth 1 "$SRC_URL" "$D/src"
  [ "$(git -C "$D/src" rev-parse HEAD)" = "$M" ] || { echo 'the clone is not the release commit'; exit 1; }
  [ -z "$(git -C "$D/src" status --porcelain --ignored)" ] || { echo 'the clone is not clean'; exit 1; }
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

Create two tokens right before the push block, each with the shortest
expiry offered (a custom date of the next day; never "No expiration"):

- GitHub: a **Tokens (classic)** personal access token from
  `https://github.com/settings/tokens/new?scopes=write:packages` (that link
  ticks only `write:packages`, which adds `read:packages`). Before you
  generate it, check the scope list: only `write:packages` and
  `read:packages` may be ticked. GitHub's form can tick `repo` along with
  it: if `repo` is ticked, **untick `repo`**. A `repo` token could push
  code and move tags. A fine-grained token (`github_pat_...`) is not an alternative: GHCR refuses
  it with "The token provided does not match expected scopes". A classic
  token can write every package your account can, so it is revoked right
  after the push. The push block refuses a token that does not start with
  `ghp_`.
- Docker Hub: Account settings, Personal access tokens, "Read & Write" (not
  "Read, Write & Delete").

**Before the push block**, note what your platform's credential helper
lists (it prints registry URLs and user names, no secrets): Docker Desktop
`docker-credential-desktop list`, Windows `docker-credential-wincred list`,
macOS `docker-credential-osxkeychain list`. Look at
`~/.docker/config.json` too.

Then push. The block checks the clone again (a resumed terminal must not
push a stale one). The registry logins use a temporary `DOCKER_CONFIG`
(never under `$REL`), and the `trap` is set before the first login so both
logouts and the removal of the config run on every exit:

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  [[ "$M" =~ ^[0-9a-f]{40}$ ]] || { echo 'set M (step 1)'; exit 1; }
  [[ "$V" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"
  [ -n "${IMG:-}" ] && [ "$IMG" = "${REL:-}/image" ] || { echo 'set REL and IMG (Phase B setup)'; exit 1; }
  D="$IMG"; if command -v cygpath >/dev/null; then D="$(cygpath -m "$IMG")"; fi
  [ "$(git -C "$D/src" rev-parse HEAD)" = "$M" ] || { echo 'the clone is not the release commit: run the check block again'; exit 1; }
  [ -z "$(git -C "$D/src" status --porcelain --ignored)" ] || { echo 'the clone is not clean: run the check block again'; exit 1; }
  CFG="$(mktemp -d)"; if command -v cygpath >/dev/null; then CFG="$(cygpath -m "$CFG")"; fi
  export DOCKER_CONFIG="$CFG"
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true; docker logout docker.io >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
  read -rs -p 'GHCR classic token (write:packages): ' T; echo
  case "$T" in ghp_*) ;; *) echo 'not a classic GitHub token (ghp_...): GHCR needs a classic token with write:packages'; exit 1 ;; esac
  printf '%s' "$T" | docker login ghcr.io -u mosherw --password-stdin
  unset T
  read -rs -p 'Docker Hub token: ' T; echo
  printf '%s' "$T" | docker login docker.io -u moshewin --password-stdin
  unset T
  docker buildx build --platform linux/amd64,linux/arm64 --push \
    -f "$D/src/apps/sync-server/Dockerfile" \
    --label "org.opencontainers.image.version=$V" --label "org.opencontainers.image.revision=$M" \
    -t "ghcr.io/mosherw/sync-system-server:$V" -t "ghcr.io/mosherw/sync-system-server:$MAJOR.$MINOR" \
    -t "ghcr.io/mosherw/sync-system-server:$MAJOR" -t ghcr.io/mosherw/sync-system-server:latest \
    -t "docker.io/moshewin/sync-system-server:$V" -t "docker.io/moshewin/sync-system-server:$MAJOR.$MINOR" \
    -t "docker.io/moshewin/sync-system-server:$MAJOR" -t docker.io/moshewin/sync-system-server:latest \
    "$D/src"
  docker buildx imagetools inspect "ghcr.io/mosherw/sync-system-server:$V"
  docker buildx imagetools inspect "docker.io/moshewin/sync-system-server:$V"
)
```

Record the manifest-list `Digest:` both inspections print (it is the same
image). If the default builder cannot build two platforms, create the
release builder once and repeat the block:
`docker buildx create --use --name sync-release --driver docker-container --driver-opt image=moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c`.
If buildx says `sync-release` already exists, it may be an older builder on
an unpinned BuildKit: run `docker buildx rm sync-release` and create it
again. Then `docker buildx inspect --bootstrap sync-release`, and
`docker inspect -f '{{.Config.Image}}' buildx_buildkit_sync-release0` must
print the pinned reference. The default builder (Docker Desktop's `docker`
driver) uses the BuildKit built into Docker itself, which is updated with
Docker, not by this pin.

After the block, run the same credential helper `list` and look at
`~/.docker/config.json` again:

- `ghcr.io` must not be listed. If it is, run `docker logout ghcr.io`.
- Any other entry that is new since the list before the push block: run
  `docker logout <registry>` for it.
- `index.docker.io` (`https://index.docker.io/v1/`) cannot be checked this
  way. Docker Desktop keeps its own Docker Hub sign-in under that key, and
  the block's `docker login docker.io` can write the release token under
  the same key, replacing it. So that entry cannot be told apart from a
  leftover release login, and comparing it with the list from before the
  push proves no logout. Do not run `docker logout docker.io` just to clear
  it: that signs Docker Desktop out and proves nothing either. **Revoking
  the Docker Hub token (below) is the control, and it is mandatory.**
  - If Docker Desktop shows you signed out of Docker Hub after the block
    (the block's logout removed the shared entry), sign in again from
    Docker Desktop if you want; that is its own sign-in, not the release
    token.
  - If Docker Desktop still shows you signed in and you did not sign in
    again yourself, treat the entry as possibly the release token: revoke
    the token, then sign out and back in from Docker Desktop so its own
    sign-in replaces the entry.

Then **revoke both registry tokens** (GitHub, Settings, Developer settings,
Personal access tokens, Tokens (classic); Docker Hub, Account settings,
Personal access tokens). This is mandatory whatever the lists show: it
makes any copy of a release token useless, wherever it was left.

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
- Every release: remove the release folder (the image clone is inside it),
  and check that the npm Access Tokens page and both registries' token
  lists hold nothing from this release.

  ```sh
  ( set -euo pipefail
    [[ "${REL:-}" == "$HOME"/sync-release-[0-9]* ]] || { echo 'REL is not a release folder (Phase B setup)'; exit 1; }
    rm -rf "$REL"
  )
  ```

## Reader image release

The reading app (`apps/reader`) is released on its own, with its own
version, only as a Docker image
([ADR 0023](docs/decisions/0023-reader-version-tag-and-image.md)):
`ghcr.io/mosherw/sync-system-reader` (canonical) and
`docker.io/moshewin/sync-system-reader` (mirror), tags `X.Y.Z`, `X.Y`, `X`
and `latest`, for `linux/amd64` and `linux/arm64`. Its git tag is
`reader-vX.Y.Z`. It is never published to npm (`private: true`). The
[rule](#the-rule) and [Before you start](#before-you-start) apply as for
the packages: the tag and the image push run on the host, the checks run
in the build container with no credential. Only the maintainer runs it;
agents never tag, push an image or create a release.

**Blocked:** do not release the reader image until #27 and #28 are closed.
The R1 block enforces it (`BLOCKERS`); for a later release, edit that list
to the issues that block it, or leave it empty.

The reader version is bumped by hand in a reviewed PR before this section
is run: `apps/reader/package.json`, `READER_VERSION` in
`apps/reader/src/config/version.ts` and a `## X.Y.Z` entry in
`apps/reader/CHANGELOG.md` (see [`docs/versioning.md`](docs/versioning.md#the-reading-app)).
Set these in your shell first (none of them is a secret). `RV` and `RM` are
the reader's own names, so they never mix with the packages' `V` and `M`:

```sh
export RV=1.0.0                # the reader version on main (apps/reader/package.json)
export REL="$(mktemp -d)"      # outside the repo: R2's bundle and outputs
export IMG="$(mktemp -d)"      # outside the repo: the fresh clone of R3 and R4
```

Optional, before R1: run the [reader dry run](#reader-dry-run-qa) on
`main` at the commit you will tag, so a broken build is found before the
public tag exists.

### R0. First reader release only

- The Docker Hub repository `moshewin/sync-system-reader` exists and is
  public (create it by hand under your Docker Hub **username** `moshewin`).
  Never push the reader to Docker Hub under the GitHub name `mosherw`: that
  is not this project's namespace there.
- On GitHub, the package `sync-system-reader` is created under `mosherw` by
  the first push, private; R6 makes it public.

### R1. Tag on the host

With your normal git credentials; nothing goes into a container. `RM` is
the commit to tag: unless you set it, it is the current `origin/main`. The
block checks that `RM` is on `origin/main` and carries the reader version,
then checks every blocker issue: it must be closed as completed, and the
merge commit of every pull request that closed it must be in `RM`. An issue
closed without a pull request asks you to confirm by hand. An issue closed
as anything but completed (`NOT_PLANNED`, `DUPLICATE`) stops the block,
unless you list it in `ACCEPT_UNFIXED` (for example
`ACCEPT_UNFIXED=28`) after deciding that the release does not need it.

```sh
( set -euo pipefail
  BLOCKERS="27 28"
  [[ "$RV" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set RV=X.Y.Z'; exit 1; }
  git fetch origin
  RM="${RM:-$(git rev-parse origin/main)}"
  [[ "$RM" =~ ^[0-9a-f]{40}$ ]] || { echo 'RM is not a full commit id'; exit 1; }
  git merge-base --is-ancestor "$RM" origin/main || { echo 'RM is not on origin/main'; exit 1; }
  git show "$RM:apps/reader/package.json" | grep -q "\"version\": \"$RV\"" || { echo "the reader is not $RV at RM"; exit 1; }
  git show "$RM:apps/reader/package.json" | grep -q '"private": true' || { echo 'the reader is not private at RM'; exit 1; }
  git show "$RM:apps/reader/src/config/version.ts" | grep -qF "READER_VERSION = '$RV';" || { echo "READER_VERSION is not $RV at RM"; exit 1; }
  git show "$RM:apps/reader/CHANGELOG.md" | grep -qx "## $RV" || { echo "apps/reader/CHANGELOG.md has no ## $RV at RM"; exit 1; }
  for n in $BLOCKERS; do
    S="$(gh issue view "$n" --json state,stateReason --jq '.state + " " + (.stateReason // "")')"
    echo "#$n: $S"
    [ "${S%% *}" = CLOSED ] || { echo "#$n is open: the reader is not released yet"; exit 1; }
    if [ "$S" != 'CLOSED COMPLETED' ]; then
      case " ${ACCEPT_UNFIXED:-} " in
        *" $n "*) echo "#$n accepted without a fix (ACCEPT_UNFIXED)"; continue ;;
        *) echo "#$n was not closed as completed; set ACCEPT_UNFIXED=$n only if the release does not need it"; exit 1 ;;
      esac
    fi
    PRS="$(gh issue view "$n" --json closedByPullRequestsReferences --jq '.closedByPullRequestsReferences[].url')"
    if [ -z "$PRS" ]; then
      echo "#$n was closed without a pull request: check by hand that its fix is in $RM"
      read -r -p "Type yes if the fix for #$n is in $RM: " OK
      [ "$OK" = yes ] || { echo 'not confirmed'; exit 1; }
    fi
    for p in $PRS; do
      MC="$(gh pr view "$p" --json mergeCommit --jq '.mergeCommit.oid // ""')"
      [[ "$MC" =~ ^[0-9a-f]{40}$ ]] || { echo "$p (closes #$n) is not merged"; exit 1; }
      git merge-base --is-ancestor "$MC" "$RM" || { echo "$p (closes #$n) is not in $RM"; exit 1; }
      echo "#$n: $p merged as $MC, which is in RM"
    done
  done
  if git rev-parse -q --verify "refs/tags/reader-v$RV" >/dev/null; then echo "reader-v$RV exists locally"; exit 1; fi
  if git ls-remote --exit-code --tags origin "refs/tags/reader-v$RV" >/dev/null; then echo "reader-v$RV exists on origin"; exit 1; fi
  git tag -a "reader-v$RV" "$RM" -m "reader-v$RV"
  git push origin "refs/tags/reader-v$RV"
  echo "export RM=$RM"
)
```

Run the printed `export RM=...` line: R2 to R4 check every build against
this commit. The block pushes only that one tag.

### R2. Checks in the build container (no credential)

Run the **[step 2](#2-build-container-no-credential)** block unchanged
(full install, audit, lint, typecheck, tests with Redis, build and smoke of
the tagged commit), pointed at the reader tag:

```sh
export REF="reader-v$RV" M="$RM" MODE=dry-run
```

It must finish green. With `MODE=dry-run` it packs the npm packages only to
check them (no token, nothing published); ignore the integrity lines it
prints. Then run `unset REF M MODE`.

### R3. Check the image (no credential)

Builds `linux/amd64` from a fresh clone of the tag and checks the running
container: the commit, a clean tree, `/health` with the tag's version, a
non-root user, no source maps, and the labels. Then it builds `linux/arm64`
(build only). Only when every check passed does it write `RM` to
`$IMG/checked`, which R4 requires. The container gets no environment
variable, no mount and no credential.

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  [[ "$RV" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set RV=X.Y.Z'; exit 1; }
  [[ "$RM" =~ ^[0-9a-f]{40}$ ]] || { echo 'set RM (R1)'; exit 1; }
  SRC_URL="${SRC_URL:-https://github.com/MosheRW/sync-system.git}"; REF="${REF:-reader-v$RV}"
  D="$IMG"; if command -v cygpath >/dev/null; then D="$(cygpath -m "$IMG")"; fi
  rm -rf "$D/src" "$D/checked"
  git clone --quiet --branch "$REF" --depth 1 "$SRC_URL" "$D/src"
  [ "$(git -C "$D/src" rev-parse HEAD)" = "$RM" ] || { echo 'the clone is not the reader commit'; exit 1; }
  [ -z "$(git -C "$D/src" status --porcelain)" ] || { echo 'the clone is not clean'; exit 1; }
  docker buildx build --platform linux/amd64 --load -f "$D/src/apps/reader/Dockerfile" \
    --label "org.opencontainers.image.version=$RV" --label "org.opencontainers.image.revision=$RM" \
    -t "sync-reader-check:$RV" "$D/src"
  trap 'docker rm -f sync-reader-health >/dev/null 2>&1 || true' EXIT
  docker run -d --name sync-reader-health "sync-reader-check:$RV" >/dev/null
  H=''
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if H="$(docker exec sync-reader-health node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null)"; then break; fi
    sleep 1
  done
  echo "$H"
  echo "$H" | grep -qx "{\"status\":\"ok\",\"version\":\"$RV\"}" || { echo '/health version is not the tag'; exit 1; }
  [ "$(docker exec sync-reader-health id -u)" != 0 ] || { echo 'the image runs as root'; exit 1; }
  [ -z "$(docker exec sync-reader-health find /app/dist /app/dist-server -name '*.map')" ] || { echo 'the image has source maps'; exit 1; }
  docker inspect -f '{{json .Config.Labels}}' "sync-reader-check:$RV"
  [ "$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "sync-reader-check:$RV")" = "$RM" ] || { echo 'wrong revision label'; exit 1; }
  docker buildx build --platform linux/arm64 -f "$D/src/apps/reader/Dockerfile" "$D/src"
  echo "$RM" > "$D/checked"
  echo "R3 passed for $RM"
)
```

The arm64 build runs under emulation and takes several minutes. If the
default builder cannot build `linux/arm64`, create the pinned release
builder once (see [step 6](#6-the-server-image-on-the-host)) and repeat the
block:
`docker buildx create --use --name sync-release --driver docker-container --driver-opt image=moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c`.
Optional: if a scanner is installed, run
`docker scout cves --only-severity critical,high "sync-reader-check:$RV"`
and keep the result with the release notes draft.

### R4. Push the image (on the host)

Create two tokens, each with the shortest expiry offered:

- A GitHub **classic** personal access token from
  `https://github.com/settings/tokens/new?scopes=write:packages` (that link
  ticks only `write:packages`). Before you generate it, check the scope
  list: only `write:packages` (and the `read:packages` it implies) may be
  ticked. GitHub's form can tick `repo` along with it; if `repo` is ticked,
  untick it. A `repo` token could push code and move tags.
- A Docker Hub personal access token with "Read & Write" (not "Read, Write
  & Delete"). Docker Hub tokens are account-wide: this one can also push
  the server image until you revoke it.

Then push. The block refuses to run unless R3 passed for `RM` on this clone
(`$IMG/checked`), and checks the clone's commit and clean tree again before
the first login. The logins use a temporary `DOCKER_CONFIG`, and the `trap`
is set before the first login so both logouts and the removal of the
config run on every exit:

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  [[ "$RM" =~ ^[0-9a-f]{40}$ ]] || { echo 'set RM (R1)'; exit 1; }
  [[ "$RV" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+$ ]] || { echo 'set RV=X.Y.Z'; exit 1; }
  MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"
  D="$IMG"; if command -v cygpath >/dev/null; then D="$(cygpath -m "$IMG")"; fi
  [ -f "$D/checked" ] && [ "$(tail -n 1 "$D/checked")" = "$RM" ] || { echo 'R3 has not passed for RM: run R3 first'; exit 1; }
  [ "$(git -C "$D/src" rev-parse HEAD)" = "$RM" ] || { echo 'the clone is not the reader commit'; exit 1; }
  [ -z "$(git -C "$D/src" status --porcelain)" ] || { echo 'the clone is not clean'; exit 1; }
  CFG="$(mktemp -d)"; if command -v cygpath >/dev/null; then CFG="$(cygpath -m "$CFG")"; fi
  export DOCKER_CONFIG="$CFG"
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true; docker logout docker.io >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
  read -rs -p 'GHCR token (write:packages only): ' T; echo
  printf '%s' "$T" | docker login ghcr.io -u mosherw --password-stdin
  unset T
  read -rs -p 'Docker Hub token: ' T; echo
  printf '%s' "$T" | docker login docker.io -u moshewin --password-stdin
  unset T
  docker buildx build --platform linux/amd64,linux/arm64 --push \
    -f "$D/src/apps/reader/Dockerfile" \
    --label "org.opencontainers.image.version=$RV" --label "org.opencontainers.image.revision=$RM" \
    -t "ghcr.io/mosherw/sync-system-reader:$RV" -t "ghcr.io/mosherw/sync-system-reader:$MAJOR.$MINOR" \
    -t "ghcr.io/mosherw/sync-system-reader:$MAJOR" -t ghcr.io/mosherw/sync-system-reader:latest \
    -t "docker.io/moshewin/sync-system-reader:$RV" -t "docker.io/moshewin/sync-system-reader:$MAJOR.$MINOR" \
    -t "docker.io/moshewin/sync-system-reader:$MAJOR" -t docker.io/moshewin/sync-system-reader:latest \
    "$D/src"
  docker buildx imagetools inspect "ghcr.io/mosherw/sync-system-reader:$RV"
  docker buildx imagetools inspect "docker.io/moshewin/sync-system-reader:$RV"
)
```

Record the manifest-list `Digest:` both inspections print (it is the same
image). Then check that no registry login is left on the host and **revoke
both registry tokens**, exactly as after
[step 6](#6-the-server-image-on-the-host)'s push.

### R5. GitHub release

Write `notes.md`: the `## RV` section of `apps/reader/CHANGELOG.md`, then
the image's manifest-list digest from R4:

```md
Image `ghcr.io/mosherw/sync-system-reader:X.Y.Z` (and docker.io): `sha256:...`
```

```sh
gh release create "reader-v$RV" --verify-tag --latest=false --title "Reader $RV" --notes-file notes.md
```

`--verify-tag` refuses when `reader-v$RV` is not on origin (instead of
creating it on the default branch), and `--latest=false` keeps the
packages' release as "Latest".

### R6. After the reader release

- [ ] First release only: set the GHCR package `sync-system-reader` public
      (GitHub, Packages, Package settings).
- [ ] Pull by tag works anonymously from both registries, and the digests
      equal R4's:

```sh
( set -euo pipefail
  export MSYS_NO_PATHCONV=1
  CFG="$(mktemp -d)"; if command -v cygpath >/dev/null; then CFG="$(cygpath -m "$CFG")"; fi
  export DOCKER_CONFIG="$CFG"
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  for ref in "ghcr.io/mosherw/sync-system-reader:$RV" "docker.io/moshewin/sync-system-reader:$RV"; do
    docker pull --quiet "$ref" >/dev/null
    echo "$ref $(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}')"
  done
)
```

- [ ] Both registry tokens revoked; no `ghcr.io` or `index.docker.io` login
      left in the credential helper or `~/.docker/config.json`.
- [ ] `rm -rf "$IMG" "$REL"`.

### Reader dry run (QA)

R3 without a tag, a token, a login or a push. From the repo, on the PR's
branch, with the reader version that branch sets:

```sh
export RV=1.0.0 IMG="$(mktemp -d)"
export REF="$(git rev-parse --abbrev-ref HEAD)" RM="$(git rev-parse HEAD)"
export SRC_URL="file://$(if command -v cygpath >/dev/null; then cygpath -m "$(pwd)"; else pwd; fi)"
```

Then run the **R3** block (the branch must be committed: the block clones
it). It builds `linux/amd64`, checks `/health`, the user and the labels,
and builds `linux/arm64`. Never run R1, R4 or R5 in a dry run. Afterwards:
`unset REF RM SRC_URL` and `rm -rf "$IMG"`.

## Dry run (QA)

The same steps without a tag, a token, a login, a push or a publish (AC54).
From the repo, on the release PR's branch:

```sh
export V=1.0.0 REL="$(mktemp -d)"    # never the release folder of the same V
export IMG="$REL/image"
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
   `export SRC_URL="file://$(if command -v cygpath >/dev/null; then cygpath -m "$(pwd)"; else pwd; fi)"`
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
  Before packing anything, `pack:check`, `release:dry-run` and `smoke`
  check that `pnpm --version` equals the version the root `package.json`
  `packageManager` pins (the one ADR 0021 verified the flag with), and stop
  without packing otherwise, for example when a global pnpm of another
  version is on `PATH` (#69).
