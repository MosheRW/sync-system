# State: #47 fix(storage): bound create-budget key TTL and batch expired live-group cleanup
- Path: fast
- Phase: implementation
- Branch: fix/47-live-group-limits
- PR: #75
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (default + NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (architect Implementer model + NEXT_MODEL) → DONE
## Gate 2 decisions (user)
- AC1: cap the `lb:<ns>` TTL (not the document-only option)
- The 1 ms margin is accepted: `lb:<ns>` expires at `PEXPIREAT ceil(u) + 1`, from Redis TIME
## Open questions
- none
## Deviations from plan
- Security advisories folded in (orchestrator instruction): L1 (`burst > rate x L` in code comments and the operator guide, plus a unit case and an H1 flood case with the per-minute bound below the derived rate), L2 (`claimDue` checks the reply shape before using `freed`; logs `timer_claim_invalid` and claims nothing), L3 (AC24 privacy test comment and a `pExpireTime(lb) <= pExpireTime(lg) + 1` assertion)
- Extra unit tests beyond the test plan: `bucketStep` boundary (`ceil(u) + 1`, `u` in the past) and `MemoryLiveGroups.tidy` dropping an app once its bucket ended before it was full
- Redis AC1 test bounds `pTTL(lb)` by `L + 1` (`L` = 60 min + 5 s slack, the derived rate's life) instead of `HOUR + 1`
- C6: the poller tests also count the `CLAIM_DUE` calls (3 for 129 members, 2 for exactly 64)
- `test/contracts/state.ts` (#12 R13 contract, existing): `u` moved from now + 300 ms to now + 600 ms and the second wait from 400 to 500 ms. The bucket now ends 1 ms after `u` instead of up to 100 ms later, so on the real-clock Redis harness the two reserves after the 250 ms wait had only ~50 ms (Windows timers + Docker port-forward round trips) before `u` and failed consistently; expectations unchanged (commit 968e47b)
