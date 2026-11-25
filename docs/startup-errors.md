# Startup errors

Every error the sync server (`apps/sync-server`) and the reader (`apps/reader`)
can print when they refuse to start, with the fix for each. A test checks this
list against the invalid-config tests of both packages, so a message that is
not listed here fails CI.

## How to read this list

- `Config error: <problem>`: the configuration is wrong. Fix the environment
  variable or the apps file the line names, then start again.
- `Startup error: <message>`: the configuration is valid, but the environment
  or the image is not (Redis, the port, a missing file).
- Both print to stderr and exit with code 1. Nothing listens, and nothing is
  logged before the config loaded.
- The server and the reader check **every** setting before they stop and print
  **every** problem of one run, one prefixed line each. Fix them all, not just
  the first.
- With an invalid ceiling (for example `MAX_GROUP_SIZE_CEILING=abc`), the apps
  file checks that compare a value with that ceiling are skipped; the run still
  fails. An app value above the ceiling you meant shows up in the next run.

Placeholders in the messages below:

| Placeholder | Stands for                                                                               |
| ----------- | ---------------------------------------------------------------------------------------- |
| `<name>`    | an environment variable name, or a JSON key name in the apps file                        |
| `<n>`       | a number the server has already parsed and validated                                     |
| `<path>`    | the apps file path (`SYNC_CONFIG_PATH`)                                                  |
| `<file>`    | a secret file path (`TOKEN_SECRET_FILE`, `TOKEN_SECRET_PREVIOUS_FILE`, `REDIS_URL_FILE`) |
| `<where>`   | the apps entry: `apps[<n>]`, or `apps[<n>] (namespace "<value>")` when it is valid       |
| `<field>`   | an apps entry field, such as `maxGroupSize`                                              |
| `<value>`   | a value the message is allowed to show (see the echo rules)                              |
| `<code>`    | a system error code, such as `EACCES`                                                    |
| `<reason>`  | one of the reasons listed under the message                                              |
| `<known>`   | the known variable name closest to the one you set                                       |

## What a message may show (echo rules)

The sync server never prints a value it received. A message may show only:

- environment variable names (a flagged unknown name is cut at 48 characters
  and ends in `...`);
- integers the server has already parsed and validated (ceilings and the rules
  that compare them);
- namespaces that match the namespace pattern;
- the apps file path and JSON key names of unknown fields, with control
  characters replaced by `?` and cut at 64 characters plus `...`;
- the path of a secret file that exists (`TOKEN_SECRET_FILE`,
  `TOKEN_SECRET_PREVIOUS_FILE`, `REDIS_URL_FILE`), shown the same way; never
  the path of one that does not exist, and never the file's content;
- system error codes (`errno`, such as `EACCES`).

It never shows a token secret, any part of `REDIS_URL` (user, password or
host), an API key, or the text of a parser or file-system error.

The reader shows the offending value of a non-secret `READER_*` variable,
cut at 40 characters plus `…`, so you can see what it read. In a URL
(`READER_SYNC_URL`, `READER_SRC_ORIGINS`), everything up to the last `@` is
replaced by `***`, so a user name or password is never shown.
`READER_SYNC_API_KEY` is never shown. Do not put a secret in another
`READER_*` variable: its start would be printed.

## Sync server

### Config error: environment variables

| Message                                                                                                      | Fix                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `Config error: <name> must be a positive integer`                                                            | Set digits only, no sign, decimal point or leading zero, or unset it for the default. |
| `Config error: <name> must be between <n> and <n>`                                                           | Set a value in the range (see "Environment variables" in `docs/operator-guide.md`).   |
| `Config error: LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent`                      | Use one of the listed levels.                                                         |
| `Config error: HOST must not be empty`                                                                       | Unset `HOST` (default `0.0.0.0`) or set an address to bind.                           |
| `Config error: SYNC_CONFIG_PATH must not be empty`                                                           | Unset it (default `./config/apps.json`) or set the apps file path.                    |
| `Config error: JOIN_METHODS_ALLOWED must be a non-empty comma-separated list of distinct methods A, B, C, D` | Use upper-case letters from A to D, each once, for example `A,D`.                     |

`NODE_ENV` has no invalid value: anything other than `development` or `test`
is treated as production.

### Config error: rules that span variables

| Message                                                                                                                              | Fix                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `Config error: MAX_APP_CONNECTIONS_CEILING (<n>) must be <= MAX_CONNECTIONS (<n>)`                                                   | Lower `MAX_APP_CONNECTIONS_CEILING` or raise `MAX_CONNECTIONS`.                    |
| `Config error: MAX_PENDING_HANDSHAKES (<n>) must be <= MAX_CONNECTIONS (<n>)`                                                        | Lower `MAX_PENDING_HANDSHAKES` or raise `MAX_CONNECTIONS`.                         |
| `Config error: MAX_INBOUND_MESSAGES_PER_SECOND (<n>) must be > MAX_LEADER_UPDATE_RATE_CEILING (<n>)`                                 | Raise `MAX_INBOUND_MESSAGES_PER_SECOND` or lower `MAX_LEADER_UPDATE_RATE_CEILING`. |
| `Config error: MAX_INBOUND_BURST (<n>) must be >= MAX_INBOUND_MESSAGES_PER_SECOND (<n>)`                                             | Raise `MAX_INBOUND_BURST` or lower `MAX_INBOUND_MESSAGES_PER_SECOND`.              |
| `Config error: MAX_BUFFERED_BYTES (<n>) must be >= 4 * MAX_MESSAGE_SIZE_CEILING (<n>)`                                               | Raise `MAX_BUFFERED_BYTES` or lower `MAX_MESSAGE_SIZE_CEILING`.                    |
| `Config error: MAX_BUFFERED_BYTES (<n>) must be >= the largest tokens.result frame (<n>)`                                            | Raise `MAX_BUFFERED_BYTES` to at least the number shown.                           |
| `Config error: MAX_BUFFERED_BYTES (<n>) must be >= the largest roster snapshot plus headroom (<n>) for MAX_GROUP_SIZE_CEILING (<n>)` | Raise `MAX_BUFFERED_BYTES` or lower `MAX_GROUP_SIZE_CEILING`.                      |
| `Config error: TOKEN_REFRESH_MIN_SECONDS (<n>) must be <= TOKEN_REFRESH_MAX_SECONDS (<n>)`                                           | Lower `TOKEN_REFRESH_MIN_SECONDS` or raise `TOKEN_REFRESH_MAX_SECONDS`.            |
| `Config error: MAX_LIVE_GROUPS_PER_APP (<n>) must be > 2 * MAX_GROUP_CREATE_BURST_PER_APP (<n>)`                                     | Raise `MAX_LIVE_GROUPS_PER_APP` or lower `MAX_GROUP_CREATE_BURST_PER_APP`.         |

A rule is checked only when every number it compares is valid on its own.

### Config error: Redis settings

In the URL rows, `<name>` is `REDIS_URL`, or
`REDIS_URL (from REDIS_URL_FILE)` when the URL was read from a file.

| Message                                                                                                                     | Fix                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Config error: REDIS_URL must not be empty`                                                                                 | Unset `REDIS_URL` for the memory store, or set a `redis://` or `rediss://` URL.                                          |
| `Config error: <name> is not a valid redis:// or rediss:// URL`                                                             | Use `redis://[user:password@]host[:port][/db]` (`rediss://` for TLS); percent-encode special characters in the password. |
| `Config error: <name> must not have a query string or fragment`                                                             | Remove everything from `?` or `#`.                                                                                       |
| `Config error: <name> port must be between 1 and 65535`                                                                     | Fix the port.                                                                                                            |
| `Config error: <name> database must be a number from 0 to 15`                                                               | Fix the database number after the `/`.                                                                                   |
| `Config error: <name> uses the public development Redis password; it is only accepted when NODE_ENV is development or test` | Set a real Redis password (and the same on the Redis server).                                                            |
| `Config error: REDIS_KEY_PREFIX must be 1-32 characters of a-z, 0-9, _ and -, starting with a letter or digit`              | Fix the prefix, or unset it for the default `sync`.                                                                      |
| `Config error: REDIS_CONNECT_TIMEOUT_SECONDS must be an integer between 1 and 120`                                          | Set a value in the range, or unset it for the default.                                                                   |
| `Config error: REDIS_COMMAND_TIMEOUT_MS must be an integer between 100 and 30000`                                           | Set a value in the range, or unset it for the default.                                                                   |

### Config error: token secrets

`<name>` is `TOKEN_SECRET` or `TOKEN_SECRET_PREVIOUS`, or
`TOKEN_SECRET (from TOKEN_SECRET_FILE)` and
`TOKEN_SECRET_PREVIOUS (from TOKEN_SECRET_PREVIOUS_FILE)` when the value was
read from a file. A file value goes through the same rules.

| Message                                                                                     | Fix                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| ``Config error: TOKEN_SECRET is required (use `openssl rand -base64 32`)``                  | Set `TOKEN_SECRET`. It may be unset only when `NODE_ENV` is `development` or `test`.                                           |
| `Config error: <name> must not start or end with whitespace`                                | Remove the spaces or line breaks around the value (a secret is used exactly as given). A secret file may end in one newline (` |
| `or`                                                                                        |
| `); anything else, such as a second newline, a lone `                                       |
| ` or a byte order mark, counts.                                                             |
| ``Config error: <name> must be at least 32 bytes (use `openssl rand -base64 32`)``          | Generate a new secret with the command shown.                                                                                  |
| `` Config error: <name> is an example value from the docs; use `openssl rand -base64 32` `` | Generate a new secret; never use a value printed in the docs.                                                                  |
| `` Config error: <name> is the public development secret; use `openssl rand -base64 32` ``  | Generate a new secret; the development secret is accepted only in development and test.                                        |
| `` Config error: <name> looks weak; use `openssl rand -base64 32` ``                        | Generate a new secret with the command shown.                                                                                  |
| `Config error: TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET`                         | Set the new secret in `TOKEN_SECRET` and the old one in `TOKEN_SECRET_PREVIOUS`.                                               |

### Config error: secret files

`<name>` is `TOKEN_SECRET_FILE`, `TOKEN_SECRET_PREVIOUS_FILE` or
`REDIS_URL_FILE`: the variables that name a file holding a secret
(see "Passing secrets to the container" in `docs/operator-guide.md`). A
message never shows the file's content. `<file>` is the path you set, with
control characters replaced by `?` and cut at 64 characters plus `...`; it
is shown only when the path exists, so a secret pasted into the variable by
mistake is never printed.

| Message                                                                 | Fix                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config error: <name> and <name> are both set; set only one`            | Remove one of the two, for example a leftover `TOKEN_SECRET:` line or `sh` wrapper next to `TOKEN_SECRET_FILE`. This is an error even when one of them is set to an empty value.                                                                   |
| `Config error: <name> must not be empty`                                | Unset it, or set it to the path of the secret file (for example `/run/secrets/sync_token_secret`).                                                                                                                                                 |
| `Config error: <name> file does not exist`                              | Check the path inside the container (a relative path starts at the working directory) and that the secret is mounted there. Set the path, never the secret itself.                                                                                 |
| `Config error: <name> file "<file>" is not readable by the server user` | The server runs as uid 1000 (`node`). On the host, `chown 1000:1000` the file and `chmod 400` it (compose `secrets: file:` is a bind mount, so the host owner and mode apply). Do not make it world-readable and do not run the container as root. |
| `Config error: <name> file "<file>" is not a regular file`              | Point the variable at the file itself, not at a directory, pipe or device.                                                                                                                                                                         |
| `Config error: <name> file "<file>" is larger than 4096 bytes`          | The path names the wrong file; a secret file holds one value.                                                                                                                                                                                      |
| `Config error: <name> file "<file>" is empty`                           | Write the secret into the file. A file holding only a newline is empty too.                                                                                                                                                                        |
| `Config error: <name> file "<file>" is not valid UTF-8`                 | Write the secret as UTF-8 text (`openssl rand -base64 32` output is).                                                                                                                                                                              |
| `Config error: <name> file "<file>" contains a NUL character`           | Write the secret as plain text; a NUL byte cannot be in an environment value either.                                                                                                                                                               |
| `Config error: <name> file cannot be read (<code>)`                     | Another file-system error; check the path and the mount.                                                                                                                                                                                           |

### Config error: unknown variables

A set variable whose name starts with `MAX_`, `TOKEN_`, `REDIS_`, `SYNC_`,
`JOIN_`, `QR_`, `APPROVAL_`, `DISCONNECT_`, `KEEP_ALIVE_` or `INACTIVITY_`, or
ends with `_CEILING`, must be one of the server's variables
([ADR 0015](decisions/0015-unknown-environment-variables.md)). Only the name is
printed, never the value.

| Message                                                                                                                                 | Fix                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config error: <name> is not a sync server variable; did you mean <known>?`                                                             | Rename it to the suggested variable.                                                                                                                                                                |
| `Config error: <name> is not a sync server variable; remove it or fix the name (see "Environment variables" in docs/operator-guide.md)` | Remove it, fix the name, or, for a helper variable of your own (for example `REDIS_PASSWORD` or `REDIS_HOST` used to build `REDIS_URL`), rename it outside these prefixes (for example `PW_REDIS`). |

### Config error: apps file

| Message                                                                                                                  | Fix                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `Config error: <path>: config file not found (set SYNC_CONFIG_PATH)`                                                     | Mount the apps file there, or point `SYNC_CONFIG_PATH` at it.                                                |
| `Config error: <path>: cannot read config file (<code>; check that the server user can read it)`                         | Make the file readable by the server's user (`node` in the image), and check it is a file.                   |
| `Config error: <path>: not valid JSON (line <n>, column <n>)`                                                            | Fix the JSON at that position.                                                                               |
| `Config error: <path>: not valid JSON`                                                                                   | Fix the JSON (for example, an empty file).                                                                   |
| `Config error: <path>: must be a JSON object with an "apps" array`                                                       | Wrap the entries in `{"apps": [...]}`.                                                                       |
| `Config error: <path>: "apps" must be a non-empty array`                                                                 | Add at least one app.                                                                                        |
| `Config error: <path>: apps[<n>] must be an object`                                                                      | Make each entry a JSON object.                                                                               |
| `Config error: <path>: <where>: unknown field(s): <name> (remove them or fix their names)`                               | Remove the fields or fix their spelling.                                                                     |
| `Config error: <path>: <where>: <field> is required`                                                                     | Add the field.                                                                                               |
| `Config error: <path>: <where>: namespace must match ^[a-z0-9][a-z0-9_-]{0,62}$`                                         | Use lower-case letters, digits, `_` and `-`, starting with a letter or digit.                                |
| `Config error: <path>: <where>: apiKey must be a string of 32-256 characters`                                            | Use a long random key, for example from `openssl rand -base64 32`.                                           |
| `Config error: <path>: <where>: minAppVersion must be a semver string of at most 64 characters`                          | Use a version like `1.2.0`.                                                                                  |
| `Config error: <path>: <where>: <field> must be an integer`                                                              | Use a whole number.                                                                                          |
| `Config error: <path>: <where>: <field> must be an integer >= <n>`                                                       | Raise the value to at least the number shown.                                                                |
| `Config error: <path>: <where>: <field> <n> exceeds <name> <n> (lower <field> or raise <name>)`                          | Do what the message says.                                                                                    |
| `Config error: <path>: <where>: keepAliveCountdownSeconds <n> must be less than inactivityLimitMinutes in seconds (<n>)` | Lower `keepAliveCountdownSeconds` or raise `inactivityLimitMinutes`.                                         |
| `Config error: <path>: <where>: defaultHandoff must be "auto" or "frozen"`                                               | Use one of the two values, or remove the field (default `auto`).                                             |
| `Config error: <path>: <where>: joinMethods must be a non-empty array of distinct methods "A", "B", "C", "D"`            | List each method once, for example `["A", "D"]`.                                                             |
| `Config error: <path>: <where>: joinMethods "<value>" is not in JOIN_METHODS_ALLOWED`                                    | Remove the method from the app, or add it to `JOIN_METHODS_ALLOWED`.                                         |
| `Config error: <path>: <where>: joinMethods is required because JOIN_METHODS_ALLOWED does not include A or D`            | Set `joinMethods` for the app (the default is `["A", "D"]`).                                                 |
| `Config error: <path>: apps[<n>] has the same namespace "<value>" as apps[<n>] (each app needs its own namespace)`       | Give each app its own namespace.                                                                             |
| `Config error: <path>: <where> has the same apiKey as <where> (each app needs its own key)`                              | Give each app its own key.                                                                                   |
| `Config error: <where> uses the public development API key; set a real key`                                              | Replace the key from `config/apps.dev.json`; it is accepted only when `NODE_ENV` is `development` or `test`. |

### Startup error

| Message                                                                                         | Fix                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Startup error: cannot read the server version: package.json not found next to the server code` | The image or install is incomplete: `package.json` must sit next to `dist/` (`/app/package.json` in the image). Rebuild it. |
| `Startup error: cannot read the server version: package.json cannot be read (<code>)`           | Make `package.json` readable by the server's user.                                                                          |
| `Startup error: cannot read the server version: package.json is larger than 64 KiB`             | The wrong file is in place: restore the server's own `package.json`.                                                        |
| `Startup error: cannot read the server version: package.json is not valid JSON`                 | Restore the server's own `package.json`.                                                                                    |
| `Startup error: cannot read the server version: package.json is not the sync server's`          | Restore the server's own `package.json` (its `name` is `@mosherw/sync-system-server`).                                      |
| `Startup error: cannot read the server version: package.json has no valid semver version`       | Restore the server's own `package.json`.                                                                                    |
| `Startup error: Redis is unreachable (REDIS_URL)`                                               | Check that Redis runs and that the host and port in `REDIS_URL` are reachable from the server.                              |
| `Startup error: Redis authentication failed (REDIS_URL)`                                        | Check the user and password in `REDIS_URL`, and that the user may run the server's commands.                                |
| `Startup error: Redis TLS handshake failed (REDIS_URL)`                                         | Check `rediss://` against the server's TLS setup and certificate.                                                           |
| `Startup error: Redis 7.2 or later is required`                                                 | Upgrade Redis (or Valkey) to 7.2 or later.                                                                                  |
| `Startup error: Redis connection failed (REDIS_URL)`                                            | Any other Redis failure while connecting or starting; check the Redis logs and `REDIS_URL`.                                 |
| `Startup error: cannot listen on port <n> (<code>)`                                             | `EADDRINUSE`: another process uses the port; `EACCES`: the port needs privileges; `EADDRNOTAVAIL`: fix `HOST`.              |

## Reader

### Config error

| Message                                                                                                                                      | Fix                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Config error: READER_ENTRY "<value>" must be one of: library, error, default-book, single-book`                                             | Use one of the listed entries.                                                                                                     |
| `Config error: READER_UI_LANG "<value>" must be one of: auto, en, he`                                                                        | Use one of the listed languages.                                                                                                   |
| `Config error: READER_LIBRARY "<value>" must be one of: on, off`                                                                             | Use `on` or `off`.                                                                                                                 |
| `Config error: READER_BOOK is required when READER_ENTRY is <value>`                                                                         | Set `READER_BOOK` to a bundled content ID.                                                                                         |
| `Config error: READER_BOOK is set but READER_ENTRY is <value>, which never opens it (use default-book or single-book, or unset READER_BOOK)` | Do what the message says.                                                                                                          |
| `Config error: READER_BOOK "<value>" is not a content ID (namespace/slug)`                                                                   | Use an ID like `samples/psalms-he`.                                                                                                |
| `Config error: READER_BOOK "<value>" is not a bundled book`                                                                                  | Use the ID of a book in the library, or add the book and rebuild.                                                                  |
| `Config error: READER_LIBRARY is off but READER_ENTRY is library (the library page is the entry)`                                            | Set `READER_LIBRARY=on` or pick another entry.                                                                                     |
| `Config error: READER_LIBRARY must be off when READER_ENTRY is single-book`                                                                  | Set `READER_LIBRARY=off` or unset it.                                                                                              |
| `Config error: READER_LIBRARY is on but no books are bundled (add content or set READER_LIBRARY=off)`                                        | Do what the message says.                                                                                                          |
| `Config error: READER_SRC_ORIGINS entry "<value>" <reason>`                                                                                  | Use exact origins like `https://content.example.org` (see below).                                                                  |
| `Config error: <name> "<value>" must be an integer from <n> to <n>`                                                                          | Set a whole number in the range (`READER_FETCH_TIMEOUT_SECONDS`, `READER_SRC_MAX_BYTES`, `READER_SYNC_LATE_JOIN_SECONDS`, `PORT`). |
| `Config error: READER_SYNC_URL "<value>" <reason>`                                                                                           | Use `wss://host[:port]/path` (`ws:` only for localhost) (see below).                                                               |
| `Config error: READER_SYNC_API_KEY is required when READER_SYNC_URL is set`                                                                  | Set the app's key from the sync server's apps file.                                                                                |
| `Config error: READER_SYNC_API_KEY must be 32 to 256 visible ASCII characters with no spaces (the value is not shown)`                       | Copy the key again, without spaces or line breaks.                                                                                 |
| `Config error: READER_SYNC_API_KEY is set but READER_SYNC_URL is not (set both, or neither)`                                                 | Set `READER_SYNC_URL` too, or unset the key.                                                                                       |
| `Config error: READER_SYNC_APP_VERSION "<value>" must be a semantic version like 1.2.3 (at most 64 characters)`                              | Use a version like `1.4.0`.                                                                                                        |
| `Config error: READER_SYNC_APP_VERSION is set but READER_SYNC_URL is not`                                                                    | Set `READER_SYNC_URL` too, or unset it.                                                                                            |
| `Config error: READER_SYNC_LATE_JOIN_SECONDS is set but READER_SYNC_URL is not`                                                              | Set `READER_SYNC_URL` too, or unset it.                                                                                            |
| `Config error: <name> is not a reader variable; did you mean <known>?`                                                                       | Rename it to the suggested variable.                                                                                               |
| `Config error: <name> is not a reader variable; remove it or fix the name (see "Configuration" in apps/reader/README.md)`                    | Remove it or fix the name: every set `READER_*` name must be a reader variable.                                                    |

`<reason>` for `READER_SRC_ORIGINS`: `is not a URL`; `must use https: (or http:
for localhost)`; `must use https: (http: is allowed only for localhost and
127.0.0.1)`; `must not contain a user name or password`; `must not contain a
wildcard`; `must have a plain host name or IPv4 address (letters, digits,
hyphens and dots)`; `must be an exact origin like https://host[:port] (no
path, query, trailing slash, uppercase or default port)`.

`<reason>` for `READER_SYNC_URL`: `is not a URL`; `must use wss: (or ws: for
localhost)`; `must use wss: (ws: is allowed only for localhost and
127.0.0.1)`; `must not contain a user name or password`; `must not contain a
query`; `must not contain a fragment`; `must have a plain host name or IPv4
address (letters, digits, hyphens and dots)`.

`HOST` and `NODE_ENV` have no invalid value in the reader. A `HOST` that
cannot be bound gives `Startup error: cannot listen on port <n> (<code>)`.

### Startup error

| Message                                                                              | Fix                                                                                                            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `Startup error: dist/library-index.json is missing or invalid (run the build first)` | Build the reader (`pnpm --filter @mosherw/sync-system-reader build`) or use the image.                         |
| `Startup error: dist/index.html is missing or has no config placeholder`             | Rebuild the reader; do not edit `dist/index.html` by hand.                                                     |
| `Startup error: cannot listen on port <n> (<code>)`                                  | `EADDRINUSE`: another process uses the port; `EACCES`: the port needs privileges; `EADDRNOTAVAIL`: fix `HOST`. |

## Not caught

- Typos of the generic names `PORT`, `HOST`, `LOG_LEVEL` and `NODE_ENV` (for
  example `PROT`): they are in no family, so they are ignored like any other
  unrelated variable.
- Names shaped like platform link variables, which Kubernetes and Docker set
  on their own: ending in `_SERVICE_HOST`, `_SERVICE_PORT`,
  `_SERVICE_PORT_<name>`, `_PORT`, `_PORT_<n>_TCP|UDP|SCTP` (optionally
  `_ADDR`, `_PORT`, `_PROTO`), `_NAME` or `_ENV_<name>`. A typo such as
  `REDIS_PORT` is therefore not caught.
- `SYNC_TEST_*` names: the repo's test harness.
