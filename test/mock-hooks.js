// ---- Test hooks consumed by content/content.js ----
// v2 (shadow-mirror architecture): content.js now reads `/export?format=html`
// instead of `?format=txt`, since it needs the per-paragraph/per-run CSS
// (font, line-height, page margins) that only the HTML export carries, to
// build the invisible measurement mirror. This canned HTML reproduces the
// exact shape Google Docs itself exports: a `<style>` block with short
// class names, a page-box class on `<body>` (padding + max-width, in pt —
// what content.js uses to derive its px-per-pt scale), paragraph classes,
// and a table (one exported `<tr>` per row, one `<p>` per cell) to exercise
// the row-as-one-unit handling.
//
// Must be an external file (not an inline <script> block): Manifest V3's
// default CSP for extension pages is `script-src 'self'`, which blocks
// inline script content.
window.__GDT_FORCE_DOC_ID__ = "mock-doc-1";
window.__GDT_MOCK_EXPORT_HTML__ = `<!DOCTYPE html><html><head><meta charset="utf-8"><style type="text/css">
.c0{padding-top:0pt;padding-bottom:0pt;line-height:1.15;orphans:2;widows:2;text-align:left}
.c1{color:#000000;font-weight:400;text-decoration:none;vertical-align:baseline;font-size:11pt;font-family:"Arial";font-style:normal}
.c2{background-color:#ffffff;max-width:468pt;padding:72pt 72pt 72pt 72pt}
.c3{padding-top:0pt;padding-bottom:0pt;line-height:1.0;text-align:left}
</style></head>
<body class="c2 doc-content">
<p class="c0"><span class="c1">Copy of Yeast as a model organism for studying neurodegenerative diseases</span></p>
<table>
<tr class="c3">
<td><p class="c0"><span class="c1">Name</span></p></td>
<td><p class="c0"><span class="c1">Michael Chang</span></p></td>
<td><p class="c0"><span class="c1">Date</span></p></td>
<td><p class="c0"><span class="c1">9/4/2026</span></p></td>
<td><p class="c0"><span class="c1">Class Period</span></p></td>
<td><p class="c0"><span class="c1">4</span></p></td>
</tr>
</table>
<p class="c0"><span class="c1">Yeast as a model organism for studying neurodegenerative disease</span></p>
<p class="c0"><span class="c1">Humans have enjoyed a close association with yeast for thousands of years, using the organism to make bread and beer. The desire of brewers to make higher quality beer led to the first genetic manipulation of yeast cells. Today, yeast is one of the best-studied genetic organisms with a small, well-defined genome (one of the first sequenced), and powerful tools are available for manipulating it. Research using yeast has shed light on the steps of the cell cycle, leading to a greater understanding of cancer biology. But is this unicellular organism that lacks a brain, or even a dendrite, a good model organism for understanding Neurodegenerative Diseases?</span></p>
<p class="c0"><span class="c1">Resources:</span></p>
</body></html>`;
