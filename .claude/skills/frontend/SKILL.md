---
name: frontend
description: 'Frontend engineering guidance for React + TypeScript apps (web or React Native): choosing the stack when it is not decided yet, project structure, components and state, data fetching, realtime clients (reconnect, resync), rendering data-driven/JSON content safely, accessibility in code, performance, and frontend testing. Use when planning, implementing, or reviewing any client-side change.'
---

# Frontend

Project decisions in `docs/conventions.md` and `docs/decisions/` override
everything here. If the project hasn't decided something this skill needs,
don't pick silently. The architect proposes it as an ADR (`docs-conventions`).

## Choosing the stack (architect, only when undecided)
Compare options against the project's real needs and write an ADR:
| Need | Points toward |
|---|---|
| Pure client app, served as static files, simple Docker image | React + Vite (SPA) |
| SEO, server rendering, server-side routes in the same app | Next.js |
| Native mobile | React Native (Expo) |
| Styling: fastest consistent results with tokens | Tailwind (tokens in config) |
| Styling: plain CSS, strong isolation, no build-time utility layer | CSS Modules + CSS variables |
Also weigh: what the user already knows, deployment shape (static vs Node
server), bundle size, and testing support. Recommend one; list the runner-up.

## Structure
- Feature folders (`features/<feature>/` with components, hooks, api, types)
  over type folders; shared UI in `components/ui/`.
- Components: small, typed props, no business logic in presentational components;
  move side effects into hooks.
- One source of truth per piece of state: server/remote state in a query/sync
  layer, UI state local, global client state only when really shared.

## Data-driven content (e.g. pages defined in JSON)
- Define a **schema** for the content (e.g. zod) and validate at load time;
  show a clear error for invalid content instead of crashing.
- Render content as data, never as HTML: no `dangerouslySetInnerHTML` on
  content unless it's sanitized and the ADR allows it.
- Keep a stable ID per page/item so sync and deep links don't depend on array
  positions.

## Realtime clients
- One connection manager (hook or service) owns the socket/stream: connect,
  authenticate/join, exponential backoff with jitter on reconnect, heartbeat
  or timeout detection, clean teardown on unmount/leave.
- Expose connection state to the UI (`connecting | live | reconnecting | offline`).
- After reconnecting, **resync from the server's current state**; don't replay
  stale local events. Treat server state as authoritative for shared position.
- Validate every incoming message against a typed schema; ignore unknown
  message types (forward compatibility).
- Debounce/throttle high-frequency outgoing events (e.g. scroll position).

## Accessibility in code
Semantic elements first (`button`, `nav`, `main`, headings in order); ARIA only
to fill gaps; manage focus on route/modal changes; live regions for
realtime announcements; test with keyboard only.

## Performance
Code-split by route; lazy-load heavy content; memoize only where profiling
shows a need; avoid re-rendering the whole page on every sync tick (select
narrow slices of state).

## Testing (only if the repo has tests)
- Unit: pure logic (parsers, reducers, schema validation).
- Component: React Testing Library, user-facing queries (`getByRole`).
- Realtime: test the connection manager against a fake server/stream; cover
  reconnect and resync.

## Review checklist
Typed props and messages; schema validation at boundaries; every UI state from
design.md implemented; connection state visible; no secrets in client code
(everything in the bundle is public); keyboard and screen-reader basics work.
