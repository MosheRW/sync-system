# State: #5 Participant tokens, token rejoin and restart recovery
- Path: full
- Phase: grooming
- Branch: feat/5-tokens-recovery
- PR: none
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: pm

## Notes
- PRD item 3 of 9. "item N" in spec.md means PRD item N, not GitHub issue N.
- Builds on #1 (server core, merged in PR #2) and #3 (core client, merged in PR #4).
- Spec: docs/issues/5/spec.md (43 acceptance criteria, 15 open questions with proposed defaults).
- Designer: likely skipped (no UI; client API and protocol only).

## Open questions
- Q1 live-group recovery on leader disconnect (default: group stays frozen, leader returns with token)
- Q2 timer ownership (default: max session + inactivity-limit config here; live timers/keep-alive in item 5)
- Q3 explicit group.end / group.leave (default: include)
- Q4 remove member (default: item 5; block list storage/transport/enforcement here)
- Q5 duplicate attachment (default: newest resume wins)
- Q6 member token refresh (default: leader tokens only)
- Q7 members waiting for leader (default: server-side parking)
- Q8 ended-group memory (default: in-memory refs until max session deadline)
- Q9 automatic token check on first connect (default: no)
- Q10 recovery slack (default: inactivity limit + max refresh interval)
- Q11 default client storage (default: localStorage)
- Q12 storage key / namespace in hello.ok (default: sync-system:v1:<namespace>@<host[:port]>)
- Q13 protocol version (default: keep 1)
- Q14 position on leader return (default: server's live position wins)
- Q15 secret outside production (default: random per-process secret + warning; dev secret in compose)

## Deviations from plan
- none
