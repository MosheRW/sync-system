# @sync-system/react

React and Next.js bindings for [`@sync-system/client`](../client/README.md):
one provider, typed hooks and two unstyled render-prop helpers. Components
re-render only when the state they use changes. The package is safe during
server-side rendering: nothing reads `window`, opens a socket or starts a
timer on the server.

Runtime dependency: `@sync-system/client` only. Peer dependency: `react`
`^18.3 || ^19` (tested on React 19). No `next` dependency. Headless: the
package renders no markup of its own.

## Install

Workspace-only for now (`private: true`, published with the release item):

```json
{
  "dependencies": {
    "@sync-system/react": "workspace:*",
    "react": "^19.0.0"
  }
}
```

The hooks return the core's types, re-exported from this package
(`SyncClientSnapshot`, `GroupState`, `JoinCodes`, `QrTicket`,
`SyncClientError`, ...), so apps need not import `@sync-system/client` for
typing.

## Provider setup

Wrap the app in one `<SyncProvider>`. It takes either `options` (it creates,
connects and closes its own client) or an existing `client` (it uses it as
is and never closes it). Exactly one of the two; switching between them on
one mount throws.

```tsx
<SyncProvider options={options}>{children}</SyncProvider>        // owns a client
<SyncProvider client={client}>{children}</SyncProvider>          // app's client
<SyncProvider options={options} autoConnect={false}>{children}</SyncProvider>
```

- `autoConnect` (default `true`): connect after mount, only from `idle`.
  With `false`, nothing connects until the app calls
  `useConnection().connect()`.
- Options are read **once**, when the client is created. Later changes (new
  object identity or new values) are ignored, so re-renders never churn
  sockets. To change the URL or the key on purpose, remount the provider
  with a React `key` (see [No automatic retry](#no-automatic-retry-after-a-fatal-error)
  for when not to).
- **One owned provider per app and storage namespace.** Two `options`
  providers on one page create two clients that resume the same stored
  group and displace each other. Share one provider (or one client in
  `client` mode) across routes.

### Next.js App Router

The package's modules start with `"use client"`, so they can be imported
from server and client components. Options often hold functions (a
`WebSocket` class, storage), which cannot cross the server/client boundary:
render the provider from a client component.

```tsx
// app/providers.tsx
'use client';
import { SyncProvider } from '@sync-system/react';
import type { ReactNode } from 'react';

const options = {
  url: 'wss://sync.example.com/ws',
  apiKey: process.env.NEXT_PUBLIC_SYNC_API_KEY!, // not a secret: it ships in the bundle
  appVersion: '1.4.0',
};

export function Providers({ children }: { children: ReactNode }) {
  return <SyncProvider options={options}>{children}</SyncProvider>;
}
```

```tsx
// app/layout.tsx (a server component)
import { Providers } from './providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### Next.js Pages Router

Plain client code in `_app.tsx`; nothing Next-specific:

```tsx
// pages/_app.tsx
import { SyncProvider } from '@sync-system/react';
import type { AppProps } from 'next/app';

const options = { url: 'wss://sync.example.com/ws', apiKey: 'public-key', appVersion: '1.4.0' };

export default function App({ Component, pageProps }: AppProps) {
  return (
    <SyncProvider options={options}>
      <Component {...pageProps} />
    </SyncProvider>
  );
}
```

### React SPA (Vite and similar)

```tsx
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SyncProvider options={options}>
      <App />
    </SyncProvider>
  </StrictMode>,
);
```

## Server-side rendering

- No client is created on the server, and none at module scope: the owned
  client is created in an effect after mount. Never create a client at
  module scope yourself and pass it in `client` mode on an SSR server (it
  would be shared by every request).
- `connect()` never runs during SSR; effects do not run on the server.
- Every state hook reads one constant idle snapshot on the server and
  during hydration (`getServerSnapshot`), so hydration never mismatches.
  The first browser render shows the idle state; render a placeholder while
  `useConnection().status === 'idle'` if that matters.
- Importing the package has no side effects (no globals, no timers).

## StrictMode

StrictMode's simulated unmount and remount keep one client and one socket:
the provider closes its owned client one tick after a real unmount, and a
remount in between cancels that close. The QR timer works the same way, so
it never issues twice.

## No automatic retry after a fatal error

The only automatic `connect()` in the package is the provider's, and it runs
only from `idle`. The core never returns to `idle`, so nothing in the package
reconnects after a fatal close (`INVALID_API_KEY`, `PROTOCOL_TOO_OLD`,
`APP_VERSION_TOO_OLD`, `SERVER_UNSUPPORTED`, invalid options), after the
core gave up, or after a removal. Reconnecting after a drop stays the core's
job, with its backoff.

For a manual retry, call `useConnection().retry()` from a user action. It
goes through the core `connect()`, which waits its backoff first after a
fatal close or a give-up, so a retry button cannot hammer the server.

**Never remount or re-key the provider to retry after a fatal close or a
removal.** A new client starts with no failure history, so every remount
opens a new socket at once: after a `minAppVersion` bump every outdated
install would do this together. Use a `key` only for a deliberate
configuration change, with a stable value (never a counter, a timestamp or
a value that changes on errors). Note that hiding and showing the provider
(React `<Activity>`, or unmounting it) also recreates the client.

`useSyncClient()` is an escape hatch: calling `connect()` or `close()` on the
client from render or from a state-driven effect bypasses these guarantees.
Call them only from user actions.

## Hooks

Every hook throws `"<hookName> must be used inside <SyncProvider>
(@sync-system/react)"` outside a provider. Returned objects and arrays keep
their identity while their content is unchanged.

### Actions

Action hooks return an `ActionState`:

```ts
interface ActionState<A extends unknown[], T> {
  run(...args: A): Promise<ActionResult<T>>; // stable identity, never rejects
  pending: boolean;
  error: SyncClientError | null;
  value: T | undefined;
  reset(): void;
}
type ActionResult<T> = { ok: true; value: T } | { ok: false; error: SyncClientError };
```

`run` never rejects: a rejected core call and a synchronous throw both give
`{ ok: false, error }` with the core's typed `SyncClientError` (so there is
never an unhandled rejection). A newer call supersedes an older one's state.
Without a client (server, before mount) actions resolve `NOT_CONNECTED` and
touch nothing. Leader-only actions call the core unchanged: a member gets
the core's `NOT_LEADER` error. `useSyncAction(fn)` builds one for any core
call:

```ts
const blockList = useSyncAction((client, groupId: string) => client.getBlockList(groupId));
```

### State and connection

| Hook                        | Returns                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `useSyncSnapshot()`         | The core `SyncClientSnapshot` (same identity until it changes).                                               |
| `useSyncSelector(sel, eq?)` | `sel(snapshot)`; re-renders only when the selection changes (`Object.is` or `eq`). Inline selectors are fine. |
| `useConnection()`           | `{ state, status, indicator, lastError, connect, retry, disconnect }`. `lastError` clears on `connected`.     |
| `useSyncIndicator()`        | The PRD sync indicator (`none`, `following`, `leading`, `reconnecting`, ...), via the core `indicatorOf`.     |
| `useUpdateRequired()`       | `UpdateRequired \| null` (below).                                                                             |
| `useSyncClient()`           | The client, or `null` on the server, during hydration and until mounted. Escape hatch (see above).            |
| `useSyncEvent(name, fn)`    | Subscribes to a core event in an effect; always calls the latest `fn`; unsubscribes on unmount.               |
| `useSyncAction(fn)`         | A custom `ActionState` over the client.                                                                       |

```tsx
const status = useSyncSelector((s) => s.connection.status);
useSyncEvent('positionUpdated', (event) => scrollTo(event.position));
```

#### Update required

`useUpdateRequired()` turns `APP_VERSION_TOO_OLD`, `PROTOCOL_TOO_OLD` and
`SERVER_UNSUPPORTED` into a typed value:

```ts
type UpdateRequired =
  | { kind: 'app'; minAppVersion?: string }
  | { kind: 'protocol'; minProtocolVersion?: number }
  | { kind: 'server_unsupported'; serverProtocolVersion: number; serverMinProtocolVersion: number };
```

Show an "update required" screen; do not retry (the same version always gets
the same answer).

### Group

| Hook                | Returns                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `useGroup()`        | The snapshot's `GroupState \| null`.                                                                                         |
| `usePosition()`     | `{ hasPosition, position, canUpdate, updatePosition(p), error }`. `updatePosition` returns an `ActionResult` (never throws). |
| `useGroupEnded()`   | `{ reason, code? } \| null`. `leader_timeout` and `inactivity` also cover a group that emptied and ended after its grace.    |
| `useLeaderStatus()` | `{ online, lifecycle } \| null` for an active group.                                                                         |
| `useRemoved()`      | `true` once the leader removed this participant (close 4004). Terminal: nothing reconnects or rejoins.                       |
| `useGroupExit()`    | `{ end, leave }` actions (leader ends, member leaves).                                                                       |

### Joining and recovery

| Hook                                  | Returns                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `useCreateGroup()`                    | Action `run(metadata, initialPosition?, options?)` -> `CreatedGroup` (with codes).            |
| `useJoinByCode()`                     | Action `run(code, { doorCode?, displayName? })` -> `JoinedGroup`.                             |
| `useJoinByQr()`                       | Action `run(ticket, { displayName? })` -> `JoinedGroup`.                                      |
| `useJoinApproval()`                   | `{ flow, cancel, reset }` for the approval flow.                                              |
| `useStoredGroups({ checkOnConnect })` | `{ groups, check, resume }`: stored groups with `availability` `live`, `resumable` or `gone`. |

There is no join by group ID (removed in #10).

`useJoinApproval().flow` follows the last join call of any join hook:
`idle`, `joining`, `waiting` (`{ requestId, expiresAt }`, from the snapshot's
`awaiting_approval`), `paused` (`JOIN_PAUSED`: door-code joining is paused,
`retryAt` when known), `approved` (admitted after waiting), `joined`,
`denied`, `withdrawn` (`cancelled` or `timeout`) or `failed` (`error`).
`cancel` withdraws a waiting request.

`useStoredGroups()` makes no network call unless the app asks: `check.run()`
calls the core `checkTokens()`; `checkOnConnect: true` checks once per
connected session (default `false`). `resume.run(groupId)` resumes one group;
the package never resumes on its own. A group reported `gone` (`blocked`,
`ended`, `expired`, `invalid`) is never recreated or rejoined.

```tsx
const { groups, resume } = useStoredGroups({ checkOnConnect: true });
return groups
  ?.filter((g) => g.availability !== 'gone')
  .map((g) => (
    <button key={g.groupId} onClick={() => void resume.run(g.groupId)}>
      Resume
    </button>
  ));
```

### Leader

| Hook                 | Returns                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `useLeaderCodes()`   | `{ codes, joinPaused, joiningEnabled, rotate, setJoiningEnabled }`.                                      |
| `useQrTicket(opts?)` | `{ state, refresh }` with automatic re-issue (below).                                                    |
| `useJoinRequests()`  | `{ requests, approve, deny }`, updated on `joinRequested`, `joinWithdrawn`, `joinPaused`, `joinResumed`. |
| `useRoster()`        | The roster while leading, else `[]`.                                                                     |
| `useViceLeader()`    | `{ viceId, isVice, setVice, clearVice }`: `viceId` for the leader, `isVice` for a member.                |
| `useGroupLock()`     | `{ locked, lock, unlock }`.                                                                              |
| `useMemberRemoval()` | `{ blockList, remove, addToBlockList }` (`addToBlockList` uses the active group).                        |
| `useKeepAlive()`     | `{ prompt, answer }`: the keep-alive prompt (`deadlineAt`) and its answer.                               |

Leader-only data (codes, requests, roster, block list, recovery state,
keep-alive prompt, QR ticket) is shown only while this client leads the
current group. On demotion, removal, group end or a switch to another group
it is dropped, and so are the leader action values (`rotate.value`,
`remove.value`, `useCreateGroup().value`, ...).

`setJoiningEnabled(false)` locks the group: nobody new joins by any method
(the join methods themselves are fixed at `createGroup`). **Codes and QR
tickets stay valid and work again after an unlock: a leaked code needs
`rotate`, not just a lock.** "Expiry" is the QR ticket's `expiresAt` and the
codes' `generation`; join codes do not expire.

`isVice` (member view) is tracked from `viceChanged` events from the
provider's mount on; a provider mounted later learns it on the next change.
It resets on group change or end.

#### QR re-issue

`useQrTicket()` and `<QrTicket>` share one ticket and one timer per provider:

- issued when the first consumer mounts (enabled, leading, connected);
- re-issued at about 80 % of the ticket's lifetime, never sooner than 10 s
  after the last issue;
- re-issued at once after `codesChanged` with reason `rotated`, `resumed`,
  `member_removed` or `superseded`: each revokes every outstanding ticket,
  so the old one is dropped first (`loading` with `ticket: null`). Not after
  `door_failures` or `created`;
- `RATE_LIMITED`: the current ticket stays; one retry after the server's
  delay (10 s to 60 s). The wait survives a demotion, a group switch and
  hiding the QR; a new connection ends it (the server's limit is per
  connection), but the 10 s floor still holds across reconnects.
  `JOIN_METHOD_UNAVAILABLE` (no method D):
  `unavailable`. Other errors: `error`, no automatic retry;
- an expired ticket is never shown as `ready`;
- the timer stops and the ticket is dropped when the last consumer unmounts
  or is disabled.

`state` is `idle`, `loading` (`ticket` or `null`), `ready` (`ticket`),
`unavailable` or `error` (`error`, `ticket` or `null`). `refresh()` is ignored
while a request is in flight, during a rate-limit wait and within 10 s of the
last issue (unless the ticket expired), so calling it in a loop cannot flood
the server.

Pass `enabled: false` (or unmount) while the QR is not on screen, so no
ticket is minted that nobody sees. The package does not read `document`;
the app decides:

```tsx
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

function JoinQr() {
  const visible = useDocumentVisible();
  return (
    <QrTicket enabled={visible}>
      {(state) =>
        state.status === 'ready' ? (
          <QrImage value={`https://reading.example/join#t=${state.ticket.ticket}`} />
        ) : (
          <p>Preparing the QR code...</p>
        )
      }
    </QrTicket>
  );
}
```

Put the ticket in the URL fragment, never the query string (see the
client's [QR tickets and deep links](../client/README.md#qr-tickets-and-deep-links)).

### Leadership and preview

| Hook              | Returns                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `useLeadership()` | `{ role, isLeader, takeBackAvailable, lastChange, dismiss, takeBack }`.                                              |
| `usePreview()`    | `{ active, groupPosition, previewPosition, start, move, end, bringGroupHere, returnToGroup }` over `client.preview`. |

`lastChange` is the last leadership change seen since the provider mounted:
`now_leading` ("you're now leading"), `lost` (with `takeBackAvailable`) or
`changed` (someone else leads), each with `reason` and `at`. `dismiss()`
clears it; it also resets on group change or end. `takeBack.run()` takes the
lead back while `takeBackAvailable`.

`usePreview()` lets the leader browse ahead without moving the group;
`bringGroupHere()` moves the group with one update and returns an
`ActionResult`. The core ends the preview on demotion or a new group.

## Components

Both render only what their render prop returns:

```tsx
<ConnectionIndicator>
  {({ indicator, status, retry }) => (
    <span>
      {indicator}
      {status === 'closed' && <button onClick={retry}>Retry</button>}
    </span>
  )}
</ConnectionIndicator>

<QrTicket enabled={visible}>{(state) => /* draw the QR */ null}</QrTicket>
```

## Credentials and untrusted text

- **`groupId`, join codes and QR tickets are credentials.** Anyone holding
  them can join or resume. The package never logs them and never puts them
  in URLs. They sit in React state (visible to React DevTools and to any
  script in the origin); never log them, never send them to analytics or
  error reporters, and never put them in URLs except the QR ticket in a URL
  fragment.
- The package logs nothing (no `console`, no logger). Errors are the core's
  `SyncClientError`, which holds no group ID, code or payload.
- **Untrusted text:** display names (roster, join requests, the user's own),
  `serverMessage`, group `metadata` and `position` come from other users or
  the server. Render them as text, never as HTML (no
  `dangerouslySetInnerHTML`). Validate any URL taken from `metadata` or
  `position` before using it in `href` or `src`: allow `https:` only, never
  `javascript:`.
