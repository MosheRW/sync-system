# Versioning policy

The published packages and the sync server follow
[semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`. The release
process is in `RELEASING.md` at the repo root; how the version number is
managed is [ADR 0016](decisions/0016-versioning-and-npm-release.md).

## One version for four packages

`@mosherw/sync-system-protocol`, `@mosherw/sync-system-client`,
`@mosherw/sync-system-react` and the sync server
(`@mosherw/sync-system-server`, shipped as the image
`ghcr.io/mosherw/sync-system-server`) form one fixed Changesets group: they
always share one version, and a release bumps all four together. A change
to one package that is breaking makes the next version a major for all four.
The reading app (`@mosherw/sync-system-reader`) is private and has no public
version.

Each package's changes are in its `CHANGELOG.md`:
[protocol](../packages/protocol/CHANGELOG.md),
[client](../packages/client/CHANGELOG.md),
[react](../packages/react/CHANGELOG.md),
[server](../apps/sync-server/CHANGELOG.md).

## What is breaking (major)

**Wire protocol** (`@mosherw/sync-system-protocol`, and the server):

- removing or renaming a message type, a field, an error code or a close code;
- a new required field in a message a peer sends;
- changing the type or meaning of an existing field;
- a tighter limit (a shorter maximum length, a lower count, a smaller size);
- raising `MIN_CLIENT_PROTOCOL_VERSION`.

**Client API** (`@mosherw/sync-system-client`) and **React API**
(`@mosherw/sync-system-react`):

- removing or renaming an export, an option, a method, an event, a hook, a
  state value or a client error code;
- narrowing accepted input (an option that accepted a value no longer does);
- a new required option;
- changing a default in a way an app can see;
- dropping a React major from the peer range (`^18.3 || ^19` today).

**Server config and env** (the server and its image):

- removing or renaming an env variable or an apps-file key;
- a lower maximum or a higher minimum for a variable or a key;
- a changed default that changes behaviour visibly;
- a new required variable or key;
- a config that started before and is now refused;
- changes to the image contract (port 8080, `SYNC_CONFIG_PATH`, the `node`
  user, `/health` and `/ready`).

## What is not breaking

- **Minor:** additions. An optional field, a new message or event a peer may
  ignore, a new error code a client can treat as generic, a new export,
  option or hook, a new env variable or apps-file key with a default, a
  looser limit.
- **Patch:** fixes with no contract change, docs, performance.

## Protocol versions

- `PROTOCOL_VERSION` is the protocol a build speaks; it rises when the wire
  format gains a message or field that a peer **must** understand. An
  addition a peer may ignore does not raise it.
- `MIN_CLIENT_PROTOCOL_VERSION` is the oldest client protocol the server
  accepts. It rises only in a server **major** release, and only after one
  minor release that already warns about the old clients.
- The client refuses a server whose `protocolVersion` is below its own
  `MIN_SERVER_PROTOCOL_VERSION`; the server refuses a client below
  `MIN_CLIENT_PROTOCOL_VERSION` (`PROTOCOL_TOO_OLD`, see
  [`docs/protocol.md`](protocol.md#versioning)).

## Compatibility

| Packages (protocol, client, react) | Server | Protocol                        |
| ---------------------------------- | ------ | ------------------------------- |
| 1.x                                | 1.x    | `PROTOCOL_VERSION` 1, minimum 1 |

Within one major, any client version works with any server version. Keep
`@mosherw/sync-system-client` and `@mosherw/sync-system-protocol` on the same
version if you depend on both: the client depends on the exact protocol
version it was released with.

## Pre-release builds

Nothing was published before 1.0.0. Upgrade notes for the unreleased builds
(join by group ID removed, token format 2, the `MAX_BUFFERED_BYTES` minimum,
Redis storage, unknown variables) are in the 1.0.0 changelog entry and the
operator guide's [Upgrading](operator-guide.md#upgrading) section.
