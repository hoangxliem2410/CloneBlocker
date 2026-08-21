/**
 * Launches a long-lived Chrome with the extension loaded, for hands-on testing
 * against a signed-in account.
 *
 * Unlike e2e-test.js this leaves the browser RUNNING after the script exits:
 * Chrome is spawned detached, so you can sign in, browse, and have the session
 * inspected later with tools/inspect-session.js over the same debugging port.
 *
 * The profile directory is stable, so a login survives restarting this script.
 *
 *   node tools/dev-session.js [--port 9333] [--fresh]
 *
 * SAFETY: platform blocking is written as DISABLED with dry-run ON. Nothing in
 * this session can block anyone until that is deliberately changed.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CDP_PORT = parseInt(argOf('port', '9333'), 10);
const SERVER_PORT = 8790;
const FRESH = args.includes('--fresh');

const ROOT = path.join(__dirname, '..');
const SESSION_DIR = path.join(os.tmpdir(), 'claude', 'C--src-3queblocker', 'dev-session');
const PROFILE = path.join(SESSION_DIR, 'chrome-profile');
const SERVER_DIR = path.join(SESSION_DIR, 'server');

// Same fingerprint the server computes for itself at boot, over the copy we are
// about to run. Kept in step with the BUILD constant in server/server.js.
function serverBuild(dir) {
  const h = require('crypto').createHash('sha256');
  try {
    h.update(fs.readFileSync(path.join(dir, 'server.js')));
    const pub = path.join(dir, 'public');
    for (const f of fs.readdirSync(pub).sort()) {
      h.update(f);
      h.update(fs.readFileSync(path.join(pub, f)));
    }
  } catch (e) { return 'unknown'; }
  return h.digest('hex').slice(0, 12);
}

// Stopping a detached process we no longer hold a handle to.
async function killPort(port) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pids = new Set(out.trim().split(/\r?\n/)
      .map(l => l.trim().split(/\s+/).pop()).filter(x => /^\d+$/.test(x)));
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch (e) {}
    }
  } catch (e) { /* nothing listening */ }
  await sleep(600);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) {
        const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
  }
  send(method, params, sessionId) {
    const i = ++this.id;
    const payload = { id: i, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pend.set(i, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
                    r.exceptionDetails.text);
  }
  return r.result && r.result.value;
}

(async () => {
  if (FRESH) { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {} }
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(SERVER_DIR, { recursive: true });

  // -- blocklist server (detached so it outlives this script) --------------
  fs.copyFileSync(path.join(ROOT, 'server', 'server.js'), path.join(SERVER_DIR, 'server.js'));
  // The dashboard is served from disk, so its assets have to travel with the
  // server copy or /admin returns "asset missing".
  const pubSrc = path.join(ROOT, 'server', 'public');
  const pubDst = path.join(SERVER_DIR, 'public');
  fs.mkdirSync(pubDst, { recursive: true });
  for (const f of fs.readdirSync(pubSrc)) {
    fs.copyFileSync(path.join(pubSrc, f), path.join(pubDst, f));
  }
  if (!fs.existsSync(path.join(SERVER_DIR, 'blocklist.json'))) {
    fs.writeFileSync(path.join(SERVER_DIR, 'blocklist.json'), JSON.stringify({
      // Seeded with the official @threads account: safe to hide locally, and a
      // known-good target for verifying suppression on a signed-in feed.
      ids: ['63082166531'],
      usernames: ['threads'],
      docIdOverrides: {}
    }, null, 2));
  }

  // The server is detached so it outlives this script -- which means a process
  // started from an older copy can still be listening, answering /health, and
  // serving code we just overwrote on disk. Reusing it on "is it up?" alone is
  // how a retired sign-in gate survives the change that replaced it. Compare the
  // build fingerprint and restart when it does not match what we just copied.
  const wantBuild = serverBuild(SERVER_DIR);
  let live = null;
  try {
    const r = await fetch(`http://localhost:${SERVER_PORT}/health`);
    if (r.ok) live = await r.json();
  } catch (e) { live = null; }

  const stale = live && live.build !== wantBuild;
  if (stale) {
    console.log(`  server on ${SERVER_PORT} is running stale code (${live.build || 'pre-fingerprint'} != ${wantBuild}) -- restarting`);
    await killPort(SERVER_PORT);
    live = null;
  }
  if (!live) {
    const srv = spawn(process.execPath, [path.join(SERVER_DIR, 'server.js'), '--port', String(SERVER_PORT)],
      { detached: true, stdio: 'ignore' });
    srv.unref();
    await sleep(900);
  }

  // -- is a browser already listening on this port? ------------------------
  let version = null;
  try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); } catch (e) {}

  if (!version) {
    const chrome = spawn(findChrome(), [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--start-maximized',
      'https://www.threads.com/login'
    ], { detached: true, stdio: 'ignore' });
    chrome.unref();

    for (let i = 0; i < 60; i++) {
      try { version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); break; }
      catch (e) { await sleep(500); }
    }
    if (!version) { console.error('Chrome did not expose its debugging port'); process.exit(1); }
  } else {
    console.log('reusing the browser already on port ' + CDP_PORT);
  }

  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  // -- load (or find) the extension ----------------------------------------
  let extId = null;
  try {
    const r = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    extId = r && r.id;
  } catch (e) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' &&
                                     t.url.includes('src/background/service-worker.js'));
    if (sw) extId = new URL(sw.url).host;
    else { console.error('could not load the extension: ' + e.message); process.exit(1); }
  }

  fs.writeFileSync(path.join(SESSION_DIR, 'session.json'),
    JSON.stringify({ extId, cdpPort: CDP_PORT, serverPort: SERVER_PORT }, null, 2));

  // -- configure it through its own options page ---------------------------
  const optionsUrl = `chrome-extension://${extId}/src/options/options.html`;
  const { targetId } = await cdp.send('Target.createTarget', { url: optionsUrl });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(1500);

  // The blocklist host lives in optional_host_permissions, so it has to be
  // granted before the service worker is allowed to fetch it. chrome.permissions
  // .request needs a user gesture, which Runtime.evaluate can synthesise.
  //
  // The request can also simply never settle -- it is answered by a native
  // Chrome bubble, and one already on screen from an earlier run leaves the
  // promise pending forever. Awaiting it directly means a 20s CDP timeout takes
  // down the whole launcher, abandoning a browser that is already up with an
  // orphan options tab. So: ask what we hold first, and cap the request in the
  // page rather than letting it decide whether the session gets configured.
  const perm = await evalIn(cdp, sessionId, `
    (async () => {
      const origins = ['http://localhost/*'];
      if (await chrome.permissions.contains({ origins })) {
        return JSON.stringify({ granted: true, has: true, asked: false });
      }
      let granted = false;
      try {
        granted = await Promise.race([
          chrome.permissions.request({ origins }),
          new Promise(r => setTimeout(() => r('pending'), 10000))
        ]);
      } catch (e) { granted = 'error: ' + e.message; }
      return JSON.stringify({ granted, has: await chrome.permissions.contains({ origins }), asked: true });
    })()
  `);

  const applied = await evalIn(cdp, sessionId, `
    (async () => {
      await chrome.storage.sync.set({ settings: {
        listUrl: 'http://localhost:${SERVER_PORT}/blocklist.json',
        refreshMinutes: 60,
        hideEnabled: true,
        hideMode: 'placeholder',
        hideComments: true,
        hideFeedPosts: true,
        platformBlockEnabled: false,
        platformBlockDryRun: true,
        debug: true
      }});
      const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'sw:refresh-now' }, r));
      return JSON.stringify(res);
    })()
  `);
  await cdp.send('Target.closeTarget', { targetId });

  const parsed = JSON.parse(applied);
  console.log('');
  console.log('  extension id : ' + extId);
  console.log('  cdp port     : ' + CDP_PORT);
  console.log('  profile      : ' + PROFILE);
  console.log('  blocklist    : http://localhost:' + SERVER_PORT + '/blocklist.json');
  console.log('  host access  : ' + perm);
  console.log('  loaded       : ' + (parsed.ok
    ? `${parsed.blocklist.ids.length} ids, ${parsed.blocklist.usernames.length} usernames`
    : 'FAILED - ' + parsed.error));
  console.log('  layer 2      : DISABLED (dry run on) - nothing can be blocked for real');
  console.log('');
  console.log('  Chrome is running detached and will stay up after this exits.');
  console.log('  Sign in, then run: node tools/inspect-session.js');
  console.log('');

  // Leave the browser running.
  setTimeout(() => process.exit(0), 250);
})().catch((e) => { console.error(e); process.exit(1); });
