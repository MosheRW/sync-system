# Spec: #12 fix(server): limit group creation and live groups per app (follow-up to #10)

Issue: https://github.com/MosheRW/sync-system/issues/12 (path: fast; source: security advisory M2 in `docs/issues/10/security.md`)

## Problem
Nothing limits `group.create`. A client can script group creation and disconnect; each group stays in memory until the inactivity limit (20 min default). At ~100 creates/s it holds ~10 % of an app's 10^6 six-digit group codes. A joiner who mistypes a method B code can land in the attacker's group and hand over their display name, and at high fill `CODES_EXHAUSTED` denies legitimate creation.

## Acceptance criteria
- [ ] A `group.create` exceeding the per-connection rate is refused with `RATE_LIMITED` (including `retryAfterMs`) before any group code is drawn.
- [ ] A `group.create` exceeding the per-app rate is refused with `RATE_LIMITED` (including `retryAfterMs`) before any group code is drawn.
- [ ] Creating a group when the app is at its live-group cap is refused with an error the client can distinguish from `RATE_LIMITED`, and no code is drawn.
- [ ] Limits and caps are isolated per app: one app hitting its limits does not affect group creation in another app.
- [ ] Refusals do not log group codes.
- [ ] The limits and their values are documented in the README.
- [ ] Tests cover each refusal path and app isolation.
- [ ] lint, typecheck, test and build pass; no new dependencies.

## Out of scope
- Memory pressure from many groups in general (pre-existing #1 concern) beyond the live-group cap.
- Changes to door codes (A), alphanumeric codes (C) or QR tickets (D).
- Pause abuse / `codes.rotate` (advisory M3).

## Open questions (decided at Gate 2)
The architect proposes; the user decides.
- Limit values: per-connection create rate, per-app create rate, live-group cap per app.
- Fixed constants, env-configurable ceilings, or configurable per app?
- Error code name for the live-group cap (e.g. `GROUP_LIMIT_REACHED`).
