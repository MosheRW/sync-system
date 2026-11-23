# State: #51 fix(docs): operator guide passes TOKEN_SECRET with docker run -e (follow-up to #37)

- Path: fast
- Phase: ready-to-merge
- Branch: fix/51-operator-guide-token-secret
- PR: #57
- Plan approved by user: yes (Gate 2, 2026-11-23, with security controls C1–C8; follow-up #58)
- Security-sensitive: yes (secret-handling guidance; security plan review runs)
- Review rounds: 1
- Last updated by: orchestrator

## Model log

- pm groom: sonnet (default) → DONE
- architect plan: opus (rule: secret-handling guidance, when in doubt go up) → DONE
- engineer implement: opus (rule: Implementer model) → DONE
- qa review r1: sonnet (NEXT_MODEL) → PASS
- security plan r1: opus (rule) → PASS
- security code r1: opus (rule) → PASS (low advisories: A1 test guard misses export / ${:-default} / flow-map / line-continuation forms; A2 Swarm bullet should say docker stack deploy)
- Gate 3: 2026-11-23, PR #57 ready to merge; advisories A1, A2 awaiting user decision

## Open questions

- none (native `_FILE` support is follow-up #58).

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
