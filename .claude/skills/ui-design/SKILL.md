---
name: ui-design
description: 'UI (visual) design guidance: design tokens, typography, spacing, colour and dark mode, components, layout and responsive behaviour, reading-focused typography, and bootstrapping a design system when none exists. Use when defining or reviewing how screens look, or when choosing or extending a component library or styling approach. Pairs with ux-design for behaviour.'
---

# UI design

UI decides **how it looks**: consistent, readable, themeable. Project decisions in
`docs/conventions.md` and `docs/decisions/` override anything here.

## First: find or found the design system
- **If one exists** (theme file, tokens, Tailwind config, CSS variables,
  `components/ui/`), use it. List the tokens and components you reuse, with file
  paths. Add a new token only if nothing fits, and flag it in design.md.
- **If none exists** (first UI issue in the project), propose a minimal one in
  design.md and mark it as needing an ADR (see `docs-conventions`):
  - Colour: semantic tokens (`--color-bg`, `--color-surface`, `--color-text`,
    `--color-text-muted`, `--color-accent`, `--color-danger`, `--color-border`),
    light and dark values, all text pairs ≥ WCAG AA contrast (4.5:1 body, 3:1 large)
  - Type scale: 5–6 steps with line heights
  - Spacing scale: a 4-px based scale (4, 8, 12, 16, 24, 32, 48)
  - Radius, shadow, and motion tokens (durations, easing; reduced-motion fallback)

## Layout
- Mobile-first; define breakpoints once and reuse them.
- Content width: cap reading text at roughly 60–75 characters per line.
- One primary action per screen, visually dominant; secondary actions quieter.
- Use whitespace and alignment to group things before adding borders or boxes.

## Reading-focused screens
- Body text 16–20 px with line height 1.5–1.7, generous margins, no
  justified text in narrow columns.
- Let users change text size; layout must survive 200% zoom.
- Make page position obvious (page x of y, progress) without crowding the text.
- Keep chrome (toolbars, sync status) unobtrusive and auto-hiding where safe;
  sync status must still be visible at a glance.
- Support RTL when content can be Hebrew/Arabic: logical CSS properties
  (`margin-inline-start`), mirrored icons where meaningful, `dir` set per content.

## Components
For each new or changed component specify: anatomy, variants, sizes, every state
(default, hover, focus-visible, active, disabled, loading, error), and the
tokens used. Don't invent one-off styles.

## Output (into design.md)
Tokens and components reused (with paths) and any new ones, screen layouts as
text wireframes, the component specs above, light/dark notes, contrast checks for
new colour pairs.
