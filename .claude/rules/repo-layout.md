# Repo layout rules (monorepo, separate repos, submodules)

The same `.claude/` setup is used in monorepos, single-purpose repos, and repos
with git submodules. **Detect the layout; never assume it.**

## Detect (architect does this once per issue, records it in architecture.md)
```
git submodule status                    # any output → submodules exist
cat package.json | grep -A5 workspaces  # npm/yarn workspaces
ls pnpm-workspace.yaml turbo.json nx.json 2>/dev/null
ls docker-compose*.yml compose*.yml 2>/dev/null
```
Record: layout (`monorepo` | `single` | `submodules`), the packages/submodules
the issue touches, and for each one its path, default branch, and checks.

## Monorepo
- One issue, one branch, one PR. Chunks may span packages; prefix the commit
  scope with the package when useful: `feat(sync-service): ...`, `feat(app): ...`.
- Run checks per affected package (workspace scripts), plus root checks.

## Separate repos
- The loop runs **in one repo per session**. The issue, branch and PR live there.
- If a feature also needs changes in another repo, the pm/architect creates a
  **linked issue** there (`gh issue create -R <owner>/<repo> ...`, body
  `Part of <owner>/<this-repo>#<N>`) and the orchestrator tells the user that
  repo needs its own run. Never edit another repo's checkout from this session.
- Contracts between repos (API, sync protocol, message schemas) are written in
  `architecture.md` **before** either side is implemented.

## Submodules
The issue, board card and main PR live in the **parent** repo. Each submodule
changed gets its own branch and PR in its own repo.
1. In the submodule: `cd <path> && git switch <default> && git pull --ff-only &&
   git switch -c <same-branch-name-as-parent>`
2. Commit there (conventional + co-author trailers, scope = the submodule's own
   area), push, and open its PR from inside the submodule directory:
   `cd <path> && gh pr create --draft --title ... --body-file ...` with body
   `Refs <owner>/<parent>#<N>`.
3. In the parent: stage the new submodule pointer and commit it separately:
   `chore(<submodule-name>): update submodule pointer for #<N>`
4. Never leave the parent pointing at a commit that isn't pushed.
5. **Merge order (human):** submodule PR first, then update the parent pointer
   to the merged commit on the submodule's default branch (squash/rebase merges
   change the SHA), then the parent PR. The orchestrator spells this out at Gate 3.
6. Run each submodule's own checks inside its directory.
