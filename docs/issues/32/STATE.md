# State: #32 fix(server): offer take-back only after a handoff loss (follow-up to #25)
- Path: fast
- Phase: validation
- Branch: fix/32-take-back-after-handoff-only
- PR: #45
- Plan approved by user: yes (2026-11-22, Q-1 accepted)
- Security-sensitive: yes (hostile member re-seizing the lead; permissions)
- Review rounds: 1
- Last updated by: qa
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (default, NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (rule: security-sensitive; Implementer model: opus) → DONE
## QA verdict
- Round 1: PASS. Checks 7/7 run locally (Docker), AC 8/8 met, RC-1..RC-8 met, no unsigned commits. GitHub Actions billing-blocked.
## Open questions
- none (Q-1 accepted at Gate 2: after a take-back the interim leader is a plain member and may be picked again as successor by the normal rule; the change to #13 AC25's first clause is accepted)
- Gate 3 advisories from security.md: L1 (upgrade window, in the PR body), L2 (in-memory restart and old leader tokens, pre-existing, possible follow-up)
## Implementation status
- Chunks 1-4 done; RC-1..RC-8 honoured (RC-7: limiter unit test asserts a refusal spends no budget; RC-8: `takeBack()` JSDoc fixed, PR body upgrade note).
- Local CI in Docker (node:24 + redis:7.2.17-alpine, repo copied in, no bind mounts): audit, lint, typecheck, test (all 1822 server tests incl. Redis suites, 0 skipped), build, compose config, reader e2e (5/5): all green.
## Deviations from plan
- Chunk 1 replaced the ping-pong rate-limit int test with the ping-pong refusal test (AC5) directly, so the commit stays green; chunk 2 adds the other new tests.
- Chunk 4 also updated wording the plan did not list but which stated the old rule: `apps/sync-server/src/groups/session.ts` (`takeBack` doc comment), `apps/reader/README.md` ("the server still allows it until #32"), and the README phrase pinned by `apps/sync-server/test/repo-hygiene.test.ts` (now pins "the leader displaced by the last handoff" and "A take-back cannot be taken back").
- `leader-controls.ts` `takeBack()` JSDoc fixed in chunk 4 per security L4 / RC-8.
