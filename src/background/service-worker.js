/**
 * MV3 service worker.
 *
 * Owns three things the content scripts cannot:
 *
 *  1. The server fetch. A content-script fetch is subject to facebook.com's
 *     origin and CSP; a service-worker fetch only needs host permission and is
 *     exempt from CORS. So the blocklist is always fetched here.
 *  2. The block queue and rate limiter. Several Facebook tabs may be open at
 *     once; centralising the queue is what stops them double-blocking the same
 *     profile or blowing through the hourly cap in parallel.
 *  3. Scheduled refresh via chrome.alarms.
 *
 * MV3 service workers are killed aggressively and restarted on demand, so
 * nothing here may live in a module-scope variable across calls. Every piece of
 * state round-trips through chrome.storage.
 */

// Executing this module publishes CB_PROTOCOL / CB_KEYS / CB_DEFAULT_SETTINGS
// onto globalThis, so the wire format has exactly one definition.
import '../common/protocol.js';

const P = globalThis.CB_PROTOCOL;
const KEYS = globalThis.CB_KEYS;
const DEFAULTS = globalThis.CB_DEFAULT_SETTINGS;

const ALARM_REFRESH = 'cb-refresh-blocklist';
const LEASE_MS = 90 * 1000;          // a claimed target is reserved this long
const MAX_TARGET_FAILURES = 5;       // stop retrying a target after this many errors
const DRYRUN_COOLDOWN_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------
async function getSettings() {
  const got = await chrome.storage.sync.get(KEYS.SETTINGS);
  return Object.assign({}, DEFAULTS, got[KEYS.SETTINGS] || {});
}
async function setSettings(patch) {
  const next = Object.assign(await getSettings(), patch || {});
  await chrome.storage.sync.set({ [KEYS.SETTINGS]: next });
  // Every recorded error is about platform blocking. Switching blocking off
  // makes all of them historical, so none should still be on screen.
  if (patch && patch.platformBlockEnabled === false) {
    const stats = await getLocal(KEYS.STATS, {});
    if (stats.lastError) { clearError(stats); await setLocal(KEYS.STATS, stats); }
  }
  return next;
}
async function getLocal(key, fallback) {
  const got = await chrome.storage.local.get(key);
  return got[key] === undefined ? fallback : got[key];
}
async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// A failure is worth remembering, but only until it stops being true.
//
// These were three bare assignments with nothing anywhere that cleared them,
// so the first block that could not run left its message in the popup
// permanently -- through a successful block, through signing back in, through
// turning platform blocking off entirely. Stamping the time makes a stale one
// obvious; clearing on success makes it stop being stale.
function noteError(stats, detail) {
  stats.lastError = String(detail || '').slice(0, 300);
  stats.lastErrorAt = Date.now();
}
function clearError(stats) {
  delete stats.lastError;
  delete stats.lastErrorAt;
}

// ---------------------------------------------------------------------------
// blocklist fetching
// ---------------------------------------------------------------------------

/**
 * Accepts several reasonable server shapes so you are not forced into one:
 *   ["123", "456"]
 *   { ids: [...], usernames: [...] }
 *   { blocked: [ { id, username }, ... ] }
 *   { data: { ids: [...] } }
 * plus an optional docIdOverrides map for hot-patching a Meta doc_id rotation.
 */
function normalizeBlocklist(payload) {
  const ids = new Set();
  const usernames = new Set();

  const takeScalar = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return;
    if (/^\d{4,}$/.test(s)) ids.add(s);
    else usernames.add(s.toLowerCase().replace(/^@/, ''));
  };
  const takeEntry = (e) => {
    if (e == null) return;
    if (typeof e === 'string' || typeof e === 'number') { takeScalar(e); return; }
    if (typeof e === 'object') {
      if (e.id != null) takeScalar(e.id);
      if (e.profileId != null) takeScalar(e.profileId);
      if (e.user_id != null) takeScalar(e.user_id);
      if (e.pk != null) takeScalar(e.pk);
      if (e.username != null) usernames.add(String(e.username).toLowerCase().replace(/^@/, ''));
      if (e.handle != null) usernames.add(String(e.handle).toLowerCase().replace(/^@/, ''));
    }
  };

  let root = payload;
  if (root && typeof root === 'object' && !Array.isArray(root) && root.data) root = root.data;

  if (Array.isArray(root)) {
    root.forEach(takeEntry);
  } else if (root && typeof root === 'object') {
    for (const key of ['ids', 'profileIds', 'profile_ids', 'blocked', 'entries', 'list', 'users']) {
      if (Array.isArray(root[key])) root[key].forEach(takeEntry);
    }
    if (Array.isArray(root.usernames)) {
      root.usernames.forEach(u => usernames.add(String(u).toLowerCase().replace(/^@/, '')));
    }
  }

  const docIdOverrides =
    (payload && payload.docIdOverrides) ||
    (payload && payload.data && payload.data.docIdOverrides) || null;

  return { ids: Array.from(ids), usernames: Array.from(usernames), docIdOverrides };
}

async function hasHostPermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (e) { return false; }
}

const ID_RE = /^\d{4,24}$/;

// ---------------------------------------------------------------------------
// Firestore-backed lists
// ---------------------------------------------------------------------------
//
// The blocklist can live in a Firestore document instead of on a self-hosted
// server: one public-read doc whose `json` field holds the whole published
// payload. Three things change when the URL points there, and only there:
// no ranking hints are appended to the URL (nothing about this browser is
// sent anywhere), the ranked slice is computed locally from published
// per-target metadata, and reports are written as create-only documents.
// Every legacy shape keeps working for self-hosted servers and static files.

const FIRESTORE_URL_RE = /\/v1\/projects\/[^/]+\/databases\/[^/]+\/documents\//;
function isFirestoreUrl(url) { return FIRESTORE_URL_RE.test(String(url || '')); }

/** `.../documents` prefix of a Firestore REST URL, or null. */
function firestoreDocsBase(url) {
  const m = String(url || '').match(/^(.*\/v1\/projects\/[^/]+\/databases\/[^/]+\/documents)\//);
  return m ? m[1] : null;
}

/** Decode the published payload out of a Firestore REST document response. */
function decodeFirestoreDoc(body) {
  if (!body || typeof body !== 'object' || !body.fields) return null;
  const f = body.fields;
  if (f.json && typeof f.json.stringValue === 'string') {
    try { return JSON.parse(f.json.stringValue); } catch (e) { return null; }
  }
  return null;
}

const normUsername = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// -- local ranking ----------------------------------------------------------
//
// Verbatim from the retired server (and duplicated in hosting/logic.js, which
// a service worker cannot import): recency halves every 7 days, velocity is
// the last 7 UTC day buckets, affinity is a smoothed share of where the
// clone's reports come from. The one inherited quirk -- language affinity
// divides by the REGION total -- is kept so rankings match the old ones.
// Everything quantises to whole days, so recomputing within a day is
// deterministic and the queue does not churn between polls.

const RANK_HALF_LIFE_DAYS = 7;
const rankDayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function rankVelocity(days, n) {
  const cutoff = rankDayKey(Date.now() - (n - 1) * 86400000);
  let total = 0;
  for (const k of Object.keys(days || {})) if (k >= cutoff) total += days[k];
  return total;
}

function rankAffinity(tally, key, total) {
  if (!key) return 1;
  const here = (tally && Object.prototype.hasOwnProperty.call(tally, key)) ? tally[key] : 0;
  return (here + 0.5) / (total + 1);
}

/**
 * Rank published target metadata for THIS browser.
 *
 * The server used to do this per-request from query params; now the region
 * and language never leave the machine. `shareRegion` keeps its user-visible
 * meaning -- off means suggestions are not localised to you.
 */
function rankPublishedTargets(meta, settings) {
  let region = null, lang = null;
  if (settings.shareRegion !== false) {
    const c = clientContext();
    region = c.region || null;
    lang = c.lang ? String(c.lang).toLowerCase() : null;
  }
  const today = Date.now();
  const out = [];
  for (const t of meta || []) {
    if (!t || !ID_RE.test(String(t.id))) continue;
    const total = Object.values(t.regions || {}).reduce((n, v) => n + v, 0);
    const trust = Number(t.trust) || 0;
    const ageDays = Math.max(0, Math.floor((today - Date.parse(t.last || 0)) / 86400000));
    const recency = Math.pow(0.5, ageDays / RANK_HALF_LIFE_DAYS);
    const vel = rankVelocity(t.days, 7);
    const regionAff = rankAffinity(t.regions, region, total);
    const langAff = rankAffinity(t.langs, lang, total);
    // Region never zeroes a target out; it dominates the ordering when it fits.
    const locality = 0.25 + 0.75 * Math.max(regionAff, langAff * 0.8);
    const rank = trust * recency * (1 + vel) * locality;
    out.push({
      id: String(t.id),
      platform: String(t.platform || ''),
      rank: Math.round(rank * 1000) / 1000,
      why: {
        trust: Math.round(trust * 100) / 100,
        recentDays: ageDays,
        velocity7d: vel,
        region: Math.round(regionAff * 100) / 100,
        lang: Math.round(langAff * 100) / 100
      }
    });
  }
  out.sort((a, b) => (b.rank - a.rank) || (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * Where this browser is, coarsely.
 *
 * A time zone and a language tag -- both of which the browser already hands to
 * every site it loads, and neither of which needs an IP lookup, a geo database
 * or a third party. That is enough for the server to tell a clone wave running
 * in Vietnamese from one running in Portuguese, which is the distinction that
 * decides whose clones are worth this person's limited block budget.
 */
function clientContext() {
  let region = null, lang = null;
  try { region = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) {}
  try { lang = (navigator.language || '').trim() || null; } catch (e) {}
  return { region, lang };
}

/** Add the ranking hints to the list URL, respecting the privacy setting. */
function withClientContext(listUrl, settings, budget) {
  // A Firestore document URL takes no hints: nothing about this browser is
  // sent, and the ranking happens locally in rankPublishedTargets instead.
  if (isFirestoreUrl(listUrl)) return listUrl;
  let u;
  try { u = new URL(listUrl); } catch (e) { return listUrl; }
  if (settings.acceptServerTargets === false) return listUrl;
  u.searchParams.set('budget', String(Math.max(1, Math.min(budget, 200))));
  if (settings.shareRegion !== false) {
    const ctx = clientContext();
    if (ctx.region) u.searchParams.set('region', ctx.region);
    if (ctx.lang) u.searchParams.set('lang', ctx.lang);
  }
  return u.toString();
}

/**
 * How many cold blocks the limiter would still allow in the next hour.
 *
 * Asking for more than that would be asking the server to rank work we have no
 * intention of doing, and would push genuinely urgent targets out of the slice.
 */
async function remainingBudget(settings) {
  const stats = await getLocal(KEYS.STATS, {});
  const hourAgo = Date.now() - 3600 * 1000;
  const cold = (stats.coldTimes || []).filter(t => t > hourAgo).length;
  const perHour = Math.max(0, (settings.maxColdBlocksPerHour | 0) - cold);
  // Ask for a few hours' worth: the queue should not run dry between polls.
  return Math.max(1, Math.min(perHour * 4 || 4, settings.targetBudget | 0 || 25));
}

/**
 * Queue what the server nominated, as cold work.
 *
 * These are accounts this browser has never seen, so they sit behind anything
 * on screen and are spent against the tighter cold ceiling. If the user later
 * scrolls past one, enqueue() promotes it to warm and it goes sooner.
 */
async function seedServerTargets(record) {
  const settings = await getSettings();
  if (settings.acceptServerTargets === false) return { ok: true, added: 0 };
  if (!settings.platformBlockEnabled) return { ok: true, added: 0 };
  const byPlatform = {};
  for (const t of record.targets || []) {
    if (!t.platform) continue;
    (byPlatform[t.platform] = byPlatform[t.platform] || []).push({ id: t.id, rank: t.rank });
  }
  let added = 0;
  for (const platform of Object.keys(byPlatform)) {
    const r = await serialize(() => enqueue(platform, byPlatform[platform], { warm: false }));
    added += r.added;
  }
  return { ok: true, added };
}

async function refreshBlocklist(force) {
  const settings = await getSettings();
  if (!settings.listUrl) {
    return { ok: false, error: 'No blocklist URL configured. Set one in the extension options.' };
  }
  if (!(await hasHostPermission(settings.listUrl))) {
    return {
      ok: false,
      needsPermission: true,
      error: 'Permission for that host has not been granted. Open the options page and click Grant access.'
    };
  }

  const prev = await getLocal(KEYS.BLOCKLIST, null);
  const headers = { accept: 'application/json' };
  if (settings.listAuthHeader) headers.authorization = settings.listAuthHeader;
  // Conditional request keeps refreshes cheap on an unchanged list.
  if (!force && prev && prev.etag) headers['if-none-match'] = prev.etag;

  // Ask for a ranked slice as well as the list itself. The server decides what
  // is worth blocking; this only tells it where we are and how much room the
  // rate limiter has left, so the slice it returns is one we can actually spend.
  const listUrl = withClientContext(settings.listUrl, settings, await remainingBudget(settings));

  // Firestore ignores If-None-Match, which made every poll download the whole
  // published blob even when nothing had changed -- the one economy the old
  // server's ETag gave us that the migration lost. Firestore DOES support
  // masked reads, so ask for a single field first: a few hundred bytes whose
  // updateTime says whether the cached copy is still current. Only a changed
  // document costs the full download. (The probe is still one billed read --
  // Firestore meters by document, not by bytes -- but an unchanged day drops
  // from ~2MB of transfer to ~10KB.)
  if (isFirestoreUrl(listUrl) && !force && prev && prev.etag && prev.source === settings.listUrl) {
    try {
      const pu = new URL(listUrl);
      pu.searchParams.set('mask.fieldPaths', 'rev');
      const probe = await fetch(pu.toString(), { method: 'GET', headers, cache: 'no-cache' });
      if (probe.ok) {
        const meta = await probe.json();
        if (meta && meta.updateTime && meta.updateTime === prev.etag) {
          const touched = Object.assign({}, prev, { fetchedAt: Date.now() });
          await setLocal(KEYS.BLOCKLIST, touched);
          return { ok: true, unchanged: true, blocklist: touched };
        }
      }
    } catch (e) { /* a failed probe must never break the refresh -- fall through */ }
  }

  let res;
  try {
    res = await fetch(listUrl, { method: 'GET', headers, cache: 'no-cache' });
  } catch (e) {
    await bumpStat('fetchErrors');
    return { ok: false, error: 'Fetch failed: ' + (e && e.message) };
  }

  if (res.status === 304 && prev) {
    const touched = Object.assign({}, prev, { fetchedAt: Date.now() });
    await setLocal(KEYS.BLOCKLIST, touched);
    return { ok: true, unchanged: true, blocklist: touched };
  }
  if (!res.ok) {
    await bumpStat('fetchErrors');
    return { ok: false, error: 'Server returned HTTP ' + res.status };
  }

  let payload;
  const text = await res.text();
  try { payload = JSON.parse(text); }
  catch (e) {
    // Also accept a plain newline-delimited list of ids.
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return { ok: false, error: 'Response was neither JSON nor a line-delimited list' };
    payload = lines;
  }

  // A Firestore document envelope carries the whole published payload as one
  // JSON string field. Unwrap it and fall through to the normal path; the
  // document updateTime stands in for the etag (a change marker, nothing
  // more -- Firestore does not honour If-None-Match).
  let fsUpdateTime = null;
  const fsDecoded = decodeFirestoreDoc(payload);
  if (fsDecoded) {
    fsUpdateTime = (payload && payload.updateTime) || null;
    payload = fsDecoded;
  }

  const norm = normalizeBlocklist(payload);
  // An empty list is a legitimate state -- nothing reported yet, or an admin
  // just removed the last entry. Refusing it meant the extension kept serving a
  // stale list after the final unblock, which is the one moment where being
  // out of date is most visible.
  //
  // A response that is not a recognisable list shape is a different matter:
  // that is an error page or a misconfigured URL, and accepting it would clear
  // everyone's blocklist.
  const looksLikeList = payload && (Array.isArray(payload) ||
    (typeof payload === 'object' && ['ids', 'usernames', 'blocked', 'entries', 'list', 'users', 'data']
      .some(k => k in payload)));
  if (!looksLikeList) {
    return { ok: false, error: 'Response did not look like a blocklist (wrong URL?)' };
  }

  // Ranked cold targets, if the list carries any and the user allows them.
  // Two shapes arrive here: a legacy server sends targets it already ranked
  // for us ({id, rank, why}); a published Firestore list sends per-target
  // METADATA (day buckets, region tallies) and the ranking happens right
  // here, with context that never leaves this machine.
  let targets = [], targetsAvailable = Number(payload.targetsAvailable) || 0;
  if (settings.acceptServerTargets !== false && Array.isArray(payload.targets)) {
    const raw = payload.targets.filter(t => t && ID_RE.test(String(t.id)));
    if (raw.some(t => t.days || t.regions || t.langs)) {
      const budget = Math.max(1, Math.min(await remainingBudget(settings), 200));
      const ranked = rankPublishedTargets(raw, settings);
      targets = ranked.slice(0, budget);
      targetsAvailable = ranked.length;
    } else {
      targets = raw.map(t => ({ id: String(t.id), platform: String(t.platform || ''),
                                rank: Number(t.rank) || 0, why: t.why || null }));
    }
  }

  const record = {
    ids: norm.ids,
    usernames: norm.usernames,
    targets,
    targetsAvailable,
    // Report keys still awaiting a decision, so the report chip can say
    // "already reported" without asking anyone.
    pending: Array.isArray(payload.pending) ? payload.pending.slice(0, 5000) : [],
    etag: res.headers.get('etag') || fsUpdateTime || null,
    fetchedAt: Date.now(),
    source: settings.listUrl,
    count: norm.ids.length + norm.usernames.length
  };
  await setLocal(KEYS.BLOCKLIST, record);
  if (norm.docIdOverrides) await setLocal('docIdOverrides', norm.docIdOverrides);
  await pruneQueueToList(record);
  await seedServerTargets(record);

  await broadcast(P.SW.BLOCKLIST_UPDATED, { count: record.count });
  return { ok: true, blocklist: record };
}

/**
 * Drop queued targets that the freshly-fetched list no longer names.
 *
 * Without this the queue only ever grows: taking someone off your server list
 * would not stop them being blocked, because their id was already sitting in
 * the queue from an earlier fetch. Removing an entry from the list has to mean
 * removing it from the pending work, or the list is not actually in control.
 *
 * Ids the tabs resolved from usernames are pruned here too, but the content
 * scripts re-seed those immediately on BLOCKLIST_UPDATED, so the effect is a
 * brief gap rather than a loss -- and erring toward NOT blocking is the right
 * direction for a mistake to fall.
 */
async function pruneQueueToList(record) {
  return serialize(async () => {
    const q = await getLocal(KEYS.QUEUE, {});
    const allowed = new Set(record.ids || []);
    let removed = 0;
    for (const platform of Object.keys(q)) {
      const before = (q[platform] || []).length;
      q[platform] = (q[platform] || []).filter(e => allowed.has(entryId(e)));
      removed += before - q[platform].length;
    }
    if (removed) await setLocal(KEYS.QUEUE, q);
    return removed;
  });
}

async function broadcast(type, payload) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({
      url: ['https://*.facebook.com/*', 'https://*.threads.net/*', 'https://*.threads.com/*']
    });
  } catch (e) { return; }
  for (const t of tabs) {
    try { chrome.tabs.sendMessage(t.id, { type, payload }, () => void chrome.runtime.lastError); }
    catch (e) { /* tab may have no listener */ }
  }
}

// ---------------------------------------------------------------------------
// platform-block queue + rate limiter
// ---------------------------------------------------------------------------

/**
 * Serialises the queue/stats mutations.
 *
 * Each of these is a read-modify-write over chrome.storage, and every storage
 * call is an await point. With several Facebook tabs open, two of them can
 * report a result at the same time: both read the queue, both remove their own
 * target from the copy they read, and the second write silently discards the
 * first one's removal. Chaining the operations removes the interleaving.
 */
let opChain = Promise.resolve();
function serialize(fn) {
  const run = () => fn();
  const next = opChain.then(run, run);
  opChain = next.then(() => {}, () => {});
  return next;
}

/**
 * Queue entries.
 *
 * A queued target is not just an id: it carries how it got here, and that
 * decides how fast it may be spent.
 *
 *   warm  the profile was on the page when it was queued. Blocking someone you
 *         are looking at is what an ordinary person does all day, so it draws
 *         no attention and can go at a natural pace.
 *
 *   cold  the server nominated it from the trending list and this browser has
 *         never seen it. A run of blocks against accounts the user never
 *         encountered is the pattern that gets an account checkpointed, so it
 *         is rationed far more tightly.
 *
 * Older builds stored bare id strings; those are read as cold, which is the
 * safe direction for an unknown to fall.
 */
function asEntry(e) {
  if (typeof e === 'string') return { id: e, warm: false, rank: 0, at: 0 };
  return { id: String(e.id), warm: !!e.warm, rank: Number(e.rank) || 0, at: Number(e.at) || 0 };
}
const entryId = (e) => (typeof e === 'string' ? e : String(e && e.id));

async function enqueue(platform, ids, opts) {
  const q = await getLocal(KEYS.QUEUE, {});
  const done = await getLocal(KEYS.DONE, {});
  const warm = !!(opts && opts.warm);
  const ranks = (opts && opts.ranks) || {};
  const existing = (q[platform] || []).map(asEntry);
  const byId = new Map(existing.map(e => [e.id, e]));
  const finished = new Set(done[platform] || []);
  let added = 0, promoted = 0;

  for (const raw of ids || []) {
    const id = String(typeof raw === 'object' && raw ? raw.id : raw);
    if (!ID_RE.test(id) || finished.has(id)) continue;
    const rank = Number(typeof raw === 'object' && raw ? raw.rank : ranks[id]) || 0;

    const seen = byId.get(id);
    if (seen) {
      // Seeing a cold target on screen upgrades it. That is the whole point of
      // the distinction: the same block is unremarkable now and conspicuous
      // later, so take it while it is cheap.
      if (warm && !seen.warm) { seen.warm = true; seen.at = Date.now(); promoted++; }
      if (rank > seen.rank) seen.rank = rank;
      continue;
    }
    byId.set(id, { id, warm, rank, at: Date.now() });
    added++;
  }

  q[platform] = Array.from(byId.values());
  await setLocal(KEYS.QUEUE, q);
  return { ok: true, added, promoted, queued: q[platform].length };
}

/**
 * Rate limiter.
 *
 * Counts every real request sent to the platform, not just the ones that
 * succeeded. Limiting successes would be the wrong meter: a target that always
 * errors would generate unlimited traffic while the counter stayed at zero,
 * which is exactly the burst pattern the caps exist to prevent.
 */
async function limiterVerdict(settings) {
  const stats = await getLocal(KEYS.STATS, {});
  const events = (stats.attemptTimes || []).filter(t => Date.now() - t < 24 * 3600 * 1000);
  const hourAgo = Date.now() - 3600 * 1000;
  const inHour = events.filter(t => t > hourAgo);
  const coldInHour = (stats.coldTimes || []).filter(t => t > hourAgo);

  if (inHour.length >= (settings.maxBlocksPerHour | 0)) {
    const oldest = Math.min.apply(null, inHour);
    return { allowed: false, retryInMs: Math.max(60000, 3600 * 1000 - (Date.now() - oldest)) };
  }
  if (events.length >= (settings.maxBlocksPerDay | 0)) {
    const oldest = Math.min.apply(null, events);
    return { allowed: false, retryInMs: Math.max(300000, 24 * 3600 * 1000 - (Date.now() - oldest)) };
  }
  if (stats.pausedUntil && Date.now() < stats.pausedUntil) {
    return { allowed: false, retryInMs: stats.pausedUntil - Date.now() };
  }
  // Warm work is still allowed when the cold ceiling is reached: blocking
  // someone on the page in front of you is the ordinary case, and rationing it
  // to protect against a risk it does not carry would just make the extension
  // feel broken.
  // Zero is a real setting -- "never block anyone I have not seen" -- so it
  // cannot be folded in with "unset". A truthiness check here meant asking for
  // no cold blocks at all granted unlimited ones, which is the exact opposite
  // of what someone choosing zero wants.
  const coldCap = Number.isFinite(settings.maxColdBlocksPerHour)
    ? Math.max(0, settings.maxColdBlocksPerHour)
    : 4;
  if (coldInHour.length >= coldCap) {
    // With a ceiling of zero there is no earlier attempt to wait out; check
    // back in an hour in case the setting changes.
    const oldest = coldInHour.length ? Math.min.apply(null, coldInHour) : Date.now();
    return { allowed: true, warmOnly: true,
             coldRetryInMs: Math.max(60000, 3600 * 1000 - (Date.now() - oldest)) };
  }
  return { allowed: true };
}

/** Backoff for a target that keeps failing: 2m, 6m, 18m, 54m, capped at 4h. */
function failureBackoffMs(failures) {
  return Math.min(2 * 60 * 1000 * Math.pow(3, Math.max(0, failures - 1)), 4 * 3600 * 1000);
}

// Jittered, so a run of blocks does not arrive on a metronome.
function rand(lo, hi) {
  const a = Math.max(0, lo || 0), b = Math.max(a, hi || a);
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function claim(platform) {
  const settings = await getSettings();
  if (!settings.platformBlockEnabled) return { ok: true, target: null, retryInMs: 300000 };

  const verdict = await limiterVerdict(settings);
  if (!verdict.allowed) return { ok: true, target: null, retryInMs: verdict.retryInMs };

  const q = await getLocal(KEYS.QUEUE, {});
  const leases = await getLocal('leases', {});
  const cooldowns = await getLocal('cooldowns', {});
  const list = (q[platform] || []).map(asEntry);
  if (!list.length) return { ok: true, target: null, retryInMs: 120000 };

  // Warm before cold, then by the server's rank. Warmth is both the safer and
  // the more relevant signal, so the two orderings agree far more often than
  // they conflict.
  list.sort((a, b) => (b.warm ? 1 : 0) - (a.warm ? 1 : 0) || (b.rank - a.rank));

  const now = Date.now();
  // Prune expired leases while we are here. Nothing else removes them, and a
  // tab closed mid-claim leaves one behind, so the object would grow forever
  // and be rewritten in full on every claim.
  for (const k of Object.keys(leases)) if (leases[k] <= now) delete leases[k];
  for (const k of Object.keys(cooldowns)) if (cooldowns[k] <= now) delete cooldowns[k];

  let soonest = Infinity;
  let heldCold = false;
  for (const entry of list) {
    const id = entry.id;
    // The hourly cold ceiling is reached: leave these queued rather than
    // dropping them, and keep serving anything warm behind them.
    if (verdict.warmOnly && !entry.warm) {
      heldCold = true;
      soonest = Math.min(soonest, verdict.coldRetryInMs || 3600000);
      continue;
    }
    const key = platform + ':' + id;
    const lease = leases[key];
    if (lease && lease > now) { soonest = Math.min(soonest, lease - now); continue; }
    // A target in cooldown is skipped rather than retried, so one bad entry
    // cannot head-of-line block everything queued behind it.
    const cool = cooldowns[key];
    if (cool && cool > now) { soonest = Math.min(soonest, cool - now); continue; }
    leases[key] = now + LEASE_MS;
    await setLocal('leases', leases);
    // The tab paces itself from this: a block of someone on screen can follow
    // the last one quickly, a cold one should not.
    const s = await getSettings();
    return { ok: true, target: id, warm: entry.warm, rank: entry.rank,
             nextDelayMs: entry.warm
               ? rand(s.warmMinDelayMs | 0, s.warmMaxDelayMs | 0)
               : rand(s.minDelayMs | 0, s.maxDelayMs | 0) };
  }
  return { ok: true, target: null, coldHeld: heldCold,
           retryInMs: Math.max(30000, Math.min(soonest, 15 * 60 * 1000)) };
}

async function reportResult(info) {
  const { platform, target, ok, dryRun, rateLimited, checkpoint, loggedOut, detail } = info || {};
  const q = await getLocal(KEYS.QUEUE, {});
  const done = await getLocal(KEYS.DONE, {});
  const stats = await getLocal(KEYS.STATS, {});
  const leases = await getLocal('leases', {});
  const cooldowns = await getLocal('cooldowns', {});
  const failures = await getLocal('failures', {});
  const key = platform + ':' + target;
  const now = Date.now();

  // The activity page shows every attempt with what was known about the
  // target at the time. Capture that BEFORE the queue entry is consumed --
  // after a success the entry is gone, and the done list is bare ids.
  {
    const entry = (q[platform] || []).map(asEntry).find(e => e.id === String(target)) || {};
    const list = await getLocal(KEYS.BLOCKLIST, null);
    const meta = list && (list.targets || []).find(t => String(t.id) === String(target));
    const log = await getLocal('blockLog', []);
    log.unshift({
      at: now, platform, id: String(target),
      ok: !!ok, dryRun: !!dryRun, warm: !!info.warm,
      rank: entry.rank != null ? entry.rank : (meta ? meta.rank : null),
      why: meta ? meta.why : null,
      detail: ok ? null : String(detail || '').slice(0, 200)
    });
    await setLocal('blockLog', log.slice(0, 500));
  }

  delete leases[key];

  stats.blockTimes = (stats.blockTimes || []).filter(t => now - t < 24 * 3600 * 1000);
  stats.attemptTimes = (stats.attemptTimes || []).filter(t => now - t < 24 * 3600 * 1000);
  stats.attempts = (stats.attempts || 0) + 1;

  // A real request left the browser whatever its outcome, so it counts.
  if (!dryRun) {
    stats.attemptTimes.push(now);
    // Counted separately: the cold ceiling exists because unencountered targets
    // are what look automated, and a warm block should never eat that budget.
    stats.coldTimes = (stats.coldTimes || []).filter(t => now - t < 24 * 3600 * 1000);
    if (!info.warm) stats.coldTimes.push(now);
  }

  if (ok && !dryRun) {
    q[platform] = (q[platform] || []).filter(e => entryId(e) !== String(target));
    done[platform] = Array.from(new Set([...(done[platform] || []), target]));
    stats.blockTimes.push(now);
    stats.succeeded = (stats.succeeded || 0) + 1;
    clearError(stats);
    delete failures[key];
    delete cooldowns[key];
  } else if (ok && dryRun) {
    // A dry run changes nothing, so the target stays queued -- but it must go
    // into cooldown, otherwise the worker would re-simulate the same first
    // entry forever and never reach the rest of the queue.
    stats.dryRuns = (stats.dryRuns || 0) + 1;
    // A dry run resolved a strategy end to end. Whatever the last complaint
    // was, it is no longer the current state of things.
    clearError(stats);
    cooldowns[key] = now + DRYRUN_COOLDOWN_MS;
  } else {
    stats.failed = (stats.failed || 0) + 1;
    noteError(stats, detail);
    const n = (failures[key] || 0) + 1;
    failures[key] = n;
    if (n >= MAX_TARGET_FAILURES) {
      // Give up rather than hammering it forever. It stays recorded so the
      // diagnostics panel can show why it never completed.
      q[platform] = (q[platform] || []).filter(e => entryId(e) !== String(target));
      stats.abandoned = (stats.abandoned || 0) + 1;
      stats.abandonedIds = Array.from(new Set([...(stats.abandonedIds || []), target])).slice(-200);
      delete cooldowns[key];
      delete failures[key];
    } else {
      cooldowns[key] = now + failureBackoffMs(n);
    }
  }

  if (loggedOut) {
    // Not the target's fault: leave it queued, clear the failure count that
    // would otherwise creep toward abandonment, and pause the whole run.
    delete failures[key];
    cooldowns[key] = now + 10 * 60 * 1000;
    stats.pausedUntil = now + 15 * 60 * 1000;
    noteError(stats, 'Signed out of the site -- platform blocking paused. Sign in again, then resume.');
  }
  if (rateLimited) stats.pausedUntil = now + 20 * 60 * 1000;
  if (checkpoint) {
    stats.pausedUntil = now + 6 * 3600 * 1000;
    stats.halted = true;
    noteError(stats, 'Account checkpoint detected. Platform blocking paused; resolve the challenge on the site.');
    await setSettings({ platformBlockEnabled: false });
    try {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
    } catch (e) { /* ignore */ }
  }

  await setLocal(KEYS.QUEUE, q);
  await setLocal(KEYS.DONE, done);
  await setLocal(KEYS.STATS, stats);
  await setLocal('leases', leases);
  await setLocal('cooldowns', cooldowns);
  await setLocal('failures', failures);
  return { ok: true };
}

async function bumpStat(name) {
  const stats = await getLocal(KEYS.STATS, {});
  stats[name] = (stats[name] || 0) + 1;
  await setLocal(KEYS.STATS, stats);
}

// ---------------------------------------------------------------------------
// alarms
// ---------------------------------------------------------------------------
async function installAlarm() {
  const settings = await getSettings();
  // Chrome clamps periods below 30 seconds; our floor is far above that, but
  // guard anyway so a bad setting cannot produce a silently-ignored alarm.
  const minutes = Math.max(1, settings.refreshMinutes | 0 || 60);
  // Leave an existing alarm alone when the period is unchanged. Recreating it
  // on every settings save would push the next refresh back a minute each time,
  // so editing unrelated options could starve the refresh indefinitely.
  // The rebrand renamed this alarm. Alarms persist per extension install, so
  // the old name would keep firing (and being ignored) forever in installs
  // that predate it -- clear it once.
  try { await chrome.alarms.clear('tq-refresh-blocklist'); } catch (e) { /* ignore */ }
  let existing = null;
  try { existing = await chrome.alarms.get(ALARM_REFRESH); } catch (e) { /* ignore */ }
  if (existing && existing.periodInMinutes === minutes) return;
  await chrome.alarms.clear(ALARM_REFRESH);
  await chrome.alarms.create(ALARM_REFRESH, { periodInMinutes: minutes, delayInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_REFRESH) return;
  refreshBlocklist(false).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  installAlarm().catch(() => {});
  refreshBlocklist(true).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  installAlarm().catch(() => {});
  refreshBlocklist(false).catch(() => {});
});

// ---------------------------------------------------------------------------
// message hub
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.type) return;

  (async () => {
    const payload = msg.payload || {};
    switch (msg.type) {
      case P.SW.GET_SETTINGS:
        respond({ ok: true, settings: await getSettings() });
        break;

      case P.SW.SET_SETTINGS: {
        const next = await setSettings(payload);
        await installAlarm();
        respond({ ok: true, settings: next });
        break;
      }

      case P.SW.GET_BLOCKLIST: {
        const bl = await getLocal(KEYS.BLOCKLIST, null);
        respond(bl ? { ok: true, blocklist: bl } : { ok: false, error: 'no blocklist cached yet' });
        break;
      }

      case P.SW.REFRESH_NOW:
        respond(await refreshBlocklist(true));
        break;

      case P.SW.GET_STATE: {
        const [settings, blocklist, queue, done, stats, blockLog, cooldowns, failures] =
          await Promise.all([
            getSettings(),
            getLocal(KEYS.BLOCKLIST, null),
            getLocal(KEYS.QUEUE, {}),
            getLocal(KEYS.DONE, {}),
            getLocal(KEYS.STATS, {}),
            getLocal('blockLog', []),
            getLocal('cooldowns', {}),
            getLocal('failures', {})
          ]);
        respond({ ok: true, settings, blocklist, queue, done, stats, blockLog, cooldowns, failures });
        break;
      }

      case P.SW.ENQUEUE_PLATFORM_BLOCK:
        // warm: these ids were resolved from the page the user is looking at.
        respond(await serialize(() => enqueue(payload.platform, payload.ids,
          { warm: payload.warm !== false })));
        break;

      case P.SW.QUEUE_CLAIM:
        // Serialised so two tabs cannot be handed the same target: the lease
        // write must land before the next claim reads the lease table.
        respond(await serialize(() => claim(payload.platform)));
        break;

      case P.SW.QUEUE_RESULT:
        respond(await serialize(() => reportResult(payload)));
        break;

      // Test hook: drive the list-prune directly. Harmless in production --
      // it only ever removes queue entries.
      case 'sw:prune-test':
        respond({ ok: true, removed: await pruneQueueToList({ ids: (payload && payload.ids) || [] }) });
        break;

      case P.SW.SUBMIT_REPORT:
        respond(await submitReport(payload));
        break;

      case P.SW.REPORT_STATUS:
        respond(await reportStatus(payload, payload && payload.force));
        break;

      case P.SW.LOG:
        if (payload && payload.msg) console.debug('[CloneBlocker/sw]', payload.msg);
        respond({ ok: true });
        break;

      default:
        respond({ ok: false, error: 'unknown message type: ' + msg.type });
    }
  })().catch((e) => {
    try { respond({ ok: false, error: String((e && e.message) || e) }); } catch (_) { /* port closed */ }
  });

  return true;   // keep the port open for the async respond above
});


// ---------------------------------------------------------------------------
// clone reporting
//
// Users report; an admin reviews and decides. Everything here runs in the
// service worker because it is the only context allowed to reach the API at
// all: a content-script fetch is bound by facebook.com's origin, and the admin
// token must never travel through a page context.
// ---------------------------------------------------------------------------

/**
 * Where the report API lives.
 *
 * Derived from listUrl by default -- the blocklist and the report intake are
 * two routes on the same service, so configuring the base separately would
 * mostly be a way to get them out of sync.
 */
async function apiBase(settings) {
  const s = settings || await getSettings();
  if (s.apiBase) return s.apiBase.replace(/\/+$/, '');
  if (!s.listUrl) return null;
  try {
    const u = new URL(s.listUrl);
    return u.origin + u.pathname.replace(/\/[^/]*$/, '');
  } catch (e) { return null; }
}

/** A stable per-install reporter id, so repeat reports from one person count
 *  once rather than inflating a profile's report count. */
/**
 * Who is filing this report.
 *
 * This used to be a UUID minted per installation, which made the identity
 * worthless: clearing extension storage produced a brand new reporter, so one
 * person could raise any report's count without limit. It is now the signed-in
 * platform account, supplied by the content script from the page.
 *
 * The server can no more verify this than we can -- proving a Meta session to a
 * third party needs Meta, and that means their API. What it changes is the cost:
 * inflating a count now takes real accounts, and reputation has something stable
 * to accumulate against. The server hashes it before storing it.
 */
function reporterRef(platform, viewerId) {
  if (!platform || !viewerId) return null;
  if (!ID_RE.test(String(viewerId))) return null;
  return platform + ':' + viewerId;
}


function reportKeyFor(platform, profileId, username) {
  const numeric = /^\d{4,}$/.test(String(profileId || ''));
  return numeric
    ? platform + ':' + profileId
    : platform + ':@' + String(username || '').toLowerCase().replace(/^@/, '');
}

/**
 * File a report as a Firestore document.
 *
 * The retired server received a POST, validated it, hashed the reporter and
 * merged it into a per-account record. Here the write IS the validation and
 * the dedup: security rules enforce every cap this function clips to, and the
 * document id -- platform~target~reporterHash -- makes a repeat report from
 * the same account a create conflict (409) rather than a second row. The
 * per-account record the dashboard shows is rebuilt from these documents.
 *
 * The pseudonym is an unkeyed SHA-256 now, not the server's salted HMAC -- a
 * pure client cannot keep a salt secret. Reports are admin-read-only, so the
 * hash is defence in depth rather than the primary barrier; PRIVACY.md says
 * so in as many words.
 */
async function firestoreSubmitReport(settings, payload, reporter, baseOverride) {
  const base = baseOverride || firestoreDocsBase(settings.listUrl);
  if (!base) return { ok: false, error: 'Could not derive the Firestore base from the list URL.' };
  if (!(await hasHostPermission(base + '/'))) {
    return { ok: false, needsPermission: true,
             error: 'Host permission not granted. Open options and click Grant access.' };
  }

  const platform = payload.platform;
  const clip = (v, max) => {
    if (v == null) return null;
    const t = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    return t ? t.slice(0, max) : null;
  };
  const url = (v) => {
    if (!v) return null;
    const t = String(v).trim();
    return /^https?:\/\//.test(t) && t.length <= 300 ? t : null;
  };

  const profileId = ID_RE.test(String(payload.profileId || '')) ? String(payload.profileId) : null;
  const username = normUsername(payload.username) || null;
  if (!profileId && !username) {
    return { ok: false, error: 'Need a numeric profile id or a username to report.' };
  }
  const target = profileId || ('@' + username);
  const reporterHash = 'acct_' + (await sha256Hex(reporter)).slice(0, 24);
  const dedupKey = platform + '~' + target + '~' + reporterHash;
  const key = platform + ':' + target;

  const fields = { platform, target, reason: payload.reason || 'clone', reporterHash, dedupKey };
  if (profileId) {
    fields.profileId = profileId;
    if (username) fields.username = username;
  } else {
    fields.username = username;
  }
  const opt = {
    displayName: clip(payload.displayName, 80),
    url: url(payload.url),
    note: clip(payload.note, 400),
    postUrl: url(payload.postUrl),
    postId: clip(payload.postId, 64),
    contentSummary: clip(payload.contentSummary, 400)
  };
  if (settings.shareRegion !== false) {
    const ctx = clientContext();
    // Pre-validated with the same patterns the rules use: a malformed value
    // must cost the field, never the report.
    if (ctx.region && /^[A-Za-z]{2,}(?:\/[A-Za-z0-9_+-]{1,40}){0,2}$/.test(ctx.region) &&
        ctx.region.length <= 64) opt.region = ctx.region;
    const lang = (ctx.lang || '').toLowerCase();
    if (lang && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/.test(lang)) opt.lang = lang;
  }
  for (const k of Object.keys(opt)) if (opt[k] != null) fields[k] = opt[k];

  const body = { fields: {} };
  for (const k of Object.keys(fields)) body.fields[k] = { stringValue: String(fields[k]) };

  let res;
  try {
    res = await fetch(base + '/reports?documentId=' + encodeURIComponent(dedupKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach Firestore: ' + (e && e.message) };
  }

  const list = await getLocal(KEYS.BLOCKLIST, null);
  const blocked = !!(list && ((profileId && (list.ids || []).includes(profileId)) ||
                              (username && (list.usernames || []).includes(username))));

  if (res.status === 409) {
    // The document already exists: this account already reported this target.
    return { ok: true, key, status: blocked ? 'approved' : 'pending', count: 1,
             duplicate: true, alreadyBlocked: blocked };
  }
  if (!res.ok) {
    return { ok: false, error: res.status === 403
      ? 'The server rules refused this report.'
      : 'Firestore returned HTTP ' + res.status };
  }

  const reported = await getLocal(KEYS.REPORTED, {});
  reported[key] = { status: blocked ? 'approved' : 'pending', count: 1, blocked, at: Date.now() };
  await setLocal(KEYS.REPORTED, reported);
  return { ok: true, key, status: blocked ? 'approved' : 'pending', count: 1,
           duplicate: false, alreadyBlocked: blocked };
}

async function submitReport(payload) {
  const settings = await getSettings();
  const base = await apiBase(settings);
  if (!base) return { ok: false, error: 'No server configured. Set the blocklist URL in options.' };
  if (!(await hasHostPermission(base + '/'))) {
    return { ok: false, needsPermission: true,
             error: 'Host permission not granted. Open options and click Grant access.' };
  }

  // Refused here as well as at the server. Sending it anyway would only earn a
  // 401, and the person deserves to be told what is actually wrong.
  const reporter = reporterRef(payload.platform, payload.viewerId);
  if (!reporter) {
    return { ok: false, signedOut: true,
             error: 'Sign in to ' + (payload.platform === 'facebook' ? 'Facebook' : 'Threads') +
                    ' before reporting.' };
  }

  // Reports go to Firestore whenever a Firestore documents base is in play --
  // directly as the list URL, or via apiBase when the list itself is served
  // as a static file from hosting and only the writes still need the database.
  const fsReportBase = firestoreDocsBase(settings.apiBase + '/') || firestoreDocsBase(settings.listUrl);
  if (fsReportBase && (!settings.apiBase || firestoreDocsBase(settings.apiBase + '/'))) {
    return firestoreSubmitReport(settings, payload, reporter, fsReportBase);
  }

  const ctx = settings.shareRegion === false ? {} : clientContext();
  const body = {
    platform: payload.platform,
    profileId: payload.profileId || null,
    username: payload.username || null,
    displayName: payload.displayName || null,
    url: payload.url || null,
    reason: payload.reason || 'clone',
    note: payload.note || '',
    reporter,
    // Coarse origin, so the server can tell a clone wave running in one
    // language and time zone from one running in another. This is what makes
    // "block the ones near you" mean anything. Off if shareRegion is disabled.
    region: ctx.region,
    lang: ctx.lang,
    // Present when the report was raised from a specific post rather than a
    // bare profile link. A reviewer deciding whether an account is a clone
    // needs the evidence, not just the name.
    postUrl: payload.postUrl || null,
    postId: payload.postId || null,
    contentSummary: payload.contentSummary || null
  };
  const headers = { 'content-type': 'application/json' };
  if (settings.submitToken) headers.authorization = 'Bearer ' + settings.submitToken;

  let res, json = null;
  try {
    res = await fetch(base + '/reports', { method: 'POST', headers, body: JSON.stringify(body) });
    json = await res.json();
  } catch (e) {
    return { ok: false, error: 'Could not reach the server: ' + (e && e.message) };
  }
  if (!res.ok || !json || !json.ok) {
    if (json && json.error === 'signed-out') {
      return { ok: false, signedOut: true, error: json.message || 'Sign in before reporting.' };
    }
    return { ok: false, error: (json && json.error) || ('server returned HTTP ' + res.status) };
  }

  const cache = await getLocal(KEYS.REPORTED, {});
  cache[json.key] = { status: json.status, count: json.count,
                      blocked: !!json.alreadyBlocked, at: Date.now() };
  await setLocal(KEYS.REPORTED, cache);

  return { ok: true, key: json.key, status: json.status,
           count: json.count, duplicate: !!json.duplicate };
}

const STATUS_TTL_MS = 10 * 60 * 1000;

async function reportStatus(q, force) {
  const key = reportKeyFor(q.platform, q.profileId, q.username);
  const cache = await getLocal(KEYS.REPORTED, {});
  const hit = cache[key];
  if (!force && hit && (Date.now() - hit.at) < STATUS_TTL_MS) {
    return { ok: true, key, cached: true, status: hit.status, count: hit.count, blocked: hit.blocked };
  }

  // Against a Firestore list there is nothing to ask: the published document
  // already carries what the chip needs. Blocked is list membership; pending
  // is the published pending-keys array; anything else is simply unreported.
  const fsSettings = await getSettings();
  const fsStatusMode = firestoreDocsBase(fsSettings.apiBase + '/') ||
    (!fsSettings.apiBase && firestoreDocsBase(fsSettings.listUrl));
  if (fsStatusMode) {
    const rec = await getLocal(KEYS.BLOCKLIST, null);
    const pid = String(q.profileId || '');
    const uname = normUsername(q.username);
    const blocked = !!(rec && (((rec.ids || []).includes(pid)) ||
                               (uname && (rec.usernames || []).includes(uname))));
    const status = blocked ? 'approved'
      : (rec && (rec.pending || []).includes(key)) ? 'pending' : null;
    return { ok: true, key, status, count: 0, blocked };
  }

  const base = await apiBase();
  const unknown = { ok: true, key, status: null, count: 0, blocked: false, offline: true };
  if (!base || !(await hasHostPermission(base + '/'))) return unknown;

  const params = new URLSearchParams({ platform: q.platform || '' });
  if (q.profileId) params.set('profileId', q.profileId);
  if (q.username) params.set('username', q.username);

  let json = null;
  try {
    const res = await fetch(base + '/reports/status?' + params.toString());
    json = await res.json();
  } catch (e) {
    // A lookup failure must never stop someone reporting -- report as unknown.
    return unknown;
  }
  const rec = { status: (json && json.status) || null, count: (json && json.count) || 0,
                blocked: !!(json && json.blocked), at: Date.now() };
  cache[key] = rec;
  await setLocal(KEYS.REPORTED, cache);
  return { ok: true, key, status: rec.status, count: rec.count, blocked: rec.blocked };
}

