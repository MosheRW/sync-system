# State: #92 fix(release): release:dry-run cannot run for an already-published version
- Path: fast
- Phase: ready-to-merge
- Branch: fix/92-dry-run-published-version
- PR: #95
- Plan approved by user: yes (Gate 2, 2026-11-26)
- Security-sensitive: yes
- Review rounds: 1
- Last updated by: orchestrator
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (rule/Implementer model) → DONE
- qa review r1: sonnet (NEXT_MODEL) → PASS
- security code r1: opus (rule) → PASS (0 findings)
## Gate 2 decisions
- Plan approved.
- L4 in scope: the registry lookup refuses to run (fixed message) when
  `NODE_TLS_REJECT_UNAUTHORIZED=0` is set; covered by a test.
- N1 (reader release R2 wording) out of scope, tracked as #100. RELEASING.md
  R2, step 6 and docs/roadmap.md untouched.
## QA verdict
- Round 1: PASS (checks green; AC 4/4 met; manual dry-run against published v1.0.0 passed; release-files L11 failure is pre-existing on origin/main)
## Open questions
- none
## Deviations from plan
- `lookupPublished` takes a 4th parameter `env` (default `process.env`) for
  the L4 check, so tests never set the real env.
- `RegistryLookupError` class: `main()` prints only these (sanitized)
  errors as `release:dry-run: ...`; other errors (npm child) propagate as
  before.
- `dryRunPackages` deps also take `log`, so tests can see the
  "integrity matches" lines.
- `main()` checks that the packed package.json version equals the source
  version used for the file name and the lookup (C3, one version string).
- Pre-existing, unrelated failure: `apps/sync-server/test/release-files.test.ts`
  "keeps bundles and outputs outside the repo ... (L11, #81)" fails on
  origin/main too (RELEASING.md line 676, reader release section, not
  touched here).
