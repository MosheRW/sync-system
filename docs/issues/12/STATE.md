# State: #12 fix(server): limit group creation and live groups per app (follow-up to #10)
- Path: fast
- Phase: architecture
- Branch: fix/12-limit-group-creation
- PR: #46
- Plan approved by user: yes (conditional: on architecture.md Revision 2 and a passing security delta check; no further Gate 2 stop)
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Gate 2 decisions (user, 2026-11-22)
- Q-1: option A (global per-app token bucket checked with the cap, derived sustained rate).
- Q-2: env variables with the constants as defaults (overrides the fixed-constants recommendation): `MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE` (6), `MAX_GROUP_CREATE_BURST_PER_APP` (120), `MAX_GROUP_CREATES_PER_APP_PER_MINUTE` (120, upper bound of the derived rate), `MAX_LIVE_GROUPS_PER_APP` (10 000); cross rule cap > 2 x burst. Names carry the `MAX_` prefix (ADR 0015 family) instead of the suggested `GROUP_` prefix; see architecture.md Q-2.1.
- Q-3: `APP_GROUP_LIMIT`, `details.maxLiveGroups` = the configured value.
- Q-4: as recommended (counted, never refused, not charged).
- Q-5: as recommended (throttled warn, namespace only).
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (default) → DONE
- security plan: opus (rule) → FAIL (H1: one instance can fill the live-group cap via leader-return keep-alive; see security.md)
- architect plan revision 1: opus (rule: revision after a failed review) → DONE (H1: global per-app token bucket with rate derived from maxSessionMinutes; M2, L1, L2, L4 folded in)
- security plan round 2: opus (rule) → PASS (H1, M3 closed; new advisories M4 app-wide flood DoS while it runs, L6-L9; required controls R1-R14 in security.md R2.4)
- architect plan amendment (revision 2): opus (rule: plan revision touching config/security) → DONE (Gate 2 decisions recorded; four MAX_ env variables with startup validation; R13/R14 adopted; new config chunk, 6 chunks)
- security plan round 3 (delta, env config): opus (rule) → PASS (H1 bound holds for every valid config; transition bound < cap confirmed; advisories L10 cap mismatch across instances, L11 large burst vs reset margin, L12 tiny refill formatting; R15 added)
## Open questions
- Resolved at Gate 2 (2026-11-22): Q-1 to Q-5, see "Gate 2 decisions" above.
- Resolved: security.md R2.4 controls folded into the plan; M4 wording corrected in Q-1 and section 8 (R12).
- Resolved: security delta check of Revision 2 (round 3) PASS; new advisories L10-L12 and control R15 in security.md R3.5.
- To confirm (non-blocking): variable names use the `MAX_` prefix rather than `GROUP_` so ADR 0015's typo check covers them; keeping `GROUP_` would need an ADR 0015 amendment.
## Deviations from plan
- none
