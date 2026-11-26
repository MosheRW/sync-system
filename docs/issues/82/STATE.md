# State: #82 fix(release): narrow the ghcr token scope and pin buildkit in the server image step
- Path: fast
- Phase: implementation
- Branch: fix/82-ghcr-scope-buildkit-pin
- PR: #96
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: security-sensitive) → DONE
- security plan: opus (rule) → PASS
## Open questions
- none
## Deviations from plan
- Gate 2 decisions (2026-11-26), extending the plan:
  1. C5 / M-1: option (a). Both push blocks (step 6, R4) export a
     persistent `BUILDX_CONFIG` from the host config before
     `export DOCKER_CONFIG="$CFG"`, pass `--builder sync-release` to the
     push build and print `docker buildx inspect sync-release` before the
     first login. Step 6's "create and repeat the block" advice is
     replaced: the pinned builder is created before the push block.
  2. L-1 in scope: both push blocks check the token's `X-OAuth-Scopes`
     (`https://api.github.com/user`, header via `curl -H @-`) and refuse
     anything but exactly `write:packages` + `read:packages`; fail closed.
  3. L-2 in scope: `docker buildx use default` after the release.
  4. L-3 in scope: the bump note asks to check the moby/buildkit security
     advisories when starting each release.
