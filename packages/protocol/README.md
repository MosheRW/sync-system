# @mosherw/sync-system-protocol

The wire protocol of the sync system: protocol versions, error and close
codes, message types, limits, join-code helpers and the zod schemas that the
server and the client both validate with. It has one runtime dependency,
`zod`, and no Node-only or browser-only module.

Most apps never import it directly: the client
([`@mosherw/sync-system-client`](https://github.com/MosheRW/sync-system/tree/main/packages/client#readme))
and the React bindings
([`@mosherw/sync-system-react`](https://github.com/MosheRW/sync-system/tree/main/packages/react#readme))
re-export the types they need. Use it when you write your own client or
tooling against the sync server.

## Install

```sh
npm install @mosherw/sync-system-protocol
```

The package is ESM only, with TypeScript types. If you also use the client,
keep both on the same version: the client depends on the exact protocol
version it was released with.

## What it exports

| Group               | Exports (examples)                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Versions            | `PROTOCOL_VERSION`, `MIN_CLIENT_PROTOCOL_VERSION`                                                          |
| Codes               | `ErrorCode`, `CloseCode`                                                                                   |
| Message types       | `ClientMessage`, `ServerMessage`, and one type per message (`HelloMessage`, `PositionUpdatedMessage`, ...) |
| Schemas and parsing | `clientMessageSchema`, `serverMessageSchema`, `parseClientMessage`, `parseServerMessage`, `formatIssues`   |
| Limits              | `MAX_JSON_DEPTH`, `GROUP_ID_PATTERN`, `MAX_DISPLAY_NAME_LENGTH`, `HANDOFF_MODES`, ...                      |
| Joining             | `normalizeJoinCode`, `classifyJoinCode`, `isDoorCode`, `normalizeDisplayName`, ...                         |
| Tokens              | `TOKEN_FORMAT_VERSION`, `splitToken`, `decodeTokenClaims` (decoding only; the server verifies)             |
| JSON guard          | `checkJson` (depth and size checks before parsing app data)                                                |

```ts
import { PROTOCOL_VERSION, parseServerMessage } from '@mosherw/sync-system-protocol';

const result = parseServerMessage(JSON.parse(frame));
if (result.ok) handle(result.message);
```

The full reference of every message, field, error code and close code is
[`docs/protocol.md`](https://github.com/MosheRW/sync-system/blob/main/docs/protocol.md).
The versioning rules are in
[`docs/versioning.md`](https://github.com/MosheRW/sync-system/blob/main/docs/versioning.md).

## License

GPL-3.0-only. See [`LICENSE`](LICENSE). The GPL also covers apps that bundle
this package and ship that bundle (browser bundles included).
