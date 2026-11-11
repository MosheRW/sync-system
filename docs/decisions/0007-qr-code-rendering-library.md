# 0007. QR code rendering library for the reader

- Status: Accepted (Gate 2, 2026-11-07: user chose the recommended option)
- Date: 2026-11-06
- Issue: #24

## Context

The leader's screen shows a QR code that encodes a deep link to the reader
with a QR ticket in the URL fragment (#24 AC12, Decision Q2). The ticket is a
bearer credential, so the QR is drawn in the browser from data that never
leaves the page. Scanning uses the phone's own camera app; there is no
in-app scanner and `Permissions-Policy: camera=()` stays (Q2).

Constraints:

- One small, dependency-free library (Q2), audited for size, dependencies,
  licence and maintenance; a security plan review is required.
- The CSP stays strict (ADR 0006, #19 C7): no `data:`/`blob:` in `img-src`,
  no `'unsafe-inline'`, no `'unsafe-eval'`. The QR must therefore be drawn as
  React SVG elements (or a canvas), never as a `data:` URL image and never
  through `innerHTML` (banned by ESLint, #19 C6).
- The payload is short: origin + `/?book=<id>` (or an allow-listed
  `?src=<url>`) + `#t=<ticket>`; a ticket is at most 256 characters
  (`MAX_QR_TICKET_LENGTH`). Typical links are 150-350 bytes (QR version
  8-13 at error correction M).
- The library ships in the browser bundle only; the reader's runtime image
  keeps zod as its only runtime dependency (it is a dev dependency, like
  React and `@sync-system/react`).

Audit (npm registry and the published tarballs, 2026-11-06; "entry" is the
ESM file the bundler imports, measured raw and gzipped):

| Package                        | Version, last release | Licence           | Runtime deps                       | Entry size           | Maintainers       | History                                     |
| ------------------------------ | --------------------- | ----------------- | ---------------------------------- | -------------------- | ----------------- | ------------------------------------------- |
| `lean-qr`                      | 2.7.4, 2026-09-07     | MIT               | 0                                  | 6.9 KB / 3.6 KB gz   | 1 (davidje13)     | since 2021, 29 releases, 5 in the last year |
| `qr` (paulmillr)               | 0.7.2, 2026-09-28     | MIT or Apache-2.0 | 0                                  | 43.7 KB / 14.2 KB gz | 1 (paulmillr)     | rewritten 2023, pre-1.0, very active        |
| `qrcode-generator`             | 2.0.4, 2025-08-07     | MIT               | 0                                  | 51.9 KB / 11.2 KB gz | 1 (kazuhikoarase) | since 2014, 24 releases                     |
| `uqr` (unjs)                   | 0.1.3, 2026-04-03     | MIT               | 0                                  | 27.5 KB / 7.8 KB gz  | 2                 | pre-1.0, quiet 2023-2026                    |
| `qrcode` (soldair)             | 1.5.4                 | MIT               | 3 (`pngjs`, `yargs`, `dijkstrajs`) | larger               | 1                 | not dependency-free: excluded               |
| Vendored Nayuki `qrcodegen.ts` | n/a                   | MIT               | 0                                  | ~30 KB source        | us                | no npm dependency; we maintain the copy     |

None of the four npm candidates has an install script. A text search of each
entry file found no `eval`, `new Function` or `innerHTML`.

## Options

1. **`lean-qr` (recommended).** `generate(text, { minCorrectionLevel })`
   returns a bitmap with `size` and `get(x, y)`; the reader turns it into one
   SVG `<path>` in React. Smallest by far (3.6 KB gz), zero dependencies,
   typed, ESM, MIT, steady releases. Its optional `extras/*` (React
   component, SVG and data-URL helpers) are not used. Con: one maintainer.
2. **`qr` (paulmillr).** Security-minded author (the noble libraries), very
   active, zero dependencies, raw matrix output. Cons: 4x larger, pre-1.0
   API, encoder and decoder in one entry.
3. **`qrcode-generator`.** Long history, zero dependencies. Cons: 3x larger,
   its convenient outputs are HTML strings and data URLs (`createSvgTag`,
   `createDataURL`), which we must avoid; slower release cadence.
4. **`uqr`.** Small API returning a boolean matrix. Cons: pre-1.0, little
   activity, twice the size of `lean-qr`.
5. **Vendor Nayuki's reference generator.** No supply-chain dependency at
   all. Cons: ~1,000 lines we own, review and update ourselves; no upstream
   security fixes.

## Decision

Accepted: **`lean-qr`**, pinned to an exact version (`2.7.4`, no range) as a
dev dependency of `apps/reader`, imported from one module only
(`src/components/group/QrCodeView.tsx`) through its main entry, drawn as an
SVG `<path>` with error correction M, a 4-module quiet zone and fixed
`--color-qr-dark` / `--color-qr-light` colours. Runner-up: `qr` (paulmillr).

## Consequences

- The CSP needs no change for the QR (no `data:`, no `blob:`, no inline
  style attributes in markup).
- One new third-party package in the browser bundle (about 3.6 KB gz).
  `pnpm audit --audit-level=high` covers it; the lockfile pins its
  integrity hash; upgrades are deliberate (exact pin).
- A ticket or link too long for a QR code (over version 40 at level L)
  shows the design's "Can't show a QR code right now" state, never a crash.
- If `lean-qr` is abandoned, swapping to option 2 or 5 touches one module.
