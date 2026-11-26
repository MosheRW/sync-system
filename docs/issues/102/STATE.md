# State: #102 test(server): wrong-password AC4 test fails against a Redis without a password
- Path: fast
- Phase: grooming
- Branch: test/102-wrong-password-passwordless
- PR: none
- Plan approved by user: no
- Security-sensitive: no (tentative)
- Review rounds: 0
- Last updated by: pm
## Model log
- pm groom: sonnet (default) → DONE
## Open questions
- Test-only fix vs. classifying the passwordless AUTH ERR as an authentication error.
## Deviations from plan
- none
