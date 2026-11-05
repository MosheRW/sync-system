# Spec: #15 feat: React/Next package (PRD item 6)

Issue: https://github.com/MosheRW/sync-system/issues/15

Source PRD: `docs/PRD Group Reading Sync.md` (Deliverables item 3: "React/Next package: hooks and components on top of the core, safe during server-side rendering"; Joining, Roles, Leader view, Timers, Group lifecycle, Identity/tokens/recovery, Version checks)
Path: full | Type: feat | PRD item 6 of 9
Numbering: "item N" means PRD item N of 9, not the GitHub issue number. Done: item 1 (#1), item 2 (#3), item 3 (#5, #7), item 4 (#10), item 5 (#13).
Builds on: `@sync-system/client` (core), `@sync-system/protocol`.

## Problem / motivation

The core client is framework-free. The reading app (items 7-8) must integrate only through packages, and React/Next developers currently have to hand-write the subscription, lifecycle and SSR plumbing around `SyncClient`. Earlier issues left explicit notes for this layer:

- Snapshot store: the core exposes an immutable `getSnapshot()` that keeps identity until something changes, plus `subscribe()` (#3 architecture, decision 2). That is the `useSyncExternalStore` contract.
- SSR: never create a client at module scope on the server, never `connect()` during SSR; `getServerSnapshot` returns a constant idle snapshot (#3 architecture and security).
- Fatal errors: "if closed, connect" loops must not hammer the server after fatal errors (#3 security). Hooks keep one client per mount and never call `close()`/`connect()` per render (StrictMode double mount, unstable deps; #3 security R2-L6).
- QR re-issue: the core only exposes `issueQrTicket()`; the recipe (re-issue at about 80 % of `expiresInMs`, and after `codesChanged` with reason `rotated` or `resumed`) is app-driven and may be wrapped in a hook (#10 D7).
- #10 spec: hooks and components for join flows, approval prompts and code display.
- #13: leader API, roster, keep-alive, lifecycle events, preview helper (snapshot `preview`), removal (close 4004 terminal), lock.

This issue adds the React/Next package that wraps the core.

## User stories

- As a **React developer**, I want one provider and typed hooks over the sync client, so that components re-render only when the state they use changes.
- As a **Next.js developer**, I want the package to render on the server without touching `window` or opening sockets, so that SSR and hydration work.
- As a **React developer**, I want hooks for creating and joining groups (by code, QR ticket, approval; join by group ID was removed in #10) and for resuming stored groups, so that join flows are a few lines.
- As a **leader-screen developer**, I want hooks for codes and QR (with automatic re-issue), pending join requests (approve/deny), roster, vice, lock, remove, and keep-alive prompts, so that I can build the leader view without wiring events by hand.
- As a **member-screen developer**, I want hooks for the connection indicator, current position, leader status, take-back availability, "you're now leading" and removal, so that follower UX is simple.
- As a **reading-app developer (items 7, 8)**, I want hooks for the leader's preview mode and for version/upgrade errors, so that the app can show "update required" and preview banners.
- As a **maintainer**, I want the package tested under React StrictMode and in a server render, so that SSR and double-mount regressions are caught.

## Acceptance criteria

Package and build
- [ ] AC1. A new workspace package (`@sync-system/react`, Q1) exists under `packages/`, covered by the root `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm lint`; it depends on `@sync-system/client` and lists `react` as a peer dependency (`^18.3 || ^19`, Q2; tests on 19).
- [ ] AC2. The package imports no server-only module and re-exports the core types its hooks return, so apps need not import the core directly for typing.
- [ ] AC3. The package ships ESM with types; the Next `"use client"` directive is present on the client modules so it can be imported from Next server and client components (App Router first, Pages Router documented as plain client code, no `next` dependency, Q3).

Provider and client lifecycle
- [ ] AC4. A provider takes either `options` (creates and owns a client) or an existing `client` (does not own it, never closes it).
- [ ] AC5. An owned client is created in the browser only, never at module scope and never during server render; the provider connects it in an effect after mount (`autoConnect`, default on; `autoConnect={false}` opts out, Q8).
- [ ] AC6. One client per provider mount: re-renders, changed option object identity and StrictMode double mount cause no extra live socket and no `close()`/`connect()` per render; the owned client is closed on real unmount (a StrictMode simulated unmount leaves neither a dead client nor a second live one).
- [ ] AC7. Nothing in the package calls `connect()` automatically from a `closed` state after a fatal close reason (auth, protocol too old, app version too old, removed, config invalid), and nothing does so in a render-driven loop; reconnecting stays the core's job. A manual connect/retry action is exposed for the app.
- [ ] AC8. Using a hook outside the provider throws a clear error naming the provider.

SSR and snapshot store
- [ ] AC9. State hooks use `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`; `getServerSnapshot` returns one constant idle snapshot (same object on every call) on the server and during hydration.
- [ ] AC10. Rendering the provider and all hooks with `react-dom/server` in a Node test environment with no `window` creates no client, opens no socket, throws nothing, and hydrates without mismatch.
- [ ] AC11. A selector hook (for example `useSyncSelector(selector, isEqual?)`) re-renders only when the selected value changes; unchanged selections keep identity; unrelated snapshot changes do not re-render.
- [ ] AC12. Importing the package in Node (no DOM) has no side effects at import time.

Connection and versions
- [ ] AC13. A hook exposes the connection state, the sync indicator (via the core `indicatorOf`), the last error, and a manual retry action.
- [ ] AC14. Hooks surface `PROTOCOL_TOO_OLD`, `APP_VERSION_TOO_OLD` and unsupported-server errors as a typed, discriminated "update required" state (with `minAppVersion` / `minProtocolVersion` when present); server-provided text is never rendered as HTML by the package.

Joining and recovery
- [ ] AC15. Action hooks create a group and join by join code, by QR ticket and by approval flow (there is no join by group ID: removed in #10, BREAKING; the package exposes none); each exposes pending and error state (typed `SyncClientError`) and causes no unhandled promise rejection.
- [ ] AC16. A hook reports stored groups' status (live, resumable, gone) via the core status API, and an action resumes one; it does nothing on the server.
- [ ] AC17. The approval-flow hook exposes the states waiting-for-approval, paused, approved, denied/withdrawn, and a cancel action.

Leader and member
- [ ] AC18. A leader hook exposes join codes (current, rotation, expiry), a rotate action, an enable/disable join methods action, and the QR ticket with automatic re-issue at about 80 % of `expiresInMs` while the consumer is mounted and immediately after `codesChanged` with reason `rotated` or `resumed`; timers are cleared on unmount and never double-run under StrictMode.
- [ ] AC19. A hook exposes pending join requests with approve and deny actions, updated on `joinRequested`, `joinWithdrawn`, `joinPaused`, `joinResumed`.
- [ ] AC20. Hooks expose the roster, vice-leader state with a set-vice action, lock/unlock, remove-member and block-list actions; leader-only actions fail with the core's typed error for members.
- [ ] AC21. A keep-alive hook exposes the prompt state and `answerKeepAlive()`; hooks expose "now leading", leadership lost/changed, and `takeBackAvailable` with a `takeBackLeadership()` action.
- [ ] AC22. A removal hook exposes the terminal "removed" (close 4004) state; neither the provider nor any hook reconnects or rejoins after it.
- [ ] AC23. A position hook returns the current group position and an `updatePosition` action for the leader; group-ended state exposes the end reason, including a group ended because it emptied (#13 D15: an empty group is held for the grace period, then ends) and removal. A stored group that has ended reports `gone` in AC16; the package never tries to recreate or rejoin it.
- [ ] AC24. A preview hook wraps the core `client.preview` (`start`, `move`, `end`, `bringGroupHere`, `returnToGroup`) and exposes `{active, groupPosition, previewPosition}`.
- [ ] AC25. Event-style hooks (for example `useSyncEvent(name, handler)`) subscribe in an effect, always call the latest handler without resubscribing, and unsubscribe on unmount.

Quality and docs
- [ ] AC26. Tests (Vitest, jsdom, `@testing-library/react`, plus a node-environment SSR test, Q7) cover AC5-AC12 and AC18-AC22 with a fake client, plus at least one integration test against the in-process sync server used by the core tests (create, join by code, position update, leader change).
- [ ] AC27. The package logs no `groupId`, token, code or participant ID and puts none in URLs; docs state that `groupId` is a credential (#3 notes).
- [ ] AC28. The package README documents install, provider setup for Next (App and Pages routers), SSR rules, every hook, and the no-auto-retry-after-fatal-error rule.
- [ ] AC29. `pnpm audit --audit-level=high` shows no new high findings from added dependencies.

## Out of scope

- Reading-app UI (items 7, 8): code entry screens, QR image rendering, camera scanning, approval prompt screens, roster/counter/list views, preview banner visuals, keep-alive and "you're now leading" screens, connection indicator visuals, RTL, content, fingerprint (except the unstyled render-prop helpers in Q4).
- Changes to the core client or server protocol (bugs found there become separate issues).
- React Native, Preact, Vue/Svelte/Solid bindings.
- Server-side session handling in Next (middleware, cookies, route handlers); the server never connects during SSR.
- Publishing, hosted-offering features, Redis, i18n of messages.

## Gate 1 decisions (user, 2026-11-05)

All ten recommendations accepted as written. No open questions remain.

1. Q1: package name `@sync-system/react`.
2. Q2: peer `react ^18.3 || ^19`; tests run on React 19.
3. Q3: App Router first via `"use client"`; Pages Router documented; no `next` dependency.
4. Q4: headless hooks, provider and a few unstyled render-prop helpers (QR auto-refresh wrapper, connection indicator); no styled UI.
5. Q5: designer phase skipped (no visual UI).
6. Q6: in-house selector hook on `useSyncExternalStore`, no extra dependency.
7. Q7: Vitest + jsdom + `@testing-library/react` devDependencies approved, plus a node-environment SSR test.
8. Q8: auto-connect after mount; `autoConnect={false}` to defer.
9. Q9: hooks for all leader actions in AC20 here; screens in item 8.
10. Q10: `private: true`, workspace-only until the release item.

Spec corrections made with the decisions: join by group ID removed from the user story and AC15 (removed in #10, BREAKING); AC23 and AC16 now cover the empty-group end (#13 D15) and `gone` status; close 4004 removal (AC22) checked and unchanged. AC placeholders resolved to concrete values.

## Open questions

None.
