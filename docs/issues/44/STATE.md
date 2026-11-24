# State: #44 fix(reader): escape control characters in echoed config values (follow-up to #36)
- Path: fast
- Phase: ready-to-merge
- Branch: fix/44-reader-config-echo-escape
- PR: #70
- Plan approved by user: yes
- Security-sensitive: no
- Review rounds: 1
- Last updated by: qa
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: sonnet (NEXT_MODEL) → DONE
- engineer implement: sonnet (architect Implementer model) → DONE
- qa review round 1: sonnet (NEXT_MODEL) → PASS
- security code round 1: opus (rule) → PASS (low advisory: bidi/zero-width chars)
- QA verdict (round 1): PASS
## Open questions
- none
## Deviations from plan
- Test for the shownUrl path uses READER_SRC_ORIGINS instead of READER_SYNC_URL (the latter also needs an API key, which would add a second problem); both go through shownUrl.
- Test uses READER_FETCH_TIMEOUT_SECONDS for the integer path (READER_PORT is not a reader variable).
