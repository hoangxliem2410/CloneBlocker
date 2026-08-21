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
 * over HTTP, plus the tag vocabulary layered on top of them and the ranking
 * dials, whose expected numbers are worked out by hand here so that a change
 * to the formula cannot pass as a rounding difference.
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

  // blocklist/publicView -- the transparency page's copy of what may be said
  // out loud. It sits in the same collection as `current`, under the same
  // rule, and that is deliberate: one place decides who may publish a list, so
  // the document the extension acts on and the document that names people
  // cannot drift into two different trust models. Public read is what the page
  // needs (it fetches this unauthenticated, exactly as the extension fetches
  // `current`); admin-only write is what stops a stranger adding a name to it.
  const viewPayload = { v: 1, updatedAt: new Date().toISOString(),
    counts: { published: 1, blocked: 1, reports: 1, byTag: { clone: 1 } },
    profiles: [{ platform: 'threads', id: '9100000001', username: 'someone',
      displayName: 'Someone', tag: 'clone', reports: 1,
      firstReported: '2026-08-07', lastActive: '2026-08-21',
      regions: ['Asia/Ho_Chi_Minh'], evidence: [] }] };
  await api('PATCH', '/blocklist/publicView', listDoc(viewPayload, 1), OWNER);

  const viewRead = await api('GET', '/blocklist/publicView');
  const viewJson = viewRead.json && viewRead.json.fields && viewRead.json.fields.json
    ? JSON.parse(viewRead.json.fields.json.stringValue) : null;
  check('the public view is readable without signing in',
    viewRead.status === 200 && viewJson && viewJson.profiles.length === 1,
    String(viewRead.status));
  check('a stranger cannot write the public view',
    (await api('PATCH', '/blocklist/publicView', listDoc(viewPayload, 2))).status === 403);
  check('the admin can write the public view',
    (await api('PATCH', '/blocklist/publicView', listDoc(viewPayload, 2), ADMIN)).status === 200);

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

  // `redbull` is the tag this phase added, and the enum is the only place a
  // vote can be refused -- an extension that offers the reason against rules
  // that do not know it would fail silently at submit time.
  const okRb = await createReport(reportBody('9100000009', H1, { reason: 'redbull' }));
  check('a report with the redbull reason is accepted', okRb.status === 200, String(okRb.status));

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
  // A near miss on a real tag is the failure mode that matters now that the
  // vocabulary is growing: the enum, not the spelling, is what decides.
  await rejects('a reason that only looks like a tag is rejected', b => { b.reason = 'red-bull'; });

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

  // The verdict half of the tag vocabulary. The rules do not gate WHO may
  // retag -- that is already admin-only -- they gate the spelling, because a
  // tag outside the list would publish an idTags entry no install matches and
  // so would quietly stop being blocked by anybody.
  const tagged = (tag) => ({ fields: {
    status: { stringValue: 'approved' },
    by: { stringValue: 'admin' },
    at: { timestampValue: new Date().toISOString() },
    tag: { stringValue: tag }
  } });
  const tagOk = await api('PATCH', '/decisions/threads~9600000001', tagged('redbull'), ADMIN);
  check('the admin can set a decision tag from the vocabulary',
    tagOk.status === 200, String(tagOk.status));
  const tagStranger = await api('PATCH', '/decisions/threads~9600000002', tagged('redbull'));
  check('a stranger cannot set a decision tag either',
    tagStranger.status === 403, String(tagStranger.status));
  const tagBad = await api('PATCH', '/decisions/threads~9600000003', tagged('bo-do'), ADMIN);
  check('a decision tag outside the vocabulary is refused',
    tagBad.status === 403, String(tagBad.status));

  // The transparency opt-in, as the rules see it. Who may set it was never in
  // question -- the whole document is admin-only -- so what is worth pinning
  // is that it survives the write at all, and that nothing but a boolean can
  // occupy the field. A `public` holding the string 'false' would be truthy to
  // every reader downstream, which is the one way this flag could put a name
  // on a page nobody agreed to name.
  const decPublic = (value) => ({ fields: {
    status: { stringValue: 'approved' },
    by: { stringValue: 'admin' },
    at: { timestampValue: new Date().toISOString() },
    public: value
  } });
  const pubOk = await api('PATCH', '/decisions/threads~9700000001',
    decPublic({ booleanValue: true }), ADMIN);
  check('the admin can opt a decision in to the public page',
    pubOk.status === 200, String(pubOk.status));
  const pubStranger = await api('PATCH', '/decisions/threads~9700000002',
    decPublic({ booleanValue: true }));
  check('a stranger cannot opt a decision in to the public page',
    pubStranger.status === 403, String(pubStranger.status));
  const pubBad = await api('PATCH', '/decisions/threads~9700000003',
    decPublic({ stringValue: 'true' }), ADMIN);
  check('a public flag that is not a boolean is refused',
    pubBad.status === 403, String(pubBad.status));

  // isAdmin() is a membership test against a LIST of uids: a Google sign-in
  // mints a different uid than the password account, and one person moderating
  // through either has to be the same admin. Widening a single pinned uid into
  // a list is precisely the change that can accidentally widen it to everyone
  // signed in, so both directions are held down -- the uid in the list is an
  // admin, and another perfectly valid signed-in uid is not.
  const inList = await api('PATCH', '/decisions/threads~9800000001', decision, ADMIN);
  check('the uid pinned in the admin list is an admin',
    inList.status === 200, String(inList.status));
  const outsider = await api('PATCH', '/decisions/threads~9800000002', decision,
    bearer('signed-in-but-not-an-admin'));
  check('a signed-in uid outside the admin list is not an admin',
    outsider.status === 403, String(outsider.status));

  // The shape the list is written in, read off the file rather than the
  // emulator: tools/firebase-setup.js --add-admin rewrites this literal with a
  // regex, and swapRules() above re-pins it by plain string replacement, so a
  // rules file that stopped spelling the allowlist this way would leave both
  // tools editing something that is no longer there.
  {
    const src = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const body = /function adminUids\(\)\s*\{\s*return \[([^\]]*)\]/.exec(src);
    const listed = body ? [...body[1].matchAll(/'([^']+)'/g)].map(q => q[1]) : [];
    const pinned = (src.match(/request\.auth\.uid == '([^']+)'/) || [])[1];
    check('isAdmin() tests membership of a uid list that holds the pinned admin',
      /request\.auth\.uid in adminUids\(\)/.test(src) &&
      listed.length >= 1 && listed.includes(pinned),
      JSON.stringify(listed));
  }

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

  // -- 13. tags: the verdict derived from the votes -------------------------
  //
  // A report's reason is a vote and a target's tag is the verdict, drawn from
  // the same vocabulary. These pin the resolution order -- admin, then modal
  // reason, then TAGS order, then 'clone' -- because every one of those steps
  // is a place where a wrong answer would still look like a plausible tag.
  const decTag = (key, tag, status, atIso) => ({
    id: key.replace(':', '~'),
    data: { status: status || 'approved', by: 'admin', at: atIso || at(0), tag }
  });
  const H3 = hashOf('threads:70000051111');
  // The case is OPENED as harassment and then out-voted: reason and tag are
  // deliberately different here, so a tag taken from the wrong one fails.
  const voteDocs = (id) => [
    doc(id, H1, { at: at(3), reason: 'harassment' }),
    doc(id, H2, { at: at(2), reason: 'scam' }),
    doc(id, H3, { at: at(1), reason: 'scam' })
  ];

  const modal = L.aggregate(voteDocs('3100000001'), [])[0];
  check('every reason is tallied, not just the one that opened the case',
    modal.reasons.scam === 2 && modal.reasons.harassment === 1 &&
    modal.reason === 'harassment',
    JSON.stringify(modal.reasons));
  check('the most common reason becomes the tag, not the first one filed',
    modal.tag === 'scam', modal.tag);

  const override = L.aggregate(voteDocs('3100000002'),
    [decTag('threads:3100000002', 'redbull')])[0];
  check('an admin tag beats the modal reason', override.tag === 'redbull', override.tag);

  const nonsense = L.aggregate(voteDocs('3100000003'),
    [decTag('threads:3100000003', 'bo-do')])[0];
  check('an admin tag outside the vocabulary falls back to the votes',
    nonsense.tag === 'scam', nonsense.tag);

  const tied = L.aggregate([
    doc('3100000004', H1, { reason: 'spam' }),
    doc('3100000004', H2, { reason: 'scam' })
  ], [])[0];
  check('a tie breaks toward whichever tag comes first in TAGS',
    tied.tag === 'scam' && L.modalTag({ other: 3, redbull: 3 }) === 'redbull',
    tied.tag);
  check('TAGS order is the tiebreak, not insertion order',
    L.TAGS.indexOf('scam') < L.TAGS.indexOf('spam') &&
    L.TAGS.indexOf('redbull') < L.TAGS.indexOf('other'),
    JSON.stringify(L.TAGS));

  // Asserted against the HEAD of TAGS rather than against a name. The head is
  // a product decision that has already moved once (redbull was made the
  // first and default reason), and a test that spells the name out just has
  // to be edited every time -- which teaches nobody anything and eventually
  // gets edited without being reread.
  const unusable = L.aggregate([doc('3100000005', H1, { reason: 'because' })], [])[0];
  check('a target with no usable reason falls back to the head of TAGS',
    unusable.tag === L.TAGS[0] && Object.keys(unusable.reasons).length === 0,
    unusable.tag + ' (TAGS[0]=' + L.TAGS[0] + ')');
  check('effectiveTag resolves the same way when asked directly',
    L.effectiveTag(null, {}) === L.TAGS[0] &&
    L.effectiveTag({ tag: 'redbull' }, { scam: 9 }) === 'redbull' &&
    L.effectiveTag({ tag: '' }, { scam: 9 }) === 'scam');

  // The head of the list is what the report sheet offers before anybody
  // touches it, so the two must not drift apart.
  check('the reason offered first is the tag an unread target gets',
    L.TAGS[0] === 'redbull', L.TAGS[0]);

  // A verdict about what an account IS does not expire because one more
  // person reported it, so the tag has to outlive the reopening.
  const retagged = L.aggregate([
    doc('3100000006', H1, { at: at(3), reason: 'scam' }),
    doc('3100000006', H2, { at: at(0), reason: 'scam' })
  ], [decTag('threads:3100000006', 'redbull', 'rejected', at(2))])[0];
  check('an admin tag survives a case reopening',
    retagged.status === 'pending' && retagged.tag === 'redbull',
    retagged.status + '/' + retagged.tag);

  // -- 14. publish: the tag map the extension filters on --------------------
  const tagRecs = L.aggregate([
    doc('2100000001', H1, { reason: 'redbull' }),
    doc('2100000001', H2, { reason: 'redbull' }),
    doc('2100000002', H1, { reason: 'scam' }),
    doc('2100000003', H1, { reason: 'spam' }),          // never decided
    doc('@tagnameonly', H2, { reason: 'scam' })
  ], [
    dec('threads:2100000001', 'approved'),
    decTag('threads:2100000002', 'impersonation'),
    dec('threads:@tagnameonly', 'approved')
  ]);
  const tagPub = L.buildPublish(tagRecs, L.reputation(tagRecs), { ids: ['2900000009'] });
  const pubById = Object.fromEntries(tagPub.targets.map(t => [t.id, t]));
  check('a published target carries its tag and its headcount',
    pubById['2100000001'].tag === 'redbull' && pubById['2100000001'].reporters === 2 &&
    pubById['2100000002'].tag === 'impersonation' && pubById['2100000002'].reporters === 1,
    JSON.stringify(tagPub.targets.map(t => [t.id, t.tag, t.reporters])));
  check('idTags covers exactly the published ids',
    Object.keys(tagPub.idTags).sort().join(',') === tagPub.ids.slice().sort().join(','),
    JSON.stringify(tagPub.idTags));
  check('a manually listed id is tagged, nobody having voted on it',
    tagPub.idTags['2900000009'] === 'other', String(tagPub.idTags['2900000009']));
  check('idTags agrees with the target records it overlaps',
    tagPub.idTags['2100000001'] === 'redbull' &&
    tagPub.idTags['2100000002'] === 'impersonation',
    JSON.stringify([tagPub.idTags['2100000001'], tagPub.idTags['2100000002']]));
  check('an undecided id is in neither ids nor idTags',
    !tagPub.ids.includes('2100000003') && !('2100000003' in tagPub.idTags),
    JSON.stringify(tagPub.ids));

  const SPEC_WEIGHTS = {
    halfLifeDays: 7, velocityWeight: 1, localityFloor: 0.25,
    localityLangFactor: 0.8, uniqueReporterBoost: 0
  };
  check('rankWeights ships with the documented defaults',
    Object.keys(SPEC_WEIGHTS).every(k => tagPub.rankWeights[k] === SPEC_WEIGHTS[k]) &&
    Object.keys(tagPub.rankWeights).length === Object.keys(SPEC_WEIGHTS).length,
    JSON.stringify(tagPub.rankWeights));
  const tunedPub = L.buildPublish(tagRecs, L.reputation(tagRecs),
    { rankWeights: { velocityWeight: 3, halfLifeDays: 0 } });
  check('a tuned dial is published and a nonsensical one falls back alone',
    tunedPub.rankWeights.velocityWeight === 3 &&
    tunedPub.rankWeights.halfLifeDays === 7 &&
    tunedPub.rankWeights.localityFloor === 0.25,
    JSON.stringify(tunedPub.rankWeights));

  // -- 15. the ranking dials, term by term ----------------------------------
  //
  // Every expected number here is worked out by hand from the spec formula
  // rather than read back from the implementation, so a change to the maths
  // has to be argued for in this file before it can ship.
  //
  //   RT: trust 2, 7 days old, 3 reports today, 3 reporters, all local.
  //   recency   = 0.5 ^ (7/7)                       = 0.5
  //   regionAff = langAff = (3 + 0.5) / (3 + 1)     = 0.875
  //   locality  = 0.25 + 0.75 * max(0.875, 0.7)     = 0.90625
  //   rank      = 2 * 0.5 * (1 + 1*3) * 0.90625 * 1 = 3.625
  const rctx = { region: VN, lang: 'vi-vn', platform: 'threads' };
  const RT = {
    platform: 'threads', id: '1100000007', username: null, displayName: null,
    trust: 2, last: L.dayKey(Date.now() - 7 * DAY), days: { [L.dayKey(Date.now())]: 3 },
    regions: { [VN]: 3 }, langs: { 'vi-vn': 3 }, reporters: 3
  };
  const withDial = (dial, value, t) =>
    L.rankTargets([t || RT], rctx, dial ? { [dial]: value } : undefined)[0].rank;

  check('the default weights reproduce the hand-computed rank exactly',
    withDial() === 3.625, String(withDial()));
  check('passing the documented defaults explicitly changes nothing',
    L.rankTargets([RT], rctx, SPEC_WEIGHTS)[0].rank === 3.625);

  // Doubling the velocity weight doubles what the 3 reports contribute:
  // (1 + 2*3) = 7 in place of 4, so 2 * 0.5 * 7 * 0.90625 = 6.34375.
  check('doubling velocityWeight reprices the velocity term, nothing else',
    withDial('velocityWeight', 2) === 6.344, String(withDial('velocityWeight', 2)));
  check('a velocity weight of zero takes the term out of the formula',
    withDial('velocityWeight', 0) === 0.906, String(withDial('velocityWeight', 0)));

  // Halving the half-life halves the recency window: a 7-day-old target under
  // a 3.5-day half-life must rank exactly as a 14-day-old one does under 7.
  const RT14 = Object.assign({}, RT,
    { id: '1100000014', last: L.dayKey(Date.now() - 14 * DAY) });
  check('halving halfLifeDays halves the recency window',
    withDial('halfLifeDays', 3.5) === withDial(null, null, RT14) &&
    withDial('halfLifeDays', 3.5) === 1.813,
    withDial('halfLifeDays', 3.5) + ' vs ' + withDial(null, null, RT14));

  // A target nobody local reported: regionAff = langAff = 0.5/(4+1) = 0.1, so
  // locality is almost all floor. 0.25 + 0.75*0.1 = 0.325, and rank 2*0.325 =
  // 0.65; a floor of 0.5 gives 0.5 + 0.5*0.1 = 0.55; a floor of 1 leaves
  // locality no say at all.
  const FOREIGN = {
    platform: 'threads', id: '1100000009', username: null, displayName: null,
    trust: 2, last: L.dayKey(Date.now()), days: {},
    regions: { [BR]: 4 }, langs: { 'pt-br': 4 }, reporters: 1
  };
  check('the default floor keeps a foreign target reachable at 0.325 locality',
    withDial(null, null, FOREIGN) === 0.65, String(withDial(null, null, FOREIGN)));
  check('raising localityFloor lifts the target it was holding down',
    L.rankTargets([FOREIGN], rctx, { localityFloor: 0.5 })[0].rank === 1.1,
    String(L.rankTargets([FOREIGN], rctx, { localityFloor: 0.5 })[0].rank));
  check('a floor of 1 leaves locality nothing to say',
    L.rankTargets([FOREIGN], rctx, { localityFloor: 1 })[0].rank === 2,
    String(L.rankTargets([FOREIGN], rctx, { localityFloor: 1 })[0].rank));

  // The term this phase added. At the shipped 0 it is exactly 1 -- the
  // headcount is carried and ignored -- and turning it to 1 makes three
  // reporters worth 1 + log2(4) = 3.
  const RT0 = Object.assign({}, RT, { id: '1100000008', reporters: 0 });
  check('at the shipped boost of zero the reporter count changes nothing',
    withDial(null, null, RT0) === withDial() && RT0.reporters !== RT.reporters,
    withDial(null, null, RT0) + ' vs ' + withDial());
  check('a boost of one makes three reporters worth log2(4)',
    withDial('uniqueReporterBoost', 1) === 10.875,
    String(withDial('uniqueReporterBoost', 1)));
  check('the unique reporter count rides along in why',
    L.rankTargets([RT], rctx)[0].why.reporters === 3,
    String(L.rankTargets([RT], rctx)[0].why.reporters));

  /**
   * The ranking formula EXACTLY as it stood before the dials existed.
   *
   * Written out here rather than imported, because the whole point of the
   * comparison is that it cannot drift when logic.js does. If this stops
   * agreeing with rankTargets under the default weights then either a dial
   * moved or the formula did, and neither is allowed to happen quietly.
   */
  function preDialRank(t, region, lang) {
    const total = Object.values(t.regions || {}).reduce((n, v) => n + v, 0);
    const aff = (tally, key) => {
      if (!key) return 1;
      const here = (tally && Object.prototype.hasOwnProperty.call(tally, key)) ? tally[key] : 0;
      return (here + 0.5) / (total + 1);
    };
    const cutoff = L.dayKey(Date.now() - 6 * DAY);
    let vel = 0;
    for (const k of Object.keys(t.days || {})) if (k >= cutoff) vel += t.days[k];
    const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(t.last || 0)) / 86400000));
    const recency = Math.pow(0.5, ageDays / 7);
    const locality = 0.25 + 0.75 * Math.max(aff(t.regions, region), aff(t.langs, lang) * 0.8);
    return Math.round((Number(t.trust) || 0) * recency * (1 + vel) * locality * 1000) / 1000;
  }

  const parityTargets = [RT, RT14, RT0, FOREIGN, {
    platform: 'threads', id: '1100000011', trust: 0.75,
    last: L.dayKey(Date.now() - 2 * DAY), days: { [L.dayKey(Date.now() - 1 * DAY)]: 1 },
    regions: { [VN]: 1, [BR]: 5 }, langs: { 'vi-vn': 1 }, reporters: 6
  }];
  for (const ctx of [rctx, { region: BR, lang: 'pt-br', platform: 'threads' }, {}]) {
    const now = L.rankTargets(parityTargets, ctx);
    const before = parityTargets
      .map(t => ({ id: t.id, rank: preDialRank(t, ctx.region || null, ctx.lang || null) }))
      .sort((a, b) => (b.rank - a.rank) || (a.id < b.id ? -1 : 1));
    check('the default weights rank identically to the pre-dial formula ('
      + (ctx.region || 'no context') + ')',
      now.length === before.length &&
      now.every((r, i) => r.id === before[i].id && r.rank === before[i].rank),
      JSON.stringify([now.map(r => [r.id, r.rank]), before.map(r => [r.id, r.rank])]));
  }

  // -- 16. the public view: what may be said out loud -----------------------
  //
  // Every other payload in this file is read by software. This one is read by
  // people, about people, and it names them -- so the interesting property is
  // not what it contains but what it refuses to contain. Each case below is a
  // way a name, a quote or a reporter could reach the page without anybody
  // having decided it should.
  const H4 = hashOf('threads:70000062222');
  const H5 = hashOf('threads:70000073333');
  const H6 = hashOf('threads:70000084444');

  const publicDocs = [
    // Approved and opted in: the only combination that is ever published.
    doc('4200000001', H1, { at: at(6), username: 'named.publicly',
      displayName: 'Named Publicly', region: 'Asia/Ho_Chi_Minh', lang: 'vi-vn',
      postUrl: 'https://www.threads.com/@named.publicly/post/AAA',
      contentSummary: 'the post the case is built on',
      note: 'internal: bio copied word for word' }),
    // A quote with nothing behind it: an unverifiable claim about a named
    // person, so the entry goes rather than the link.
    doc('4200000001', H2, { at: at(2), region: 'Asia/Bangkok',
      contentSummary: 'a quote with no link behind it' }),
    // A link that is not https is not proof either -- the page renders it as
    // an anchor, and the same guard that protects the dashboard applies here.
    doc('4200000001', H4, { at: at(1), region: 'Asia/Ho_Chi_Minh',
      postUrl: 'http://insecure.example/p' }),
    doc('4200000001', H5, { at: at(1), region: 'Europe/Warsaw' }),
    doc('4200000001', H6, { at: at(1), region: 'America/Sao_Paulo' }),
    // Approved, never opted in: blocked everywhere, named nowhere.
    doc('4200000002', H1, { at: at(4), displayName: 'Blocked Only', reason: 'scam' }),
    // Opted in while still pending: the opt-in is recorded, the page waits.
    doc('4200000003', H2, { at: at(3), displayName: 'Not Yet Approved', reason: 'redbull' }),
    // Username-only, approved and opted in: the page is about who an account
    // claims to be, and that is the username.
    doc('@publicnameonly', H3, { at: at(5), displayName: 'Username Only', reason: 'redbull' })
  ];
  const decPub = (key, status, isPublic) => ({
    id: key.replace(':', '~'),
    data: { status, by: 'admin', at: at(0), public: isPublic }
  });
  const publicRecs = L.aggregate(publicDocs, [
    decPub('threads:4200000001', 'approved', true),
    dec('threads:4200000002', 'approved'),
    decPub('threads:4200000003', 'pending', true),
    decPub('threads:@publicnameonly', 'approved', true)
  ]);
  const pubView = L.buildPublicView(publicRecs, L.reputation(publicRecs));
  const serialised = JSON.stringify(pubView);
  const named = pubView.profiles.map(p => p.id || '@' + p.username).sort();
  const namedProfile = pubView.profiles.find(p => p.id === '4200000001');

  check('only an approved target that was opted in is named in public',
    pubView.profiles.length === 2 && named.join(',') === '4200000001,@publicnameonly',
    JSON.stringify(named));
  check('an approved target that was never opted in is absent',
    serialised.indexOf('4200000002') < 0 && serialised.indexOf('Blocked Only') < 0 &&
    pubView.counts.blocked === 3 && pubView.counts.published === 2,
    JSON.stringify(pubView.counts));
  check('a target opted in before it was approved is absent',
    serialised.indexOf('4200000003') < 0 && serialised.indexOf('Not Yet Approved') < 0);
  check('evidence with no https url behind it is dropped',
    namedProfile.evidence.length === 1 &&
    serialised.indexOf('a quote with no link behind it') < 0 &&
    serialised.indexOf('insecure.example') < 0,
    JSON.stringify(namedProfile.evidence));
  check('evidence with an https url is kept, quote and all',
    namedProfile.evidence[0].url === 'https://www.threads.com/@named.publicly/post/AAA' &&
    namedProfile.evidence[0].summary === 'the post the case is built on',
    JSON.stringify(namedProfile.evidence[0]));
  // Asserted against the serialised document rather than the object, the same
  // way the store's leak check is: a pseudonym nested three levels down in a
  // field nobody thought about is still a pseudonym on a public page.
  check('no reporter pseudonym survives into the public view',
    serialised.indexOf('acct_') < 0 && serialised.indexOf(H1) < 0,
    serialised.indexOf('acct_') < 0 ? 'absent' : 'LEAKED');
  check('moderator-facing detail stays out of the public view',
    serialised.indexOf('internal: bio copied word for word') < 0 &&
    !('notes' in namedProfile) && !('reporters' in namedProfile),
    JSON.stringify(Object.keys(namedProfile)));
  // Names in tally order and nothing else: a count beside a region is a hint
  // about how many people in one place reported this, which is a step toward
  // narrowing who they are.
  check('regions are names only, in tally order, capped at three',
    namedProfile.regions.every(r => typeof r === 'string') &&
    namedProfile.regions.join(',') ===
      'Asia/Ho_Chi_Minh,America/Sao_Paulo,Asia/Bangkok' &&
    serialised.indexOf('Warsaw') < 0 && !/"regions":\s*\{/.test(serialised),
    JSON.stringify(namedProfile.regions));
  const byTag = {};
  for (const p of pubView.profiles) byTag[p.tag] = (byTag[p.tag] || 0) + 1;
  check('counts.byTag is exactly the tally of the profiles beside it',
    JSON.stringify(pubView.counts.byTag) === JSON.stringify(byTag) &&
    byTag.clone === 1 && byTag.redbull === 1 &&
    pubView.counts.published === pubView.profiles.length,
    JSON.stringify(pubView.counts.byTag));

  // -- 17. claiming the project by signing in -------------------------------
  //
  // The first account to sign in creates admin/allowlist with itself inside
  // and becomes an admin, so the owner never has to learn their own uid to
  // get into their own dashboard. That is a door, so every way it must stay
  // shut is worth a check -- more so than the one way it opens.
  {
    // A ruleset with NO baked-in admin, so these exercise the claim path
    // rather than the literal allowlist that the rest of this file uses.
    const rulesSrc = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const pinned = rulesSrc.match(/request\.auth\.uid == '([^']+)'/)[1];
    const putRules = (content) => fetch(
      `http://${HOST}/emulator/v1/projects/${PROJECT}:securityRules`,
      { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }) });

    const ALICE = 'claim-alice', BOB = 'claim-bob';
    const claimBody0 = (uid) => ({ fields: {
      uids: { arrayValue: { values: [{ stringValue: uid }] } },
      claimedAt: { stringValue: new Date().toISOString() },
      claimedBy: { stringValue: 'test' } } });

    // First: with somebody pinned -- the normal state of a provisioned
    // project -- the claim must be shut. This is the guard that stops a second
    // account taking a project that already has an owner.
    await putRules(rulesSrc.split(pinned).join(ADMIN_UID));
    check('with an admin already pinned, nobody can claim the project',
      (await api('POST', '/admin?documentId=allowlist',
        claimBody0(ALICE), bearer(ALICE))).status === 403);

    // Now empty the pinned list, which is the only state the claim is for.
    // Cut between the 'return [' that opens the list and the '];' that closes
    // it, rather than matching across lines with a regex -- the shape is the
    // one firestore.rules documents for the --add-admin rewriter.
    const openAt = rulesSrc.indexOf('return [', rulesSrc.indexOf('function adminUids()'));
    const closeAt = rulesSrc.indexOf('];', openAt);
    const unpinned = rulesSrc.slice(0, openAt + 'return ['.length) + rulesSrc.slice(closeAt);
    await putRules(unpinned);
    const claimBody = (uid) => ({ fields: {
      uids: { arrayValue: { values: [{ stringValue: uid }] } },
      claimedAt: { stringValue: new Date().toISOString() },
      claimedBy: { stringValue: 'test' } } });
    const post = (body, uid) =>
      api('POST', '/admin?documentId=allowlist', body, uid ? bearer(uid) : undefined);

    check('with nothing claimed, a signed-in account is not yet an admin',
      (await api('GET', '/reports', undefined, bearer(ALICE))).status === 403);
    check('an unauthenticated caller cannot claim',
      (await post(claimBody(ALICE))).status === 403);
    check('a claim naming somebody else is refused',
      (await post(claimBody(BOB), ALICE)).status === 403, 'alice naming bob');
    check('a claim naming two uids is refused',
      (await post({ fields: { uids: { arrayValue: { values: [
        { stringValue: ALICE }, { stringValue: BOB }] } } } }, ALICE)).status === 403);
    const sneaky = claimBody(ALICE);
    sneaky.fields.backdoor = { stringValue: 'x' };
    check('a claim carrying an unknown field is refused',
      (await post(sneaky, ALICE)).status === 403);

    check('the first signed-in account claims the project',
      (await post(claimBody(ALICE), ALICE)).status === 200);
    check('and is an admin from that moment',
      (await api('GET', '/reports', undefined, bearer(ALICE))).status === 200);

    check('a second account cannot claim over it',
      (await post(claimBody(BOB), BOB)).status !== 200);
    check('and is still not an admin',
      (await api('GET', '/reports', undefined, bearer(BOB))).status === 403);
    check('nor may it overwrite the list',
      (await api('PATCH', '/admin/allowlist', claimBody(BOB), bearer(BOB))).status === 403);
    check('nor delete it to reopen the claim',
      (await api('DELETE', '/admin/allowlist', undefined, bearer(BOB))).status === 403);
    check('the allowlist is not world-readable',
      (await api('GET', '/admin/allowlist')).status === 403);

    check('an admin may add a second admin',
      (await api('PATCH', '/admin/allowlist', { fields: { uids: { arrayValue: { values: [
        { stringValue: ALICE }, { stringValue: BOB }] } } } }, bearer(ALICE))).status === 200);
    check('who is then an admin too',
      (await api('GET', '/reports', undefined, bearer(BOB))).status === 200);

    check('the public blocklist is unaffected throughout',
      [200, 404].includes((await api('GET', '/blocklist/current')).status));
    check('reports stay closed to the public throughout',
      (await api('GET', '/reports')).status === 403);

    // Leave the ruleset as the rest of the file expects to find it.
    await api('DELETE', '/admin/allowlist', undefined, bearer(ALICE));
    await swapRules();
  }

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
