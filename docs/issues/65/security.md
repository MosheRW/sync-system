# Security review (plan): #65

Mode: plan. Reviewed: [`architecture.md`](architecture.md),
[ADR 0022](../../decisions/0022-secret-scan-suppressions.md) (Proposed),
[`spec.md`](spec.md), `RELEASING.md` steps 0, 3, 4 and 6, the 16 flagged
lines, `apps/sync-server/src/tokens/jwt.ts`.

Result: **PASS**. No critical or high finding. 1 medium, 4 low (advisory).

## Assets and trust boundaries

- **The release secret-scan gate** (step 0, and the security reviewer's
  per-PR scan): `.gitleaksignore` decides what it stops reporting.
- **Release credentials**: the npm granular token (step 3/4, publish
  container) and the GHCR and Docker Hub tokens (step 6, host).
- **Registry identity**: which Docker Hub namespace operators are told to
  pull from (`docker.io/moshewin/sync-system-server`).
- **A third-party image** (gitleaks) run on the maintainer's host over a
  read-only mount of the repo.

## Threats (STRIDE, brief)

| Threat | Who / how | Plan's answer |
|---|---|---|
| Information disclosure | A real secret hidden in `.gitleaksignore` and published when the repo goes public | Per-finding fingerprints (commit + file + line), scope test, manual check of every value (below) |
| Information disclosure | A later real secret placed in a `test/` file passes because the path is allowlisted | Option 1 rejects path allowlists; fingerprints fail closed on anything new |
| Tampering | A future PR adds its own fingerprint to silence its own leak | ADR 0022: separate commit, security reviewer checks the value; see M1 |
| Spoofing | Operators pull a lookalike image from a namespace the maintainer doesn't own | User confirmed `moshewin/sync-system-server` is theirs; see L2 for the old name |
| Elevation / supply chain | A changed gitleaks image runs over the repo | Tag + digest pin; `:ro` mount; no credentials passed; see L1 |
| Spoofing (release) | Publishing with the wrong npm account's token | Step 4 `npm whoami` pinned to `moshe-winberg` |

## Verification of the suppressed hits

I read every flagged line (values not reproduced here):

- **`jwt.ts:10` `TOKEN_HEADER_SEGMENT`**: decodes to
  `{"alg":"HS256","typ":"JWT"}`. It's a public constant, not a secret.
- **The two random-looking base64 `TOKEN_SECRET`s**
  (`multi-process.redis.test.ts`, line 14 in the fingerprinted commit and
  line 15 today; `restart-process.int.test.ts`, line 12 in the fingerprinted
  commit and line 15 today): both sit under a
  `/** Test-only values, never real ones. */` comment and are only passed
  to child server processes that the test itself spawns. I checked each
  exact value against all tracked files, the full working tree (including
  untracked and ignored files: `.env*`, the `compose*.yaml` files, the
  uncommitted `compose.yaml` edit) and `git log --all -S` history. Neither
  value appears anywhere outside its own test file. **They are not real
  secrets.** They can't sign tokens for any deployment, because deployments
  take `TOKEN_SECRET` from their own environment.
- **The other 13** use the repo's fixture style (`SENTINEL-...`,
  `test-api-key-...`, `key-a-0123456789-...`). All are under `test/`
  directories and are test-only.
- **The pinned image**: `docker buildx imagetools inspect
  zricethezav/gitleaks:v8.24.0` resolves to index digest
  `sha256:2bcceac4...5176`, which matches the plan.

## ADR 0022: option choice

I agree with **option 1** (per-finding fingerprints). It's the only option
that fails closed. Each entry suppresses one line in one commit, so if a
later commit puts a real value on the same line, it is still reported.
Option 2 makes every `test/` directory a blind spot. Option 3 lets anyone
bypass the scan by adding the marker to a real value. Option 4's
`gitleaks:allow` stays attached to the line when it is later edited. The
squash-merge caveat is also fail-closed: the scan reports the finding again
and nothing is silently hidden. That makes it a nuisance, not a risk.

## Step 4 `npm whoami` change and token scope

The change is correct and needed. A granular token belongs to the user
`moshe-winberg`, so `whoami` can never print the org name `mosherw`. The
old line would block every publish. That failure is safe (fail-closed), but
it would push the operator toward ad-hoc workarounds. Pinning the user is
what gives the check its value: it refuses a token from the wrong account.
I agree that step 4 should **not** call `npm org ls`: step 3 sets
"Organizations: no access", and keeping that least-privilege setting
matters more. Publish rights to `@mosherw` come from the token's package/
scope permission and the user's org ownership, and that is verified once in
step 0. Keep step 3's "Organizations: no access" unchanged.

## Docker Hub login user vs org

It matters only for whether login works, not for security. A Docker Hub
**personal** access token authenticates as its owner, so `docker login -u`
must be the owner's **username**. If `moshewin` is the user, `-u moshewin`
is right. If `moshewin` were an org, `-u moshewin` with a personal token
fails at login, which is safe. The fix would then be to log in as the member
user who has write on the repo, or to use an organization access token,
whose login name is the org. Either way, no credential reaches the wrong
account. See L3 for a step 0 check that removes the guess.

## Findings

| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| M1 | Medium | architecture.md Approach 4 (scope test); ADR 0022 Decision | The scope test accepts any rule id for `test/` paths. A later PR could fingerprint a high-confidence hit (`private-key`, `npm-access-token`, `github-pat`, `aws-access-token`) in a test file, the test would pass, and only the human review stands between that hit and publication. | In the scope test, also require the rule to be `generic-api-key` (the only rule suppressed today). Any other rule then needs an ADR 0022 amendment. Record this in the ADR's Decision and in the `docs/conventions.md` row. |
| L1 | Low | architecture.md Approach 3 (scan block) | The gitleaks container has network access it doesn't need. A compromised image could send repo contents out (the pin makes that unlikely). | Add `--network none` to the `docker run` and assert it in the release-files test next to `:ro` and `--redact`. |
| L2 | Low | spec "Out of scope"; historical `docs/issues/35`, `/37` | The old name `docker.io/mosherw/sync-system-server` stays in historical records. If the Docker Hub namespace `mosherw` isn't controlled by the maintainer, someone could register it and push a lookalike image for anyone who copies the old name. No release exists yet, so exposure is low. | Maintainer: check whether `mosherw` exists on Docker Hub. If it's free, consider registering it (an empty org or user). Otherwise accept. No code change needed. |
| L3 | Low | RELEASING.md step 0 Docker Hub item; step 6 `docker login docker.io -u moshewin` | The login user is assumed from the repo URL (architecture "Questions"). | Step 0 item: "`moshewin` is your Docker Hub **username** (Account settings). If it is an org, step 6 logs in with your member username instead." Resolve this before Gate 2 if possible. |
| L4 | Low | RELEASING.md step 0 npm item (pre-existing, touched by this plan) | `npm whoami` / `npm org ls mosherw` on the host need an npm login session, which leaves a session token on the host and can conflict with "Access Tokens page lists no token". The Docker Hub PAT text (line 362) suggests repo scoping that Docker Hub personal tokens generally don't offer. | Step 0: end the npm checks with `npm logout`, then check the Tokens page. Step 6: keep the "Read & Write" fallback, and say "not Delete" and the shortest expiry. |

## Required controls (part of the plan)

1. `.gitleaksignore` contains exactly the 16 fingerprints in
   architecture.md "Evidence", grouped under `#` comments, and no values.
2. Scope test: every entry is `<40 hex>:<path>:<rule>:<line>`. The path is
   under a `test/` directory, or the entry is exactly the `jwt.ts` line-10
   fingerprint. **The rule is `generic-api-key`** (M1).
3. Step 0 scan command: the image is pinned by tag and `sha256` digest from
   a single `GITLEAKS_IMAGE` variable, uses `--redact`, mounts `:ro`, passes
   no env or credentials, and uses `--network none` (L1). The test asserts
   all of these.
4. Step 4 compares `npm whoami` to `moshe-winberg`. Step 3 keeps
   "Organizations: no access". Step 4 does not add `npm org ls` or anything
   else that needs more token scope.
5. The step 6 tokens are still read with `read -rs`, passed with
   `--password-stdin`, and cleaned up by the `DOCKER_CONFIG` trap. Only the
   `-u` value and the tag names change.
6. No commit on the branch adds a secret-shaped literal. The final full
   scan with the pinned image on the branch reports `no leaks found`.
7. GHCR (`ghcr.io/mosherw`, `-u mosherw`) and npm (`@mosherw`) are
   unchanged.
8. ADR 0017's amendment doesn't spell out the full old Docker Hub reference
   (it would trip the new name test, and would invite copy-paste).

## What I'll check in code mode

- `.gitleaksignore`: line-by-line match with the Evidence table. Every
  value is re-read at its commit. No extra entries.
- gitleaks over `origin/main..HEAD` and over the full history with the
  pinned image reports no leaks. Every new fingerprint is justified.
- The scope test enforces path, the `jwt.ts` exception and the rule id, and
  fails for an entry outside that scope.
- RELEASING.md diff: only names, the `whoami` value, the step 0 items and
  the scan block change. The token handling (`read -rs`, stdin, traps,
  `unset`) is untouched. No `-x`.
- `git grep` over tracked files: no `docker.io/mosherw` outside
  `docs/issues/`. The `ghcr.io/mosherw` count is unchanged from `main`.
- The user's `compose.yaml` edit is not in any commit.
- npm audit (no dependency change expected).
