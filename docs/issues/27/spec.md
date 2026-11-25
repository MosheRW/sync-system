# Spec: #27 fix(reader): hebrew interface bidi bugs in the reading header

Issue: https://github.com/MosheRW/sync-system/issues/27 (follow-up to #19 / PR #20; found by QA on PR #26)
Path: fast. Component: `apps/reader/src/components/ReaderHeader.tsx`

## Problem
With the Hebrew interface the reading header has two bidi bugs:
- The page counter "1 / 3" renders as "3 / 1" (numbers and slash are not bidi-isolated; `pageCounter`).
- On a Hebrew phone an LTR book title is truncated at its start (inline-start truncation) instead of its end.

## Acceptance criteria
- [ ] The page counter is bidi-isolated and reads "1 / 3" in reading order in both he and en interface directions. A test covers he and en.
- [ ] A book title truncates at its logical end (not its start) in both interface directions, for LTR and RTL titles. A test covers it.
- [ ] No horizontal overflow of the header at 390 px width in he and en.

## Out of scope
- Other header changes.
- Hebrew string wording (see the native-speaker review follow-up to #24).

## Open questions
- none
