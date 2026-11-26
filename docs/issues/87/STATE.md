# State: #87 test(sync-server): main-redis AC4 and multi-process reconnect tests flaky under load
- Path: fast
- Phase: architecture
- Branch: test/87-redis-load-stable-tests
- PR: #98
- Plan approved by user: no
- Security-sensitive: no
- Review rounds: 0
- Last updated by: architect
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (default) → DONE
## Open questions
- release-files.test.ts L11 fails deterministically on main (8dd503c), unrelated to #87; see architecture.md Open questions.
## Deviations from plan
- none
