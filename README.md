# Sync System

Group Reading Sync: a sync service that lets an ad-hoc group follow one
leader's position in real time, and a reading app that is its first
customer. The server syncs a **position, not a page**: it stores and relays an
opaque payload and never reads it. Groups are ephemeral; nothing outlives a
group.

## What is here

| Package                         | Path                | Published as                                                                               | What                                                    |
| ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `@mosherw/sync-system-protocol` | `packages/protocol` | npm                                                                                        | Wire protocol: versions, error codes, message schemas.  |
| `@mosherw/sync-system-client`   | `packages/client`   | npm                                                                                        | Framework-free client for browsers and Node.            |
| `@mosherw/sync-system-react`    | `packages/react`    | npm                                                                                        | React/Next provider and hooks over the client.          |
| `@mosherw/sync-system-server`   | `apps/sync-server`  | image `ghcr.io/mosherw/sync-system-server` (mirror `docker.io/mosherw/sync-system-server`) | The sync server (HTTP `/health`, `/ready` + WebSocket). |
| `@mosherw/sync-system-reader`   | `apps/reader`       | not published                                                                              | The reading app (React + Vite, Node server).            |

The three npm packages and the server share one version number (see
[`docs/versioning.md`](docs/versioning.md)). `packages/*` holds libraries and
`apps/*` holds deployables.

## Quick start

Try the server and the reading app together (development settings, loopback
only):

```sh
docker compose up --build    # sync server on 127.0.0.1:8080, reader on http://127.0.0.1:8081
```

Run the server in production from the published image: see
[Install with Docker Compose](docs/operator-guide.md#install-with-docker-compose).
Add groups to your own app:

```sh
npm install @mosherw/sync-system-react react
```

and follow the [integration guide](docs/integration-guide.md).

## Documentation

| For                       | Read                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Running the server        | [Operator guide](docs/operator-guide.md): install, config file, every env variable, Redis, several instances, upgrading, security |
| Startup errors            | [`docs/startup-errors.md`](docs/startup-errors.md): every message and its fix                                                     |
| Building an app           | [Integration guide](docs/integration-guide.md), with the reading app as the worked example                                        |
| The client API            | [`packages/client/README.md`](packages/client/README.md)                                                                          |
| The React API             | [`packages/react/README.md`](packages/react/README.md)                                                                            |
| The wire protocol         | [`docs/protocol.md`](docs/protocol.md) and [`packages/protocol/README.md`](packages/protocol/README.md)                           |
| The reading app           | [`apps/reader/README.md`](apps/reader/README.md): content schema, fingerprint, direction rules, configuration, groups             |
| Versions and upgrades     | [`docs/versioning.md`](docs/versioning.md), and each package's `CHANGELOG.md`                                                     |
| Releasing                 | `RELEASING.md` (maintainer, added with the release procedure)                                                                     |
| Reporting a vulnerability | [`SECURITY.md`](SECURITY.md)                                                                                                      |
| Project decisions         | [`docs/conventions.md`](docs/conventions.md) and the ADRs in [`docs/decisions/`](docs/decisions/)                                 |

## Development

A pnpm workspace (Node 24, pnpm 10, TypeScript, ESM).

```sh
corepack enable          # uses the pnpm version pinned in package.json
pnpm install
pnpm lint                # eslint, prettier --check and the docs link check
pnpm typecheck
pnpm test                # vitest in every package, plus the release script tests
pnpm build
pnpm pack:check          # the published tarballs hold only what they should
pnpm smoke               # install the packed tarballs into a clean project
pnpm audit               # high and critical advisories
```

Run the server from source with
[Run from source](docs/operator-guide.md#run-from-source), and the reader
with `pnpm --filter @mosherw/sync-system-reader dev` (see its README).
Changes that users see add a changeset (`pnpm changeset`, see
[`.changeset/README.md`](.changeset/README.md)).

## License

GPL-3.0-only: see [`LICENSE`](LICENSE). Every package, including the
published client and React packages, is under the GPL. **An app that bundles
`@mosherw/sync-system-client` or `@mosherw/sync-system-react` and ships that
bundle (browser bundles included) is bound by the GPL's terms.**
