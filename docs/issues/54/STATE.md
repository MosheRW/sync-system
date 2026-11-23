# State: #54 fix(ci): repo-hygiene CI trigger test blocks pnpm test in the release procedure

- Path: fast
- Phase: architecture
- Branch: fix/54-repo-hygiene-ci-trigger
- PR: #55 (draft)
- Plan approved by user: no
- Security-sensitive: no (architect: comment-only workflow change; test keeps every security assertion)
- Review rounds: 0
- Last updated by: architect

## Model log

- pm groom: sonnet (default) → DONE
- architect plan: opus (rule: orchestrator decision) → DONE

## Open questions

- ADR 0018 (Proposed): A restore triggers, B marked pause the test accepts (recommended), C env flag (rejected), D repo-variable job gate (rejected). User decides at Gate 2.

## Deviations from plan

- none
