# 0003. Interface languages and how the language is chosen

- Status: Accepted (Gate 2, 2026-11-05: user chose the recommended option)
- Date: 2026-11-05
- Issue: #19

## Context

Content direction is independent of interface direction (AC12). Testing and
demonstrating an RTL interface needs at least one RTL interface language
(designer decision D4). Interface strings must be externalised either way.

## Options

1. **Ship `en` and `he`; choose from `navigator.languages` (first supported
   primary subtag), fallback `en`; an optional env value `READER_UI_LANG`
   (`auto` | `en` | `he`, default `auto`) pins it per deployment
   (recommended).** No i18n library: one typed messages object per language
   (`src/i18n/en.ts`, `src/i18n/he.ts`; the shared type forces every key in
   both) and a small `format(template, values)` for `{n}` placeholders.
2. Same languages with an i18n library (`i18next`, `react-intl`): plurals and
   ICU formats built in, but a new dependency for about 30 strings.
3. `en` only: AC12 testable only through test-only messages; no real RTL
   interface for users.
4. Also `ar` now: needs a reviewed Arabic translation nobody has supplied.

## Decision

Option 1. The interface language sets `<html lang dir>` (`he` gives `rtl`);
the content region carries the document's own `lang`/`dir` (design.md
section 6). Numbers use `Intl.NumberFormat(uiLang)`; library language names
use `Intl.DisplayNames(uiLang)`, falling back to the raw tag.

## Consequences

- Adding a language is one messages file plus one entry in the supported
  list; the type checker reports missing keys.
- No in-app language switcher in v1.
- Hebrew strings need a native-speaker check in QA (copy from design.md,
  translated by the engineer).
