# Architecture: #102 wrong-password AC4 test fails against a Redis without a password

Path: fast. Spec: [spec.md](spec.md).

## Repo layout
- Layout: `monorepo` (pnpm workspaces, no submodules).
- Affected package: `apps/sync-server` (tests only).
- Checks: root `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; the
  Redis suite needs `SYNC_TEST_REDIS_URL` (without it the suite is skipped silently).

## Decisions
Decisions: none open.

**Test-only fix (recommended, chosen).** The product change (classifying
`ERR AUTH <password> called without any password configured ...` as an
authentication error) is rejected:
- The product is behaving correctly for the case it describes: the server
  sends a password Redis does not expect, and Redis refuses the command with
  a generic `ERR`. "Redis connection failed" is an honest message; widening
  `AUTH_REPLIES` would need message-text matching on a generic `ERR` reply,
  which is fragile across Redis versions and would be a change to the
  #35 AC4 error classification (reviewed by security) to fix a test.
- The spec bug is in the test fixture: it relies on the default user having
  a password, which is true only in CI.
If the user still wants that UX improvement, it is a separate product issue.

## Root cause (evidence)
- `apps/sync-server/test/main-redis.redis.test.ts:81-97` sets only
  `url.password = 'SENTINEL-wrong'`, so node-redis sends `AUTH SENTINEL-wrong`.
- Passwordless `redis:7` (7.4.12) replies `ERR AUTH <password> called without
  any password configured for the default user...`; `ERR` is not in
  `AUTH_REPLIES` (`apps/sync-server/src/storage/redis/connect.ts:81`), so the
  server prints `Startup error: Redis connection failed (REDIS_URL)`.
- `AUTH default <anything>` returns OK on a nopass default user.
- Verified by the architect on both live containers: after
  `ACL SETUSER probe102 reset on >known-pw`, `AUTH probe102 wrong-pw` returns
  `WRONGPASS invalid username-password pair or user is disabled.` on
  passwordless `redis:7` (6391) and on `redis:7.2.17-alpine --requirepass`
  (6392). The probe user was deleted afterwards.

## Approach
In the wrong-password test only:
1. Create a Redis ACL user with a known random password through the existing
   `userWithoutGet(prefix)` helper (same file, line ~103; a function
   declaration inside the `describeRedis` callback, so it is hoisted and
   callable from the earlier test; no lint rule forbids it). The user's
   command permissions are irrelevant because it never authenticates.
2. Build the `REDIS_URL` from `user.url` with the username kept and the
   password replaced by a different random wrong password, e.g.
   `SENTINEL-wrong-${randomBytes(8).toString('hex')}` (`randomBytes` is
   already imported). Redis replies `WRONGPASS` on both setups.
3. Keep both existing assertions unchanged (`{ ok: false, exitCode: 1 }` and
   the exact stderr `Startup error: Redis authentication failed (REDIS_URL)\n`).
4. Add secrecy assertions in the style of the next test (line ~160): stderr
   and the captured logs (`LogCapture`, keep a reference to it) contain
   neither the wrong password, the ACL user's real password, nor the user name.
5. `try { ... } finally { await user.remove(); }` so the ACL user is deleted
   (and the inspector closed) even if an assertion fails. Pass
   `REDIS_KEY_PREFIX: prefix` (from `randomPrefix()`) so `remove()`'s flush
   is scoped; nothing is written anyway.
6. A short comment above the test: why a dedicated ACL user (passwordless
   default user replies `ERR`, not `WRONGPASS`; refs #102).

Rejected alternatives:
- Skip the test when the default user has no password: weakens coverage
  locally for no gain, since the ACL approach works on both.
- A new helper (e.g. `aclUser()`): duplicates `userWithoutGet`; adds a hunk
  near #98's edits. Reusing the existing helper keeps the diff inside
  lines 81-97.

## Files to create / modify
- `apps/sync-server/test/main-redis.redis.test.ts`: rewrite the body of
  "prints an authentication Startup error for a wrong password (AC4)" only
  (lines 81-97), as above. No other hunk.

Contracts: none. Data model changes: none.
Docker impact: none.
Docs impact: none (test-only; no setup, config or behaviour change).

## Coordination with PR #98 (#87)
PR #98 (`test/87-redis-load-stable-tests`) edits the same file: the `childEnv`
import (line 14) and the exit-1 child test (~line 177), plus
`test/helpers/child-env.ts` and `test/multi-process.redis.test.ts`. #102 touches
only lines 81-97 and does not touch the helper or the import line, so git
should merge both cleanly in either order. If a conflict still appears on
whichever PR merges second, the engineer merges `origin/main` into that
branch (`git merge origin/main`), resolves by keeping both changes, re-runs
the checks, and pushes. Never rebase or force-push.

## Risks / edge cases
- The test needs ACL admin rights on the test Redis (`ACL SETUSER/DELUSER`);
  the neighbouring tests already require this, both in CI and locally.
- If `user.remove()` itself fails, the leftover user is disabled-by-password
  and random-named; harmless on a throwaway test Redis.
- `inspector()` connects as the default user via `SYNC_TEST_REDIS_URL`; works
  for both passwordless and password-protected Redis.

## Security-sensitive areas
Security-sensitive: no

Test-only change; no product code, endpoint, dependency, schema or config
change. The test handles throwaway random passwords against a throwaway test
Redis; the plan adds assertions that neither the wrong password, the ACL
password nor the user name reaches stderr or logs (#35 secrecy tests).

## Implementer model
Implementer model: sonnet
One test body in one file, following the existing `userWithoutGet` pattern in
`apps/sync-server/test/main-redis.redis.test.ts`; no decisions left open.

## Test plan
| Acceptance criterion | Verification |
|---|---|
| Root cause recorded | This document + PR body. |
| AC4 test passes on password-protected and passwordless Redis 7, no assertion weakened | `SYNC_TEST_REDIS_URL=redis://127.0.0.1:6391 pnpm --filter ./apps/sync-server exec vitest run test/main-redis.redis.test.ts` (passwordless) and the same with `SYNC_TEST_REDIS_URL=redis://:ci-only-redis-password@127.0.0.1:6392` (password-protected). Both green; check the run did not report the suite as skipped. Also confirm the test fails on 6391 before the change (reproduces the bug). After the run, `ACL LIST` on both shows no leftover `sync-test-*` users. |
| Lint, typecheck, test, build pass; no new deps | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` at the root; `pnpm-lock.yaml` unchanged. |

## Implementation chunks
1. `test(sync-server): use an acl user for the wrong-password ac4 test` (Refs: #102)

No docs chunk (`Docs impact: none`).
