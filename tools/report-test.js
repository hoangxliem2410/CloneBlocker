/**
 * End-to-end test of clone reporting.
 *
 *   node tools/report-test.js [--headful]
 *
 * Runs the real server, loads the extension into a clean Chrome, opens a live
 * Threads page, and drives the in-page report affordance the way a person
 * would -- hover a profile link, click the chip, fill the sheet, submit -- then
 * checks the report actually landed on the server and that approving it reaches
 * the blocklist.
 *
 * Uses its own ports so it cannot collide with a hands-on dev session.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HEADFUL = process.argv.includes('--headful');
const SRV_PORT = 8803;
const CDP_PORT = 9351;
const USER = 'reportadmin';
const PASS = 'reportpass-3311';
const BASIC = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const ROOT = path.join(__dirname, '..');
const BASE = `http://localhost:${SRV_PORT}`;
const TEST_URL = 'https://www.threads.com/@threads';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

class CDP {
  constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
    this.ready=new Promise((res,rej)=>{this.ws.addEventListener('open',res);
      this.ws.addEventListener('error',()=>rej(new Error('cdp socket')));});
    this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
      if(m.id&&this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);
        m.error?q.rej(new Error(m.error.message)):q.res(m.result);}});}
  send(me,pa,s){const i=++this.id;const o={id:i,method:me,params:pa||{}};if(s)o.sessionId=s;
    return new Promise((res,rej)=>{this.p.set(i,{res,rej});this.ws.send(JSON.stringify(o));
      setTimeout(()=>{if(this.p.has(i)){this.p.delete(i);rej(new Error('t/o '+me))}},45000)})}
}

async function ev(c, s, expr, awaitPromise) {
  const r = await c.send('Runtime.evaluate',
    { expression: expr, returnByValue: true, userGesture: true, awaitPromise: awaitPromise !== false }, s);
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                    r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}


/**
 * Hover a profile link and return the chip's state.
 *
 * CDP's synthetic mouseMoved does not produce a mouseover that reaches a
 * content-script listener in headless, so this falls back to dispatching a real
 * MouseEvent. That is a limitation of driving the browser, not of the feature:
 * an actual pointer produces the event normally.
 */
async function hoverProfile(cdp, page) {
  await ev(cdp, page, `
    (() => {
      var as = document.querySelectorAll('a[href^="/@"]');
      for (var i = 0; i < as.length; i++) {
        var b = as[i].getBoundingClientRect();
        if (b.width > 8 && b.top > 120 && b.bottom < window.innerHeight - 40) {
          as[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
          return 1;
        }
      }
      return 0;
    })()`, false);
  await sleep(2500);
  return ev(cdp, page, `
    (() => {
      var h = document.querySelector('[data-3que-ui]');
      var c = h && h.shadowRoot && h.shadowRoot.querySelector('.chip');
      return c ? JSON.stringify({ text: c.textContent.trim(), cls: c.className }) : null;
    })()`, false);
}

function buildExt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-rep-ext-'));
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else {
        const dst = path.join(dir, child);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(ROOT, child), dst);
      }
    }
  };
  walk('src'); walk('icons');
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  m.host_permissions = m.host_permissions.concat([`http://localhost:${SRV_PORT}/*`]);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

function findChrome() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome'
  ]) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found');
}

(async () => {
  const extDir = buildExt();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-rep-prof-'));
  const srvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-rep-srv-'));
  fs.copyFileSync(path.join(ROOT, 'server', 'server.js'), path.join(srvDir, 'server.js'));
  const pubSrc = path.join(ROOT, 'server', 'public');
  fs.mkdirSync(path.join(srvDir, 'public'), { recursive: true });
  for (const f of fs.readdirSync(pubSrc)) {
    fs.copyFileSync(path.join(pubSrc, f), path.join(srvDir, 'public', f));
  }
  fs.writeFileSync(path.join(srvDir, 'blocklist.json'),
    JSON.stringify({ ids: [], usernames: [], docIdOverrides: {} }, null, 2));

  const srv = spawn(process.execPath,
    [path.join(srvDir, 'server.js'), '--port', String(SRV_PORT), '--user', USER, '--pass', PASS],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => console.error('[server]', String(d).trim()));
  await sleep(900);

  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'
  ];
  if (!HEADFUL) chromeArgs.splice(3, 0, '--headless=new');
  const chrome = spawn(findChrome(), chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});

  const cleanup = () => {
    try { chrome.kill(); } catch (e) {}
    try { srv.kill(); } catch (e) {}
    for (const d of [extDir, profile, srvDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  };
  process.on('exit', cleanup);

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); break; }
    catch (e) { await sleep(500); }
  }
  if (!version) { check('chrome started', false); return finish(cleanup); }

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  const extId = loaded && loaded.id;
  check('extension loaded', !!extId, extId || '');

  // Configure through the options page (wakes the worker, grants host access).
  const { targetId: optTarget } = await cdp.send('Target.createTarget',
    { url: `chrome-extension://${extId}/src/options/options.html` });
  const { sessionId: opt } = await cdp.send('Target.attachToTarget', { targetId: optTarget, flatten: true });
  await cdp.send('Runtime.enable', {}, opt);
  await sleep(1500);

  await ev(cdp, opt, `
    (async () => {
      // No permissions.request here: the test build already declares the local
      // server in host_permissions, and the optional-permission prompt does not
      // resolve in headless.
      await chrome.storage.sync.set({ settings: {
        listUrl: '${BASE}/blocklist.json',
        reportUiEnabled: true, reportHoverDelayMs: 0,
        hideEnabled: false, platformBlockEnabled: false, platformBlockDryRun: true,
        debug: true
      }});
      return 1;
    })()`);

  // -- open Threads and drive the in-page affordance -----------------------
  const { targetId: pageTarget } = await cdp.send('Target.createTarget', { url: TEST_URL });
  const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId: pageTarget, flatten: true });
  await cdp.send('Runtime.enable', {}, page);
  await cdp.send('Page.enable', {}, page);
  await cdp.send('Network.enable', {}, page);
  // Headless defaults to a short viewport; profile links end up below the fold
  // and a synthetic hover at their coordinates would land on nothing.
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false }, page);
  await sleep(13000);

  // First: the popup entry point. It is deterministic (no synthetic pointer
  // events involved), so if the sheet fails to open here the fault is in the
  // report module rather than in event simulation.
  const viaPopup = await ev(cdp, opt, `
    (async () => {
      const tabs = await chrome.tabs.query({ url: ['https://*.threads.com/*'] });
      if (!tabs.length) return JSON.stringify({ error: 'no tab' });
      const res = await new Promise(r => chrome.tabs.sendMessage(tabs[0].id,
        { type: 'tab:report-current' },
        x => r(x || { error: (chrome.runtime.lastError||{}).message })));
      return JSON.stringify(res);
    })()`);
  check('the popup entry point opens the report sheet',
    viaPopup && JSON.parse(viaPopup).ok === true, viaPopup || '');
  await sleep(1200);

  const popupSheet = await ev(cdp, page, `
    (() => {
      var h = document.querySelector('[data-3que-ui]');
      if (!h || !h.shadowRoot) return null;
      var s = h.shadowRoot.querySelector('.sheet');
      return s ? h.shadowRoot.querySelector('.who .m').textContent.trim() : null;
    })()`, false);
  check('report UI host is injected on demand', !!popupSheet, popupSheet || 'no sheet');

  // Nobody is signed in yet, so the sheet must say so rather than let someone
  // write out a case and lose it to a refusal on submit.
  const signedOut = await ev(cdp, page, `
    (() => {
      var r = document.querySelector('[data-3que-ui]').shadowRoot;
      var err = r.querySelector('.err'), sub = r.querySelector('.submit');
      return JSON.stringify({ disabled: !!(sub && sub.disabled),
                              msg: (err && !err.hidden) ? err.textContent.trim() : null });
    })()`, false);
  const so = JSON.parse(signedOut || '{}');
  check('a signed-out viewer is told to sign in before reporting',
    so.disabled === true && /Sign in to Threads/.test(so.msg || ''), signedOut || '');

  // Give the browser the cookie a signed-in viewer would have. This is the same
  // value the MAIN world reads for viewerId, so the whole chain -- page cookie,
  // bridge, sheet, service worker, server -- runs exactly as it does in life,
  // without needing real credentials in a test.
  await cdp.send('Network.setCookie', {
    name: 'ds_user_id', value: '55501234567', domain: '.threads.com', path: '/'
  }, page);
  await cdp.send('Page.reload', {}, page);
  await sleep(13000);

  // Close it again before testing the hover path.
  await ev(cdp, page, `
    (() => { var h = document.querySelector('[data-3que-ui]');
             var b = h && h.shadowRoot && h.shadowRoot.querySelector('.cancel');
             if (b) b.click(); return 1; })()`, false);
  await sleep(600);

  // Now the hover affordance. Pick a link in the body, not the top nav.
  const anchor = await ev(cdp, page, `
    (() => {
      var as = document.querySelectorAll('a[href^="/@"], a[href*="threads.com/@"]');
      for (var i = 0; i < as.length; i++) {
        var b = as[i].getBoundingClientRect();
        if (b.width > 8 && b.height > 8 && b.top > 120 && b.bottom < window.innerHeight - 40) {
          return JSON.stringify({ x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2),
                                  href: as[i].getAttribute('href') });
        }
      }
      return null;
    })()`, false);
  check('found a profile link to hover', !!anchor, anchor || 'none');
  if (!anchor) return finish(cleanup);

  const a = JSON.parse(anchor);
  // Move somewhere neutral first: pointerover only fires on a change of target.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 400 }, page);
  await sleep(200);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y }, page);
  await sleep(1800);

  let chipState = await ev(cdp, page, `
    (() => {
      var h = document.querySelector('[data-3que-ui]');
      if (!h || !h.shadowRoot) return JSON.stringify({ host: false });
      var c = h.shadowRoot.querySelector('.chip');
      return JSON.stringify({ host: true, chip: !!c,
        cls: c ? c.className : null, kids: h.shadowRoot.children.length });
    })()`, false);
  console.log('  after synthetic hover: ' + chipState);

  if (!JSON.parse(chipState).chip) {
    // Fall back to a real DOM event. If this works, the handler is fine and it
    // was the synthetic input that never reached hit-testing.
    await ev(cdp, page, `
      (() => {
        var as = document.querySelectorAll('a[href^="/@"]');
        for (var i = 0; i < as.length; i++) {
          var b = as[i].getBoundingClientRect();
          if (b.width > 8 && b.top > 120 && b.bottom < window.innerHeight - 40) {
            as[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
            return 1;
          }
        }
        return 0;
      })()`, false);
    await sleep(1500);
    chipState = await ev(cdp, page, `
      (() => {
        var h = document.querySelector('[data-3que-ui]');
        var c = h && h.shadowRoot && h.shadowRoot.querySelector('.chip');
        return JSON.stringify({ chip: !!c, cls: c ? c.className : null });
      })()`, false);
    console.log('  after dispatched event: ' + chipState);
  }

  // Open the sheet by clicking the chip inside the shadow root.
  await ev(cdp, page, `
    (() => { document.querySelector('[data-3que-ui]').shadowRoot
               .querySelector('.chip').click(); return 1; })()`, false);
  await sleep(1200);

  const sheet = await ev(cdp, page, `
    (() => {
      var r = document.querySelector('[data-3que-ui]').shadowRoot;
      var s = r.querySelector('.sheet');
      if (!s) return null;
      return JSON.stringify({ title: r.querySelector('.hd').textContent.trim(),
                              who: r.querySelector('.who .n').textContent.trim(),
                              meta: r.querySelector('.who .m').textContent.trim(),
                              reasons: r.querySelectorAll('#reason option').length });
    })()`, false);
  check('the report sheet opens with the profile identified',
    !!sheet && JSON.parse(sheet).reasons === 6, sheet || 'no sheet');

  // Fill and submit.
  await ev(cdp, page, `
    (() => {
      var r = document.querySelector('[data-3que-ui]').shadowRoot;
      r.querySelector('#reason').value = 'impersonation';
      r.querySelector('#note').value = 'automated test report';
      r.querySelector('.submit').click();
      return 1;
    })()`, false);
  await sleep(4000);

  const outcome = await ev(cdp, page, `
    (() => {
      var r = document.querySelector('[data-3que-ui]').shadowRoot;
      var ok = r.querySelector('.ok'), err = r.querySelector('.err');
      return JSON.stringify({ ok: ok ? ok.textContent.trim() : null,
                              err: (err && !err.hidden) ? err.textContent.trim() : null });
    })()`, false);
  const o = JSON.parse(outcome || '{}');
  check('submitting the report succeeds in the page', !!o.ok && !o.err, outcome);

  // -- server side ---------------------------------------------------------
  const queue = await (await fetch(`${BASE}/admin/reports?status=pending`,
    { headers: { authorization: BASIC } })).json();
  check('the report reached the server',
    queue.ok && queue.count === 1, JSON.stringify(queue.reports && queue.reports[0] &&
      { key: queue.reports[0].key, reason: queue.reports[0].reason, notes: queue.reports[0].notes.length }));

  const rec = queue.reports && queue.reports[0];
  check('the report carries the reason and note from the sheet',
    rec && rec.reason === 'impersonation' &&
    rec.notes.some(n => /automated test report/.test(n.text)),
    rec ? rec.reason : '');

  // -- approve via the admin path the review page uses ---------------------
  const decide = await (await fetch(`${BASE}/admin/reports/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: BASIC },
    body: JSON.stringify({ key: rec.key, decision: 'approve', by: 'test' })
  })).json();
  const listNow = await (await fetch(`${BASE}/blocklist.json`)).json();
  const onList = (listNow.ids || []).length + (listNow.usernames || []).length > 0;
  check('approving puts the reported account on the blocklist',
    decide.ok && onList, JSON.stringify({ ids: listNow.ids, usernames: listNow.usernames }));

  // -- the chip should now reflect that state ------------------------------
  await cdp.send('Page.reload', {}, page);
  await sleep(13000);
  const chip2 = await hoverProfile(cdp, page);
  check('the chip reflects the account’s new state',
    !!chip2 && /blocked|reported/i.test(JSON.parse(chip2).cls), chip2 || 'no chip');

  finish(cleanup);
})().catch(e => { console.error('harness error:', e); process.exitCode = 1; });

function finish(cleanup) {
  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    failed.forEach(f => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  if (cleanup) cleanup();
  process.exitCode = failed.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
}
