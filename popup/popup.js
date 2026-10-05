(() => {
const DEFAULT_SETTINGS = {
  backend: "google-cloud",
  apiKey: "",
  targetLang: "zh-CN",
};

const enabledToggle = document.getElementById("enabledToggle");
const scrollSyncToggle = document.getElementById("scrollSyncToggle");
const targetLangSel = document.getElementById("targetLang");
const backendSel = document.getElementById("backend");
const apiKeyRow = document.getElementById("apiKeyRow");
const apiKeyInput = document.getElementById("apiKey");
const retranslateBtn = document.getElementById("retranslate");
const openPanelBtn = document.getElementById("openPanel");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isDocsTab(tab) {
  return tab && tab.url && /^https:\/\/docs\.google\.com\/document\//.test(tab.url);
}

async function sendToContent(message) {
  const tab = await getActiveTab();
  if (!isDocsTab(tab)) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    console.warn("[GDT popup] message failed", err);
    return null;
  }
}

function updateApiKeyVisibility() {
  apiKeyRow.hidden = backendSel.value === "google-free";
}

let panelTabId = null;

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  targetLangSel.value = settings.targetLang;
  backendSel.value = settings.backend;
  apiKeyInput.value = settings.apiKey || "";
  updateApiKeyVisibility();

  const tab = await getActiveTab();
  if (isDocsTab(tab)) {
    panelTabId = tab.id;
    const state = await sendToContent({ type: "GDT_GET_STATE" });
    if (state && state.ok) {
      enabledToggle.checked = state.enabled;
      if (scrollSyncToggle) scrollSyncToggle.checked = state.scrollSync;
    }
  } else {
    enabledToggle.disabled = true;
    if (scrollSyncToggle) scrollSyncToggle.disabled = true;
    retranslateBtn.disabled = true;
  }
}

enabledToggle.addEventListener("change", () => {
  sendToContent({ type: "GDT_SET_ENABLED", enabled: enabledToggle.checked });
});

// (Absent in the side panel, which has its own scroll-sync button.)
if (scrollSyncToggle) {
  scrollSyncToggle.addEventListener("change", () => {
    sendToContent({ type: "GDT_SET_SCROLL_SYNC", scrollSync: scrollSyncToggle.checked });
  });
}

targetLangSel.addEventListener("change", async () => {
  await chrome.storage.sync.set({ targetLang: targetLangSel.value });
  sendToContent({ type: "GDT_SET_TARGET_LANG", targetLang: targetLangSel.value });
});

backendSel.addEventListener("change", async () => {
  updateApiKeyVisibility();
  await chrome.storage.sync.set({ backend: backendSel.value });
});

apiKeyInput.addEventListener("change", async () => {
  await chrome.storage.sync.set({ apiKey: apiKeyInput.value });
});

// sidePanel.open() has to run straight from the click, so no awaiting
// anything (like getActiveTab) before it.
// (Absent when this script is loaded inside the side panel's settings view.)
if (openPanelBtn) {
  openPanelBtn.addEventListener("click", () => {
    if (panelTabId === null) return;
    chrome.sidePanel.open({ tabId: panelTabId })
      .then(() => window.close())
      .catch((err) => {
        openPanelBtn.textContent = "Retry opening panel";
        openPanelBtn.title = err.message;
      });
  });
}

retranslateBtn.addEventListener("click", () => {
  sendToContent({ type: "GDT_FORCE_RETRANSLATE" });
});

init();

})();
