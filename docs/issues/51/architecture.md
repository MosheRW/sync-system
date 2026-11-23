# Architecture: #51 fix(docs): operator guide passes TOKEN_SECRET with docker run -e

Path: fast. Branch: `fix/51-operator-guide-token-secret`. Spec: [spec.md](spec.md).

## Repo layout

- Layout: `monorepo` (pnpm workspace, no submodules; `git submodule status` is empty).
- Touched: root docs only (`docs/operator-guide.md`, `docs/roadmap.md`) and one
  test file in `apps/sync-server/test/` (the repo-hygiene doc guards live there).
- Checks: root `pnpm lint` (ESLint + Prettier + `scripts/release/check-links.ts`),
  `pnpm typecheck`, `pnpm test` (all workspaces + `scripts/release/*.test.ts`).

## Decisions: none open

No ADR. The spec fixes the scope (docs only, no change to how the server reads
config). One related idea is a question, not part of this plan: native
`TOKEN_SECRET_FILE` support (see Questions).

## Facts the guidance must match (verified in the code)

1. The server reads `TOKEN_SECRET`, `TOKEN_SECRET_PREVIOUS` and `REDIS_URL` from
   the **process environment only** (`apps/sync-server/src/config/token-secret.ts`,
   `known-vars.ts`). There is **no `_FILE` variant**.
2. `TOKEN_SECRET_FILE` (or any other unknown `TOKEN_*`/`REDIS_*` name) is a
   **Config error and stops startup** (ADR 0015, `SERVER_FAMILY_PREFIXES`). The
   guide must say so, so nobody tries it.
3. The secret is used exactly as given; leading/trailing whitespace is a
   `Config error` (never trimmed). `$(cat file)` strips trailing newlines, so a
   file written by `openssl rand -base64 32 > file` works; a CRLF file fails
   loudly (`\r` is whitespace), which is acceptable.
4. Image: `node:24-alpine` (has `/bin/sh`), `WORKDIR /app`, `USER node`
   (uid 1000), `CMD ["node", "dist/index.js"]`, base `ENTRYPOINT`
   `docker-entrypoint.sh` (runs `sh -c ...` commands unchanged).
5. `.gitignore` and `.dockerignore` already ignore `.env*`; a file named
   `sync-server.env` is **not** ignored, so the examples keep the env file
   outside the clone.

## What each option protects against (do not overclaim)

| Way to pass the secret                                       | Shell history | Host process list (`ps`, docker CLI argv) | `docker inspect` / `docker compose config` | Inside the container (`docker exec`, `/proc/1/environ`) |
| ------------------------------------------------------------ | ------------- | ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `-e TOKEN_SECRET=value`                                      | exposed       | exposed                                   | exposed                                    | exposed                                                 |
| `-e TOKEN_SECRET="$(cat file)"` (current line 164)           | hidden        | exposed (expanded into argv)              | exposed                                    | exposed                                                 |
| `--env-file file` / compose `env_file:` / `${VAR}` from `.env` | hidden        | hidden                                    | **exposed** (`Config.Env`)                 | exposed                                                 |
| Secret file (compose `secrets:` or Swarm secret) + `sh` wrapper | hidden        | hidden                                    | hidden (only the mount path shows)         | exposed (file and process env)                          |

And for all options: anyone in the `docker` group or root on the host can read
the secret (they control the daemon). No option protects against them; restrict
Docker access. The guide states exactly this, nothing stronger.

## Approach

Docs-only fix in `docs/operator-guide.md`:

### A. Replace the `docker run` example (lines ~157-165, "Run with the development compose files" section)

New outline (engineer finalises wording, keeps Prettier formatting):

```sh
docker build -f apps/sync-server/Dockerfile -t sync-server .
# Once: an env file outside the clone, mode 600, owned by you, never committed.
umask 077
printf 'TOKEN_SECRET=%s\n' "$(openssl rand -base64 32)" > "$HOME/sync-server.env"
docker run -p 127.0.0.1:8080:8080 \
  -v "$PWD/config/apps.json:/config/apps.json:ro" \
  -e SYNC_CONFIG_PATH=/config/apps.json \
  --env-file "$HOME/sync-server.env" sync-server
```

(`umask 077` in a subshell or followed by a note is fine; the result must be a
mode-600 file. Alternatively `install -m 600 /dev/null FILE` first. Pick one,
verify it.) One sentence after it: "Never pass the secret with
`-e TOKEN_SECRET=...`: see [Passing secrets to the container](#passing-secrets-to-the-container)."
Non-secret settings (`SYNC_CONFIG_PATH`) stay as `-e`.

### B. New subsection `### Passing secrets to the container` under `## Token secret`

Place it after the rules list (before "Routine rotation"). Content:

1. Applies to `TOKEN_SECRET`, `TOKEN_SECRET_PREVIOUS`, and `REDIS_URL` when it
   holds a password.
2. **Don't** use `-e NAME=value` or `-e NAME="$(cat file)"`: the first lands in
   shell history; both put the value in the docker command line (visible in the
   host's process list while it runs) and in `docker inspect`.
3. **Env file** (`docker run --env-file FILE`, compose `env_file:`, or compose
   `${VAR}` interpolation from `.env`): one `NAME=value` per line, no quotes, LF
   line endings; mode 600, owned by the operator, outside the repo, never
   committed. Keeps the value out of shell history and the process list. It is
   **still visible** in `docker inspect` (`Config.Env`), in
   `docker compose config`, and inside the container.
4. **Secret file** (compose `secrets:` or a Swarm secret, mounted at
   `/run/secrets/<name>`): the server reads env vars only and has no
   `TOKEN_SECRET_FILE` (setting it stops startup, see
   [Environment variables](#environment-variables)), so a small wrapper reads the
   file and starts the server. Example (compose):

   ```yaml
   services:
     sync-server:
       image: ghcr.io/mosherw/sync-system-server:1.0.0
       command:
         - sh
         - -c
         - 'TOKEN_SECRET="$$(cat /run/secrets/sync_token_secret)" && export TOKEN_SECRET && exec node dist/index.js'
       secrets:
         - sync_token_secret
   secrets:
     sync_token_secret:
       file: ./sync_token_secret # or `external: true` for a Swarm secret
   ```

   (`$$` escapes compose interpolation. The engineer verifies the exact snippet,
   including that a missing file stops startup instead of starting with an
   empty secret: `var="$(cat missing)" && ...` short-circuits on cat's failure.)
   Notes: keeps the value out of `docker inspect` and the container config;
   still readable inside the container (the file and the server's process
   environment) by anyone who can `docker exec`. The wrapper replaces the
   image's `CMD`, so re-check it when upgrading (the upgrade notes say if the
   `CMD` changes). With a plain compose file secret the host file is
   bind-mounted with its own owner and mode, so it must be readable by uid 1000
   (the image's `node` user); Swarm secrets are mounted root-owned, mode 0444,
   on a tmpfs. Only state the compose `uid`/`gid`/`mode` options if verified on
   the local Docker Compose version; otherwise leave them out.
5. Closing line: anyone with access to the Docker daemon (the `docker` group or
   root) can read the secret whichever way it is passed; restrict that access.

### C. Small touch-ups, same file

- Install step 2 (line ~34): link to the new subsection instead of only `#token-secret`.
- After the minimal `compose.yaml` (line ~50): one sentence that
  `${TOKEN_SECRET}` comes from the shell or a `.env` file next to `compose.yaml`
  (mode 600, never committed) and, like any env value, shows in
  `docker inspect`; link to the subsection for the secret-file option. Keep the
  example itself unchanged (its `:?` fail-fast is useful).
- Leave "Run from source" (`TOKEN_SECRET="$(openssl rand ...)" pnpm ...`) as is:
  development, no docker, value never typed.

### D. Other docs: grep result

- `README.md`, `SECURITY.md`, `docs/startup-errors.md`, other `docs/*.md`: no
  secret passed with `-e`. No change.
- `RELEASING.md` lines 131-132: `-e SYNC_TEST_REDIS_URL=...ci-only-redis-password...`
  is a public, throwaway CI password for a disposable container. Not a secret;
  out of scope. `release-files.test.ts` already bans `--env-file`/`-e NPM_TOKEN`
  in `RELEASING.md`; this plan does not touch `RELEASING.md`.
- `compose.yaml` / `compose.redis.yaml`: public dev-only values, refused in
  production by the server. No change.

### E. Regression guard (one test)

Add to `apps/sync-server/test/repo-hygiene.test.ts` a `describe('operator guide
passes secrets safely (#51)')` test:
- the guide contains no `-e TOKEN_SECRET`, `-e TOKEN_SECRET_PREVIOUS`,
  `-e REDIS_URL` (regex `/-e\s+(TOKEN_SECRET|REDIS_URL)/`);
- the `## Token secret` section (sliced up to `## Timers`) contains
  `--env-file`, `docker inspect`, `600`, `TOKEN_SECRET_FILE` and
  `/run/secrets/`.

Alternative rejected: implementing `TOKEN_SECRET_FILE` in the server (out of
scope per spec; it would also change ADR 0015's known-variable list). Rejected:
dropping the compose `${TOKEN_SECRET}` example (works, fails fast; documenting
its exposure is enough).

### F. Roadmap title fix (separate chunk)

`docs/roadmap.md` line 46: replace the #56 title with the real GitHub title
`` `test(server): harden repo-hygiene ci.yml trigger and permissions checks (follow-up to #54)` ``,
keep the rest of the line. Prettier check must stay clean.

## Files to create / modify

- `docs/operator-guide.md`: replace the `docker run -e TOKEN_SECRET=...` example;
  add `### Passing secrets to the container`; two linking sentences (A, B, C).
- `apps/sync-server/test/repo-hygiene.test.ts`: one regression test (E).
- `docs/roadmap.md`: fix the #56 title (F).
- `docs/issues/51/STATE.md`: phase and deviations, as usual.

## Data model / contracts

None. No API, message, schema or config change.

## Docker impact: none

No image, Dockerfile or compose file change.

## Docs impact

`docs/operator-guide.md` (the fix itself) and `docs/roadmap.md` (title fix).
No changeset: no package changes.

## Risks / edge cases

- **Overclaiming**: the env file does not hide the value from `docker inspect`;
  the table above is the source of truth for wording.
- **Wrapper snippet correctness**: `$$` in compose, busybox `sh` export
  semantics, fail-closed on a missing file, trailing newline. Must be verified
  in Docker, not written from memory.
- **File permissions**: mode 600 owned by the operator suits `--env-file` (the
  docker CLI reads it on the host) but not a bind-mounted compose secret file
  (the container's uid 1000 reads it). The guide must say which applies where.
- **Existing doc tests** slice the guide by `## ` headings (`## Upgrading` ..
  `## Token secret`, `## Environment variables` .. `## Storage (Redis)`, etc.).
  Add only a `###` subsection inside `## Token secret`; add no new `## ` heading
  and no new table row starting with `` | `NAME` `` inside the env section
  (the env-table tests parse those).
- **Link check**: the new anchor `#passing-secrets-to-the-container` must match
  the heading slug (checked by `pnpm lint`).

## Security-sensitive areas

Security-sensitive: yes

- Secrets/config guidance: how operators pass `TOKEN_SECRET`,
  `TOKEN_SECRET_PREVIOUS` and a password-bearing `REDIS_URL` to the container
  (`docs/operator-guide.md`, "Run with the development compose files",
  "Install with Docker Compose" and "Token secret"). Wrong or overclaiming
  guidance leads operators to leak the token signing secret. No code path changes.

## Implementer model

Implementer model: opus
Reason: secret-handling guidance (`Security-sensitive: yes`), and the wrapper
snippet and the exposure claims must be verified precisely in Docker.

## Test plan

Local Docker CI (Actions is billing-blocked; ADR 0018): fresh clone of the pushed
branch **including `.git`** into a `node:24` container on a private Docker
network with `redis:7.2.17-alpine` (pinned digest from `RELEASING.md`), **no
bind mounts** (copy in via `git bundle` / `docker cp`), `CI=true`,
`SYNC_TEST_REDIS_URL=redis://:<pw>@<redis-host>:6379`, then
`corepack enable && pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`.

| AC | Check |
| --- | --- |
| 1. No `-e TOKEN_SECRET=VALUE` | New repo-hygiene test (E); `grep -n -- '-e TOKEN_SECRET' docs/operator-guide.md` is empty. |
| 2. Recommends `--env-file` (mode 600) and a compose/Swarm secret | Test (E) strings; manual read of the subsection. |
| 3. Notes `docker inspect` exposes `-e` values (and env-file values) | Test (E) string `docker inspect`; manual read against the table above. |
| 4. Existing docs tests pass | `pnpm lint` (Prettier + link check) and `pnpm test` green, incl. `repo-hygiene`, `env-reference`, `release-files`. |

Manual Docker verification of the new snippets (record results in the PR):
1. Build the image; run the `--env-file` example with a mode-600 file; `/health` ok;
   `docker inspect -f '{{json .Config.Env}}'` shows `TOKEN_SECRET` (confirms the
   wording that env files are visible there).
2. Compose secret + wrapper: server starts, `/health` ok;
   `docker inspect` `Config.Env` has no `TOKEN_SECRET`; with the secret file
   missing the container exits non-zero and never serves; check what file mode
   the `node` user needs.
3. Swarm: optional (needs `docker swarm init`); if skipped, say so in the PR and
   keep the Swarm part to one sentence (`external: true` + `docker secret create`).

## Implementation chunks

1. `docs: pass the token secret with an env file or a secret file` — operator-guide changes A-C.
2. `test(server): guard the operator guide against secrets passed with -e` — test E.
3. `docs(roadmap): fix the #56 title` — F.

(The docs change is chunk 1 because it is the fix itself; there is no separate
trailing docs chunk.) Every commit carries only the `Refs: #51` trailer.

## Questions

- Follow-up (not in this issue): should the server support a
  `TOKEN_SECRET_FILE` / `REDIS_URL_FILE` convention so a secret file works
  without overriding the image's `CMD`? That needs its own issue and an ADR 0015
  amendment.
