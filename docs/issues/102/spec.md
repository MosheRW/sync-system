# Spec: test(server): wrong-password AC4 test fails against a Redis without a password

Issue: https://github.com/MosheRW/sync-system/issues/102 (refs #48, #35, #87)

## Problem
`apps/sync-server/test/main-redis.redis.test.ts` ("prints an authentication Startup error for a wrong password (AC4)", ~line 81) fails against a Redis started without a password; it passes in CI (password-protected Redis). Also fails on clean `origin/main`.

Root cause (established with evidence):
- The test sets only `url.password = 'SENTINEL-wrong'` (no username), so node-redis sends a single-arg `AUTH SENTINEL-wrong`.
- Passwordless docker `redis:7` (7.4.12) replies `ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?`. The reply code `ERR` is not in `AUTH_REPLIES` (`apps/sync-server/src/storage/redis/connect.ts:81`), so the server prints `Startup error: Redis connection failed (REDIS_URL)` instead of the authentication error.
- `AUTH default SENTINEL-wrong` against a nopass default user returns OK, so adding only a username does not help.
- Against `redis:7.2.17-alpine --requirepass ci-only-redis-password` (the CI setup) the test passes (WRONGPASS).

## Candidate fixes (architect decides)
1. Test-only: the test creates an ACL user with a known password (like `userWithoutGet`), then connects with that username and a wrong password, giving WRONGPASS on both setups.
2. Product change: classify that `ERR AUTH ... without any password configured` reply as an authentication error (AC4 of #35).

## Acceptance criteria
- [ ] Root cause recorded with evidence (above, kept in the architecture/PR notes).
- [ ] The AC4 wrong-password test passes against both a password-protected and a passwordless Redis 7, or is skipped with an explicit, logged reason in the passwordless case; no assertion weakened without justification.
- [ ] Lint, typecheck, test and build pass; no new dependencies.

## Out of scope
- The AC4 exit-1 timeout under load (#87, PR #98). PR #98 also edits `main-redis.redis.test.ts` and `test/helpers/child-env.ts`; only the wrong-password test is touched here.
- `docs/roadmap.md`.

## Open questions
- Test-only fix vs. product classification change (see candidate fixes); the architect should recommend one.
