# Spec: #48 test(server): cover forgetGroup slot retention and fix limits wording (follow-up to #12)

Issue: https://github.com/MosheRW/sync-system/issues/48
Path: fast. Follow-up to #12 (PR #46), QA advisories A1 and A2.

## Problem
1. No `forgetGroup` slot-retention test (A1). `liveGroups.release` has two call sites: the create guard and `endGroup`. `forgetGroup` and the cluster `forget` must leave the live-group slot (`lg`) in place, because the group still exists elsewhere. Nothing pins this.
2. Ambiguous wording (A2). The sentence is NOT in README.md. It is in `docs/operator-guide.md`, section "Several instances", around line 522: "(the four `MAX_GROUP_CREATE*` and `MAX_LIVE_GROUPS_PER_APP` variables)". Only three names match `MAX_GROUP_CREATE*`, so it can read as five variables.

Context: #47 (PR #75, merged) changed `apps/sync-server/src/groups/live-groups.ts`, the redis scripts/timers, and the tests `live-groups.test.ts` and `live-groups.redis.test.ts`. The regression test must build on the current code after #47.

## Acceptance criteria
- [ ] A test shows that `forgetGroup` and the cluster `forget` leave the live-group slot in place, and that `endGroup` still releases it.
- [ ] The test covers the memory implementation and, where the suite runs it, Redis.
- [ ] The `docs/operator-guide.md` parenthetical no longer reads as five variables (suggested: "(the four group creation variables: `MAX_GROUP_CREATE*` and `MAX_LIVE_GROUPS_PER_APP`)", or equivalent reading as four in total).
- [ ] Only that one parenthetical is edited in the doc (other sessions edit nearby text for #41).
- [ ] No product code change; lint, typecheck, test and build pass; no new dependencies.

## Out of scope
- Any change to when slots are released.
- Other doc rewrites.
- `docs/roadmap.md` (do not edit).

## Open questions
- none
