// Background service worker: performs all translation network requests
// (kept out of the content script so requests aren't subject to the
// Google Docs page's CSP, and so results can be cached centrally).

const CACHE_KEY = "gdt_translation_cache_v1";
// Defaults to a documented, terms-covered API. The 'google-free' backend
// below talks to an undocumented endpoint that carries no SLA or terms
// guarantee — fine while developing, not something to point a published
// extension's users at by default, so it has to be chosen deliberately.
const DEFAULT_SETTINGS = {
  backend: "google-cloud", // 'google-cloud' | 'deepl' | 'google-free'
  apiKey: "",
  targetLang: "zh-CN",
};

async function getCache() {
  const data = await chrome.storage.local.get(CACHE_KEY);
  return data[CACHE_KEY] || {};
}

async function setCache(cache) {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

function cacheKey(text, targetLang, backend) {
  return `${backend}::${targetLang}::${text}`;
}

async function translateOne(text, targetLang, settings) {
  const backend = settings.backend || "google-free";

  if (backend === "google-free") {
    // Undocumented endpoint used by many open-source tools. No API key
    // needed, but it is rate-limited and covered by no SLA or terms of
    // service — which is why it is no longer the default (see
    // DEFAULT_SETTINGS). Kept for local development only.
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx" +
      `&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`google-free HTTP ${res.status}`);
    const data = await res.json();
    return (data[0] || []).map((chunk) => chunk[0]).join("");
  }

  if (backend === "google-cloud") {
    if (!settings.apiKey) throw new Error("Missing Google Cloud Translation API key");
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(settings.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target: targetLang, format: "text" }),
    });
    if (!res.ok) throw new Error(`google-cloud HTTP ${res.status}`);
    const data = await res.json();
    return data.data.translations[0].translatedText;
  }

  if (backend === "deepl") {
    if (!settings.apiKey) throw new Error("Missing DeepL API key");
    const isFreeKey = settings.apiKey.endsWith(":fx");
    const endpoint = isFreeKey
      ? "https://api-free.deepl.com/v2/translate"
      : "https://api.deepl.com/v2/translate";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        auth_key: settings.apiKey,
        text,
        target_lang: targetLang.toUpperCase(),
      }),
    });
    if (!res.ok) throw new Error(`deepl HTTP ${res.status}`);
    const data = await res.json();
    return data.translations[0].text;
  }

  throw new Error(`Unknown translation backend: ${backend}`);
}

async function translateBatch(items, targetLang, settings) {
  const cache = await getCache();
  const results = {};
  const toFetch = [];

  for (const item of items) {
    const key = cacheKey(item.text, targetLang, settings.backend);
    if (cache[key] !== undefined) {
      results[item.id] = { text: cache[key] };
    } else {
      toFetch.push(item);
    }
  }

  let cacheChanged = false;
  const CONCURRENCY = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < toFetch.length) {
      const item = toFetch[cursor++];
      try {
        const translated = await translateOne(item.text, targetLang, settings);
        results[item.id] = { text: translated };
        cache[cacheKey(item.text, targetLang, settings.backend)] = translated;
        cacheChanged = true;
      } catch (err) {
        results[item.id] = { error: String(err && err.message ? err.message : err) };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, toFetch.length) }, worker)
  );

  if (cacheChanged) await setCache(cache);
  return results;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "GDT_TRANSLATE_BATCH") {
    (async () => {
      try {
        const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
        const targetLang = msg.targetLang || settings.targetLang;
        const results = await translateBatch(msg.items, targetLang, settings);
        sendResponse({ ok: true, results });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true; // keep channel open for async sendResponse
  }

  if (msg && msg.type === "GDT_GET_SETTINGS") {
    (async () => {
      const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      sendResponse({ ok: true, settings });
    })();
    return true;
  }
});
