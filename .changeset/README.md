# Changesets

This folder holds pending changesets for the published packages and the
sync server ([Changesets](https://changesets.dev), ADR
[0016](../docs/decisions/0016-versioning-and-npm-release.md)).

Add one in every PR with a user-visible change:

```sh
pnpm changeset
```

Pick the packages and the bump (the versioning rules are in
[`docs/versioning.md`](../docs/versioning.md)); protocol, client, react and
server form one fixed group, so they always share one version. The reader is
ignored. A release PR runs `pnpm changeset version`, which consumes these
files and writes the `CHANGELOG.md` files. Releasing is described in
[`RELEASING.md`](../RELEASING.md).
