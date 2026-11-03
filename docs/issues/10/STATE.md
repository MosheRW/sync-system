# State: #10 Join methods A-D (door code, approval, alphanumeric, QR)
- Path: full
- Phase: validation (QA round 3 FAIL, fix round 3 needed)
- Branch: feat/10-join-methods
- PR: #11 (ready for review)
- Plan approved by user: yes (Gate 2, with decisions Q-A to Q-E below)
- Security-sensitive: yes (door codes, approval, brute-force limits, QR ticket signing, codes blob, removal of join by group ID)
- Review rounds: 3 (code review); security plan review rounds: 3 (round 1 FAIL, round 2 PASS, round 3 targeted PASS)
- QA verdict: FAIL (round 3, head 81726e5)
- Last updated by: qa (round 3)

## Notes
- PRD item 4 of 9. "item N" in spec.md means PRD item N, not GitHub issue N.
- Builds on #1, #3, #5 and #7 (all merged to main).
- Spec: docs/issues/10/spec.md (45 acceptance criteria).
- UI impact: none in this issue (protocol, server, core client). Designer phase skipped (Q1.4, accepted by the user at Gate 1).
- GitHub #9 (client forgetAllGroups clock skew) is parked and out of scope.

## Gate 1 decisions (user)
- Every open question accepted with its recommended default as written in spec.md:
  Q1.1-Q1.4, Q2.1-Q2.3, Q3.1-Q3.3, Q4.1-Q4.2, Q5.1-Q5.6, Q6.1-Q6.3.
- Recorded in spec.md ("Gate 1 decisions (all questions closed)").

## Architecture
- Plan: docs/issues/10/architecture.md (21 implementation chunks, Security-sensitive: yes).
- Next: security plan review (mode plan), then Gate 2.

## Security plan review
- Round 1: FAIL (docs/issues/10/security.md). High 1, medium 3, low 7.
- H1: door-code limits are per group only; guessing spread across groups is silent
  (10-min failure decay) and capped only by the 600/min app budget (~0.86 break-ins
  per app per day). Required: R1a (count failures since last door change),
  R1b (fixed per-app wrong-door budget, recommended 30/min), R1c (corrected odds).
- Required controls R1a-R16 mapped to planned commits (security.md section 5).
- Plan revision 1 (architect): every required control R1a-R16 added to architecture.md and
  mapped to the 21 planned commits (architecture.md section 8.4). R1a in DoorGuard, R1b as
  DOOR_FAILURES_PER_APP_PER_MINUTE (planned 30) checked before the compare, R1c corrected odds
  in section 8.1 plus spec/README corrections listed in section 8.6 (commit 21). Advisories
  M2 (follow-up issue), M3, L4, L5, L6 recorded in section 8.5.
- Round 2: PASS (security.md "Round 2"). H1 and M1 closed in plan; all R1a-R16 mapped.
  New low notes for the engineer: N1 (blob from a direct server reply is always stored;
  highest-generation rule only for merging stored copies, commit 17), N2 (R1b peek/compare/
  record synchronous, before any await such as setCodes), N3 accepted.

## Gate 2 decisions (user; plan approved)
Recorded in architecture.md section 12 (plan revision 2).
- Q-A: keep createGroup(metadata, initialPosition?, options?) with options.joinMethods (no breaking change; D10).
- Q-B (changed from the recommendation): separate QR ticket generation (D12). Bumped only by
  create, leader codes.rotate and a new full code set on recreation; automatic door-code
  rotation bumps the code generation only, so QR tickets survive it. ticketGeneration is set
  to the new code generation (R3 inherited, no revival after restart without a usable blob);
  invariants ticketGeneration <= generation, both monotonic; blob carries t (t <= n); R2
  compares the code generation only. Spec AC25/AC29/AC30/AC32/AC33 and decision 6 wording
  updated by the engineer in commit 21 (exact text in architecture.md 8.6).
- Q-C: pending joiners get GROUP_ENDED on group end or drop, no groupId, no details (D9, R13).
- Q-D: QR refresh is app-driven (issueQrTicket() + README recipe, no client timer; D7).
- Q-E: DOOR_FAILURES_PER_APP_PER_MINUTE = 60 (~0.086 expected break-ins per app per day under
  a nonstop attack; 8.1, 8.6).
- Security notes folded in: N1 (direct server blob always stored; highest generation only when
  merging stored copies; commit 17), N2 (R1b check/compare/record synchronous before any await;
  commit 9). N3 accepted.
- Next: security re-check of the Q-B change (D12, 4.7, 4.8, 7.3, 8.6) if the orchestrator
  runs it, then implementation (engineer, 21 commits).

## Security plan review round 3 (targeted, head d5fb2e2)
- PASS (security.md "Round 3"). D12 separate ticket generation keeps R3 (no ticket
  revival after restart), key/purpose separation, and the M1/R2 residual; Q-E = 60 odds
  (~0.086/day per app, ~0.087 with C) and the reworded ACs in architecture 8.6 are consistent.
- No new required control. Low notes: N4 (AC33 "higher" ticket generation), N5 (section 10
  table rows R2+N1 / Q-B misaligned), N6 (code-mode checks on generation assignment).

## Implementation (engineer)
- All 21 planned commits are on the branch, in order, plus two small hygiene
  commits (see deviations). PR #11 marked ready for review.
- Checks: pnpm lint, typecheck, test (protocol 70, server 819, client 537),
  build and `pnpm audit --audit-level=high` all exit 0. No dependency changes.
- Required controls R1a-R16 implemented with tests; N1, N2 folded in; N4 (AC33
  "higher" ticket generation) and N5 (section 10 table rows) applied in
  commit 21. N6: only `issueCodeSet` and `rotateDoorCode` build a new
  generation (recreation with a verified blob copies the blob's values);
  every payload re-signs the blob from the record's current codes (current
  `t`); `qr.issue` reads `ticketGeneration` under the group lock.
- Advisories M3, L4, L6 documented in the README; M2 documented with a
  pointer to issue #12 (not implemented).

## QA validation (round 1, head 30e93df)
- Verdict: PASS (review comment on PR #11).
- Checks: install --frozen-lockfile, lint, typecheck, test (protocol 70,
  server 819, client 537), build and `pnpm audit --audit-level=high` all
  exit 0; CI `check` 2/2 pass; no dependency changes.
- Acceptance criteria: 45/45 met. Join by group ID is gone from protocol,
  server, client and both READMEs (BREAKING CHANGE footer on d9c5e28).
- Deviations: all accepted. Notes: commits 9926c9c and da0ba5d were not
  lint/typecheck-green alone (fixed by 1c50739, c4475fc; c4475fc would
  better be `test(server)`); history is not rewritten.
- Observation: the PR body doesn't mention the breaking removal of
  `group.join` / `joinGroup()`.

## QA validation (round 2, head 99d315f)
- Verdict: PASS (review comment on PR #11).
- Checks: install --frozen-lockfile, lint, typecheck, test (protocol 81,
  server 820, client 537), build and `pnpm audit` all exit 0; CI `check`
  2/2 pass; no dependency changes.
- Delta 0175ba4..99d315f verified: A1 (redaction test), A2 (shared
  `normalizeDisplayName` rejects the listed invisible/blank characters,
  test literals checked by code point), A3 (architecture wording).
- Acceptance criteria: 45/45 met. Client and server still share the one
  display-name rule from `@sync-system/protocol`.
- Note (non-blocking): the A1 test's `message` subcase is covered by the
  top-level `message` redact path, not `*.displayName`; the `frame` and
  `request` subcases cover the wildcard path.
- Round 1 PR-body observation resolved (BREAKING CHANGE note added).

## QA validation (round 3, head 81726e5)
- Verdict: FAIL (review comment on PR #11).
- Checks: install --frozen-lockfile, lint, typecheck, test (protocol 137,
  server 896, client 538), build and `pnpm audit` all exit 0; CI `check`
  2/2 pass.
- Acceptance criteria: 44/45 met; AC20 not met (finding 1).
- Finding 1 (B2 class): `EMOJI_SEQUENCE_PARTS` in
  `packages/protocol/src/join.ts` accepts any run of tag characters plus
  U+E007F after any Extended_Pictographic, so a name can carry invisible
  ASCII ("Bob" + U+1F3F4 + tags("ignore all") + U+E007F is accepted).
  Expected: only RGI tag sequences (U+1F3F4 + gbeng/gbsct/gbwls + U+E007F),
  or at minimum U+1F3F4 + 2 letter tags + 1-3 letter/digit tags + U+E007F.
- Finding 2 (B1 class): the pino message key `msg` is not redacted
  (`message` is); `{ msg: x }` is logged, and with a message string it
  produces a duplicate `msg` key. Expected: treat `msg` like `message`.
- Advisories for Gate 3: ZWNJ/ZWJ between letters (Persian, Indic) now
  rejected, a regression from round 2, so the user decides; `code` key
  and Unicode-data trade-offs accepted; logger walks each record twice
  (5.2 vs 1.5 us small record), acceptable.

## Open questions
- none (M2 is tracked as issue #12).

## Deviations from plan
- Extra commits: `style(server): use a type import for the mocked crypto
  module` (1c50739) and `fix(server): type the join attempt helper in the
  brute-force tests` (c4475fc) fix lint/typecheck slips in commits 3 and 8
  (pushed commits are never amended).
- `JoinService` was created in commit 5 (with the create/release hooks)
  instead of commit 6, so codes had one owner from the start.
- `defaultAppMethods` lives in `joins/join-methods.ts` and is used by
  `config/apps-config.ts` (planned in both places).
- QR tickets: the schema caps raw `ticket` input at 512 characters
  (`MAX_QR_TICKET_INPUT_LENGTH`), so a malformed or over-256 ticket gets
  `QR_INVALID` as AC25 and the section 10 test row require, instead of
  `INVALID_MESSAGE` (architecture 4.3 step 5 wording).
- `CreatedGroup.joinMethods` / `codes` landed in commit 14 (not 16), so the
  client tests could join by code when `joinGroup` was retired; the leader
  API and `createGroup` options landed in 16 as planned.
- Server test helpers: `createGroupWithMembers` returns `codes` and `join`
  fields; new `codesOf`, `joinByCode` helpers and a `ScriptedRandom` code
  source (`codeRandom` server option) for collision tests.
- Client local guard for a pending approval: when the server's deadline plus
  `requestTimeoutMs` passes, the join rejects with REQUEST_TIMEOUT and the
  connection is dropped (as other request timeouts do), so the server
  withdraws the request.
- Fix round (Gate 3 findings): the user asked to fix the three low
  security findings A1-A3 from code review round 1 before merging.
  - A1 (5e76b9f): `displayName` and `*.displayName` were already in
    `REDACT_PATHS` (since 29d3bf4, #5), at the same depth as the join
    code fields, so no logger change was needed. Committed as
    `test(server)` instead of the requested `fix(server)`: a new test
    logs join message shapes carrying a display name (spread, nested,
    request entry) and proves the name is removed (verified to fail
    without the paths).
  - A2 (eab3a13): the shared `normalizeDisplayName` also rejects U+00AD,
    U+115F, U+180E, U+2060-U+2064, U+3164 and U+FFA0; names made only of
    whitespace and such characters are rejected. Tests per character.
  - A3 (18dd4f6): architecture.md N4 AC33 text says "higher" ticket
    generation, matching spec AC33.
  - Checks: lint, typecheck, test (protocol 81, server 820, client 537),
    build and `pnpm audit --audit-level=high` all exit 0.
- Fix round 2 (Gate 3 B1/B2): the user asked to fix the two low findings
  from security code review round 2 completely, by problem class rather
  than by listed instance.
  - B1 (a11333e, `fix(server)`): pino path redaction is gone. The logger
    walks every logged object (log fields via a `logMethod` hook, mixins
    via `formatters.log`, child and grandchild bindings via a wrapped
    `child`) and removes sensitive keys at any depth, including arrays,
    arrays of objects, class instances and `toJSON` results; cycles become
    `[Circular]`, depth is capped at 32. Keys are matched after
    normalization (lowercase, a-z0-9 only) against an exact set
    (`position`, `metadata`, `payload`, `body`, `ip`, `remoteAddress`,
    `address`, `x-forwarded-for`, `headers`, `req`, `url`, `query`,
    `reason`, `message`, `codes`, `reqId`, `appVersion`, ...) and
    fragments (`apikey`, `token`, `secret`, `password`, `credential`,
    `signature`, `authorization`, `cookie`, `groupid`, `participantid`,
    `blocklist`, `displayname`, `joincode`, `doorcode`, `groupcode`,
    `alphacode`, `blob`, `ticket`, `requestid`), so plurals and prefixed
    forms are covered. `REDACT_PATHS` is replaced by `SENSITIVE_LOG_KEYS`,
    `SENSITIVE_LOG_KEY_PARTS` and `isSensitiveLogKey`. Errors anywhere
    become `safeErr` (pino would otherwise copy `err.message` into `msg`),
    and arguments after the message are dropped (no `%s` interpolation).
    Tests (apps/sync-server/test/logger-redaction.test.ts): 31 keys x 10
    shapes (top level, 1/3/6 levels deep, array of objects,
    `{pending:[...]}`, `{requests:[{entry}]}`, nested arrays, mixed arrays)
    plus object/array values, spellings, credential fragments, allowed
    fields kept, cycles, class instances, toJSON, errors, interpolation,
    child bindings, no mutation. 70 of the 72 failed with the old config.
    join-privacy.int.test.ts: join keys at any depth; the static `reason`
    check now covers every log call in `src` (keys and shorthand only) and
    a new static check forbids template-literal log messages.
  - B2 (0f79ad0, `fix(protocol)`): the shared `normalizeDisplayName`
    rejects by property: `Cc`, `Cf`, `Cs`, `Co`, `Cn`, `Zl`, `Zp`,
    `Default_Ignorable_Code_Point`, `Bidi_Control`, plus the blank-looking
    U+2800, U+115F, U+1160, U+3164, U+FFA0, U+1D159. ZWJ, U+FE0E/U+FE0F and
    tags U+E0020-U+E007F are allowed only inside emoji sequences (tags after
    a pictographic emoji and ending with U+E007F; selectors after an emoji;
    ZWJ between emoji). Every name needs a visible `L`/`N`/`S`/`P`
    character. Trim and length rules unchanged. `FORBIDDEN_NAME_CHARACTERS`
    and `LONE_SURROGATE` removed (superseded by the property class, `Cs`).
    Tests (packages/protocol/test/display-name.test.ts): every code point
    U+0000-U+10FFFF (lone surrogates included) checked alone, embedded and
    doubled against an independent property oracle; every allowed code
    point accepted between letters; every code point alone accepted exactly
    when visible and allowed; 20,000 seeded random names from the
    non-visible pool rejected; the B2 list; emoji-part misuse; positive
    names in Latin, accented, Hebrew (with niqqud), Arabic, CJK, Japanese,
    Korean, Devanagari, Cyrillic, Greek, Thai and emoji (ZWJ family, flag,
    skin tone, keycaps, England/Scotland tag flags, rainbow/transgender
    flags). Runtime about 3 s.
  - Same class, also fixed:
    - Leader client (bd5c0af, `fix(client)`): the `join.requested` name was
      handed to the app unchecked. It now passes the same rule and is
      dropped if it fails (other Unicode data on the client, misbehaving
      server); the request stays. README updated (ff1c075 keeps the
      drift-guard sentence on one line).
    - Server end to end (4599fd0, `test(server)`): the B2 characters are
      rejected with INVALID_MESSAGE on `group.joinByCode`.
    - Logs: error messages, `%s` interpolation, child bindings and
      template-literal messages (above), and keys not covered before:
      `groupId`, `reqId`, `appVersion`, `payload`, `url`, `query`,
      `address`, credential fragments; `reason`/`message`/`headers`/`req`
      now at any depth.
  - Checked, no change needed: display name is the only free text in #10
    that reaches the leader (codes and request IDs are pattern-checked;
    error texts are fixed); the client logger only accepts flat primitive
    fields and logs fixed events; server log call sites pass only
    allowlisted scalars.
  - Residual (documented, not fixed): a join code logged under the key
    `code` cannot be redacted by name (`code` is the error-code field, D5);
    `\p{Cn}` and emoji properties follow the engine's Unicode data, so a
    client with older data may reject a new emoji the server accepts (the
    leader client then drops the name); ZWNJ (U+200C) is rejected, so
    Persian names must use a space instead.
  - Checks: lint, typecheck, test (protocol 137, server 896, client 538),
    build and `pnpm audit --audit-level=high` all exit 0. No dependency
    changes.
- Deviation (fix round 2): ZWJ is allowed only between emoji, not between
  letters, so Indic conjuncts written with an explicit ZWJ are rejected
  (the user's rule: emoji sequences only).
