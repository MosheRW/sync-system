# State: #86 fix(sync-server): stale pubsub probe result can replace a healthy link
- Path: fast
- Phase: implementation
- Branch: fix/86-pubsub-probe-race
- PR: #94
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect: opus (default) → DONE
- security plan: opus (rule) → PASS (0 critical, 0 high, 0 medium, 3 low; required controls RC1-RC6 in security.md)
## Gate 2 decisions (user, 2026-11-26)
- Plan approved as proposed.
- L1 (guard relies on connect.ts bounds): accepted; RC4 covers it in this PR.
- L2 (debug event for discarded stale results): accepted, not implemented.
- L3: include one line in `docs/operator-guide.md` (`REDIS_COMMAND_TIMEOUT_MS`
  row): stall detection can take up to heartbeat + command timeout when the
  timeout exceeds the 5 s heartbeat. Own `docs(...)` commit.
## Open questions
- none
## Deviations from plan
- none
