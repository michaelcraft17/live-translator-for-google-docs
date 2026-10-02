// Side panel UI. Renders what the content script (content/content.js) sends
// over a port and reports clicks and scrolling back to it; it never touches
// the document itself.

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const staleEl = document.getElementById("staleBanner");
const settingsEl = document.getElementById("settings");
const settingsBtn = document.getElementById("settingsBtn");
const scrollSyncBtn = document.getElementById("scrollSyncBtn");

let tabId = null;
let port = null;
let reconnectTimer = null;
let applyingScroll = false; // true while a scroll we caused is in flight

function setStatus(text) {
  statusEl.textContent = text || "";
  statusEl.hidden = !text;
}

function sentenceLabel(s) {
  return s.error ? `⚠ ${s.text}` : s.translated !== null ? s.translated : "…";
}

function buildParagraph(p) {
  const pEl = document.createElement("div");
  pEl.className = "gdt-panel-paragraph";
  pEl.dataset.gdtParagraphId = p.id;
  // Header and footer entries have no counterpart to highlight in the
  // document (Docs draws them in the page margin), so label them.
  if (p.place && p.place !== "body") pEl.dataset.gdtPlace = p.place;
  if (p.minHeight > 0) pEl.style.minHeight = `${p.minHeight}px`;

  if (!p.sentences.length) {
    pEl.innerHTML = "&nbsp;"; // preserve blank-line spacing
    return pEl;
  }
  for (const s of p.sentences) {
    const sEl = document.createElement("span");
    sEl.className = "gdt-sentence";
    sEl.dataset.gdtParagraphId = p.id;
    sEl.dataset.gdtSentenceId = s.id;
    sEl.textContent = sentenceLabel(s);
    if (s.error) sEl.classList.add("gdt-sentence-error");
    pEl.appendChild(sEl);
    pEl.appendChild(document.createTextNode(" "));
  }
  return pEl;
}

function findSentenceEl(pId, sId) {
  for (const el of listEl.querySelectorAll(".gdt-sentence")) {
    if (el.dataset.gdtParagraphId === pId && el.dataset.gdtSentenceId === sId) return el;
  }
  return null;
}

function clearActive() {
  listEl.querySelectorAll(".gdt-sentence.gdt-active").forEach((el) => el.classList.remove("gdt-active"));
}

function setActive(pId, sId, scroll) {
  clearActive();
  if (!pId) return;
  const el = findSentenceEl(pId, sId);
  if (!el) return;
  el.classList.add("gdt-active");
  if (scroll) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function showScrollSync(on) {
  scrollSyncBtn.classList.toggle("gdt-on", !!on);
  scrollSyncBtn.classList.toggle("gdt-off", !on);
  scrollSyncBtn.title = on ? "Scroll sync: on (click to turn off)" : "Scroll sync: off (click to turn on)";
  scrollSyncBtn.dataset.on = on ? "1" : "";
}

function render(snapshot) {
  if (typeof snapshot.scrollSync === "boolean") showScrollSync(snapshot.scrollSync);
  staleEl.hidden = !snapshot.stale;
  listEl.textContent = "";
  if (!snapshot.enabled) {
    setStatus("Translation is turned off.");
    return;
  }
  setStatus(snapshot.paragraphs.length ? "" : "Reading the document…");
  const frag = document.createDocumentFragment();
  for (const p of snapshot.paragraphs) frag.appendChild(buildParagraph(p));
  listEl.appendChild(frag);
}

// Scroll sync is keyed by paragraph + how far through it, not by scroll
// percentage — see setupScrollSync in content.js for why.
function paragraphAtTop() {
  const top = listEl.getBoundingClientRect().top;
  let chosen = null;
  for (const el of listEl.querySelectorAll(".gdt-panel-paragraph")) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.top <= top) chosen = { el, rect };
    else if (chosen) break;
  }
  return chosen && { ...chosen, top };
}

function scrollToParagraph(pId, fraction) {
  const el = listEl.querySelector(`[data-gdt-paragraph-id="${CSS.escape(pId)}"]`);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const offset = rect.top - listEl.getBoundingClientRect().top + Math.max(0, Math.min(1, fraction)) * rect.height;
  applyingScroll = true;
  listEl.scrollTop += offset;
  setTimeout(() => {
    applyingScroll = false;
  }, 100);
}

function onMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case "snapshot":
      render(msg);
      break;
    case "sentence": {
      const el = findSentenceEl(msg.pId, msg.sentence.id);
      if (!el) return;
      el.textContent = sentenceLabel(msg.sentence);
      el.classList.toggle("gdt-sentence-error", !!msg.sentence.error);
      break;
    }
    case "active":
      setActive(msg.pId, msg.sId, msg.scroll);
      break;
    case "stale":
      staleEl.hidden = !msg.stale;
      break;
    case "enabled":
      if (!msg.enabled) {
        listEl.textContent = "";
        setStatus("Translation is turned off.");
      }
      break;
    case "scrollSync":
      showScrollSync(msg.scrollSync);
      break;
    case "scrollTo":
      scrollToParagraph(msg.pId, msg.fraction);
      break;
  }
}

scrollSyncBtn.addEventListener("click", () => {
  const next = !scrollSyncBtn.dataset.on;
  showScrollSync(next);
  if (tabId !== null) chrome.tabs.sendMessage(tabId, { type: "GDT_SET_SCROLL_SYNC", scrollSync: next }).catch(() => {});
});

// The gear swaps the translation list for the same settings the toolbar
// popup has (popup/popup.js drives both).
settingsBtn.addEventListener("click", () => {
  const showing = settingsEl.hidden;
  settingsEl.hidden = !showing;
  listEl.hidden = showing;
  settingsBtn.classList.toggle("gdt-on", showing);
  settingsBtn.title = showing ? "Back to translation" : "Settings";
});

listEl.addEventListener("click", (e) => {
  const sEl = e.target.closest(".gdt-sentence");
  if (!sEl || !port) return;
  setActive(sEl.dataset.gdtParagraphId, sEl.dataset.gdtSentenceId, false);
  port.postMessage({ type: "click", pId: sEl.dataset.gdtParagraphId, sId: sEl.dataset.gdtSentenceId });
});

let scrollQueued = false;
listEl.addEventListener(
  "scroll",
  () => {
    if (applyingScroll || scrollQueued || !port) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      const at = paragraphAtTop();
      if (!at || !port) return;
      const fraction = at.rect.height > 0 ? (at.top - at.rect.top) / at.rect.height : 0;
      port.postMessage({ type: "panelScroll", pId: at.el.dataset.gdtParagraphId, fraction });
    });
  },
  { passive: true }
);

function connect() {
  clearTimeout(reconnectTimer);
  if (port) {
    try {
      port.disconnect();
    } catch (err) {
      // already closed
    }
    port = null;
  }
  if (tabId === null) return;
  const thisPort = chrome.tabs.connect(tabId, { name: "gdt-panel" });
  port = thisPort;
  thisPort.onMessage.addListener(onMessage);
  thisPort.onDisconnect.addListener(() => {
    // Read lastError so Chrome doesn't log it: it is just "no listener yet"
    // while the page is still loading, or the tab navigating.
    void chrome.runtime.lastError;
    if (port !== thisPort) return;
    port = null;
    setStatus("Connecting to the document…");
    reconnectTimer = setTimeout(connect, 1500);
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  connect();
  // A side panel can outlive a tab switch; follow whichever tab is in front.
  chrome.tabs.onActivated.addListener((info) => {
    if (info.tabId === tabId) return;
    tabId = info.tabId;
    listEl.textContent = "";
    connect();
  });
}

init();
