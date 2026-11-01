# GitHub CLI rules

- **Explicit numbers only.** Always act on the issue/PR number you were given.
  Never pick "the active issue" from `gh issue list`.
- **Bodies via file.** For any multi-line body, write it to a temp file and use
  `--body-file`, never `--body "..."` (quotes and newlines break):
  ```
  cat > /tmp/body-42.md <<'MD'
  ...
  MD
  gh issue comment 42 --body-file /tmp/body-42.md
  ```
- **Board moves** go through the helper only:
  `bash .claude/scripts/board.sh <issue> "<Status>"`
- **Never** run `gh pr merge`, `gh pr review --approve`, `gh issue close`,
  `gh pr close`, or `gh repo delete`. Merging and approving belong to the human.
  (All agents share one GitHub account, which is the PR author, and GitHub
  rejects approving your own PR anyway.)
- Comments link to the committed docs, e.g.
  `docs/issues/42/architecture.md` on branch `feat/42-refresh-tokens`.
- Required auth scopes: `repo`, `read:org`, `project`
  (`gh auth refresh -s project` if board commands fail).
