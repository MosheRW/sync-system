# State: #52 fix(release): move the docker ps check in RELEASING.md step 4 to its own block (follow-up to #37)

- Path: fast
- Phase: validation
- Branch: fix/52-releasing-docker-ps-block
- PR: #61
- Plan approved by user: yes (Gate 2, 2026-11-23)
- Security-sensitive: no
- Review rounds: 2
- Last updated by: engineer

## Model log

- pm groom: sonnet (default) → DONE
- architect plan: sonnet (NEXT_MODEL: small docs fix following an existing pattern) → DONE
- engineer implement: sonnet (Implementer model) → DONE
- qa review r1: sonnet (NEXT_MODEL) → PASS (local Docker CI green; 3/3 criteria met; #51 bookkeeping accurate)
- security code r1: opus (rule) → PASS (low A1: step 4 intro still says "Paste only this block:" with two blocks)
- Gate 3: 2026-11-23, PR #61 ready to merge; low advisory A1 awaiting user decision
- engineer fix r1: opus (rule: fix round) → DONE (A1: step 4 intro now says "Paste only the first block below:"; release-files test regex updated to match)

## Open questions

- none

## Deviations from plan

- none
