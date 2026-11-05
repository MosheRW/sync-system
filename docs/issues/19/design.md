# Design: #19 reading app content, text direction (RTL) and content fingerprint

Scope: item 7 only. This covers the reading screen, page navigation and its
mirroring, interface vs content direction, mixed-direction blocks, and the
loading / error / blocked states that item 7 itself produces.
Not designed here (item 8): join flow, code/QR, approval, connection indicator,
leader views, follower "jump" prompt, late-joiner countdown, and the
content-mismatch warn/block screens. The layout reserves slots for them (see
"Reserved slots").

No reading app or design system exists yet. Framework and styling approach are
undecided (architect, ADR at Gate 2). Everything below is framework-agnostic:
behaviour, layout, semantic HTML attributes and tokens. Where a styling choice
is implied, it is marked **proposal**.

---

## 1. Users and context

| User | Goal | Context |
|---|---|---|
| Reader (any language) | Read a sequence of pages comfortably | Mostly phones, one hand, often in a room with others; tablets and laptops too |
| Hebrew / Arabic reader | Book feels native: RTL text, RTL page order, reversed swipe | Same |
| Mixed-language reader | English quotes in a Hebrew book (and the reverse) render correctly | Same |
| Reader with an interface in one language and content in another | Neither side breaks the other | Same |
| Screen-reader / keyboard user | Know which page they are on, turn pages without a pointer | Laptop or phone with VoiceOver / TalkBack |
| Content author / app developer | Understand why a file was refused | Usually at a desk, testing a file |

Attention: readers look at the text, not the chrome. Chrome stays quiet, the
text dominates.

## 2. Flows

### Flow A: open content and read (happy path)
1. App starts with a content source (bundled sample or URL; how the source is
   chosen is the architect's call, see Open questions).
2. Loader runs. Bundled content: no visible loading state in practice.
   Fetched content: loading state (see state table; shown only after 300 ms).
3. Validation and schema-version check pass; fingerprint is computed.
4. **Reading screen shows page 1.** Goal achieved: the reader can read.
5. Reader turns pages with the next/previous controls, keyboard or swipe.
6. On the first page "Previous" is unavailable; on the last page "Next" is
   unavailable (see component states).

### Flow B: fetch fails (recoverable)
1-2. As A.
3. Network error, non-2xx, or timeout.
4. Fetch-failure state with **Try again**. Try again returns to step 2.
5. If retry succeeds, continue at A3.

### Flow C: content refused (not recoverable in-app)
1-3. As A, but validation fails (malformed JSON, wrong types, missing pages,
   bad direction value, bad content ID) or the schema version is missing /
   not a valid version / outside the supported range.
4. Blocked state for the specific reason. Nothing from the file renders
   (no partial pages, no title from the file).
5. Only exit: **Go back** if the app has a previous screen (for example a
   content list or item 8's join flow); otherwise no action.

### Flow D: mismatch (logic only in item 7)
Item 7 returns `match | different-content | different-version |
unsupported-schema` and the outcome `warn | block`. Item 8 designs the screens.
The only item-7 UI rule: when the outcome is `block` for the *local* file's own
schema, Flow C's "unsupported schema" state applies (AC16 = AC3).

## 3. Screens and components

| Screen / component | New / reused | Notes |
|---|---|---|
| `ReadingScreen` | new | Header, content region, nav bar, live region |
| `ReaderHeader` | new | Document title (content), page counter (interface), end slot reserved for item 8 |
| `PageView` | new | Renders one page's blocks |
| `ContentBlock` | new | One block: `dir`, `lang`, alignment, isolation |
| `PageNav` | new | Previous/next buttons, progress bar; mirrored by document direction |
| `PageProgress` | new | Thin bar inside `PageNav` |
| `StatusScreen` | new | Shared layout for loading, fetch failure, blocked states |
| `LiveAnnouncer` | new | Single polite live region for page announcements |

Nothing to reuse: `apps/` has only `sync-server`; `packages/react` has hooks,
no visual components.

## 4. Reading screen layout

### Phone (default, < 640 px)
```
+------------------------------------------+
| [Title of the book…]        3 / 12  [S]  |  ReaderHeader (48 px)
+------------------------------------------+   S = reserved slot (item 8)
|                                          |
|  Block text, block text, block text      |  PageView: scrolls vertically
|  block text block text block text.       |  if the page is longer than
|                                          |  the viewport
|  Block text, block text…                 |
|                                          |
+------------------------------------------+
| [====------------------------]           |  PageProgress (4 px)
| [ ‹ Previous ]            [ Next › ]     |  PageNav (56 px + safe area)
+------------------------------------------+
```
The same screen for an **RTL document** (nav mirrored, text right-aligned):
```
+------------------------------------------+
| [S]  3 / 12        […כותרת הספר]          |  header follows INTERFACE dir
+------------------------------------------+   (shown here with a Hebrew UI)
|      טקסט הבלוק, טקסט הבלוק, טקסט הבלוק  |
|            .טקסט הבלוק טקסט הבלוק         |
+------------------------------------------+
|           [------------------------====] |  progress fills from the right
| [ ‹ Next ]                [ Previous › ] |  nav follows DOCUMENT dir
+------------------------------------------+
```

### Tablet / desktop (>= 640 px)
- Content column centred, `max-inline-size: 66ch` (target 60-75 characters per
  line), inline padding grows to `--space-8`.
- Header and nav bar span the full width; their content aligns to the same
  centred column so controls sit near the text.
- Nav buttons show icon + label at every size (labels are not hidden on
  phones: "Next"/"Previous" is clearer than a lone chevron when the mapping is
  mirrored).

### Behaviour
- Header and nav bar are fixed (always visible). Auto-hiding chrome is **not**
  used in v1: item 8 will put the connection indicator in the header, and the
  PRD wants sync status visible at a glance.
- Turning a page resets the content region's scroll to the top.
- Text is selectable. Text size follows the browser / OS setting (rem units);
  layout must survive 200 % zoom with no horizontal scrolling of the text
  column. An in-app text-size control is out of scope.

## 5. Page navigation and mirroring (AC13)

The **document** direction decides the mapping. Never the page's or a block's
direction, and never the interface direction.

| Input | LTR document | RTL document |
|---|---|---|
| Button on the **right** edge | Next (chevron points right) | Previous (chevron points right) |
| Button on the **left** edge | Previous (chevron points left) | Next (chevron points left) |
| `ArrowRight` | Next | Previous |
| `ArrowLeft` | Previous | Next |
| `PageDown`, `Space` (when content is not scrollable further) | Next | Next |
| `PageUp`, `Shift+Space` (at top) | Previous | Previous |
| `Home` / `End` | First / last page | First / last page |
| Swipe finger right-to-left | Next | Previous |
| Swipe finger left-to-right | Previous | Next |
| Progress bar fills from | left | right |
| Page slide animation, "next" | new page enters from the right | new page enters from the left |

Rule of thumb for implementers: the physical side where "next" lives equals
the document's *end* side.

Details:
- Chevrons are **not** auto-mirrored by interface direction (no logical-flip
  CSS on the icons). They point in the physical direction of travel, which
  depends only on the document direction.
- Button labels ("Next", "Previous") are interface strings in the interface
  language; their physical position comes from the document direction. With a
  Hebrew UI and an English book: left = "‹ הקודם", right = "הבא ›".
- Arrow keys and `Space`/`PageDown` only act when focus is not in a text input
  and no modifier other than Shift is pressed. Arrow keys do not turn the page
  while the user is selecting text with Shift+Arrow.
- `Space`/`PageDown` first scroll a long page; they turn the page only when
  the page is already scrolled to the bottom (and `PageUp`/`Shift+Space` at the
  top). Arrow Left/Right always turn the page.
- Swipe: horizontal pointer/touch move of at least 48 px, with
  `|dx| > 1.5 × |dy|`, finished within 600 ms or past 30 % of the width.
  Ignored if a text selection is active, if more than one finger is down
  (pinch zoom), or when the page is zoomed and can pan horizontally.
- At the first/last page the corresponding swipe/key does nothing (no
  wrap-around); with motion on, a small 8 px rubber-band nudge signals the end.

## 6. Interface direction vs content direction (AC12)

Two independent `dir` scopes:
- **Interface scope**: `<html lang={uiLang} dir={uiDir}>`. Header, buttons'
  labels, status screens, announcements.
- **Content scope**: the content region (`<main>` or its article) carries
  `lang={docLang}` (if known) and `dir={docDir}`. Pages and blocks inside set
  their own `dir` when it differs.
- Any content string shown inside interface chrome (the document title in the
  header) is wrapped in its own isolated element with the document's `dir` and
  `lang` (`<bdi>` or an element with `dir`), so a Hebrew title does not reorder
  an English page counter and vice versa.
- `PageNav` is chrome (interface `dir` for labels) but positions its buttons by
  document direction (section 5).

| Interface | Content | Header layout | Text alignment | Next button | Example test |
|---|---|---|---|---|---|
| LTR (en) | LTR | Title left, counter right | left | right | English UI, English sample |
| LTR (en) | RTL | Title left (title text itself RTL-isolated), counter right | right | **left** | English UI, Hebrew sample |
| RTL (he) | LTR | Title right (LTR-isolated), counter left | left | **right** | Hebrew UI, English sample |
| RTL (he) | RTL | Title right, counter left | right | left | Hebrew UI, Hebrew sample |

Status screens (loading, errors) are interface only and follow the interface
direction. They never show text from the file.

## 7. Mixed-direction blocks (AC10, AC11, AC14)

- **Every block is its own element** with an explicit `dir` set to the
  *effective* direction (block → page → document → `ltr`). Each element with
  `dir` is a bidi isolate, so one block's direction never leaks into its
  neighbours.
- **`auto` is resolved by the app**, not left to the browser: the app computes
  the first strong character (AC11) and writes `dir="ltr"` or `dir="rtl"`.
  Neutral-only or empty text gets the page/document direction. Reason: browser
  `dir="auto"` fallback for neutral text differs between engines, and the
  computed value is what the tests assert.
- **Alignment**: `text-align: start` on every block, so alignment follows the
  block's own direction. An English quote in a Hebrew book is left-aligned; a
  Hebrew block in an English book is right-aligned. Margins and indents use
  logical properties only (`padding-inline-start`, `margin-block-end`).
  No justified text.
- **Punctuation**: because each block's base direction is correct, trailing
  punctuation lands at the block's end side (a period at the left end of a
  Hebrew sentence, at the right end of an English one). Inline mixing *within*
  one block (an English word inside a Hebrew sentence) is handled by the
  Unicode bidi algorithm; authors who need fine control use Unicode isolates
  (FSI/PDI) or marks (LRM/RLM) in the text. There are no inline spans in schema
  v1. The README (AC22) should say this.
- **Whitespace**: block text is rendered as plain text (AC4) with
  `white-space: pre-line` (**proposal**) so authored line breaks inside a
  block show, while runs of spaces collapse. The architect confirms whether
  `\n` inside a block is meaningful in schema v1.
- **Sample content for tests (AC14, AC20)** should include: Hebrew paragraph
  ending in `.` and `?`; Hebrew paragraph with an embedded English phrase and a
  number; an English block (`dir: ltr`) inside the Hebrew document; an `auto`
  block starting with English inside an RTL page; an `auto` block of only
  digits and punctuation (`"1948 - 2024."`) to prove the fallback; an Arabic
  block; the reverse set in the English document.

## 8. States

### StatusScreen (shared layout)
```
+------------------------------------------+
|                                          |
|               (icon 32 px)               |
|        Heading (text-lg, semibold)       |
|    One or two lines of body, muted.      |
|                                          |
|            [ Primary action ]            |
|              ▸ Details                    |  disclosure, collapsed
+------------------------------------------+
```
Centred column, max 40ch, interface direction. Details are plain text, never
file content beyond the typed reason and numbers.

### State table

| State | Trigger | Heading | Body | Action | Details (collapsed) |
|---|---|---|---|---|---|
| Loading | loader running; shown after 300 ms | (none, spinner + text) "Loading…" | after 8 s: "Still loading. This can take a moment on a slow connection." | none | none |
| Fetch failure: network | network error | "Can't load this text" | "Check your connection, then try again." | **Try again** (primary) | `Reason: network error` |
| Fetch failure: HTTP | non-2xx | "Can't load this text" | "The server didn't send it. Try again in a moment." | **Try again** | `Reason: HTTP 404` |
| Fetch failure: timeout | loader timeout | "Loading took too long" | "Check your connection, then try again." | **Try again** | `Reason: timed out after 15 s` (architect sets value) |
| Retrying | Try again pressed | same screen, button shows spinner, label "Trying again…", disabled (aria-disabled) | | | |
| Blocked: schema too new | version > max supported | "This text needs a newer app" | "Update the app to open it." | Go back (if available) | `Schema version 2. This app reads version 1.` |
| Blocked: schema too old | version < min supported | "This text uses an old format" | "This app can no longer open it." | Go back (if available) | `Schema version N. This app reads version 1.` |
| Blocked: schema missing / not a version | no or invalid `schemaVersion` | "This file can't be opened" | "It isn't a reading file this app understands." | Go back (if available) | `Missing schema version` / `Schema version is not valid` |
| Blocked: invalid content | JSON parse error, wrong types, missing pages, bad direction, bad content ID | "This file can't be opened" | "Something in the file isn't valid." | Go back (if available) | first typed error, e.g. `Page 3, block 2: unknown direction "rlt"` / `Content ID must look like namespace/slug` |
| Reading | content loaded | n/a | n/a | n/a | n/a |
| Reading, first page | page index 0 | Previous unavailable | | | |
| Reading, last page | last index | Next unavailable | | | |

Notes:
- Wording says "text" for content, never "schema", "fingerprint" or
  "content ID" in headings or body (match the real world). Technical terms
  appear only under Details, for authors and support.
- Retry is offered only when retrying can help (fetch failures). Refused files
  would fail again, so they get no retry.
- Details for invalid content show the typed error's path and code. Any value
  quoted from the file is truncated to 40 characters and rendered as plain text.
- Single-page document: both nav buttons unavailable; progress bar full;
  counter "1 / 1".
- Empty page (page with zero blocks): see Open questions.

### PageNav button states

| State | Look | Behaviour |
|---|---|---|
| Default | `--color-text` label + chevron, transparent bg, 44 px min height | |
| Hover (pointer) | bg `--color-surface` | |
| Focus-visible | 2 px `--color-focus` outline, 2 px offset | |
| Active (pressed) | bg `--color-surface-2` | |
| Unavailable (first/last) | `--color-text-muted`, no hover | `aria-disabled="true"`, stays focusable so focus is never lost when reaching the end; activation does nothing |

Primary button (StatusScreen): bg `--color-accent`, text `--color-on-accent`;
hover darkens via `--color-accent-hover`; focus-visible outline; loading shows
an inline spinner and keeps its width.

## 9. Accessibility

- **lang / dir**: interface on `<html>`; content on the content region;
  effective `dir` on every block; `lang` on content region and on blocks when
  known (needs a schema field, see Decisions needed D3). Without `lang`, screen
  readers read Hebrew with an English voice, so this matters.
- **Landmarks**: `header` (banner), `main` holding an `article` whose
  accessible name is the document title (or "Reading" if none), `nav` with
  label "Pages" for PageNav.
- **Page announcement**: one polite live region (interface language). On
  every page change it announces "Page 4 of 12". It does not read the page
  text (the user moves into the content to read it). Not announced on first
  load; the heading/landmark is enough.
- **Focus**: after a page turn by button or key, focus stays where it was (on
  the button). After a swipe, focus is not moved. On a status screen, focus
  moves to its heading (`tabindex="-1"`) so screen readers hear the reason;
  after Try again succeeds, focus moves to the content article.
- **Focus order**: header (title, then item-8 slot), content, Previous/Next in
  *visual* order for the current document direction (DOM order follows the
  physical layout, so Tab order matches what is seen).
- **Keyboard**: everything in section 5; all controls are real buttons.
- **Buttons' accessible names** are the visible labels ("Next page",
  "Previous page" as `aria-label` is fine if the visible label is shorter, but
  the visible text must be contained in the name).
- **Reduced motion**: with `prefers-reduced-motion: reduce`, page change is
  instant (no slide, no rubber-band); the spinner becomes a static indicator
  with the "Loading…" text.
- **Colour**: no state depends on colour alone (unavailable buttons are also
  `aria-disabled`; errors have headings and icons).
- **Touch targets**: nav buttons at least 44 × 44 px (target 48 px tall).
- **Zoom**: 200 % zoom and large OS text sizes keep the text column readable;
  the header title truncates with an ellipsis before the counter wraps.
- **Plain text**: all content and sync-service text (display names, AC18) is
  inserted as text, never HTML.

## 10. Visual design: proposed minimal design system

No design system exists; this is the project's first UI. The tokens below are a
**proposal** for an ADR (D1). Values are given as CSS custom properties for
clarity; the architect decides how they're expressed (CSS variables, a theme
object, Tailwind config, …).

Theme follows `prefers-color-scheme` (light/dark). No in-app theme toggle in v1.

### Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-bg` | `#FFFFFF` | `#121416` | page background |
| `--color-surface` | `#F6F7F9` | `#1C1F22` | header, nav bar, hover |
| `--color-surface-2` | `#ECEEF1` | `#262A2E` | pressed |
| `--color-text` | `#1A1C1E` | `#E8EAED` | body, labels |
| `--color-text-muted` | `#5B6168` | `#A3A9B1` | counter, secondary text, unavailable |
| `--color-border` | `#D0D4DA` | `#33383D` | hairlines |
| `--color-accent` | `#1F5FBF` | `#8AB4F8` | primary button, progress fill |
| `--color-accent-hover` | `#194E9E` | `#A8C7FA` | primary hover |
| `--color-on-accent` | `#FFFFFF` | `#121416` | text on accent |
| `--color-danger` | `#B3261E` | `#F28B82` | error icon |
| `--color-focus` | `#1F5FBF` | `#8AB4F8` | focus ring |

Contrast (computed, WCAG relative luminance):

| Pair | Light | Dark |
|---|---|---|
| text / bg | 17.0:1 | 15.1:1 |
| text-muted / bg | 6.3:1 | 7.8:1 |
| text-muted / surface | 5.8:1 | 6.9:1 |
| accent / bg (progress, focus ring, 3:1 needed) | 6.1:1 | 8.8:1 |
| on-accent / accent | 6.1:1 | 8.8:1 |
| danger / bg | 6.6:1 | 7.7:1 |

### Typography
Fonts (**proposal**): system UI stack, no web fonts in v1 (fast on phones,
offline-friendly), with script fallbacks so Hebrew and Arabic get proper
glyphs:
`system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Hebrew", "Noto Naskh Arabic", Arial, sans-serif`.

| Token | Size | Line height | Use |
|---|---|---|---|
| `--text-sm` | 0.875rem (14 px) | 1.4 | counter, details |
| `--text-md` | 1rem (16 px) | 1.5 | UI labels, status body |
| `--text-body` | 1.125rem (18 px) | 1.65 | reading text |
| `--text-lg` | 1.25rem (20 px) | 1.4 | status heading, header title |
| `--text-xl` | 1.5rem (24 px) | 1.3 | `heading` blocks, if adopted (D2) |

- Arabic reading text: `:lang(ar)` raises line height to 1.85 (diacritics).
- Weights: 400 body, 600 headings and buttons.
- Body on phones may drop to 1.0625rem only if 18 px proves too large in
  testing; never below 16 px.

### Spacing, radius, shadow, motion
- Spacing (4-px base): `--space-1` 4, `--space-2` 8, `--space-3` 12,
  `--space-4` 16, `--space-6` 24, `--space-8` 32, `--space-12` 48.
- Block gap: `--space-4` between blocks (paragraph spacing, no first-line
  indent).
- Content padding: inline `--space-4` (phone) / `--space-8` (>= 640 px);
  block `--space-6`.
- Radius: `--radius-sm` 4 px, `--radius-md` 8 px (buttons).
- Shadow: none in the reading screen; hairline `--color-border` separates
  header and nav bar from content.
- Motion: `--duration-fast` 120 ms (hover/press), `--duration-page` 200 ms
  (page slide), easing `cubic-bezier(0.2, 0, 0, 1)`. Reduced motion: 0 ms.
- Breakpoints: `--bp-sm` 640 px, `--bp-lg` 1024 px (>= 1024 adds nothing in
  item 7; reserved for item 8's richer leader views).

## 11. Reserved slots for item 8 (not designed here)
- `ReaderHeader` end slot (inline-end in interface direction): connection
  indicator and group controls. Item 7 renders nothing there.
- An overlay layer above the content and below status screens, for item 8's
  prompts (jump to page, countdown, mismatch warning).
- `ReadingScreen` exposes the current page index and a "go to page" action so
  item 8 can jump without bypassing the page announcement.

## 12. Display hints for schema v1: recommendation

Recommendation: **no visual display hints in v1** (no colours, fonts, sizes or
alignment in the file). Alignment comes from direction; styling comes from the
app's tokens. Three small, non-visual fields are worth having, listed for the
architect to decide (D2, D3):

| Field | Level | Values | Why |
|---|---|---|---|
| `title` | document, optional | string | Header and the article's accessible name. Without it the header shows only the counter. |
| `lang` | document, page, block; optional | BCP 47 tag (`he`, `en`, `ar`) | Screen readers pick the right voice; `:lang(ar)` line height; hyphenation. Not used to infer direction. |
| `type` | block, optional | `paragraph` (default) \| `heading` | Lets screen-reader users jump by heading; renders `heading` at `--text-xl`/600. Can be deferred if the architect wants the schema even smaller. |

All three are part of the content and therefore of the fingerprint (Q4 asks
the architect to confirm coverage).

## 13. Acceptance criteria mapping

| AC | Where it shows up in the UI |
|---|---|
| AC1 | `PageView` renders pages and blocks; `title` (if adopted) in header |
| AC2 | Same Flow A for bundled and fetched; only fetched shows Loading |
| AC3 | Blocked states: schema too new / too old / missing / not a version; nothing partial |
| AC4 | Blocked: invalid content; plain-text rendering everywhere |
| AC5 | Fetch-failure states with Try again |
| AC6-AC8 | No reader-facing UI; fingerprint and content ID are never shown to readers. Item 8 uses the metadata |
| AC10 | Effective `dir` on every `ContentBlock` |
| AC11 | App-resolved `auto`; neutral fallback; sample blocks in section 7 |
| AC12 | Two `dir` scopes; four-combination table (section 6) |
| AC13 | `PageNav` mirroring, keys, swipe, progress, animation (section 5) |
| AC14 | Per-block isolation, `text-align: start`, punctuation (section 7) |
| AC15-AC17 | No item-7 screen; local unsupported schema uses the blocked state (Flow D) |
| AC18 | Plain-text rule (section 9); item-8 slot content too |
| AC19 | n/a (architecture) |
| AC20 | Sample content list (section 7) also used for the four direction combinations |
| AC21 | n/a; DOM access (swipe, live region, Web Crypto) must be client-only if SSR |
| AC22 | README documents direction rules and the bidi authoring note (section 7) |
| AC23 | Blocked: invalid content, Details "Content ID must look like namespace/slug" |

## 14. Decisions needed (for the architect)

- **D1. Design-system foundation (ADR).** Adopt the tokens in section 10
  (colour light/dark, type scale, spacing, radius, motion, breakpoints) as the
  project's first design system, and choose how they're expressed together
  with the styling-approach ADR (plain CSS custom properties + logical
  properties recommended as the framework-neutral baseline; a component library
  is not needed for item 7's handful of components).
- **D2. Display hints in schema v1.** Recommendation: no visual hints; add
  optional document `title`, and optional block `type: paragraph | heading`
  (the latter can be deferred).
- **D3. `lang` field.** Optional BCP 47 `lang` at document/page/block level,
  recommended for accessibility. Independent of `dir`.
- **D4. Interface localisation.** AC12 needs an RTL interface to test. Which
  interface locales ship in v1 (recommend `en` and `he`), and how the interface
  language is chosen (browser language, recommended). Strings must be
  externalised either way.
- **D5. Fonts.** System font stack with Noto fallbacks, no bundled web fonts
  (recommended), vs bundling Hebrew/Arabic fonts for consistent rendering.

## 15. Open questions

1. How does the app pick which content to open (fixed bundled sample, URL query
   parameter, a simple list of bundled samples)? If a list screen is wanted in
   item 7 it is a small extra screen not designed here; the blocked states'
   "Go back" depends on it.
2. Is a page with zero blocks valid? Recommendation: reject it in validation
   (it's almost certainly an authoring mistake), so no "empty page" state is
   needed.
3. Is `\n` inside a block's text meaningful (line breaks, e.g. poetry)? The
   design assumes yes (`pre-line`).
4. Fetch timeout value (the design shows 15 s as a placeholder).
5. Should the reader's current page survive a reload (local storage)? Not in
   the spec; item 8's sync may make it moot. Assumed no for item 7.
