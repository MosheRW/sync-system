# Security policy

## Supported versions

| Version | Supported                        |
| ------- | -------------------------------- |
| 1.x     | Yes: fixes go into a 1.x release |
| < 1.0   | No (never released)              |

This covers the npm packages `@mosherw/sync-system-protocol`,
`@mosherw/sync-system-client` and `@mosherw/sync-system-react`, and the
server image `ghcr.io/mosherw/sync-system-server` (mirror
`docker.io/mosherw/sync-system-server`).

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a
vulnerability.**

Report it privately through GitHub's private vulnerability reporting: on the
repository page, open **Security**, then **Report a vulnerability**. Include
what is affected (package or image and version), how to reproduce it, and
the impact you see. Do not include real tokens, API keys or personal data;
placeholders are enough.

You get an answer in the report thread. Once a fix is released, the advisory
is published with credit to the reporter unless you ask otherwise.

## Scope notes

- The API key of a browser app is public by design (it identifies the app,
  it grants nothing on its own); finding it in a page is not a
  vulnerability.
- The deployment advice (TLS, a reverse proxy with per-IP limits, Redis on a
  private network, the token secret) is in the
  [operator guide](docs/operator-guide.md#deployment-security); the known
  limits of each release are listed there too.
