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
  onAuthStateChanged, signInWithPopup, GoogleAuthProvider
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

// Every tag on to start with: the filter is there to narrow a queue somebody
// is already looking at, not to hide part of it before they have looked.
const selectedTags = new Set(LOGIC.TAGS);

// The last full read, kept so decisions and the publish step work from the
// same records the admin is looking at.
let records = [];
let rep = Object.create(null);
let manual = {};
// The decision documents as stored, which is NOT what `records` carry: a
// record's tag is the effective one and its status may have been reopened by a
// later report. Writing a decision has to start from what is actually in the
// document or it silently undoes the half it was not asked about.
let decisions = new Map();
// The payload the current read would publish. The ranking preview ranks these
// targets, so what the admin previews is the array clients receive.
let payload = null;

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

/**
 * A document's full resource name, which is what a commit write needs.
 *
 * Derived from BASE rather than rebuilt from the config, so the emulator and
 * production cases stay one code path: BASE already ends in the documents
 * root, and everything from "projects/" on is exactly that name.
 */
function docName(path) {
  return BASE.slice(BASE.indexOf('/projects/') + 1) + '/' + path;
}

/**
 * Several document writes, applied all-or-nothing.
 *
 * An `update` without an updateMask replaces the document, the same semantics
 * patchDocument() has, so a caller can move a write from one to the other
 * without wondering what happens to the fields it did not mention.
 */
function commit(writes) {
  return fs(':commit', 'POST', { writes });
}

// -- decisions and publishing -----------------------------------------------

const STATUS_OF = { approve: 'approved', reject: 'rejected', revoke: 'pending' };

/** Record keys are platform:target; decision doc ids are platform~target. */
function decisionPath(key) {
  const i = key.indexOf(':');
  return 'decisions/' + encodeURIComponent(key.slice(0, i) + '~' + key.slice(i + 1));
}

/** The admin's override for a key, or null when the tag is still inferred. */
function overrideTag(key) {
  const t = (decisions.get(key) || {}).tag;
  return LOGIC.TAGS.includes(t) ? t : null;
}

/** Whether this key is opted in to the public page, as stored. */
function isPublic(key) {
  return (decisions.get(key) || {}).public === true;
}

/**
 * Write decisions/{key}, carrying over whatever this call is not about.
 *
 * A PATCH without an updateMask replaces the document, and the document now
 * holds three independent verdicts: a status (should this be blocked), a tag
 * (what is it) and `public` (may it be named on the transparency page).
 * Sending only one of them would erase the others — approving a target would
 * throw away the tag an admin chose for it, retagging one would revoke its
 * approval, and either would silently unpublish it. So all three are always
 * written, and `patch` says only which of them is changing.
 *
 * `at` and `by` describe the STATUS decision, so a retag leaves them alone.
 * That matters beyond tidiness: aggregate() reopens a rejected case when a
 * report arrives after `at`, and moving `at` forward for an unrelated retag
 * would quietly re-close it.
 */
function writeDecision(key, patch) {
  const prev = decisions.get(key) || {};
  const prevStatus = ['approved', 'rejected', 'pending'].includes(prev.status)
    ? prev.status : 'pending';
  const status = patch.status !== undefined ? patch.status : prevStatus;
  const tag = patch.tag !== undefined ? patch.tag : overrideTag(key);
  const pub = patch.public !== undefined ? patch.public === true : isPublic(key);
  const same = status === prevStatus;

  const fields = {
    status: { stringValue: status },
    by: { stringValue: (same && prev.by) ? String(prev.by) : 'dashboard' },
    at: { timestampValue: (same && prev.at) ? String(prev.at) : new Date().toISOString() }
  };
  // Absent rather than empty when there is no override: `tag` is an optional
  // field and effectiveTag() reads its absence as "let the reports decide".
  if (LOGIC.TAGS.includes(tag)) fields.tag = { stringValue: tag };
  // Absent rather than false, for the same reason and a stronger one: not
  // published is the default state of every target that has ever existed, and
  // a document that says nothing about publishing is the honest record of a
  // decision nobody has taken.
  if (pub) fields.public = { booleanValue: true };
  return patchDocument(decisionPath(key), fields);
}

/**
 * Write admin/manual whole.
 *
 * Same replacement hazard as a decision, one document up: the manual list and
 * the ranking weights live side by side here, so a write that mentions only
 * one of them drops the other. Every caller goes through this and passes the
 * complete next state.
 */
function writeManual(next) {
  const ids = (next.ids || []).map(String);
  const usernames = (next.usernames || []).map(v => LOGIC.normUser(v));
  const overrides = (next.docIdOverrides && typeof next.docIdOverrides === 'object')
    ? next.docIdOverrides : {};
  const weights = LOGIC.rankWeightsOf(next.rankWeights);
  return patchDocument('admin/manual', {
    ids: { arrayValue: { values: ids.map(v => ({ stringValue: v })) } },
    usernames: { arrayValue: { values: usernames.map(v => ({ stringValue: v })) } },
    docIdOverrides: { mapValue: { fields: Object.fromEntries(
      Object.keys(overrides).map(k => [k, { stringValue: String(overrides[k]) }])) } },
    rankWeights: { mapValue: { fields: Object.fromEntries(
      Object.keys(weights).map(k => [k, { doubleValue: weights[k] }])) } }
  });
}

/**
 * Derive and publish blocklist/current AND blocklist/publicView from the
 * records just read, in one commit.
 *
 * This runs after EVERY decision, not only on the Publish button: the served
 * list is a pure function of (reports, decisions, manual), so republishing at
 * each write is what keeps the list and the report store structurally
 * consistent — the old server's "list and status never disagree" transaction,
 * without a transaction.
 *
 * The two documents go in a single :commit rather than two PATCHes because
 * they are two views of one decision set. Written separately, a failure or a
 * closed tab between them would leave a profile named on the public page after
 * it had been taken off the blocklist — the one disagreement that matters, and
 * the one nobody would notice. Firestore applies a commit's writes atomically,
 * so the pair either both land or neither does, and they carry the same rev
 * and the same updatedAt to say so.
 */
async function publishList() {
  const list = LOGIC.buildPublish(records, rep, manual);
  const view = LOGIC.buildPublicView(records, rep);
  // One publish, one timestamp: each builder stamps its own clock read, and
  // two documents from the same commit that disagree by a millisecond would
  // invite exactly the "which is newer" question this pairing exists to
  // remove.
  view.updatedAt = list.updatedAt;

  const cur = await getDocument('blocklist/current');
  const prevRev = (cur.ok && cur.doc && Number(cur.doc.data.rev)) || 0;
  const rev = prevRev + 1;
  const envelope = (payload) => ({
    json: { stringValue: JSON.stringify(payload) },
    updatedAt: { timestampValue: payload.updatedAt },
    rev: { integerValue: String(rev) }
  });

  const out = await commit([
    { update: { name: docName('blocklist/current'), fields: envelope(list) } },
    { update: { name: docName('blocklist/publicView'), fields: envelope(view) } }
  ]);
  if (!out.ok) { setConn(out.error || 'publish failed', 'bad'); return false; }
  setConn('Published rev ' + rev + ' · ' + view.profiles.length + ' public', 'ok');
  return true;
}

async function decideAndPublish(key, decision) {
  const out = await writeDecision(key, { status: STATUS_OF[decision] });
  if (!out.ok) return out;
  await refresh();       // re-read so the publish is computed from what is stored
  await publishList();
  return { ok: true };
}

/**
 * Set (or clear) a target's tag and republish.
 *
 * The same write-then-reread-then-publish path a decision takes, because a tag
 * IS published: it rides on every target and in idTags, and an install that
 * has narrowed its blockTags is acting on it. A retag that did not republish
 * would leave the served list disagreeing with the dashboard.
 */
async function retagAndPublish(key, tag) {
  const out = await writeDecision(key, { tag: tag || null });
  if (!out.ok) return out;
  await refresh();
  await publishList();
  return { ok: true };
}

/**
 * Opt a target in to (or out of) the public transparency page and republish.
 *
 * The same write-then-reread-then-publish path, because publicView is derived
 * from the stored decisions exactly like the blocklist is. Opting out is the
 * half that has to be immediate: a name comes off the page in the same commit
 * that records the admin changing their mind, not at the next publish.
 */
async function setPublicAndPublish(key, next) {
  const out = await writeDecision(key, { public: next === true });
  if (!out.ok) return out;
  await refresh();
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

// -- tags -------------------------------------------------------------------

/**
 * The tag chip.
 *
 * Filled means inferred — this is what the reports add up to, and it will move
 * on its own as more arrive. Outlined means a person decided it, and no volume
 * of later reports will change it. An admin scanning the queue needs to know
 * which of their tags are actually theirs, so the two never look the same.
 */
function tagChip(tag, overridden) {
  const t = LOGIC.TAGS.includes(tag) ? tag : 'other';
  const chip = el('span', 'tag tag-' + t + (overridden ? ' over' : ''), t);
  chip.title = overridden
    ? 'tag set by an admin — reports no longer move it'
    : 'tag inferred from the reports';
  return chip;
}

// -- sign-in ----------------------------------------------------------------
function showGate(msg) {
  $('gate').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('gateDenied').hidden = true;
  if (msg) { $('gateErr').hidden = false; $('gateErr').textContent = msg; }
}
function showApp() {
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
}

/**
 * Signed in fine, and the rules still said no.
 *
 * This is the one screen that must never be vague. Two sign-in methods mean
 * two uids for one person, and the uid a Google sign-in mints is not printed
 * anywhere the owner can reach: not in the Firebase console's provider page,
 * not in the rules file, nowhere on this page unless it is put here. An
 * "unauthorized" toast plus an automatic sign-out would destroy the only copy
 * of the fact needed to fix the problem, and the owner would be locked out of
 * their own dashboard with nothing to type into --add-admin.
 *
 * So the session is kept, the uid is shown, the exact command is shown, and
 * signing out is a button rather than something that happens to you.
 */
function showDenied(user) {
  const uid = (user && user.uid) || '';
  const who = (user && (user.email || user.displayName)) || uid;
  showGate();
  $('gateErr').hidden = true;
  $('gateDeniedWho').textContent =
    'Signed in as ' + who + ', which is not an admin of this project.';
  $('gateDeniedUid').textContent = uid;
  $('gateDeniedCmd').textContent = 'node tools/firebase-setup.js --add-admin ' + uid;
  $('gateDenied').hidden = false;
}

/**
 * One admin-only read, used as the question "do the rules accept this
 * account?". Membership of the allowlist is not visible to a client any other
 * way -- the rules are not readable, so the only honest test is to try.
 *
 * admin/manual is the cheapest probe: a single document, admin-only, and
 * absent on a fresh project, which the REST layer already reports as an
 * answer rather than an error.
 */
async function isAdminAccount() {
  const out = await getDocument('admin/manual');
  return !out.unauthorized;
}

/**
 * Take ownership of a project nobody owns yet.
 *
 * A uid compiled into firestore.rules can only be added by editing and
 * deploying that file, which is a chicken and egg for the person who wants to
 * sign in with Google: they cannot learn their own uid without opening a
 * dashboard they cannot open. So the first account to sign in claims the
 * project by creating admin/allowlist with itself inside.
 *
 * The rules do the deciding, not this function. `create` succeeds only when
 * the document is absent and only when the single uid inside is the caller's
 * own, so a second attempt fails with a conflict rather than a takeover, and
 * this can never install somebody else. All that happens here is the ask.
 */
async function tryClaimProject(user) {
  // A POST to the COLLECTION with an explicit documentId, not a PATCH: that
  // is the create-only verb, so an existing allowlist answers 409 instead of
  // being overwritten. The safety is structural, not a check we remembered.
  const res = await fs('/admin?documentId=allowlist', 'POST', {
    fields: {
      uids: { arrayValue: { values: [{ stringValue: user.uid }] } },
      claimedAt: { stringValue: new Date().toISOString() },
      claimedBy: { stringValue: user.email || user.displayName || 'unknown' }
    }
  });
  return !!(res && res.ok);
}

/**
 * A signed-in account the rules refuse, discovered mid-session. With Firebase
 * Auth a session does not quietly expire (tokens self-refresh), so a 403 is
 * about WHO this is, not about how old the token is -- the same answer the
 * gate's probe gives, and it deserves the same screen.
 */
function unauthorized() {
  showDenied(auth && auth.currentUser);
}

$('gateGoogle').addEventListener('click', async () => {
  $('gateErr').hidden = true;
  if (!auth) { showGate('Firebase is not configured.'); return; }
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    const code = (err && err.code) || '';
    // A closed or blocked popup is the user's own doing, not a failure worth
    // shouting about; anything else is worth naming, because the usual cause
    // is a provider nobody enabled yet.
    if (/popup-closed-by-user|cancelled-popup-request/.test(code)) return;
    showGate(/popup-blocked/.test(code)
      ? 'The browser blocked the sign-in popup. Allow popups for this site and try again.'
      : /operation-not-allowed|configuration-not-found/.test(code)
        ? 'Google sign-in is not enabled on this project. Run: node tools/firebase-setup.js'
        : 'Google sign-in failed: ' + (code || (err && err.message) || 'unknown error'));
  }
  // onAuthStateChanged takes it from here: the admin probe, then the app.
});

$('gateSignOut').addEventListener('click', async () => {
  if (auth) await signOut(auth).catch(() => {});
  location.reload();
});

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
  // onAuthStateChanged takes it from here: the admin probe, then the app.
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
/**
 * The tag toggles, drawn from TAGS so the row cannot drift from the vocabulary.
 *
 * Purely client-side: everything is already in memory, and a tag filter that
 * needed a round trip would stop being the quick "show me the scams" it is for.
 * Counts come from the rows currently loaded, so they say how much of THIS tab
 * each tag accounts for rather than quoting a global total the list contradicts.
 */
function renderTagFilter() {
  const host = $('tagFilter');
  host.textContent = '';
  // The blocklist tab lists published ids and usernames, not queue records;
  // most of them have no record left to carry a tag, so the row would filter
  // against something half the entries do not have.
  if (currentStatus === '__blocklist') { host.classList.add('hidden'); return; }
  host.classList.remove('hidden');

  const counts = Object.create(null);
  for (const r of rows) counts[r.tag] = (counts[r.tag] || 0) + 1;

  host.appendChild(el('span', 'flbl', 'Tags'));
  for (const tag of LOGIC.TAGS) {
    const on = selectedTags.has(tag);
    const b = el('button', 'tagchip tag-' + tag + (on ? ' on' : ''), tag);
    if (counts[tag]) b.appendChild(el('span', 'n', String(counts[tag])));
    b.addEventListener('click', () => {
      if (on) selectedTags.delete(tag); else selectedTags.add(tag);
      render();
    });
    host.appendChild(b);
  }
  const all = el('button', 'tagchip all' + (selectedTags.size === LOGIC.TAGS.length ? ' on' : ''),
    'all');
  all.addEventListener('click', () => {
    for (const tag of LOGIC.TAGS) selectedTags.add(tag);
    render();
  });
  host.appendChild(all);
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
    const out = await writeDecision(key, { status: STATUS_OF[decision] });
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

// -- ranking dials ----------------------------------------------------------
//
// The weights ride in the published list, so tuning them is a publish, not a
// deploy. The preview beside the form is the point of the card: a half-life is
// an abstraction, and the only thing anyone actually wants to know is which
// accounts move to the top if they change it.

const RANK_FIELDS = [
  ['halfLifeDays', 0.5,
   'A report counts half as much once it is this many days old. Smaller means the list forgets faster.'],
  ['velocityWeight', 0.1,
   'How much each report from the last 7 days multiplies rank. 0 ignores how busy a target is right now.'],
  ['localityFloor', 0.05,
   'The share of its rank a target keeps for someone far from it. 1 ignores locality; 0 makes a distant target worthless.'],
  ['localityLangFactor', 0.05,
   'A matching language counts this much of a matching region.'],
  ['uniqueReporterBoost', 0.1,
   // The honest reading, not the flattering one: this term is switched off in
   // production, and saying so is what stops it being tuned by accident.
   'Extra weight for independent reporters, on top of the trust their reports already carry. 0 means off — ranking is exactly what it was before this dial existed.']
];

// True while the form holds values nobody has saved. A refresh must not
// overwrite what the admin is in the middle of typing.
let rankDirty = false;

function buildRankForm() {
  const host = $('rankFields');
  host.textContent = '';
  for (const [key, step, help] of RANK_FIELDS) {
    const row = el('div', 'rankfield');
    const label = el('label', 'fname', key);
    label.htmlFor = 'rw_' + key;
    const input = document.createElement('input');
    input.type = 'number';
    input.id = 'rw_' + key;
    input.step = String(step);
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(el('div', 'fhelp', help));
    host.appendChild(row);
  }
}

/**
 * What the form says right now, sanitised the way a published list would be.
 *
 * A cleared box reads as NaN rather than as 0, because rankWeightsOf treats an
 * unusable value as "not set" and falls back to the default — and "I emptied
 * this field" means "leave it alone", not "turn this term off". `Number('')`
 * is 0, which would have meant the opposite.
 */
function formWeights() {
  const raw = {};
  for (const [key] of RANK_FIELDS) {
    const v = $('rw_' + key).value.trim();
    raw[key] = v === '' ? NaN : Number(v);
  }
  return LOGIC.rankWeightsOf(raw);
}

function fillRankForm(weights) {
  const w = LOGIC.rankWeightsOf(weights);
  for (const [key] of RANK_FIELDS) $('rw_' + key).value = String(w[key]);
  rankDirty = false;
  setRankMsg();
}

function setRankMsg() {
  const msg = $('rankMsg');
  msg.textContent = rankDirty ? 'unsaved — preview only' : '';
  msg.className = 'note' + (rankDirty ? ' dirty' : '');
}

/**
 * The top of the ranked list under the form's current values.
 *
 * Ranked with logic.js rankTargets over the very array buildPublish would
 * ship, so this is not a model of what clients compute — it is the same
 * function over the same data. No ctx is passed: with no region and no
 * language, affinity() stays neutral, which is the only honest default for a
 * dashboard that has no particular viewer.
 */
function renderRankPreview() {
  const host = $('rankPreview');
  host.textContent = '';
  const targets = (payload && payload.targets) || [];
  if (!targets.length) {
    host.appendChild(el('div', 'note', 'Nothing published yet — approve a target with a numeric id.'));
    return;
  }
  const tagOf = new Map(targets.map(t => [t.id, t.tag]));
  const ranked = LOGIC.rankTargets(targets, {}, formWeights()).slice(0, 10);
  ranked.forEach((t, i) => {
    const row = el('div', 'prow');
    row.appendChild(el('div', 'pos', String(i + 1)));
    const name = el('div', 'pnamewrap');
    name.appendChild(el('span', 'pname',
      t.displayName || (t.username ? '@' + t.username : t.id)));
    name.appendChild(tagChip(tagOf.get(t.id), false));
    row.appendChild(name);
    row.appendChild(el('div', 'prank', t.rank.toFixed(3)));
    row.appendChild(el('div', 'pwhy', [
      'trust ' + t.why.trust,
      t.why.reporters + ' reporter' + (t.why.reporters === 1 ? '' : 's'),
      t.why.recentDays + 'd old',
      t.why.velocity7d + '/7d'
    ].join('  ·  ')));
    host.appendChild(row);
  });
}

buildRankForm();
// The defaults until the first read says otherwise, so the card is never blank
// while the queue behind it is loading.
fillRankForm(null);
$('rankForm').addEventListener('input', () => {
  rankDirty = true;
  setRankMsg();
  renderRankPreview();
});
$('rankReset').addEventListener('click', () => {
  fillRankForm(LOGIC.RANK_WEIGHTS);
  rankDirty = true;      // the defaults are not saved until someone saves them
  setRankMsg();
  renderRankPreview();
});
$('rankForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('rankForm').querySelector('button[type="submit"]');
  btn.disabled = true;
  // Stored on admin/manual next to the manual list, because buildPublish
  // already takes that document as "everything the admin has decided that is
  // not a per-target decision" — and publishing is what makes a weight real.
  const out = await writeManual(Object.assign({}, manual, { rankWeights: formWeights() }));
  btn.disabled = false;
  if (!out.ok) {
    if (out.unauthorized) { unauthorized(); return; }
    setConn(out.error || 'could not save the weights', 'bad');
    return;
  }
  rankDirty = false;
  await refresh();
  await publishList();
});

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
  // Tallied here rather than in buildStats: the tag breakdown is a dashboard
  // view, and buildStats' shape is asserted field for field by the test suite
  // as the contract the old server published.
  bars($('byTag'), tagTally(), (label) => 'tag-' + label);
  bars($('topReporters'), d.topReporters || []);
}

/**
 * Every record by its effective tag, biggest first.
 *
 * Ties break on TAGS order — the same order that breaks ties when the modal
 * reason is chosen — so two equal tags do not swap places between refreshes.
 */
function tagTally() {
  const m = Object.create(null);
  for (const r of records) m[r.tag] = (m[r.tag] || 0) + 1;
  return Object.entries(m)
    .sort((a, b) => (b[1] - a[1]) || (LOGIC.TAGS.indexOf(a[0]) - LOGIC.TAGS.indexOf(b[0])));
}

function bars(host, pairs, tint) {
  host.textContent = '';
  if (!pairs.length) { host.appendChild(el('div', 'note', 'No data yet.')); return; }
  const max = Math.max(...pairs.map(p => p[1]));
  for (const pair of pairs) {
    const row = el('div', 'barrow' + (tint ? ' ' + tint(pair[0]) : ''));
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
    const out = await writeDecision(rec.key, { status: 'pending' });
    if (!out.ok) return out;
  }

  const mIds = (manual.ids || []).map(String);
  const mNames = (manual.usernames || []).map(v => LOGIC.normUser(v));
  const nextIds = isIdKind ? mIds.filter(v => v !== value) : mIds;
  const nextNames = isIdKind ? mNames : mNames.filter(v => v !== value);
  if (nextIds.length !== mIds.length || nextNames.length !== mNames.length) {
    const out = await writeManual(Object.assign({}, manual,
      { ids: nextIds, usernames: nextNames }));
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
  // Keyed the way records are (platform:target), so a row can ask what its own
  // decision document actually holds.
  decisions = new Map(decisionsOut.docs.map(d => [d.id.replace('~', ':'), d.data || {}]));

  setConn('Connected', 'ok');

  // The stats' blocklist column counts what WOULD be served right now — the
  // same derivation publishList() writes, so the tiles and the list agree.
  payload = LOGIC.buildPublish(records, rep, manual);
  renderStats(LOGIC.buildStats(records, rep, { ids: payload.ids, usernames: payload.usernames }));
  renderTrends(LOGIC.trendMatrix(records, {}));
  // Only when the admin is not mid-edit: a refresh fires after every decision,
  // and pulling the published values back into a half-typed form would lose
  // work with no warning.
  if (!rankDirty) fillRankForm(manual.rankWeights);
  renderRankPreview();

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
  const byTag = rows.filter(r => selectedTags.has(r.tag));
  if (!q) return byTag;
  return byTag.filter(r => [r.displayName, r.username, r.profileId, r.platform,
                            r.reason, r.tag, r.key]
    .filter(Boolean).join(' ').toLowerCase().includes(q));
}

// -- rendering --------------------------------------------------------------
function render() {
  const host = $('rows');
  host.textContent = '';
  renderTagFilter();

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
  top.appendChild(tagChip(r.tag, overrideTag(r.key) !== null));
  // The opening reason stays visible next to the tag: when they disagree, the
  // case has moved on from what the first reporter thought it was.
  if (r.reason !== r.tag) top.appendChild(el('span', 'reason', 'reported as ' + r.reason));
  if (r.held) top.appendChild(el('span', 'pill held', 'held: no trusted reporter'));
  if (r.status !== 'pending') top.appendChild(el('span', 'pill ' + r.status, r.status));
  // Named in public, or waiting to be. The two are worth distinguishing: the
  // opt-in can be recorded on a target of any status, but only an approved one
  // reaches the page, so a pending row says so rather than implying it is live.
  if (r.public) {
    const live = r.status === 'approved';
    const flag = el('span', 'pill public' + (live ? '' : ' later'),
      live ? 'on the public page' : 'public once approved');
    flag.title = live
      ? 'this profile is named on the public transparency page'
      : 'opted in, but nothing is published until this target is approved';
    top.appendChild(flag);
  }
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
  actions.appendChild(publicControl(r));
  actions.appendChild(retagControl(r));
  box.appendChild(actions);
  return box;
}

/**
 * The publish-publicly toggle.
 *
 * Separate from Approve on purpose, and worded as an act rather than a state.
 * Approving puts an id on a blocklist that only the extension reads; this puts
 * a person's name on a page anyone can read and search, and the owner decided
 * (ROADMAP, open decision 2) that the second must never happen as a side
 * effect of the first. So it is its own button, on its own row, saying which
 * of the two it does.
 */
function publicControl(r) {
  const on = r.public === true;
  const label = on ? 'Unpublish' : 'Publish publicly';
  const b = el('button', 'btn' + (on ? '' : ' pub'), label);
  b.title = on
    ? 'take this profile off the public transparency page'
    : 'name this profile on the public transparency page';
  b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '…';
    const out = await setPublicAndPublish(r.key, !on);
    if (!out.ok) {
      if (out.unauthorized) { unauthorized(); return; }
      b.disabled = false; b.textContent = label;
      setConn(out.error || 'failed', 'bad');
    }
    // On success refresh() has already redrawn this row from what is stored.
  });
  return b;
}

/**
 * The retag select.
 *
 * The empty option is the important one: it clears the override rather than
 * setting a seventh tag, and the tag goes back to following the reports. An
 * admin who has changed their mind needs a way back to "let the votes decide",
 * or every accidental retag is permanent.
 */
function retagControl(r) {
  const wrap = el('div', 'retag');
  wrap.appendChild(el('span', null, 'tag'));

  const sel = document.createElement('select');
  const auto = el('option', null, 'auto · ' + LOGIC.modalTag(r.reasons));
  auto.value = '';
  sel.appendChild(auto);
  for (const tag of LOGIC.TAGS) {
    const o = el('option', null, tag);
    o.value = tag;
    sel.appendChild(o);
  }
  const current = overrideTag(r.key);
  sel.value = current || '';

  sel.addEventListener('change', async () => {
    const next = sel.value;
    sel.disabled = true;
    const out = await retagAndPublish(r.key, next);
    if (!out.ok) {
      if (out.unauthorized) { unauthorized(); return; }
      sel.disabled = false;
      sel.value = current || '';
      setConn(out.error || 'retag failed', 'bad');
    }
    // On success refresh() has already redrawn this row from what is stored.
  });
  wrap.appendChild(sel);
  return wrap;
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
    // The tag as PUBLISHED, straight out of idTags — this tab is a view of the
    // served document, so it should show what the served document says rather
    // than re-deriving it. Usernames are not in idTags and carry no tag.
    if (e.kind === 'id' && payload && payload.idTags[e.value]) {
      top.appendChild(tagChip(payload.idTags[e.value], false));
    }
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

  // The auth state decides gate vs app -- but "signed in" and "allowed to
  // moderate" are two different questions once there are two ways in, so the
  // second one is asked before the dashboard is shown. Showing the app first
  // and letting refresh() discover the 403 would flash an empty dashboard at
  // someone whose real answer is "your uid is not on the list".
  onAuthStateChanged(auth, async (user) => {
    if (!user) { showGate(); return; }
    if (!(await isAdminAccount())) {
      // Not an admin yet -- but on a project nobody has claimed, signing in
      // IS the claim. Only if that is refused (someone got here first) is
      // this account genuinely locked out, and then it needs its uid.
      if (await tryClaimProject(user) && await isAdminAccount()) {
        showApp();
        // After the refresh, not before: refresh() finishes by writing its own
        // connection status, and taking ownership of the project is the one
        // message that must not be scrolled past on the way in.
        await refresh();
        setConn('Claimed this project as ' + (user.email || user.uid) +
                ' -- close the sign-up window now', 'ok');
        return;
      }
      showDenied(user);
      return;
    }
    showApp();
    refresh();
  });
})();
