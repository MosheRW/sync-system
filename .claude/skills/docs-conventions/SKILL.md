---
name: docs-conventions
description: 'Documentation conventions: architecture decision records (ADRs) for undecided technical or design choices, the project conventions file, README, protocol/API docs, self-hosting docs, and the docs chunk every plan must include. Use when a plan contains an open decision, when a change affects setup, configuration, APIs, protocols, or usage, and when reviewing whether docs were updated.'
---

# Documentation conventions

## Where things live
| File | Holds | Updated when |
|---|---|---|
| `docs/conventions.md` | The project's accepted choices in one page: stack, transport, styling, folder layout, scripts, commit scopes | An ADR is accepted |
| `docs/decisions/NNNN-<slug>.md` | One ADR per significant decision | A decision is proposed, accepted, or superseded |
| `README.md` | What it is, quick start, scripts, links to the other docs | Setup, scripts, or usage change |
| `docs/protocol.md` / `docs/api.md` | Every endpoint or message type: shape, errors, versioning | Any contract change |
| `docs/self-hosting.md` | Docker/compose setup, every env variable, upgrade notes | Config, images, or compose change |
| `docs/issues/<N>/` | Per-issue spec, design, architecture, security, state | Throughout the issue |

Create a file the first time it's needed; don't scaffold empty docs.

## ADRs (decisions that aren't made yet)
The architect writes an ADR whenever a plan depends on an undecided choice
(framework, transport, styling, storage, a new dependency, or a design-system
foundation). Number sequentially. Template:

```
# NNNN. <Decision title>
- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD
- Issue: #<N>

## Context
What forces this decision; constraints (e.g. client-agnostic, self-hostable,
stores no data).

## Options
1. <Option A>: pros / cons
2. <Option B>: pros / cons

## Decision
<Recommended option> because <reasons tied to the context>.

## Consequences
What becomes easier, what becomes harder, what we must now do.
```

- The architect commits the ADR as `Proposed` with the plan. The user decides
  at Gate 2.
- After approval, the **first implementation chunk** sets it to `Accepted`,
  records the choice in `docs/conventions.md`, and commits:
  `docs(adr): accept NNNN <slug>`.
- A rejected option: update the ADR to the user's choice before accepting.
- Never edit an accepted ADR's decision. Supersede it with a new one.

## The docs chunk
Every plan's chunk list ends with a docs chunk whenever the change affects
README, protocol/API, self-hosting/config, or conventions, e.g.
`docs(protocol): document group join messages`. If nothing is affected, the
plan says `Docs impact: none` explicitly.

## Style
Short, task-first ("To run locally: …"), copy-pasteable commands, every env
variable listed with default and example, no stale screenshots; link instead of
duplicating.
