# Architecture: #27 fix(reader): hebrew interface bidi bugs in the reading header

Path: fast. Spec: [spec.md](spec.md).

## Repo layout
- Layout: `monorepo` (pnpm workspaces, no submodules). Touched package:
  `apps/reader` (`@mosherw/sync-system-reader`) only.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (root), and
  `pnpm build && pnpm --filter @mosherw/sync-system-reader test:e2e`
  (Playwright, ADR 0008; outside `pnpm test`).
- Not touched (concurrent #44 work): `apps/reader/src/config/*`,
  `apps/reader/src/content/quote.ts`. `PlainText.tsx` (which imports `quote.ts`)
  is not changed either. `docs/roadmap.md` is not touched.

## Decisions
Decisions: none open. The fix follows the existing bidi patterns (ADR 0003,
#19 architecture section 7) and keeps the header's current visual layout, so
no designer input is needed (see "Layout" below).

## Root causes
1. **Counter.** `.counter` is a `<p>` in the interface direction. `"1 / 3"` is
   EN, WS, CS, WS, EN; the spaces stop rule W4, so in an RTL paragraph the
   neutrals resolve to R and the two numbers are laid out right to left:
   "3 / 1".
2. **Title.** `text-overflow: ellipsis` is applied by the **block container**
   (`p.title`), and its end side comes from that block's direction, which is
   the interface direction. The `<bdi dir={docDir}>` inside is inline, so with
   an RTL interface and an LTR title the LTR run overflows towards the left
   (the RTL end) and its *start* is clipped, with the ellipsis on the left.
   The mirror case (LTR interface, RTL title) has the same bug.

## Approach
1. **Counter: LTR isolate.** Wrap the formatted counter in
   `<bdi dir="ltr">` inside `p.counter`:
   `<p className={styles.counter}><bdi dir="ltr">{format(t.pageCounter, …)}</bdi></p>`.
   Same pattern as numbers/times in `components/group/GroupButton.tsx:83`,
   `LeaderViews.tsx:57`. `<bdi>` gets `unicode-bidi: isolate` from the UA
   stylesheet; no CSS needed. A short comment in `ReaderHeader.tsx` notes
   that `pageCounter` is shown in an LTR isolate and must stay numbers and
   separators only (wording itself is out of scope; i18n files unchanged).
2. **Title: truncate inside the title's own direction.** Make the title's
   `<bdi>` the element that clips, so the ellipsis uses the title's direction:
   in `ReadingScreen.module.css`, move `white-space`, `overflow`,
   `text-overflow` from `.title` to a new rule `.title > bdi`:
   ```css
   .title > bdi {
     display: inline-block;   /* own block formatting, direction = bdi dir */
     max-inline-size: 100%;   /* never wider than the title slot */
     overflow: hidden;
     white-space: nowrap;
     text-overflow: ellipsis;
     vertical-align: top;     /* overflow:hidden inline-block baseline fix */
   }
   ```
   `.title` keeps `flex: 1; min-inline-size: 0; margin; font-*` and gets
   `overflow: hidden` + `white-space: nowrap` only as a guard (no ellipsis
   there). Direction stays `dir={docDir}` from the content (ADR 0004 / #19
   AC12), not `dir="auto"`: the document declares its direction, and the
   existing tests assert the title `bdi` carries `docDir`.
   **Layout:** because the `bdi` is an inline-block inside a `p` that is still
   in the interface direction, a short title still sits at the interface
   start (right in he, left in en) exactly as today; only long titles change,
   and they now clip at their own logical end (right for LTR titles, left for
   RTL titles) in both interface directions. No visual decision is introduced.
3. **390 px.** `.headerInner` already wraps and `.title` has
   `min-inline-size: 0`; the inline-block's `max-inline-size: 100%` keeps the
   title inside its flex slot, so nothing can push the header wider than the
   viewport. Verified in the browser test below, not assumed.

### Alternatives rejected
- `dir={docDir}` on `p.title` itself: fixes the ellipsis side, but then
  `text-align: start` follows the title's direction, moving a short LTR title
  to the far side of its slot in the he interface (a visual change needing
  design) and changing the header element's own direction.
- `dir="auto"` on the title: ignores the declared document direction and
  breaks the AC12 contract (title `bdi dir === docDir`).
- `direction: ltr` / `unicode-bidi: isolate` in CSS on `.counter`: works, but
  direction in CSS instead of markup goes against the project's
  `dir`-attribute pattern and isn't visible to tests or assistive tech.
- JS truncation (`maxLength`): character counts don't match pixel widths, and
  it would touch `PlainText`/`quote.ts` (#44 in progress).

## Files to create / modify
| Path | Change |
|---|---|
| `apps/reader/src/components/ReaderHeader.tsx` | wrap counter text in `<bdi dir="ltr">`; comment on the LTR isolate |
| `apps/reader/src/components/ReadingScreen.module.css` | `.title` keeps sizing; new `.title > bdi` clip/ellipsis rule |
| `apps/reader/test/reader-header.test.tsx` (new) | unit tests, he and en (see test plan) |
| `apps/reader/e2e/header-layout.spec.ts` (new) | Chromium 390x844 layout checks, he and en |
| `apps/reader/e2e/helpers/fixtures.ts` | `pages.open(options?: BrowserContextOptions)` passes `locale`/`viewport` to `browser.newContext` (guard unchanged) |

Existing tests that use `banner.querySelector('bdi')` for the title
(`direction-scopes`, `mixed-content`, `content-block`) still find the title
first (it precedes the counter in the DOM; all use titled samples). If any
breaks, scope the query to `.title bdi` rather than changing the order.

## Data model / contracts / Docker
- Data model changes: none. Contracts (API, realtime): none.
- Docker impact: none.
- Docs impact: none (no user, operator or integration doc describes the
  header's rendering; i18n strings unchanged).

## Risks / edge cases
- `overflow: hidden` inline-block: baseline moves to the bottom margin edge;
  `vertical-align: top` keeps the header height unchanged (check visually).
- Untitled book: no `bdi` in `.title`; nothing changes.
- Long title with mixed scripts: the `bdi` isolate keeps neutral punctuation
  (e.g. the trailing `)` in "Pride and Prejudice (Chapter 1, opening)") with
  the title, not the interface.
- Hebrew numerals: `format` uses `Intl.NumberFormat('he')`, which yields
  Western digits, so the LTR isolate is correct.
- Firefox/Safari honour `text-overflow` on inline-blocks the same way; the
  e2e run is Chromium only, so QA does the manual cross-browser check.

## Security-sensitive areas
Security-sensitive: no
Markup/CSS change in one presentational component; no input handling, data,
endpoints, auth, secrets or dependencies. Titles still render via `PlainText`
(React-escaped).

## Implementer model
Implementer model: sonnet
No security/schema/contract/dependency change, no ADR, 2 product files, and the
counter follows `components/group/GroupButton.tsx`; the CSS and test probes are
fully specified here.

## Test plan
jsdom does not lay out text, so unit tests assert structure and attributes;
the visual behaviour (reading order, ellipsis side, overflow) is asserted in a
Playwright spec at 390 px, the repo's browser-test tool (ADR 0008; 390x844 is
already the phone size in `trusted-types.spec.ts`). QA also checks manually,
as #19 did for bidi rendering.

### Unit (`apps/reader/test/reader-header.test.tsx`, Vitest + jsdom)
Render through `renderReading(…, ui)` with `applyInterfaceLanguage` for `en`
and `he` (pattern: `direction-scopes.test.tsx`).
| AC | Assertion |
|---|---|
| AC1 | for `en` and `he`: `.counter` contains exactly one `bdi[dir="ltr"]` whose `textContent` is `"1 / 3"` (pagedDoc(3)); after Next it is `"2 / 3"` |
| AC2 | for `en`/`he` x `pride-and-prejudice-en`/`psalms-he`: the title `bdi` is a direct child of `p.title`, has `dir` = docDir and the doc `lang`; `p.title` itself has no `dir` (stays in the interface direction) |

### Browser (`apps/reader/e2e/header-layout.spec.ts`, Playwright, Chromium)
Contexts via `pages.open({ locale: 'en-US' | 'he-IL', viewport: { width: 390, height: 844 } })`
(locale drives `navigator.languages` → interface language). Open
`/?book=samples%2Fpride-and-prejudice-en` (long LTR title) and
`/?book=samples%2Fpsalms-he` (RTL title) in both locales; assert
`<html dir>` is the expected interface direction first.
| AC | Assertion (in `page.evaluate`) |
|---|---|
| AC1 | counter `bdi`: `Range` rects of the first character (`1`) and the last (`3`): `rect('1').right <= rect('3').left` in he and en |
| AC2 | title `bdi` with `scrollWidth > clientWidth` (truncated): the first character's rect is inside the bdi's client box and the last character's is outside it on the title's end side (LTR title: last char beyond the right edge; RTL title: beyond the left edge). Psalms' title may fit at 390 px, so for the RTL case the probe sets the title text node's `data` to a long Hebrew string (layout probe only, no React re-render happens during the check) and re-measures; same for a long LTR string in the en/he contexts if the sample happens to fit |
| AC2 (layout kept) | a short title sits at the interface start: he → `bdi.right ≈ p.title.right`, en → `bdi.left ≈ p.title.left` (±1 px) |
| AC3 | `document.documentElement.scrollWidth <= window.innerWidth` and `header.scrollWidth <= header.clientWidth`, for every case above (he and en) |

### Manual (QA)
`pnpm --filter @mosherw/sync-system-reader dev`, devtools 390 px, en and he
interface (browser language), Chrome plus Firefox (Safari if available):
counter reads "1 / 3"; long LTR and RTL titles end with an ellipsis at their
logical end; short titles at the interface start; header height unchanged;
no horizontal scroll.

## Implementation chunks
1. `fix(reader): isolate the page counter in the reading header` —
   `ReaderHeader.tsx` + AC1 unit tests in `reader-header.test.tsx`.
2. `fix(reader): truncate the header title at its own logical end` —
   `ReadingScreen.module.css` + AC2 unit tests.
3. `test(reader): check header bidi and 390 px overflow in the browser` —
   `fixtures.ts` `open(options)` + `e2e/header-layout.spec.ts`.

No docs chunk (`Docs impact: none`).
