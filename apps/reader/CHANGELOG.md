# @mosherw/sync-system-reader

The reading app has its own version, outside the packages' release group,
and is never published to npm. This file is written by hand with each
reader release ([ADR 0023](../../docs/decisions/0023-reader-version-tag-and-image.md),
[`docs/versioning.md`](../../docs/versioning.md)).

## 1.0.0

First public release of the reading app as a Docker image,
`ghcr.io/mosherw/sync-system-reader` (mirror
`docker.io/moshewin/sync-system-reader`), tags `1.0.0`, `1.0`, `1` and
`latest`, for `linux/amd64` and `linux/arm64`. Git tag `reader-v1.0.0`. The
[README](README.md) says how to run it.

- `/health` now answers JSON `{"status":"ok","version":"1.0.0"}` (it was the
  text `ok`); it is still liveness only, with no `/ready`.
- The image carries the OCI labels (`source`, `licenses`, `title`,
  `description`, and `version` and `revision` from the release) and the
  `LICENSE` file in `/app`.
- The sync client's default `appVersion` (`READER_SYNC_APP_VERSION` unset)
  is now `1.0.0`.
