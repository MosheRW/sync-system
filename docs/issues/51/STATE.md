# State: #51 fix(docs): operator guide passes TOKEN_SECRET with docker run -e (follow-up to #37)

- Path: fast
- Phase: architecture
- Branch: fix/51-operator-guide-token-secret
- PR: none
- Plan approved by user: no
- Security-sensitive: yes (secret-handling guidance; security plan review runs)
- Review rounds: 0
- Last updated by: architect

## Model log

- pm groom: sonnet (default) → DONE
- architect plan: opus (rule: secret-handling guidance, when in doubt go up) → DONE

## Open questions

- Follow-up idea (not this issue): native `TOKEN_SECRET_FILE` / `REDIS_URL_FILE` support; needs its own issue and an ADR 0015 amendment.

## Deviations from plan

- none
