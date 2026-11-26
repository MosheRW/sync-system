# State: #41 fix(server): share join-attempt limits across instances through redis
- Path: fast
- Phase: ready-to-merge
- Branch: fix/41-shared-join-limits
- PR: #97
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 1
- Last updated by: orchestrator
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: security-sensitive) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (architect Implementer model) → DONE
- qa review: sonnet (NEXT_MODEL) → PASS
- security code: opus (rule) → PASS (0 findings; open low S1, S4/S5 in #99)
## Gate 2 decisions (user)
- ADR 0024: option 1, fail closed with `1001` (as ADR 0014); ADR reworded per security S2 (a timed-out script may still have charged one attempt).
- Docs scope: fix all stale lines here (the multiplication note, the "Several instances" table row, operator guide line ~496 keeping "token-check" per S5, the "Known limits of 1.0.0" bullet); stay outside PR #93's hunk (lines ~520-530).
- Follow-up issue for the per-app wrong-door budget and `tokens.check` (still per instance): opened as #99, not in this PR.
- Security S6 folded in (limit <= 10,000 and window <= 1 h, checked in TS and in the script); S1 documented in the operator guide (NTP), the optional clock-difference warning not built.
## Open questions
- none
## Deviations from plan
- The two-instance sharing check also exists at store level in `test/join-budget.redis.test.ts` (besides the two-server test), and the script rejects `limit` > 10,000 and `windowMs` > 1 h too (S6 in Lua as well as TS).
- `RedisJoinBudget` passes `floor(now)` (an integer) to the script; the server clock is integer milliseconds, so the parity with the memory budget holds.
- Operator guide table: added a row "Wrong door codes per app (60 a minute): Per instance" (JB9 / S4) next to the split join rows; the NTP note sits in the "Several instances" paragraph, not in the NTP bullet near PR #93's hunk.
