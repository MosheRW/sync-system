# @mosherw/sync-system-react

## 1.0.0

### Major Changes

- 7c5cb60: First public release, 1.0.0. The protocol, client and React packages and the
  sync server share this one version. The wire protocol is version 1 with a
  minimum client protocol version of 1 (`PROTOCOL_VERSION = 1`,
  `MIN_CLIENT_PROTOCOL_VERSION = 1`); nothing was released before, so there is
  no protocol bump. The packages are published under the `@mosherw` npm scope
  (`@mosherw/sync-system-protocol`, `@mosherw/sync-system-client`,
  `@mosherw/sync-system-react`), licensed GPL-3.0-only, and the server ships as
  the image `ghcr.io/mosherw/sync-system-server` (mirror
  `docker.io/moshewin/sync-system-server`).

  Notes for anyone who ran pre-release builds:

  - **Join by group ID removed (#10):** `group.join` is gone (it gets
    `INVALID_MESSAGE`), and the client's `joinGroup()` with it. Join with
    `group.joinByCode` / `joinByCode()` or `group.joinByQr` / `joinByQr()`.
  - **Token format 2 (#13):** tokens carry a leadership `term` claim. Format 1
    tokens are `TOKEN_INVALID`; clients delete them and groups are created
    again.
  - **`MAX_BUFFERED_BYTES` minimum:** the server refuses to start when
    `MAX_BUFFERED_BYTES` is below 45056 (and below 4 x
    `MAX_MESSAGE_SIZE_CEILING` or the largest roster snapshot plus 32 KiB).
    Unset it (default 262144) or raise it.
  - **Storage can now be Redis (#35):** set `REDIS_URL` to keep groups across
    restarts and to run several instances on one Redis; unset, groups stay in
    memory.
  - **Stop every instance to upgrade:** upgrading from the 9a PR 1 build (Redis
    for one instance) means stopping every instance before starting the new
    ones; old and new instances on one Redis prefix are not supported.
  - **Unknown look-alike env variables stop startup (#36):** a set variable in
    the server's name families (for example `MAX_*`, `REDIS_*`, `SYNC_*`) that
    is not one of its variables is a `Config error`, and the server exits 1.
  - **Package names:** the pre-release workspace packages are renamed to
    `@mosherw/sync-system-*`, and the source export condition is now
    `@mosherw/sync-system-source`.

### Patch Changes

- Updated dependencies [7c5cb60]
  - @mosherw/sync-system-client@1.0.0
