/**
 * Lifecycle tests for the report + blocklist server.
 *
 *   node tools/server-test.js
 *
 * Runs the real server against a temporary store and drives it over HTTP, so
 * the contract the extension depends on is exercised exactly as shipped.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8802;
const USER = 'testadmin';
const PASS = 'testpass-9271';
const BASIC = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(method, p, body, auth) {
  const headers = { 'content-type': 'application/json' };
  // `auth` is a complete Authorization header value (e.g. "Basic <b64>"), not a
  // bare token — the admin gate speaks Basic auth and session cookies now.
  if (auth) headers.authorization = auth;
  const r = await fetch(BASE + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* 304 has no body */ }
  return { status: r.status, json, etag: r.headers.get('etag') };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-srv-test-'));
  fs.copyFileSync(path.join(__dirname, '..', 'server', 'server.js'), path.join(dir, 'server.js'));
  const pubSrc = path.join(__dirname, '..', 'server', 'public');
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  for (const f of fs.readdirSync(pubSrc)) {
    fs.copyFileSync(path.join(pubSrc, f), path.join(dir, 'public', f));
  }
  fs.writeFileSync(path.join(dir, 'blocklist.json'),
    JSON.stringify({ ids: [], usernames: [], docIdOverrides: {} }, null, 2));

  const srv = spawn(process.execPath, [path.join(dir, 'server.js'), '--port', String(PORT), '--user', USER, '--pass', PASS,
     // The whole suite reports from one address; the per-account ceiling below
     // is the one these tests care about and it keeps its default.
     '--report-rate', '100000'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => console.error('[server]', String(d).trim()));

  for (let i = 0; i < 40; i++) {
    try { const h = await api('GET', '/health'); if (h.json && h.json.ok) break; } catch (e) {}
    await sleep(250);
  }

  const cleanup = () => {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  };

  // -- 1. reporting ---------------------------------------------------------
  const r1 = await api('POST', '/reports', {
    platform: 'threads', profileId: '9100000001', username: 'nguyenvana.clone',
    displayName: 'Fake Nguyễn Văn A', url: 'https://www.threads.com/@nguyenvana.clone',
    reason: 'clone', reporter: 'threads:70000039595', note: 'copied bio and photos'
  });
  check('a report is accepted', r1.json && r1.json.ok && r1.json.count === 1, JSON.stringify(r1.json));

  const dup = await api('POST', '/reports', { platform: 'threads', profileId: '9100000001', reporter: 'threads:70000039595' });
  check('the same reporter does not inflate the count',
    dup.json && dup.json.duplicate === true && dup.json.count === 1, JSON.stringify(dup.json));

  const second = await api('POST', '/reports', { platform: 'threads', profileId: '9100000001', reporter: 'threads:70000047514' });
  check('a different reporter raises the count',
    second.json && second.json.count === 2, JSON.stringify(second.json));

  const bad = await api('POST', '/reports', { platform: 'myspace', profileId: '123456' });
  check('an unknown platform is rejected', bad.status === 400, String(bad.status));

  const noIdent = await api('POST', '/reports', { platform: 'facebook' });
  check('a report with no identity is rejected', noIdent.status === 400, String(noIdent.status));

  // -- 2. admin gate --------------------------------------------------------
  const noAuth = await api('GET', '/admin/reports');
  check('admin routes require a token', noAuth.status === 401, String(noAuth.status));

  const queue = await api('GET', '/admin/reports?status=pending', undefined, BASIC);
  check('the review queue lists the pending report',
    queue.json && queue.json.count === 1 && queue.json.reports[0].count === 2,
    queue.json ? `${queue.json.count} rows` : '');

  // -- 3. approve puts it on the list --------------------------------------
  const before = await api('GET', '/blocklist.json');
  const approve = await api('POST', '/admin/reports/decide',
    { key: 'threads:9100000001', decision: 'approve', by: 'admin1' }, BASIC);
  const after = await api('GET', '/blocklist.json');
  check('approving adds the profile to the blocklist',
    approve.json && approve.json.status === 'approved' &&
    (before.json.ids || []).length === 0 && (after.json.ids || []).includes('9100000001'),
    JSON.stringify(after.json.ids));

  const status = await api('GET', '/reports/status?platform=threads&profileId=9100000001');
  check('the public status endpoint reports it as blocked',
    status.json && status.json.blocked === true && status.json.status === 'approved',
    JSON.stringify(status.json));

  // -- 4. an id-bearing report should not also add the username ------------
  check('a numeric id is listed without also listing the username',
    !(after.json.usernames || []).includes('nguyenvana.clone'),
    JSON.stringify(after.json.usernames));

  // -- 5. revoke takes it back off -----------------------------------------
  const revoke = await api('POST', '/admin/reports/decide',
    { key: 'threads:9100000001', decision: 'revoke', by: 'admin1' }, BASIC);
  const afterRevoke = await api('GET', '/blocklist.json');
  check('revoking removes it from the blocklist and reopens the report',
    revoke.json && revoke.json.status === 'pending' &&
    !(afterRevoke.json.ids || []).includes('9100000001'),
    JSON.stringify(afterRevoke.json.ids));

  // -- 6. removing from the list must not leave a stale "approved" ---------
  await api('POST', '/admin/reports/decide', { key: 'threads:9100000001', decision: 'approve' }, BASIC);
  await api('POST', '/admin/blocklist/remove', { ids: ['9100000001'] }, BASIC);
  const q2 = await api('GET', '/admin/reports', undefined, BASIC);
  const rec = q2.json.reports.find(r => r.key === 'threads:9100000001');
  check('removing from the list reopens the report rather than leaving it "approved"',
    rec && rec.status === 'pending', rec ? rec.status : 'missing');

  // -- 7. rejection, and re-reporting reopens ------------------------------
  await api('POST', '/admin/reports/decide', { key: 'threads:9100000001', decision: 'reject' }, BASIC);
  const afterReject = await api('GET', '/admin/reports', undefined, BASIC);
  const rejected = afterReject.json.reports.find(r => r.key === 'threads:9100000001');
  check('rejecting sets the status', rejected && rejected.status === 'rejected', rejected && rejected.status);

  await api('POST', '/reports', { platform: 'threads', profileId: '9100000001', reporter: 'threads:70000055433' });
  const q3 = await api('GET', '/admin/reports?status=pending', undefined, BASIC);
  check('a new reporter reopens a rejected account',
    q3.json && q3.json.reports.some(r => r.key === 'threads:9100000001'),
    JSON.stringify(q3.json.count));

  // -- 8. username-only reports --------------------------------------------
  await api('POST', '/reports', { platform: 'facebook', username: 'some.clone', reporter: 'threads:70000039595' });
  await api('POST', '/admin/reports/decide', { key: 'facebook:@some.clone', decision: 'approve' }, BASIC);
  const listNow = await api('GET', '/blocklist.json');
  check('a username-only report lands in the usernames list',
    (listNow.json.usernames || []).includes('some.clone'),
    JSON.stringify(listNow.json.usernames));

  // -- 8b. non-ASCII names must survive the round trip ---------------------
  // Names like this are the norm for the intended user base, and a chunk-split
  // multi-byte character used to arrive mangled.
  const VN = 'Nguyễn Văn A 🇻🇳';
  await api('POST', '/reports', {
    platform: 'facebook', profileId: '100000000000001',
    displayName: VN, reason: 'clone', reporter: 'threads:70000063352', note: 'tên giả mạo'
  });
  const vnQueue = await api('GET', '/admin/reports', undefined, BASIC);
  const vnRec = vnQueue.json.reports.find(r => r.key === 'facebook:100000000000001');
  check('a non-ASCII display name survives the round trip',
    vnRec && vnRec.displayName === VN, vnRec ? vnRec.displayName : 'missing');
  check('a non-ASCII note survives the round trip',
    vnRec && vnRec.notes.some(n => n.text === 'tên giả mạo'),
    vnRec ? JSON.stringify(vnRec.notes.map(n => n.text)) : '');

  // -- 8c. post evidence is attached and accumulates ------------------------
  await api('POST', '/reports', {
    platform: 'threads', profileId: '777777777', username: 'clone1',
    reason: 'clone', reporter: 'threads:70000007919',
    postUrl: 'https://www.threads.com/@clone1/post/AAA',
    postId: 'AAA', contentSummary: 'first suspicious post'
  });
  await api('POST', '/reports', {
    platform: 'threads', profileId: '777777777', reporter: 'threads:70000015838',
    postUrl: 'https://www.threads.com/@clone1/post/BBB',
    postId: 'BBB', contentSummary: 'second suspicious post'
  });
  // The same post reported twice should not duplicate the evidence.
  await api('POST', '/reports', {
    platform: 'threads', profileId: '777777777', reporter: 'threads:70000023757',
    postUrl: 'https://www.threads.com/@clone1/post/AAA',
    postId: 'AAA', contentSummary: 'first suspicious post'
  });
  const ev = await api('GET', '/admin/reports', undefined, BASIC);
  const evRec = ev.json.reports.find(r => r.key === 'threads:777777777');
  check('post evidence is attached to the report',
    evRec && evRec.posts.length === 2 &&
    evRec.posts.some(x => x.postId === 'AAA' && /first suspicious/.test(x.summary)),
    evRec ? JSON.stringify(evRec.posts.map(x => x.postId)) : 'missing');
  check('the same post reported twice is not duplicated',
    evRec && evRec.posts.filter(x => x.postId === 'AAA').length === 1,
    evRec ? String(evRec.posts.length) : '');

  // -- 9. ETag still works for the polling extension -----------------------
  const e1 = await api('GET', '/blocklist.json');
  const r304 = await fetch(BASE + '/blocklist.json', { headers: { 'if-none-match': e1.etag } });
  check('an unchanged list answers 304', r304.status === 304, String(r304.status));

  // -- 10. credentials -------------------------------------------------------
  const wrong = await api('GET', '/admin/stats', undefined,
    'Basic ' + Buffer.from(USER + ':nope').toString('base64'));
  check('a wrong password is rejected', wrong.status === 401, String(wrong.status));

  const wrongUser = await api('GET', '/admin/stats', undefined,
    'Basic ' + Buffer.from('nobody:' + PASS).toString('base64'));
  check('a wrong username is rejected', wrongUser.status === 401, String(wrongUser.status));

  const login = await fetch(BASE + '/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('login issues an HttpOnly session cookie',
    login.status === 200 && /^3que_sid=/.test(cookie) &&
    /HttpOnly/i.test(login.headers.get('set-cookie') || ''),
    cookie.slice(0, 24));

  const viaCookie = await fetch(BASE + '/admin/stats', { headers: { cookie } });
  check('the session cookie authenticates admin routes', viaCookie.status === 200, String(viaCookie.status));

  const badLogin = await fetch(BASE + '/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'wrong' })
  });
  check('login with a bad password is refused', badLogin.status === 401, String(badLogin.status));

  await fetch(BASE + '/admin/logout', { method: 'POST', headers: { cookie } });
  const afterLogout = await fetch(BASE + '/admin/stats', { headers: { cookie } });
  check('signing out invalidates the session', afterLogout.status === 401, String(afterLogout.status));

  // -- 11. reporting stays anonymous ----------------------------------------
  const anon = await fetch(BASE + '/reports', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'threads', username: 'anon.target', reporter: 'threads:70000031676' })
  });
  check('reporting needs no credentials at all', anon.status === 200, String(anon.status));

  const anonAdmin = await fetch(BASE + '/admin/reports');
  check('admin routes still refuse the same anonymous caller',
    anonAdmin.status === 401, String(anonAdmin.status));

  // -- 12. default credentials are loopback-only ----------------------------
  {
    const defPort = PORT + 1;
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-srv-def-'));
    fs.copyFileSync(path.join(__dirname, '..', 'server', 'server.js'), path.join(dir2, 'server.js'));
    fs.mkdirSync(path.join(dir2, 'public'), { recursive: true });
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'server', 'public'))) {
      fs.copyFileSync(path.join(__dirname, '..', 'server', 'public', f), path.join(dir2, 'public', f));
    }
    const srv2 = spawn(process.execPath, [path.join(dir2, 'server.js'), '--port', String(defPort)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    await sleep(900);

    const defBasic = 'Basic ' + Buffer.from('admin:admin123').toString('base64');
    const r1 = await fetch('http://localhost:' + defPort + '/admin/stats', { headers: { authorization: defBasic } });
    check('the documented defaults work from loopback', r1.status === 200, String(r1.status));

    const sess = await fetch('http://localhost:' + defPort + '/admin/session');
    const sj = await sess.json();
    check('the server admits it is using default credentials',
      sj.usingDefaults === true, JSON.stringify(sj));

    const page = await fetch('http://localhost:' + defPort + '/admin');
    check('the dashboard page itself needs no credentials', page.status === 200, String(page.status));

    try { srv2.kill(); } catch (e) {}
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (e) {}
  }

  // -- 13. input limits -----------------------------------------------------
  {
    const long = 'A'.repeat(5000);
    await api('POST', '/reports', {
      platform: 'threads', profileId: '888888888', username: long,
      displayName: long, reason: 'clone', reporter: 'threads:70000123456', note: long,
      postUrl: 'https://www.threads.com/@x/post/' + long,
      postId: long, contentSummary: long
    });
    const q = await api('GET', '/admin/reports', undefined, BASIC);
    const rec = q.json.reports.find(r => String(r.profileId) === '888888888');
    check('an over-long display name is truncated, not stored whole',
      rec && rec.displayName.length === 80, rec ? String(rec.displayName.length) : 'missing');
    check('an over-long note is truncated',
      rec && rec.notes[0].text.length === 400, rec ? String(rec.notes[0].text.length) : '');
    check('the stored reporter is a pseudonym, not the raw account id',
      rec && /^acct_[0-9a-f]{16}$/.test(rec.reporters[0]) &&
      rec.reporters[0].indexOf('888') < 0, rec ? rec.reporters[0] : '');
    check('an over-long content summary is truncated',
      rec && rec.posts[0] && rec.posts[0].summary.length === 400,
      rec && rec.posts[0] ? String(rec.posts[0].summary.length) : '');
    check('an over-long post URL is rejected rather than truncated into nonsense',
      rec && rec.posts[0] && rec.posts[0].url === null,
      rec && rec.posts[0] ? String(rec.posts[0].url) : '');

    const huge = await fetch(BASE + '/reports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'threads', profileId: '999999999', note: 'x'.repeat(200000) })
    });
    check('an oversized request body is rejected', huge.status === 400, String(huge.status));

    const bigId = await api('POST', '/reports',
      { platform: 'threads', profileId: '9'.repeat(500), reporter: 'threads:70000079190' });
    check('a 500-digit profile id is not accepted as an id', bigId.status === 400, String(bigId.status));
  }

  // -- 14. dangerous URLs ---------------------------------------------------
  // The dashboard renders these as links the owner clicks. A javascript: href
  // there would run in the dashboard's origin, carrying the admin session.
  {
    await api('POST', '/reports', {
      platform: 'facebook', profileId: '123456789', reporter: 'threads:70000071271',
      url: 'javascript:fetch("/admin/reports/decide",{method:"POST"})',
      postUrl: 'javascript:alert(1)', contentSummary: 'payload'
    });
    const x = await api('GET', '/admin/reports', undefined, BASIC);
    const xr = x.json.reports.find(r => String(r.profileId) === '123456789');
    check('a javascript: profile URL is dropped', xr && xr.url === null, xr ? String(xr.url) : 'missing');
    check('a javascript: post URL is dropped',
      xr && xr.posts[0] && xr.posts[0].url === null,
      xr && xr.posts[0] ? String(xr.posts[0].url) : 'no post');
    check('the post is still kept for its text',
      xr && xr.posts.length === 1 && xr.posts[0].summary === 'payload',
      xr ? String(xr.posts.length) : '');

    await api('POST', '/reports', {
      platform: 'facebook', profileId: '123456780', reporter: 'threads:70000000000',
      url: 'https://www.facebook.com/real.person/'
    });
    const okq = await api('GET', '/admin/reports', undefined, BASIC);
    const okr = okq.json.reports.find(r => String(r.profileId) === '123456780');
    check('a normal https URL is kept',
      okr && okr.url === 'https://www.facebook.com/real.person/', okr ? String(okr.url) : 'missing');
  }

  // -- 15. prototype pollution ----------------------------------------------
  {
    const proto = await api('POST', '/admin/reports/decide',
      { key: '__proto__', decision: 'approve', by: 'attacker' }, BASIC);
    check('a __proto__ key is treated as missing, not as a report',
      proto.json && Array.isArray(proto.json.missing) &&
      proto.json.missing.indexOf('__proto__') >= 0 && proto.json.decided.length === 0,
      JSON.stringify(proto.json && proto.json.missing));
    check('Object.prototype was not written to',
      ({}).status === undefined && ({}).decidedBy === undefined,
      String(({}).status) + '/' + String(({}).decidedBy));

    const many = await api('POST', '/admin/reports/decide',
      { keys: new Array(2000).fill('threads:9100000001'), decision: 'reject' }, BASIC);
    check('an oversized bulk decision is refused', many.status === 400, String(many.status));
  }

  // -- 16. security headers and CORS scope ----------------------------------
  {
    const pub = await fetch(BASE + '/blocklist.json');
    check('public routes still answer cross-origin (the extension needs it)',
      pub.headers.get('access-control-allow-origin') === '*',
      String(pub.headers.get('access-control-allow-origin')));

    const adm = await fetch(BASE + '/admin/stats', { headers: { authorization: BASIC } });
    check('admin routes advertise no cross-origin access',
      adm.headers.get('access-control-allow-origin') === null,
      String(adm.headers.get('access-control-allow-origin')));

    check('responses carry nosniff',
      pub.headers.get('x-content-type-options') === 'nosniff',
      String(pub.headers.get('x-content-type-options')));

    const page = await fetch(BASE + '/admin');
    const csp = page.headers.get('content-security-policy') || '';
    check('the dashboard ships a CSP that forbids inline script',
      csp.indexOf("default-src 'none'") >= 0 && csp.indexOf("script-src 'self'") >= 0 &&
      csp.indexOf('unsafe-inline') < 0, csp.slice(0, 44));
    check('the dashboard refuses to be framed',
      page.headers.get('x-frame-options') === 'DENY' && csp.indexOf("frame-ancestors 'none'") >= 0,
      String(page.headers.get('x-frame-options')));
  }

  // -- 17. brute-force throttling -------------------------------------------
  {
    let sawThrottle = false, status = 0;
    for (let i = 0; i < 14; i++) {
      const r = await fetch(BASE + '/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USER, password: 'guess-' + i })
      });
      status = r.status;
      if (r.status === 429) { sawThrottle = true; break; }
    }
    check('repeated sign-in attempts are throttled', sawThrottle, 'last status ' + status);

    const afterThrottle = await fetch(BASE + '/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS })
    });
    check('a throttled client cannot slip through with the right password',
      afterThrottle.status === 429, String(afterThrottle.status));

    // Basic auth is a separate door and must still work for scripts.
    const basicStill = await fetch(BASE + '/admin/stats', { headers: { authorization: BASIC } });
    check('throttling sign-in does not lock out Basic auth',
      basicStill.status === 200, String(basicStill.status));
  }

  // -- 18. default credentials behind a proxy -------------------------------
  {
    const defPort = PORT + 2;
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-srv-proxy-'));
    fs.copyFileSync(path.join(__dirname, '..', 'server', 'server.js'), path.join(dir3, 'server.js'));
    fs.mkdirSync(path.join(dir3, 'public'), { recursive: true });
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'server', 'public'))) {
      fs.copyFileSync(path.join(__dirname, '..', 'server', 'public', f), path.join(dir3, 'public', f));
    }
    const srv3 = spawn(process.execPath, [path.join(dir3, 'server.js'), '--port', String(defPort)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    await sleep(900);

    const defBasic = 'Basic ' + Buffer.from('admin:admin123').toString('base64');
    const direct = await fetch('http://localhost:' + defPort + '/admin/stats',
      { headers: { authorization: defBasic } });
    check('defaults work for a genuinely local caller', direct.status === 200, String(direct.status));

    // Behind a reverse proxy every request arrives from 127.0.0.1. A forwarding
    // header is the only evidence the hop was not local, so it must be believed.
    const proxied = await fetch('http://localhost:' + defPort + '/admin/stats',
      { headers: { authorization: defBasic, 'x-forwarded-for': '203.0.113.9' } });
    check('defaults are refused when a forwarding header says the caller is remote',
      proxied.status === 401, String(proxied.status));

    try { srv3.kill(); } catch (e) {}
    try { fs.rmSync(dir3, { recursive: true, force: true }); } catch (e) {}
  }

  // -- 19. reports must carry the account behind them -----------------------
  {
    const anon = await api('POST', '/reports',
      { platform: 'threads', profileId: '4100000001', reporter: 'just-a-nickname' });
    check('a report with no platform account is refused', anon.status === 401, String(anon.status));
    check('and says why, so the extension can tell the user',
      anon.json && anon.json.error === 'signed-out', JSON.stringify(anon.json && anon.json.error));

    const noReporter = await api('POST', '/reports',
      { platform: 'threads', profileId: '4100000002' });
    check('a report with no reporter at all is refused', noReporter.status === 401, String(noReporter.status));

    const wrongPlatform = await api('POST', '/reports',
      { platform: 'threads', profileId: '4100000003', reporter: 'myspace:12345678' });
    check('an account on an unknown platform is refused',
      wrongPlatform.status === 401, String(wrongPlatform.status));

    // An account id that appears nowhere else in this suite, so finding it in
    // the store can only mean the reporter identity leaked.
    const SECRET_ACCT = 'facebook:900000000001';
    const good = await api('POST', '/reports',
      { platform: 'threads', profileId: '4100000004', reporter: SECRET_ACCT });
    check('a report carrying a real account id is accepted', good.status === 200, String(good.status));

    const raw = fs.readFileSync(path.join(dir, 'reports.json'), 'utf8');
    check('the raw account id is never written to the store',
      raw.indexOf('900000000001') < 0 && raw.indexOf('acct_') > 0,
      raw.indexOf('900000000001') < 0 ? 'absent' : 'LEAKED');

    // Same account, different report -> same pseudonym, so dedup still works.
    await api('POST', '/reports',
      { platform: 'threads', profileId: '4100000004', reporter: SECRET_ACCT });
    const q = await api('GET', '/admin/reports', undefined, BASIC);
    const rec = q.json.reports.find(r => String(r.profileId) === '4100000004');
    check('the same account reporting twice does not inflate the count',
      rec && rec.count === 1, rec ? String(rec.count) : 'missing');
  }

  // -- 20. reputation -------------------------------------------------------
  {
    const GOOD = 'threads:80000000001';   // will build a record of being right
    const BAD  = 'threads:80000000002';   // will build a record of being wrong

    // Give each of them a decided history.
    for (let i = 0; i < 6; i++) {
      await api('POST', '/reports', { platform: 'threads', profileId: '4200' + (1000 + i), reporter: GOOD });
      await api('POST', '/admin/reports/decide',
        { key: 'threads:4200' + (1000 + i), decision: 'approve' }, BASIC);
    }
    for (let i = 0; i < 6; i++) {
      await api('POST', '/reports', { platform: 'threads', profileId: '4300' + (1000 + i), reporter: BAD });
      await api('POST', '/admin/reports/decide',
        { key: 'threads:4300' + (1000 + i), decision: 'reject' }, BASIC);
    }

    // A fresh accusation from each.
    await api('POST', '/reports', { platform: 'threads', profileId: '4400001111', reporter: GOOD });
    await api('POST', '/reports', { platform: 'threads', profileId: '4400002222', reporter: BAD });

    const q = await api('GET', '/admin/reports?status=pending', undefined, BASIC);
    const byGood = q.json.reports.find(r => String(r.profileId) === '4400001111');
    const byBad  = q.json.reports.find(r => String(r.profileId) === '4400002222');

    check('a reporter with a good record carries more weight than one without',
      byGood && byBad && byGood.score > byBad.score,
      `good ${byGood && byGood.score} vs bad ${byBad && byBad.score}`);
    check('both reports still have a raw count of one',
      byGood && byBad && byGood.count === 1 && byBad.count === 1,
      `${byGood && byGood.count}/${byBad && byBad.count}`);
    check('a consistently wrong reporter falls below the trust floor',
      byBad && byBad.held === true, String(byBad && byBad.held));
    check('a consistently right reporter is not held',
      byGood && byGood.held === false, String(byGood && byGood.held));
    check('the queue ranks the trusted report above the held one',
      q.json.reports.findIndex(r => String(r.profileId) === '4400001111') <
      q.json.reports.findIndex(r => String(r.profileId) === '4400002222'),
      'good at ' + q.json.reports.findIndex(r => String(r.profileId) === '4400001111'));

    // Revoking an approval must take the credit back with it, or a reporter
    // could bank trust from a decision that was undone.
    const before = (await api('GET', '/admin/reports?status=pending', undefined, BASIC))
      .json.reports.find(r => String(r.profileId) === '4400001111').score;
    for (let i = 0; i < 6; i++) {
      await api('POST', '/admin/reports/decide',
        { key: 'threads:4200' + (1000 + i), decision: 'revoke' }, BASIC);
    }
    const after = (await api('GET', '/admin/reports?status=pending', undefined, BASIC))
      .json.reports.find(r => String(r.profileId) === '4400001111').score;
    check('revoking approvals takes the reporter trust back with it',
      after < before, `${before} -> ${after}`);

    const stats = await api('GET', '/admin/stats', undefined, BASIC);
    check('stats report how many reporters are distrusted',
      stats.json.reporters && stats.json.reporters.distrusted >= 1,
      JSON.stringify(stats.json.reporters));
    check('stats count the held reports',
      stats.json.reports.held >= 1, String(stats.json.reports.held));
    check('top reporters carry their weight alongside their volume',
      Array.isArray(stats.json.topReporters) && stats.json.topReporters[0].length === 3,
      JSON.stringify(stats.json.topReporters[0]));
  }

  // -- 21. per-account rate limiting ----------------------------------------
  {
    // Ten a minute per account, independent of address.
    let throttled = false;
    for (let i = 0; i < 14; i++) {
      const r = await api('POST', '/reports',
        { platform: 'threads', profileId: '4500' + (1000 + i), reporter: 'threads:80000000009' });
      if (r.status === 429) { throttled = true; break; }
    }
    check('one account cannot fire off unlimited reports', throttled, String(throttled));

    // A different account is unaffected -- the limit is per account, not global.
    const other = await api('POST', '/reports',
      { platform: 'threads', profileId: '4600001234', reporter: 'threads:80000000010' });
    check('throttling one account does not block another',
      other.status === 200, String(other.status));
  }

  // -- 22. regional ranking -------------------------------------------------
  //
  // A blocklist of thousands cannot be worked through by one account, so the
  // server has to say which few are worth spending a block on. Three clones,
  // identical except for where they are being reported from and when.
  {
    const VN = 'Asia/Ho_Chi_Minh', BR = 'America/Sao_Paulo';
    const mk = async (id, region, lang, reporters) => {
      for (const who of reporters) {
        await api('POST', '/reports',
          { platform: 'threads', profileId: id, reporter: who, region, lang, reason: 'clone' });
      }
      await api('POST', '/admin/reports/decide',
        { key: 'threads:' + id, decision: 'approve' }, BASIC);
    };
    await mk('5100000001', VN, 'vi-VN', ['threads:81000000001', 'threads:81000000002']);
    await mk('5100000002', BR, 'pt-BR', ['threads:81000000003', 'threads:81000000004']);
    await mk('5100000003', VN, 'vi-VN', ['threads:81000000005']);

    const vn = await api('GET',
      '/blocklist.json?platform=threads&region=' + encodeURIComponent(VN) + '&lang=vi-VN&budget=10');
    const order = (vn.json.targets || []).map(t => t.id);
    check('a ranked target slice is returned alongside the full list',
      Array.isArray(vn.json.targets) && Array.isArray(vn.json.ids) &&
      vn.json.ids.length >= vn.json.targets.length,
      `${vn.json.targets.length} targets, ${vn.json.ids.length} ids`);
    check('the local clone outranks the foreign one',
      order.indexOf('5100000001') >= 0 &&
      order.indexOf('5100000001') < order.indexOf('5100000002'),
      JSON.stringify(order.slice(0, 4)));

    const br = await api('GET',
      '/blocklist.json?platform=threads&region=' + encodeURIComponent(BR) + '&lang=pt-BR&budget=10');
    const brOrder = (br.json.targets || []).map(t => t.id);
    check('the same server ranks differently for a different region',
      brOrder.indexOf('5100000002') < brOrder.indexOf('5100000001'),
      JSON.stringify(brOrder.slice(0, 4)));

    check('a foreign clone is still reachable, just lower',
      brOrder.indexOf('5100000001') >= 0, JSON.stringify(brOrder.slice(0, 6)));

    check('every target carries the reasoning behind its rank',
      vn.json.targets[0].why && typeof vn.json.targets[0].why.velocity7d === 'number' &&
      typeof vn.json.targets[0].why.region === 'number',
      JSON.stringify(vn.json.targets[0].why));

    check('the budget caps how many targets come back',
      (await api('GET', '/blocklist.json?platform=threads&budget=1')).json.targets.length === 1,
      'budget=1');

    const fb = await api('GET', '/blocklist.json?platform=facebook&budget=10');
    check('targets are filtered to the platform that asked',
      (fb.json.targets || []).every(t => t.platform === 'facebook'),
      JSON.stringify((fb.json.targets || []).map(t => t.platform)));

    // Only approved, id-bearing accounts can be blocked.
    await api('POST', '/reports',
      { platform: 'threads', profileId: '5100000009', reporter: 'threads:81000000009', region: VN });
    const pend = await api('GET', '/blocklist.json?platform=threads&budget=50');
    check('a pending report is never handed out as a block target',
      !(pend.json.targets || []).some(t => t.id === '5100000009'),
      JSON.stringify((pend.json.targets || []).map(t => t.id)));

    // The plain list must keep working for clients that send no context.
    const plain = await api('GET', '/blocklist.json');
    check('a client that sends no context still gets the plain list',
      Array.isArray(plain.json.ids) && plain.json.targets === undefined,
      JSON.stringify(Object.keys(plain.json)));

    // Ranking must be stable within a day, or the ETag changes every poll and
    // conditional requests stop being worth anything.
    const a = await api('GET', '/blocklist.json?platform=threads&region=' + encodeURIComponent(VN));
    const b = await api('GET', '/blocklist.json?platform=threads&region=' + encodeURIComponent(VN));
    check('an unchanged ranking keeps its ETag, so polling stays cheap',
      a.etag && a.etag === b.etag, `${a.etag} vs ${b.etag}`);
  }

  // -- 23. the trending matrix ----------------------------------------------
  {
    const t = await api('GET', '/admin/trends', undefined, BASIC);
    check('the trending matrix names the regions seen',
      t.json.regions.indexOf('Asia/Ho_Chi_Minh') >= 0, JSON.stringify(t.json.regions));
    check('the matrix has one row per region and one column per day',
      t.json.matrix.length === t.json.regions.length &&
      t.json.matrix.every(r => r.length === t.json.days.length),
      `${t.json.matrix.length} x ${(t.json.matrix[0] || []).length}`);
    check('today shows the activity we just generated',
      t.json.matrix.some(row => row[row.length - 1] > 0),
      JSON.stringify(t.json.matrix.map(r => r[r.length - 1])));
    check('each region lists what is driving it',
      Array.isArray((t.json.topByRegion || {})['Asia/Ho_Chi_Minh']) &&
      t.json.topByRegion['Asia/Ho_Chi_Minh'].length > 0,
      JSON.stringify((t.json.topByRegion['Asia/Ho_Chi_Minh'] || []).map(r => r.last7)));

    const guarded = await fetch(BASE + '/admin/trends');
    check('the trending matrix is admin-only', guarded.status === 401, String(guarded.status));
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    failed.forEach(f => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  cleanup();
  process.exitCode = failed.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
