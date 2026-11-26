# State: #48 test(server): cover forgetGroup slot retention and fix limits wording
- Path: fast
- Phase: ready-to-merge
- Branch: test/48-forget-slot-retention
- PR: #93
- Plan approved by user: yes
- Security-sensitive: no
- Review rounds: 1
- Last updated by: orchestrator
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: sonnet (NEXT_MODEL from pm) → DONE
- engineer implement: sonnet (architect Implementer model) → DONE
- qa round 1: sonnet (NEXT_MODEL from engineer) → PASS
- security code round 1: opus (rule) → PASS (0 findings)
## Open questions
- none
## Deviations from plan
- The service is not reachable from `SyncServer`, so the tests reach it through the class prototype (`vi.spyOn(GroupService.prototype, 'create')`, `mock.contexts[0]`); no src change. On Redis `forgetGroup` is called inside `service.lock.run` because it needs a group task.
- The cluster `forget` test calls `receiveRemote` on the captured service instead of spying `storage.cluster.setReceiver` (same code path).
- The memory test could not use a cluster; Redis tests assert the `lg` zset (`release` is part of the Redis commit, not spy-able).
- One extra commit: lint fix for the new tests.
