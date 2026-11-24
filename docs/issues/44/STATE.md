# State: #44 fix(reader): escape control characters in echoed config values (follow-up to #36)
- Path: fast
- Phase: implementation
- Branch: fix/44-reader-config-echo-escape
- PR: #70
- Plan approved by user: yes
- Security-sensitive: no
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: sonnet (NEXT_MODEL) → DONE
- engineer implement: sonnet (architect Implementer model) → DONE
## Open questions
- none
## Deviations from plan
- Test for the shownUrl path uses READER_SRC_ORIGINS instead of READER_SYNC_URL (the latter also needs an API key, which would add a second problem); both go through shownUrl.
- Test uses READER_FETCH_TIMEOUT_SECONDS for the integer path (READER_PORT is not a reader variable).
