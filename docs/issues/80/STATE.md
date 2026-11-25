# State: #80 test: make load-sensitive tests stable under machine load (follow-up to #47)
- Path: fast
- Phase: architecture
- Branch: test/80-load-stable-tests
- PR: #85
- Plan approved by user: no
- Security-sensitive: no
- Review rounds: 0
- Last updated by: architect
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (rule: one tier up from NEXT_MODEL sonnet) → DONE
## Open questions
- Follow-up issue for the stale-probe race in RedisPubSub.probe() (product, security control C15/F20); see architecture.md
- Other load-flaky tests outside #78/#80: main-redis.redis.test.ts AC4, multi-process.redis.test.ts
## Deviations from plan
- none
