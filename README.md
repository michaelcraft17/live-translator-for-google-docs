# Google Docs Live Translator (MVP)

Real-time, side-by-side translation for Google Docs, shown in Chrome's side
panel, with bidirectional sentence-click synchronization.

Requires Chrome 114 or newer (the Side Panel API).

## Load it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this folder.
2. Open any Google Doc at `https://docs.google.com/document/d/…/edit`.
3. A round 🌐 translate button appears at the top right of the document.
   Click it to open the translation side panel (click again to close it).
   Chrome narrows the page to make room, the same way it does for Gemini.
   The extension's toolbar popup has an "Open translation panel" button too.
4. The panel header has a target-language dropdown, a scroll-sync button
   (two Joy-Con-style bars: snapped together = syncing, pulled apart = off)
   and a ⚙ settings gear (enabled toggle, translation backend, API key,
   re-translate). The same settings are in the toolbar popup.

Nothing is fetched or translated while the panel is closed.

## The side panel

The translation list lives in `sidepanel/` (a native Chrome side panel), not
on the page. A native panel narrows the browser's real viewport, so Docs
re-lays out its canvas around it. Doing the same from inside the page does
not work: Docs ignores a narrowed container and synthetic `resize` events,
and only re-lays out for a genuine window resize.

- **`content/content.js` stays the source of truth.** Only it can see the
  document, the mirror and the highlight boxes. When the panel opens it
  connects a long-lived port (`chrome.tabs.connect`, name `gdt-panel`) and
  the script pushes a snapshot of the paragraphs, then individual updates
  (a sentence's translation, the active sentence, the rate-limit banner,
  scroll position). The panel sends back sentence clicks and its own scroll
  position.
- **The port doubles as "is anyone looking?"** While there is no port (panel
  closed) or translation is switched off, `refreshFromDoc()` does nothing, so
  a closed panel costs no export fetches and no translation requests.
- **`background.js`** enables the panel only on `docs.google.com/document/`
  tabs and opens/closes it on request (`GDT_OPEN_PANEL` / `GDT_CLOSE_PANEL`).
  `sidePanel.open()` must run in direct response to a click, so the page
  button and the popup button call it with nothing awaited first.
- **Scroll sync** is keyed by paragraph plus how far through it, in both
  directions, over the port — not by scroll percentage.
- **The 🌐 button** is placed from live geometry every 500 ms: just under the
  formatting toolbar (clear of Docs' "hide the menus" chevron), at the right
  edge, slid left past anything labelled "Gemini" so it never overlaps. It is
  anchored by `right`, so it rides the viewport edge when the panel opens.
  `TOOLBAR_CLEARANCE_PX` and `BUTTON_RIGHT_MARGIN_PX` in `content.js` move it.

## Document tabs and page margins

- **Only the open document tab is translated.** Docs' export covers every
  tab unless told which one, so requests carry `&tab=<id>` (from the URL's
  `?tab=`; `t.0` when absent). Switching tabs is detected by watching the
  URL and, after a 1 s settle, drops everything from the old tab and fetches
  the new one.
- **Page margins come from the `.docx` export**, which stores them in
  `w:pgMar`. The HTML export under-reports them (changed bottom/left
  margins stayed at the 1-inch default while top/right updated), so the
  docx values override the mirror's page box. A layout change (not just a
  text change) also rebuilds the mirror. If the tab-specific docx request is
  refused, the plain one is used.
- **Page breaks follow Docs' widow/orphan control**: at least two lines of
  a paragraph on each side of a break, otherwise the lines (or a short
  paragraph, whole) move to the next page.
- **Clicks resolve from Docs' own caret** (`.kix-cursor-caret`) rather than
  the raw click pixel, so a click in the empty space right of a line, or in
  the gap between sentences, lands on the sentence the cursor is really in.

## How it works (v2 — shadow page mirror)

Current Google Docs renders the entire document body on `<canvas>`, with
**no DOM text mirror at all** — confirmed by direct inspection of a live
doc: every selector that used to find per-paragraph text
(`.kix-paragraphrenderer` and others) returns zero elements, and a full-tree
text search finds nothing. This isn't a renamed CSS class; the DOM text
layer that a v1 of this extension relied on has been removed from Docs
entirely. The extension now works around that with a technique in the same
family as PDF.js's text-layer-over-canvas, or the "shadow textarea" trick
used for caret-position measurement:

1. **Extraction** fetches `/export?format=html` (not `?format=txt`).
   Unlike plain text, Docs' HTML export carries real per-paragraph and
   per-run CSS (font, line-height, alignment, page margins/width) in a
   `<style>` block — exactly the information needed to reproduce layout.
   Each `<p>`, heading (`<h1>`–`<h6>`), and list item (`<li>`) is treated
   as one paragraph unit — headings and list items don't get wrapped in a
   nested `<p>` in the export, so a selector limited to `<p>` alone would
   silently skip every heading and every bulleted/numbered item in a
   document (confirmed on a real rules document: 6 headings + 34 list
   items against only 5 plain `<p>` paragraphs — ~90% of that document's
   content invisible to extraction, translation, and highlighting).
2. **The mirror**: a hidden Shadow DOM host is positioned and sized to
   exactly overlay the real, on-screen page box (`.kix-page-paginated` —
   unlike per-paragraph elements, the *page* container itself still exists
   as a real DOM node, even though its content is canvas). The exported
   stylesheet is injected into that shadow root (scoped for free by the
   shadow boundary, so it can't collide with anything on the real page)
   with every `pt` value rescaled to `px` using a factor derived from the
   real page's on-screen pixel width vs. its logical width in points — this
   naturally tracks the current Docs zoom level. The exported
   paragraphs/tables are cloned into it using that same scaled CSS.
3. The browser's own text-layout engine then wraps that content using the
   same font metrics and column width Docs used, so line breaks land in
   (very close to) the same places as the real, invisible canvas text.
   `getClientRects()` on a node inside this mirror reports real, on-screen
   coordinates, because the mirror sits exactly on top of the real page.
4. **Sentence-level highlighting**: within each paragraph's mirror node,
   text nodes are split (via `Text.splitText()`) and wrapped in
   `<span data-gdt-sent="i">` at sentence boundaries, without disturbing
   whatever original per-run styling spans already surround them — a
   sentence that straddles a styling change or a line wrap just ends up
   wrapped as multiple such spans, measured as the union of their rects.
5. **Highlight boxes** are inserted as real children of the relevant mirror
   node with `visibility: visible` set explicitly, overriding the
   `visibility: hidden` inherited from the mirror's otherwise-invisible
   ancestry (this is normal, spec'd CSS behavior). Because that mirror node
   is a real descendant of whatever actually scrolls the document, the
   highlight box scrolls natively with it — no scroll-position listener
   needed. (Their color/border styling lives in a `<style>` written
   directly into the shadow root, in `ensureMirror()` — content.css cannot
   reach anything inside the shadow boundary.)
6. **Click hit-testing** is geometric, not `elementsFromPoint`-based: since
   the mirror is deliberately `pointer-events: none` (so it never blocks
   real interaction with the document underneath it), a click's
   coordinates are compared directly against each paragraph's
   mirror-measured rect to find the paragraph, then the sentence, clicked.
- **Sentence splitting**: `Intl.Segmenter(..., {granularity: 'sentence'})`
  per paragraph (regex fallback if unavailable).
- **Translation**: routed through the background service worker (avoids the
  Docs page's CSP). Default backend is the free, keyless, unofficial Google
  Translate endpoint — fine for prototyping, but rate-limited and not
  ToS-guaranteed. Switch to **Google Cloud Translation API** or **DeepL API**
  (paste an API key in the popup) for real use. Translations are cached
  (`chrome.storage.local`) by `backend+targetLang+sentence text`, so unchanged
  sentences are never re-translated.
- **Change detection is now a poll**, not a `MutationObserver`: canvas
  repaints aren't DOM mutations, so there's no DOM signal left to react to.
  The export endpoint is re-fetched on an interval instead (with the same
  throttle/backoff as before), and a resize listener rebuilds the mirror's
  scale/position (zoom or window-size changes invalidate it even when the
  text hasn't changed).
- The panel's scroll position is kept in sync with the doc's in both
  directions by paragraph (see "The side panel" above).

## Known limitations (by design — architecture over polish first)

- **Multi-page documents**: each real, on-screen page box gets its own
  independently-positioned mirror (not one continuous column across the
  whole document). A paragraph/heading/list-item long enough to genuinely
  straddle a page break is itself *split* into two DOM fragments — one
  per page — at the exact line boundary where Docs really breaks it,
  using `Range.extractContents()` to cut the DOM without disturbing
  nested run styling. Verified against a real document down to the exact
  wording of both halves, including a sentence that itself straddles the
  split (its highlight correctly spans both fragments, stopping exactly
  at the real sentence boundary, not the page boundary). `<table>` is the
  one exception: a straddling table stays one atomic, unsplit block,
  since splitting it would need per-row reflow to keep column widths
  consistent across the cut, which is out of scope here.
- **Vertical spacing follows Docs' own rules, not the export's CSS.** The
  export gives every block its "space before/after paragraph" as its own
  `padding-top`/`padding-bottom`, but stacked padding boxes add where
  Docs' real spacing *collapses*. `collapseAdjacentBlockSpacing` resolves
  each adjacent pair to a single value before pagination:
  `max(previous space-after, next space-before)` normally, `0` between two
  consecutive `<li>`s (Docs applies no paragraph spacing at all between
  items of one list — only line height), and `0` at the top of a page,
  where the page break has already absorbed it (verified: a heading pushed
  to a page top by an explicit page break starts exactly at the page's
  content top, not its space-before below it). A list's *outer* boundaries
  are ordinary boundaries and take part in the `max()` rule like anything
  else — an earlier version excluded them along with the between-items
  case, and lost ~9.6px at every heading→list transition. See "Matching
  Docs' line and block geometry" below. *Horizontal*
  indentation: a nested list item gets a *different* class than its
  parent, carrying a larger `margin-left` (36pt per level, e.g. 36pt →
  72pt → 108pt) — this is real, load-bearing data, not incidental
  spacing, so `normalizeBlockEl` only zeroes `margin-top`/`margin-bottom`
  (the properties an errant browser default actually shows up on) and
  leaves `margin-left`/`margin-right` untouched. An earlier version zeroed
  `margin` outright, which deleted list indentation along with the
  intended vertical-margin fix — every nested item silently collapsed to
  the page's full text width.
- **Headers and footers are translated, but can't be highlighted.** Their
  text comes from a different export than the body's (see "Header and
  footer text" below) and appears in the panel as labelled entries. What
  they don't get is bidirectional highlighting: Docs draws them in the page
  margin, which the mirror doesn't cover, so there's nothing to point a
  click at or draw a box on. Their effect on the body's *geometry* — a tall
  header pushes it down, measured at 24px on a real document — is handled
  by measuring the rendered page (see "Calibrating against the rendered
  page").
- **Tables measure slightly short**, which can put a page break in the
  wrong place. A real table measured 503.5px against the mirror's 497
  (~1.3%); since a `<table>` is never split (below), enough accumulated
  drift lets a whole table land on a page Docs wouldn't have put it on,
  moving everything after it. Cell padding and border-collapse are the
  likely culprits; see "Open: tables push page breaks out of step" in
  `HANDOFF.md`.
- **Table rows are one clickable/translatable unit**, not split per cell —
  a coarser but robust tradeoff, unchanged from v1.
- **No OAuth / Docs API integration** — extraction uses the export
  endpoint rather than the structured Docs API. A future version could
  swap in the Docs API for authoritative paragraph/table structure instead
  of reverse-engineering it from exported HTML+CSS.
- Google could change the HTML export's class-naming scheme, the
  `.kix-page-paginated` page-anchor class, or move to a pageless-only
  model — if the panel doesn't appear or highlighting stops lining up,
  open DevTools console and look for `[GDT]` warnings first.

## Header and footer text

The HTML export throws headers and footers away. Where a header should be it
emits an empty `<div><p><span></span></p></div>` and nothing else — a header
holding a table exports as *no table at all*, with none of its words
anywhere in the file. `?format=txt` drops them too.

`?format=docx` keeps them, in `word/header*.xml` / `word/footer*.xml`. A
.docx is a ZIP, and Chrome can inflate one without a library:
`DecompressionStream("deflate-raw")` handles the only compression method
these parts use, so `fetchHeaderFooterTexts` needs just enough of the ZIP
central directory to locate the parts. Each `<w:p>` becomes one panel
entry, which is what puts a header table's cells in as separate,
separately-translatable lines rather than one run-on string.

Two practical notes:

- It's a much bigger download than the HTML export (a few hundred KB
  against a few dozen), so it runs on its own long throttle — a header
  changes far less often than the body.
- `header1`/`header2`/`header3` are the default, first-page and even-page
  headers. A document using "different first page" repeats the same text
  across more than one of them, so identical parts are de-duplicated.

Header and footer paragraphs carry `place: "header"` / `"footer"` and a null
`bodyIndex`, which is what keeps them out of the mirror's block mapping —
that mapping is by `bodyIndex`, not list position, precisely so adding a
header can't slide every body paragraph onto the wrong block.

## Calibrating against the rendered page

Two things about a document's real layout are in neither the export nor any
browser API, and both are worth several pixels a line:

- **Docs' natural line height for some fonts.** A line box is the font's
  natural height (ascent + descent + line gap) times the paragraph's
  line-spacing multiple. For Arial the browser agrees exactly (1.1499 em,
  and a real 16px Arial caret measures 18.4px). For Roboto it does not:
  the browser reports 1.1715 em (the font's `hhea` metrics) while Docs lays
  out at 1.2002 em (its OS/2 `usWin` metrics) — a real 16px Roboto caret
  measures 19.2px. Docs appears to take the larger of the two metric sets;
  the browser only ever exposes `hhea` (`line-height: normal`) or a
  platform-dependent pick (Canvas `fontBoundingBox` returned `usWin` for
  Arial but `hhea` for Roboto).
- **How far a page header pushes the body down**, which the export can't
  say because it doesn't contain the header at all.

Both are recovered by reading back the page Docs actually drew.
`calibrateAgainstRealPage` takes an ink profile of the canvas, pairs those
bands against the mirror's own predicted lines, and derives (a) a per-font
correction to the natural line height and (b) the body's true starting
offset on the page; the mirror is then rebuilt with those and re-measured,
up to three passes. Everything is bounded and has to be supported by
several samples — a mis-calibration would be worse than the pixels it
fixes, and on a document that needs no correction it must be a no-op.

Two things make it harder than it sounds, both learned the hard way:

- **Docs rounds every line's position to a whole pixel**, so each end of a
  measured span carries up to half a pixel of rounding. Across a
  five-line paragraph that's most of a percent — the same size as the
  effect being measured, and it "corrected" Arial by 0.7% when Arial was
  already exact. Per-paragraph spans now only decide *which* font is
  wrong; *how* wrong comes from a span across the whole page, where the
  same rounding is under a tenth of a percent.
- **A hidden tab has no canvas to read.** Chrome discards a backgrounded
  tab's backing store and Docs stops painting into it, so `getImageData`
  returns fully transparent every time. Calibration waits for
  `visibilitychange` rather than burning its retry budget.

The current state is readable off the mirror host as
`data-gdt-calibration` — see "Debugging".

## Pages are recycled tiles, not one element each

Docs does not keep a DOM element per page. `.kix-page-paginated` elements
are tiles from a small pool (two, in a 100%-zoom window) living inside
`.kix-rotatingtilemanager-content`, re-pointed at whichever pages are near
the viewport by rewriting each one's absolute `top`. So the elements on
hand are neither all of the document's pages nor in document order —
scrolled to the end of a four-page document, `querySelectorAll` returns two
elements and the *first* one is page four.

`getPageLayout()` describes the whole document from however few of them
exist: each element's `offsetTop` is its document-space position, pages are
evenly pitched (page height + gap, read off two adjacent tiles), any one
page's offset modulo that pitch recovers where page zero starts, and
`.kix-rotatingtilemanager`'s own height covers the whole document — note
its `-content` child does *not*, it stretches only as far as the tiles that
currently exist. The mirror then builds one container per real page and
positions it in that same space, so a container for an unrendered page
simply sits where that page will be once the user scrolls to it.

## Matching Docs' line and block geometry

The mirror is only useful if the browser lays its text out at the same
`y` as Docs' canvas renderer does. Four rules, each measured against the
real thing (see "Measuring the real page" below), reproduce a real
document's line positions to within 0.7px over a full two-page document —
which is the measurement floor, since Docs rounds caret positions to
whole pixels.

1. **Line box height = the font's natural line height x Docs' line-spacing
   multiple.** Natural line height means ascent + descent + line gap
   (1.1499 em for Arial), *not* CSS's `font-size x multiple` — those differ
   by ~15%, which is a full line of drift by line 15 of a long paragraph.
2. **Measured off the run, not the block.** Docs' export puts paragraph
   styling on the block's class but font-size on the `<span>`s inside it,
   and for headings the two genuinely disagree (an `<h2>` element at
   21.333px around a 22.667px run). `normalizeBlockEl` takes the largest
   run's font, and sets the block's own `font-size` to match so the line's
   invisible strut can't outgrow the line-height.
3. **Adjacent blocks' spacing collapses** — see the bullet above.
4. **Leading hangs below the text.** Docs starts a line's glyphs flush
   with the top of the line box and puts all the extra leading underneath;
   CSS splits it half above, half below. The blocks carry a
   `position: relative; top: -halfLeading` to cancel that — it moves every
   measured rect without touching the layout the paginator depends on.

### Measuring the real page

Two techniques give exact ground truth about the canvas-rendered document,
without trusting anything the mirror itself computed (a mirror rect
compared against a mirror rect only proves internal consistency — a
mistake worth not repeating):

- **The caret is real DOM.** `.kix-cursor-caret` is an ordinary element
  with an exact `getBoundingClientRect()`, and its top is the *line box*
  top while its height is the run's natural line height. Walking the
  document with the Down arrow and recording that rect at each step yields
  every real line's position, glyph-independently.
- **The canvas is readable.** `.kix-canvas-tile-content` is same-origin
  and untainted, so `getImageData` works: scanning rows for dark pixels
  gives an ink profile, i.e. exactly where each line's glyphs are. Useful
  as an independent cross-check and for spotting which lines exist at all.

Both beat eyeballing a screenshot, and both are non-destructive. When a
question genuinely needs an edit (e.g. "does Docs suppress space-before at
a page top?" — press Cmd+Enter before a heading, measure, then Cmd+Z),
verify the document is byte-identical afterwards by re-running the ink
profile and comparing band positions against the pre-edit baseline.

## Debugging

All logs/warnings are prefixed `[GDT]`. Useful things to check in the
console on a live doc:
- `document.querySelector('.kix-page-paginated')` should find the visible
  page box the mirror anchors to.
- `document.getElementById('gdt-shadow-mirror-host').shadowRoot` — the
  live mirror. Content scripts run in an isolated JS world, so
  `window.__GDT_DEBUG_STATE__` (see below) isn't reachable from the page's
  own console context on a real Google Docs tab, but DOM elements like this
  one are shared and inspectable normally.
- A `No page anchor element found` warning means highlighting is
  unavailable for this document (translation/panel still work).
- `document.getElementById('gdt-shadow-mirror-host').dataset.gdtCalibration`
  reports what the last calibration pass decided: its `outcome`
  (`changed` / `clean` / `unreadable`), whether the tab was `hidden` at the
  time, the per-font `naturalRatios` it corrected, and the `originShifts` it
  applied to page 1 and to every later page. `unreadable` with
  `hidden: true` is normal and self-correcting — it just means nobody was
  looking at the page yet.

## Local testing (no real Google Doc needed)

`test/mock-docs.html` recreates just enough of the real Docs shape — a
`.kix-page-paginated` box for the mirror to anchor to, and canned export
HTML with the same `<style>`-class structure Google's own export uses
(including a table, to exercise the row-handling path) — to test
extraction, translation, mirror-building, and click sync without touching
a real document. It loads the actual unmodified `content/content.js` and
`content/content.css`, and — since it runs as an extension page, not an
isolated content-script world — has real `chrome.runtime`/`chrome.storage`
access *and* a directly inspectable `window.__GDT_DEBUG_STATE__` (unlike on
a real Docs tab, where the isolated world hides it from the page's own
console context).

1. Load the extension unpacked, then copy its ID from `chrome://extensions`.
2. Navigate to `chrome-extension://<EXTENSION_ID>/test/mock-docs.html`.
3. Use the "Dump extension state" button (or `window.__GDT_DEBUG_STATE__`
   in the console) to inspect paragraph/sentence/mirror state directly.

The mock page has no side panel, so its canned-export hook
(`__GDT_MOCK_EXPORT_HTML__`) also stands in for "a panel is open" and the
translation list itself isn't drawn there — use the dump button to inspect
state.

Editing `content.js` only requires reloading that tab (not the extension or
a real doc) to see changes — reload the extension in `chrome://extensions`
too if a change doesn't seem to take effect.

Two globals let the mock page control `content.js` without touching a real
Google Doc — both are always `undefined` on real `docs.google.com` pages,
so they're no-ops there:
- `window.__GDT_FORCE_DOC_ID__` — a fake doc ID (bypasses the URL check).
- `window.__GDT_MOCK_EXPORT_HTML__` — canned `/export?format=html` content
  (bypasses the network fetch).
