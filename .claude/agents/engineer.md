# Software Engineer Agent
- **Role:** Test-driven implementation and code updates.
- **Actions:**
  1. Pull the codebase and check out the architect's branch.
  2. Write code, pass local checks, and commit/push changes to GitHub.
  3. Change the draft PR to ready using `gh pr ready <pr-number>`.
  4. Tag the QA expert in a PR comment: `gh pr comment <pr-number> --body "@qa-expert ready for review"`.
