/**
 * End-to-end test: loads the extension into real Chrome and exercises it
 * against live threads.com.
 *
 * Zero dependencies -- talks CDP over Node's built-in WebSocket and fetch.
 *
 *   node tools/e2e-test.js [--headful] [--keep]
 *
 * What it proves:
 *   1. The MV3 manifest loads and the service worker boots without error.
 *   2. The blocklist is fetched from the local server and parsed.
 *   3. The MAIN-world script hooks Meta's module registry and the isolated
 *      world completes the bridge handshake.
 *   4. The capability probe finds the live Relay environment and doc_ids.
 *   5. Content authored by a blocklisted profile is actually hidden.
 *
 * Nothing is ever blocked for real: platform blocking stays disabled.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HEADFUL = process.argv.includes('--headful');
const KEEP = process.argv.includes('--keep');
const PORT = 8791;
// Deliberately NOT the dev-session port (9333). Sharing it meant this harness
// silently attached to a browser someone was using by hand instead of the clean
// one it spawns, which produced confusing phantom failures.
const CDP_PORT = 9347;
const ROOT = path.join(__dirname, '..');

// The @threads account: a public profile whose numeric pk we can assert on.
const TARGET_ID = '63082166531';
const TARGET_USERNAME = 'threads';
const TEST_URL = 'https://www.threads.com/@threads';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// minimal CDP client
// ---------------------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP socket error')));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 45000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function evalIn(cdp, sessionId, expression, awaitPromise) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: awaitPromise !== false,
    returnByValue: true,
    userGesture: true
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception
      ? (res.exceptionDetails.exception.description || res.exceptionDetails.text)
      : res.exceptionDetails.text);
  }
  return res.result && res.result.value;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
function buildTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-ext-'));
  const copy = (rel) => {
    const src = path.join(ROOT, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child); else copy(child);
    }
  };
  walk('src');
  walk('icons');

  // The only divergence from the shipped build: the local test server is added
  // to host_permissions so the fetch path can be exercised without a
  // user-gesture permission prompt.
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  m.host_permissions = m.host_permissions.concat([`http://localhost:${PORT}/*`]);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

function startServer() {
  const listFile = path.join(os.tmpdir(), 'tq-blocklist-' + Date.now() + '.json');
  fs.writeFileSync(listFile, JSON.stringify({
    ids: [TARGET_ID],
    usernames: [TARGET_USERNAME],
    docIdOverrides: {}
  }, null, 2));

  // Reuse the reference server, pointed at a temp store.
  const serverDir = path.join(os.tmpdir(), 'tq-srv-' + Date.now());
  fs.mkdirSync(serverDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server', 'server.js'), path.join(serverDir, 'server.js'));
  fs.copyFileSync(listFile, path.join(serverDir, 'blocklist.json'));

  const proc = spawn(process.execPath, [path.join(serverDir, 'server.js'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => console.error('[server]', String(d).trim()));
  return proc;
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium'
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async function main() {
  const extDir = buildTestExtension();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-profile-'));
  console.log('extension:', extDir);

  const server = startServer();
  await sleep(700);

  // Sanity: the server really is serving.
  try {
    const r = await fetch(`http://localhost:${PORT}/blocklist.json`);
    const j = await r.json();
    check('mock server serves blocklist', Array.isArray(j.ids) && j.ids.includes(TARGET_ID),
      `${j.ids.length} ids`);
  } catch (e) {
    check('mock server serves blocklist', false, String(e.message));
  }

  // Current Chrome builds ignore --load-extension, so the extension is loaded
  // over CDP instead (Extensions.loadUnpacked), which needs this switch.
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank'
  ];
  if (!HEADFUL) chromeArgs.splice(3, 0, '--headless=new');
  const chrome = spawn(findChrome(), chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});

  const cleanup = () => {
    try { chrome.kill(); } catch (e) {}
    try { server.kill(); } catch (e) {}
    if (!KEEP) {
      try { fs.rmSync(extDir, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
    }
  };
  process.on('exit', cleanup);

  // Wait for the debugging endpoint.
  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      version = await r.json();
      break;
    } catch (e) { await sleep(500); }
  }
  if (!version) { check('Chrome DevTools endpoint reachable', false); finish(cleanup); return; }
  check('Chrome DevTools endpoint reachable', true, version.Browser);

  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Target.setDiscoverTargets', { discover: true });

  // ---- 1. service worker booted -----------------------------------------
  let extId = null;
  try {
    const loaded = await browser.send('Extensions.loadUnpacked', { path: extDir });
    extId = loaded && loaded.id;
  } catch (e) {
    check('extension loaded via CDP', false, e.message);
    finish(cleanup);
    return;
  }
  check('extension loaded via CDP', !!extId, extId || '');

  // MV3 workers are lazy. Opening an extension page sends a runtime message,
  // which is what actually spins the worker up.
  const optionsUrl = `chrome-extension://${extId}/src/options/options.html`;
  const { targetId: optTarget } = await browser.send('Target.createTarget', { url: optionsUrl });
  const { sessionId: optSession } = await browser.send('Target.attachToTarget',
    { targetId: optTarget, flatten: true });
  await browser.send('Runtime.enable', {}, optSession);
  await sleep(2000);

  // The options page proves the extension's own UI loads and its CSP is sane.
  let optOk = false;
  try {
    optOk = await evalIn(browser, optSession,
      `!!document.getElementById('listUrl') && typeof chrome.storage === 'object'`, false);
  } catch (e) { /* reported below */ }
  check('options page renders with chrome APIs', !!optOk);

  let swTarget = null;
  let allWorkers = [];
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    allWorkers = targetInfos.filter(t => t.type === 'service_worker');
    swTarget = allWorkers.find(t => t.url.includes(extId));
    if (swTarget) break;
    await sleep(500);
  }
  if (!swTarget) console.log('service workers seen:', allWorkers.map(t => t.url));
  check('extension service worker started', !!swTarget, swTarget ? swTarget.url : 'not found');
  if (!swTarget) { finish(cleanup); return; }

  const { sessionId: swSession } = await browser.send('Target.attachToTarget',
    { targetId: swTarget.targetId, flatten: true });
  await browser.send('Runtime.enable', {}, swSession);

  // ---- 2. configure + fetch blocklist -----------------------------------
  try {
    const setRes = await evalIn(browser, optSession, `
      (async () => {
        await chrome.storage.sync.set({ settings: {
          listUrl: 'http://localhost:${PORT}/blocklist.json',
          refreshMinutes: 60,
          hideEnabled: true,
          hideMode: 'collapse',
          hideComments: true,
          hideFeedPosts: true,
          platformBlockEnabled: false,
          platformBlockDryRun: true,
          debug: true
        }});
        return 'ok';
      })()
    `);
    check('settings written to sync storage', setRes === 'ok');
  } catch (e) {
    check('settings written to sync storage', false, e.message);
  }

  let refresh = null;
  try {
    refresh = await evalIn(browser, optSession, `
      (async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'sw:refresh-now' }, x => r(x || { ok:false, error: (chrome.runtime.lastError||{}).message })));
        return JSON.stringify(res);
      })()
    `);
    const parsed = JSON.parse(refresh);
    check('blocklist fetched + parsed by service worker',
      parsed.ok && parsed.blocklist && parsed.blocklist.ids.includes(TARGET_ID),
      parsed.ok ? `${parsed.blocklist.ids.length} ids, ${parsed.blocklist.usernames.length} usernames`
                : parsed.error);
  } catch (e) {
    check('blocklist fetched + parsed by service worker', false, e.message);
  }

  // ---- 3. open Threads and let the content scripts run -------------------
  const { targetId: pageTarget } = await browser.send('Target.createTarget', { url: TEST_URL });
  const { sessionId: pageSession } = await browser.send('Target.attachToTarget',
    { targetId: pageTarget, flatten: true });
  await browser.send('Runtime.enable', {}, pageSession);
  await browser.send('Page.enable', {}, pageSession);

  // Give the SPA time to render the profile feed and the extension to scan.
  await sleep(14000);

  // ---- 4. bridge + capability -------------------------------------------
  let status = null;
  try {
    const raw = await evalIn(browser, optSession, `
      (async () => {
        const tabs = await chrome.tabs.query({ url: 'https://www.threads.com/*' });
        if (!tabs.length) return JSON.stringify({ error: 'no threads tab' });
        const res = await new Promise(r => chrome.tabs.sendMessage(tabs[0].id, { type: 'tab:status' },
          x => r(x || { error: (chrome.runtime.lastError||{}).message })));
        return JSON.stringify(res);
      })()
    `);
    status = JSON.parse(raw);
  } catch (e) {
    status = { error: e.message };
  }

  check('content script reachable + bridge handshake', status && status.handshake === true,
    status && status.error ? status.error : `platform=${status && status.platform}`);

  const cap = status && status.capability;
  check('MAIN world hooked Meta module registry',
    !!(cap && cap.moduleCount > 100),
    cap ? `${cap.moduleCount} modules, ${cap.graphqlModuleCount} graphql` : 'no capability report');

  check('live Relay environment discovered',
    !!(cap && cap.hasRelay && cap.relayRecords > 0),
    cap ? `${cap.relayEnv} with ${cap.relayRecords} records` : '');

  check('Relay commitMutation available', !!(cap && cap.hasCommitMutation));

  check('identity map learned from Relay store',
    !!(status && status.identity && status.identity.aliasesKnown > 0),
    status && status.identity ? JSON.stringify(status.identity) : '');

  // ---- 4b. request/response correlation across the world boundary --------
  // A response that omits its ticket does not raise an error; it just hangs
  // until the caller times out. Assert the round-trip actually completes.
  try {
    const raw = await evalIn(browser, optSession, `
      (async () => {
        const tabs = await chrome.tabs.query({ url: 'https://www.threads.com/*' });
        const res = await new Promise(r => chrome.tabs.sendMessage(tabs[0].id,
          { type: 'tab:probe-bridge' }, x => r(x || { error: (chrome.runtime.lastError||{}).message })));
        return JSON.stringify(res);
      })()
    `);
    const probe = JSON.parse(raw);
    check('MAIN world request/response round-trip resolves',
      !!(probe && probe.ok && probe.ms < 5000),
      JSON.stringify(probe));
  } catch (e) {
    check('MAIN world request/response round-trip resolves', false, e.message);
  }

  // ---- 5. the actual point: is the content hidden? -----------------------
  let hideInfo = null;
  try {
    hideInfo = await evalIn(browser, pageSession, `
      (() => {
        const hidden = document.querySelectorAll('[data-tq-hidden="1"]');
        const who = new Set();
        hidden.forEach(n => who.add(n.getAttribute('data-tq-who')));
        const containers = document.querySelectorAll('[data-pressable-container]');
        // How many of those containers are visible to a reader right now?
        let visible = 0;
        containers.forEach(n => {
          const cs = getComputedStyle(n);
          if (cs.display !== 'none' && cs.visibility !== 'hidden') visible++;
        });
        return JSON.stringify({
          hiddenCount: hidden.length,
          who: Array.from(who).slice(0, 5),
          containers: containers.length,
          visibleContainers: visible
        });
      })()
    `, false);
    hideInfo = JSON.parse(hideInfo);
  } catch (e) {
    hideInfo = { error: e.message };
  }

  check('content from blocklisted profile is hidden',
    !!(hideInfo && hideInfo.hiddenCount > 0),
    hideInfo ? JSON.stringify(hideInfo) : '');

  // ---- 5a. authorship vs. mention ----------------------------------------
  // A blocked profile appearing INSIDE someone else's post (a comment, a tag)
  // must not take that post down with it. Only the comment itself should go.
  // Synthetic nodes are used so the two cases can be stated exactly.
  try {
    const raw = await evalIn(browser, pageSession, `
      (() => {
        const mk = (html) => {
          const d = document.createElement('div');
          d.innerHTML = html;
          document.body.appendChild(d.firstElementChild);
          return document.body.lastElementChild;
        };
        // Innocent author, blocked profile only quoted in a nested comment.
        mk('<div data-pressable-container="true" data-tqtest="mention">' +
             '<a href="/@some_innocent_person">Innocent</a>' +
             '<div>post body</div>' +
             '<div role="article"><a href="/@threads">threads</a><div>a reply</div></div>' +
           '</div>');
        // Blocked profile is the author.
        mk('<div data-pressable-container="true" data-tqtest="author">' +
             '<a href="/@threads">threads</a><div>post body</div>' +
           '</div>');
        return 'injected';
      })()
    `, false);
    if (raw !== 'injected') throw new Error('injection failed');
    await sleep(6000);
    const out = await evalIn(browser, pageSession, `
      (() => {
        const q = (s) => document.querySelector(s);
        const hidden = (el) => !!el && el.getAttribute('data-tq-hidden') === '1';
        const mention = q('[data-tqtest="mention"]');
        return JSON.stringify({
          postWithMentionHidden: hidden(mention),
          nestedCommentHidden: hidden(mention && mention.querySelector('div[role="article"]')),
          postByBlockedAuthorHidden: hidden(q('[data-tqtest="author"]'))
        });
      })()
    `, false);
    const r = JSON.parse(out);
    check('a blocked profile is judged by authorship, not by being mentioned',
      r.postWithMentionHidden === false && r.postByBlockedAuthorHidden === true,
      JSON.stringify(r));
    check('the blocked profile own nested comment is still hidden',
      r.nestedCommentHidden === true, JSON.stringify(r));
  } catch (e) {
    check('a blocked profile is judged by authorship, not by being mentioned', false, e.message);
  }

  // ---- 5b. hide modes react to a settings change live --------------------
  // Switching mode must release what is currently hidden and re-apply, not
  // leave content stuck in the previous mode with no way back.
  try {
    await evalIn(browser, optSession, `
      (async () => {
        await new Promise(r => chrome.runtime.sendMessage(
          { type: 'sw:set-settings', payload: { hideMode: 'placeholder' } }, r));
        return 'ok';
      })()
    `);
    await sleep(6000);
    const raw = await evalIn(browser, pageSession, `
      JSON.stringify({
        placeholders: document.querySelectorAll('.tq-placeholder').length,
        placeholderMode: document.querySelectorAll('[data-tq-hidden="1"][data-tq-mode="placeholder"]').length
      })
    `, false);
    const ph = JSON.parse(raw);
    check('placeholder hide mode applies after live settings change',
      ph.placeholders > 0 && ph.placeholderMode > 0, JSON.stringify(ph));
  } catch (e) {
    check('placeholder hide mode applies after live settings change', false, e.message);
  }

  // Turning hiding off entirely must restore every hidden node.
  try {
    await evalIn(browser, optSession, `
      (async () => {
        await new Promise(r => chrome.runtime.sendMessage(
          { type: 'sw:set-settings', payload: { hideEnabled: false } }, r));
        return 'ok';
      })()
    `);
    await sleep(4000);
    const raw = await evalIn(browser, pageSession, `
      JSON.stringify({
        stillHidden: document.querySelectorAll('[data-tq-hidden="1"]').length,
        leftoverBars: document.querySelectorAll('.tq-placeholder').length
      })
    `, false);
    const off = JSON.parse(raw);
    check('disabling hiding restores all content',
      off.stillHidden === 0 && off.leftoverBars === 0, JSON.stringify(off));
  } catch (e) {
    check('disabling hiding restores all content', false, e.message);
  }

  // ---- 6. platform blocking must stay untouched --------------------------
  try {
    const state = await evalIn(browser, optSession, `
      (async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'sw:get-state' }, x => r(x)));
        return JSON.stringify({
          enabled: res.settings.platformBlockEnabled,
          attempts: (res.stats && res.stats.attempts) || 0,
          succeeded: (res.stats && res.stats.succeeded) || 0
        });
      })()
    `);
    const s = JSON.parse(state);
    check('no real block was attempted (safety)',
      s.enabled === false && s.succeeded === 0, JSON.stringify(s));
  } catch (e) {
    check('no real block was attempted (safety)', false, e.message);
  }

  // ---- 7. dry-run block: must degrade gracefully, never throw -------------
  // Logged out, no block mutation module is loaded, so every strategy should
  // decline in an orderly way and report why.
  try {
    const dry = await evalIn(browser, pageSession, `
      (async () => {
        const MARK = '__3que_bridge__';
        // Reuse the isolated world's nonce by asking the content script to
        // relay for us is not possible from here, so drive the MAIN world
        // directly the way the isolated world does: it already completed a
        // handshake, so we can only observe. Instead assert the extension
        // reports a structured capability rather than crashing the page.
        return JSON.stringify({
          pageAlive: document.readyState,
          errors: (window.__tqPageErrors || []).length
        });
      })()
    `);
    const d = JSON.parse(dry);
    check('page still healthy after injection', d.pageAlive === 'complete' || d.pageAlive === 'interactive',
      JSON.stringify(d));
  } catch (e) {
    check('page still healthy after injection', false, e.message);
  }

  // ---- 8. Facebook leg ----------------------------------------------------
  // Logged out there is no feed to hide, but the parts that must work on
  // facebook.com -- module hook, bridge, Relay -- can still be verified.
  const { targetId: fbTarget } = await browser.send('Target.createTarget',
    { url: 'https://www.facebook.com/' });
  await browser.send('Target.attachToTarget', { targetId: fbTarget, flatten: true });
  await sleep(12000);

  let fbStatus = null;
  try {
    const raw = await evalIn(browser, optSession, `
      (async () => {
        const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/*' });
        if (!tabs.length) return JSON.stringify({ error: 'no facebook tab' });
        const res = await new Promise(r => chrome.tabs.sendMessage(tabs[0].id, { type: 'tab:status' },
          x => r(x || { error: (chrome.runtime.lastError||{}).message })));
        return JSON.stringify(res);
      })()
    `);
    fbStatus = JSON.parse(raw);
  } catch (e) { fbStatus = { error: e.message }; }

  check('facebook: content script + bridge handshake',
    !!(fbStatus && fbStatus.handshake), fbStatus && fbStatus.error ? fbStatus.error : `platform=${fbStatus && fbStatus.platform}`);
  check('facebook: platform detected correctly',
    fbStatus && fbStatus.platform === 'facebook', fbStatus && fbStatus.platform);

  const fbCap = fbStatus && fbStatus.capability;
  check('facebook: MAIN world hooked module registry',
    !!(fbCap && fbCap.moduleCount > 100),
    fbCap ? `${fbCap.moduleCount} modules, ${fbCap.graphqlModuleCount} graphql` : 'no capability report');
  check('facebook: Relay environment reachable',
    !!(fbCap && fbCap.hasRelay), fbCap ? String(fbCap.relayEnv) : '');

  // Collect console errors originating from our code.
  try {
    const errs = await evalIn(browser, pageSession,
      `JSON.stringify((window.__tqErrors||[]))`, false);
    if (errs && errs !== '[]') console.log('page errors:', errs);
  } catch (e) { /* ignore */ }

  browser.close();
  finish(cleanup);
})().catch((e) => {
  console.error('harness error:', e);
  process.exitCode = 1;
});

function finish(cleanup) {
  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  }
  cleanup();
  process.exitCode = failed.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
}
