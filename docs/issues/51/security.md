# Security review (plan): #51 operator guide passes TOKEN_SECRET with docker run -e

Mode: plan, round 1. Branch `fix/51-operator-guide-token-secret`, draft PR #57.
Inputs: [spec.md](spec.md), [architecture.md](architecture.md),
`apps/sync-server/src/config/token-secret.ts`, `known-vars.ts`,
`apps/sync-server/Dockerfile`, `docs/operator-guide.md`, `.gitignore`.

**Verdict: PASS.** No critical or high findings. The required controls
below are part of the plan, and code mode checks them.

## Assets and trust boundaries

- **`TOKEN_SECRET` / `TOKEN_SECRET_PREVIOUS`**: whoever holds them can forge
  any app's tokens (leader takeover in every group). They are the most
  sensitive values an operator handles.
- **`REDIS_URL` with a password**: read/write access to all live group state.
- Boundaries: operator shell (history), host process list (all local users),
  Docker daemon state (`docker inspect`, `config.v2.json`; docker group and
  root), compose project directory (often a git repo), container
  (`docker exec`, `/proc/1/environ`).

## Threats (brief)

| Who | Can do | Through |
| --- | --- | --- |
| Any local user on the host | read the secret | `ps` while `docker run -e NAME=value` (or `"$(cat f)"`) runs in the foreground |
| Anyone with shell history access / backups | read the secret | `-e NAME=value` or `export NAME=value` typed literally |
| Docker group, monitoring agents with daemon access | read the secret | `docker inspect` `Config.Env`, `docker compose config` |
| Anyone with repo access | read the secret | secret or env file created inside a git working tree and committed |
| Other host users | read the secret | a secret file made world-readable so uid 1000 in the container can read it |
| Root / docker group | always read it | daemon control; no option protects, documented as residual |

## Verification of the plan's facts

All checked against the code; accurate and not overclaimed:

- Server reads the three values from the process env only; no `_FILE`
  variant; `TOKEN_SECRET_FILE` matches the `TOKEN_` family prefix and is a
  `Config error` (`known-vars.ts` `unknownServerVariables`). Correct.
- Whitespace is never trimmed (`checkSecret`), so `$(cat f)` (strips trailing
  LFs) works and CRLF fails loudly without echoing the value. Correct.
- An **empty** file gives `TOKEN_SECRET=""` (set, not unset), which fails the
  32-byte check under `NODE_ENV=production` (set in the image). A missing file
  makes `cat` fail, and an assignment-only command takes the exit status of
  its command substitution, so `&&` short-circuits. The wrapper fails closed
  in both cases. Must still be shown in Docker (control C3).
- Dockerfile: `USER node` (uid 1000), `CMD ["node", "dist/index.js"]`, base
  `docker-entrypoint.sh` passes `sh ...` through. The wrapper with `exec` keeps
  node as PID 1, so signal handling is unchanged. Correct.
- Exposure table: correct per row. `-e NAME="$(cat f)"`: hidden from history,
  in the CLI argv (visible to **every** local user via `ps` for the whole run
  when not detached), in `docker inspect`. `--env-file` / compose `env_file:` /
  `${VAR}`: out of history and argv, still in `Config.Env` and
  `docker compose config`. Secret file + wrapper: only the mount path in
  inspect; value in the file and in node's environ inside the container.
  Docker group / root residual: correct and stated without overclaiming.
- Swarm secrets: root-owned, mode 0444 on tmpfs by default, readable by uid
  1000. Correct. Plain compose file secrets are bind mounts that keep host
  owner and mode. Correct. The plan rightly leaves `uid`/`gid`/`mode` out unless
  verified.
- `.gitignore` ignores `.env*` but not `sync-server.env` or `sync_token_secret`.
  Correct; this drives findings M1 and M2.

## Findings

No critical or high findings.

| # | Severity | Location | Issue (attack scenario) | Fix |
| --- | --- | --- | --- | --- |
| M1 | Medium | architecture.md B.4 (compose `secrets:` `file: ./sync_token_secret`) | The example puts the secret file next to `compose.yaml`. Operators often keep their compose dir in git (infra repo, or this clone for the dev path). `sync_token_secret` is not ignored, so a `git add .` commits the signing secret: anyone with repo access forges tokens. | Use an absolute path outside any repo in the example (e.g. `/etc/sync-server/token_secret`), and add one line: keep it out of any git working tree, or add it to `.gitignore` if it must sit there. |
| M2 | Medium | architecture.md B.4 / Risks "File permissions" | A plain compose secret must be readable by uid 1000 in the container. If the operator's uid is not 1000, the server fails closed and the obvious "fix" is `chmod 644`/`o+r`, which makes the secret readable by every host user. The plan says only "must be readable by uid 1000", not how. | The guide gives the exact commands: `sudo install -m 400 -o 1000 -g 1000 /dev/null FILE` (or `chown 1000:1000` + `chmod 400`), then write into it; says **never** make it world-readable; and notes that a host account with uid 1000 can then read it too. Verify in Docker (C3). |
| M3 | Medium | architecture.md B.1 / B.4 (wrapper covers `TOKEN_SECRET` only) | B.1 says the advice covers `TOKEN_SECRET_PREVIOUS` and a password-bearing `REDIS_URL`, but the only wrapper reads one secret. During rotation (needs both secrets) an operator on the secret-file method has no pattern and falls back to `environment:`/`-e`, exposing both the old and new secret in `docker inspect`. | Show (or describe in one sentence with the exact chain) how to read a second secret in the same `&&` chain: `TOKEN_SECRET_PREVIOUS="$$(cat /run/secrets/sync_token_secret_previous)" && export TOKEN_SECRET_PREVIOUS &&`, removed with the secret after the window; same for `REDIS_URL`. Link from "Routine rotation" and say that after a leak the old secret file is deleted, never mounted as previous. |
| M4 | Medium | architecture.md E (regression test) | The regex `/-e\s+(TOKEN_SECRET\|REDIS_URL)/` would match the plan's own warning sentence in A ("Never pass the secret with `-e TOKEN_SECRET=...`"), so the engineer must change the prose or weaken the test. It also misses `--env TOKEN_SECRET`, `--env=...`, `-e "TOKEN_SECRET=..."`, `-e'...'`, `-eTOKEN_SECRET`, and literal values in compose `environment:` blocks. A guard with holes lets the anti-pattern come back unnoticed. | Scan only fenced code blocks in `docs/operator-guide.md` (` ```sh ` / ` ```yaml `), with a pattern like `/(?:^\|\s)(?:-e\|--env)(?:\s+\|=)?["']?(TOKEN_SECRET(_PREVIOUS)?\|REDIS_URL)\b/m`. Also assert that no YAML block sets `TOKEN_SECRET`/`TOKEN_SECRET_PREVIOUS`/`REDIS_URL` to a literal (a value not starting with `${`). Prose may name the anti-pattern. Add a negative self-check (the regex matches `-e TOKEN_SECRET=x`, `--env "REDIS_URL=x"`) so the guard can't silently match nothing. |
| L1 | Low | architecture.md A (`umask 077` then `printf > file`) | A bare `umask 077` stays in the operator's interactive shell. A `>` redirect onto an **existing** file keeps that file's old mode (umask applies only on creation), so a re-run can leave a 644 env file. | Use a subshell and an explicit mode: `(umask 077 && printf 'TOKEN_SECRET=%s\n' "$(openssl rand -base64 32)" > "$HOME/sync-server.env") && chmod 600 "$HOME/sync-server.env"`, or `install -m 600 /dev/null FILE` first. Verify with `ls -l`. |
| L2 | Low | architecture.md B.3 (env file format "no quotes") | "No quotes" is right for `docker run --env-file` (quotes become part of the value), but compose `.env`/`env_file:` strip quotes and **interpolate `$`** in unquoted values. A `REDIS_URL` password containing `$` is silently changed (misconfiguration, not a leak). | Split the format note: `--env-file` takes the value literally, no quotes; compose `.env` must single-quote values that contain `$`. Recommend generated secrets (base64/hex) that contain no `$`. |
| L3 | Low | architecture.md C (install `compose.yaml` `${TOKEN_SECRET}`) | Operators often satisfy `${TOKEN_SECRET:?}` with `export TOKEN_SECRET=<value>` typed in the shell, which puts it in history. | The planned sentence also says not to type the value: use the `.env` file (mode 600) or `export TOKEN_SECRET="$(cat FILE)"`. |

## Required controls (engineer)

- **C1** Every new command example keeps the secret value out of argv and shell
  history: no literal value and no `"$(cat …)"` expanded on a `docker`
  command line. Non-secret settings may stay as `-e`.
- **C2** The exposure wording matches the architecture.md table exactly. In
  particular, env files are **still visible** in `docker inspect` and
  `docker compose config`, and the docker group / root residual is stated.
- **C3** Verify the compose secret wrapper in Docker and record the results in
  the PR: (a) starts and `/health` is ok; (b) `Config.Env` has no
  `TOKEN_SECRET`; (c) missing file: exits non-zero, never serves; (d) empty
  file: `Config error`, exits non-zero; (e) the value appears in neither
  `docker logs` nor `docker inspect` (`Args`/`Cmd` show only the script);
  (f) the file mode/owner that works for uid 1000 (M2).
- **C4** The wrapper keeps `exec node dist/index.js` (node stays PID 1), uses `$$`
  for every `$` in compose, and has no `set -x`, `echo` or `printenv`.
- **C5** Secret and env file locations in examples are outside the clone and
  outside any git working tree, or the guide says to gitignore them (M1).
  Mode 600 for `--env-file` (read by the host CLI). For bind-mounted compose
  secrets, owner 1000 with mode 400/600, never world-readable (M2). Created
  with an explicit mode (L1).
- **C6** Rotation and `REDIS_URL`: the secret-file pattern shows how to pass
  `TOKEN_SECRET_PREVIOUS` and a password-bearing `REDIS_URL` (M3). The guide
  says `TOKEN_SECRET_FILE`/`REDIS_URL_FILE` are config errors.
- **C7** The regression test follows M4: it scans code blocks, covers the
  `-e`/`--env` variants and literal compose values, and has a positive
  self-check.
- **C8** No real-looking secret value appears anywhere in the docs. Only
  commands that generate one, or the existing refused placeholders.

## What code mode will check

- `gh pr diff 57`: C1-C8 above, line by line, in `docs/operator-guide.md` and
  `apps/sync-server/test/repo-hygiene.test.ts`.
- The PR's recorded Docker verification for C3 (a-f).
- Every anchor and link to `#passing-secrets-to-the-container` resolves
  (`pnpm lint` link check).
- gitleaks over `origin/main..HEAD`; no new secret-like strings; `npm audit`
  high/critical (no dependency change expected).
- `RELEASING.md` and compose files are unchanged (out of scope per the plan).
