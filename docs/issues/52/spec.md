# Spec: #52 fix(release): move the docker ps check in RELEASING.md step 4 to its own block

Issue: https://github.com/MosheRW/sync-system/issues/52 (follow-up to #37, PR #50; source: QA A2)

## Problem
In `RELEASING.md` step 4 the trailing `docker ps -a --filter name=sync-release-publish` check shares a code block with the publish subshell. Without bracketed paste, the "Type yes" prompt reads it as input and the procedure aborts. This is safe (it happens before any token is used) but confusing.

## Acceptance criteria
- [ ] The `docker ps` check is in its own code block, after the publish block.
- [ ] The text tells the operator to run it as a separate step.
- [ ] The release marker test still passes.

## Out of scope
- Changing the publish procedure itself.

## Open questions
- none
