# Design: #19 reading app content, text direction (RTL) and content fingerprint

Scope: item 7 only. This covers the reading screen, page navigation and its
mirroring, interface vs content direction, mixed-direction blocks, the
loading / error / blocked states that item 7 itself produces, and (added
after the post-design decisions, AC24-AC35) the library page, the "book not
found" and "no book selected" screens, and single-book mode (section 8a).
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
1. The URL picks the content (AC25): `?book=<contentId>` for a bundled book,
   `?src=<url>` for fetched content; or the reader arrives from the library
   (Flow F). Single-book mode ignores the URL (Flow E).
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
5. Only exit: **Back to library** (AC31) when the library is enabled; it is a
   real link to the library page, not browser history. Otherwise no action is
   shown (single-book mode, or library not enabled).

### Flow D: mismatch (logic only in item 7)
Item 7 returns `match | different-content | different-version |
unsupported-schema` and the outcome `warn | block`. Item 8 designs the screens.
The only item-7 UI rule: when the outcome is `block` for the *local* file's own
schema, Flow C's "unsupported schema" state applies (AC16 = AC3).

### Flow E: entry resolution (AC25, AC27-AC29)
Config (env, validated at startup, AC30) decides what happens when the URL
does not name a book. Full table in section 8a. In short:
1. Single-book mode: URL parameters are ignored without any message; the one
   configured book opens (Flow A). No library, no back links, no not-found
   screens.
2. `?book=<id>` known: reading screen (bundled, so no loading state).
3. `?book=<id>` unknown: "Book not found" screen (AC28), with **Go to
   library** only when the library is enabled.
4. `?src=<url>`: loader (Flow A, B or C).
5. No parameter: per config, library page, "No book selected" error page, or
   the default book.

### Flow F: library (AC26)
1. Reader opens the library page (entry per Flow E, or from a Back to library
   link).
2. Sees a list of bundled books; each shows its title and, if known, language.
3. Activates a book: opens its own reading page (`?book=<contentId>`), Flow A.
4. The reading page has no way to switch books (AC24). To pick another book the
   reader uses the browser back button or the URL. No library link in the
   reading header (see Open questions 1).

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
| `LibraryScreen` | new | Heading and list of books (section 8a) |
| `LibraryItem` | new | One link row: isolated title, language line, end chevron |
| `NoticeBar` | new | Dismissible `role="status"` message under the header (only for "unknown book, opening default", section 8a) |

The "book not found", "no book selected" and "empty library" screens reuse
`StatusScreen`; no new layout.

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
- **No book switcher (AC24).** `ReaderHeader` holds only: the document title
  (plain text, not a link, button or menu), the page counter, and the reserved
  item-8 slot. There is no book picker, dropdown, tab bar or library link on
  the reading screen. Each reading page behaves as if that book were the only
  one.
- Reload returns to page 1 (AC35): no position is stored and the URL carries
  no page number. No "resume" prompt.
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
- **Whitespace and line breaks (AC33, decided)**: block text is rendered as
  plain text (AC4) with `white-space: pre-line`. Each `\n` in the text is a
  visible line break (poetry, addresses); `\r\n` is treated as `\n`; runs of
  spaces collapse; spaces at line starts and ends are dropped. Consecutive
  `\n\n` shows a blank line, as authored. Every line follows the block's own
  direction and alignment (no hanging indent). The line break stays inside one
  block element, so it is not a new block gap (`--space-4` applies between
  blocks only) and a screen reader reads it as one block. Titles (header,
  library) are *not* pre-line: line breaks in a `title` collapse to spaces.
- **Sample content for tests (AC14, AC20)** should include: Hebrew paragraph
  ending in `.` and `?`; Hebrew paragraph with an embedded English phrase and a
  number; an English block (`dir: ltr`) inside the Hebrew document; an `auto`
  block starting with English inside an RTL page; an `auto` block of only
  digits and punctuation (`"1948 - 2024."`) to prove the fallback; an Arabic
  block; the reverse set in the English document; a multi-line poem block (`\n`
  inside the text) in each direction. For the library (AC26): a Hebrew-titled
  RTL book, an English-titled LTR book, an Arabic-titled book, a book with no
  `title` (falls back to its content ID), and an English-document book with a
  Hebrew title to check isolation.

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
| Loading | loader running; shown after 300 ms | (none, spinner + text) "Loading…" | after 8 s: "Still loading. This can take a moment on a slow connection." (skipped if the configured timeout is 8 s or less) | none | none |
| Fetch failure: network | network error | "Can't load this text" | "Check your connection, then try again." | **Try again** (primary) | `Reason: network error` |
| Fetch failure: HTTP | non-2xx | "Can't load this text" | "The server didn't send it. Try again in a moment." | **Try again** | `Reason: HTTP 404` |
| Fetch failure: timeout | loader timeout (configurable) | "Loading took too long" | "Check your connection, then try again." | **Try again** | `Reason: timed out after 15 s` (shows the configured value; default 15 s, AC34) |
| Retrying | Try again pressed | same screen, button shows spinner, label "Trying again…", disabled (aria-disabled) | | | |
| Blocked: schema too new | version > max supported | "This text needs a newer app" | "Update the app to open it." | Back to library (only if library enabled) | `Schema version 2. This app reads version 1.` |
| Blocked: schema too old | version < min supported | "This text uses an old format" | "This app can no longer open it." | Back to library (only if library enabled) | `Schema version N. This app reads version 1.` |
| Blocked: schema missing / not a version | no or invalid `schemaVersion` | "This file can't be opened" | "It isn't a reading file this app understands." | Back to library (only if library enabled) | `Missing schema version` / `Schema version is not valid` |
| Blocked: invalid content | JSON parse error, wrong types, missing pages, **a page with zero blocks (AC32)**, bad direction, bad content ID | "This file can't be opened" | "Something in the file isn't valid." | Back to library (only if library enabled) | first typed error, e.g. `Page 3, block 2: unknown direction "rlt"` / `Page 3: has no blocks` / `Content ID must look like namespace/slug` |
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
- Empty page (zero blocks) is invalid (AC32, decided): the whole file is
  refused with the "invalid content" state above, so the reading screen never
  has to render an empty page and needs no empty-page state.
- "Back to library" on refused-file screens (AC31) is a secondary-style link
  (outlined, `--color-text` label, same size as a button), not the primary
  button, since there is nothing to retry. It appears whenever the library is
  enabled, for both `?book=` and `?src=` entries. In single-book mode or with
  no library it is absent and the screen has heading, body and Details only;
  that is a dead end by design (the deployment serves one book). The
  fetch-failure screens keep only **Try again** (AC31 covers refused files).
- "Go back" in the spec means this action; the label is "Back to library" so
  the destination is clear.

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

## 8a. Library, entry resolution and not-found screens (AC24-AC31)

### Entry resolution table

| Situation | Library enabled | Config for no/unknown book | Result |
|---|---|---|---|
| Single-book mode (AC29) | not offered | n/a | Configured book opens; `?book`, `?src` ignored silently; no library link anywhere |
| `?book=<known id>` | any | n/a | Reading screen |
| `?src=<url>` | any | n/a | Loader, then reading / fetch failure / blocked |
| No parameter | yes | library | `LibraryScreen` |
| No parameter | any | error page | "No book selected" screen |
| No parameter | any | default book | Default book opens, no notice |
| `?book=<unknown id>` | yes | library | "Book not found" with **Go to library** |
| `?book=<unknown id>` | no | error page | "Book not found", no link |
| `?book=<unknown id>` | any | default book | Default book opens with a `NoticeBar` (proposal, Open questions 2) |

"Library enabled" is the architect's definition (config). The design only
needs: the library link and "Back to library" show if and only if the library
page exists in this deployment and the app is not in single-book mode.

### LibraryScreen

Phone (< 640 px), English interface; a Hebrew-titled, an English-titled and an
untitled book:
```
+------------------------------------------+
| Library                                  |  header, 48 px, interface dir
+------------------------------------------+
|  +------------------------------------+  |
|  | [תהילים…]                       >  |  |  row, min 64 px; title RTL-
|  | Hebrew                             |  |  isolated, at the interface
|  +------------------------------------+  |  START edge
|  | Pride and Prejudice             >  |  |
|  | English                            |  |
|  +------------------------------------+  |
|  | acme/untitled-sample            >  |  |  fallback title = content ID
|  +------------------------------------+  |  (LTR, no language line)
+------------------------------------------+
```
Hebrew interface (rows mirror; each title keeps its own book's direction):
```
+------------------------------------------+
|                                  ספרייה  |
+------------------------------------------+
|  +------------------------------------+  |
|  | <                     [...תהילים]  |  |  Hebrew title RTL, at the right
|  |                              עברית |  |
|  +------------------------------------+  |
|  | <              Pride and Prejudice |  |  English title LTR-isolated,
|  |                            אנגלית |  |  still at the right (start) edge
|  +------------------------------------+  |
+------------------------------------------+
```
- **Heading**: `<h1>` "Library" in interface language and direction; also
  the page `<title>`. Item 8 may add entry points to this page later; nothing
  is reserved for them here.
- **Layout**: one-column list at every size (no grid: books are few and a grid
  muddles RTL reading order). At >= 640 px the list is centred,
  `max-inline-size: 40rem`, same row design. Background `--color-bg`; rows
  separated by hairlines `--color-border`; no cards or shadows.
- **Row (`LibraryItem`)**: the whole row is one link (`<a>`), full-row hit
  area, minimum 56 px tall (64 px with a language line), inline padding
  `--space-4`, gap `--space-3`.
  - **Title**: `--text-lg` / 600, `--color-text`, wraps to at most 2 lines then
    ellipsis. It is an isolated element (`<bdi>` or an element with `dir`)
    carrying the *document's* `dir` and `lang` (effective document direction,
    default `ltr`), so Hebrew and English titles each render in their own
    direction whatever the interface direction. Same isolation rule as the
    header title (section 6). Line breaks in a title collapse to spaces.
  - **Alignment**: rows align to the *interface* start edge (title at the
    start edge, language line below it), not to the title's own direction.
    This keeps a list of mixed-direction books scannable.
  - **Language line** (only when the document has `lang`): language name in the
    interface language (`Intl.DisplayNames`; fall back to the raw tag),
    `--text-sm`, `--color-text-muted`, interface direction. Omitted when
    `lang` is missing. No "RTL"/"LTR" badge: direction is visible in the title.
  - **Fallback title**: with no `title`, show the content ID as the title,
    `dir="ltr"`, no `lang`, `overflow-wrap: anywhere` so long IDs wrap. The ID
    is not shown as a second line when a real title exists (readers do not
    need it).
  - **End chevron**: points toward the interface *end* (right in an LTR UI,
    left in an RTL UI; mirrored with the interface direction), `aria-hidden`.
    Deliberately unlike `PageNav`, whose chevrons follow the document
    direction (section 5): here the chevron means "open", not "next page".
- **Row states**:

| State | Look |
|---|---|
| Default | `--color-text` title, transparent bg |
| Hover | bg `--color-surface` |
| Focus-visible | 2 px `--color-focus` outline, inset so it is not clipped |
| Active | bg `--color-surface-2` |
| Visited | no change |

- **Order**: stable; preferably alphabetical by title in the interface locale
  (architect's call). No search, sort or filters in v1.
- **Loading**: none, assuming titles are known at build time (D6). If the list
  is async, use the `StatusScreen` loading state.

### Library empty state
Library enabled but no bundled books (reachable only through odd config; the
architect may make it a startup error instead, Open questions 6):
`StatusScreen`, neutral icon, heading "No books yet", body "There's nothing to
read here yet.", no action, Details `No books are bundled with this app.`

### "Book not found" screen (AC28)
`StatusScreen`, interface direction, neutral icon (`--color-text-muted`, not
the danger colour: the link is wrong, nothing broke).

| Part | Copy |
|---|---|
| Heading | "Book not found" |
| Body | "We couldn't find that book. The link may be wrong or out of date." |
| Action (only if the library is enabled) | primary link-button **Go to library** |
| Details | `Book ID: acme/psalms-hh` (from the URL, truncated to 40 characters, plain text, `dir="ltr"`) |

With no library the screen has no action (a dead end, same as the refused-file
screens). Focus moves to the heading on arrival, as for all status screens.

### "No book selected" screen (AC27, error-page option)
`StatusScreen`, neutral icon.

| Part | Copy |
|---|---|
| Heading | "No book selected" |
| Body | "Open a link to a book to start reading." |
| Action (only if the library is enabled) | primary link-button **Go to library** |
| Details | `No book was specified in the link.` |

The copy is fixed, localised interface text in v1; config chooses *whether*
this page shows, not its wording.

### NoticeBar (unknown book, default-book option; proposal)
Shown above the content, under the header, on the default book's reading
screen: `We couldn't find "acme/psalms-hh". Showing Psalms instead.` (the id is
truncated to 40 chars, plain text, `dir="ltr"` isolated; the title is the
default book's isolated title). `role="status"` (not an alert, no focus
steal), `--color-surface` bg, hairline border, a **Dismiss** button (44 px
target). Dismissal is not remembered (a reload shows it again, consistent with
AC35). Never shown in single-book mode.

### Single-book mode (AC29)
- The reading and status screens are unchanged except what is removed: no
  library link, no "Back to library", no NoticeBar, no "Go to library".
  `?book` and `?src` are ignored with no message (the reader sees only the one
  book; there is nothing to explain).
- Not-found and no-book screens cannot occur. A missing or invalid configured
  book is a startup/config error (AC30), not a reader-facing screen.

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
- **Library and status screens**: `<main>` with one `<h1>` (Library, or the
  status heading). The list is a real `<ul>` so screen readers announce the
  number of books. Each row is one link whose accessible name is the title,
  then the language ("Psalms, Hebrew"); the title carries its own `lang` so
  the right voice reads it. "Back to library" and "Go to library" are links,
  not buttons. On in-app navigation to the library or a status screen, focus
  moves to the `<h1>` (`tabindex="-1"`); on a full page load, normal start.
  The page `<title>` is "Library", the book title, or the status heading.
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
| AC24 | Reading header has no book switcher or library link (section 4 Behaviour); one book per page |
| AC25 | Entry resolution (Flow E, section 8a table); fetch screens for `?src` |
| AC26 | `LibraryScreen` and `LibraryItem` (section 8a): titles with per-book `dir`/`lang`, fallback to content ID, empty state |
| AC27 | "No book selected" screen, library page, default book: rows of the entry table (section 8a) |
| AC28 | "Book not found" screen, link to library only when enabled (section 8a) |
| AC29 | Single-book mode (section 8a): no library link, no back links, params ignored |
| AC30 | No reader-facing UI: startup/config error |
| AC31 | "Back to library" on every refused-file state (section 8 table and notes), absent when the library is not enabled |
| AC32 | Blocked: invalid content, Details `Page N: has no blocks`; no empty-page state |
| AC33 | `white-space: pre-line` rendering of `\n` in blocks (section 7) |
| AC34 | Fetch timeout state shows the configured value; default 15 s (section 8 table) |
| AC35 | Reload returns to page 1; no persistence, no resume prompt (section 4 Behaviour) |
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
  optional document `title` (now also the library row's title, so adopt it
  rather than defer it), and optional block `type: paragraph | heading`
  (the latter can be deferred).
- **D3. `lang` field.** Optional BCP 47 `lang` at document/page/block level,
  recommended for accessibility. Independent of `dir`.
- **D4. Interface localisation.** AC12 needs an RTL interface to test. Which
  interface locales ship in v1 (recommend `en` and `he`), and how the interface
  language is chosen (browser language, recommended). Strings must be
  externalised either way.
- **D5. Fonts.** System font stack with Noto fallbacks, no bundled web fonts
  (recommended), vs bundling Hebrew/Arabic fonts for consistent rendering.

- **D6. Library data and routes.** The library needs, per bundled book, its
  content ID, optional `title`, document `lang` and effective document `dir`,
  ideally without loading every book's pages at runtime (for example a
  build-time index). Also decide the library page's URL (for example the root
  with no params, or a fixed path) and what "library enabled" means in config,
  including how it relates to the "no book" option and to single-book mode.

## 15. Open questions

Resolved by the spec and removed from this list: how the app picks content
(URL parameters and library, AC25-AC27); zero-block pages (invalid, AC32);
line breaks in blocks (preserved, AC33); fetch timeout (15 s default,
configurable, AC34); current page across reload (not kept, AC35).

1. Should the reading screen have a "Library" link (a way back, not a book
   switcher)? Designed as **no**: AC24 says each page behaves as if it were the
   only book, and the browser back button covers it. Easy to add to the
   header's end area if wanted (hidden in single-book mode).
2. Unknown `?book=` with the "open a default book" option: designed as opening
   the default book with a dismissible `NoticeBar`, so the substitution is not
   silent. Confirm, or show "Book not found" in that case instead.
3. If both `?book` and `?src` are present, which wins? No special screen is
   designed; the architect picks the rule.
4. Should fetch-failure screens also offer "Back to library"? AC31 covers only
   refused files; designed as Try again only.
5. A bundled book that fails validation at runtime (should be impossible if
   tests pass): designed to be listed with its title or ID, with its reading
   page showing the blocked state, so nothing is hidden silently. Architect
   may prefer to omit it.
6. Empty library (enabled, no bundled books): reader-facing empty state
   (designed) or a startup config error (AC30)? Architect decides.
