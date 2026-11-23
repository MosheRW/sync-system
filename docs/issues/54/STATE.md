# State: #54 fix(ci): repo-hygiene CI trigger test blocks pnpm test in the release procedure

- Path: fast
- Phase: ready-to-merge
- Branch: fix/54-repo-hygiene-ci-trigger
- PR: #55
- Plan approved by user: yes (Gate 2, 2026-11-23: ADR 0018 option B)
- Security-sensitive: no (architect: comment-only workflow change; test keeps every security assertion)
- Review rounds: 1
- Last updated by: orchestrator

## Model log

- pm groom: sonnet (default) → DONE
- architect plan: opus (rule: orchestrator decision) → DONE
- engineer implement: opus (rule: Implementer model) → DONE
- qa review r1: sonnet (NEXT_MODEL) → PASS
- security code r1: opus (rule) → PASS (low advisories: L1 trigger allowlist bypass by quoted key / space before colon / column-0 comment; L2 pre-existing permissions check misses extra scopes and job-level permissions)
- Gate 3: 2026-11-23, PR #55 ready to merge; advisories L1, L2 awaiting user decision

## Open questions

- none (ADR 0018 accepted at Gate 2, 2026-11-23: option B)

## Deviations from plan

- Extra commit `style(docs): format the roadmap table after the #37 status update`: `b95876d` (roadmap update on this branch) left `docs/roadmap.md` unformatted, so `pnpm lint` failed, which also stops `RELEASING.md` step 2 before `pnpm test` (AC4). Formatting only, no content change.
- The trigger test picks the expected state from the marker (paused if `# CI paused (#54):` is present, otherwise active) instead of computing two booleans; equivalent to "exactly one holds" and gives a failure message naming the expected state.
