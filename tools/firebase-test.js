/**
 * Contract tests for the Firebase backend, in one command:
 *
 *   node tools/firebase-test.js
 *
 * The replacement for the retired server-test.js/report-test.js server
 * suites. Without FIRESTORE_EMULATOR_HOST set it relaunches itself under
 * `firebase emulators:exec`, so the emulator's lifetime brackets the run and
 * nothing needs starting by hand. The project id keeps the demo- prefix on
 * purpose: the emulator treats demo-* as offline-only, so nothing here can
 * ever touch production.
 *
 * Suite 1 (rules) drives the Firestore emulator over plain REST exactly the
 * way the extension and the dashboard do -- unauthenticated for the public
 * paths, an unsigned emulator JWT for the admin -- after swapping the rules'
 * pinned production admin uid for a test uid inside the emulator. The rules
 * file on disk is never edited.
 *
 * Suite 2 (logic) requires hosting/logic.js directly and asserts the ported
 * formulas against fixture documents: the same aggregation, reputation,
 * publish, stats, trends and ranking behaviors the old server suite proved
 * over HTTP.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PROJECT = 'demo-clone';
const ROOT = path.join(__dirname, '..');

// -- bootstrap: relaunch under the emulator when not already inside one ------
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  const { spawn } = require('child_process');
  // The firebase CLI is not on PATH here; firebase-tools keeps its entry
  // script in the user cache. FIREBASE_CLI overrides for machines that keep
  // it elsewhere.
  const cli = process.env.FIREBASE_CLI ||
    path.join(os.homedir(), '.cache', 'firebase', 'tools', 'bin', 'firebase');
  if (!fs.existsSync(cli)) {
    console.error('firebase CLI not found at ' + cli + ' -- set FIREBASE_CLI to its entry script');
    process.exit(1);
  }
  // cwd must be the repo root so emulators:exec finds firebase.json, which
  // carries the emulator ports and preloads firestore.rules.
  // The emulator needs JDK 21+; the machine's default java may be older.
  const { javaEnv } = require('./java-env.js');
  const child = spawn(process.execPath,
    [cli, 'emulators:exec', '--only', 'firestore', '--project', PROJECT,
     'node tools/firebase-test.js'],
    { cwd: ROOT, stdio: 'inherit', env: javaEnv() });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
  return;
}

// -- harness (same shape as the old server-test.js) --------------------------
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const ADMIN_UID = 'test-admin';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(method, p, body, auth) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const r = await fetch(BASE + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* deletes return an empty body */ }
  return { status: r.status, json };
}

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
const ADMIN = bearer(ADMIN_UID);
const OWNER = 'Bearer owner';   // rules bypass; used only to seed fixtures

// The same derivation the extension uses for the reporter pseudonym.
const hashOf = (ref) =>
  'acct_' + crypto.createHash('sha256').update(ref).digest('hex').slice(0, 24);

// Firestore REST value encoding. Every report field is a string, so the
// generic encoder only needs stringValue.
const enc = (obj) => {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = { stringValue: String(obj[k]) };
  return { fields };
};

/** A fully valid report body; rejection tests then break one field at a time. */
function reportBody(target, who, extra) {
  const body = { platform: 'threads', target, reason: 'clone', reporterHash: who };
  if (/^\d+$/.test(target)) body.profileId = target;
  else body.username = target.slice(1);
  Object.assign(body, extra || {});
  body.dedupKey = body.platform + '~' + body.target + '~' + body.reporterHash;
  return body;
}

const createReport = (body, docId) => api('POST',
  '/reports?documentId=' + encodeURIComponent(docId !== undefined ? docId : body.dedupKey),
  enc(body));

// Swap the pinned PRODUCTION admin uid for the test uid inside the emulator
// only -- the file on disk stays exactly as deployed, and the uid is read out
// of it rather than repeated here so re-pinning cannot desync the tests.
async function swapRules() {
  const src = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const m = src.match(/request\.auth\.uid == '([^']+)'/);
  if (!m) throw new Error('could not find the pinned admin uid in firestore.rules');
  const r = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { files: [
      { name: 'firestore.rules', content: src.split(m[1]).join(ADMIN_UID) }
    ] } })
  });
  if (r.status !== 200) {
    throw new Error('rules swap failed: ' + r.status + ' ' + (await r.text()));
  }
}

(async () => {
  await swapRules();

  // ==========================================================================
  // Suite 1: the security rules, over REST
  // ==========================================================================

  // -- 1. the public blocklist ----------------------------------------------
  const listDoc = (payload, rev) => ({ fields: {
    json: { stringValue: JSON.stringify(payload) },
    updatedAt: { timestampValue: new Date().toISOString() },
    rev: { integerValue: String(rev) }
  } });
  const seedPayload = { v: 1, updatedAt: new Date().toISOString(),
    ids: ['63082166531'], usernames: ['threads'], docIdOverrides: {},
    pending: [], targets: [] };
  await api('PATCH', '/blocklist/current', listDoc(seedPayload, 1), OWNER);

  const pub = await api('GET', '/blocklist/current');
  const pubJson = pub.json && pub.json.fields && pub.json.fields.json
    ? JSON.parse(pub.json.fields.json.stringValue) : null;
  check('the published blocklist is publicly readable',
    pub.status === 200 && pubJson && pubJson.ids.includes('63082166531'),
    String(pub.status));

  const strangerList = await api('PATCH', '/blocklist/current', listDoc(seedPayload, 2));
  check('a stranger cannot write the blocklist', strangerList.status === 403, String(strangerList.status));

  const adminList = await api('PATCH', '/blocklist/current', listDoc(seedPayload, 2), ADMIN);
  check('the admin can write the blocklist', adminList.status === 200, String(adminList.status));

  // -- 2. report intake: what the rules accept ------------------------------
  const H1 = hashOf('threads:70000039595');
  const H2 = hashOf('threads:70000047514');

  const full = reportBody('9100000001', H1, {
    username: 'nguyenvana.clone',
    displayName: 'Fake Nguyễn Văn A',
    url: 'https://www.threads.com/@nguyenvana.clone',
    note: 'copied bio and photos',
    postUrl: 'https://www.threads.com/@nguyenvana.clone/post/AAA',
    postId: 'AAA',
    contentSummary: 'first suspicious post',
    region: 'Asia/Ho_Chi_Minh',
    lang: 'vi-vn'
  });
  const ok1 = await createReport(full);
  check('a fully populated numeric-target report is accepted', ok1.status === 200, String(ok1.status));

  const ok2 = await createReport(reportBody('@nguyenvana.clone', H1, { reason: 'impersonation' }));
  check('a username-target report is accepted', ok2.status === 200, String(ok2.status));

  // Every rejection case below mutates one field of an otherwise valid
  // report, so a FAIL points at the named validation and never at a broken
  // fixture. The dedup key is recomputed after the mutation on purpose: the
  // key must stay consistent so only the named field is at fault.
  let caseN = 0;
  async function rejects(name, mutate) {
    caseN++;
    const b = reportBody(String(8200000000 + caseN), hashOf('threads:7900000' + caseN), {});
    mutate(b);
    b.dedupKey = b.platform + '~' + b.target + '~' + b.reporterHash;
    const r = await createReport(b);
    check(name, r.status === 403, String(r.status));
  }

  await rejects('an unknown platform is rejected', b => { b.platform = 'myspace'; });
  await rejects('a report with no reason is rejected', b => { delete b.reason; });
  await rejects('an unlisted reason is rejected', b => { b.reason = 'because'; });
  await rejects('an 81-char display name is rejected', b => { b.displayName = 'x'.repeat(81); });
  await rejects('a 401-char note is rejected', b => { b.note = 'x'.repeat(401); });
  await rejects('a 401-char content summary is rejected', b => { b.contentSummary = 'x'.repeat(401); });
  await rejects('a 65-char post id is rejected', b => { b.postId = 'x'.repeat(65); });
  await rejects('a javascript: profile url is rejected', b => { b.url = 'javascript:alert(1)'; });
  await rejects('an over-long post url is rejected',
    b => { b.postUrl = 'https://evil.example/' + 'a'.repeat(300); });
  await rejects('a malformed region is rejected', b => { b.region = 'not a region!!'; });
  await rejects('a malformed language is rejected', b => { b.lang = 'x'; });
  await rejects('a raw account reference is not a reporter hash',
    b => { b.reporterHash = 'threads:79000000000'; });
  await rejects('a numeric target must carry its profile id', b => { delete b.profileId; });
  await rejects('a 500-digit profile id is rejected',
    b => { b.target = '1'.repeat(500); b.profileId = b.target; });
  await rejects('an unknown extra field is rejected', b => { b.extra = 'x'; });

  const claims = reportBody('@claimsanid', H2, {});
  claims.profileId = '12345678';
  check('a username target cannot also claim a profile id',
    (await createReport(claims)).status === 403);

  const skewed = reportBody('8300000001', H1, {});
  skewed.dedupKey = 'threads~8300000999~' + H1;   // a key for a different target
  check('a dedup key that contradicts the fields is rejected',
    (await createReport(skewed, skewed.dedupKey)).status === 403);

  check('a document id that is not the dedup key is rejected',
    (await createReport(reportBody('8300000002', H1, {}), 'some-other-id')).status === 403);

  // -- 3. dedup: the document id IS the one-report-per-reporter rule --------
  const again = await createReport(full);
  check('the same reporter reporting the same target again conflicts',
    again.status === 409, String(again.status));

  const second = await createReport(reportBody('9100000001', H2, {}));
  check('a different reporter creates a second document', second.status === 200, String(second.status));

  // -- 4. reports are write-only for the public -----------------------------
  const docPath = '/reports/' + encodeURIComponent(full.dedupKey);
  check('a stranger cannot read a report back', (await api('GET', docPath)).status === 403);
  check('a stranger cannot list the reports', (await api('GET', '/reports')).status === 403);
  const adminRead = await api('GET', docPath, undefined, ADMIN);
  check('the admin can read a report',
    adminRead.status === 200 && adminRead.json.fields.platform.stringValue === 'threads',
    String(adminRead.status));

  check('a stranger cannot edit a report',
    (await api('PATCH', docPath, enc({ note: 'rewritten' }))).status === 403);
  check('a stranger cannot delete a report', (await api('DELETE', docPath)).status === 403);

  const disposable = reportBody('8400000001', H1, {});
  await createReport(disposable);
  const del = await api('DELETE', '/reports/' + encodeURIComponent(disposable.dedupKey), undefined, ADMIN);
  check('the admin can delete a report', del.status === 200, String(del.status));

  // -- 5. decisions and the manual list are the admin's alone ---------------
  const decision = { fields: {
    status: { stringValue: 'approved' },
    by: { stringValue: 'admin' },
    at: { timestampValue: new Date().toISOString() }
  } };
  check('a stranger cannot write a decision',
    (await api('PATCH', '/decisions/threads~9100000001', decision)).status === 403);
  check('the admin can write a decision',
    (await api('PATCH', '/decisions/threads~9100000001', decision, ADMIN)).status === 200);

  const manual = { fields: {
    ids: { arrayValue: { values: [{ stringValue: '63082166531' }] } },
    usernames: { arrayValue: {} },
    docIdOverrides: { mapValue: {} }
  } };
  check('a stranger cannot write the manual list',
    (await api('PATCH', '/admin/manual', manual)).status === 403);
  check('the admin can write the manual list',
    (await api('PATCH', '/admin/manual', manual, ADMIN)).status === 200);

  // -- 6. the raw account id never reaches the store ------------------------
  // An account id that appears nowhere else in this suite, so finding it in a
  // dump can only mean the reporter identity leaked past the hashing.
  const SECRET = 'threads:900000000001';
  const carried = await createReport(reportBody('4100000004', hashOf(SECRET), {}));
  check('a report derived from a real account id is accepted', carried.status === 200, String(carried.status));

  const dump = await api('GET', '/reports?pageSize=300', undefined, ADMIN);
  const rawDump = JSON.stringify(dump.json);
  check('the raw account id is never stored',
    dump.status === 200 && rawDump.indexOf('900000000001') < 0 && rawDump.indexOf('acct_') > 0,
    rawDump.indexOf('900000000001') < 0 ? 'absent' : 'LEAKED');

  // ==========================================================================
  // Suite 2: the ported logic, straight from hosting/logic.js
  // ==========================================================================
  const L = require(path.join(ROOT, 'hosting', 'logic.js'));
  const DAY = 86400000;
  const at = (daysAgo, plusMs) => new Date(Date.now() - daysAgo * DAY + (plusMs || 0)).toISOString();

  let seq = 0;
  /** A fixture report document in the shape the dashboard reads from Firestore. */
  function doc(target, who, opts) {
    const o = opts || {};
    const data = { platform: 'threads', target, reason: o.reason || 'clone', reporterHash: who };
    if (/^\d+$/.test(target)) data.profileId = target;
    else data.username = target.slice(1);
    for (const k of ['username', 'displayName', 'url', 'note', 'postUrl', 'postId',
                     'contentSummary', 'region', 'lang']) {
      if (o[k] !== undefined) data[k] = o[k];
    }
    data.dedupKey = data.platform + '~' + target + '~' + who;
    return { id: data.dedupKey, createTime: o.at || at(0, -(++seq)), data };
  }
  const dec = (key, status, atIso) =>
    ({ id: key.replace(':', '~'), data: { status, by: 'admin', at: atIso || at(0) } });

  // -- 7. aggregation: immutable documents -> the old per-account record ----
  const agg = L.aggregate([
    doc('9100000001', H1, { at: at(3), displayName: 'Fake Nguyễn Văn A',
      note: 'copied bio and photos', postUrl: 'https://t.example/p1', postId: 'AAA',
      contentSummary: 'first suspicious post', region: 'Asia/Ho_Chi_Minh', lang: 'vi-vn' }),
    doc('9100000001', H2, { at: at(0), displayName: 'Renamed Later',
      postUrl: 'https://t.example/p1', region: 'Asia/Ho_Chi_Minh', lang: 'vi-vn' })
  ], [])[0];
  check('two reporters aggregate to a count of two',
    agg.count === 2 && agg.reporters.length === 2, String(agg.count));
  check('the same post url is stored once', agg.posts.length === 1, String(agg.posts.length));
  check('notes and evidence ride along',
    agg.notes.some(n => n.text === 'copied bio and photos') && agg.posts[0].postId === 'AAA');
  check('late detail fills gaps but never overwrites',
    agg.displayName === 'Fake Nguyễn Văn A', agg.displayName);
  check('reports bucket by their creation day, in UTC',
    agg.days[L.dayKey(Date.now() - 3 * DAY)] === 1 && agg.days[L.dayKey(Date.now())] === 1,
    JSON.stringify(agg.days));

  const sameReporter = L.aggregate([
    doc('9200000001', H1, { at: at(2) }),
    doc('9200000001', H1, { at: at(1) })
  ], [])[0];
  check('the same reporter cannot be counted twice', sameReporter.count === 1, String(sameReporter.count));

  const fills = L.aggregate([
    doc('9300000001', H1, { at: at(2) }),
    doc('9300000001', H2, { at: at(1), displayName: 'Filled Later' })
  ], [])[0];
  check('a missing display name is filled by a later report', fills.displayName === 'Filled Later');

  const textOnly = L.aggregate([doc('9400000001', H1, { contentSummary: 'text only evidence' })], [])[0];
  check('evidence with no url is still kept for its text',
    textOnly.posts.length === 1 && textOnly.posts[0].url === null &&
    textOnly.posts[0].summary === 'text only evidence');

  // -- 8. publish: what the world is allowed to see -------------------------
  const pubDocs = [
    doc('6100000001', H1, { username: 'someclone' }),
    doc('@nameonly', H2, {}),
    doc('7100000001', H1, {}),
    doc('7200000001', H2, {})
  ];
  const pubRecs = L.aggregate(pubDocs, [
    dec('threads:6100000001', 'approved'),
    dec('threads:@nameonly', 'approved'),
    dec('threads:7200000001', 'rejected')
  ]);
  const payload = L.buildPublish(pubRecs, L.reputation(pubRecs), {});
  check('an approved id-bearing target publishes its id, not its username',
    payload.ids.includes('6100000001') && !payload.usernames.includes('someclone'),
    JSON.stringify(payload.usernames));
  check('an approved username-only target publishes the username',
    payload.usernames.includes('nameonly'));
  check('pending and rejected targets publish nothing',
    !payload.ids.includes('7100000001') && !payload.ids.includes('7200000001') &&
    payload.usernames.length === 1,
    JSON.stringify(payload.ids));
  // The single most safety-critical publish semantic: pending is never
  // blockable, so a pending id must not exist in targets either.
  check('a pending id never appears in targets',
    !payload.targets.some(t => t.id === '7100000001'),
    JSON.stringify(payload.targets.map(t => t.id)));
  check('pending keys are published as status only',
    payload.pending.includes('threads:7100000001') &&
    !payload.pending.includes('threads:7200000001'));

  const revoked = L.aggregate(pubDocs, [
    dec('threads:6100000001', 'pending'),          // revoke = back to pending
    dec('threads:@nameonly', 'approved'),
    dec('threads:7200000001', 'rejected')
  ]);
  const payload2 = L.buildPublish(revoked, L.reputation(revoked), {});
  check('revoking an approval removes the id on recompute',
    !payload2.ids.includes('6100000001') && !payload2.targets.some(t => t.id === '6100000001'),
    JSON.stringify(payload2.ids));

  const reopened = L.aggregate([
    doc('7300000001', H1, { at: at(3) }),
    doc('7300000001', H2, { at: at(0) })           // a NEW reporter, after the verdict
  ], [dec('threads:7300000001', 'rejected', at(2))]);
  check('a new reporter after a rejection reopens the case',
    reopened[0].status === 'pending', reopened[0].status);

  const settled = L.aggregate([doc('7300000002', H1, { at: at(3) })],
    [dec('threads:7300000002', 'rejected', at(2))]);
  check('a rejection with no fresh reports stays rejected',
    settled[0].status === 'rejected', settled[0].status);

  // -- 9. reputation: derived from current decisions, never banked ----------
  const GOOD = hashOf('threads:80000000001');
  const BAD = hashOf('threads:80000000002');
  const repDocs = [], repDecs = [];
  for (let i = 0; i < 5; i++) {
    repDocs.push(doc('4200100' + i, GOOD, {}));
    repDecs.push(dec('threads:4200100' + i, 'approved'));
    repDocs.push(doc('4300100' + i, BAD, {}));
    repDecs.push(dec('threads:4300100' + i, 'rejected'));
  }
  repDocs.push(doc('4400001111', GOOD, { at: at(2) }));
  repDocs.push(doc('4400002222', BAD, {}));
  repDocs.push(doc('4500009999', BAD, {}));
  repDocs.push(doc('4500009999', GOOD, {}));
  const repRecs = L.aggregate(repDocs, repDecs);
  const rep = L.reputation(repRecs);

  const wGood = L.trustOf(rep, GOOD), wBad = L.trustOf(rep, BAD);
  check('five upheld reports weigh 5.5/6', Math.abs(wGood - 5.5 / 6) < 1e-9, wGood.toFixed(3));
  check('an unknown reporter sits at exactly one half', L.trustOf(rep, hashOf('threads:0')) === 0.5);
  check('five rejections weigh 0.5/6, below the trust floor',
    Math.abs(wBad - 0.5 / 6) < 1e-9 && wBad < L.TRUST_FLOOR, wBad.toFixed(3));

  const rows = L.sortQueue(repRecs.filter(r => r.status === 'pending').map(r => L.withTrust(r, rep)));
  const byGood = rows.find(r => r.profileId === '4400001111');
  const byBad = rows.find(r => r.profileId === '4400002222');
  const mixed = rows.find(r => r.profileId === '4500009999');
  check('trust moves the score, never the raw count',
    byGood.score > byBad.score && byGood.count === 1 && byBad.count === 1,
    `${byGood.score} vs ${byBad.score}`);
  check('a report backed only by distrusted reporters is held', byBad.held === true);
  check('one reporter with a good record keeps a report out of held', mixed.held === false);
  check('the queue puts held rows last and higher scores first',
    rows[rows.length - 1].held === true &&
    rows.indexOf(mixed) === 0 &&
    rows.indexOf(byGood) < rows.indexOf(byBad),
    rows.map(r => r.profileId).join(','));

  const clawDecs = repDecs.map(d => d.data.status === 'approved'
    ? { id: d.id, data: { status: 'pending', by: 'admin', at: at(0) } } : d);
  const clawRecs = L.aggregate(repDocs, clawDecs);
  const claw = L.withTrust(clawRecs.find(r => r.profileId === '4400001111'), L.reputation(clawRecs));
  check('revoking approvals claws the reporter trust back',
    claw.score < byGood.score, `${byGood.score} -> ${claw.score}`);

  // -- 10. stats: the dashboard's overview numbers --------------------------
  const stats = L.buildStats(repRecs, rep, L.buildPublish(repRecs, rep, {}));
  const shapeOk =
    ['reports', 'reporters', 'blocklist', 'byPlatform', 'byReason', 'perDay', 'topReporters']
      .every(k => k in stats) &&
    ['total', 'pending', 'approved', 'rejected', 'withEvidence', 'held', 'totalSubmissions']
      .every(k => k in stats.reports);
  check('stats carry the exact dashboard shape', shapeOk, JSON.stringify(Object.keys(stats)));
  check('total submissions is the sum of the counts',
    stats.reports.totalSubmissions === repRecs.reduce((n, r) => n + r.count, 0),
    String(stats.reports.totalSubmissions));
  check('distrusted counts reporters under the trust floor',
    stats.reporters.distrusted === 1, String(stats.reporters.distrusted));
  check('stats count the held reports', stats.reports.held === 6, String(stats.reports.held));
  check('top reporters carry their weight alongside their volume',
    Array.isArray(stats.topReporters) && stats.topReporters[0].length === 3,
    JSON.stringify(stats.topReporters[0]));
  const dk2 = L.dayKey(Date.now() - 2 * DAY);
  const bucket = stats.perDay.find(d => d.day === dk2);
  check('perDay is keyed on the record creation day',
    stats.perDay.length === 14 && bucket && bucket.count === 1, JSON.stringify(bucket));

  // -- 11. trends: where the clones are operating ---------------------------
  const VN = 'Asia/Ho_Chi_Minh', BR = 'America/Sao_Paulo';
  const TG = hashOf('threads:80000000003');
  const trendRecs = L.aggregate([
    doc('8100000001', hashOf('t:1'), { region: VN, at: at(0) }),
    doc('8100000001', hashOf('t:2'), { region: VN, at: at(1) }),
    doc('8100000001', hashOf('t:3'), { region: VN, at: at(0, -1) }),
    doc('8100000001', hashOf('t:4'), { region: BR, at: at(0, -2) }),
    doc('8100000002', hashOf('t:5'), { region: VN, at: at(0) }),
    doc('8100000003', TG, { region: VN, at: at(0) }),
    doc('8100000004', hashOf('t:7'), { region: VN, at: at(0) }),
    // No region on this one: it exists only to give TG an upheld record, so
    // it must stay out of the matrix entirely.
    doc('8200000001', TG, { at: at(1) })
  ], [dec('threads:8200000001', 'approved')]);
  const tm = L.trendMatrix(trendRecs, { days: 14 });
  check('the matrix has one row per region and one column per day',
    tm.matrix.length === tm.regions.length && tm.matrix.every(r => r.length === tm.days.length),
    `${tm.matrix.length} x ${(tm.matrix[0] || []).length}`);
  check('the matrix names every region seen',
    tm.regions.includes(VN) && tm.regions.includes(BR), JSON.stringify(tm.regions));
  const rowVN = tm.matrix[tm.regions.indexOf(VN)];
  const rowBR = tm.matrix[tm.regions.indexOf(BR)];
  check('day history follows the dominant region',
    rowVN.reduce((n, v) => n + v, 0) === 7 && rowBR.every(v => v === 0),
    JSON.stringify({ vn: rowVN.reduce((n, v) => n + v, 0), br: rowBR.reduce((n, v) => n + v, 0) }));
  const top = tm.topByRegion[VN];
  check('each region lists its busiest targets first',
    top[0].key === 'threads:8100000001' && top[0].last7 === 4,
    JSON.stringify(top.map(r => [r.key, r.last7, r.trust])));
  check('equal activity is ordered by reporter trust',
    top.findIndex(r => r.key === 'threads:8100000003') <
    top.findIndex(r => r.key === 'threads:8100000004'));

  // -- 12. ranking: the block budget is spent near the caller ---------------
  const rankRecs = L.aggregate([
    doc('5100000001', hashOf('threads:81000000001'), { region: VN, lang: 'vi-vn' }),
    doc('5100000001', hashOf('threads:81000000002'), { region: VN, lang: 'vi-vn' }),
    doc('5100000002', hashOf('threads:81000000003'), { region: BR, lang: 'pt-br' }),
    doc('5100000002', hashOf('threads:81000000004'), { region: BR, lang: 'pt-br' }),
    doc('5100000003', hashOf('threads:81000000005'), { region: VN, lang: 'vi-vn' })
  ], ['5100000001', '5100000002', '5100000003'].map(id => dec('threads:' + id, 'approved')));
  const published = L.buildPublish(rankRecs, L.reputation(rankRecs), {});
  check('approved id-bearing targets are published with their metadata',
    published.targets.length === 3 && typeof published.targets[0].trust === 'number',
    String(published.targets.length));

  const vn = L.rankTargets(published.targets, { region: VN, lang: 'vi-vn', platform: 'threads' });
  const vnIds = vn.map(t => t.id);
  check('the local clone outranks the foreign one',
    vnIds.indexOf('5100000001') >= 0 && vnIds.indexOf('5100000001') < vnIds.indexOf('5100000002'),
    JSON.stringify(vnIds));
  check('a foreign clone is still reachable, just lower',
    vnIds.includes('5100000002'), JSON.stringify(vnIds));

  const br = L.rankTargets(published.targets, { region: BR, lang: 'pt-br', platform: 'threads' });
  const brIds = br.map(t => t.id);
  check('the same data ranks differently for a different region',
    brIds.indexOf('5100000002') < brIds.indexOf('5100000001'), JSON.stringify(brIds));

  const noCtx = L.rankTargets(published.targets, {});
  check('no client context means neutral locality for everyone',
    noCtx.every(t => t.why.region === 1 && t.why.lang === 1),
    JSON.stringify(noCtx.map(t => t.why.region)));
  check('every target carries the reasoning behind its rank',
    typeof vn[0].why.velocity7d === 'number' && typeof vn[0].why.region === 'number',
    JSON.stringify(vn[0].why));

  // The ported quirk: language affinity divides by the REGION total. With an
  // empty regions tally the denominator is 1, so a four-report language tally
  // yields (4 + 0.5) / 1 = 4.5 -- impossible for a true share, and exactly
  // what the server produced. If this reads 0.9 someone "fixed" the quirk and
  // rankings no longer match the old ones.
  const quirk = L.rankTargets([{
    platform: 'threads', id: '9999000001', username: null, displayName: null,
    trust: 1, last: L.dayKey(Date.now()), days: {}, regions: {}, langs: { 'vi-vn': 4 }
  }], { lang: 'vi-vn' });
  check('language affinity divides by the region total, as the server did',
    quirk[0].why.lang === 4.5, String(quirk[0].why.lang));

  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    failed.forEach(f => console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')));
  }
  process.exitCode = failed.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
