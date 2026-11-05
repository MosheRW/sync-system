# 0002. Styling approach, design tokens and fonts

- Status: Proposed
- Date: 2026-11-05
- Issue: #19

## Context

The reading app is the project's first UI. `docs/issues/19/design.md`
section 10 proposes a minimal token set (colour light/dark, type scale,
spacing, radius, motion, breakpoints): designer decisions D1 and D5. Needs:
logical CSS properties (RTL/LTR independence, AC12-AC14), per-block `dir`,
`white-space: pre-line` (AC33), `prefers-color-scheme`,
`prefers-reduced-motion`, and a strict CSP (`style-src 'self'`, see 0006),
which rules out runtime-injected `<style>` tags. About ten components in
item 7.

## Options

Styling:

1. **CSS Modules + one global `tokens.css` of CSS custom properties
   (recommended).** Built into Vite, no dependency; output is static CSS
   files (CSP-friendly); tokens are plain variables any later framework can
   read. Cons: no utility shorthand; logical-property discipline is checked
   in review, not by a tool.
2. **Tailwind CSS** with the tokens in its config. Fast, has logical
   utilities (`ps-*`, `ms-*`, `text-start`). Cons: new dependency and build
   step for a ten-component app; RTL variants to learn.
3. **CSS-in-JS (styled-components, emotion).** Cons: runtime style injection
   needs `style-src 'unsafe-inline'` or nonces, plus a runtime cost.

Fonts (D5):

- a. **System UI stack with script fallbacks, no web fonts (recommended):**
  `system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Hebrew", "Noto Naskh Arabic", Arial, sans-serif`.
  Fast on phones, offline-friendly, nothing to license or host.
- b. Bundle Hebrew/Arabic web fonts (Noto Sans Hebrew, Noto Naskh Arabic):
  consistent rendering everywhere, but hundreds of KB more and font licence
  notices.

## Decision

Option 1 with fonts a. The design.md section 10 tokens are adopted as written
(colours and contrast pairs, type scale, spacing, radius, motion,
breakpoints) in `apps/reader/src/styles/tokens.css`. Theme follows
`prefers-color-scheme` (no toggle). Physical properties (`left`, `right`,
`margin-left`, ...) are used only where design.md requires a physical side:
`PageNav` button positions, chevrons and progress fill, which follow the
document direction (design.md section 5).

## Consequences

- No styling dependency. Components use `var(--token)` only, never raw colour
  or spacing values.
- Item 8 extends `tokens.css`; changing a token is a design decision.
- Text rendering varies slightly between operating systems (fonts a);
  acceptable for v1.
