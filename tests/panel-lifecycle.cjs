const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

(async () => {
  const calls = [];
  let receive;
  const chrome = {
    sidePanel: {
      setOptions: async options => calls.push(['options', options]),
      open: async options => calls.push(['open', options]),
      close: async options => calls.push(['close', options]),
    },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { receive = fn; } },
    },
    tabs: { onUpdated: { addListener() {} } },
  };
  const background = fs.readFileSync('background.js', 'utf8');
  vm.runInNewContext(background.slice(background.indexOf('const DOCS_URL_RE')), { chrome, console });
  assert.equal(calls.length, 0, 'worker wake must not reset panel options');
  const sender = { tab: { id: 7, url: 'https://docs.google.com/document/d/test/edit' } };
  const send = type => new Promise(resolve => receive({ type }, sender, resolve));
  assert.equal((await send('GDT_PREPARE_PANEL')).ok, true);
  assert.equal(calls[0][1].enabled, true);
  const opening = send('GDT_OPEN_PANEL');
  assert.equal(calls.at(-1)[0], 'open', 'open must happen synchronously with the gesture message');
  assert.equal((await opening).ok, true);
  assert.equal((await send('GDT_CLOSE_PANEL')).ok, true);
  delete chrome.sidePanel.close;
  await send('GDT_CLOSE_PANEL');
  assert.deepEqual(calls.slice(-2).map(call => call[1].enabled), [false, true]);
  chrome.sidePanel.open = async () => { throw new Error('gesture expired'); };
  assert.match((await send('GDT_OPEN_PANEL')).error, /gesture expired/);

  const content = fs.readFileSync('content/content.js', 'utf8');
  const buttonSource = content.slice(content.indexOf('  function createFloatingButton()'), content.indexOf("  // Docs' header changes"));
  let click;
  let resolveMessage;
  let messageCount = 0;
  const state = { enabled: true, floatingBtn: null, sidePanelPort: null };
  const button = { setAttribute() {}, removeAttribute() {}, addEventListener(name, fn) { if (name === 'click') click = fn; } };
  vm.runInNewContext(buttonSource + '\ncreateFloatingButton();', {
    state, document: { createElement: () => button }, TRANSLATE_ICON_PATH: '',
    chrome: { runtime: { sendMessage() { messageCount++; return new Promise(resolve => { resolveMessage = resolve; }); } } },
    console: { warn() {} }, setTimeout, clearTimeout, setInterval() {},
    placeFloatingButton() {}, debounce: fn => fn, window: { addEventListener() {} },
  });
  const first = click();
  await click();
  assert.equal(messageCount, 1, 'rapid clicks must not overlap');
  state.sidePanelPort = {};
  resolveMessage({ ok: true });
  await first;
  const close = click();
  assert.equal(messageCount, 2);
  state.sidePanelPort = null;
  resolveMessage({ ok: true });
  await close;
  const failure = click();
  resolveMessage({ ok: false, error: 'test failure' });
  await failure;
  assert.match(button.title, /test failure/);
  const retry = click();
  assert.equal(messageCount, 4, 'failed requests must allow retry');
  state.sidePanelPort = {};
  resolveMessage({ ok: true });
  await retry;
  console.log('Panel lifecycle checks passed: preparation, direct opening, close fallback, errors, rapid clicks, retry.');
})().catch(err => { console.error(err); process.exitCode = 1; });
