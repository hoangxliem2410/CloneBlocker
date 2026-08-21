/**
 * Renders every image the Chrome Web Store listing needs.
 *
 *   node tools/make-store-assets.js [--port 9360] [--keep]
 *
 * The promo tiles are laid out in HTML and screenshotted at their exact pixel
 * size, rather than drawn with distance fields like the icons. Tiles need real
 * type, and shipping a font rasteriser to set four words would be silly.
 *
 * The listing screenshots embed genuine captures of the extension's own pages,
 * taken from a real Chrome with the extension loaded -- the store asks for
 * actual user experience, and a mocked-up UI is both against the spirit of
 * that and the sort of thing reviewers notice. Nothing here shows a real
 * account or a real feed.
 *
 * Writes into store/:
 *   icon128.png                 (via tools/make-icons.js)
 *   small-promo-440x280.png     required
 *   marquee-1400x560.png        optional, needed to be eligible for featuring
 *   screenshot-1..4-1280x800.png
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CDP_PORT = parseInt(argOf('port', '9360'), 10);
const KEEP = args.includes('--keep');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'store');
const PROFILE = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'store-assets-profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome'
  ].filter(Boolean)) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found');
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', () => rej(new Error('CDP socket error')));
    });
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) {
        const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
  }
  send(method, params, sessionId, ms = 30000) {
    const i = ++this.id;
    const payload = { id: i, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pend.set(i, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, ms);
    });
  }
}

/** Open a target, size it exactly, screenshot it, close it. */
async function shoot(cdp, url, width, height, file, settleMs, prep) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  // deviceScaleFactor 1: the store wants exact pixels, not a 2x image that
  // happens to be the right aspect ratio.
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  // A scrollbar sliced down the edge of a listing image just reads as a bad
  // crop, so it goes -- the content it scrolls is unaffected.
  try { await cdp.send('Emulation.setScrollbarsHidden', { hidden: true }, sessionId); } catch (e) {}
  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(settleMs || 900);
  // prep may return a y offset to capture from. The clip is in document
  // coordinates, not viewport coordinates -- scrolling the page and then
  // clipping at y=0 captures the (now unpainted) top of the document and
  // yields a black rectangle. Move the clip instead of the page.
  let top = 0;
  if (prep) {
    await cdp.send('Runtime.enable', {}, sessionId);
    const pr = await cdp.send('Runtime.evaluate',
      { expression: prep, awaitPromise: true, returnByValue: true }, sessionId, 20000);
    if (typeof pr.result.value === 'number') top = pr.result.value;
    await sleep(700);
  }
  const r = await cdp.send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: top > 0,
      clip: { x: 0, y: top, width, height, scale: 1 } },
    sessionId);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  console.log('  wrote', path.relative(ROOT, file), `(${width}x${height})`,
    fs.statSync(file).size + ' bytes');
}

const dataUrl = html => 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
const pngUri = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');

// -- shared page furniture -------------------------------------------------

const FONT = `-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

const BASE = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT};
    -webkit-font-smoothing: antialiased;
    background: #12162b;
    color: #f4f6fc;
    overflow: hidden;
  }
  .field {
    position: absolute; inset: 0;
    background:
      radial-gradient(120% 120% at 12% 0%, #2b3566 0%, #1a2044 42%, #12162b 100%);
  }
  /* A faint crowd of impersonators behind everything, which is the problem
     the extension exists for. Kept very low contrast so it reads as texture
     and never competes with the mark. */
  .crowd { position: absolute; inset: 0; opacity: .07; }
  .crowd i {
    position: absolute; display: block; border-radius: 999px;
    background: #aab6e8;
  }
`;

/**
 * A row of ghost head-and-shoulders glyphs, as decorative texture.
 *
 * The shoulders are centred under the head with a flat bottom edge -- an
 * off-centre capsule floating below a circle reads as two unrelated blobs
 * rather than as a person, which is worse than no texture at all.
 */
function crowd(count, size, top, gap, left) {
  let out = '';
  const head = size * 0.46;
  const bw = size * 0.80, bh = size * 0.40;
  for (let i = 0; i < count; i++) {
    const x = left + i * gap;
    out += `<i style="left:${x}px;top:${top}px;width:${head}px;height:${head}px"></i>`;
    out += `<i style="left:${x - (bw - head) / 2}px;top:${top + head * 1.16}px;` +
           `width:${bw}px;height:${bh}px;border-radius:${bw / 2}px ${bw / 2}px 0 0"></i>`;
  }
  return out;
}

// -- promo tiles -----------------------------------------------------------

function tileHtml(w, h, opts) {
  const icon = pngUri(path.join(ROOT, 'icons', 'icon128.png'));
  const big = opts.iconSize;
  return `<!doctype html><meta charset="utf-8"><style>${BASE}
    .wrap {
      position: absolute; inset: 0; display: flex; align-items: center;
      gap: ${opts.gap}px; padding: 0 ${opts.pad}px;
    }
    .mark {
      width: ${big}px; height: ${big}px; flex: none; border-radius: ${big * 0.235}px;
      background: url('${icon}') center/cover no-repeat;
      box-shadow: 0 ${big * 0.09}px ${big * 0.28}px rgba(6, 9, 24, .55);
    }
    .name { font-size: ${opts.title}px; font-weight: 700; letter-spacing: -.022em; line-height: 1.04; }
    .tag  { margin-top: ${opts.tagGap}px; font-size: ${opts.tag}px; font-weight: 500;
            line-height: 1.28; color: #b9c4ee; max-width: ${opts.tagWidth}px; }
    .rule { margin-top: ${opts.tagGap}px; width: ${opts.title * 1.6}px; height: 3px;
            border-radius: 2px; background: linear-gradient(90deg, #ff5e5b, #ff5e5b 55%, transparent); }
  </style>
  <div class="field"></div>
  <div class="crowd">${opts.crowd}</div>
  <div class="wrap">
    <div class="mark"></div>
    <div>
      <div class="name">3Que Blocker</div>
      <div class="rule"></div>
      <div class="tag">${opts.tagline}</div>
    </div>
  </div>`;
}

// -- listing screenshots ---------------------------------------------------

/**
 * One caption band, one real capture. The capture is inset on a tinted field
 * rather than bled to the edges so the 1280x800 frame is filled without
 * upscaling a smaller page into blur.
 */
function shotHtml(opts) {
  const shot = pngUri(opts.image);
  return `<!doctype html><meta charset="utf-8"><style>${BASE}
    .page { position: absolute; inset: 0; display: flex; flex-direction: column;
            padding: 54px 64px 0; }
    h1 { margin: 0; font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -.024em; }
    h1 em { font-style: normal; color: #ff8a86; }
    p  { margin: 14px 0 0; font-size: 21px; line-height: 1.42; font-weight: 450;
         color: #b9c4ee; max-width: 830px; }
    .stage { flex: 1; margin-top: 34px; position: relative; }
    .frame {
      position: absolute; left: 50%; transform: translateX(-50%); top: 0;
      width: ${opts.frameWidth}px; border-radius: 14px 14px 0 0; overflow: hidden;
      background: #0e1223;
      box-shadow: 0 -1px 0 rgba(255,255,255,.07) inset, 0 26px 70px rgba(4, 7, 20, .6);
      border: 1px solid rgba(150,168,235,.16); border-bottom: 0;
    }
    .frame img { display: block; width: 100%; }
  </style>
  <div class="field"></div>
  <div class="crowd">${crowd(12, 118, 690, 112, -8)}</div>
  <div class="page">
    <h1>${opts.title}</h1>
    <p>${opts.body}</p>
    <div class="stage">
      <div class="frame"><img src="${shot}"></div>
    </div>
  </div>`;
}

/**
 * The one screenshot that is drawn rather than captured.
 *
 * The popup would be the obvious second image, but on a page where the site
 * has not yet loaded its own block module the popup honestly reports that --
 * a red capability notice, permanent until the user opens a profile menu. The
 * choice was to misconfigure the extension for a prettier picture or to
 * explain the actual model instead. This explains the model.
 */
function layersHtml() {
  const card = (kick, title, lines, accent) => `
    <div class="card">
      <div class="kick" style="color:${accent}">${kick}</div>
      <div class="ct">${title}</div>
      <ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>
    </div>`;
  return `<!doctype html><meta charset="utf-8"><style>${BASE}
    .page { position: absolute; inset: 0; padding: 62px 64px; display: flex; flex-direction: column; }
    h1 { margin: 0; font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -.024em; }
    h1 em { font-style: normal; color: #ff8a86; }
    .sub { margin: 15px 0 0; font-size: 21px; line-height: 1.42; color: #b9c4ee; max-width: 900px; }
    .cards { display: flex; gap: 26px; margin-top: 44px; }
    .card { flex: 1; padding: 32px 34px 30px; border-radius: 18px;
            background: rgba(150,168,235,.07); border: 1px solid rgba(150,168,235,.19); }
    .kick { font-size: 15px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .ct { margin-top: 12px; font-size: 30px; font-weight: 700; letter-spacing: -.018em; }
    ul { margin: 20px 0 0; padding: 0; list-style: none; }
    li { font-size: 19px; line-height: 1.5; color: #cdd6f6; padding-left: 26px; position: relative; margin-top: 12px; }
    li::before { content: ""; position: absolute; left: 4px; top: 11px; width: 8px; height: 8px;
                 border-radius: 999px; background: #7f8cc4; }
    .foot { margin-top: auto; font-size: 20px; line-height: 1.45; color: #b9c4ee;
            border-left: 3px solid #ff5e5b; padding-left: 20px; max-width: 1000px; }
  </style>
  <div class="field"></div>
  <div class="crowd">${crowd(12, 118, 700, 112, -8)}</div>
  <div class="page">
    <h1>Two layers, because they cost <em>different things</em></h1>
    <p class="sub">A list of thousands cannot be blocked by one account &mdash; that is exactly what
       gets an account checkpointed. So the two halves are treated differently.</p>
    <div class="cards">
      ${card('Layer 1 &middot; free', 'Hide them', [
        'Covers the entire list',
        'Profiles, comments and feed posts',
        'Costs your account nothing',
        'No limit, runs on every page load'
      ], '#8ee6a8')}
      ${card('Layer 2 &middot; costly', 'Block them', [
        'Only a ranked, budgeted slice',
        'Ordered by how active and how near',
        'Separate hourly ceiling you set',
        'Nothing blocked without your approval'
      ], '#ff8a86')}
    </div>
    <p class="foot">Blocking someone whose profile is on your screen is ordinary.
       Grinding through strangers is not &mdash; so the budget is spent on what you actually see, first.</p>
  </div>`;
}

/** The lead screenshot: no UI, just the claim. */
function heroHtml() {
  const icon = pngUri(path.join(ROOT, 'icons', 'icon128.png'));
  return `<!doctype html><meta charset="utf-8"><style>${BASE}
    .page { position: absolute; inset: 0; display: flex; flex-direction: column;
            align-items: center; justify-content: center; text-align: center; padding: 0 90px; }
    .mark { width: 132px; height: 132px; border-radius: 31px;
            background: url('${icon}') center/cover no-repeat;
            box-shadow: 0 14px 44px rgba(6, 9, 24, .6); }
    h1 { margin: 34px 0 0; font-size: 62px; line-height: 1.06; font-weight: 700; letter-spacing: -.03em; }
    h1 em { font-style: normal; color: #ff8a86; }
    p { margin: 20px 0 0; font-size: 24px; line-height: 1.45; color: #b9c4ee; max-width: 800px; }
    .pills { display: flex; gap: 12px; margin-top: 40px; flex-wrap: wrap; justify-content: center; }
    .pill { font-size: 17px; font-weight: 600; padding: 11px 20px; border-radius: 999px;
            background: rgba(150,168,235,.11); border: 1px solid rgba(150,168,235,.22);
            color: #d5ddf8; }
  </style>
  <div class="field"></div>
  <div class="crowd">${crowd(13, 132, 636, 108, -12)}</div>
  <div class="page">
    <div class="mark"></div>
    <h1>Someone is pretending<br>to be <em>you</em>.</h1>
    <p>3Que Blocker hides every impersonator on your list the moment a page loads &mdash;
       and blocks the ones that are actually active near you.</p>
    <div class="pills">
      <span class="pill">Facebook &amp; Threads</span>
      <span class="pill">Hides instantly</span>
      <span class="pill">Blocks at a safe pace</span>
      <span class="pill">Your own server</span>
    </div>
  </div>`;
}

// -- main ------------------------------------------------------------------

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Icons first: the tiles embed icon128.png, so a stale icon would silently
  // propagate into every promotional asset.
  require('child_process').execSync(`"${process.execPath}" "${path.join(__dirname, 'make-icons.js')}"`,
    { stdio: 'inherit' });

  // Real captures of the extension's own pages, from a browser that has it
  // loaded. Falls back to the long-lived dev session if one is already up.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-shots-'));
  const uiShots = await captureExtensionPages(tmp);

  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); break; }
    catch (e) { await sleep(400); }
  }
  if (!version) { console.error('renderer did not start'); process.exit(1); }
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  try {
    console.log('\npromotional tiles');
    await shoot(cdp, dataUrl(tileHtml(440, 280, {
      iconSize: 96, gap: 26, pad: 34, title: 34, tag: 15, tagGap: 12, tagWidth: 230,
      tagline: 'Impersonator accounts, hidden on sight.',
      crowd: crowd(7, 74, 196, 68, 14)
    })), 440, 280, path.join(OUT, 'small-promo-440x280.png'));

    await shoot(cdp, dataUrl(tileHtml(1400, 560, {
      iconSize: 224, gap: 76, pad: 110, title: 92, tag: 32, tagGap: 26, tagWidth: 720,
      tagline: 'Hide every clone of your profile on Facebook and Threads &mdash; and block the ones that matter, at a pace that keeps your account safe.',
      crowd: crowd(12, 150, 392, 124, 30)
    })), 1400, 560, path.join(OUT, 'marquee-1400x560.png'));

    console.log('\nlisting screenshots');
    await shoot(cdp, dataUrl(heroHtml()), 1280, 800,
      path.join(OUT, 'screenshot-1-1280x800.png'));

    await shoot(cdp, dataUrl(layersHtml()), 1280, 800,
      path.join(OUT, 'screenshot-2-1280x800.png'));

    const shots = [
      { image: uiShots.options, frameWidth: 880,
        title: 'Every limit is <em>yours</em> to set',
        body: 'How fast blocks go out, how many unseen accounts may be blocked in an hour, whether to share a coarse region at all. The cautious defaults are the ones it ships with.' },
      { image: path.join(ROOT, 'docs', 'shots', 'dashboard.png'), frameWidth: 980,
        title: 'You run the server. <em>You</em> decide the list.',
        body: 'Reports land in your own moderation dashboard, ranked by reporter reputation and by where the clone is active right now. Nothing reaches the blocklist until you approve it.' }
    ];
    let n = 3;
    for (const s of shots) {
      if (!s.image || !fs.existsSync(s.image)) {
        console.log('  skipped, no capture for:', s.title.replace(/<[^>]+>/g, ''));
        continue;
      }
      await shoot(cdp, dataUrl(shotHtml(s)), 1280, 800,
        path.join(OUT, `screenshot-${n}-1280x800.png`));
      n++;
    }
  } finally {
    if (!KEEP) { try { chrome.kill(); } catch (e) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\nstore assets in', path.relative(ROOT, OUT) + path.sep);
  process.exit(0);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });

/**
 * Screenshots the popup and options pages from a browser with the extension
 * loaded. Prefers the running dev session, because loading an unpacked
 * extension needs a non-headless Chrome and there is usually one up already.
 */
async function captureExtensionPages(dir) {
  // Both go to a temp dir that is deleted at the end. The popup in particular
  // must never land in the repo: its Page capability panel prints "Signed in
  // as <numeric account id>", so a committed copy would publish the real
  // account of whoever ran this.
  const out = { popup: path.join(dir, 'popup.png'), options: path.join(dir, 'options.png') };
  let version = null, port = null;
  for (const p of [9333, 9360]) {
    try { version = await (await fetch(`http://localhost:${p}/json/version`)).json(); port = p; break; }
    catch (e) { /* not up */ }
  }
  if (!version) {
    console.log('\nno browser with the extension loaded on 9333 -- run tools/dev-session.js first');
    console.log('(falling back to the hero screenshot and the dashboard only)');
    return {};
  }

  // The extension id is read from the session file the dev launcher writes.
  // Scanning for a live service_worker target does not work: MV3 workers idle
  // out after a few seconds, so a perfectly healthy extension shows no target
  // at all and the scan reports it as missing.
  const sessionFile = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'dev-session', 'session.json');
  let extId = null;
  try { extId = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).extId; } catch (e) { /* no session */ }
  if (!extId) {
    const c = new CDP(version.webSocketDebuggerUrl); await c.ready;
    const { targetInfos } = await c.send('Target.getTargets');
    c.ws.close();
    const sw = targetInfos.find(t => t.type === 'service_worker' &&
      t.url.includes('src/background/service-worker.js'));
    extId = sw ? new URL(sw.url).host : null;
  }
  if (!extId) { console.log('\nextension not loaded in the browser on ' + port); return {}; }
  console.log('\ncapturing extension pages from the browser on ' + port + ' (' + extId + ')');

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;
  // Two display-only changes, both reverted below: scroll to the section the
  // listing caption is actually about, and stand in an example endpoint --
  // a localhost URL in a store screenshot reads as a half-finished dev build.
  const EXAMPLE_URL = 'https://blocklist.example.com/blocklist.json';
  await shoot(cdp, `chrome-extension://${extId}/src/options/options.html`, 880, 1180, out.options, 1600,
    `(async () => {
       const el = document.getElementById('listUrl');
       if (el) el.value = ${JSON.stringify(EXAMPLE_URL)};
       const h = [...document.querySelectorAll('h2')]
         .find(n => n.textContent.indexOf('Layer 2') === 0);
       await new Promise(r => setTimeout(r, 250));
       if (!h) return 0;
       const s = h.closest('section');
       return Math.max(0, s.getBoundingClientRect().top + window.scrollY - 18);
     })()`);
  try {
    await capturePopup(cdp, extId, out.popup);
  } catch (e) {
    console.log('  popup capture skipped:', e.message);
    delete out.popup;
  }
  cdp.ws.close();
  return out;
}

/**
 * Screenshots the action popup as it actually appears: opened over a supported
 * site.
 *
 * Loading popup.html as a plain tab produces a misleading image -- the popup
 * asks chrome.tabs for the active tab of its own window, so on its own it
 * reports "not on a supported site" and renders its empty state. Driving
 * chrome.action.openPopup() from the service worker with a Threads tab in
 * front gives the real popup surface with real state behind it.
 */
async function capturePopup(cdp, extId, file) {
  const { targetId: tab } = await cdp.send('Target.createTarget',
    { url: 'https://www.threads.com/@threads' });
  try {
    await cdp.send('Target.activateTarget', { targetId: tab });
    await sleep(5000);

    // Opening an extension page wakes the (idled) MV3 worker so there is a
    // target to drive, and is also where the display state is set.
    const { targetId: opt } = await cdp.send('Target.createTarget',
      { url: `chrome-extension://${extId}/src/options/options.html` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: opt, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(1400);
    // Platform blocking is shown OFF, which is both its real default and the
    // honest thing to picture: with it on but dry-run armed the popup reports
    // "612 queued - 0 blocked", which reads as broken rather than as safe.
    // Dry run stays ON regardless -- this browser is signed in to real
    // accounts and a screenshot is not worth arming live blocking to take.
    await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const { settings = {} } = await chrome.storage.sync.get('settings');
        await chrome.storage.sync.set({ settings: { ...settings,
          hideEnabled: true, platformBlockEnabled: false, platformBlockDryRun: true } });
        await new Promise(r => chrome.runtime.sendMessage({ type: 'sw:refresh-now' }, r));
      })()`,
      awaitPromise: true, returnByValue: true
    }, sessionId, 20000);
    await cdp.send('Target.closeTarget', { targetId: opt });
    await cdp.send('Target.activateTarget', { targetId: tab });
    await sleep(800);

    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.includes(extId));
    if (!sw) throw new Error('service worker not running');
    const { sessionId: swSession } = await cdp.send('Target.attachToTarget',
      { targetId: sw.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, swSession);
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'chrome.action.openPopup().then(() => "ok").catch(e => "ERR: " + e.message)',
      awaitPromise: true, returnByValue: true, userGesture: true
    }, swSession);
    if (r.result.value !== 'ok') throw new Error(String(r.result.value));
    await sleep(1800);

    const { targetInfos: after } = await cdp.send('Target.getTargets');
    const popup = after.find(t => t.type === 'page' && t.url.includes('/popup/popup.html'));
    if (!popup) throw new Error('popup did not appear');

    const { sessionId: pSession } = await cdp.send('Target.attachToTarget',
      { targetId: popup.targetId, flatten: true });
    await cdp.send('Page.enable', {}, pSession);
    // The popup really does overflow, so it really does have a scrollbar --
    // but a scrollbar sliced down the edge of a listing image just looks like
    // a bad crop. Hide the bar, keep the content.
    try { await cdp.send('Emulation.setScrollbarsHidden', { hidden: true }, pSession); } catch (e) {}
    await sleep(400);
    // No metrics override here: this is the real popup surface, and resizing
    // it would capture something the user never sees.
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, pSession);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('  wrote', path.basename(file), '(real action popup)',
      fs.statSync(file).size + ' bytes');
  } finally {
    try { await cdp.send('Target.closeTarget', { targetId: tab }); } catch (e) {}
  }
}
