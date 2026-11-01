# Git & commit rules

## Conventional Commits (mandatory)
Format: `<type>(<optional scope>): <subject>`

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `style`, `build`, `ci`, `chore`, `revert`
- Subject: imperative mood ("add", not "added"), lowercase, no trailing period, ≤ 72 chars
- Body (optional): explain *why*, wrap at 72 chars
- Breaking change: `feat(api)!: ...` plus a `BREAKING CHANGE:` footer
- Reference the issue with a trailer: `Refs: #<N>`

Examples:
```
docs(spec): add spec for #42
feat(auth): add refresh-token rotation
test(auth): cover expired refresh token
fix(auth): reject reused refresh token
```

## Co-author signature (every agent commit)
Every commit an agent makes ends with **two** `Co-Authored-By` trailers, one
per line (GitHub parses only one co-author per line):

1. **The model actually running you**, e.g. `Claude Opus 5.5` or
   `Claude Sonnet 5.5`, as named in your own system prompt, with
   `<noreply@anthropic.com>`. Never copy a model name from an example or
   another commit. If you can't tell which model you are, use plain `Claude`.
2. **Your own agent identity**: your role title plus the fabricated email
   `<agent-name>@sync-system`, where `<agent-name>` is the `name:` in your
   agent file's frontmatter.

Use `git commit --trailer` so git formats the footer correctly:

```
git commit -m "<type>(<scope>): <subject>" \
  --trailer "Refs: #<N>" \
  --trailer "Co-Authored-By: <actual model name> <noreply@anthropic.com>" \
  --trailer "Co-Authored-By: <Role title> <<agent-name>@sync-system>"
```

| Agent (`name:`) | Role trailer                                               |
|-----------------|------------------------------------------------------------|
| `pm`            | `Co-Authored-By: Product Manager <pm@sync-system>`         |
| `designer`      | `Co-Authored-By: Designer <designer@sync-system>`          |
| `architect`     | `Co-Authored-By: Architect <architect@sync-system>`        |
| `engineer`      | `Co-Authored-By: Engineer <engineer@sync-system>`          |
| `qa`            | `Co-Authored-By: QA Engineer <qa@sync-system>`             |
| `security`      | `Co-Authored-By: Security Engineer <security@sync-system>` |

Any agent added later follows the same rule. Add it to this table and give it
its own "Commit signature" section.

Example (engineer running on Sonnet 5.5):
```
feat(auth): add refresh-token rotation

Refs: #42
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Co-Authored-By: Engineer <engineer@sync-system>
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
