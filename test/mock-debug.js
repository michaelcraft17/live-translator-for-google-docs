function dumpState() {
  const s = window.__GDT_DEBUG_STATE__;
  const out = document.getElementById("gdt-test-dump");
  if (!s) {
    out.textContent = "window.__GDT_DEBUG_STATE__ not found yet — content.js may still be loading.";
    return;
  }
  const summary = {
    paragraphCount: s.paragraphs.length,
    paragraphs: s.paragraphs.map((p) => ({
      id: p.id,
      kind: p.kind,
      text: p.text.length > 70 ? p.text.slice(0, 70) + "…" : p.text,
      sentenceCount: p.sentences.length,
      mirrorElFound: !!p.mirrorEl,
      translatedFirstSentence: p.sentences[0] ? p.sentences[0].translated : null,
    })),
  };
  out.textContent = JSON.stringify(summary, null, 2);
}

document.getElementById("gdt-dump-btn").addEventListener("click", dumpState);
setTimeout(dumpState, 2000);
