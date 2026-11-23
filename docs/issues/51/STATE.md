# State: #51 fix(docs): operator guide passes TOKEN_SECRET with docker run -e (follow-up to #37)

- Path: fast
- Phase: ready-to-merge
- Branch: fix/51-operator-guide-token-secret
- PR: #57
- Plan approved by user: yes (Gate 2, 2026-11-23, with security controls C1–C8; follow-up #58)
- Security-sensitive: yes (secret-handling guidance; security plan review runs)
- Review rounds: 3
- Last updated by: orchestrator

## Model log

- pm groom: sonnet (default) → DONE
- architect plan: opus (rule: secret-handling guidance, when in doubt go up) → DONE
- engineer implement: opus (rule: Implementer model) → DONE
- qa review r1: sonnet (NEXT_MODEL) → PASS
- security plan r1: opus (rule) → PASS
- security code r1: opus (rule) → PASS (low advisories: A1 test guard misses export / ${:-default} / flow-map / line-continuation forms; A2 Swarm bullet should say docker stack deploy)
- Gate 3: 2026-11-23, PR #57 ready to merge; the user chose to fix advisories A1, A2 now
- engineer fix r1: opus (rule: fix round) → DONE (A1: guide check also catches `export`, `${…:-…}`/`${…-…}`/`${…:=…}`/`${…=…}` defaults, flow maps and `-e \` continuations; A2: Swarm bullet says `docker stack deploy`)
- qa review r2: opus (rule: round 2) → PASS (local Docker CI green; A1 mutation check fails on export, ${:-default}, flow map, -e continuation; safe forms pass; A2 verified)
- security code r2: opus (rule) → PASS (low advisories A3: Swarm ingress ignores `127.0.0.1:` in `ports:`; A4: remaining gaps in the guide secret check)
- Gate 3 (round 2): 2026-11-23, the user chose to fix A3 now and move A4 to follow-up #59
- engineer fix r2: opus (rule: fix round) → DONE (A3: Swarm bullet drops `ports:` and puts the proxy on the overlay network, verified in docker:dind 29.10; roadmap lists #59; local Docker CI green)
- qa review r3: opus (rule: round 2+) → PASS (local Docker CI green; A3 Swarm bullet accurate and consistent; non-blocking N1: routing mesh hides client IPs from the proxy, affects nginx `allow 10.0.0.0/8` and `limit_conn perip`; suggest `mode: host` for the proxy port)
- security code r3: opus (rule) → PASS (low A5: multi-node Swarm overlay traffic unencrypted by default)
- Gate 3 (round 3): 2026-11-23, PR #57 ready to merge; security A5 and QA note N1 (Swarm routing mesh hides client IPs) → follow-up #60 (user decision)

## Open questions

- none (native `_FILE` support is follow-up #58).
- Follow-up #59 `test(server): close remaining gaps in the operator-guide secret check (follow-up to #51)` (security A4, Gate 3 round 2): open.

## Deviations from plan

- `### Passing secrets to the container` sits at the end of `## Token secret`
  (after the leak paragraph and the HKDF note), not between the rules list and
  "Routine rotation": placed there, the rotation and leak paragraphs would have
  read as part of the new subsection. Routine rotation step 1 and the leak
  paragraph link to it instead (security M3).
- Env file creation uses `install -m 600 /dev/null FILE` then `printf ... >`
  (one of the two options the plan allowed, and security L1): the mode is set
  before the secret is written, also when the file already exists.
- The compose wrapper uses a `>-` folded YAML scalar (one `sh -c` string,
  readable one step per line) instead of one long single-quoted line; verified
  in Docker. The compose secret example uses `/etc/sync-server/token_secret`
  owned 1000:1000 mode 400 (security M1, M2), not `./sync_token_secret`.
- The regression test follows security M4/C7 (code blocks only, `-e`/`--env`
  variants, literal-value check, self-check) instead of the plan's single
  regex over the whole file.
- Roadmap chunk also adds follow-up #58 (orchestrator instruction at Gate 2);
  commit subject `docs(roadmap): fix the #56 title and add follow-up #58`.
- Compose `uid`/`gid`/`mode` secret options are not documented (not verified,
  per plan).
- Fix r2 (A3): the Swarm advice was verified in a throwaway docker:dind
  29.10 Swarm rather than taken from docs: `127.0.0.1:8081:8080` deploys as
  `PublishMode: ingress` on `0.0.0.0`; long syntax with `host_ip` is rejected
  by `docker stack deploy`; `mode: host` also binds `0.0.0.0`. So the guide
  recommends no published port and the proxy on the stack's overlay network
  (verified: reachable as `sync-server:8080`, no host listener), and does not
  offer `mode: host` as a loopback option.
