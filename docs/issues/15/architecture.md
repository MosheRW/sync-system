# Architecture: #15 React/Next package `@sync-system/react` (PRD item 6)

Spec: [`spec.md`](spec.md) (29 ACs, Gate 1 decisions Q1-Q10, all as recommended).
Design: none (Q5, no visual UI).

## 1. Repo layout

- Layout: **monorepo** (pnpm workspace `apps/*`, `packages/*`; no submodules,
  `git submodule status` is empty; no turbo/nx). One issue, one branch, one PR.
- Touched:
  | Path | Package | Change | Checks |
  |---|---|---|---|
  | `packages/react` | `@sync-system/react` (new) | all product code and tests | `pnpm --filter @sync-system/react typecheck test build` |
  | `packages/client` | `@sync-system/client` | README only (SSR section points to the React package). **No code change** (spec: core changes out of scope) | unchanged |
  | root | `eslint.config.js`, `README.md`, `pnpm-lock.yaml` | lint globs for `.tsx`, React package lint block, workspace table, lockfile | `pnpm lint`, `pnpm audit --audit-level=high` |
- `apps/sync-server` is a devDependency only (integration test, same as the core tests). No server change.
- No other repo is affected. Docker impact: **none** (library package, not in any image).

## 2. Decisions

**Decisions: none open.** Q1-Q10 were decided at Gate 1; no ADR is needed
(`docs/decisions/` stays absent). The design choices below (D1-D12) are
implementation decisions inside those answers. Four spec interpretations need
a confirmation at Gate 2 (section 13, Q-A to Q-D), each with a recommendation
the plan already assumes.

| # | Decision | Why |
|---|---|---|
| D1 | The owned client is created **in the provider's effect**, never during render (server or browser). The first browser render (and hydration) runs on a constant empty store. | AC5 trivially holds; discarded concurrent renders never create a client; hydration matches the server by construction (AC9, AC10). Cost: one extra render after mount. |
| D2 | One `SyncStore` (package-internal class, no React import) per client: composes the core snapshot with the leader-only and event-derived data the core does not keep in the snapshot (codes, join requests, roster, leader state, keep-alive prompt, vice flag, leadership notices, last error, join flow, preview). All state hooks are selectors over `store.getState()`. | `getRoster()`, `getJoinRequests()`, `getLeaderState()` return a **new frozen array/object on every call** and `client.preview.getState()` has no subscribe: none of them can be a `useSyncExternalStore` `getSnapshot` directly (infinite loop). The store caches them with structural identity keeping. |
| D3 | Deferred close: the provider's cleanup schedules `close()` with `setTimeout(0)`; a re-run of the effect before it fires cancels it. | StrictMode runs mount, cleanup, mount synchronously in one commit: one client, one `connect()`, no `close()` (AC6). A real unmount closes on the next tick. |
| D4 | The **only** automatic `connect()` call site is the provider effect, guarded by `client.getState().status === 'idle'`. | The core never returns to `idle` once `connect()` was called, so no automatic connect can ever run from `closed` (fatal, gave_up, removed, client) (AC7, AC22). |
| D5 | QR re-issue is a ref-counted `QrTicketController` owned by the store, shared by every `useQrTicket` consumer, with a deferred release (as D3). | StrictMode mount/unmount/mount never issues twice; two components showing the QR share one ticket and one 6/min budget (AC18). |
| D6 | Source modules are `.ts` using `createElement` (no JSX in `src`); tests are `.tsx`. | No JSX runtime config in the build; `"use client"` stays the first statement after `tsc`. |
| D7 | In-house selector (`useSyncSelector`) on `useSyncExternalStore`, own implementation of the well-known "with selector" memo (Q6). | No extra dependency. |
| D8 | Actions never reject: every action hook returns `run(...) => Promise<ActionResult<T>>` (`{ ok: true, value } \| { ok: false, error }`) plus `pending`/`error` state. | AC15 "no unhandled promise rejection" holds structurally, not by convention. |
| D9 | Provider prop type `SyncClientLike` (a `Pick` of `SyncClient`'s public surface used by the package) for the `client` mode. | Tests and apps can pass a fake; a real `SyncClient` satisfies it. |
| D10 | Options are read **once**, when the owned client is created; later identity or value changes are ignored. To change URL/key, remount with a React `key`. | AC6: changed option identity must not churn sockets. Documented. |
| D11 | Event-derived state (keep-alive prompt, member vice flag, leadership notices, last error) starts when the store attaches (provider mount); everything the core can report by getter is re-read on attach. | The core has no getter for those; a provider mounted late misses earlier events (Q-C). |
| D12 | No logger, no `console`, no URL building in the package (ESLint enforced). Errors are the core's `SyncClientError` (already scrubbed, #3 L3). | AC27. |

## 3. Approach

A thin headless layer: `SyncProvider` -> `SyncStore` -> hooks. The store is
framework-free (testable without React) and wraps exactly the core's public
API; hooks are small selectors plus action wrappers; two render-prop helpers
(`<QrTicket>`, `<ConnectionIndicator>`) wrap hooks with no markup of their own.

Alternatives rejected:
- *Create the client in `useState(() => new SyncClient(...))` during render*:
  harmless (the constructor has no side effects) but it does run in renders
  that React discards, and it would run on the server unless guarded by a
  `typeof window` check (a global read). D1 is simpler to reason about.
- *One `useSyncExternalStore` per core getter*: impossible for the non-stable
  getters (D2) and would re-subscribe per hook to many events.
- *`use-sync-external-store/with-selector` or zustand*: rejected at Gate 1 (Q6).
- *Close in cleanup immediately and reconnect on remount*: StrictMode would open
  and close a socket every dev mount, and the remount would `connect()` from
  `closed` (R2-L6 delay, AC6 "no dead client").

## 4. Files

### New: `packages/react/`
| File | What |
|---|---|
| `package.json` | `@sync-system/react`, `private: true`, `type: module`, `sideEffects: false`, `exports` like the client (`@sync-system/source` -> `src/index.ts`, `types`, `default` -> `dist`), `files: ["dist"]`, scripts `build`/`typecheck`/`test` like the client. `dependencies`: `@sync-system/client: workspace:*` (only). `peerDependencies`: `react: "^18.3 \|\| ^19"`. `devDependencies`: `react`, `react-dom`, `@types/react`, `@types/react-dom` (19.x), `vitest` (same as client), `jsdom`, `@testing-library/react`, `@testing-library/dom` (its peer), `typescript`, `@types/node`, `@sync-system/server`, `@sync-system/protocol`, `ws`, `@types/ws`. No `next`. |
| `tsconfig.json` | Like client's, plus `jsx: "react-jsx"`, `lib: ["ES2023", "DOM"]` and `types: ["node"]` for tests; includes `src`, `test`, `vitest.config.ts`. |
| `tsconfig.build.json` | Like client's build config: `lib: ["ES2023"]`, `types: []`, `rootDir: src`, `outDir: dist` (no DOM: `window`/`document` use fails the build). |
| `vitest.config.ts` | Client's config (source conditions, `NODE_ENV: test`, setup file), default `environment: 'jsdom'`, `include: ['test/**/*.test.{ts,tsx}']`; node-environment files use `// @vitest-environment node`. |
| `README.md` | AC28, see section 10. |
| `src/index.ts` | `"use client"`. Public exports (section 5) and type re-exports from `@sync-system/client` (AC2): `SyncClient`, `SyncClientOptions`, `SyncClientSnapshot`, `ConnectionState`, `GroupState`, `SyncClientError`, `isSyncClientError`, `ClientErrorCode`, `indicatorOf`, `SyncIndicator`, `JoinCodes`, `QrTicket`, `JoinRequest`, `RosterEntry`, `LeaderState`, `StoredGroupStatus`, `CreatedGroup`, `JoinedGroup`, `ResumedGroup`, `GroupEndedReason`, `LeaderLifecycle`, `KeepAliveEvent`, `SyncClientEvents`, `PreviewState`, `JsonValue`, `JsonObject`, `Role`, `JoinMethod`, all other event/option types the hooks return. |
| `src/host.ts` | Typed `setTimeout`/`clearTimeout`/`now` via `globalThis` (pattern: `packages/client/src/host.ts`), read at call time, never at import. |
| `src/types.ts` | `SyncClientLike`, `ActionResult`, `ActionState`, `UpdateRequired`, `LeadershipChange`, `JoinFlowState`, `QrTicketState`, `StoredGroup`, `SyncState`. |
| `src/server-state.ts` | Frozen module constants `IDLE_SNAPSHOT`, `SERVER_STATE` (pure literals, no side effect) and `EMPTY_STORE` (store over no client). |
| `src/store.ts` | `SyncStore` (section 6). No React import. |
| `src/qr-controller.ts` | `QrTicketController` (section 8). No React import. |
| `src/update-required.ts` | `updateRequiredOf(snapshot, lastError): UpdateRequired \| null` (pure, AC14). |
| `src/context.ts` | `"use client"`. `SyncContext = createContext<SyncStore \| null>(null)`; `useSyncStore(hookName)` throws `Error('<hookName> must be used inside <SyncProvider> (@sync-system/react)')` (AC8). |
| `src/provider.ts` | `"use client"`. `SyncProvider` (section 7). |
| `src/selector.ts` | `"use client"`. `useSyncSelector`, `useSyncSnapshot`, internal `useStoreSelector`. |
| `src/action.ts` | `"use client"`. `useSyncAction` (generic, D8) and `toSyncError`. |
| `src/hooks/connection.ts` | `"use client"`. `useConnection`, `useSyncIndicator`, `useUpdateRequired`, `useSyncClient`. |
| `src/hooks/group.ts` | `"use client"`. `useGroup`, `useGroupEnded`, `usePosition`, `useLeaderStatus`, `useRemoved`, `useGroupExit`. |
| `src/hooks/join.ts` | `"use client"`. `useCreateGroup`, `useJoinByCode`, `useJoinByQr`, `useJoinApproval`. |
| `src/hooks/stored-groups.ts` | `"use client"`. `useStoredGroups`. |
| `src/hooks/leader.ts` | `"use client"`. `useLeaderCodes`, `useQrTicket`, `useJoinRequests`, `useRoster`, `useViceLeader`, `useGroupLock`, `useMemberRemoval`, `useKeepAlive`. |
| `src/hooks/leadership.ts` | `"use client"`. `useLeadership`. |
| `src/hooks/preview.ts` | `"use client"`. `usePreview`. |
| `src/hooks/events.ts` | `"use client"`. `useSyncEvent`. |
| `src/components/qr-ticket.ts` | `"use client"`. `<QrTicket>` render-prop helper. |
| `src/components/connection-indicator.ts` | `"use client"`. `<ConnectionIndicator>` render-prop helper. |
| `test/setup.ts` | Copy of the client's: fails a file on any unhandled rejection / uncaught exception (AC15). |
| `test/helpers/fake-client.ts` | `FakeSyncClient implements SyncClientLike`: settable snapshot, `emit(event, payload)`, controllable promises per method, call counters (`connect`, `close`, `issueQrTicket`, ...), fake `preview`. |
| `test/helpers/fake-websocket.ts` | Minimal counting fake `WebSocket` for owned-mode lifecycle tests with a **real** `SyncClient` (counts constructed/closed sockets). |
| `test/helpers/render.tsx` | `renderWithProvider(ui, { client?, options?, strict = true })` wrapping in `<StrictMode>`. |
| `test/helpers/real-server.ts` | Minimal in-process server start (same imports as `packages/client/test/helpers/real-server.ts`: `createSyncServer`, `AppRegistry`, `parseAppsConfig`, `parseEnv`), `ws` with `maxPayload`. |
| `test/*.test.ts(x)` | Section 11. |

### Modified
| File | Change |
|---|---|
| `eslint.config.js` | Type-checked block `files` globs to `{apps,packages}/*/**/*.{ts,tsx}`. New block for `packages/react/src/**/*.ts`: `no-console: error`; `no-restricted-imports` for `node:*`, `ws`, `next`, `next/*`, `react-dom`, `react-dom/*`, `@sync-system/server`; `no-restricted-globals` for `window`, `document`, `navigator`, `localStorage`, `location`, `console`. |
| `README.md` (root) | Workspace table row for `@sync-system/react` and a link to its README. |
| `packages/client/README.md` | SSR section: replace "item 6" with a link to `@sync-system/react`. |
| `pnpm-lock.yaml` | New devDependencies. |

## 5. Public API

All hooks throw the provider error outside `<SyncProvider>` (AC8). Every
returned object/array keeps its identity while its content is unchanged.
On the server and before the owned client exists, state hooks return the idle
values and actions resolve `{ ok: false, error: SyncClientError('NOT_CONNECTED') }`
without touching anything (AC16 "does nothing on the server").

### 5.1 Shared types (`src/types.ts`)
```ts
/** The client surface the package uses; a SyncClient satisfies it. */
export type SyncClientLike = Pick<SyncClient,
  'connect' | 'close' | 'getState' | 'getSnapshot' | 'subscribe' | 'on' | 'off' |
  'createGroup' | 'joinByCode' | 'joinByQr' | 'cancelJoin' | 'checkTokens' | 'resumeGroup' |
  'endGroup' | 'leaveGroup' | 'updatePosition' | 'getJoinCodes' | 'getJoinRequests' |
  'rotateCodes' | 'issueQrTicket' | 'approveJoin' | 'denyJoin' | 'getRoster' | 'getLeaderState' |
  'setViceLeader' | 'clearViceLeader' | 'lockGroup' | 'unlockGroup' | 'removeMember' |
  'getBlockList' | 'addToBlockList' | 'answerKeepAlive' | 'takeBackLeadership' | 'preview'>;

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SyncClientError };

export interface ActionState<A extends unknown[], T> {
  /** Stable identity. Never rejects; also sets pending/error/value. */
  readonly run: (...args: A) => Promise<ActionResult<T>>;
  readonly pending: boolean;
  readonly error: SyncClientError | null;
  readonly value: T | undefined;
  readonly reset: () => void;
}

export type UpdateRequired =
  | { readonly kind: 'app'; readonly minAppVersion?: string }          // APP_VERSION_TOO_OLD
  | { readonly kind: 'protocol'; readonly minProtocolVersion?: number } // PROTOCOL_TOO_OLD
  | { readonly kind: 'server_unsupported';                               // SERVER_UNSUPPORTED
      readonly serverProtocolVersion: number; readonly serverMinProtocolVersion: number };

export type LeadershipChange =
  | { readonly kind: 'now_leading'; readonly reason: NowLeadingEvent['reason']; readonly at: number }
  | { readonly kind: 'lost'; readonly reason: LeadershipReason; readonly takeBackAvailable: boolean; readonly at: number }
  | { readonly kind: 'changed'; readonly reason: LeadershipReason; readonly at: number };

export type JoinFlowState =
  | { readonly status: 'idle' }
  | { readonly status: 'joining' }
  | { readonly status: 'waiting'; readonly requestId: string; readonly expiresAt: number }
  | { readonly status: 'paused'; readonly retryAt: number | undefined }        // JOIN_PAUSED (Q-B)
  | { readonly status: 'approved' | 'joined'; readonly group: JoinedGroup }   // approved: passed through waiting
  | { readonly status: 'denied' }                                              // JOIN_DENIED
  | { readonly status: 'withdrawn'; readonly reason: 'cancelled' | 'timeout' } // JOIN_CANCELLED / APPROVAL_TIMEOUT
  | { readonly status: 'failed'; readonly error: SyncClientError };

export type QrTicketState =
  | { readonly status: 'idle' }                          // not a connected leader, or not mounted
  | { readonly status: 'loading'; readonly ticket: QrTicket | null }
  | { readonly status: 'ready'; readonly ticket: QrTicket }
  | { readonly status: 'unavailable' }                   // JOIN_METHOD_UNAVAILABLE: group has no method D
  | { readonly status: 'error'; readonly error: SyncClientError; readonly ticket: QrTicket | null };

export interface StoredGroup extends StoredGroupStatus {
  /** live: 'live'; resumable: 'recoverable' | 'waiting'; gone: 'blocked' | 'ended' | 'expired' | 'invalid'. */
  readonly availability: 'live' | 'resumable' | 'gone';
}
```

### 5.2 Provider and components
```ts
export type SyncProviderProps =
  | { options: SyncClientOptions; client?: never; autoConnect?: boolean; children?: ReactNode }
  | { client: SyncClientLike; options?: never; autoConnect?: boolean; children?: ReactNode };
export function SyncProvider(props: SyncProviderProps): ReactElement;

export function QrTicket(props: { enabled?: boolean; children: (state: QrTicketState) => ReactNode }): ReactNode;
export function ConnectionIndicator(props: {
  children: (s: { indicator: SyncIndicator; status: ConnectionState['status']; retry: () => void }) => ReactNode;
}): ReactNode;
```

### 5.3 Hooks
| Hook | Returns | AC |
|---|---|---|
| `useSyncClient()` | `SyncClientLike \| null` (null on server / before mount). Escape hatch. | 4 |
| `useSyncSnapshot()` | `SyncClientSnapshot` | 9 |
| `useSyncSelector<T>(selector: (s: SyncClientSnapshot) => T, isEqual?: (a: T, b: T) => boolean)` | `T` | 11 |
| `useConnection()` | `{ state: ConnectionState; status; indicator: SyncIndicator; lastError: SyncClientError \| null; connect(): void; retry(): void; disconnect(): void }`. `connect`/`retry` (same function) call `client.connect()` and swallow the rejection (the error shows in `state`/`lastError`); `disconnect` calls `close()`. | 7, 13 |
| `useSyncIndicator()` | `SyncIndicator` via core `indicatorOf` | 13 |
| `useUpdateRequired()` | `UpdateRequired \| null` | 14 |
| `useGroup()` | `GroupState \| null` | 23 |
| `useGroupEnded()` | `{ reason: GroupEndedReason; code?: ClientErrorCode } \| null` (from `group.status === 'ended'`; `leader_timeout`/`inactivity` cover the empty-group end, #13 D15) | 23 |
| `usePosition()` | `{ hasPosition: boolean; position: JsonValue \| undefined; canUpdate: boolean; updatePosition(p: JsonValue): ActionResult<void>; error: SyncClientError \| null }` (core `updatePosition` throws synchronously; wrapped) | 23 |
| `useLeaderStatus()` | `{ online: boolean; lifecycle: LeaderLifecycle } \| null` (active member/leader group only) | stories |
| `useRemoved()` | `boolean`: connection `closed` with reason `removed`, or group ended with reason `removed` | 22 |
| `useGroupExit()` | `{ end: ActionState<[], void>; leave: ActionState<[], void> }` | stories |
| `useCreateGroup()` | `ActionState<[metadata: JsonObject, initialPosition?: JsonValue, options?: CreateGroupOptions], CreatedGroup>` | 15 |
| `useJoinByCode()` | `ActionState<[code: string, options?: JoinOptions], JoinedGroup>` (records the join flow) | 15 |
| `useJoinByQr()` | `ActionState<[ticket: string, options?: JoinByQrOptions], JoinedGroup>` (records the join flow) | 15 |
| `useJoinApproval()` | `{ flow: JoinFlowState; cancel: ActionState<[], void>; reset(): void }`. `waiting` comes from the snapshot (`awaiting_approval`), outcomes from the store's last join call (any join hook). | 17 |
| `useStoredGroups(opts?: { checkOnConnect?: boolean })` | `{ groups: readonly StoredGroup[] \| null; check: ActionState<[], readonly StoredGroup[]>; resume: ActionState<[groupId: string, options?: ResumeOptions], ResumedGroup> }`. `checkOnConnect` default **false** (Q-D); when true, one check per connected session (store-level single flight). Never resumes on its own. | 16 |
| `useLeaderCodes()` | `{ codes: JoinCodes \| null; joinPaused: { retryAt: number } \| null; joiningEnabled: boolean; rotate: ActionState<[], JoinCodes>; setJoiningEnabled: ActionState<[enabled: boolean], void> }` (`setJoiningEnabled` = unlock/lock, Q-A) | 18 |
| `useQrTicket(opts?: { enabled?: boolean })` | `{ state: QrTicketState; refresh(): void }` | 18 |
| `useJoinRequests()` | `{ requests: readonly JoinRequest[]; approve: ActionState<[requestId: string], 'admitted' \| 'group_full'>; deny: ActionState<[requestId: string], void> }` | 19 |
| `useRoster()` | `readonly RosterEntry[]` (leader only; `[]` otherwise) | 20 |
| `useViceLeader()` | `{ viceId: string \| null /* leader view */; isVice: boolean /* member view, Q-C */; setVice: ActionState<[participantId: string], string>; clearVice: ActionState<[], void> }` | 20 |
| `useGroupLock()` | `{ locked: boolean; lock: ActionState<[], void>; unlock: ActionState<[], void> }` | 20 |
| `useMemberRemoval()` | `{ blockList: readonly string[]; remove: ActionState<[participantId: string], readonly string[]>; addToBlockList: ActionState<[participantIds: readonly string[]], readonly string[]> }` (`addToBlockList` passes the active group's ID) | 20 |
| `useKeepAlive()` | `{ prompt: KeepAliveEvent \| null; answer: ActionState<[], void> }` | 21 |
| `useLeadership()` | `{ role: Role \| null; isLeader: boolean; takeBackAvailable: boolean; lastChange: LeadershipChange \| null; dismiss(): void; takeBack: ActionState<[], void> }` | 21 |
| `usePreview()` | `{ active: boolean; groupPosition: JsonValue \| undefined; previewPosition: JsonValue \| undefined; start(p?): void; move(p): void; end(): void; bringGroupHere(): void; returnToGroup(): JsonValue \| undefined }` | 24 |
| `useSyncEvent<E extends keyof SyncClientEvents>(event: E, handler: (payload: SyncClientEvents[E]) => void)` | `void` | 25 |
| `useSyncAction<A extends unknown[], T>(fn: (client: SyncClientLike, ...args: A) => Promise<T> \| T)` | `ActionState<A, T>` | 15 |

Leader-only actions call the core unchanged, so a member gets the core's typed
`NOT_LEADER` / `NOT_IN_GROUP` error in `{ ok: false, error }` (AC20).

`useSyncAction` details: `run` is stable (`useCallback` on the store); it
catches both a rejected promise and a synchronous throw; a non-`SyncClientError`
value (not expected from the core) becomes `new SyncClientError('INTERNAL_ERROR')`
so `error` stays typed; state setters are skipped after unmount; a newer
`run` supersedes an older one's state update (call counter).

## 6. `SyncStore` (`src/store.ts`)

```ts
interface SyncState {
  readonly snapshot: SyncClientSnapshot;        // core object, same identity
  readonly codes: JoinCodes | null;
  readonly joinRequests: readonly JoinRequest[];
  readonly roster: readonly RosterEntry[];
  readonly leaderState: LeaderState | null;
  readonly joinPaused: { readonly retryAt: number } | null;
  readonly keepAlive: KeepAliveEvent | null;
  readonly isVice: boolean;
  readonly leadership: LeadershipChange | null;
  readonly lastError: SyncClientError | null;
  readonly joinFlow: JoinFlowState;
  readonly preview: PreviewState;
}
class SyncStore {
  constructor(client: SyncClientLike | null)  // no side effects
  readonly client: SyncClientLike | null
  attach(): () => void                        // idempotent, ref-counted; returns detach
  subscribe(listener: () => void): () => void
  getState(): SyncState                       // cached, identity-stable
  getServerState(): SyncState                 // always SERVER_STATE
  readonly qr: QrTicketController
  // internal mutators used by hooks: recordJoin(promise, kind), dismissLeadership(),
  // previewChanged(), checkStoredGroups() (single flight)
}
```
- `attach()` subscribes to `client.subscribe` and to the events
  `codesChanged, joinRequested, joinWithdrawn, joinPaused, joinResumed,
  rosterChanged, viceChanged, lockChanged, keepAlive, keepAliveCleared,
  nowLeading, leadershipLost, leaderChanged, takeBackOffered, removed, error,
  groupEnded, rejoined, state`; every one marks the store dirty and notifies.
  On attach it re-reads every getter (D11). Detach removes all listeners.
- `getState()` rebuilds only when dirty or `client.getSnapshot()` changed
  identity, and keeps each part's previous identity when equal:
  codes by `generation` (and group); join requests and roster element-wise by
  identity/`requestId`; leader state by fields; preview by
  `active`/positions identity. So `getState()` is a valid
  `useSyncExternalStore` snapshot (same object until something changed).
- Event-derived resets: `keepAlive` cleared on `keepAliveCleared`,
  `leadershipLost`, and whenever the snapshot is no longer an active leader
  group of the same ID; `isVice` reset when the group ID changes or ends;
  `joinPaused` cleared on `joinResumed`, rotation and group change;
  `lastError` cleared when the connection reaches `connected`.
- Preview: `usePreview` actions call `client.preview.*` then
  `store.previewChanged()` (marks dirty); snapshot changes also recompute it
  (the core ends the preview on demotion/new group).
- `EMPTY_STORE` (client `null`): `attach` no-op, `getState()` returns
  `SERVER_STATE`.

## 7. Provider lifecycle (StrictMode and SSR)

```
SyncProvider({ options | client, autoConnect = true })
  owned mode:
    [store, setStore] = useState<SyncStore>(EMPTY_STORE)
    entryRef = useRef<{ store, closeTimer?, closed } | undefined>()
    optionsRef = latest options (read only at creation, D10)
    useEffect(() => {                       // deps: []
      let entry = entryRef.current
      if (entry?.closeTimer) { clearTimeout; entry.closeTimer = undefined }  // StrictMode remount
      if (!entry || entry.closed) { entry = { store: new SyncStore(new SyncClient(optionsRef.current)), closed: false }
                                    entryRef.current = entry; setStore(entry.store) }
      return () => { entry.closeTimer = setTimeout(() => { entry.closed = true; entry.store.client.close() }, 0) }
    }, [])
  client mode:
    store = useMemo(() => new SyncStore(client), [client])   // never closes the client (AC4)
  both:
    useEffect(() => store.attach(), [store])
    useEffect(() => {                       // deps: [store, autoConnect]
      const c = store.client
      if (autoConnect && c && c.getState().status === 'idle') void c.connect().catch(() => {})
    }, [store, autoConnect])
  render: createElement(SyncContext.Provider, { value: store }, children)
```
- **Server render:** effects do not run, so no client, no socket, no timer;
  every hook reads `SERVER_STATE` via `getServerSnapshot` (one constant object,
  AC9, AC10). Client mode on the server: the app's client is used read-only
  through `getServerSnapshot` (still the constant).
- **Hydration:** the first browser render uses `getServerSnapshot` (same
  constant) and, in owned mode, `EMPTY_STORE`: markup matches. The effect then
  creates the client and re-renders.
- **StrictMode:** effects run mount, cleanup, mount synchronously: the close
  timer is cancelled before it fires, the `idle` guard stops a second
  `connect()`. One client, one socket, no `close()` (AC6).
- **Real unmount:** the close fires one tick later; the store's listeners were
  removed by its own cleanup.
- **Effect re-run after a real close** (e.g. React `<Activity>` hide/show):
  `entry.closed` is true, so a fresh client is created (documented; not a
  "dead client" left in context).
- Mode switch (`options` <-> `client`) on the same mount throws a clear error;
  passing both or neither throws (types forbid it too).
- `autoConnect={false}`: nothing connects until `useConnection().connect()`.
  Turning it on later connects only from `idle`.

## 8. QR re-issue timer (`QrTicketController`)

- `acquire()` / `release()` ref count from `useQrTicket` effects. `release()`
  to zero schedules `stop()` with `setTimeout(0)`; `acquire()` cancels it
  (StrictMode never double-runs, D5).
- Eligible = refCount > 0 and `enabled` and snapshot connected with an active
  `leader` group. Re-evaluated on every store change. Not eligible: clear the
  timer, bump the generation, drop the ticket (status `idle`).
- `issue()`: single flight; `gen = ++generation`; `client.issueQrTicket()`;
  results with a stale `gen` are dropped.
  - success: `ready`; schedule the next issue at
    `max(10_000, 0.8 * (ticket.expiresAt - now()))` ms (10 s floor keeps
    within the server's 6/min, clamped to the 2^31-1 timer max).
  - `JOIN_METHOD_UNAVAILABLE`: `unavailable`, no timer.
  - `RATE_LIMITED`: keep the current ticket, retry once after
    `details.retryAfterMs ?? 10_000` (at least 10 s).
  - anything else (`NOT_CONNECTED`, `CONNECTION_LOST`, `NOT_LEADER`, ...):
    `error`, **no automatic retry**; the next eligibility change (reconnect +
    `codesChanged resumed`) or `refresh()` issues again.
- `codesChanged` with reason `rotated`, `resumed`, `member_removed` or
  `superseded` (security R1: each revokes every outstanding ticket): if eligible, clear the
  timer, bump the generation (an in-flight result issued before the rotation is
  discarded), set `loading` with `ticket: null` (the old ticket is revoked) and
  issue now. `door_failures` and `created` do nothing (same ticket generation).
- `stop()`: clear the timer, bump the generation, drop the ticket (the
  credential leaves memory when nothing shows it).
- `refresh()`: manual issue (same single flight). Security R2: a no-op while a
  request is in flight, during a `RATE_LIMITED` wait, and within 10 s of the
  last issue unless the ticket was revoked or is missing/expired.

## 9. No auto-retry after fatal (AC7, AC22)

1. One automatic `connect()` call site (provider), guarded by `status === 'idle'` (D4).
2. No hook or component calls `connect()`, `close()`, `resumeGroup()`,
   `joinBy*()` from render, from a store change or from an event; only from
   user-invoked callbacks. `useStoredGroups` never resumes by itself.
3. Manual `retry()` goes through the core `connect()`, which applies the
   backoff after `closed(fatal|gave_up)` (#3 M5) and the socket gap (R2-L6).
4. Enforced by tests: a source scan (`package.test.ts`) asserts `.connect(` only
   appears in `provider.ts` and the `useConnection` callback, and `.close(` only
   in `provider.ts` and `useConnection`; behavior tests drive a fake client to
   `closed` with each fatal reason (`fatal` + `INVALID_API_KEY`,
   `PROTOCOL_TOO_OLD`, `APP_VERSION_TOO_OLD`, `SERVER_UNSUPPORTED`; `removed`;
   `gave_up`), re-render many times, advance fake timers by minutes, and
   assert `connect` was called once. `INVALID_OPTIONS` (config invalid) is
   thrown by the constructor in owned mode: the provider catches it, exposes it
   as `lastError`/`closed`-like state via `useConnection` (store over no client
   with the error) and never retries.

## 10. Docs impact

- `packages/react/README.md` (new, AC28): install (workspace), provider setup
  for Next App Router (a `"use client"` `providers.tsx` that renders
  `SyncProvider`, because options with functions cannot cross the
  server/client boundary) and Pages Router (plain client code in `_app.tsx`),
  React SPA, SSR rules (no client on the server, constant idle snapshot,
  `autoConnect`), options read once (`key` to change), StrictMode behavior,
  every hook and component with its return type and a short example, the
  QR re-issue rules, the **no-auto-retry-after-fatal rule**, update-required
  handling, credentials (`groupId`, codes, QR tickets are credentials; they
  sit in React state and are visible to React DevTools; never log, never put
  in URLs except the QR fragment pattern from the client README; render
  names/server text as text only).
- Root `README.md`: workspace table row.
- `packages/client/README.md`: SSR section links to the React package.
- No protocol, server config or self-hosting change.

## 11. Test plan

Default environment jsdom; `strict = true` (StrictMode) in every render helper
unless a test needs otherwise. Fake timers where timers matter.

| AC | Test |
|---|---|
| 1 | `package.test.ts`: `package.json` name, `private`, deps exactly `@sync-system/client`, peer `react` `^18.3 \|\| ^19`, no `next`; root scripts cover it (workspace glob). CI runs lint/typecheck/test/build. |
| 2 | `package.test.ts`: source scan, no `node:*`, `ws`, `next`, `react-dom`, server import in `src`; type-level test (`expectTypeOf`) that the re-exported types exist. |
| 3 | `package.test.ts` builds (`tsc -p tsconfig.build.json`) and asserts every `dist/**/*.js` except pure modules (`store`, `qr-controller`, `server-state`, `update-required`, `host`, `types`) starts with `"use client";` and that `dist/index.d.ts` exists; ESM (`type: module`). |
| 4 | `provider.test.tsx`: client mode uses the given fake, unmount never calls `close()`; owned mode creates a client. |
| 5 | `provider.test.tsx` (real `SyncClient` + counting fake WebSocket): no socket during render; one after effects; `autoConnect={false}` opens none until `connect()`. SSR side in AC10. |
| 6 | `provider.test.tsx`: StrictMode mount -> 1 socket, 0 closes; 20 re-renders with new `options` objects -> still 1; unmount -> after timers, closed once; remount after real close -> a new client. |
| 7 | `connection.test.tsx`: fake client to `closed` per fatal reason, re-render, advance 10 min: `connect` count 1; `retry()` calls it once more. Source scan from section 9. |
| 8 | `context.test.tsx`: each public hook outside the provider throws an error naming `SyncProvider`. |
| 9 | `ssr.node.test.tsx`: `getServerSnapshot` identity across calls; `renderToString` twice, same constant read. |
| 10 | `ssr.node.test.tsx` (`@vitest-environment node`): traps on `window`, `document`, `WebSocket`, `localStorage` like the client's `ssr-import` test; `renderToString(<SyncProvider options>…all hooks…)` throws nothing, no trap hit, no client constructed (spy on `SyncClient.prototype.connect` and a counting `WebSocket` option), `vi.getTimerCount() === 0`. `hydration.test.tsx` (jsdom): hydrate that HTML with `hydrateRoot` and `onRecoverableError` spy: not called, no `console.error`; then one client connects. |
| 11 | `selector.test.tsx`: render counter; unrelated snapshot change -> no re-render; equal selection with custom `isEqual` keeps identity; inline selector does not loop. |
| 12 | `import.node.test.ts`: import `src/index.ts` with global traps and timer spies: nothing read/started; plus a fresh-process import of `dist/index.js` (client pattern). |
| 13 | `connection.test.tsx`: state, indicator matches `indicatorOf`, `lastError` from `error` event, cleared on `connected`. |
| 14 | `connection.test.tsx`: each update-required code with/without details -> discriminated value; server message rendered by a consumer appears as text (no HTML injection; the package itself never renders it). |
| 15 | `join.test.tsx`: create/joinByCode/joinByQr pending -> value; rejection -> `{ ok: false }` + `error`, no unhandled rejection (setup file). No join-by-group-ID export (export-list test). |
| 16 | `stored-groups.test.tsx`: availability mapping for all 7 statuses; `resume` calls core; no call on server/null client; `checkOnConnect` single flight under StrictMode. |
| 17 | `join.test.tsx`: waiting (snapshot `awaiting_approval`), paused (`JOIN_PAUSED`), approved, denied, withdrawn (cancel, timeout), `cancel` action. |
| 18 | `qr.test.tsx` (fake timers): issue on mount once under StrictMode; re-issue at 80 % (and 10 s floor); immediate re-issue on `rotated`/`resumed`, none on `door_failures`; stale in-flight result discarded; timer cleared on unmount (`vi.getTimerCount()`); two consumers share one ticket; `RATE_LIMITED` retry delay; `unavailable`; `error` without retry. Codes, rotate, `setJoiningEnabled` in `leader.test.tsx`. |
| 19 | `leader.test.tsx`: requests list follows the four events; approve/deny call core. |
| 20 | `leader.test.tsx`: roster identity stable until `rosterChanged`; vice (leader `viceId`, member `isVice`), lock, remove, block list; member gets `NOT_LEADER` result. |
| 21 | `leadership.test.tsx`: keep-alive prompt set/cleared, `answer`; `now_leading` / `lost` / `changed`; `takeBackAvailable` + `takeBack`. |
| 22 | `leadership.test.tsx`: `removed` event + `closed(removed)` -> `useRemoved()` true; no `connect`/`resumeGroup`/`joinBy*` call afterwards (advance timers, re-render). |
| 23 | `group.test.tsx`: position + `updatePosition` (leader ok, member `NOT_LEADER` result); ended reasons incl. `leader_timeout`/`inactivity`/`removed`. |
| 24 | `preview.test.tsx`: actions delegate to `client.preview`, state updates, ends on demotion snapshot. |
| 25 | `events.test.tsx`: handler swapped across renders is called (latest) with one subscription (`on` count 1); unsubscribed on unmount. |
| 26 | All the above use the fake client; `integration/flow.int.test.tsx`: in-process server, two providers (leader, member, `ws` injected, `storage: 'memory'`): create, join by code (method A or C), `updatePosition` seen by the member, leader change (vice set + leader provider unmount -> handoff with short `disconnectGraceSeconds`, or take-back) seen via `useLeadership`. |
| 27 | `package.test.ts`: no `console`/logger in `src`; a full-flow test with spies on every `console` method asserts no call; README test checks the credential statement. |
| 28 | `readme.test.ts`: every runtime export of `src/index.ts` is named in the README; sections for Next App/Pages, SSR, no-auto-retry exist. |
| 29 | CI `pnpm audit --audit-level=high`; engineer runs it before the PR is marked ready. |

## 12. Risks and edge cases

- **Credentials in React state.** `groupId` (in the snapshot), codes and QR
  tickets live in hook state and are visible in React DevTools and in any
  error boundary that serializes props/state. Mitigation: nothing is logged,
  the context value is the store object (private `#` fields), the QR ticket is
  dropped when no consumer is mounted, README states it.
- **Server render with a module-scope client** (apps passing `client` they
  created at module scope): the package cannot stop it; the README forbids it
  (#3 L7), and `getServerSnapshot` never reads that client's state, so no
  cross-request leak through SSR markup.
- **React 18.3** is a supported peer but tests run on 19 (Q2). The APIs used
  (`useSyncExternalStore`, `useEffect`, `createContext`) behave the same; no
  React 19-only API (`use`, `useActionState`) is used.
- **Timers in jsdom/fake timers**: the deferred close and QR release need a
  timer tick in tests (`vi.runOnlyPendingTimers()`).
- **Late provider mount** misses one-off events (D11, Q-C).
- **Rate budgets**: QR 6/min (10 s floor), `tokens.check` 10/min (single
  flight, opt-in auto check), keep-alive answers are user-driven.
- **Hydration flash**: the first client render shows idle state; apps that
  care render a placeholder while `status === 'idle'`.

## 13. Gate 2 questions (recommendation first)

**Decided at Gate 2 (user, 2026-11-05): all four recommendations accepted.**
Q-A: `setJoiningEnabled` = lock/unlock of all joining; "expiry" = the QR
ticket's `expiresAt` and the codes' generation; the README states codes and
tickets work again after unlock, so a leaked code needs `rotate`. Q-B: `paused`
= `JOIN_PAUSED`. Q-C: the member vice flag is tracked from provider mount,
event-only, reset on group change or end. Q-D: `useStoredGroups` auto-check is
opt-in `checkOnConnect`, default off. Every security control R1-R14 of
[`security.md`](security.md) is required and part of this plan.

- **Q-A (AC18 "enable/disable join methods", "code expiry").** The core has no
  API to change a group's join methods after creation, and join codes do not
  expire (only QR tickets do). *Recommended:* `setJoiningEnabled(bool)` maps
  to `unlockGroup()`/`lockGroup()` (stops every method), methods stay as chosen
  at `createGroup`; "expiry" is the QR ticket's `expiresAt` and the codes'
  `generation`. Per-method toggling would need a protocol + server + core
  change: a follow-up issue if wanted. *Alternative:* drop the action from
  AC18.
- **Q-B (AC17 "paused").** The core has no "paused" state for a pending
  approval (a connection drop rejects the request). *Recommended:* `paused` =
  the join failed with `JOIN_PAUSED` (door-code joining paused after repeated
  failures), with `retryAt` from `details.retryAfterMs`.
- **Q-C (member vice flag).** The core reports "you are the vice" only through
  the `viceChanged` event. *Recommended:* accept that `isVice` is tracked from
  the provider's mount on (documented); optional follow-up for a core getter.
- **Q-D (`useStoredGroups` auto-check).** *Recommended:* opt-in
  `checkOnConnect` (default `false`), so the package makes no network call the
  app did not ask for (`checkTokens` is never automatic in the core either).

## 14. Security-sensitive areas

Security-sensitive: yes

- Credentials flowing through React state, context and DevTools: `groupId`
  (#3: a credential), join codes, QR tickets (bearer), participant IDs,
  display names (`src/store.ts`, `src/qr-controller.ts`, `src/hooks/leader.ts`).
- Reconnect/retry behavior that could hammer the server after fatal errors or
  removal (`src/provider.ts`, `src/hooks/connection.ts`; #3 M5, R2-L6).
- SSR: a client must never be created or connected on a shared server
  (`src/provider.ts`, `src/server-state.ts`; #3 L7).
- Rate budgets of QR issue and token checks (`src/qr-controller.ts`,
  `src/hooks/stored-groups.ts`).
- Untrusted text (display names, server messages) is never rendered as HTML
  by the package (the helpers render nothing themselves).
- New devDependencies: `react`, `react-dom`, `@types/react`,
  `@types/react-dom`, `jsdom`, `@testing-library/react`,
  `@testing-library/dom` (approved at Gate 1, Q7); no new runtime dependency.

## 15. Implementer model

Implementer model: opus
Reason: security-sensitive, new package with new dependencies, ~25 files,
and subtle lifecycle logic (StrictMode deferred close, identity-stable store
caching, QR timer generations) with no existing React pattern in the repo.

## 16. Implementation chunks

1. `build(react): scaffold the react package` (package.json, tsconfigs, vitest config, `src/index.ts` stub, test setup, ESLint globs and react block, lockfile; `package.test.ts` for AC1)
2. `feat(react): add the sync store and server state` (`store.ts`, `server-state.ts`, `host.ts`, `types.ts`, `update-required.ts`; store unit tests)
3. `feat(react): add the provider with strict-mode-safe lifecycle` (`context.ts`, `provider.ts`; provider, context tests, AC4-AC8)
4. `feat(react): add snapshot, selector and connection hooks` (`selector.ts`, `hooks/connection.ts`, `<ConnectionIndicator>`; AC9, AC11, AC13, AC14)
5. `test(react): cover server rendering, hydration and import` (`ssr.node.test.tsx`, `hydration.test.tsx`, `import.node.test.ts`; AC10, AC12)
6. `feat(react): add action, group and position hooks` (`action.ts`, `hooks/group.ts`, `hooks/events.ts`; AC22 removal, AC23, AC25)
7. `feat(react): add join, approval and stored-group hooks` (`hooks/join.ts`, `hooks/stored-groups.ts`; AC15-AC17)
8. `feat(react): add leader code and qr ticket hooks` (`qr-controller.ts`, `useLeaderCodes`, `useQrTicket`, `<QrTicket>`; AC18)
9. `feat(react): add join request, roster and member control hooks` (`useJoinRequests`, `useRoster`, `useViceLeader`, `useGroupLock`, `useMemberRemoval`; AC19, AC20)
10. `feat(react): add keep-alive, leadership and preview hooks` (`useKeepAlive`, `hooks/leadership.ts`, `hooks/preview.ts`; AC21, AC24)
11. `test(react): add the in-process server integration test` (AC26)
12. `test(react): enforce no logging and no automatic reconnect` (source scans, console spies; AC7, AC27)
13. `docs(react): document the react package` (package README, `readme.test.ts`, root README row, client README SSR link; AC28)
