# State: #9 fix(client): harden forgetAllGroups cut-off against clock skew (follow-up to #7)
- Path: fast
- Phase: validation
- Branch: fix/9-forget-cutoff-clock-skew
- PR: #72
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (rule: security-sensitive) → DONE
## Open questions
- none (D1 decided at Gate 2: B, monotonic + 60 s, no D floor)
## Deviations from plan
- D1 decision recorded in its own commit (`docs(architecture): record the D1 decision for #9`) before chunk 1, not inside the code commit.
- README also notes that a device clock ahead of the server widens the lost-token window (from the plan's risk list) and takes the optional L-a wording (cut-off lives in this tab's memory only).
## Verification notes
- Root `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm audit --audit-level=high`: pass. Lockfile and `packages/client/src/index.ts` unchanged.
- Tests: client 581/581, react 227/227, other workspaces 1079/1079, root scripts 86/86, protocol pass. `apps/sync-server` (not touched by this issue) had load-dependent timeouts on this machine (parallel sessions): `release-files.test.ts` passes with `--testTimeout=60000`; `redis-startup.test.ts` "reports a refused port as unreachable, fast" took 5.9 s against its 5 s bound.
