/**
 * Renders the server-side moderation dashboard to PNGs.
 *
 *   node tools/dashboard-visual.js [--shot-dir DIR]
 *
 * Starts a throwaway server with a token, seeds representative reports, then
 * screenshots the sign-in gate and the signed-in dashboard. Nothing touches a
 * real account or a real store.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8806;
const CDP_PORT = 9358;
const USER = 'admin';
const PASS = 'admin123';
const ROOT = path.join(__dirname, '..');
const OUT = process.argv.includes('--shot-dir')
  ? process.argv[process.argv.indexOf('--shot-dir') + 1] : '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function findChrome() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome'
  ]) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found');
}

const post = (b) => fetch(`http://localhost:${PORT}/reports`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b)
}).then(r => r.json());

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-dash-'));
  fs.copyFileSync(path.join(ROOT, 'server', 'server.js'), path.join(dir, 'server.js'));
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'server', 'public'))) {
    fs.copyFileSync(path.join(ROOT, 'server', 'public', f), path.join(dir, 'public', f));
  }
  fs.writeFileSync(path.join(dir, 'blocklist.json'),
    JSON.stringify({ ids: [], usernames: [], docIdOverrides: {} }, null, 2));

  const srv = spawn(process.execPath,
    // Seeding a demo from one address trips the per-IP report ceiling, which is
    // the limiter behaving correctly. Lift it for the fixture only.
    [path.join(dir, 'server.js'), '--port', String(PORT), '--report-rate', '100000'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => console.error('[server]', String(d).trim()));
  await sleep(1000);

  // Representative data, written through the API so encoding is exercised.
  await post({ platform:'threads', profileId:'9100000001', username:'nguyenvana.clone',
    displayName:'Nguyễn Văn A', reason:'clone', reporter:'threads:70000087109',
    postUrl:'https://www.threads.com/@nguyenvana.clone/post/XYZ1', postId:'XYZ1',
    contentSummary:'Chuyển khoản gấp giúp mình nhé, mình đang kẹt ở nước ngoài 🙏',
    note:'Ảnh và tiểu sử giống hệt tài khoản thật' });
  await post({ platform:'threads', profileId:'9100000001', reporter:'threads:70000095028',
    postUrl:'https://www.threads.com/@nguyenvana.clone/post/XYZ2', postId:'XYZ2',
    contentSummary:'Mình mất điện thoại, ai cho mượn tiền không?' });
  await post({ platform:'threads', profileId:'9100000002', username:'copycat.02',
    displayName:'Trần Thị B', reason:'scam', reporter:'threads:70000102947',
    postUrl:'https://www.threads.com/@copycat.02/post/DEMO2', postId:'DEMO2',
    contentSummary:'Bán vé concert giá rẻ, chuyển khoản trước 50% rồi chặn' });
  await post({ platform:'facebook', username:'fake.tiger.01', displayName:'Lê Văn C (giả mạo)',
    reason:'impersonation', reporter:'threads:70000110866', url:'https://www.facebook.com/fake.tiger.01/',
    note:'Dùng ảnh của người khác' });
  await post({ platform:'threads', username:'spam.bot.9', displayName:'Spam Bot',
    reason:'spam', reporter:'threads:70000118785' });
  await fetch(`http://localhost:${PORT}/admin/reports/decide`, {
    method:'POST', headers:{'content-type':'application/json', authorization:'Basic '+Buffer.from(USER+':'+PASS).toString('base64')},
    body: JSON.stringify({ key:'threads:9100000002', decision:'approve', by:'demo' })
  });

  // Build one reporter with a good record and one with a bad one, so the
  // screenshot shows what trust weighting actually looks like.
  const decide = (key, decision) => fetch(`http://localhost:${PORT}/admin/reports/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               authorization: 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64') },
    body: JSON.stringify({ key, decision, by: 'demo' })
  });
  for (let i = 0; i < 5; i++) {
    await post({ platform: 'threads', profileId: '9100' + (100 + i), reporter: 'threads:70000000001' });
    await decide('threads:9100' + (100 + i), 'approve');
    await post({ platform: 'threads', profileId: '9200' + (100 + i), reporter: 'threads:70000000002' });
    await decide('threads:9200' + (100 + i), 'reject');
  }
  // A fresh accusation from each, so the queue shows them side by side.
  await post({ platform: 'threads', profileId: '9300001111', username: 'maybe.clone',
    displayName: 'Reported by a trusted account', reason: 'clone',
    reporter: 'threads:70000000001' });
  await post({ platform: 'threads', profileId: '9300002222', username: 'noisy.report',
    displayName: 'Reported by a distrusted account', reason: 'spam',
    reporter: 'threads:70000000002' });

  // Regional spread, so the trending matrix shows a wave rather than one cell.
  const REG = [['Asia/Ho_Chi_Minh', 'vi-VN', 9], ['Asia/Bangkok', 'th-TH', 4],
               ['America/Sao_Paulo', 'pt-BR', 3], ['Europe/Warsaw', 'pl-PL', 2]];
  let seed = 0;
  for (const [region, lang, n] of REG) {
    for (let i = 0; i < n; i++) {
      seed++;
      await post({ platform: 'threads', profileId: '95' + String(100000 + seed),
        username: 'clone.' + seed, displayName: 'Clone ' + seed, reason: 'clone',
        reporter: 'threads:8200000' + String(1000 + seed), region, lang });
      await decide('threads:95' + String(100000 + seed), 'approve');
    }
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-dash-prof-'));
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});

  const cleanup = () => {
    try { chrome.kill(); } catch (e) {}
    try { srv.kill(); } catch (e) {}
    for (const d of [dir, profile]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  };
  process.on('exit', cleanup);

  let v = null;
  for (let i = 0; i < 60; i++) {
    try { v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json(); break; }
    catch (e) { await sleep(400); }
  }
  const c = new CDP(v.webSocketDebuggerUrl); await c.ready;
  const { targetId } = await c.send('Target.createTarget', { url: `http://localhost:${PORT}/admin` });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  await c.send('Page.enable', {}, sessionId);
  await c.send('Runtime.enable', {}, sessionId);
  await c.send('Emulation.setDeviceMetricsOverride',
    { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false }, sessionId);
  await sleep(2500);

  const gate = await ev(c, sessionId,
    `JSON.stringify({ gate: !document.getElementById('gate').classList.contains('hidden'),
                      app: !document.getElementById('app').classList.contains('hidden') })`);
  console.log('before sign-in: ' + gate);
  await shot(c, sessionId, path.join(OUT, 'dash-gate.png'));

  // Sign in the way a person would.
  await ev(c, sessionId, `
    (async () => {
      document.getElementById('gateUser').value = ${JSON.stringify(USER)};
      document.getElementById('gatePass').value = ${JSON.stringify(PASS)};
      document.getElementById('gateForm').dispatchEvent(new Event('submit', { cancelable: true }));
      return 1;
    })()`);
  await sleep(3000);

  const state = await ev(c, sessionId, `
    JSON.stringify({
      app: !document.getElementById('app').classList.contains('hidden'),
      conn: document.getElementById('conn').textContent,
      pending: document.getElementById('statPending').textContent,
      approved: document.getElementById('statApproved').textContent,
      submissions: document.getElementById('statSubmissions').textContent,
      evidence: document.getElementById('statEvidence').textContent,
      rows: document.querySelectorAll('.report').length,
      first: (document.querySelector('.report .name')||{}).textContent,
      cited: (document.querySelector('.evidence summary')||{}).textContent,
      bars: document.querySelectorAll('.spark .bar').length,
      matrixRows: document.querySelectorAll('#trendMatrix .mrow').length,
      litCells: document.querySelectorAll('#trendMatrix .mcell.on').length
    })`);
  console.log('after sign-in:  ' + state);
  await shot(c, sessionId, path.join(OUT, 'dashboard.png'));

  cleanup();
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error(e.message); process.exit(1); });
