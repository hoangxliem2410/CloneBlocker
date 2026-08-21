/**
 * Moderation dashboard, on Firebase Hosting.
 *
 * This is the owner's tool, not the users'. It deliberately does not live in
 * the extension: shipping admin tooling inside a distributed extension would
 * put admin credentials in every user's copy, and moderating should not
 * require the extension to be installed at all.
 *
 * Auth is Firebase Auth (email + password). Data access is Firestore REST
 * with the signed-in admin's ID token, NOT the Firestore web SDK: the SDK
 * never exposes a document's server-assigned createTime, and aggregation
 * keys every report's age on exactly that time so no client clock is ever
 * trusted. The SDK would also be a second large dependency for what is,
 * here, four collections read and two documents written.
 *
 * All intelligence lives in logic.js (loaded before this module as a classic
 * script, so globalThis.CB_LOGIC is ready). This file only fetches documents,
 * feeds them to the pure compute, renders, and writes decisions back.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const $ = (id) => document.getElementById(id);
const LOGIC = globalThis.CB_LOGIC;

const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

let auth = null;   // set at boot, once the config is known
let BASE = null;   // Firestore REST root, production or emulator

let currentStatus = 'pending';
let rows = [];
let blocklist = [];
const selected = new Set();

// The last full read, kept so decisions and the publish step work from the
// same records the admin is looking at.
let records = [];
let rep = Object.create(null);
let manual = {};

// -- Firestore REST ---------------------------------------------------------

/**
 * One fetch wrapper, like the old api(): every call carries the admin's ID
 * token, and a 401/403 comes back as { unauthorized: true } so callers can
 * fall back to the gate instead of wedging on an opaque error.
 */
async function fs(path, method, body) {
  const user = auth && auth.currentUser;
  if (!user) return { ok: false, unauthorized: true, error: 'Not signed in' };
  let token;
  try { token = await user.getIdToken(); }
  catch (e) { return { ok: false, unauthorized: true, error: 'Session lost: ' + (e && e.message) }; }

  let res, json = null;
  try {
    res = await fetch(BASE + path, {
      method: method || 'GET',
      headers: Object.assign({ authorization: 'Bearer ' + token },
        body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    json = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, error: 'Request failed: ' + (e && e.message) };
  }
  const errText = json && json.error && json.error.message;
  if (res.status === 401 || res.status === 403) {
    return { ok: false, unauthorized: true, status: res.status, data: json,
             error: errText || 'Not signed in' };
  }
  return { ok: res.ok, status: res.status, data: json,
           error: res.ok ? null : (errText || ('HTTP ' + res.status)) };
}

/** Firestore's typed values back to the plain ones logic.js expects. */
function fromValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  return null;
}
function fromFields(fields) {
  // Null prototype: keys here can be stranger-chosen strings, and a
  // "__proto__" key on an ordinary object rewrites its prototype.
  const out = Object.create(null);
  for (const k of Object.keys(fields || {})) out[k] = fromValue(fields[k]);
  return out;
}
function decodeDoc(doc) {
  return {
    id: doc.name.split('/').pop(),
    createTime: doc.createTime,
    data: fromFields(doc.fields)
  };
}

/** Every document of a collection, following pageTokens until done. */
async function listAll(collection) {
  const docs = [];
  let pageToken = '';
  do {
    const q = '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const out = await fs('/' + collection + q);
    if (!out.ok) return out;
    for (const d of (out.data && out.data.documents) || []) docs.push(decodeDoc(d));
    pageToken = (out.data && out.data.nextPageToken) || '';
  } while (pageToken);
  return { ok: true, docs };
}

/** One document, where absence is an answer rather than an error. */
async function getDocument(path) {
  const out = await fs('/' + path);
  if (out.status === 404) return { ok: true, doc: null };
  if (!out.ok) return out;
  return { ok: true, doc: decodeDoc(out.data) };
}

/** PATCH without an updateMask replaces the whole document — intended here. */
function patchDocument(path, fields) {
  return fs('/' + path, 'PATCH', { fields });
}

// -- decisions and publishing -----------------------------------------------

const STATUS_OF = { approve: 'approved', reject: 'rejected', revoke: 'pending' };

/** Record keys are platform:target; decision doc ids are platform~target. */
function decisionPath(key) {
  const i = key.indexOf(':');
  return 'decisions/' + encodeURIComponent(key.slice(0, i) + '~' + key.slice(i + 1));
}

function writeDecision(key, status) {
  return patchDocument(decisionPath(key), {
    status: { stringValue: status },
    by: { stringValue: 'dashboard' },
    at: { timestampValue: new Date().toISOString() }
  });
}

/**
 * Derive and publish blocklist/current from the records just read.
 *
 * This runs after EVERY decision, not only on the Publish button: the served
 * list is a pure function of (reports, decisions, manual), so republishing at
 * each write is what keeps the list and the report store structurally
 * consistent — the old server's "list and status never disagree" transaction,
 * without a transaction.
 */
async function publishList() {
  const payload = LOGIC.buildPublish(records, rep, manual);
  const cur = await getDocument('blocklist/current');
  const prevRev = (cur.ok && cur.doc && Number(cur.doc.data.rev)) || 0;
  const out = await patchDocument('blocklist/current', {
    json: { stringValue: JSON.stringify(payload) },
    updatedAt: { timestampValue: payload.updatedAt },
    rev: { integerValue: String(prevRev + 1) }
  });
  if (!out.ok) { setConn(out.error || 'publish failed', 'bad'); return false; }
  setConn('Published rev ' + (prevRev + 1), 'ok');
  return true;
}

async function decideAndPublish(key, decision) {
  const out = await writeDecision(key, STATUS_OF[decision]);
  if (!out.ok) return out;
  await refresh();       // re-read so the publish is computed from what is stored
  await publishList();
  return { ok: true };
}

// -- UI plumbing ------------------------------------------------------------

function setConn(text, cls) {
  $('conn').textContent = text;
  $('conn').className = 'status' + (cls ? ' ' + cls : '');
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * A link, or nothing.
 *
 * Every URL here was typed by a stranger. The rules reject anything that is
 * not http(s) on the way in, but records predating that check are still in the
 * store, and one "javascript:" href in this page would run with the session
 * that is reviewing it. Checked again at the point of use.
 */
function link(href, cls) {
  let u;
  try { u = new URL(href, location.origin); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const a = el('a', cls, href);
  a.href = u.href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  return a;
}

// -- sign-in ----------------------------------------------------------------
function showGate(msg) {
  $('gate').classList.remove('hidden');
  $('app').classList.add('hidden');
  if (msg) { $('gateErr').hidden = false; $('gateErr').textContent = msg; }
}
function showApp() {
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
}

/**
 * A signed-in account the rules refuse. With Firebase Auth a session does not
 * quietly expire (tokens self-refresh), so a 403 means this account is not
 * the pinned admin. Sign it out so the gate accepts a different one.
 */
function unauthorized() {
  showGate('This account is not authorized to moderate. Sign in with the admin account.');
  if (auth) signOut(auth).catch(() => {});
}

$('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('gateErr').hidden = true;
  if (!auth) { showGate('Firebase is not configured.'); return; }
  try {
    await signInWithEmailAndPassword(auth, $('gateUser').value.trim(), $('gatePass').value);
  } catch (err) {
    const code = (err && err.code) || '';
    showGate(/invalid-credential|wrong-password|user-not-found|invalid-email/.test(code)
      ? 'Wrong email or password.'
      : 'Sign-in failed: ' + (code || (err && err.message) || 'unknown error'));
    return;
  }
  $('gatePass').value = '';
  // onAuthStateChanged takes it from here: showApp() + refresh().
});
$('signout').addEventListener('click', async () => {
  if (auth) await signOut(auth).catch(() => {});
  location.reload();
});

// -- tabs, filter, bulk -----------------------------------------------------
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentStatus = tab.dataset.status;
    selected.clear();
    refresh();
  });
}
$('refresh').addEventListener('click', refresh);
$('publish').addEventListener('click', async () => {
  $('publish').disabled = true;
  await refresh();
  await publishList();
  $('publish').disabled = false;
});
$('filter').addEventListener('input', render);

$('selectAll').addEventListener('change', (e) => {
  const visible = visibleRows();
  if (e.target.checked) visible.forEach(r => selected.add(r.key));
  else visible.forEach(r => selected.delete(r.key));
  render();
});
$('bulkApprove').addEventListener('click', () => bulk('approve'));
$('bulkReject').addEventListener('click', () => bulk('reject'));

async function bulk(decision) {
  if (!selected.size) return;
  // Sequential writes, capped like the old endpoint. A failure mid-batch
  // leaves the earlier decisions standing — partial success was tolerated
  // before and still is; the refresh below shows what actually landed.
  const keys = Array.from(selected).slice(0, 500);
  $('bulkApprove').disabled = $('bulkReject').disabled = true;
  let decided = 0, lastErr = null;
  for (const key of keys) {
    const out = await writeDecision(key, STATUS_OF[decision]);
    if (out.ok) decided++; else lastErr = out.error;
  }
  $('bulkApprove').disabled = $('bulkReject').disabled = false;
  if (!decided) {
    setConn(lastErr || 'bulk action failed', 'bad');
    return;
  }
  selected.clear();
  await refresh();
  await publishList();
}

// -- stats ------------------------------------------------------------------
function renderStats(d) {
  const r = d.reports || {};
  $('statPending').textContent = r.pending != null ? r.pending : '—';
  $('statApproved').textContent = r.approved != null ? r.approved : '—';
  $('statRejected').textContent = r.rejected != null ? r.rejected : '—';
  $('statSubmissions').textContent = r.totalSubmissions != null ? r.totalSubmissions : '—';
  $('statEvidence').textContent = r.withEvidence != null ? r.withEvidence : '—';
  const rp = d.reporters || {};
  $('statHeld').textContent = r.held != null ? r.held : '—';
  // The tile holds a number; the qualifier belongs in the label under it.
  $('statReporters').textContent = rp.known != null ? rp.known : '—';
  $('statReportersK').textContent = rp.distrusted
    ? `Reporters · ${rp.distrusted} distrusted` : 'Known reporters';
  const b = d.blocklist || {};
  $('statBlocked').textContent = (b.ids || 0) + (b.usernames || 0);

  // Sparkline scaled to the busiest day, so a quiet fortnight still reads.
  const spark = $('spark');
  spark.textContent = '';
  const days = d.perDay || [];
  const max = Math.max(1, ...days.map(x => x.count));
  for (const day of days) {
    const bar = el('div', 'bar');
    bar.style.height = Math.round((day.count / max) * 100) + '%';
    bar.title = day.day + ': ' + day.count + ' report' + (day.count === 1 ? '' : 's');
    spark.appendChild(bar);
  }

  bars($('byPlatform'), d.byPlatform || []);
  bars($('byReason'), d.byReason || []);
  bars($('topReporters'), d.topReporters || []);
}

function bars(host, pairs) {
  host.textContent = '';
  if (!pairs.length) { host.appendChild(el('div', 'note', 'No data yet.')); return; }
  const max = Math.max(...pairs.map(p => p[1]));
  for (const pair of pairs) {
    const row = el('div', 'barrow');
    row.appendChild(el('span', 'lbl', pair[0]));
    // A third element, when present, is the reporter's trust weight. Volume
    // alone flatters a mass-reporter; the weight is what separates them.
    row.appendChild(el('span', null,
      pair.length > 2 ? `${pair[1]}  ·  ${Number(pair[2]).toFixed(2)}` : String(pair[1])));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = Math.round((pair[1] / max) * 100) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    host.appendChild(row);
  }
}

// -- trending matrix --------------------------------------------------------
//
// Regions down the side, days across, one cell per region-day. The point is
// not precision: it is seeing at a glance that something is starting
// somewhere, which is what decides whose clones get a block budget spent.
function renderTrends(d) {
  const host = $('trendMatrix');
  host.textContent = '';
  const regions = d.regions || [];
  if (!regions.length) {
    host.appendChild(el('div', 'note', 'No regional data yet. Reports carry a region once clients update.'));
    return;
  }

  const peak = Math.max(1, ...d.matrix.map(row => Math.max(...row)));
  const table = el('div', 'matrix');

  // Header: the day column labels, thinned so they stay readable.
  const head = el('div', 'mrow head');
  head.appendChild(el('div', 'mlbl', ''));
  (d.days || []).forEach((day, i) => {
    const c = el('div', 'mcell lbl', i % 3 === 0 ? day.slice(5) : '');
    head.appendChild(c);
  });
  head.appendChild(el('div', 'mtot', 'total'));
  table.appendChild(head);

  regions.forEach((region, ri) => {
    const row = el('div', 'mrow');
    row.appendChild(el('div', 'mlbl', region));
    (d.matrix[ri] || []).forEach((n, ci) => {
      const cell = el('div', 'mcell', n ? String(n) : '');
      // Intensity, not a colour scale: one channel is enough to read a wave
      // and it survives both themes without a legend.
      cell.style.opacity = n ? String(0.25 + 0.75 * (n / peak)) : '0';
      cell.className = 'mcell' + (n ? ' on' : '');
      cell.title = `${region} · ${(d.days || [])[ci]} · ${n} report${n === 1 ? '' : 's'}`;
      row.appendChild(cell);
    });
    row.appendChild(el('div', 'mtot', String((d.totals || [])[ri] || 0)));
    table.appendChild(row);
  });
  host.appendChild(table);

  // Under it, what is actually driving each region.
  const top = $('trendTop');
  top.textContent = '';
  for (const region of regions.slice(0, 4)) {
    const col = el('div', 'tcol');
    col.appendChild(el('h3', null, region));
    const rows = (d.topByRegion || {})[region] || [];
    if (!rows.length) { col.appendChild(el('div', 'note', 'nothing recent')); }
    for (const r of rows) {
      const line = el('div', 'trow');
      line.appendChild(el('span', 'lbl',
        r.displayName || (r.username ? '@' + r.username : r.key)));
      line.appendChild(el('span', 'n', r.last7 + '/7d'));
      col.appendChild(line);
    }
    top.appendChild(col);
  }
}

// -- data -------------------------------------------------------------------

/**
 * The blocklist tab's entries, derived from the published payload with the
 * provenance the old /admin/blocklist attached: the first aggregated record
 * that explains each value. An entry no record explains is a manual one.
 */
function deriveBlocklist(payload, all) {
  const describe = (value, kind) => {
    const rec = all.find(r => kind === 'id'
      ? String(r.profileId) === String(value)
      : LOGIC.normUser(r.username) === LOGIC.normUser(value));
    return {
      value, kind,
      platform: rec ? rec.platform : null,
      displayName: rec ? rec.displayName : null,
      reports: rec ? rec.count : 0,
      key: rec ? rec.key : null
    };
  };
  return (payload.ids || []).map(v => describe(v, 'id'))
    .concat((payload.usernames || []).map(v => describe(v, 'username')));
}

/**
 * Take one entry off the served list, the way /admin/blocklist/remove did:
 * every approved record that put the value there is reopened ('pending' —
 * revoked, not rejected), and if the manual list also holds the value it is
 * dropped and written back. Both halves run because a value can be on the
 * list for both reasons at once, and removing only one would see it
 * republished from the other.
 */
async function removeFromBlocklist(entry) {
  const isIdKind = entry.kind === 'id';
  const value = isIdKind ? String(entry.value) : LOGIC.normUser(entry.value);

  for (const rec of records) {
    if (rec.status !== 'approved') continue;
    const hit = isIdKind
      ? (rec.profileId && String(rec.profileId) === value)
      : (rec.username && LOGIC.normUser(rec.username) === value);
    if (!hit) continue;
    const out = await writeDecision(rec.key, 'pending');
    if (!out.ok) return out;
  }

  const mIds = (manual.ids || []).map(String);
  const mNames = (manual.usernames || []).map(v => LOGIC.normUser(v));
  const nextIds = isIdKind ? mIds.filter(v => v !== value) : mIds;
  const nextNames = isIdKind ? mNames : mNames.filter(v => v !== value);
  if (nextIds.length !== mIds.length || nextNames.length !== mNames.length) {
    const overrides = (manual.docIdOverrides && typeof manual.docIdOverrides === 'object')
      ? manual.docIdOverrides : {};
    const out = await patchDocument('admin/manual', {
      ids: { arrayValue: { values: nextIds.map(v => ({ stringValue: v })) } },
      usernames: { arrayValue: { values: nextNames.map(v => ({ stringValue: v })) } },
      docIdOverrides: { mapValue: { fields: Object.fromEntries(
        Object.keys(overrides).map(k => [k, { stringValue: String(overrides[k]) }])) } }
    });
    if (!out.ok) return out;
  }
  return { ok: true };
}

async function refresh() {
  const reportsOut = await listAll('reports');
  if (reportsOut.unauthorized) { unauthorized(); return; }
  if (!reportsOut.ok) { setConn(reportsOut.error || 'Could not reach Firestore', 'bad'); return; }
  const decisionsOut = await listAll('decisions');
  if (decisionsOut.unauthorized) { unauthorized(); return; }
  if (!decisionsOut.ok) { setConn(decisionsOut.error || 'Could not load decisions', 'bad'); return; }
  const manualOut = await getDocument('admin/manual');   // absent until first manual entry
  if (manualOut.unauthorized) { unauthorized(); return; }
  if (!manualOut.ok) { setConn(manualOut.error || 'Could not load manual list', 'bad'); return; }

  records = LOGIC.aggregate(reportsOut.docs, decisionsOut.docs);
  rep = LOGIC.reputation(records);
  manual = manualOut.doc ? manualOut.doc.data : {};

  setConn('Connected', 'ok');

  // The stats' blocklist column counts what WOULD be served right now — the
  // same derivation publishList() writes, so the tiles and the list agree.
  const payload = LOGIC.buildPublish(records, rep, manual);
  renderStats(LOGIC.buildStats(records, rep, { ids: payload.ids, usernames: payload.usernames }));
  renderTrends(LOGIC.trendMatrix(records, {}));

  if (currentStatus === '__blocklist') {
    blocklist = deriveBlocklist(payload, records);
    rows = [];
  } else {
    const annotated = LOGIC.sortQueue(records.map(r => LOGIC.withTrust(r, rep)));
    rows = currentStatus ? annotated.filter(r => r.status === currentStatus) : annotated;
    blocklist = [];
  }
  render();
}

function visibleRows() {
  const q = $('filter').value.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r => [r.displayName, r.username, r.profileId, r.platform, r.reason, r.key]
    .filter(Boolean).join(' ').toLowerCase().includes(q));
}

// -- rendering --------------------------------------------------------------
function render() {
  const host = $('rows');
  host.textContent = '';

  if (currentStatus === '__blocklist') {
    $('bulkbar').classList.add('hidden');
    renderBlocklist(host);
    return;
  }
  const list = visibleRows();
  $('empty').classList.toggle('hidden', list.length > 0);
  $('bulkbar').classList.toggle('hidden', list.length === 0);
  $('selCount').textContent = selected.size + ' selected';
  for (const r of list) host.appendChild(reportRow(r));
}

function reportRow(r) {
  const box = el('div', 'report' + (selected.has(r.key) ? ' sel' : ''));

  const top = el('div', 'top');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = selected.has(r.key);
  cb.addEventListener('change', () => {
    if (cb.checked) selected.add(r.key); else selected.delete(r.key);
    render();
  });
  top.appendChild(cb);
  top.appendChild(el('span', 'name', r.displayName || (r.username ? '@' + r.username : r.profileId)));
  top.appendChild(el('span', 'count', r.count + ' report' + (r.count === 1 ? '' : 's')));
  // The weighted score, when it disagrees with the raw count. Ten reports
  // worth 0.4 between them is the thing worth seeing at a glance.
  if (r.score != null && Math.abs(r.score - r.count) >= 0.05) {
    top.appendChild(el('span', 'score', 'score ' + r.score.toFixed(2)));
  }
  top.appendChild(el('span', 'reason', r.reason));
  if (r.held) top.appendChild(el('span', 'pill held', 'held: no trusted reporter'));
  if (r.status !== 'pending') top.appendChild(el('span', 'pill ' + r.status, r.status));
  box.appendChild(top);

  box.appendChild(el('div', 'meta', [
    r.username ? '@' + r.username : null,
    r.profileId ? 'id ' + r.profileId : 'no numeric id',
    r.platform
  ].filter(Boolean).join('  ·  ')));

  if (r.url) {
    const a = link(r.url, 'plink');
    if (a) box.appendChild(a);
  }

  // Who stands behind this, and how often they have been right before.
  const trust = r.trust || [];
  if (trust.length) {
    const who = el('div', 'who');
    for (const t of trust) {
      const cls = 'rep' + (t.weight < 0.25 ? ' bad' : t.weight >= 0.75 ? ' good' : '');
      who.appendChild(el('span', cls,
        t.who + '  ' + t.weight.toFixed(2) +
        (t.approved + t.rejected ? ` (${t.approved}✓ ${t.rejected}✗)` : ' (new)')));
    }
    box.appendChild(who);
  }

  // The posts people cited. This is the substance of the case, so it is shown
  // inline rather than hidden behind a detail view.
  const posts = r.posts || [];
  if (posts.length) {
    const det = document.createElement('details');
    det.className = 'evidence';
    det.open = posts.length <= 2;
    det.appendChild(el('summary', null,
      posts.length + ' post' + (posts.length === 1 ? '' : 's') + ' cited'));
    for (const p of posts.slice(-6)) {
      const pd = el('div', 'post');
      if (p.summary) pd.appendChild(el('div', 'txt', p.summary));
      if (p.url) {
        const a = link(p.url, null);
        if (a) pd.appendChild(a);
      }
      det.appendChild(pd);
    }
    box.appendChild(det);
  }

  if (r.notes && r.notes.length) {
    const n = el('div', 'notes');
    for (const note of r.notes.slice(-4)) {
      n.appendChild(el('div', null, '“' + note.text + '” — ' + note.by));
    }
    box.appendChild(n);
  }

  const actions = el('div', 'actions');
  const add = (label, cls, decision) => {
    const b = el('button', 'btn ' + cls, label);
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '…';
      const out = await decideAndPublish(r.key, decision);
      if (!out.ok) {
        if (out.unauthorized) { unauthorized(); return; }
        b.disabled = false; b.textContent = label;
        setConn(out.error || 'failed', 'bad');
      }
    });
    actions.appendChild(b);
  };
  // An approved entry is already on the live list, so the useful action is
  // taking it back off, not approving it again.
  if (r.status === 'approved') add('Remove from blocklist', 'danger', 'revoke');
  else {
    add('Approve → block', 'good', 'approve');
    if (r.status !== 'rejected') add('Reject', 'danger', 'reject');
  }
  box.appendChild(actions);
  return box;
}

function renderBlocklist(host) {
  const q = $('filter').value.trim().toLowerCase();
  const list = q
    ? blocklist.filter(e => (e.value + ' ' + (e.displayName || '') + ' ' + (e.platform || ''))
        .toLowerCase().includes(q))
    : blocklist;
  $('empty').classList.toggle('hidden', list.length > 0);

  for (const e of list) {
    const box = el('div', 'report');
    const top = el('div', 'top');
    top.appendChild(el('span', 'name', e.displayName || e.value));
    top.appendChild(el('span', 'pill', e.kind));
    if (e.reports) top.appendChild(el('span', 'count', e.reports + ' reports'));
    box.appendChild(top);
    box.appendChild(el('div', 'meta',
      [e.kind === 'id' ? 'id ' + e.value : '@' + e.value, e.platform].filter(Boolean).join('  ·  ')));

    const actions = el('div', 'actions');
    const b = el('button', 'btn danger', 'Remove from blocklist');
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '…';
      const out = await removeFromBlocklist(e);
      if (!out.ok) {
        if (out.unauthorized) { unauthorized(); return; }
        b.disabled = false; b.textContent = 'Remove from blocklist';
        setConn(out.error || 'failed', 'bad');
        return;
      }
      await refresh();
      await publishList();
    });
    actions.appendChild(b);
    box.appendChild(actions);
    host.appendChild(box);
  }
}

// -- boot -------------------------------------------------------------------
(async () => {
  // The Hosting reserved URL carries the project's own config, so nothing is
  // hardcoded for production. Against the emulators that URL may not resolve;
  // any apiKey satisfies the Auth emulator, so a stub config is enough there.
  let config = null;
  try {
    const res = await fetch('/__/firebase/init.json');
    if (res.ok) config = await res.json();
  } catch (e) { /* fall through to the local stub */ }
  if (LOCAL && (!config || !config.apiKey)) {
    config = { apiKey: 'demo', projectId: 'demo-clone', authDomain: 'demo-clone.firebaseapp.com' };
  }
  if (!config || !config.apiKey) {
    showGate('Could not load the Firebase configuration (init.json).');
    return;
  }

  const app = initializeApp(config);
  auth = getAuth(app);
  if (LOCAL) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

  BASE = LOCAL
    ? 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents'
    : 'https://firestore.googleapis.com/v1/projects/'
        + encodeURIComponent(config.projectId) + '/databases/(default)/documents';

  // The auth state decides gate vs app; there is no session probe to make.
  onAuthStateChanged(auth, (user) => {
    if (user) { showApp(); refresh(); }
    else showGate();
  });
})();
