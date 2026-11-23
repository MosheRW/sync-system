# Integration guide

How to build a group feature on the sync server, with the reading app
([`apps/reader`](../apps/reader/README.md)) as the worked example. The reader
lets a leader start a group for a book; others join by code or QR and follow
the leader's page.

The pieces:

| Piece                                                             | What you use it for                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The sync server ([operator guide](operator-guide.md))             | Runs the groups. Stores and relays your **position**; never reads it.     |
| [`@mosherw/sync-system-react`](../packages/react/README.md)       | Provider and hooks for React and Next.js apps (the reader uses this).     |
| [`@mosherw/sync-system-client`](../packages/client/README.md)     | The framework-free client under it; use it directly without React.        |
| [`@mosherw/sync-system-protocol`](../packages/protocol/README.md) | Wire types, only for your own client ([protocol reference](protocol.md)). |

## 1. Register your app

Each app has one entry in the server's apps file: a `namespace`, an
`apiKey`, a `minAppVersion` and its limits (see
[Config file](operator-guide.md#config-file-registered-client-apps)). Generate
the key with `openssl rand -base64 32`.

**In a browser app the API key is public**: it ships in the page and only
identifies the app and selects its limits. Joining needs a code or a QR
ticket, and every leader action needs a token. Give each app its own entry
with tight `maxConnections`, and put per-IP limits at the reverse proxy. The
reader's entry is `reading-app` in
[`config/apps.example.json`](../config/apps.example.json); for local work it
uses the public `dev-app` key from
[`config/apps.dev.json`](../config/apps.dev.json), which the server accepts
only with `NODE_ENV=development` or `test`.

## 2. Run the server and the reader

```sh
docker compose up --build    # sync server on 127.0.0.1:8080, reader on 127.0.0.1:8081
```

The reader gets `READER_SYNC_URL=ws://127.0.0.1:8080/ws` and the dev key (see
the reader's [Local setup](../apps/reader/README.md#local-setup)). Open
`http://127.0.0.1:8081` in two browser windows: start a group in one, join it
in the other. For your own app, install the packages:

```sh
npm install @mosherw/sync-system-react react
```

## 3. Set up the provider

One provider per app, created once. The reader's
[`SyncRoot.tsx`](../apps/reader/src/group/SyncRoot.tsx) builds the options
once with `useState` and passes `autoConnect` so a solo reader never opens a
socket:

```tsx
import { SyncProvider, type SyncClientOptions } from '@mosherw/sync-system-react';

const [options] = useState<SyncClientOptions>(() => ({
  url: sync.url, // wss://... in production
  apiKey: sync.apiKey, // public, see above
  appVersion: sync.appVersion, // checked against the app's minAppVersion
  storage: sessionStorage, // where participant tokens live
}));

<SyncProvider options={options} autoConnect={hasStoredGroup}>
  {children}
</SyncProvider>;
```

Options are read once; the provider owns and closes the client. The
[Provider setup](../packages/react/README.md#provider-setup) section covers
Next.js and SSR. Handle `useUpdateRequired()` with an "update required"
screen (the reader's `UpdateGate`): the same version always gets the same
answer, so never retry.

## 4. Decide your metadata and your position

The server never reads either; they are your app's contract with itself.

- **Metadata** is set once, by the leader, at `createGroup(metadata)`. Every
  joiner gets it. The reader sends what the book is:
  `{ contentId, fingerprint, schemaVersion }`
  ([`metadata.ts`](../apps/reader/src/content/metadata.ts)), where the
  fingerprint is a SHA-256 over the canonical JSON of the whole book (see the
  reader's [Fingerprint](../apps/reader/README.md#fingerprint)). A member
  compares it with its own copy before following: a different book blocks,
  a different version of the same book asks first
  ([Group metadata and comparison](../apps/reader/README.md#group-metadata-and-comparison)).
- **Position** is what the leader moves. The reader's is
  `{ "v": 1, "pageIndex": 3 }`
  ([`position.ts`](../apps/reader/src/group/position.ts)).
- Treat both as **untrusted input** on receipt: check the exact shape (the
  reader's `parseLeaderMetadata` and `decodePosition` accept exactly their
  keys and ignore anything else), and render any text as text, never HTML.
- Version your position (`v`) so an old member never misreads a new
  leader's position: accept only versions you know.
- Keep both small: each is limited to the app's `maxMessageBytes`.

## 5. Create and join

```tsx
const create = useCreateGroup();
const result = await create.run(toGroupMetadata(book), encodePosition(page), {
  joinMethods: ['A', 'D'], // within the app's joinMethods
});
if (result.ok) showCodes(result.value.codes);
```

The leader alone gets the codes (`useLeaderCodes()`) and the QR ticket
(`useQrTicket()` or `<QrTicket>`). Joiners use `useJoinByCode()` (group code
plus door code for method A, the 8-character code for C), `useJoinByQr()` for
a QR ticket, and `useJoinApproval()` to follow a method B request until the
leader decides. The reader's join flow is
[`use-join.ts`](../apps/reader/src/group/use-join.ts); its QR link carries the
ticket in the URL fragment and strips it before anything else runs
([Joining](../apps/reader/README.md#joining)). A QR ticket is a bearer
credential: keep `qrTicketSeconds` short and never log or store it.

Pick join methods by who may join: A (a 6-digit door code) is a "same room"
control; B (leader approval), C or D are stronger. See
[Joining (methods A to D)](operator-guide.md#joining-methods-a-to-d).

## 6. Follow the position

The leader moves the group with `usePosition().updatePosition(position)`
(rate-limited to `maxLeaderUpdatesPerSecond`); members read
`usePosition().position`. The reader's
[`use-follow.ts`](../apps/reader/src/group/use-follow.ts) adds what a reading
app needs on top: a member who browses away stops following and is offered
to go back, and a late joiner gets a short countdown before the jump
([Following](../apps/reader/README.md#following)).

`useSyncIndicator()` gives the sync indicator (`following`, `leading`,
`reconnecting`, ...) for a status line.

## 7. Leader controls and the lifecycle

The hooks in [Leader](../packages/react/README.md#leader) and
[Leadership and preview](../packages/react/README.md#leadership-and-preview)
map one-to-one onto the server's roles:

- codes and QR (`useLeaderCodes`, `useQrTicket`), join requests
  (`useJoinRequests`), the roster (`useRoster`), the vice-leader
  (`useViceLeader`), lock (`useGroupLock`) and removal (`useMemberRemoval`);
- the keep-alive prompt (`useKeepAlive`): answer it, or the group pauses;
- preview (`usePreview`): the leader browses without moving the group, and
  only a "leader active" signal is sent;
- leadership changes (`useLeadership`): "you're now leading", a lost lead,
  and the take-back offer after a handoff.

The reader shows each of them
([Leader views and lifecycle prompts](../apps/reader/README.md#leader-views-and-lifecycle-prompts)).
Display names in the roster are plain text; show the "generated" flag so a
chosen `Guest 3` cannot pass as a generated name.

## 8. Recovery

The client stores each participant token (per app namespace) in the storage
you gave it and resumes the group after a reload or a dropped connection.
`useStoredGroups()` lists stored groups (`live`, `resumable` or `gone`) and
resumes one on request; a `gone` group is never recreated. The reader keeps
tokens in `sessionStorage` per tab
([ADR 0009](decisions/0009-reader-group-session-storage.md),
[Reloads, phone locks and storage](../apps/reader/README.md#reloads-phone-locks-and-storage)).
On shared devices tell users to leave the group before walking away.

A leader that drops for less than `disconnectGraceSeconds` comes back still
leading; for a 30-second phone lock set it to 45 or more. After a server
restart without Redis, the leader's client recreates the group from its
token; with Redis nothing is lost (see
[Recovery and tokens](operator-guide.md#recovery-and-tokens)).

## 9. Ship it

- Serve your app over HTTPS and the server over `wss://`.
- Pin package versions; the client and the server work together within one
  major version (see [`docs/versioning.md`](versioning.md)).
- The packages are GPL-3.0-only. **An app that bundles the client or React
  package and ships that bundle (browser bundles included) is bound by the
  GPL's terms.**
