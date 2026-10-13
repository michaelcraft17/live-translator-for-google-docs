// Runs in the page's own world at document_start, before Docs registers any
// font. Docs builds each embedded face with `new FontFace(family, source)`
// and `document.fonts.add()`; the "docs-" faces have no stylesheet rule and
// no request the extension can see, so the face's source is only reachable
// here. This probe records what each source is (a CSS `url()` string or raw
// bytes, and how big) on the root element, where the isolated content script
// can read it. It changes nothing about how faces load.
(() => {
  const Native = window.FontFace;
  if (!Native || window.__gdtFontHook) return;
  window.__gdtFontHook = true;
  const log = [];
  const publish = () => {
    try {
      document.documentElement.dataset.gdtFontLog = JSON.stringify(log);
    } catch (e) {
      // The root can be missing for a moment at document_start.
    }
  };
  window.FontFace = new Proxy(Native, {
    construct(target, args, newTarget) {
      const [family, source, descriptors] = args;
      let kind = typeof source;
      let size = 0;
      let ref = "";
      if (typeof source === "string") {
        kind = "css";
        size = source.length;
        ref = source.slice(0, 400);
      } else if (source instanceof ArrayBuffer) {
        kind = "ArrayBuffer";
        size = source.byteLength;
      } else if (ArrayBuffer.isView(source)) {
        kind = "view";
        size = source.byteLength;
      }
      log.push({
        family: String(family),
        kind,
        size,
        ref,
        weight: descriptors && descriptors.weight,
        style: descriptors && descriptors.style,
        range: descriptors && descriptors.unicodeRange ? String(descriptors.unicodeRange).slice(0, 24) : "",
      });
      publish();
      return Reflect.construct(target, args, newTarget);
    },
  });
})();
