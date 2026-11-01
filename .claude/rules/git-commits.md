# Git & commit rules

## Conventional Commits (mandatory)
Format: `<type>(<optional scope>): <subject>`

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `style`, `build`, `ci`, `chore`, `revert`
- Subject: imperative mood ("add", not "added"), lowercase, no trailing period, ≤ 72 chars
- Body (optional): explain *why*, wrap at 72 chars
- Breaking change: `feat(api)!: ...` plus a `BREAKING CHANGE:` footer
- Reference the issue in the footer: `Refs #<N>`

Examples:
```
docs(spec): add spec for #42
feat(auth): add refresh-token rotation
test(auth): cover expired refresh token
fix(auth): reject reused refresh token
```

## Commit granularity
- One logical chunk per commit, so the history reads as the chronology of the work.
- Never mix unrelated changes in one commit.
- Commit each phase's deliverable before handing off, and push it.

## Branches
- Name: `<type>/<issue-number>-<short-slug>`, e.g. `feat/42-refresh-tokens`, `fix/57-null-avatar`
- Branch from the repo's default branch:
  `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`

## Never
- `git push --force` / `-f` / `--force-with-lease` on shared branches
- `git commit --amend` or `git rebase` on commits that are already pushed
- `--no-verify` (don't skip hooks; fix what they report)
- `git reset --hard` or deleting branches without the user's approval
- Committing secrets, `.env` files, or generated build output
