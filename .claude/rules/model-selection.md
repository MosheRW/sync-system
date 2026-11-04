# Model selection

The orchestrator chooses the model for **every** agent invocation and passes it
explicitly when invoking the subagent. Agents can't switch models mid-run, but
they can (a) recommend the model for the next step and (b) escalate when the
task is beyond the model they're running on.

## Tiers
| Model    | Use for | Never for |
|----------|---------|-----------|
| `haiku`  | Trivial, mechanical grooming: a one-line chore/typo issue (pm only) | Writing code, any review, architecture |
| `sonnet` | Well-defined work with a clear plan or a clear pattern to follow: most specs, designs, QA runs, implementing `light` plans | Open design decisions, security reviews, fix rounds after a failed review |
| `opus`   | Open design decisions, architecture, anything security-sensitive, plans touching schema/API/dependencies, every fix round, anything that already escalated or failed once | (no limit) |

## Defaults (when no better signal exists)
These match each agent's `model:` frontmatter, which is also the fallback if a
model can't be passed at invocation time.

| Agent       | Default  | Notes |
|-------------|----------|-------|
| `pm`        | `sonnet` | `haiku` only for trivial fast-path chores |
| `designer`  | `sonnet` | `opus` for new flows or screens with no existing pattern |
| `architect` | `opus`   | `sonnet` only on the fast path for small fixes following an existing pattern |
| `engineer`  | per the architect's `Implementer model:` line (`opus` if missing) | fix rounds and continuations always `opus` |
| `qa`        | `sonnet` | `opus` from review round 2 on |
| `security`  | `opus`   | always; never downgraded |

## How the choice is made, in order
1. Hard rules above (e.g. `security` is always `opus`; fix rounds are `opus`).
2. An `ESCALATE` from the last run of the same step → re-run on the next tier up.
3. The previous agent's `NEXT_MODEL` recommendation.
4. The default for the agent.
When in doubt, pick the higher tier: a failed round costs more than the
price difference.

## Recommending (`NEXT_MODEL`)
Every agent ends its result block with:
```
NEXT_MODEL: haiku | sonnet | opus  (for <next agent>, <one-line reason>)
```
Base it on what you learned while doing your own step: real complexity,
ambiguity, risk. Don't base it on cost.

## Escalating (`ESCALATE`)
Return `RESULT: ESCALATE` (not `BLOCKED`) when the task is solvable but beyond
your current model:
- the work needs decisions the plan/spec doesn't make
- a check still fails after **2 honest attempts**
- the code doesn't match what the plan or spec assumed
- you're not confident your output is correct
Before escalating: commit and push only finished, passing work; `git stash`
anything unfinished; record in `STATE.md` → "Model log" where you stopped and why.
`BLOCKED` stays reserved for things a model upgrade can't fix (missing
requirements, user decisions, plan is wrong). An agent already running on
`opus` returns `BLOCKED` instead of `ESCALATE`.

## Logging
The orchestrator appends one line per invocation to `STATE.md` → "Model log":
```
- <agent> <mode>: <model> (<why: default | NEXT_MODEL | escalation | rule>) → <RESULT>
```
