# State: #102 test(server): wrong-password AC4 test fails against a Redis without a password
- Path: fast
- Phase: architecture
- Branch: test/102-wrong-password-passwordless
- PR: #105
- Plan approved by user: yes (Gate 2, 2026-11-26)
- Security-sensitive: no
- Review rounds: 0
- Last updated by: orchestrator
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
## Open questions
- (resolved in architecture.md: test-only fix with a dedicated ACL user; product change rejected)
## Deviations from plan
- none
## Gate 2 decisions
- Plan approved by user (2026-11-26): test-only fix (ACL user in the wrong-password AC4 test). Product change rejected.
- Engineer starts only after PR #98 (#87) is merged (user decision); then merge origin/main into this branch first.
