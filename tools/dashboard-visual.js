/**
 * Renders the Firebase-era moderation dashboard to PNGs.
 *
 *   node tools/dashboard-visual.js [--shot-dir DIR]
 *
 * Starts the emulator suite (Firestore + Auth + Hosting), creates the admin
 * account in the Auth emulator, seeds representative reports, then
 * screenshots the sign-in gate and the signed-in dashboard. The demo-
 * prefixed project id keeps the emulators fully offline, so nothing here can
 * touch a real account, a real project, or a real store.
 *
 * The dashboard lives at /admin/ now, not at /: hosting's root became the
 * public transparency page. Nothing about the page changed, only where it is
 * served from, so this tool follows it and keeps asking the same questions.
 *
 * Seeding goes through the REAL security rules on purpose: reports are
 * unauthenticated REST creates with proper dedup-key document ids — exactly
 * the write the extension performs — and decisions/publish carry the admin's
 * token, exactly the writes the dashboard performs. A fixture the rules
 * would reject is a fixture that lies about what production accepts.
 */
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = 'demo-clone';
const FS_PORT = 8080;      // fixed by firebase.json at the repo root
const AUTH_PORT = 9099;
const HOST_PORT = 5000;
const CDP_PORT = 9358;
const EMAIL = 'admin@demo.test';
const PASS = 'admin123';
const ROOT = path.join(__dirname, '..');
const OUT = process.argv.includes('--shot-dir')
  ? process.argv[process.argv.indexOf('--shot-dir') + 1]
  : path.join(ROOT, 'docs', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The published payload is derived in the seed script with the SAME compute
// the dashboard runs in the browser, so the screenshot shows a store the real
// publish path could have produced.
const LOGIC = require(path.join(ROOT, 'hosting', 'logic.js'));

const FS_BASE = `http://127.0.0.1:${FS_PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;

// The standalone Firebase CLI installs itself under ~/.cache/firebase and is
// not on PATH; FIREBASE_CLI overrides for machines that keep it elsewhere.
const FIREBASE_BIN = process.env.FIREBASE_CLI ||
  path.join(os.homedir(), '.cache', 'firebase', 'tools', 'bin', 'firebase');

/**
 * The Firebase CLI shells out to `java` and refuses to start the Firestore
 * emulator on anything below 21. A dev machine often pins an older JDK first
 * on PATH for other work, so look for a modern one in the usual install roots
 * and put it in front -- for the emulator process only; nothing else sees the
 * changed PATH.
 */
const { javaEnv } = require('./java-env.js');

class CDP {
  constructor(u){this.ws=new WebSocket(u);this.id=0;this.p=new Map();
    this.ready=new Promise(r=>this.ws.addEventListener('open',r));
    this.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
      if(m.id&&this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);
        m.error?q.rej(new Error(m.error.message)):q.res(m.result);}});}
  send(me,pa,s){const i=++this.id;const o={id:i,method:me,params:pa||{}};if(s)o.sessionId=s;
    return new Promise((res,rej)=>{this.p.set(i,{res,rej});this.ws.send(JSON.stringify(o));
      setTimeout(()=>{if(this.p.has(i)){this.p.delete(i);rej(new Error('t/o '+me))}},45000)})}
}
async function ev(c,s,e){const r=await c.send('Runtime.evaluate',
  {expression:e,returnByValue:true,awaitPromise:true,userGesture:true},s);
  if(r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result&&r.result.value;}
async function shot(c,s,f){const r=await c.send('Page.captureScreenshot',
  {format:'png',captureBeyondViewport:true},s);
  fs.writeFileSync(f,Buffer.from(r.data,'base64')); console.log('wrote '+f);}

/** Poll a condition inside the page; the page may still be booting, so an
 *  evaluate that throws counts as "not yet" rather than as a failure. */
async function until(c, s, expr, label, tries) {
  for (let i = 0; i < (tries || 60); i++) {
    let v = null;
    try { v = await ev(c, s, expr); } catch (e) { /* not loaded yet */ }
    if (v) return;
    await sleep(500);
  }
  throw new Error('timed out waiting for ' + label);
}

function findChrome() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome'
  ]) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found');
}

// The checks are the point, not a byproduct: a screenshot of a half-rendered
// page looks fine at a glance, so every region of the dashboard is also read
// back through the DOM and compared against what the fixture must produce.
let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + detail : ''}`);
}

// -- Firestore seeding, through the rules ------------------------------------

// The same derivation the extension uses for the reporter pseudonym.
const hashOf = (ref) =>
  'acct_' + crypto.createHash('sha256').update(ref).digest('hex').slice(0, 24);

// The emulator accepts unsigned tokens (alg none, empty signature); only the
// claims matter, because they are what the rules see as request.auth.
function bearer(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return 'Bearer ' + b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({
    sub: uid, user_id: uid, aud: PROJECT,
    iss: 'https://securetoken.google.com/' + PROJECT,
    iat: now, exp: now + 3600, auth_time: now,
    firebase: { sign_in_provider: 'password' }
  }) + '.';
}
let ADMIN = null;   // set once the Auth emulator has minted the admin uid

// Every report field is a string, so the encoder only needs stringValue.
const enc = (obj) => {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = { stringValue: String(obj[k]) };
  return { fields };
};

/**
 * File one report the way the extension does: an unauthenticated create with
 * the dedup key as the document id, validated by the deployed rules. The
 * argument keeps the old fixture's vocabulary (profileId/username/reporter);
 * this maps it onto the Firestore document contract.
 */
async function report(r) {
  const target = r.profileId ? String(r.profileId) : '@' + r.username;
  const body = { platform: r.platform, target, reason: r.reason || 'clone',
                 reporterHash: hashOf(r.reporter) };
  // The rules bind identity to the key: a numeric target IS the profileId,
  // an @target IS the username.
  if (r.profileId) body.profileId = String(r.profileId);
  if (r.username) body.username = r.username;
  for (const k of ['displayName', 'url', 'note', 'postUrl', 'postId', 'contentSummary', 'region']) {
    if (r[k]) body[k] = r[k];
  }
  // The extension lowercases before sending; the rules reject 'vi-VN'.
  if (r.lang) body.lang = r.lang.toLowerCase();
  body.dedupKey = body.platform + '~' + body.target + '~' + body.reporterHash;

  const res = await fetch(FS_BASE + '/reports?documentId=' + encodeURIComponent(body.dedupKey), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(enc(body))
  });
  if (res.status !== 200) {
    throw new Error('rules rejected a seed report (' + res.status + '): ' + JSON.stringify(body));
  }
}

/**
 * Record keys are platform:target; decision doc ids are platform~target.
 *
 * `opts.public` is the transparency opt-in, which lives on this same document
 * because it is a second verdict about the same target -- block it, and name
 * it on the public page -- not a second kind of record. It is written here
 * rather than through the dashboard button so the screenshot has a row in
 * each state to show side by side.
 */
const decide = async (key, decision, opts) => {
  const i = key.indexOf(':');
  const docPath = '/decisions/' + encodeURIComponent(key.slice(0, i) + '~' + key.slice(i + 1));
  const fields = {
    status: { stringValue: decision === 'approve' ? 'approved'
            : decision === 'reject' ? 'rejected' : 'pending' },
    by: { stringValue: 'demo' },
    at: { timestampValue: new Date().toISOString() }
  };
  if (opts && opts.public) fields.public = { booleanValue: true };
  const res = await fetch(FS_BASE + docPath, {
    method: 'PATCH',
    headers: { authorization: ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error('decision write failed (' + res.status + '): ' + key);
};

// Just enough Firestore value decoding for what the seed wrote: reports are
// all strings, decisions add one timestamp.
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('integerValue' in v) return Number(v.integerValue);
  return null;
}
async function listAll(collection) {
  const docs = [];
  let pageToken = '';
  do {
    const q = '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(FS_BASE + '/' + collection + q, { headers: { authorization: ADMIN } });
    if (!res.ok) throw new Error('listing ' + collection + ' failed: ' + res.status);
    const json = await res.json();
    for (const d of json.documents || []) {
      const data = {};
      for (const k of Object.keys(d.fields || {})) data[k] = fromValue(d.fields[k]);
      docs.push({ id: d.name.split('/').pop(), createTime: d.createTime, data });
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return docs;
}

/**
 * Publish blocklist/current the way the dashboard does after a decision:
 * re-read what is actually stored, derive the payload with the shared pure
 * compute, write it with the admin's token so the rules vouch for the path.
 */
async function publish() {
  const records = LOGIC.aggregate(await listAll('reports'), await listAll('decisions'));
  const payload = LOGIC.buildPublish(records, LOGIC.reputation(records), {});
  const res = await fetch(FS_BASE + '/blocklist/current', {
    method: 'PATCH',
    headers: { authorization: ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: {
      json: { stringValue: JSON.stringify(payload) },
      updatedAt: { timestampValue: payload.updatedAt },
      rev: { integerValue: '1' }
    } })
  });
  if (!res.ok) throw new Error('publish failed: ' + res.status);
  return payload;
}

// Swap the pinned PRODUCTION admin uid for the emulator-minted one, inside
// the emulator only -- the rules file on disk stays exactly as deployed.
async function swapRules(uid) {
  const src = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const m = src.match(/request\.auth\.uid == '([^']+)'/);
  if (!m) throw new Error('could not find the pinned admin uid in firestore.rules');
  const r = await fetch(`http://127.0.0.1:${FS_PORT}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { files: [
      { name: 'firestore.rules', content: src.split(m[1]).join(uid) }
    ] } })
  });
  if (r.status !== 200) {
    throw new Error('rules swap failed: ' + r.status + ' ' + (await r.text()));
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // A stale emulator (a dev session, an aborted run) would poison the exact
  // counts asserted below, so refuse to share ports rather than reuse them.
  for (const [port, what] of [[FS_PORT, 'Firestore'], [AUTH_PORT, 'Auth'], [HOST_PORT, 'Hosting']]) {
    let busy = true;
    try { await fetch(`http://127.0.0.1:${port}/`); } catch (e) { busy = false; }
    if (busy) {
      console.error(`port ${port} (${what} emulator) is already in use — stop it first`);
      process.exit(1);
    }
  }

  const emu = spawn(process.execPath,
    [FIREBASE_BIN, 'emulators:start', '--only', 'firestore,auth,hosting',
     '--project', PROJECT, ...require('./dev-config.js').devConfigArgs()],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: javaEnv() });
  emu.stdout.on('data', () => {});
  emu.stderr.on('data', d => console.error('[emulator]', String(d).trim()));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-dash-prof-'));
  let chrome = null;
  const cleanup = () => {
    try { if (chrome) chrome.kill(); } catch (e) {}
    // The CLI wraps a java child; killing the node pid alone leaves the
    // emulator itself listening for the next run to trip over.
    try { execSync(`taskkill /PID ${emu.pid} /T /F`, { stdio: 'ignore' }); }
    catch (e) { try { emu.kill(); } catch (e2) {} }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  };
  process.on('exit', cleanup);

  // Generous window: a first run downloads the emulator jar before anything
  // can listen. Hosting comes up last, so it is polled last.
  for (const port of [FS_PORT, AUTH_PORT, HOST_PORT]) {
    let up = false;
    for (let i = 0; i < 240 && !up; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); up = true; }
      catch (e) { await sleep(500); }
    }
    if (!up) { console.error('emulator never answered on port ' + port); process.exit(1); }
  }

  // The admin exists only inside the Auth emulator; its minted uid is then
  // pinned into the (emulator-side) rules so this account IS the admin.
  const su = await fetch(
    `http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS, returnSecureToken: true })
    });
  const localId = (await su.json()).localId;
  if (!localId) throw new Error('Auth emulator sign-up failed');
  await swapRules(localId);
  ADMIN = bearer(localId);

  // Representative data, written through the rules so encoding AND validation
  // are exercised. All documents are created "now" (report time is the
  // server-assigned createTime), so the whole fixture lands in today's
  // buckets — the sparkline and matrix show today's spike, which is honest.
  await report({ platform:'threads', profileId:'9100000001', username:'nguyenvana.clone',
    displayName:'Nguyễn Văn A', reason:'clone', reporter:'threads:70000087109',
    postUrl:'https://www.threads.com/@nguyenvana.clone/post/XYZ1', postId:'XYZ1',
    contentSummary:'Chuyển khoản gấp giúp mình nhé, mình đang kẹt ở nước ngoài 🙏',
    note:'Ảnh và tiểu sử giống hệt tài khoản thật' });
  await report({ platform:'threads', profileId:'9100000001', reporter:'threads:70000095028',
    postUrl:'https://www.threads.com/@nguyenvana.clone/post/XYZ2', postId:'XYZ2',
    contentSummary:'Mình mất điện thoại, ai cho mượn tiền không?' });
  await report({ platform:'threads', profileId:'9100000002', username:'copycat.02',
    displayName:'Trần Thị B', reason:'scam', reporter:'threads:70000102947',
    postUrl:'https://www.threads.com/@copycat.02/post/DEMO2', postId:'DEMO2',
    contentSummary:'Bán vé concert giá rẻ, chuyển khoản trước 50% rồi chặn' });
  await report({ platform:'facebook', username:'fake.tiger.01', displayName:'Lê Văn C (giả mạo)',
    reason:'impersonation', reporter:'threads:70000110866', url:'https://www.facebook.com/fake.tiger.01/',
    note:'Dùng ảnh của người khác' });
  await report({ platform:'threads', username:'spam.bot.9', displayName:'Spam Bot',
    reason:'spam', reporter:'threads:70000118785' });
  await decide('threads:9100000002', 'approve');
  // The transparency opt-in, on the row that leads the queue. It is still
  // pending, which is the honest half of the pair: opting in is recorded
  // whenever the admin decides it, but nothing is named publicly until the
  // target is also approved, and the row has to say which of those it means.
  await decide('threads:9100000001', 'pending', { public: true });

  // Build one reporter with a good record and one with a bad one, so the
  // screenshot shows what trust weighting actually looks like.
  for (let i = 0; i < 5; i++) {
    await report({ platform: 'threads', profileId: '9100' + (100 + i), reporter: 'threads:70000000001' });
    await decide('threads:9100' + (100 + i), 'approve');
    await report({ platform: 'threads', profileId: '9200' + (100 + i), reporter: 'threads:70000000002' });
    await decide('threads:9200' + (100 + i), 'reject');
  }
  // A fresh accusation from each, so the queue shows them side by side. The
  // distrusted reporter's one (best trust 0.08 < 0.25) is the held report.
  await report({ platform: 'threads', profileId: '9300001111', username: 'maybe.clone',
    displayName: 'Reported by a trusted account', reason: 'clone',
    reporter: 'threads:70000000001' });
  await report({ platform: 'threads', profileId: '9300002222', username: 'noisy.report',
    displayName: 'Reported by a distrusted account', reason: 'spam',
    reporter: 'threads:70000000002' });

  // Regional spread, so the trending matrix shows a wave rather than one cell.
  const REG = [['Asia/Ho_Chi_Minh', 'vi-VN', 9], ['Asia/Bangkok', 'th-TH', 4],
               ['America/Sao_Paulo', 'pt-BR', 3], ['Europe/Warsaw', 'pl-PL', 2]];
  let seed = 0;
  for (const [region, lang, n] of REG) {
    for (let i = 0; i < n; i++) {
      seed++;
      await report({ platform: 'threads', profileId: '95' + String(100000 + seed),
        username: 'clone.' + seed, displayName: 'Clone ' + seed, reason: 'clone',
        reporter: 'threads:8200000' + String(1000 + seed), region, lang });
      await decide('threads:95' + String(100000 + seed), 'approve');
    }
  }

  const payload = await publish();
  console.log('published: ' + payload.ids.length + ' ids, '
    + payload.pending.length + ' pending, ' + payload.targets.length + ' targets');

  chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});

  let v = null;
  for (let i = 0; i < 60; i++) {
    try { v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); break; }
    catch (e) { await sleep(400); }
  }
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  // /admin/, resolved by hosting's directory index; / is the public page now.
  const { targetId } = await c.send('Target.createTarget',
    { url: `http://localhost:${HOST_PORT}/admin/` });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Emulation.setDeviceMetricsOverride',
    { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false }, sessionId);

  // The gate unhides only after the boot resolved the config and Firebase
  // Auth reported "no user" — i.e. the real sign-in path is live.
  await until(c, sessionId, `(function(){var g=document.getElementById('gate');
    return g && !g.classList.contains('hidden')})()`, 'the sign-in gate');
  const gate = JSON.parse(await ev(c, sessionId,
    `JSON.stringify({ gate: !document.getElementById('gate').classList.contains('hidden'),
                      app: !document.getElementById('app').classList.contains('hidden') })`));
  console.log('before sign-in: ' + JSON.stringify(gate));
  check('the gate shows and the app stays hidden before sign-in', gate.gate && !gate.app);
  await shot(c, sessionId, path.join(OUT, 'dash-gate.png'));

  // Sign in the way a person would: through the form's own submit handler,
  // which drives signInWithEmailAndPassword against the Auth emulator.
  await ev(c, sessionId, `
    (async () => {
      document.getElementById('gateUser').value = ${JSON.stringify(EMAIL)};
      document.getElementById('gatePass').value = ${JSON.stringify(PASS)};
      document.getElementById('gateForm').dispatchEvent(new Event('submit', { cancelable: true }));
      return 1;
    })()`);
  await until(c, sessionId,
    `!document.getElementById('app').classList.contains('hidden')`, 'the app after sign-in');
  await until(c, sessionId, `document.querySelectorAll('.report').length > 0
    && document.getElementById('conn').textContent === 'Connected'`, 'the report queue');

  const state = JSON.parse(await ev(c, sessionId, `
    JSON.stringify({
      conn: document.getElementById('conn').textContent,
      pending: document.getElementById('statPending').textContent,
      approved: document.getElementById('statApproved').textContent,
      rejected: document.getElementById('statRejected').textContent,
      submissions: document.getElementById('statSubmissions').textContent,
      blocked: document.getElementById('statBlocked').textContent,
      evidence: document.getElementById('statEvidence').textContent,
      held: document.getElementById('statHeld').textContent,
      reporters: document.getElementById('statReporters').textContent,
      reportersLabel: document.getElementById('statReportersK').textContent,
      rows: document.querySelectorAll('.report').length,
      first: (document.querySelector('.report .name')||{}).textContent,
      repChips: document.querySelectorAll('.report .rep').length,
      goodChips: document.querySelectorAll('.report .rep.good').length,
      badChips: document.querySelectorAll('.report .rep.bad').length,
      heldPills: document.querySelectorAll('.report .pill.held').length,
      cited: (document.querySelector('.evidence summary')||{}).textContent,
      postTexts: document.querySelectorAll('.evidence .post .txt').length,
      bars: document.querySelectorAll('.spark .bar').length,
      matrixRows: document.querySelectorAll('#trendMatrix .mrow').length,
      litCells: document.querySelectorAll('#trendMatrix .mcell.on').length,
      trendCols: document.querySelectorAll('#trendTop .tcol').length
    })`));
  console.log('after sign-in:  ' + JSON.stringify(state));

  // Expected values are pinned to the fixture above; every count is derived,
  // so a drift here means the compute or the rendering changed, not the seed.
  check('the dashboard connected', state.conn === 'Connected', state.conn);
  check('stat tiles: 5 pending', state.pending === '5', state.pending);
  check('stat tiles: 24 approved (1 + 5 history + 18 spread)', state.approved === '24', state.approved);
  check('stat tiles: 5 rejected', state.rejected === '5', state.rejected);
  check('stat tiles: 35 submissions across 34 accounts', state.submissions === '35', state.submissions);
  check('stat tiles: 24 on the derived blocklist', state.blocked === '24', state.blocked);
  check('stat tiles: 2 with evidence', state.evidence === '2', state.evidence);
  check('stat tiles: held counts the all-distrusted records', state.held === '6', state.held);
  check('stat tiles: 21 known reporters, 1 distrusted',
    state.reporters === '21' && state.reportersLabel === 'Reporters · 1 distrusted',
    state.reporters + ' / ' + state.reportersLabel);
  check('the pending queue shows 5 report rows', state.rows === 5, String(state.rows));
  check('the VN clone (score 1.0) leads the queue', state.first === 'Nguyễn Văn A', state.first);
  check('trust chips render on every reporter', state.repChips === 6, String(state.repChips));
  check('the trusted reporter earns a good chip', state.goodChips === 1, String(state.goodChips));
  check('the distrusted reporter earns a bad chip', state.badChips === 1, String(state.badChips));
  check('exactly the distrusted report is held', state.heldPills === 1, String(state.heldPills));
  check('the cited posts render as evidence', state.cited === '2 posts cited', state.cited);
  check('both Vietnamese summaries render', state.postTexts === 2, String(state.postTexts));
  check('the sparkline draws a bar per day of the fortnight', state.bars === 14, String(state.bars));
  check('the trend matrix shows 4 region rows', state.matrixRows === 5, String(state.matrixRows));
  check('one lit cell per region (all reports are today)', state.litCells === 4, String(state.litCells));
  check('per-region top lists render', state.trendCols === 4, String(state.trendCols));

  // The transparency opt-in has to be legible at a glance, not just present in
  // the markup: naming somebody publicly is the one decision on this page that
  // cannot be quietly undone, so the row it was taken on must not look like the
  // four rows beside it. Read back as a person sees it -- an opted-in row
  // carries a marker that says so in words, the rest carry nothing about the
  // public page in their header line, and the marker is drawn in its own colour
  // rather than in the row's body text.
  const pub = JSON.parse(await ev(c, sessionId, `
    (function () {
      var rows = Array.prototype.slice.call(document.querySelectorAll('.report'));
      var marked = rows.filter(function (r) { return r.querySelector('.pill.public'); });
      var plain = rows.filter(function (r) { return !r.querySelector('.pill.public'); });
      var out = { marked: marked.length, plain: plain.length };
      if (!marked.length) return JSON.stringify(out);
      var pill = marked[0].querySelector('.pill.public');
      var name = marked[0].querySelector('.name');
      out.text = pill.textContent;
      out.colour = getComputedStyle(pill).color;
      out.rowColour = getComputedStyle(name).color;
      out.plainHeadersMentionPublic = plain.some(function (r) {
        return /public/i.test(r.querySelector('.top').textContent);
      });
      return JSON.stringify(out);
    })()`));
  console.log('public opt-in:  ' + JSON.stringify(pub));
  check('a row opted in to the public page is visibly distinguishable from one that is not',
    pub.marked === 1 && pub.plain === 4 &&
    /public/i.test(pub.text || '') && !pub.plainHeadersMentionPublic &&
    !!pub.colour && pub.colour !== pub.rowColour,
    JSON.stringify(pub));

  await shot(c, sessionId, path.join(OUT, 'dashboard.png'));

  console.log(failed ? failed + ' CHECK(S) FAILED' : 'all checks passed');
  cleanup();
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch(e => { console.error(e.message); process.exit(1); });
