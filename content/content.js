// Google Docs Live Translator — content script
//
// ARCHITECTURE NOTE (v2 — shadow page mirror)
//
// Current Google Docs renders the document body entirely on <canvas>, with
// no DOM text mirror at all (confirmed live: `.kix-paragraphrenderer` and
// every other selector previously used for this returns zero elements, and
// a full-tree text search finds nothing — this isn't a renamed class, the
// DOM text layer simply doesn't exist anymore). That makes the old
// "read text directly off real paragraph elements, highlight by inserting
// a child of that element" design impossible: there is no such element.
//
// The replacement technique (same family as PDF.js's text-layer-over-canvas,
// or the "shadow textarea" trick used for caret-position measurement):
//
//   1. Fetch `/export?format=html` instead of `?format=txt`. Unlike plain
//      text, Docs' HTML export carries real per-paragraph and per-run CSS
//      (font-family/size, line-height, alignment, page margins/width) in a
//      `<style>` block with short class names (`.c0`, `.c1`, ...).
//   2. Parse that HTML (via DOMParser — safe here because content scripts
//      run in an isolated JS world with their own untouched built-ins, even
//      though the *page's* own DOMParser is wrapped by a Trusted-Types
//      policy that would reject this same call if run in the page's world).
//   3. Build a hidden "mirror": a shadow-DOM host positioned and sized to
//      exactly overlay the real, on-screen page box (`.kix-page-paginated`,
//      which — unlike per-paragraph elements — still exists as a real DOM
//      node even though its *content* is canvas). Inject the exported
//      stylesheet (scoped for free by the shadow boundary) with every `pt`
//      value rescaled to `px` using a factor derived from the real page's
//      on-screen pixel width vs. its logical width in points, and clone the
//      exported paragraphs/tables into it using that same scaled CSS.
//   4. The browser's own text-layout engine then wraps that content using
//      the same font metrics and column width Docs used, so line breaks
//      land in (very close to) the same places. `getClientRects()` on a
//      node inside this mirror reports *real, on-screen* coordinates,
//      because the mirror is positioned to sit exactly on top of the real
//      page — even though it's invisible (`visibility: hidden`).
//   5. A highlight box is inserted as a real child of the relevant mirror
//      node with `visibility: visible` set explicitly (which overrides the
//      inherited `hidden` from its hidden ancestor — a normal, spec'd CSS
//      behavior). Because that mirror node already scrolls natively with
//      the real page (see "mirror placement" below), the highlight box
//      does too, for free — no scroll-position listener needed.
//
// Known limitations of this approach (accepted for v1, documented so they
// aren't mistaken for bugs later):
//   - Multi-page documents: each real, on-screen page box gets its own
//     independently-positioned mirror container (not one continuous
//     column), and a paragraph/heading/list-item long enough to genuinely
//     straddle a page break is itself split into two DOM fragments — one
//     per page — at the exact line boundary where the real page breaks
//     (see paginateBlocks/splitLeafAtHeight). `<table>` is the one
//     exception: a straddling table stays one atomic, unsplit block, since
//     splitting it would need per-row reflow to keep column widths
//     consistent across the split, which is out of scope here.
//   - Mixed run styles within one paragraph use only the *first* run's
//     font for wrap-width purposes is avoided (every run's own class is
//     preserved via cloning), but a sentence that itself straddles a
//     styling change (or now, a page-split point) is measured as the
//     union of its (possibly several) fragments' rects — correct, but
//     slightly more fragile than a single rect if the export's run
//     boundaries are unusual.
//   - Table rows remain one highlightable/clickable unit (same
//     simplification as before), not split per cell or per sentence.
//   - No DOM-mutation signal exists anymore for "text changed" (canvas
//     repaints aren't DOM mutations), so change detection is now a poll of
//     the export endpoint on an interval, not a MutationObserver.

(() => {
  const LOG_PREFIX = "[GDT]";
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  const PAGE_SELECTORS = [".kix-page-paginated", ".kix-page"];
  const CONTAINER_SELECTORS = [
    ".kix-appview-editor-container",
    ".kix-appview-editor",
    "#docs-editor",
  ];

  // Sustained polling at 6s previously drove Google's export endpoint into
  // a persistent 429 rate-limit within a few minutes of normal use (see the
  // note above fetchExportHtml) — 15s cuts steady-state request volume by
  // more than half while still feeling live for normal editing pace.
  const REFRESH_POLL_MS = 15000;
  // Independent of REFRESH_POLL_MS — this only re-measures and nudges the
  // mirror's position (see repositionMirrorTick below), it doesn't touch
  // the network, so a much shorter interval is cheap and keeps position
  // drift from Docs' own UI chrome (a "Saving…" indicator, a banner, etc.)
  // from ever accumulating enough to throw off a click.
  const REPOSITION_TICK_MS = 500;
  const TAB_SETTLE_MS = 1000;
  const RESIZE_DEBOUNCE_MS = 300;
  const CLICK_HIT_TEST_SLOP_PX = 40; // how far a click may be from the nearest paragraph and still count

  /** @type {{
   *   docId: string|null,
   *   enabled: boolean,
   *   targetLang: string,
   *   sidePanelPort: chrome.runtime.Port|null,
   *   floatingBtn: HTMLElement|null,
   *   paragraphs: Array<{
   *     id: string,
   *     kind: 'p'|'row',
   *     text: string,
   *     sentences: Array<{ id: string, text: string, translated: string|null, error: string|null }>,
   *     mirrorEls: Element[],
   *   }>,
   *   activeHighlight: { paragraph: object, sentenceIndex: number } | null,
   *   activeHighlightBoxes: HTMLElement[],
   *   lastSignature: string|null,
   *   lastBodyNode: Element|null,
   *   lastStyleText: string,
   *   lastBodyClassAttr: string,
   *   mirror: { host: HTMLElement, shadow: ShadowRoot, styleEl: HTMLElement, container: HTMLElement }|null,
   * }}
   */
  const state = {
    docId: null,
    enabled: true,
    scrollSync: true,
    targetLang: "zh-CN",
    sidePanelPort: null,
    stale: false,
    floatingBtn: null,
    paragraphs: [],
    activeHighlight: null,
    activeHighlightBoxes: [],
    lastSignature: null,
    lastBodyNode: null,
    lastStyleText: "",
    lastBodyClassAttr: "",
    headerFooter: null,
    headerFooterSignature: null,
    mirror: null,
    lastTabId: null,
    // Page margins/width in pt from the docx export (see fetchHeaderFooterTexts).
    docxPage: null,
    // Extra distance the real body starts below the page's top margin,
    // which only a page header causes and only measurement can reveal
    // (see calibrateAgainstRealPage). Index 0 is page 1 — the page a
    // "different first page" header lands on — and index 1 covers every
    // page after it.
    pageOriginShifts: [0, 0],
  };

  // ---------- utilities ----------

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function querySelectorFirst(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function ensurePositioned(el) {
    if (getComputedStyle(el).position === "static") {
      el.style.position = "relative";
    }
  }

  function getDocId() {
    // Test hook (see test/mock-docs.html): lets the local mock page force
    // a doc ID without a real docs.google.com URL. Always undefined on
    // real Google Docs pages, so this is a no-op there.
    if (window.__GDT_FORCE_DOC_ID__) return window.__GDT_FORCE_DOC_ID__;
    const m = location.pathname.match(/\/document\/d\/([^/]+)/);
    return m ? m[1] : null;
  }

  // Google Docs "document tabs": the URL carries `?tab=t.<id>` for whichever
  // tab is open, and omits it for the first tab (always `t.0`). The export
  // endpoint covers *every* tab unless told which one to export, so without
  // this the panel translated the whole document instead of just the tab
  // the user is looking at.
  function getTabId() {
    const m = location.search.match(/[?&]tab=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : "t.0";
  }

  function exportUrl(docId, format) {
    return `https://docs.google.com/document/d/${docId}/export?format=${format}&tab=${encodeURIComponent(getTabId())}`;
  }

  // ---------- export fetch (HTML — carries the styling the mirror needs) ----------

  const EXPORT_FETCH_MIN_INTERVAL_MS = 4000;
  // A 429 means content.js's *own* view of the document is now stale — the
  // mirror and every rect it reports are still built from whatever export
  // last succeeded, even though the real page keeps changing underneath
  // it. Observed in practice: a fixed 30s backoff isn't enough — Google's
  // export endpoint can stay rate-limited for minutes once tripped, and a
  // fixed short retry just re-triggers 429 in a self-sustaining loop
  // forever, silently, with no visible sign to the user that translations
  // and highlight positions have stopped tracking the document at all
  // (this is the most likely explanation for "highlight doesn't match" —
  // not a flaw in the mirror's geometry, but stale input to it). Backing
  // off exponentially, and surfacing staleness in the panel (see
  // setStale()), turns a silent failure into a visible, recoverable one.
  const EXPORT_FETCH_BACKOFF_BASE_MS = 30000;
  const EXPORT_FETCH_BACKOFF_MAX_MS = 5 * 60000;
  let lastExportFetchAt = 0;
  let exportFetchBackoffUntil = 0;
  let consecutiveFailures = 0;

  async function fetchExportHtml(docId) {
    // Test hook (see test/mock-docs.html): lets the local mock page supply
    // canned export HTML instead of hitting the network. Always undefined
    // on real Google Docs pages, so this is a no-op there.
    if (window.__GDT_MOCK_EXPORT_HTML__ !== undefined) {
      return window.__GDT_MOCK_EXPORT_HTML__;
    }

    const now = Date.now();
    if (now < exportFetchBackoffUntil) {
      const err = new Error(
        `export fetch skipped: backing off after a rate limit until ${new Date(exportFetchBackoffUntil).toLocaleTimeString()}`
      );
      err.skip = true; // benign — staleness is already flagged from the 429 that triggered this backoff
      throw err;
    }
    if (now - lastExportFetchAt < EXPORT_FETCH_MIN_INTERVAL_MS) {
      const err = new Error("export fetch skipped: throttled (fetched too recently)");
      err.skip = true; // benign — just two triggers landing close together, not a real failure
      throw err;
    }
    lastExportFetchAt = now;

    const url = exportUrl(docId, "html");
    // Default ("same-origin") credentials mode: the initial request to
    // docs.google.com is same-origin so cookies are sent automatically.
    // Docs redirects internally to a signed googleusercontent.com URL that
    // serves an `Access-Control-Allow-Origin: *` header — combined with
    // `credentials: 'include'` that combination is rejected by CORS, so we
    // must NOT force credentials on this request.
    const res = await fetch(url);
    if (res.status === 429) {
      consecutiveFailures += 1;
      const backoff = Math.min(
        EXPORT_FETCH_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1),
        EXPORT_FETCH_BACKOFF_MAX_MS
      );
      exportFetchBackoffUntil = Date.now() + backoff;
      throw new Error(`export fetch failed: HTTP 429 (rate limited, backing off ${Math.round(backoff / 1000)}s)`);
    }
    if (!res.ok) {
      throw new Error(`export fetch failed: HTTP ${res.status}`);
    }
    consecutiveFailures = 0;
    return res.text();
  }

  // ---------- sentence splitting ----------

  let segmenter = null;
  function getSegmenter() {
    if (segmenter !== null) return segmenter;
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    } else {
      segmenter = false;
    }
    return segmenter;
  }

  function segmentSentences(text) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const seg = getSegmenter();
    if (seg) {
      const out = [];
      for (const { segment } of seg.segment(trimmed)) {
        const s = segment.trim();
        if (s) out.push(s);
      }
      return out;
    }
    return trimmed
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ---------- HTML export parsing ----------

  function parseExportedDocument(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const styleEl = doc.querySelector("style");
    return {
      styleText: styleEl ? styleEl.textContent : "",
      bodyNode: doc.body,
    };
  }

  // Collects, in document order, the "block" nodes we treat as one
  // paragraph unit: top-level <p> elements (including ones nested in lists,
  // but not ones inside a <table>) and <tr> elements (a whole table row is
  // one coarser unit — see the architecture note above).
  // Block-level tags treated as one paragraph unit each: plain paragraphs,
  // headings, and list items. Google's HTML export doesn't wrap heading or
  // list text in a nested <p> — the <hN>/<li> element itself holds the
  // run spans directly — so a selector limited to "p" (the original
  // assumption) silently skips every heading and every bulleted/numbered
  // list item in a document. Confirmed on a real rules document: 6
  // headings + 34 list items across 5 lists, against only 5 plain <p>
  // paragraphs — i.e. the selector was missing ~90% of that document's
  // content from extraction, translation, and highlighting entirely.
  const TEXT_BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI"]);

  function extractBlockNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.tagName === "TR") return NodeFilter.FILTER_ACCEPT;
        if (TEXT_BLOCK_TAGS.has(node.tagName) && !node.closest("table")) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function leafText(node) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let out = "";
    let n;
    while ((n = walker.nextNode())) out += n.data;
    return out;
  }

  function textOfBlock(node) {
    if (node.tagName === "TR") {
      const cells = Array.from(node.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
      return cells.map((c) => leafText(c).trim()).join("  ");
    }
    return leafText(node);
  }

  function makeParagraph(id, kind, text, place, bodyIndex) {
    return {
      id,
      kind,
      text,
      // "body" paragraphs are the ones the mirror lays out and can
      // highlight; header/footer ones exist only in the panel, since Docs
      // draws them in the page margin and the HTML export doesn't describe
      // them at all (see fetchHeaderFooterTexts).
      place,
      // Position among *body* blocks only — what rebuildMirror matches its
      // cloned blocks against. Null for anything not in the body flow, so
      // adding a header can't shift the body's mapping.
      bodyIndex,
      sentences: segmentSentences(text).map((sText, sIdx) => ({
        id: `${id}-s${sIdx}`,
        text: sText,
        translated: null,
        error: null,
      })),
      mirrorEls: [],
    };
  }

  function buildParagraphsFromBlocks(blockNodes) {
    return blockNodes.map((node, i) =>
      makeParagraph(`p${i}`, node.tagName === "TR" ? "row" : "p", textOfBlock(node), "body", i)
    );
  }

  // Header first, then the body, then the footer — the order they're read
  // in. Translations already in hand are carried across by matching text,
  // so a poll that only changed the body doesn't re-translate the header.
  function composeParagraphs(bodyParagraphs) {
    const headerTexts = (state.headerFooter && state.headerFooter.header) || [];
    const footerTexts = (state.headerFooter && state.headerFooter.footer) || [];
    const marginal = (texts, place, prefix) =>
      texts.map((text, i) => makeParagraph(`${prefix}${i}`, "p", text, place, null));
    const next = [...marginal(headerTexts, "header", "h"), ...bodyParagraphs, ...marginal(footerTexts, "footer", "f")];
    const previousByText = new Map();
    for (const p of state.paragraphs) {
      if (!previousByText.has(p.text)) previousByText.set(p.text, p);
    }
    for (const p of next) {
      if (p.place === "body") continue; // body reuse is by position, below
      const prev = previousByText.get(p.text);
      if (prev && prev.place === p.place) p.sentences = prev.sentences;
    }
    return next;
  }

  // ---------- header / footer text (from the .docx export) ----------
  //
  // The HTML export throws headers and footers away. Where a header should
  // be it emits an empty `<div><p><span></span></p></div>` and nothing
  // else — a header holding a table exports as no table at all, with none
  // of its words anywhere in the file. `?format=txt` drops them too.
  //
  // `?format=docx` keeps them, in `word/header*.xml` / `word/footer*.xml`.
  // A .docx is a ZIP, and Chrome can inflate one without a library:
  // `DecompressionStream("deflate-raw")` handles the only compression
  // method these parts ever use, so all that's needed here is enough of
  // the ZIP central directory to find the parts and their offsets.
  //
  // This is a second, much larger download (a few hundred KB against the
  // HTML export's few dozen), so it's fetched on its own long throttle
  // rather than on every poll — a header changes far less often than the
  // body does.
  const HEADER_FETCH_MIN_INTERVAL_MS = 120000;
  const ZIP_EOCD_SIGNATURE = 0x06054b50;
  const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
  const ZIP_MAX_COMMENT_BYTES = 66000; // 64KB comment + the 22-byte record
  let lastHeaderFetchAt = 0;

  function readZipDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - ZIP_MAX_COMMENT_BYTES); i--) {
      if (view.getUint32(i, true) === ZIP_EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const entries = [];
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_SIGNATURE) break;
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      entries.push({
        name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
        method,
        compressedSize,
        localHeaderOffset,
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return { view, entries };
  }

  async function readZipEntryText(bytes, view, entry) {
    // The central directory records where each entry's *local* header is;
    // the data itself starts past that header's own variable-length name
    // and extra fields, whose lengths can differ from the central copy's.
    const nameLength = view.getUint16(entry.localHeaderOffset + 26, true);
    const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
    const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const raw = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return new TextDecoder().decode(raw);
    if (entry.method !== 8) return null; // nothing else turns up in a .docx
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const inflated = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(inflated));
  }

  // One string per paragraph of a header/footer part. A table cell is its
  // own `<w:p>`, which is what puts "Name", "Michael Chang", "Date", ...
  // into the panel as separate, separately-translatable entries rather
  // than one run-on line.
  function wordPartParagraphs(xml) {
    // DOMParser is safe in a content script's isolated world even though
    // the page's own copy is behind a Trusted-Types policy — same reason
    // parseExportedDocument can use it.
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return [];
    return Array.from(doc.getElementsByTagName("w:p"))
      .map((para) => Array.from(para.getElementsByTagName("w:t")).map((t) => t.textContent).join(""))
      .map((text) => text.trim())
      .filter(Boolean);
  }

  async function fetchHeaderFooterTexts(docId) {
    const now = Date.now();
    if (now < exportFetchBackoffUntil) return null; // already rate-limited; don't make it worse
    if (now - lastHeaderFetchAt < HEADER_FETCH_MIN_INTERVAL_MS) return null;
    lastHeaderFetchAt = now;

    // No `credentials: "include"` — same reason as fetchExportHtml: Docs
    // redirects to a signed googleusercontent.com URL whose
    // `Access-Control-Allow-Origin: *` is incompatible with credentialed
    // requests, and the fetch fails outright.
    // Headers, footers and page setup are document-wide, so if the
    // tab-specific request is refused, the plain one answers the same
    // question (observed: the `tab` variant 429ing while the plain one
    // succeeded).
    let res = await fetch(exportUrl(docId, "docx"));
    if (!res.ok) res = await fetch(`https://docs.google.com/document/d/${docId}/export?format=docx`);
    if (!res.ok) throw new Error(`docx export failed: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const zip = readZipDirectory(bytes);
    if (!zip) throw new Error("docx export was not a readable zip");

    const collect = async (pattern) => {
      const out = [];
      const seen = new Set();
      // header1/header2/header3 are the default, first-page and even-page
      // headers; a document using "different first page" has the same text
      // in more than one of them, and the reader only wants it once.
      for (const entry of zip.entries.filter((e) => pattern.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
        const xml = await readZipEntryText(bytes, zip.view, entry);
        if (!xml) continue;
        const paragraphs = wordPartParagraphs(xml);
        if (!paragraphs.length) continue;
        const key = paragraphs.join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(...paragraphs);
      }
      return out;
    };

    // The HTML export under-reports page margins (observed: bottom and left
    // stuck at the 1in default after being changed in Page setup, while top
    // and right did update), so the docx's own page settings are the source
    // of truth for them. A document with several sections has several
    // `pgMar`s; the last is the body-level one.
    let page = null;
    const docEntry = zip.entries.find((e) => e.name === "word/document.xml");
    if (docEntry) {
      const xml = await readZipEntryText(bytes, zip.view, docEntry);
      const mar = xml && Array.from(xml.matchAll(/<w:pgMar\b[^>]*>/g)).pop();
      const sz = xml && Array.from(xml.matchAll(/<w:pgSz\b[^>]*>/g)).pop();
      const twips = (tag, attr) => {
        const m = tag && tag[0].match(new RegExp(`w:${attr}="(-?\\d+)"`));
        return m ? parseInt(m[1], 10) / 20 : null;
      };
      const top = twips(mar, "top");
      const right = twips(mar, "right");
      const bottom = twips(mar, "bottom");
      const left = twips(mar, "left");
      const width = twips(sz, "w");
      if ([top, right, bottom, left, width].every((v) => v !== null && v >= 0)) {
        page = { top, right, bottom, left, width };
      }
    }

    return {
      header: await collect(/^word\/header\d*\.xml$/),
      footer: await collect(/^word\/footer\d*\.xml$/),
      page,
    };
  }

  // ---------- shadow mirror (invisible, real-layout clone of the page) ----------
  //
  // One mirror *page container* per page of the real document (see
  // getPageLayout — that is *not* the same as one per rendered
  // `.kix-page-paginated` element, of which Docs keeps only a recycled
  // handful) — not one continuous column. An earlier version used a single
  // column for the whole document, which is exactly right for a one-page
  // document but silently wrong for anything longer: the real page break
  // introduces a vertical gap (the rest of page 1's blank space plus page
  // 2's own top margin) that a continuous column has no way to know about,
  // so every line after the break drifts further out of sync the deeper
  // into page 2 (or beyond) you go. Confirmed directly: typing a marker
  // character at a mirror-computed coordinate for text that had scrolled
  // onto page 2 landed the marker back on page 1. Each page container
  // below is independently positioned over its own real page box, so that
  // gap is a property of *where the containers sit*, not something the
  // content flow needs to model itself.

  function getPageEls() {
    return Array.from(document.querySelectorAll(PAGE_SELECTORS.join(", ")));
  }

  // Docs does not keep one DOM element per page. `.kix-page-paginated`
  // elements are *recycled tiles*: the editor keeps a small pool of them
  // (two, in a 100%-zoom window) inside `.kix-rotatingtilemanager-content`
  // and re-points them at whichever pages are near the viewport, moving
  // each one by rewriting its absolute `top`. So the rendered elements are
  // neither all of the document's pages nor even in document order —
  // scrolled to the end of a four-page document, `querySelectorAll`
  // returned exactly two elements, and the *first* in DOM order was page
  // four. Treating `pageEls[i]` as "page i" (as this code used to) is
  // therefore wrong the moment a document is longer than the pool: only
  // the first two pages' worth of content got mirrored at all, and after
  // any scroll those two mirrors sat over the wrong pages entirely.
  //
  // What *is* stable is the tile manager's coordinate space. Every page
  // element carries its document-space position in `offsetTop`, pages are
  // evenly pitched (page height + inter-page gap), and the tile content's
  // `scrollHeight` reaches the bottom of the last page whether or not that
  // page is currently rendered. That's enough to describe every page in
  // the document from however few of them happen to exist right now — so
  // the mirror builds one container per *real* page and positions it in
  // that same space, and a container for an unrendered page simply sits
  // where that page will be when the user scrolls to it.
  // NOT `.kix-rotatingtilemanager-content` (the inner element the page
  // tiles are actually positioned in): that one only stretches as far as
  // the tiles that currently exist, so at the top of a four-page document
  // it reports the height of two. Its parent carries an explicit height
  // for the whole document, scrolled or not.
  const TILE_MANAGER_SELECTOR = ".kix-rotatingtilemanager";
  const PAGE_GAP_FALLBACK_PX = 10;
  let cachedPagePitchPx = null;

  function getPageLayout() {
    const rendered = getPageEls();
    if (!rendered.length) return null;
    const pages = rendered
      .map((el) => ({ docTop: el.offsetTop, rect: el.getBoundingClientRect() }))
      .sort((a, b) => a.docTop - b.docTop);
    const width = pages[0].rect.width;
    const height = pages[0].rect.height;
    if (!(width > 0) || !(height > 0)) return null;

    // If `offsetTop` isn't telling us anything (a Docs layout this doesn't
    // know about, or the `.kix-page` fallback selector matching something
    // that isn't absolutely positioned), fall back to the old one
    // container per rendered element, in on-screen order — wrong for a
    // long document, but no worse than before, and never wrong for a
    // document short enough to be rendered in full.
    const distinctDocTops = new Set(pages.map((p) => p.docTop)).size;
    if (pages.length > 1 && distinctDocTops < pages.length) {
      const byScreen = rendered
        .slice()
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      return {
        count: byScreen.length,
        rects: byScreen.map((el) => el.getBoundingClientRect()),
        width,
        height,
        renderedPages: byScreen.map((el, i) => ({ el, index: i })),
      };
    }

    let pitch = null;
    for (let i = 1; i < pages.length; i++) {
      const gap = pages[i].docTop - pages[i - 1].docTop;
      if (gap > 0 && (pitch === null || gap < pitch)) pitch = gap;
    }
    if (pitch) cachedPagePitchPx = pitch;
    else pitch = cachedPagePitchPx || height + PAGE_GAP_FALLBACK_PX;

    // Every page sits at `firstTop + n * pitch`, so any one page's offset
    // modulo the pitch recovers where page 0 starts.
    const firstTop = ((pages[0].docTop % pitch) + pitch) % pitch;

    let count = Math.round((pages[pages.length - 1].docTop - firstTop) / pitch) + 1;
    const tile = document.querySelector(TILE_MANAGER_SELECTOR);
    if (tile) {
      // The scrollable extent runs from the first page's top to the last
      // page's bottom, plus a matching inset at the end — so it lands
      // somewhere inside the last page's own pitch, and flooring picks out
      // the page count without needing to know what that inset is.
      const full = Math.max(tile.scrollHeight, tile.clientHeight);
      const derived = Math.floor((full - firstTop) / pitch);
      if (derived >= 1) count = Math.max(count, derived);
    }
    count = Math.max(count, rendered.length);

    const refDocTop = pages[0].docTop;
    const refViewportTop = pages[0].rect.top;
    const left = pages[0].rect.left;
    const rects = [];
    for (let i = 0; i < count; i++) {
      rects.push({
        top: refViewportTop + (firstTop + i * pitch - refDocTop),
        left,
        width,
        height,
      });
    }
    // Which *document* page each currently-rendered tile is showing — the
    // only way to line a real, readable page up with its mirror container.
    const renderedPages = rendered
      .map((el) => ({ el, index: Math.round((el.offsetTop - firstTop) / pitch) }))
      .filter((p) => p.index >= 0 && p.index < count);
    return { count, rects, width, height, renderedPages };
  }

  function ensureMirror() {
    if (state.mirror && state.mirror.host.isConnected) return state.mirror;
    const host = document.createElement("div");
    host.id = "gdt-shadow-mirror-host";
    // Deliberately NOT positioned: an absolutely-positioned page container
    // (below) with no other positioned ancestor is placed relative to the
    // real scroll container directly, exactly as if it were that
    // container's own child — which is what positionPageContainer's math
    // assumes. Zero size so this takes no layout space of its own even
    // though it's `position: static` (in normal flow).
    host.style.margin = "0";
    host.style.width = "0";
    host.style.height = "0";
    host.style.overflow = "visible";
    host.style.visibility = "hidden";
    host.style.pointerEvents = "none";

    const shadow = host.attachShadow({ mode: "open" });

    // Shadow DOM encapsulation cuts both ways: it's *why* Google's own
    // `.c0`/`.c1`/`.c2` export classes can be dropped in here without
    // leaking onto the real page, but it equally means our own
    // content.css (injected into the light DOM by the manifest) never
    // reaches anything in here either. This base stylesheet (written once,
    // untouched by the per-refresh rescaling below) is what actually makes
    // `.gdt-original-highlight-box` visible — without it the box has
    // correct geometry and `visibility: visible` but no paint at all.
    const baseStyleEl = document.createElement("style");
    baseStyleEl.textContent = `
      /* Docs expresses every bit of real vertical spacing as padding on
         the element's own exported class (see normalizeBlockEl), so any
         vertical *margin* here is a browser default leaking in — and the
         export doesn't always override them. A bare <hr> is the case that
         surfaced this: Google emits horizontal lines as <hr> with no rule
         of its own, so the UA's 0.5em block margins applied and every line
         cost 15px of flow where the real document spends under one. That
         pushed everything after a horizontal line 14px down the page.
         It also broke the paginator, which measures blocks with
         getBoundingClientRect() — that reports the <hr>'s 2px border box
         and cannot see the 13px of margin around it, so the two disagreed
         about how much of the page each line had used.

         No !important, and this sits before the exported stylesheet, so
         anything the export does set still wins; this only clears defaults
         nothing else has an opinion about. */
      hr, ul, ol, dl, table, blockquote, figure, pre, h1, h2, h3, h4, h5, h6, p {
        margin-top: 0;
        margin-bottom: 0;
      }
      .gdt-original-highlight-box {
        position: absolute;
        pointer-events: none;
        background: rgba(255, 224, 138, 0.4);
        border-left: 3px solid #e0a800;
        animation: gdt-highlight-fade-in 0.15s ease;
      }
      @keyframes gdt-highlight-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    `;
    shadow.appendChild(baseStyleEl);

    const styleEl = document.createElement("style");
    shadow.appendChild(styleEl);

    state.mirror = { host, shadow, styleEl, pageContainers: [] };
    return state.mirror;
  }

  // Creates/removes page-container divs so there's exactly one per page of
  // the document (rendered or not), each carrying the page-content class
  // (padding/max-width) so it wraps text at the same column width as the
  // real page.
  function ensurePageContainers(mirror, count, className) {
    while (mirror.pageContainers.length < count) {
      const el = document.createElement("div");
      el.dataset.gdtMirrorPage = String(mirror.pageContainers.length);
      el.style.position = "absolute";
      // z-index only takes effect on a positioned element, which is why
      // this couldn't just live on the (deliberately unpositioned, see
      // ensureMirror) host anymore: without it here, this container has no
      // z-index of its own, so paint order within the real scroller's
      // stacking context falls back to DOM order — and the real canvas
      // tiles reliably end up on top, hiding every highlight box inside
      // this container despite `visibility: visible` and correct styling.
      el.style.zIndex = "2147483647";
      mirror.shadow.appendChild(el);
      mirror.pageContainers.push(el);
    }
    while (mirror.pageContainers.length > count) {
      mirror.pageContainers.pop().remove();
    }
    mirror.pageContainers.forEach((el) => {
      el.className = className || "";
    });
    return mirror.pageContainers;
  }

  // Reads the page-box class's own padding (all four sides) + max-width, in
  // pt, from the exported stylesheet — the raw metrics both the horizontal
  // scale and the per-page printable-height budget (see paginateBlocks)
  // are derived from.
  function extractPageBoxMetricsPt(styleText, bodyClassAttr) {
    const classNames = (bodyClassAttr || "").split(/\s+/).filter(Boolean);
    let paddingTop = 0;
    let paddingRight = 0;
    let paddingBottom = 0;
    let paddingLeft = 0;
    let maxWidth = 0;
    for (const cn of classNames) {
      const re = new RegExp("\\." + cn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}");
      const m = styleText.match(re);
      if (!m) continue;
      const decl = m[1];
      const mw = decl.match(/max-width:\s*([\d.]+)pt/);
      if (mw) maxWidth = parseFloat(mw[1]);
      const shorthand = decl.match(/padding:\s*([\d.]+)pt\s+([\d.]+)pt\s+([\d.]+)pt\s+([\d.]+)pt/);
      if (shorthand) {
        paddingTop = parseFloat(shorthand[1]);
        paddingRight = parseFloat(shorthand[2]);
        paddingBottom = parseFloat(shorthand[3]);
        paddingLeft = parseFloat(shorthand[4]);
      }
      const pt_ = decl.match(/padding-top:\s*([\d.]+)pt/);
      if (pt_) paddingTop = parseFloat(pt_[1]);
      const pr = decl.match(/padding-right:\s*([\d.]+)pt/);
      if (pr) paddingRight = parseFloat(pr[1]);
      const pb = decl.match(/padding-bottom:\s*([\d.]+)pt/);
      if (pb) paddingBottom = parseFloat(pb[1]);
      const pl = decl.match(/padding-left:\s*([\d.]+)pt/);
      if (pl) paddingLeft = parseFloat(pl[1]);
    }
    return { paddingTop, paddingRight, paddingBottom, paddingLeft, maxWidth };
  }

  // Derives px-per-pt by comparing the page box's logical width (padding +
  // max-width, in pt) against the real page element's on-screen pixel
  // width. This naturally accounts for the current Docs zoom level without
  // hardcoding an assumed page size — it works out to the standard 4/3
  // px-per-pt at 100% zoom on an unmodified Letter page, but isn't
  // hardcoded to that.
  function computePxPerPt(metricsPt, pageWidthPx) {
    const logicalWidthPt = metricsPt.paddingLeft + metricsPt.paddingRight + metricsPt.maxWidth;
    if (!logicalWidthPt || pageWidthPx <= 0) return 4 / 3; // fallback: standard 96dpi assumption
    return pageWidthPx / logicalWidthPt;
  }

  function scaleStyleTextPtToPx(styleText, pxPerPt) {
    return styleText.replace(/(-?[\d.]+)pt\b/g, (_m, num) => `${(parseFloat(num) * pxPerPt).toFixed(3)}px`);
  }

  function getMainScroller() {
    const candidate = document.querySelector(".kix-appview-editor");
    if (candidate && candidate.scrollHeight > candidate.clientHeight + 5) {
      return candidate;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getScrollAnchorContainer() {
    const main = getMainScroller();
    if (main === document.scrollingElement || main === document.documentElement) {
      return document.body;
    }
    return main;
  }

  // Makes sure the (unpositioned, zero-size) mirror host is a genuine
  // descendant of whichever element actually scrolls the document, so the
  // browser's own scrolling carries every page container — and therefore
  // any highlight box inside one — along for free, with no scroll listener
  // needed. Idempotent; cheap to call every tick.
  function ensureHostAnchored(hostEl) {
    const anchor = getScrollAnchorContainer();
    if (hostEl.parentElement !== anchor) {
      anchor.appendChild(hostEl);
    }
    if (anchor !== document.body) ensurePositioned(anchor);
    return anchor;
  }

  // Positions one page container so its coordinate space lines up exactly
  // with one real, on-screen page box. Since the host itself is
  // unpositioned (see ensureMirror), an absolutely-positioned page
  // container with no positioned ancestor between it and `anchor` resolves
  // its `top`/`left` against `anchor` directly — the same math as if it
  // were `anchor`'s own child, even though it actually lives inside the
  // host's shadow root.
  function positionPageContainer(containerEl, pageRect, anchor) {
    if (anchor === document.body) {
      const scroller = document.scrollingElement || document.documentElement;
      containerEl.style.top = `${pageRect.top + scroller.scrollTop}px`;
      containerEl.style.left = `${pageRect.left + scroller.scrollLeft}px`;
    } else {
      const contRect = anchor.getBoundingClientRect();
      containerEl.style.top = `${pageRect.top - contRect.top + anchor.scrollTop}px`;
      containerEl.style.left = `${pageRect.left - contRect.left + anchor.scrollLeft}px`;
    }
    containerEl.style.width = `${pageRect.width}px`;
  }

  // A font's natural line height (ascent + descent + line gap) as a
  // *ratio* of font-size, measured once per font face.
  //
  // Deliberately probed at a large reference size and divided back down,
  // rather than probed at the real size directly. Chrome quantizes a
  // font's reported metrics to 0.5px at whatever size it's asked about:
  // Arial at 14.667px measures as exactly 17.0px when its true natural
  // height is 14.667 x 1.1499 = 16.867px. That 0.133px error is invisible
  // on its own, but it's an error *per line*, and Docs' line-spacing
  // multiple scales it up (x1.15 -> 0.154px/line) before it accumulates
  // down the page — ~6px by line 40, which is a third of a line of drift
  // by the bottom of a dense page. At the 1000px probe size the same
  // 0.5px quantum is a 0.05% error instead, i.e. gone.
  const naturalLineHeightRatioCache = new Map();
  const NATURAL_LH_PROBE_PX = 1000;
  // Fonts whose natural height Docs disagrees with the browser about, as
  // measured against the rendered page — see calibrateAgainstRealPage.
  const calibratedNaturalRatios = new Map();
  function fontKeyOf(fontFamily, fontWeight, fontStyle) {
    return `${fontFamily}|${fontWeight}|${fontStyle}`;
  }
  // Docs registers every font it embeds under its own "docs-" prefixed
  // family name (e.g. "docs-EB Garamond"), specifically so it never
  // collides with a same-named font already installed on the machine.
  // The export's CSS, being a portable snapshot, names runs with the
  // plain, unprefixed family instead — so probing with that name doesn't
  // necessarily hit Docs' own embedded font at all: whenever a real font
  // of that same plain name happens to also be installed locally (common
  // for popular Google Fonts like EB Garamond), the browser resolves the
  // plain name to *that* font instead, and measures its metrics rather
  // than the embedded one Docs actually laid the page out with. Measured
  // live: "EB Garamond" resolved locally to a natural ratio of 1.15, while
  // "docs-EB Garamond" (Docs' real embedded font) measured 1.305 — a 13.5%
  // gap, just over calibrateAgainstRealPage's own MAX_RATIO_CORRECTION
  // sanity cap, so calibration silently declined to correct it and
  // reported "clean" while every line still drifted ~13% short,
  // compounding visibly within a page's worth of lines. Preferring the
  // "docs-" name whenever Docs has actually registered one sidesteps the
  // collision instead of relying on calibration to catch a gap that can
  // legitimately exceed what calibration is willing to trust.
  function resolveMirrorFontFamily(fontFamily) {
    const bare = (fontFamily || "").replace(/^["']|["']$/g, "");
    if (!bare || bare.toLowerCase().startsWith("docs-")) return fontFamily;
    if (!document.fonts) return fontFamily;
    const prefixed = `docs-${bare}`;
    for (const face of document.fonts) {
      if (face.family.replace(/^["']|["']$/g, "") === prefixed) {
        return `"${prefixed}"`;
      }
    }
    return fontFamily;
  }

  // Same "docs-" preference as resolveMirrorFontFamily, but applied to every
  // font-family declaration in the exported stylesheet itself — not just the
  // isolated measurement probes. This stylesheet is what every mirror
  // paragraph's real text actually renders and *wraps* with, so a plain
  // family name that resolves locally to a different-metric font doesn't
  // just mismeasure line height, it changes glyph advance widths and can
  // shift word-wrap points relative to the real, canvas-rendered page: a
  // line that wraps one word earlier or later in the mirror than on the real
  // page throws off every rect on every subsequent line of that paragraph.
  function rewriteFontFamiliesForMirror(styleText) {
    if (!document.fonts) return styleText;
    const registered = new Set();
    for (const face of document.fonts) {
      registered.add(face.family.replace(/^["']|["']$/g, ""));
    }
    return styleText.replace(/font-family:\s*([^;]+);/g, (m, list) => {
      const rewritten = list
        .split(",")
        .map((name) => {
          const trimmed = name.trim();
          const bare = trimmed.replace(/^["']|["']$/g, "");
          if (!bare || bare.toLowerCase().startsWith("docs-")) return trimmed;
          const prefixed = `docs-${bare}`;
          return registered.has(prefixed) ? `"${prefixed}"` : trimmed;
        })
        .join(", ");
      return `font-family: ${rewritten};`;
    });
  }

  function measureNaturalLineHeightPx(fontFamily, fontSizePx, fontWeight, fontStyle) {
    const key = fontKeyOf(fontFamily, fontWeight, fontStyle);
    const calibrated = calibratedNaturalRatios.get(key);
    if (calibrated !== undefined) return calibrated * fontSizePx;
    let ratio = naturalLineHeightRatioCache.get(key);
    if (ratio === undefined) {
      const probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "nowrap";
      probe.style.lineHeight = "normal";
      probe.style.fontFamily = resolveMirrorFontFamily(fontFamily);
      probe.style.fontSize = `${NATURAL_LH_PROBE_PX}px`;
      probe.style.fontWeight = fontWeight || "normal";
      probe.style.fontStyle = fontStyle || "normal";
      probe.textContent = "Mg";
      document.body.appendChild(probe);
      ratio = probe.getBoundingClientRect().height / NATURAL_LH_PROBE_PX;
      probe.remove();
      naturalLineHeightRatioCache.set(key, ratio);
    }
    return ratio * fontSizePx;
  }

  // The font a block's *text* is actually drawn in, which is not
  // necessarily the font the block element itself computes to. Google's
  // export puts paragraph-level styling on the block's class but run-level
  // styling (including font-size) on `<span>`s inside it, and for headings
  // the two genuinely disagree: in a real doc measured here, an `<h2>`
  // element computed to 21.333px (16pt, the heading style's stock size)
  // while the `<span>` holding its text carried 22.667px (17pt, the size
  // actually applied in the document), and an `<h3>` computed to 18.667px
  // against a run of 17.333px. Line height has to follow the *run*, since
  // that's what Docs lays the line out from — deriving it from the block
  // instead made every heading's line box ~1.8px wrong, in whichever
  // direction that particular heading's style happened to disagree.
  //
  // Where runs disagree with each other (a paragraph mixing sizes), the
  // largest wins: that's the one that sets the line's height.
  //
  // Where runs are the *same* size but disagree on weight or style — a
  // short bold label ("Feasibility (20 points): ") leading into a long
  // regular sentence, extremely common in translated documents — size
  // alone doesn't pick a winner. Break that tie by character count
  // instead of by DOM order: the run holding most of the line's actual
  // text is the one whose metrics the line was really laid out from.
  // Encountered-first would silently prefer the label just because it
  // comes first, even though it might be one word out of a full sentence.
  // Confirmed on a real EB Garamond doc that regular/bold happen to share
  // identical natural-height metrics there, so encountered-first did no
  // damage in that case — but nothing guarantees that of every font, and
  // Google Fonts weights routinely do carry their own hhea/OS2 metrics.
  const FONT_SIZE_TIE_EPSILON_PX = 0.1;
  function dominantRunFont(blockEl) {
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let best = null;
    let bestChars = 0;
    let n;
    while ((n = walker.nextNode())) {
      const chars = n.data ? n.data.trim().length : 0;
      if (!chars) continue;
      const el = n.parentElement;
      if (!el) continue;
      const cs = getComputedStyle(el);
      const fontSizePx = parseFloat(cs.fontSize);
      if (!fontSizePx) continue;
      if (!best || fontSizePx > best.fontSizePx + FONT_SIZE_TIE_EPSILON_PX) {
        best = { fontSizePx, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle };
        bestChars = chars;
      } else if (Math.abs(fontSizePx - best.fontSizePx) <= FONT_SIZE_TIE_EPSILON_PX && chars > bestChars) {
        best = { fontSizePx, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle };
        bestChars = chars;
      }
    }
    if (best) return best;
    // An *empty* paragraph still occupies a full line on screen, at the
    // size of the run it would contain — and the export does carry that
    // run, as an empty `<span>` with the class that names the font. No
    // text means the walk above found nothing, so fall back to the
    // largest font among the block's (textless) descendants.
    for (const el of blockEl.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const fontSizePx = parseFloat(cs.fontSize);
      if (!fontSizePx) continue;
      if (!best || fontSizePx > best.fontSizePx) {
        best = { fontSizePx, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle };
      }
    }
    return best;
  }

  // Google Docs' "line spacing" setting (e.g. 1.15, from the exported
  // `.c0{line-height:1.15;...}`) is a multiple of the font's own natural
  // default line height — but plain CSS unitless `line-height` computes as
  // font-size × ratio instead, which is measurably shorter (for Arial
  // 14.667px: 1.15× that is ~16.87px, but the font's own natural line
  // height is ~17px, and Docs' real spacing is ~1.15× *that*, ~19.5px).
  // The gap is invisible on a short paragraph — a couple of px — but
  // compounds line after line, until deep into a long paragraph the
  // mirror's idea of "this line" sits a full visual line or more above
  // where the real, canvas-rendered line actually is. Confirmed directly:
  // clicking at a mirror-reported coordinate and checking where Google's
  // own cursor actually lands (via a typed marker character) showed
  // exactly this — correct for the first few lines, off by a full line by
  // line ~15. Fix: re-derive the font's natural line height ourselves and
  // reapply Docs' ratio to *that*, instead of trusting the browser's
  // unitless-ratio interpretation.
  //
  // Also zeroes margin-top/margin-bottom unconditionally (NOT
  // margin-left/right — see below). Google's canvas renderer has no
  // concept of a browser's default UA stylesheet — every bit of real
  // *vertical* spacing it produces is expressed in the export as an
  // explicit `padding-top`/`padding-bottom` on the paragraph's own class.
  // Any vertical *margin* a cloned block ends up with here is therefore
  // always a browser default leaking in (this was already implicitly true
  // for `<p>`, which happened to compute to 0 margin in every export seen
  // so far, but `<h1>`–`<h6>` carry much larger UA-default margins that
  // nothing in the export ever overrides — left alone, that reintroduces
  // exactly the kind of vertical drift the line-height fix above exists
  // to eliminate, just via a different property).
  //
  // margin-left/right are deliberately left alone: unlike vertical
  // spacing, Docs *does* use `margin-left` for real, meaningful data — a
  // list item's indentation. A top-level bullet's class carries
  // `margin-left:36pt`; one level deeper, a *different* class on that
  // `<li>` carries `margin-left:72pt`, scaling with nesting depth. An
  // earlier version of this function zeroed margin outright, which
  // silently deleted that indentation along with the unwanted vertical
  // margin — every nested list item collapsed to the page's full text
  // width, since nothing was left to distinguish it from a top-level one.
  function normalizeBlockEl(blockEl) {
    blockEl.style.marginTop = "0";
    blockEl.style.marginBottom = "0";
    // Every block's own "space before/after paragraph"
    // (padding-top/padding-bottom, `<li>` included) is left untouched
    // here — collapseAdjacentBlockSpacing runs once over the whole
    // sequence before this function and has already resolved every
    // adjacent pair down to a single value.
    const cs = getComputedStyle(blockEl);
    const declaredLH = parseFloat(cs.lineHeight);
    const blockFontSizePx = parseFloat(cs.fontSize);
    if (!declaredLH || !blockFontSizePx) return;
    // The multiple itself (Docs' "line spacing", e.g. 1.15) is a property
    // of the paragraph, so it does come from the block — only the font
    // it gets applied to comes from the run (see dominantRunFont).
    const ratio = declaredLH / blockFontSizePx;
    const run = dominantRunFont(blockEl) || {
      fontFamily: cs.fontFamily,
      fontSizePx: blockFontSizePx,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
    };
    const natural = measureNaturalLineHeightPx(run.fontFamily, run.fontSizePx, run.fontWeight, run.fontStyle);
    if (!natural) return;
    const lineHeightPx = natural * ratio;
    blockEl.style.lineHeight = `${lineHeightPx.toFixed(3)}px`;
    // Kept for calibrateAgainstRealPage, which needs to know which font's
    // natural height a given line's spacing came from in order to correct it.
    blockEl.dataset.gdtFontKey = fontKeyOf(run.fontFamily, run.fontWeight, run.fontStyle);
    blockEl.dataset.gdtNatural = String(natural / run.fontSizePx);

    // Match the block's own font-size to the run's as well, so the line's
    // invisible "strut" (the zero-width box CSS puts on every line from
    // the *block's* font) can't be taller than the text actually on that
    // line. Where the two disagreed — an <h3> element computing to
    // 18.667px around a 17.333px run — the taller strut won, and the line
    // box came out ~0.5px taller than the line-height set just above. Per
    // line that's nothing; per *heading* it's a permanent shift of
    // everything below it, and it measured as a step of ~0.75px at every
    // heading, compounding down a document with many sections. With the
    // strut matched, the line box is exactly `lineHeightPx` everywhere.
    blockEl.style.fontSize = `${run.fontSizePx}px`;

    // Docs puts a line's extra leading entirely *below* the text: the
    // glyphs' ascent starts flush with the top of the line box (verified
    // against real caret geometry — the caret for the document's first
    // line sits exactly at the page's content top plus that paragraph's
    // own space-before, with no leading above it). CSS instead splits
    // leading half above and half below, which drops every line's text by
    // half the difference. That offset doesn't accumulate, but it's a
    // constant ~1.3px of "the highlight sits slightly low" on every box.
    //
    // `position: relative` moves the rendered box (and so every rect
    // measured from it) without touching layout, so the flow the
    // paginator measures is unchanged — and it's the same positioning
    // renderHighlightBoxes' own ensurePositioned would apply anyway, with
    // the boxes' offsets computed against this element's shifted rect.
    blockEl.style.position = "relative";
    blockEl.style.top = `${(-(lineHeightPx - natural) / 2).toFixed(3)}px`;

    // Docs uses empty paragraphs as its vertical spacing (rather than
    // "space before/after") in plenty of documents, and the export gives
    // every one of them a hard `height: 11pt` — a stock number, not the
    // paragraph's real height. On screen an empty paragraph occupies one
    // full line of whatever font it carries: a 12pt one is 21.16px tall,
    // not the declared 14.667px. That 6.5px shortfall lands *per spacer*,
    // so in a document that separates every paragraph this way the mirror
    // fell nearly 50px behind by the bottom of the first page. The
    // declared height can't simply be dropped either — an empty block has
    // no line boxes, so CSS would collapse it to nothing — so it's
    // replaced with the line height computed just above.
    if (!(blockEl.textContent || "").trim()) {
      blockEl.style.height = `${lineHeightPx.toFixed(3)}px`;
    }
  }

  // Google's export gives every paragraph/heading/list-item its own
  // independent "space before/after paragraph" as
  // padding-top/padding-bottom, but the real renderer treats adjacent
  // blocks' spacing as *collapsing* — the gap between two consecutive
  // blocks is the larger of the first's space-after and the second's
  // space-before, never their sum. Padding boxes don't collapse like
  // that: stacked back to back, a paragraph's 16px padding-bottom plus
  // the next heading's 18.667px padding-top produced a 34.7px on-screen
  // gap versus Google's real 18.667px one — a ~16px overshoot at that one
  // boundary, repeated at every block transition down the page.
  //
  // The one exception is a run of consecutive `<li>`s: *between* two items
  // of a list Docs applies no paragraph spacing at all, only line height,
  // even though every `<li>` shares a class declaring the usual 16px/16px
  // (measured: a real, on-screen 19.4px item pitch — exactly one line —
  // where the declared padding would predict ~51px). So that one pair
  // collapses to 0, not to max().
  //
  // A list's *outer* boundaries are not special and must NOT be excluded
  // from the max() rule — that was a real bug here. An earlier version
  // hard-zeroed every `<li>`'s padding on both sides and skipped any pair
  // involving one, which correctly killed the between-items spacing but
  // also deleted the space between a heading and the list's first item:
  // measured against the live document, the mirror came up 9.6px short at
  // every heading -> list boundary, which is what put the highlight box a
  // full line above its heading by the time a couple of lists had gone by.
  // Verified against real caret geometry: with the list's first item and
  // last item participating in the ordinary max() collapse, every block
  // boundary in the test document predicts the real on-screen line
  // position to within 0.5px (the measurement floor — Docs rounds caret
  // positions to whole pixels).
  //
  // This has to work in padding, not by handing the spacing to `margin`
  // and letting the browser's native adjoining-margin collapse do it:
  // paginateBlocks measures how much of a page each block consumes via
  // getBoundingClientRect(), which (correctly) excludes margin — moving
  // the spacing there would make the paginator undercount every block's
  // real height and start splitting pages in the wrong place.
  function collapseAdjacentBlockSpacing(blocks) {
    const list = Array.from(blocks);
    const declared = list.map((el) => {
      const cs = getComputedStyle(el);
      return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
    });
    const finalTop = declared.map((d) => d.top);
    const finalBottom = declared.map((d) => d.bottom);
    for (let i = 1; i < list.length; i++) {
      const betweenListItems = list[i - 1].tagName === "LI" && list[i].tagName === "LI";
      const collapsed = betweenListItems ? 0 : Math.max(finalBottom[i - 1], finalTop[i]);
      finalBottom[i - 1] = 0;
      finalTop[i] = collapsed;
    }
    list.forEach((el, i) => {
      el.style.paddingTop = `${finalTop[i]}px`;
      el.style.paddingBottom = `${finalBottom[i]}px`;
    });
  }

  // Splits `leafEl` into two DOM fragments at the line boundary closest
  // to `splitY` (a viewport Y coordinate), without cutting through the
  // middle of a line. Returns `{ firstPart, secondPart }` where
  // `firstPart` is `leafEl` itself (mutated in place to keep only the
  // content before the split — or `null` if literally nothing fits before
  // `splitY`) and `secondPart` is a *new* element sharing `leafEl`'s tag
  // and attributes (so it keeps the same styling/class), containing
  // everything from the split point onward — or `null` if everything fit
  // and there was nothing to move to a second part. The function as a
  // whole returns `null` (not an object) if no text exists to split on at
  // all; the caller falls back to treating the leaf as atomic in that
  // case.
  //
  // The actual cut uses `Range.extractContents()`: setting a range from
  // the split point to the end of `leafEl` and extracting it hands back a
  // DocumentFragment that already has any partially-selected ancestor
  // (e.g. a `<span>` the split point falls inside) correctly re-cloned
  // around just the tail content, preserving that run's own styling on
  // both sides of the cut — reimplementing that ancestor-aware splitting
  // by hand would be most of this function's real complexity, so this
  // leans on the native, spec'd behavior instead.
  //
  // Finding *where* to cut walks every character position via a 1-char
  // Range (the same per-character-rect technique already used elsewhere
  // in this file, e.g. for sentence-boundary splitting) looking for the
  // first one whose line starts at or after `splitY` — i.e. the first
  // character of the first line that doesn't fit — rather than a
  // height-based estimate, so the cut always lands exactly between two
  // rendered lines, never mid-line.
  function splitLeafAtHeight(leafEl, splitY) {
    const walker = document.createTreeWalker(leafEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    if (!textNodes.length) return null;

    // A line belongs on this page only if it fits — but "fits" means its
    // *text* fits, not its whole line box. Docs lets the extra leading
    // below the last line of a page spill into the bottom margin: measured
    // on a real page, the final line sat with its text box ending at
    // 960.2px against a content area ending at 960px, while its full line
    // box would have run to 963px. Testing the line box would have bumped
    // that line to the next page (one line too few); testing only the
    // line's top would keep a line whose text hangs a whole line past the
    // page (one line too many). Both were wrong, in opposite directions,
    // and either one is enough to leave every highlight after the break a
    // line out of place.
    const cs = getComputedStyle(leafEl);
    const lineHeightPx = parseFloat(cs.lineHeight) || 0;
    const naturalRatio = parseFloat(leafEl.dataset.gdtNatural);
    const fontSizePx = parseFloat(cs.fontSize);
    const textBoxPx = naturalRatio > 0 && fontSizePx > 0 ? naturalRatio * fontSizePx : lineHeightPx;
    let splitNode = null;
    let splitOffset = -1;
    outer: for (const node of textNodes) {
      for (let i = 0; i < node.data.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        if (rects[0].top + textBoxPx > splitY + 0.5) {
          splitNode = node;
          splitOffset = i;
          break outer;
        }
      }
    }
    if (!splitNode) return null; // everything fits — caller keeps it whole

    // Widow/orphan control. Docs (by default) never leaves a lone line of a
    // paragraph at the bottom of a page or at the top of the next: it needs
    // at least two lines on each side of a break, and otherwise moves the
    // line(s) over — or the whole paragraph, when it is only two or three
    // lines long. A plain "split wherever the page runs out" put the first
    // line of a two-line bullet at the foot of page 1 while Docs had moved
    // the entire bullet to page 2, so its highlight landed in the blank
    // space below the previous paragraph.
    const MIN_LINES_EACH_SIDE = 2;
    if (lineHeightPx > 0) {
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const leafRect = leafEl.getBoundingClientRect();
      const leafTop = leafRect.top + padTop;
      const totalLines = Math.round((leafRect.height - padTop - padBottom) / lineHeightPx);
      const lineIndexAt = (node, i) => {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        const rs = r.getClientRects();
        return rs.length ? Math.round((rs[0].top - leafTop) / lineHeightPx) : null;
      };
      const firstLine = lineIndexAt(splitNode, splitOffset);
      if (firstLine !== null && totalLines >= 2) {
        let keep = firstLine; // lines that stay on this page
        if (totalLines - keep < MIN_LINES_EACH_SIDE) keep = totalLines - MIN_LINES_EACH_SIDE;
        if (keep < MIN_LINES_EACH_SIDE) {
          return { firstPart: null, secondPart: leafEl };
        }
        if (keep !== firstLine) {
          let found = false;
          outer2: for (const node of textNodes) {
            for (let i = 0; i < node.data.length; i++) {
              const idx = lineIndexAt(node, i);
              if (idx !== null && idx >= keep) {
                splitNode = node;
                splitOffset = i;
                found = true;
                break outer2;
              }
            }
          }
          if (!found) return { firstPart: null, secondPart: leafEl };
        }
      }
    }

    if (splitNode === textNodes[0] && splitOffset === 0) {
      // Not even the first character fits — the whole leaf belongs on
      // the next page, not split at all.
      return { firstPart: null, secondPart: leafEl };
    }

    const range = document.createRange();
    range.selectNodeContents(leafEl);
    range.setStart(splitNode, splitOffset);
    const extracted = range.extractContents(); // mutates leafEl in place, removing this content

    const secondPart = leafEl.cloneNode(false); // shallow: same tag + attributes, no children
    secondPart.appendChild(extracted);
    // cloneNode copies the `style` attribute too, so without this the
    // continuation would re-apply the collapsed "space before paragraph"
    // that collapseAdjacentBlockSpacing put on the block — a gap Docs
    // never draws, because this isn't the start of a paragraph, it's the
    // middle of one that happens to resume on a new page. (Measured on
    // the live document: the first line of page 2 sits exactly at the
    // page's content top, with no space above it at all.) The first
    // part's space-after goes for the same reason — nothing follows it on
    // its page.
    leafEl.style.paddingBottom = "0";
    secondPart.style.paddingTop = "0";

    return { firstPart: leafEl, secondPart };
  }

  // Distributes the document's cloned top-level blocks (currently all
  // sitting in `scratch`, already laid out at the real column width)
  // across `pageContainers`, in order, by accumulating each leaf's own
  // rendered height against each page's printable-height budget.
  // `appendChild` on an already-attached node *moves* it, so this
  // reparents each leaf into its assigned page container without losing
  // any state (its cloned structure, or the sentence spans instrumented
  // onto it later).
  //
  // A `<ul>`/`<ol>` is not itself a pagination leaf — it's decomposed
  // recursively into its `<li>` children (and, one level deeper, any
  // nested `<ul>`/`<ol>` a Google export represents as a *sibling* of the
  // `<li>` it's nested under, not a child of it). Confirmed live: a real
  // multi-page document had its "Requirements" list start on page 1 and
  // continue onto page 2; treating the whole `<ul>` as one atomic block
  // (as an earlier version did, matching how `<table>` is still handled)
  // pushed the *entire list* — including items genuinely on page 1 — onto
  // whichever page had room for all of it, breaking every item in a list
  // long enough to straddle a page boundary, not just the ones actually
  // near it. Splitting a list this way means one `<ul>` may need to
  // become two (or more) cloned wrappers, one per page it has items on —
  // `listCloneCache` tracks, per original list element, which page its
  // current clone belongs to, minting a fresh clone (nested under that
  // same page's clone of the list one level up, if any) whenever a leaf
  // lands on a page the cached clone isn't for yet.
  //
  // `<table>` is deliberately NOT decomposed or split the same way as
  // p/heading/li (still one atomic block): a straddling table would need
  // per-row reflow to keep column widths consistent across the split,
  // which is out of scope here.
  //
  // Everything else that's splittable (any TEXT_BLOCK_TAGS tag — see
  // splitLeafAtHeight below) genuinely IS split into two DOM fragments at
  // the exact line
  // where the real page breaks, when it's long enough to straddle a page
  // boundary — confirmed live: a list item whose real content starts on
  // page 1 and continues onto page 2 (with the exact wording of both
  // halves reported by hand). An earlier version kept every leaf as one
  // atomic, unsplit block, which not only left the straddling leaf itself
  // measurably wrong but corrupted every leaf *after* it too (see
  // placeLeaf's own note on overflow carry-over) — splitting the leaf for
  // real, rather than approximating around it, removes both problems.
  function paginateBlocks(scratch, pageContainers, printableHeightsPx, placementLog) {
    let pageIndex = 0;
    let usedHeight = 0;
    const listCloneCache = new Map(); // original <ul>/<ol> -> { pageIndex, cloneEl }

    function cloneForCurrentPage(origListEl, parentContainer) {
      const cached = listCloneCache.get(origListEl);
      if (cached && cached.pageIndex === pageIndex) return cached.cloneEl;
      const clone = origListEl.cloneNode(false); // shallow: tag + attributes (class etc.), no children
      parentContainer.appendChild(clone);
      listCloneCache.set(origListEl, { pageIndex, cloneEl: clone });
      return clone;
    }

    // Places a leaf on the CURRENT page unconditionally, then, if its
    // height pushes the running total past the page's budget, treats the
    // excess as spilling onto the next page(s) and carries it forward as
    // *their* starting usedHeight, rather than resetting to 0. Used both
    // for leaves that already fit and as the fallback for `<table>`
    // (which is never split) and for a splittable leaf where no clean
    // line boundary could be found to split at.
    //
    // The carry-over (instead of resetting to 0 on the next page) matters
    // even now that splitting exists: it's what keeps a *table*'s own
    // overflow from corrupting whatever comes after it, the same way it
    // used to matter for every splittable leaf before splitting existed.
    function placeWhole(leafEl, listChain) {
      // "Space before paragraph" is suppressed at the top of a page —
      // whatever gap it would have opened has already been absorbed by
      // the page break itself. Verified directly on a real document: an
      // <h3> carrying an 18.667px space-before, pushed to the top of a
      // page with an explicit page break, put its caret at exactly the
      // page's content top (96px in from a 1in margin), not 18.667px
      // below it. Zeroed before the height is measured just below, so the
      // paginator budgets this block at the size it will actually render
      // at on its new page.
      if (pageIndex > 0 && usedHeight === 0) leafEl.style.paddingTop = "0";
      let parentContainer = pageContainers[pageIndex];
      for (const listEl of listChain) {
        parentContainer = cloneForCurrentPage(listEl, parentContainer);
      }
      parentContainer.appendChild(leafEl); // moves the node
      // Measured *after* attaching, not before. The second half of a leaf
      // split across a page boundary arrives here detached — it was built
      // by splitLeafAtHeight and has never been in the document — and a
      // detached element's getBoundingClientRect() is all zeros, so
      // measuring first silently counted every such continuation as
      // taking up no space at all. Everything placed after it on that
      // page then believed the page still had the continuation's height
      // free (observed: the heading right after a page-straddling list
      // item was treated as the page's first block, and had its
      // space-before suppressed by the rule just above). For a leaf
      // that's already attached this is the same number either way — the
      // page containers are all the same width, so moving it doesn't
      // reflow it.
      const h = leafEl.getBoundingClientRect().height;
      usedHeight += h;
      // TEMP DIAGNOSTIC (see debugging session) — see rebuildMirror's
      // gdtMirrorStats note. Safe to delete once the drift is found.
      if (placementLog) {
        placementLog.push({
          tag: leafEl.tagName,
          idx: leafEl.dataset.gdtParaIndex,
          text: (leafEl.textContent || "").slice(0, 30),
          h: Math.round(h * 100) / 100,
          cumulative: Math.round(usedHeight * 100) / 100,
          pageIndex,
        });
      }

      while (pageIndex < pageContainers.length - 1) {
        const budget = printableHeightsPx[pageIndex] || printableHeightsPx[printableHeightsPx.length - 1];
        if (usedHeight <= budget) break;
        usedHeight -= budget;
        pageIndex += 1;
      }
    }

    function placeLeaf(leafEl, listChain) {
      const budget = printableHeightsPx[pageIndex] || printableHeightsPx[printableHeightsPx.length - 1];
      const remaining = budget - usedHeight;
      const h = leafEl.getBoundingClientRect().height;

      if (h > remaining && pageIndex < pageContainers.length - 1 && TEXT_BLOCK_TAGS.has(leafEl.tagName)) {
        const leafTop = leafEl.getBoundingClientRect().top;
        const split = remaining > 0 ? splitLeafAtHeight(leafEl, leafTop + remaining) : { firstPart: null, secondPart: leafEl };
        if (split) {
          // placeWhole(firstPart) can, in a rare rounding edge case (the
          // post-split DOM re-laying-out very slightly taller than the
          // `remaining` budget it was cut to), already advance pageIndex
          // on its own via the carry-over loop above. Taking the max
          // here (instead of an unconditional `+= 1`) guarantees the
          // second part always lands on a genuinely new page without
          // ever double-advancing past it — a double-advance previously
          // walked pageIndex one past the last real page and crashed
          // trying to clone a list wrapper into a nonexistent container.
          const entryPageIndex = pageIndex;
          if (split.firstPart) placeWhole(split.firstPart, listChain);
          pageIndex = Math.max(pageIndex, entryPageIndex + 1);
          usedHeight = 0;
          if (split.secondPart) placeLeaf(split.secondPart, listChain); // may itself need further splitting
          return;
        }
        // splitLeafAtHeight returned null. Its own "everything fits"
        // fast path (see its comment) tests each line by *ink* height,
        // with a small rounding tolerance — deliberately lenient, since
        // Docs really does let a page's very last line's leading spill
        // past the bottom margin. But we only ever get here because `h >
        // remaining` already said this leaf's full box does NOT fit — so
        // a null return doesn't mean "comfortably fits", it means "the
        // shortfall is small enough (at most that leading-plus-rounding
        // slop, never more) that no line boundary crossed the threshold".
        // Confirmed against a real document: a 3-line paragraph over
        // budget by a fraction of a pixel — under that tolerance — took
        // this path and was kept in full on the current page, while
        // Google Docs itself moved the whole paragraph to the next page,
        // leaving that last sliver of the current page blank rather than
        // let it spill. The leading-spill leniency is for a line that's
        // already mid-paragraph on this page (nothing else needs that
        // space); it doesn't extend to deciding whether a paragraph gets
        // to *start* on this page at all. So: treat this exactly like
        // the "not even the first character fits" case above and move
        // the whole, unsplit leaf to the next page — never let it spill
        // on a technicality only the ink-based check would forgive.
        if (remaining > 0) {
          pageIndex += 1;
          usedHeight = 0;
          placeLeaf(leafEl, listChain);
          return;
        }
      }
      placeWhole(leafEl, listChain);
    }

    function walk(node, listChain) {
      for (const child of Array.from(node.children)) {
        if (child.tagName === "UL" || child.tagName === "OL") {
          walk(child, [...listChain, child]);
        } else {
          placeLeaf(child, listChain);
        }
      }
    }

    walk(scratch, []);
  }

  // ---------- calibration against the rendered page ----------
  //
  // Two things about a document's real layout are simply not in the HTML
  // export, and can't be computed from it or from any browser API:
  //
  //   * **Docs' natural line height for some fonts.** A line box is the
  //     font's natural height (ascent + descent + line gap) times the
  //     paragraph's line-spacing multiple. For Arial the browser agrees
  //     with Docs exactly — `line-height: normal` reports 1.1499 em, and
  //     a real 16px Arial caret measures 18.4px. For Roboto it does not:
  //     the browser reports 1.1715 em (the font's `hhea` metrics) while
  //     Docs lays out at 1.2002 em (its OS/2 `usWin` metrics), and a real
  //     16px Roboto caret measures 19.2px. Docs appears to take the larger
  //     of the two metric sets; the browser only ever exposes `hhea`
  //     (`line-height: normal`) or a platform-dependent pick (Canvas
  //     `fontBoundingBox` returned `usWin` for Arial but `hhea` for
  //     Roboto). 0.53px per line doesn't sound like much, but it's per
  //     line — measured across a four-page document it put the last
  //     paragraph three lines out on its own.
  //   * **How far a page header pushes the body down.** The export drops
  //     headers entirely (an empty placeholder `<div>` is all that's left
  //     of one, even when the real header holds a table), so when a header
  //     is tall enough to overflow the top margin there's nothing to say
  //     by how much. Measured on a real document: page 1's first line sat
  //     at 120px from the page top where the unheadered pages started at
  //     96px.
  //
  // Both are recoverable from the page Docs actually drew.
  // `.kix-canvas-tile-content` is same-origin and untainted, so its pixels
  // can be read back: scanning rows for dark ones gives an "ink profile",
  // i.e. exactly where every real line's glyphs are. Comparing that
  // against the mirror's own predicted lines yields the two corrections,
  // which are fed back and the mirror rebuilt (at most twice — the second
  // pass starts from an almost-aligned mirror, so its pairing is
  // near-perfect, and a third would only chase noise).
  //
  // Every correction is bounded and has to be supported by several
  // samples: a mis-calibration would be worse than the few pixels it's
  // there to fix, and on a document that needs no correction at all this
  // has to be a no-op.
  const BLOCK_LINE_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li";
  // `BLOCK_LINE_SELECTOR` alone also matches a table cell's own `<p>` —
  // confirmed live: Google's export wraps every `<td>`'s text in one
  // (`<td><p class="c6"><span>...</span></p></td>`). `extractBlockNodes`
  // already excludes these (`!node.closest("table")`, since a table is a
  // single atomic block — see paginateBlocks), but code that queries
  // `BLOCK_LINE_SELECTOR` directly does not, and a table's cells sit
  // *inside* the same DOM subtree as the real flow blocks, interleaved
  // with them in document order. Feeding those phantom blocks to
  // `collapseAdjacentBlockSpacing`/`normalizeBlockEl` — meant to run over
  // the *vertical reading order* of the page — treats side-by-side cells
  // as vertically adjacent and lets the "next real paragraph after the
  // table" collapse its spacing against a table cell instead of the table
  // itself, corrupting the table's own measured height in the process.
  // Measured live on a document with two tables ahead of a bulleted
  // section: the mirror ran ~200px short of the real canvas by the time
  // it reached that section, which is exactly this — a table rendering
  // shorter in the mirror than for real, silently pulling every paragraph
  // after it up by the shortfall until a click several bullets in landed
  // on a different bullet's mirror box entirely.
  function flowBlocksIn(root) {
    return Array.from(root.querySelectorAll(BLOCK_LINE_SELECTOR)).filter((el) => !el.closest("table"));
  }
  const INK_DARK_MAX = 200;
  const MAX_CALIBRATION_PASSES = 3;
  const MIN_RATIO_SAMPLES = 4; // line gaps, not paragraphs
  // A band top is a glyph position, good to about half a pixel, so even
  // averaged over a page a correction under half a percent is noise.
  const MIN_RATIO_CORRECTION = 0.005;
  const MAX_RATIO_CORRECTION = 0.1; // above this something is wrong, not a metric
  const MIN_ORIGIN_CORRECTION_PX = 4;
  // A page span carries about 0.7px of rounding noise at its two ends, so
  // anything under ~2 sigma of that isn't a real discrepancy.
  const MIN_SPAN_RESIDUAL_PX = 1.5;
  // Below this share of the page, the flagged fonts aren't carrying enough
  // of the span for the residual to say much about them.
  const MIN_FLAGGED_SPAN_SHARE = 0.25;
  const MAX_ORIGIN_CORRECTION_PX = 200;

  // Top edge (in CSS px from the page's top) of each horizontal band of
  // ink on a rendered page. One band is normally one line of text; an
  // underline or a table rule can add a thin extra one, which the caller
  // merges away.
  function readInkBandTops(pageEl) {
    const canvas = pageEl.querySelector("canvas");
    if (!canvas || !canvas.width || !canvas.height) return null;
    const cssHeight = pageEl.getBoundingClientRect().height;
    if (!(cssHeight > 0)) return null;
    let data;
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (err) {
      // A tainted canvas (or a browser that won't read it back) just means
      // no calibration — never an error worth surfacing.
      return null;
    }
    const devicePerCss = canvas.height / cssHeight;
    const tops = [];
    let runStart = -1;
    for (let y = 0; y < canvas.height; y++) {
      let ink = false;
      const row = y * canvas.width * 4;
      // Every second column: a text line always has far more ink than one
      // stray column, and this halves the scan.
      for (let x = 0; x < canvas.width; x += 2) {
        const i = row + x * 4;
        if (data[i + 3] > 10 && data[i] < INK_DARK_MAX) {
          ink = true;
          break;
        }
      }
      if (ink) {
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        tops.push(runStart / devicePerCss);
        runStart = -1;
      }
    }
    if (runStart >= 0) tops.push(runStart / devicePerCss);
    return tops;
  }

  // The mirror's lines for one page, in order, each tagged with the block
  // it belongs to so consecutive-line spacing can be attributed to a font.
  function mirrorLinesForPage(containerEl, pageTopPx) {
    const lines = [];
    for (const blockEl of flowBlocksIn(containerEl)) {
      const range = document.createRange();
      range.selectNodeContents(blockEl);
      const rects = Array.from(range.getClientRects())
        .filter((r) => r.height > 1)
        .map((r) => [r.top - pageTopPx, r.bottom - pageTopPx])
        .sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const r of rects) {
        const last = merged[merged.length - 1];
        // Several rects on one line (one per styling run) overlap
        // vertically; a genuinely new line does not.
        if (last && r[0] < last[1] - 1) {
          last[0] = Math.min(last[0], r[0]);
          last[1] = Math.max(last[1], r[1]);
        } else merged.push([r[0], r[1]]);
      }
      for (const m of merged) lines.push({ top: m[0], blockEl });
    }
    return lines.sort((a, b) => a.top - b.top);
  }

  // How far below a line box's top that line's *ink* starts, for this
  // font and this text — the difference between the font's full ascent
  // and the tallest glyph actually on the line. Needed because the mirror
  // predicts line boxes while the canvas only shows ink.
  let inkProbeCtx = null;
  function inkTopOffsetPx(blockEl, text) {
    if (!inkProbeCtx) inkProbeCtx = document.createElement("canvas").getContext("2d");
    if (!inkProbeCtx) return null;
    const cs = getComputedStyle(blockEl);
    // Font *family* has to come from the run gdtFontKey recorded (see
    // dominantRunFont/normalizeBlockEl), not the block's own computed
    // style: the block itself was never given an explicit font-family (only
    // font-size and line-height are copied onto it), so getComputedStyle
    // reports whatever it inherits — measured on a real block as "Arial"
    // while its own text actually rendered in "EB Garamond". Probing with
    // the wrong family measures the wrong font's ascent metrics, which
    // feeds directly into originShift below.
    const [runFamily, runWeight, runStyle] = (blockEl.dataset.gdtFontKey || "").split("|");
    const fontFamily = resolveMirrorFontFamily(runFamily || cs.fontFamily);
    const fontWeight = runWeight || cs.fontWeight;
    const fontStyle = runStyle || cs.fontStyle;
    inkProbeCtx.font = `${fontStyle} ${fontWeight} ${parseFloat(cs.fontSize)}px ${fontFamily}`;
    const m = inkProbeCtx.measureText(text.slice(0, 200));
    if (!(m.fontBoundingBoxAscent >= 0) || !(m.actualBoundingBoxAscent >= 0)) return null;
    return m.fontBoundingBoxAscent - m.actualBoundingBoxAscent;
  }

  // Pairs the mirror's lines for one page against the real ink bands on
  // that page, one for one, and returns whatever corrections that
  // supports. Returns null when the page can't be read or the two sides
  // clearly don't describe the same content.
  function calibratePage(containerEl, pageEl, contentTopPx) {
    const pageRect = pageEl.getBoundingClientRect();
    const lines = mirrorLinesForPage(containerEl, pageRect.top);
    if (lines.length < 4) return null;
    const rawBands = readInkBandTops(pageEl);
    if (!rawBands || rawBands.length < 4) return null;

    const pitch = Math.min(
      ...lines.slice(1).map((l, i) => l.top - lines[i].top).filter((d) => d > 1)
    );
    if (!(pitch > 1)) return null;

    const bands = [];
    for (const top of rawBands) {
      // Anything starting above the top margin is header furniture, not
      // body text — Docs draws the header inside the margin, and the body
      // can never start above it.
      if (top < contentTopPx - 2) continue;
      // An underline (or a table rule) sits a few px under its own line
      // and reads as a separate band; fold it back into that line.
      if (bands.length && top - bands[bands.length - 1] < pitch * 0.75) continue;
      bands.push(top);
    }
    if (bands.length < 4) return null;

    const pairs = Math.min(lines.length, bands.length);
    const residuals = [];
    for (let i = 0; i < pairs; i++) residuals.push(bands[i] - lines[i].top);
    // Pairing line i with band i is only trustworthy while the two stay
    // in step: a missing or extra band shows up as the residual jumping by
    // about a line, and the very drift being measured here eventually
    // walks them apart on its own. Stop at either.
    let usable = 1;
    while (
      usable < pairs &&
      Math.abs(residuals[usable] - residuals[usable - 1]) < pitch * 0.5 &&
      Math.abs(residuals[usable] - residuals[0]) < pitch * 0.5
    ) {
      usable++;
    }
    if (usable < 4) return null;

    // Per-font line-height correction. Measured across each paragraph as a
    // whole — first line's band to last line's band, divided by the number
    // of gaps — rather than gap by gap. A band's top is where that line's
    // *tallest glyph* starts, which wanders half a pixel or so from line to
    // line depending on whether the line happens to contain a capital or an
    // ascender; per-gap that noise is the same size as the effect being
    // measured (and did, in testing, "correct" Arial by 0.7% when Arial was
    // already exact). Spanning a whole paragraph divides that same endpoint
    // noise by the number of gaps instead.
    const byFont = new Map();
    let runStart = 0;
    for (let i = 1; i <= usable; i++) {
      if (i < usable && lines[i].blockEl === lines[runStart].blockEl) continue;
      const runEnd = i - 1;
      const gaps = runEnd - runStart;
      // Two-line paragraphs carry as much endpoint noise as signal.
      if (gaps >= 2) {
        const blockEl = lines[runStart].blockEl;
        const key = blockEl.dataset.gdtFontKey;
        const natural = parseFloat(blockEl.dataset.gdtNatural);
        const mirrorSpan = lines[runEnd].top - lines[runStart].top;
        const realSpan = bands[runEnd] - bands[runStart];
        if (key && natural > 0 && mirrorSpan > 1 && realSpan > 1) {
          if (!byFont.has(key)) byFont.set(key, { natural, realSpan: 0, mirrorSpan: 0, gaps: 0 });
          const acc = byFont.get(key);
          acc.realSpan += realSpan;
          acc.mirrorSpan += mirrorSpan;
          acc.gaps += gaps;
        }
      }
      runStart = i;
    }

    // Where the body actually starts, which a header can push down.
    let originShift = null;
    const first = lines[0];
    const inkOffset = inkTopOffsetPx(first.blockEl, (first.blockEl.textContent || "").trim());
    if (inkOffset !== null) originShift = bands[0] - (first.top + inkOffset);

    // The same measurement taken across the whole page rather than one
    // paragraph at a time. Docs rounds every line's position to a whole
    // pixel, so each end of a span carries up to half a pixel of rounding:
    // across a five-line paragraph that's most of a percent — the same size
    // as the metric error being hunted — while across a full page of text
    // it's under a tenth of one. The per-paragraph numbers above are still
    // what says *which* font is wrong; this is what says by how much.
    const spanReal = bands[usable - 1] - bands[0];
    const spanMirror = lines[usable - 1].top - lines[0].top;
    return { byFont, originShift, usable, spanReal, spanMirror };
  }

  // Runs calibratePage over whichever pages are rendered right now and
  // folds the results into the module-level correction state. Returns true
  // if anything changed by enough to be worth rebuilding for.
  function calibrateAgainstRealPage(contentTopPx) {
    if (!state.mirror) return "unreadable";
    const layout = getPageLayout();
    if (!layout || !layout.renderedPages) return "unreadable";
    let changed = false;
    let anyReadable = false;

    for (const { el, index } of layout.renderedPages) {
      const containerEl = state.mirror.pageContainers[index];
      if (!containerEl) continue;
      const result = calibratePage(containerEl, el, contentTopPx);
      if (!result) continue;
      anyReadable = true;

      // Which fonts are wrong: a font already carrying a calibration stays
      // in the set, so later passes keep refining the same ones rather than
      // re-deciding from scratch on a mirror that's already nearly right.
      const flagged = [];
      let flaggedSpan = 0;
      for (const [key, { natural, realSpan, mirrorSpan, gaps }] of result.byFont) {
        if (gaps < MIN_RATIO_SAMPLES || !(mirrorSpan > 1)) continue;
        const drift = Math.abs(realSpan / mirrorSpan - 1);
        const already = calibratedNaturalRatios.has(key);
        if (!already && (drift < MIN_RATIO_CORRECTION || drift > MAX_RATIO_CORRECTION)) continue;
        flagged.push({ key, natural });
        flaggedSpan += mirrorSpan;
      }

      // How wrong, from the full-page span — and attributed across the
      // flagged fonts in proportion to how much of the page each one
      // occupies, which works out to the same relative correction for all
      // of them. The attribution is approximate (it ignores the handful of
      // pixels contributed by blank spacer paragraphs), but the whole thing
      // runs again on the rebuilt mirror, so an approximate step still
      // converges.
      const residual = result.spanReal - result.spanMirror;
      if (
        flagged.length &&
        flaggedSpan > result.spanMirror * MIN_FLAGGED_SPAN_SHARE &&
        Math.abs(residual) >= MIN_SPAN_RESIDUAL_PX
      ) {
        const factor = 1 + residual / flaggedSpan;
        if (Math.abs(factor - 1) <= MAX_RATIO_CORRECTION) {
          for (const { key, natural } of flagged) {
            const corrected = natural * factor;
            calibratedNaturalRatios.set(key, corrected);
            log("calibrated natural line height", key, natural.toFixed(4), "->", corrected.toFixed(4));
            changed = true;
          }
        }
      }

      // Page 0 gets its own origin (it's the one a "different first page"
      // header lands on); every later page shares page 1's, since a header
      // that repeats pushes them all down by the same amount and one that
      // doesn't leaves them all alone.
      // `originShift` is the error that's *left* with the current shift
      // already applied, so it accumulates rather than replaces.
      const shift = result.originShift;
      if (shift !== null && index <= 1 && Math.abs(shift) >= MIN_ORIGIN_CORRECTION_PX) {
        const slot = index === 0 ? 0 : 1;
        const total = (state.pageOriginShifts[slot] || 0) + shift;
        // A header can only ever push the body *down*, so a negative total
        // isn't a header — it's this page's mirror content starting a line
        // later than the real page's, which is what a pagination mismatch
        // looks like from here. Refining an existing positive shift
        // downwards is fine; driving one below zero is not.
        if (total >= 0 && total <= MAX_ORIGIN_CORRECTION_PX && total !== state.pageOriginShifts[slot]) {
          state.pageOriginShifts[slot] = total;
          log("calibrated page origin: slot", slot, "->", total.toFixed(2), "px");
          changed = true;
        }
      }
    }
    // Surfaced on the mirror host so what the calibration decided (or why
    // it decided nothing) can be read straight off the page — see
    // "Debugging" in README.md.
    if (state.mirror && state.mirror.host) {
      state.mirror.host.dataset.gdtCalibration = JSON.stringify({
        outcome: changed ? "changed" : anyReadable ? "clean" : "unreadable",
        pass: calibrationPass,
        hidden: document.hidden,
        naturalRatios: Object.fromEntries(calibratedNaturalRatios),
        originShifts: state.pageOriginShifts,
      });
    }
    if (changed) return "changed";
    return anyReadable ? "clean" : "unreadable";
  }

  // Docs paints its pages asynchronously, and the mirror is built the
  // moment the export fetch resolves — which is regularly *before* the
  // first paint, when the canvas reads back as fully transparent. The
  // first attempt at calibration therefore has to be able to come up
  // empty and try again rather than silently giving up, which is what it
  // did in testing: every reload produced an uncalibrated mirror.
  const CALIBRATION_FIRST_DELAY_MS = 800;
  const CALIBRATION_RETRY_MS = 1500;
  const MAX_CALIBRATION_RETRIES = 8;
  let calibrationTimer = null;
  let calibrationRetries = 0;

  function scheduleCalibration(contentTopPx, delayMs) {
    clearTimeout(calibrationTimer);
    calibrationTimer = setTimeout(() => {
      const outcome = calibrateAgainstRealPage(contentTopPx);
      if (outcome === "unreadable") {
        // Chrome throws away a hidden tab's canvas backing store and Docs
        // stops painting into it, so `getImageData` on a backgrounded
        // document reads back fully transparent every single time. There
        // is nothing to calibrate against until someone is actually
        // looking at the page — wait for that rather than burning the
        // retry budget on a page that cannot answer. (This cost a while
        // to spot: the calibration looked broken when it was only ever
        // running against a hidden tab.)
        if (document.hidden) {
          document.addEventListener(
            "visibilitychange",
            () => scheduleCalibration(contentTopPx, CALIBRATION_FIRST_DELAY_MS),
            { once: true }
          );
          return;
        }
        // Visible, but Docs hasn't painted this page yet — that happens on
        // every load, since the mirror is built the moment the export
        // fetch resolves and that regularly beats the first paint.
        if (calibrationRetries < MAX_CALIBRATION_RETRIES) {
          calibrationRetries += 1;
          scheduleCalibration(contentTopPx, CALIBRATION_RETRY_MS);
        }
        return;
      }
      if (outcome === "changed" && calibrationPass < MAX_CALIBRATION_PASSES) {
        calibrationPass += 1;
        rebuildingFromCalibration = true;
        rebuildMirror();
        rebuildingFromCalibration = false;
        if (state.activeHighlight) renderHighlightBoxes();
      }
    }, delayMs);
  }

  // Rebuilds the mirror's content and position from the most recently
  // parsed export (state.lastBodyNode/lastStyleText). Called both after a
  // real text change and on resize (page width/zoom can change without the
  // text changing, which invalidates the previous scale).
  let lastRepositionWidth = null;
  let lastPageCount = null;
  let calibrationPass = 0;
  let rebuildingFromCalibration = false;

  function rebuildMirror() {
    if (!state.lastBodyNode) return;
    const layout = getPageLayout();
    if (!layout) {
      warn("No page anchor element found (tried:", PAGE_SELECTORS.join(", "), ") — highlighting will be unavailable.");
      return;
    }
    const pageRects = layout.rects;
    if (layout.width <= 0) return;

    const { host, styleEl } = ensureMirror();
    const anchor = ensureHostAnchored(host);

    const metricsPt = extractPageBoxMetricsPt(state.lastStyleText, state.lastBodyClassAttr);
    const dp = state.docxPage;
    if (dp) {
      metricsPt.paddingTop = dp.top;
      metricsPt.paddingRight = dp.right;
      metricsPt.paddingBottom = dp.bottom;
      metricsPt.paddingLeft = dp.left;
      metricsPt.maxWidth = dp.width - dp.left - dp.right;
    }
    const pxPerPt = computePxPerPt(metricsPt, layout.width);
    let scaledStyle = rewriteFontFamiliesForMirror(scaleStyleTextPtToPx(state.lastStyleText, pxPerPt));
    if (dp) {
      // Beats the export's own page-box rule, which carries stale margins.
      const sel = (state.lastBodyClassAttr || "").split(/\s+/).filter(Boolean).map((c) => `.${CSS.escape(c)}`).join("");
      if (sel) {
        const px = (v) => `${(v * pxPerPt).toFixed(3)}px`;
        scaledStyle += `\n${sel}{padding:${px(dp.top)} ${px(dp.right)} ${px(dp.bottom)} ${px(dp.left)} !important;max-width:${px(metricsPt.maxWidth)} !important}`;
      }
    }
    styleEl.textContent = scaledStyle;

    // Every page in a Docs document has the same box, so one printable
    // height covers all of them — including the ones not currently
    // rendered, which have no element to measure. A page whose header
    // pushed the body down (calibrateAgainstRealPage) both starts lower
    // and has that much less room on it.
    const contentTopPx = metricsPt.paddingTop * pxPerPt;
    const originShiftFor = (i) => state.pageOriginShifts[i === 0 ? 0 : 1] || 0;
    const printableHeightsPx = pageRects.map(
      (_, i) =>
        layout.height - (metricsPt.paddingTop + metricsPt.paddingBottom) * pxPerPt - originShiftFor(i)
    );

    const containers = ensurePageContainers(state.mirror, layout.count, state.lastBodyClassAttr || "");
    containers.forEach((c, i) => {
      const shift = originShiftFor(i);
      c.style.paddingTop = shift ? `${(contentTopPx + shift).toFixed(2)}px` : "";
    });
    containers.forEach((c) => {
      c.innerHTML = "";
    });

    // Clone everything into page 1's container first (a scratch buffer —
    // it needs *some* attached, correctly-styled container to lay out
    // against before per-child heights can be measured at all), then
    // redistribute by height into their real target containers.
    const scratch = containers[0];
    for (const child of Array.from(state.lastBodyNode.children)) {
      scratch.appendChild(document.importNode(child, true));
    }
    const flowBlocks = flowBlocksIn(scratch);
    collapseAdjacentBlockSpacing(flowBlocks);
    flowBlocks.forEach(normalizeBlockEl);

    // Tag each block with its logical paragraph index *before* pagination
    // gets a chance to split any of them (see paginateBlocks/
    // splitLeafAtHeight) — both resulting fragments of a split leaf need
    // to carry the same tag so they can be re-associated with the same
    // state.paragraphs entry afterward, instead of each looking like its
    // own separate paragraph.
    extractBlockNodes(scratch).forEach((node, i) => {
      node.dataset.gdtParaIndex = String(i);
    });

    const placementLog = [];
    paginateBlocks(scratch, containers, printableHeightsPx, placementLog);
    try {
      host.dataset.gdtPlacementLog = JSON.stringify(placementLog);
    } catch (e) {
      host.dataset.gdtPlacementLog = "ERROR: " + (e && e.message);
    }

    // Re-discover every fragment across all page containers, in page
    // order, grouped by the index tagged above — one paragraph now maps
    // to an *array* of one or more mirror elements, not a single element,
    // precisely because a straddling leaf was split into two.
    const fragmentsByIndex = new Map();
    containers.forEach((c) => {
      extractBlockNodes(c).forEach((node) => {
        const idx = Number(node.dataset.gdtParaIndex);
        if (!fragmentsByIndex.has(idx)) fragmentsByIndex.set(idx, []);
        fragmentsByIndex.get(idx).push(node);
      });
    });

    state.paragraphs.forEach((p) => {
      // Keyed on bodyIndex rather than array position: header and footer
      // paragraphs sit in this same list but have no counterpart in the
      // mirror, and positional matching would slide every body paragraph
      // onto the wrong block the moment a header appeared.
      const fragments = (p.bodyIndex === null ? null : fragmentsByIndex.get(p.bodyIndex)) || [];
      p.mirrorEls = fragments;
      if (p.kind === "p" && fragments.length) {
        instrumentParagraphMirror(fragments, p.sentences.map((s) => s.text));
      }
    });

    // TEMP DIAGNOSTIC (see debugging session): surfaces per-rebuild
    // paragraph/mirror consistency onto the host's dataset, since that's
    // readable from the page's own JS world even though this content
    // script's closures aren't (isolated world). Safe to delete once the
    // click-resolution bug is found.
    try {
      const bodyParas = state.paragraphs.filter((p) => p.place === "body");
      const emptyMirror = bodyParas.filter((p) => !p.mirrorEls || !p.mirrorEls.length).length;
      host.dataset.gdtMirrorStats = JSON.stringify({
        rebuildAt: Date.now(),
        totalBody: bodyParas.length,
        emptyMirror,
        fragmentsByIndexSize: fragmentsByIndex.size,
        sample: bodyParas
          .filter((p) => [2, 56, 57, 58, 60, 61].includes(p.bodyIndex))
          .map((p) => ({
            id: p.id,
            bodyIndex: p.bodyIndex,
            mirrorCount: (p.mirrorEls || []).length,
            taggedIndexOnEl:
              p.mirrorEls && p.mirrorEls[0] ? p.mirrorEls[0].dataset.gdtParaIndex : null,
            text: p.text.slice(0, 30),
          })),
      });
    } catch (e) {
      host.dataset.gdtMirrorStats = "ERROR: " + (e && e.message);
    }

    // TEMP DIAGNOSTIC — checks whether extractBlockNodes(state.lastBodyNode)
    // (the pristine tree, used by buildParagraphsFromBlocks to assign
    // bodyIndex/text) still lines up 1:1 with the body paragraphs currently
    // held in state.paragraphs. If it diverges anywhere, that's the index
    // shift causing the wrong translation to highlight. Safe to delete once
    // the bug is found.
    try {
      const freshBlocks = extractBlockNodes(state.lastBodyNode);
      const freshTexts = freshBlocks.map((n) => textOfBlock(n));
      const bodyParas = state.paragraphs.filter((p) => p.place === "body");
      let firstMismatch = -1;
      for (let i = 0; i < Math.max(freshTexts.length, bodyParas.length); i++) {
        const a = freshTexts[i];
        const b = bodyParas[i] ? bodyParas[i].text : undefined;
        if (a !== b) {
          firstMismatch = i;
          break;
        }
      }
      host.dataset.gdtIndexCheck = JSON.stringify({
        freshCount: freshTexts.length,
        bodyParaCount: bodyParas.length,
        firstMismatch,
        around:
          firstMismatch >= 0
            ? {
                freshBefore: freshTexts.slice(Math.max(0, firstMismatch - 2), firstMismatch + 3),
                paraBefore: bodyParas
                  .slice(Math.max(0, firstMismatch - 2), firstMismatch + 3)
                  .map((p) => ({ id: p.id, bodyIndex: p.bodyIndex, text: p.text })),
              }
            : null,
      });
    } catch (e) {
      host.dataset.gdtIndexCheck = "ERROR: " + (e && e.message);
    }

    containers.forEach((c, i) => positionPageContainer(c, pageRects[i], anchor));
    lastRepositionWidth = Math.round(layout.width);
    lastPageCount = layout.count;

    // Now that the mirror exists, check it against the page Docs actually
    // drew and, if that turns up a correction the export couldn't have
    // told us about, apply it and build once more.
    if (!rebuildingFromCalibration) {
      calibrationPass = 0;
      calibrationRetries = 0;
    }
    if (calibrationPass < MAX_CALIBRATION_PASSES) {
      scheduleCalibration(contentTopPx, CALIBRATION_FIRST_DELAY_MS);
    }
  }

  // A webfont Docs embeds can still be mid-download the moment the mirror
  // is first built and measured — Docs calls `document.fonts.add()`
  // synchronously when it registers a face, so `document.fonts` already
  // contains it (which is all resolveMirrorFontFamily/
  // rewriteFontFamiliesForMirror check for), but the face's own `status`
  // can still be "unloaded"/"loading" at that instant. Both the metrics
  // probe in measureNaturalLineHeightPx and the mirror's real text then
  // render with whatever fallback font the browser substitutes meanwhile —
  // silently, since membership in `document.fonts` isn't the same as being
  // ready to paint. Worse, that wrong probe result is cached forever (see
  // naturalLineHeightRatioCache) and nothing ever re-measures it:
  // rebuildMirror() only re-runs when the document's *text* changes (see
  // refreshFromDoc), so a document whose text never changes after this race
  // is stuck with one permanently-wrong measurement for that font, for the
  // rest of the session. A whole different font's metrics is usually a big
  // enough gap to exceed calibrateAgainstRealPage's own
  // MAX_RATIO_CORRECTION sanity cap too — the same reason the plain-vs-
  // "docs-" name collision went uncorrected before resolveMirrorFontFamily
  // existed — so calibration silently declines to fix it as well. Far more
  // likely on a document's CJK font than its Latin ones: Docs subsets CJK
  // embeds to the characters actually used and they're larger downloads,
  // so they're more likely to still be loading when a short document's
  // first (and, absent this, only) mirror build happens.
  //
  // `loadingdone` fires every time a batch of requested fonts finishes
  // downloading, for the life of the page — not just once at startup — so
  // this also covers a font Docs registers later. Debounced because Docs
  // can add several faces in quick succession, each firing its own event.
  function invalidateFontMetricsAndRebuild() {
    if (!naturalLineHeightRatioCache.size && !calibratedNaturalRatios.size) return;
    naturalLineHeightRatioCache.clear();
    calibratedNaturalRatios.clear();
    if (!state.lastBodyNode) return;
    calibrationPass = 0;
    calibrationRetries = 0;
    rebuildMirror();
    if (state.activeHighlight) renderHighlightBoxes();
  }

  // Cheap, frequent counterpart to rebuildMirror(): re-measures the real
  // page boxes and, if their positions drifted, nudges the (already-built)
  // mirror to match — without re-cloning/re-instrumenting/re-paginating
  // any content.
  //
  // This exists because position drift isn't only caused by a window
  // resize or a text edit (the only two things that trigger rebuildMirror
  // elsewhere). Google Docs' own UI regularly shifts the page's on-screen
  // top/left by a few pixels for reasons that are neither — a "Saving…"
  // indicator appearing, a collaborator's comment thread opening, the
  // spelling-suggestion banner, etc. Observed in practice: querying a
  // sentence's rect, waiting a few seconds with no edits, then querying
  // again showed every rect shifted by 8-17px — enough for a click aimed
  // at one sentence to land on its neighbor instead. A window resize
  // legitimately changes the page's *width* too (invalidating the
  // px-per-pt scale, hence the full rebuild there); this only chases a
  // *position* offset, which is safe to correct far more often.
  function repositionMirrorTick() {
    if (!state.mirror || !state.lastBodyNode) return;
    const layout = getPageLayout();
    if (!layout || layout.width <= 0) return;
    const pageRects = layout.rects;

    if (
      (lastRepositionWidth !== null && Math.round(layout.width) !== lastRepositionWidth) ||
      // The document's real page *count* — not how many page elements
      // happen to be rendered, which changes every time the tile pool
      // rotates during an ordinary scroll and must never trigger a rebuild.
      (lastPageCount !== null && layout.count !== lastPageCount) ||
      layout.count !== state.mirror.pageContainers.length
    ) {
      // Width changed without a `resize` event (e.g. Docs' own zoom
      // control, not the window), or the document gained/lost a page —
      // either invalidates the current layout, so this needs the full
      // rebuild, not just a nudge.
      rebuildMirror();
      if (state.activeHighlight) renderHighlightBoxes();
    } else {
      const anchor = ensureHostAnchored(state.mirror.host);
      state.mirror.pageContainers.forEach((c, i) => positionPageContainer(c, pageRects[i], anchor));
    }
    lastRepositionWidth = Math.round(layout.width);
    lastPageCount = layout.count;
  }

  // Splits/wraps a paragraph's text nodes so that every sentence's
  // characters are wrapped in `<span data-gdt-sent="i">`, without disturbing
  // whatever original per-run styling spans (font/bold/etc.) already
  // surround them. A sentence that straddles a run boundary ends up wrapped
  // as two (or more) such spans, one per original run it touches — measured
  // later as the union of their rects, which correctly reports a
  // multi-styled or multi-line sentence's full extent.
  //
  // `fragments` is an array, not a single element, because a paragraph
  // long enough to straddle a page break is itself split (see
  // paginateBlocks/splitLeafAtHeight) into two separate DOM subtrees, one
  // per page — but it's still conceptually one continuous run of text for
  // sentence-matching purposes. Text nodes are collected across every
  // fragment, in order, into one flat sequence before doing anything else,
  // so a sentence that itself happens to straddle the split point is
  // still found and measured correctly (as the union of spans living in
  // two different fragments) — `Text.splitText()` and `replaceWith()`
  // both operate on a node's own current parent regardless of which
  // fragment's subtree that parent lives in, so nothing below needs to
  // know or care which fragment any given text node came from.
  function instrumentParagraphMirror(fragments, sentenceTexts) {
    if (!sentenceTexts.length) return;
    const textNodes = [];
    for (const frag of fragments) {
      const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) textNodes.push(n);
    }
    if (!textNodes.length) return;

    const fullText = textNodes.map((t) => t.data).join("");
    let cursor = 0;
    const ranges = [];
    for (const s of sentenceTexts) {
      const idx = fullText.indexOf(s, cursor);
      if (idx === -1) {
        warn("Sentence text not found in mirror paragraph text — skipping precise measurement for this paragraph.", { s });
        return;
      }
      ranges.push([idx, idx + s.length]);
      cursor = idx + s.length;
    }

    // Sentence text (as split for translation) doesn't include the
    // whitespace between sentences, so back-to-back ranges built directly
    // from indexOf leave that gap claimed by neither sentence — a click
    // landing in it (e.g. right at the start of the next sentence's first
    // word, where the mirror's own measurement can be a pixel or two off
    // from the real page) falls through to getSentenceClientRects' nearest-
    // rect fallback with no rect of its own to prefer, and can resolve to
    // the wrong sentence. Extending each range to start where the previous
    // one ended (and the last to run to the end of the text) closes every
    // gap, so every character position — including inter-sentence spaces —
    // is unambiguously claimed by exactly one sentence.
    // The gap goes to the sentence *before* it: a caret just before the
    // space is still at the end of that sentence, and only a caret after
    // the space (immediately before the next sentence's first letter) is in
    // the next one.
    for (let i = 0; i + 1 < ranges.length; i++) {
      ranges[i][1] = ranges[i + 1][0];
    }
    if (ranges.length) {
      ranges[0][0] = 0;
      ranges[ranges.length - 1][1] = fullText.length;
    }

    // Split each text node at every sentence boundary that falls strictly
    // inside it, producing a flat, ordered list of (possibly-split) pieces.
    let offset = 0;
    const pieces = [];
    for (const node of textNodes) {
      const localStart = offset;
      const text = node.data;
      const boundaries = new Set();
      for (const [s, e] of ranges) {
        if (s > localStart && s < localStart + text.length) boundaries.add(s - localStart);
        if (e > localStart && e < localStart + text.length) boundaries.add(e - localStart);
      }
      const sorted = Array.from(boundaries).sort((a, b) => a - b);
      let cur = node;
      let consumed = 0;
      let pieceStart = localStart;
      for (const b of sorted) {
        const splitAt = b - consumed;
        const rest = cur.splitText(splitAt);
        pieces.push({ node: cur, start: pieceStart, end: localStart + b });
        pieceStart = localStart + b;
        consumed = b;
        cur = rest;
      }
      pieces.push({ node: cur, start: pieceStart, end: localStart + text.length });
      offset += text.length;
    }

    for (const piece of pieces) {
      const sentIdx = ranges.findIndex(([s, e]) => piece.start >= s && piece.start < e);
      if (sentIdx === -1) continue; // inter-sentence whitespace — leave unwrapped
      const span = document.createElement("span");
      span.dataset.gdtSent = String(sentIdx);
      piece.node.replaceWith(span);
      span.appendChild(piece.node);
    }
  }

  function getSentenceClientRects(paragraph) {
    if (!paragraph.mirrorEls || !paragraph.mirrorEls.length) return paragraph.sentences.map(() => []);
    if (paragraph.kind === "row") {
      // Table rows are never split across fragments (see paginateBlocks),
      // so there's always exactly one element here.
      const rect = paragraph.mirrorEls[0].getBoundingClientRect();
      const asRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      return paragraph.sentences.map(() => [asRect]);
    }
    const bySent = new Map();
    for (const mirrorEl of paragraph.mirrorEls) {
      mirrorEl.querySelectorAll("[data-gdt-sent]").forEach((el) => {
        const idx = Number(el.dataset.gdtSent);
        const rects = Array.from(el.getClientRects()).map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
        if (!bySent.has(idx)) bySent.set(idx, []);
        bySent.get(idx).push(...rects);
      });
    }
    return paragraph.sentences.map((_, i) => bySent.get(i) || []);
  }

  // ---------- translation ----------

  function collectUntranslatedSentences() {
    const items = [];
    for (const p of state.paragraphs) {
      for (const s of p.sentences) {
        if (s.translated === null) {
          items.push({ id: `${p.id}::${s.id}`, text: s.text });
        }
      }
    }
    return items;
  }

  function findSentenceByCompositeId(compositeId) {
    const [pId, sId] = compositeId.split("::");
    const p = state.paragraphs.find((x) => x.id === pId);
    if (!p) return null;
    const s = p.sentences.find((x) => x.id === sId);
    return s ? { paragraph: p, sentence: s } : null;
  }

  async function requestTranslations(items) {
    if (!items.length) return;
    const CHUNK = 60;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: "GDT_TRANSLATE_BATCH",
          items: chunk,
          targetLang: state.targetLang,
        });
      } catch (err) {
        warn("translation request failed", err);
        continue;
      }
      if (!response || !response.ok) {
        warn("translation batch error", response && response.error);
        continue;
      }
      for (const [compositeId, result] of Object.entries(response.results)) {
        const found = findSentenceByCompositeId(compositeId);
        if (!found) continue;
        if (result.error) {
          found.sentence.error = result.error;
        } else {
          found.sentence.translated = result.text;
          found.sentence.error = null;
        }
        updatePanelSentenceText(found.paragraph, found.sentence);
      }
    }
  }

  // ---------- side panel bridge ----------
  //
  // The translation list lives in the browser's own side panel
  // (sidepanel/sidepanel.js), not on the page: a native side panel narrows
  // the page's real viewport, so Docs re-lays itself out around it the same
  // way it does for its own Gemini panel — something no amount of
  // restyling from inside the page could get Docs' canvas to do.
  //
  // This script stays the source of truth (it alone can see the document,
  // the mirror and the highlight boxes) and pushes what the panel needs
  // over a long-lived port the panel opens to this tab. The port also tells
  // us whether a panel is open at all, so a closed panel costs no export
  // fetches or translation requests.

  function postToPanel(msg) {
    if (!state.sidePanelPort) return;
    try {
      state.sidePanelPort.postMessage(msg);
    } catch (err) {
      state.sidePanelPort = null;
    }
  }

  function snapshotForPanel() {
    return {
      type: "snapshot",
      enabled: state.enabled,
      stale: state.stale,
      paragraphs: state.paragraphs.map((p) => ({
        id: p.id,
        place: p.place,
        // Sum across fragments (a straddling paragraph has more than one) —
        // purely cosmetic, keeps an entry roughly as tall as its original.
        minHeight: (p.mirrorEls || []).reduce((sum, el) => sum + el.getBoundingClientRect().height, 0),
        sentences: p.sentences.map((s) => ({ id: s.id, text: s.text, translated: s.translated, error: s.error })),
      })),
    };
  }

  function renderPanelFull() {
    postToPanel(snapshotForPanel());
  }

  function updatePanelSentenceText(paragraph, sentence) {
    postToPanel({
      type: "sentence",
      pId: paragraph.id,
      sentence: { id: sentence.id, text: sentence.text, translated: sentence.translated, error: sentence.error },
    });
  }

  // Surfaces the "stale mirror/translations" state described in the note
  // above fetchExportHtml: rather than silently keep serving positions and
  // text computed from whatever export last succeeded, tell the user when
  // that stops being current, so a highlight that looks wrong is
  // recognizable as "known stale" rather than "the tool is broken."
  function setStale(stale) {
    if (state.stale === stale) return;
    state.stale = stale;
    postToPanel({ type: "stale", stale });
  }

  function onPanelConnect(port) {
    if (port.name !== "gdt-panel") return;
    if (state.sidePanelPort) {
      try {
        state.sidePanelPort.disconnect();
      } catch (err) {
        // already gone
      }
    }
    state.sidePanelPort = port;
    port.onMessage.addListener((msg) => handlePanelMessage(msg));
    port.onDisconnect.addListener(() => {
      if (state.sidePanelPort !== port) return;
      state.sidePanelPort = null;
      clearOriginalHighlight();
      placeFloatingButton();
    });
    placeFloatingButton();
    renderPanelFull();
    // Nothing has been fetched while the panel was closed, so catch up now.
    void refreshFromDoc();
  }

  function handlePanelMessage(msg) {
    if (!msg) return;
    if (msg.type === "click") {
      const paragraph = state.paragraphs.find((p) => p.id === msg.pId);
      if (!paragraph) return;
      const sIdx = paragraph.sentences.findIndex((s) => s.id === msg.sId);
      if (sIdx < 0) return;
      highlightOriginal(paragraph, sIdx);
    } else if (msg.type === "panelScroll") {
      if (typeof scrollDocToParagraph === "function") scrollDocToParagraph(msg.pId, msg.fraction);
    }
  }

  // ---------- highlighting ----------
  //
  // Boxes are inserted as real children of the mirror node for the active
  // paragraph/sentence, with `visibility: visible` set explicitly to
  // override the inherited `hidden` from the mirror's otherwise-invisible
  // ancestry — a normal, spec'd CSS behavior. Since that mirror node is
  // already correctly positioned and already scrolls natively with the
  // real page (see positionPageContainer), the highlight box does too, for
  // free — the same reasoning the old per-paragraph-anchored design used,
  // just one level removed (anchored to the mirror instead of a real node).

  function removeActiveHighlightBoxes() {
    for (const box of state.activeHighlightBoxes) {
      box.remove();
    }
    state.activeHighlightBoxes = [];
  }

  function renderHighlightBoxes() {
    removeActiveHighlightBoxes();
    const active = state.activeHighlight;
    if (!active) return;
    const { paragraph, sentenceIndex } = active;
    if (!paragraph.mirrorEls || !paragraph.mirrorEls.length) return;

    if (paragraph.kind === "row") {
      // Table rows are never split (see paginateBlocks) — always exactly
      // one element.
      const mirrorEl = paragraph.mirrorEls[0];
      const box = document.createElement("div");
      box.className = "gdt-original-highlight-box";
      box.style.visibility = "visible";
      box.style.left = "0";
      box.style.top = "0";
      box.style.width = "100%";
      box.style.height = "100%";
      ensurePositioned(mirrorEl);
      mirrorEl.appendChild(box);
      state.activeHighlightBoxes.push(box);
      return;
    }

    // A straddling paragraph has more than one mirror element (one per
    // page it was split across — see paginateBlocks/splitLeafAtHeight),
    // and a sentence that itself straddles the split has spans living in
    // more than one of them. Each box is appended as a child of whichever
    // fragment its own span actually lives in — not always
    // `mirrorEls[0]` — both so its position is computed relative to the
    // right anchor, and so it scrolls natively with the page that
    // fragment is actually on.
    let anyRects = false;
    for (const mirrorEl of paragraph.mirrorEls) {
      const spans = mirrorEl.querySelectorAll(`[data-gdt-sent="${sentenceIndex}"]`);
      if (!spans.length) continue;
      ensurePositioned(mirrorEl);
      const anchorRect = mirrorEl.getBoundingClientRect();
      spans.forEach((span) => {
        Array.from(span.getClientRects()).forEach((r) => {
          anyRects = true;
          const box = document.createElement("div");
          box.className = "gdt-original-highlight-box";
          box.style.visibility = "visible";
          box.style.left = `${r.left - anchorRect.left}px`;
          box.style.top = `${r.top - anchorRect.top}px`;
          box.style.width = `${r.width}px`;
          box.style.height = `${r.height}px`;
          mirrorEl.appendChild(box);
          state.activeHighlightBoxes.push(box);
        });
      });
    }
    if (!anyRects) {
      warn("No measurable rects for sentence highlight.", { paragraphId: paragraph.id, sentenceIndex });
    }
  }

  function highlightOriginal(paragraph, sentenceIndex) {
    state.activeHighlight = { paragraph, sentenceIndex };
    renderHighlightBoxes();
    if (paragraph.mirrorEls && paragraph.mirrorEls.length) {
      // Scroll to whichever fragment actually holds this sentence, not
      // always the first one — relevant once a paragraph has been split
      // across a page boundary.
      let target = paragraph.mirrorEls[0];
      for (const mirrorEl of paragraph.mirrorEls) {
        if (mirrorEl.querySelector(`[data-gdt-sent="${sentenceIndex}"]`)) {
          target = mirrorEl;
          break;
        }
      }
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      warn("highlightOriginal: paragraph has no mirror element to scroll to.", { paragraphId: paragraph.id });
    }
  }

  function clearOriginalHighlight() {
    state.activeHighlight = null;
    removeActiveHighlightBoxes();
  }

  function clearTranslatedHighlight() {
    postToPanel({ type: "active", pId: null });
  }

  function highlightTranslatedSentence(paragraph, sentence, { scroll = true } = {}) {
    postToPanel({ type: "active", pId: paragraph.id, sId: sentence.id, scroll });
  }

  // ---------- click handling ----------
  //
  // There's no real, clickable per-paragraph element in the actual page
  // anymore (only canvas) — and the mirror is deliberately
  // `pointer-events: none` so it never blocks real interaction with the
  // document underneath it. So instead of hit-testing via
  // `elementsFromPoint`, a click's coordinates are compared directly
  // against each paragraph's mirror-measured rect.

  function findParagraphForClick(clientX, clientY) {
    let best = null;
    let bestDist = Infinity;
    for (const p of state.paragraphs) {
      // Check every fragment (a straddling paragraph has more than one —
      // see paginateBlocks/splitLeafAtHeight) since a click near a page
      // boundary might be closest to either half.
      for (const mirrorEl of p.mirrorEls || []) {
        const r = mirrorEl.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) continue;
        // Half-open on the bottom/right edge: two vertically (or
        // horizontally) stacked rects that share a boundary — e.g.
        // consecutive lines of mirrored text — otherwise both claim that
        // exact boundary pixel as "inside", and whichever paragraph is
        // checked first (array order) always wins the tie regardless of
        // which line the click actually landed on. Confirmed live: a click
        // exactly on the pixel where one line ends and the next begins
        // resolved to the wrong (earlier-checked) paragraph every time.
        const inside = clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom;
        if (inside) return { paragraph: p, dist: 0 };
        const vGap = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
        const hGap = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
        const dist = vGap * 1000 + hGap;
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
    }
    if (!best) return null;
    return { paragraph: best, dist: bestDist };
  }

  function findSentenceIndexForClick(paragraph, clientX, clientY) {
    if (!paragraph.sentences.length) return -1;
    if (paragraph.sentences.length === 1 || paragraph.kind === "row") return 0;

    // Among every rect the click's x falls inside, pick the one whose
    // *vertical center* is closest to the click, rather than the first rect
    // whose top/bottom edges happen to contain it. The mirror's own line
    // edges can be off from the real page's by a pixel or two (font-metric
    // rounding the calibration pass didn't flag as worth correcting), and a
    // click near where two lines meet can fall just inside the wrong
    // neighbor's edge-based box even after the boundary is made half-open —
    // its center is far more stable, since both lines' small edge errors
    // point the same direction and mostly cancel out there. Confirmed live:
    // a click square in the middle of "tracks" (end of one sentence)
    // resolved to the next sentence because the mirror's line boundary sat
    // ~1px above where that word actually renders.
    const rectsBySentence = getSentenceClientRects(paragraph);
    let bestInsideIdx = -1;
    let bestInsideDist = Infinity;
    for (let i = 0; i < rectsBySentence.length; i++) {
      for (const r of rectsBySentence[i]) {
        if (clientX < r.left || clientX >= r.left + r.width) continue;
        const centerY = r.top + r.height / 2;
        const dist = Math.abs(clientY - centerY);
        if (dist < bestInsideDist) {
          bestInsideDist = dist;
          bestInsideIdx = i;
        }
      }
    }
    if (bestInsideIdx !== -1) return bestInsideIdx;

    let best = -1;
    let bestDist = Infinity;
    rectsBySentence.forEach((rects, i) => {
      for (const r of rects) {
        // Vertical distance to the line's center, not its edges: two lines
        // sharing a boundary both have a 0 edge gap there, and the tie was
        // going to whichever sentence came first.
        const vDist = Math.abs(clientY - (r.top + r.height / 2));
        const hGap = clientX < r.left ? r.left - clientX : clientX > r.left + r.width ? clientX - (r.left + r.width) : 0;
        const dist = vDist * 1000 + hGap;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
    });
    return best;
  }

  // After a click, Docs snaps its own caret (`.kix-cursor-caret`, a real
  // DOM element with real on-screen geometry) to the nearest character
  // boundary. That boundary — not the raw click pixel — is what the reader
  // means by "this sentence": a click in the empty space right of a line's
  // last word puts the caret at the end of that line, and a click on the
  // gap between two sentences puts it on one side of it, while the raw
  // coordinates are in neither place. So resolve the sentence from the
  // character just after the caret, falling back to the click itself when
  // there is no caret near it (clicks that don't place one).
  const CARET_SETTLE_MS = 60;
  const CARET_MAX_DRIFT_PX = 30;
  function caretProbePoint(clickX, clickY) {
    let best = null;
    for (const el of document.querySelectorAll(".kix-cursor-caret")) {
      const r = el.getBoundingClientRect();
      if (!(r.height > 0)) continue;
      const centerY = r.top + r.height / 2;
      const d = Math.abs(centerY - clickY);
      if (d > CARET_MAX_DRIFT_PX) continue;
      if (!best || d < best.d) best = { d, x: r.left + 2, y: centerY };
    }
    return best;
  }

  function onOriginalClick(event) {
    if (!state.enabled) return;
    if (event.target.closest("#gdt-floating-toggle")) return;
    const clickX = event.clientX;
    const clickY = event.clientY;
    setTimeout(() => {
      const probe = caretProbePoint(clickX, clickY);
      handleOriginalClickAt(probe ? probe.x : clickX, probe ? probe.y : clickY);
    }, CARET_SETTLE_MS);
  }

  function handleOriginalClickAt(clientX, clientY) {

    const found = findParagraphForClick(clientX, clientY);
    // TEMP DIAGNOSTIC — see rebuildMirror's gdtMirrorStats note.
    try {
      if (state.mirror && state.mirror.host) {
        state.mirror.host.dataset.gdtLastClick = JSON.stringify({
          at: Date.now(),
          clientX: clientX,
          clientY: clientY,
          foundId: found ? found.paragraph.id : null,
          foundBodyIndex: found ? found.paragraph.bodyIndex : null,
          dist: found ? found.dist : null,
          foundMirrorElTaggedIndex:
            found && found.paragraph.mirrorEls && found.paragraph.mirrorEls[0]
              ? found.paragraph.mirrorEls[0].dataset.gdtParaIndex
              : null,
        });
      }
    } catch (e) {
      // ignore
    }
    if (!found || found.dist > CLICK_HIT_TEST_SLOP_PX) return;
    const { paragraph } = found;
    if (!paragraph.sentences.length) return;

    const sIdx = findSentenceIndexForClick(paragraph, clientX, clientY);
    if (sIdx < 0) return;
    const sentence = paragraph.sentences[sIdx];

    highlightOriginal(paragraph, sIdx);
    highlightTranslatedSentence(paragraph, sentence);
  }

  // ---------- refresh (poll-based — canvas repaints aren't DOM mutations) ----------

  async function refreshFromDoc() {
    if (!state.docId) return;
    // No open side panel (or translation switched off) means nobody to show
    // anything to, and every export request counts against the rate limit.
    if (!state.sidePanelPort || !state.enabled) return;
    // Nobody is looking at this browser tab, so there's nothing to keep
    // current — and every export request counts against the rate limit.
    if (document.hidden) return;

    let html;
    try {
      html = await fetchExportHtml(state.docId);
    } catch (err) {
      if (!err.skip) {
        warn("failed to fetch export html", err.message || err);
        setStale(true);
      }
      return;
    }
    setStale(false);

    const { styleText, bodyNode } = parseExportedDocument(html);
    const blocks = extractBlockNodes(bodyNode);
    const texts = blocks.map(textOfBlock);
    // Layout counts as a change too: the mirror's geometry comes from the
    // export's stylesheet and page-box class (margins, page size, spacing),
    // so a margin edit with identical text must still rebuild the mirror.
    const signature = [bodyNode.getAttribute("class") || "", styleText, texts.join("\u0001")].join("\u0002");

    if (signature === state.lastSignature) {
      // Margins only live in the docx, so look there even when the body is
      // unchanged (self-throttled; see HEADER_FETCH_MIN_INTERVAL_MS).
      void refreshHeaderFooter();
      return;
    }

    const previousBody = state.paragraphs.filter((p) => p.place === "body");
    const bodyParagraphs = buildParagraphsFromBlocks(blocks);
    for (let i = 0; i < bodyParagraphs.length; i++) {
      const prevP = previousBody[i];
      if (prevP && prevP.text === bodyParagraphs[i].text) {
        bodyParagraphs[i].sentences = prevP.sentences;
      }
    }

    state.paragraphs = composeParagraphs(bodyParagraphs);
    state.lastSignature = signature;
    state.lastTabId = getTabId();
    state.lastBodyNode = bodyNode;
    state.lastStyleText = styleText;
    state.lastBodyClassAttr = bodyNode.getAttribute("class") || "";

    clearOriginalHighlight();
    rebuildMirror();
    renderPanelFull();
    await requestTranslations(collectUntranslatedSentences());
    // Deliberately not awaited: the header is a separate, much bigger
    // download, and the body shouldn't wait on it to appear.
    void refreshHeaderFooter();
  }

  // The user switched to a different document tab: drop everything built from
  // the previous tab (so none of its text or translations carry over by
  // position) and fetch the new one immediately, past the usual throttles.
  function onTabChanged() {
    clearOriginalHighlight();
    state.paragraphs = [];
    state.lastSignature = null;
    state.headerFooter = null;
    state.headerFooterSignature = null;
    state.docxPage = null;
    lastHeaderFetchAt = 0; // margins can differ per tab; fetch them for this one
    // Throttle/backoff are left alone on purpose: a switch must not be a
    // way around an active rate limit.
    renderPanelFull();
    void refreshFromDoc();
  }

  // Pulls the header/footer text (see fetchHeaderFooterTexts) and, if it
  // changed, folds it into the paragraph list and translates it.
  async function refreshHeaderFooter() {
    if (!state.docId || !state.enabled) return;
    let texts;
    try {
      texts = await fetchHeaderFooterTexts(state.docId);
    } catch (err) {
      // A document with no header, a rate limit, an export format that
      // isn't a zip — none of it is worth interrupting the body over.
      warn("header/footer text unavailable", err.message || err);
      return;
    }
    if (!texts) return; // throttled or backing off; nothing to do
    const signature = JSON.stringify(texts);
    if (signature === state.headerFooterSignature) return;
    const pageChanged = JSON.stringify(texts.page) !== JSON.stringify(state.docxPage);
    state.headerFooter = texts;
    state.headerFooterSignature = signature;
    state.docxPage = texts.page;
    if (pageChanged && state.lastBodyNode) {
      clearOriginalHighlight();
      rebuildMirror();
    }
    if (!texts.header.length && !texts.footer.length) return;

    // The body paragraph objects are carried across untouched, so their
    // mirror elements are still live — no rebuild needed, just a re-render
    // of the panel with the new entries in it.
    state.paragraphs = composeParagraphs(state.paragraphs.filter((p) => p.place === "body"));
    renderPanelFull();
    await requestTranslations(collectUntranslatedSentences());
  }

  // ---------- scroll sync (keeps the side-by-side panel roughly aligned) ----------

  let scrollSyncLock = false;
  function releaseScrollLockSoon() {
    setTimeout(() => {
      scrollSyncLock = false;
    }, 60);
  }

  // Set by setupScrollSync; lets a scroll the user makes in the side panel
  // (relayed as a "panelScroll" message) move the document.
  let scrollDocToParagraph = null;

  function setupScrollSync() {
    const main = getMainScroller();
    const isWindowScroller = main === document.scrollingElement || main === document.documentElement;

    // Where "the top of what the reader is looking at" is, in the document.
    const docAnchorY = () => (isWindowScroller ? 0 : main.getBoundingClientRect().top);

    // The paragraph straddling a given viewport Y, and how far through it
    // that Y falls. Both sides are keyed off this rather than off a
    // scrollTop percentage: a translation is rarely the same length as its
    // original (Chinese runs shorter than English, and a paragraph the
    // panel renders in three lines may take six in the document), so a
    // proportional mapping drifts steadily out of step down a long
    // document even though both ends line up. Anchoring on the paragraph
    // actually at the top of the view keeps the two genuinely side by side.
    function docParagraphAt(y) {
      let chosen = null;
      for (const p of state.paragraphs) {
        for (const el of p.mirrorEls || []) {
          const rect = el.getBoundingClientRect();
          if (rect.height <= 0) continue;
          if (rect.top <= y) chosen = { id: p.id, rect };
          else if (chosen) return chosen;
        }
      }
      return chosen;
    }

    const fractionThrough = (y, rect) =>
      Math.max(0, Math.min(1, rect.height > 0 ? (y - rect.top) / rect.height : 0));

    scrollDocToParagraph = (pId, fraction) => {
      if (scrollSyncLock || !state.enabled || !state.scrollSync) return;
      const paragraph = state.paragraphs.find((p) => p.id === pId);
      const mirrorEl = paragraph && paragraph.mirrorEls && paragraph.mirrorEls[0];
      if (!mirrorEl) return;
      scrollSyncLock = true;
      const mirrorRect = mirrorEl.getBoundingClientRect();
      const wanted = mirrorRect.top + Math.max(0, Math.min(1, fraction || 0)) * mirrorRect.height;
      const offset = wanted - docAnchorY();
      if (isWindowScroller) window.scrollBy(0, offset);
      else main.scrollTop += offset;
      releaseScrollLockSoon();
    };

    const onMainScroll = () => {
      // The original-side highlight needs no repositioning here — it's a
      // real DOM child of the mirror node, which is itself a real
      // descendant of this same scroller, so native scrolling carries it
      // along for free. That's independent of scrollSync below, which only
      // governs the *panel-follows-doc* convenience behavior.
      if (scrollSyncLock || !state.sidePanelPort || !state.enabled || !state.scrollSync) return;
      const anchorY = docAnchorY();
      const source = docParagraphAt(anchorY);
      if (!source) return;
      scrollSyncLock = true;
      postToPanel({ type: "scrollTo", pId: source.id, fraction: fractionThrough(anchorY, source.rect) });
      releaseScrollLockSoon();
    };

    // Scroll fires far faster than the layout reads above are worth doing,
    // and every one of those reads forces a synchronous layout — once per
    // frame is both smooth and plenty.
    let queued = false;
    (isWindowScroller ? window : main).addEventListener(
      "scroll",
      () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          onMainScroll();
        });
      },
      { passive: true }
    );
  }

  // ---------- floating toggle button ----------

  // A round icon button in the Docs top bar, next to "Ask Gemini", that
  // toggles the translation side panel the way that button toggles Gemini's.
  // Docs rebuilds parts of its header from time to time and would drop a
  // node it didn't make, so placeFloatingButton() re-attaches it on a timer.
  const TRANSLATE_ICON_PATH =
    "M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z";

  function createFloatingButton() {
    if (state.floatingBtn) return;
    const btn = document.createElement("button");
    btn.id = "gdt-floating-toggle";
    btn.className = "gdt-toolbar-btn";
    btn.type = "button";
    btn.title = "Translate";
    btn.setAttribute("aria-label", "Translate");
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="${TRANSLATE_ICON_PATH}"/></svg>`;
    // Opening a side panel has to happen in direct response to a click, so
    // hand the request to the background worker from inside the handler.
    btn.addEventListener("click", () => {
      if (state.sidePanelPort) {
        chrome.runtime.sendMessage({ type: "GDT_CLOSE_PANEL" }).catch(() => {});
        return;
      }
      if (!state.enabled) setEnabled(true);
      chrome.runtime.sendMessage({ type: "GDT_OPEN_PANEL" }).catch(() => {});
    });
    state.floatingBtn = btn;
    placeFloatingButton();
    setInterval(placeFloatingButton, 1500);
  }

  function placeFloatingButton() {
    const btn = state.floatingBtn;
    if (!btn) return;
    const gemini = Array.from(document.querySelectorAll('[aria-label*="Gemini" i]')).find(
      (el) => el !== btn && el.getBoundingClientRect().width > 0
    );
    // The button itself may be wrapped (Docs wraps its toolbar buttons);
    // sit beside the outermost wrapper that still lives in the same row.
    let anchor = gemini;
    while (anchor && anchor.parentElement && anchor.parentElement.children.length === 1) {
      anchor = anchor.parentElement;
    }
    if (anchor && anchor.parentElement) {
      btn.classList.remove("gdt-floating");
      if (btn.nextElementSibling !== anchor) anchor.parentElement.insertBefore(btn, anchor);
    } else {
      // Gemini's button not found: a fixed spot at the top right still works.
      btn.classList.add("gdt-floating");
      if (btn.parentElement !== document.body) document.body.appendChild(btn);
    }
    btn.classList.toggle("gdt-on", !!state.sidePanelPort);
  }

  function setEnabled(enabled) {
    state.enabled = enabled;
    if (!enabled) {
      clearOriginalHighlight();
      clearTranslatedHighlight();
    }
    postToPanel({ type: "enabled", enabled });
    if (enabled) void refreshFromDoc();
    chrome.storage.local.set({ gdt_enabled: enabled });
  }

  function setScrollSync(scrollSync) {
    state.scrollSync = scrollSync;
    chrome.storage.local.set({ gdt_scroll_sync: scrollSync });
  }

  // ---------- init ----------

  function waitForEditor() {
    return new Promise((resolve) => {
      const existing = querySelectorFirst(CONTAINER_SELECTORS);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = querySelectorFirst(CONTAINER_SELECTORS);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function init() {
    state.docId = getDocId();
    if (!state.docId) {
      warn("Could not determine document ID from URL.");
      return;
    }

    const stored = await chrome.storage.sync.get({ targetLang: "zh-CN" });
    state.targetLang = stored.targetLang;
    const localStored = await chrome.storage.local.get({ gdt_enabled: true, gdt_scroll_sync: true });
    state.enabled = localStored.gdt_enabled;
    state.scrollSync = localStored.gdt_scroll_sync;

    const editorRoot = await waitForEditor();
    log("editor root found:", editorRoot.className || editorRoot.id);

    createFloatingButton();
    setEnabled(state.enabled);

    await refreshFromDoc();
    setupScrollSync();

    // See invalidateFontMetricsAndRebuild's own note: catches a webfont
    // that was still downloading at the measurements above.
    if (document.fonts) {
      document.fonts.addEventListener("loadingdone", debounce(invalidateFontMetricsAndRebuild, 300));
    }

    document.addEventListener("click", onOriginalClick, true);
    chrome.runtime.onConnect.addListener(onPanelConnect);

    setInterval(refreshFromDoc, REFRESH_POLL_MS);
    // Switching document tabs only changes the URL (no page load), so watch
    // for it and start over with the newly selected tab's content.
    let watchedTabId = getTabId();
    let tabSettleTimer = null;
    setInterval(() => {
      const tabId = getTabId();
      if (tabId === watchedTabId) return;
      watchedTabId = tabId;
      // Wait for the user to settle on a tab, so flicking through several
      // tabs costs one export request instead of one per tab passed.
      clearTimeout(tabSettleTimer);
      tabSettleTimer = setTimeout(onTabChanged, TAB_SETTLE_MS);
    }, 500);
    setInterval(repositionMirrorTick, REPOSITION_TICK_MS);

    window.addEventListener(
      "resize",
      debounce(() => {
        rebuildMirror();
        if (state.activeHighlight) renderHighlightBoxes();
      }, RESIZE_DEBOUNCE_MS)
    );
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GDT_SET_ENABLED") {
      setEnabled(!!msg.enabled);
      sendResponse({ ok: true });
    } else if (msg.type === "GDT_SET_SCROLL_SYNC") {
      setScrollSync(!!msg.scrollSync);
      sendResponse({ ok: true });
    } else if (msg.type === "GDT_SET_TARGET_LANG") {
      state.targetLang = msg.targetLang;
      state.paragraphs.forEach((p) =>
        p.sentences.forEach((s) => {
          s.translated = null;
          s.error = null;
        })
      );
      renderPanelFull();
      requestTranslations(collectUntranslatedSentences());
      sendResponse({ ok: true });
    } else if (msg.type === "GDT_FORCE_RETRANSLATE") {
      // Deliberately doesn't go through refreshFromDoc(): that reuses a
      // paragraph's existing (already-translated) sentence objects
      // whenever its *text* hasn't changed — which is the normal case for
      // this button, since the user isn't editing the doc, just asking to
      // retranslate it (e.g. after switching backend or API key). That
      // made this a silent no-op: collectUntranslatedSentences() found
      // nothing to do because everything already had a `translated`
      // value. Clearing it directly here (same pattern as
      // GDT_SET_TARGET_LANG above) guarantees a fresh request every time.
      state.paragraphs.forEach((p) =>
        p.sentences.forEach((s) => {
          s.translated = null;
          s.error = null;
        })
      );
      renderPanelFull();
      requestTranslations(collectUntranslatedSentences());
      sendResponse({ ok: true });
    } else if (msg.type === "GDT_GET_STATE") {
      sendResponse({ ok: true, enabled: state.enabled, targetLang: state.targetLang, scrollSync: state.scrollSync });
    }
    return true;
  });

  // Test hook (see test/mock-docs.html): live reference to internal state
  // for debugging. Content scripts run in an isolated JS world on real
  // Google Docs pages, so this never leaks onto the actual page there.
  window.__GDT_DEBUG_STATE__ = state;

  init().catch((err) => warn("init failed", err));
})();
