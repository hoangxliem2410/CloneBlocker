/**
 * Reference blocklist + report server (zero dependencies).
 *
 *   node server/server.js [--port 8787] [--user admin] [--pass admin123]
 *                          [--submit-token S] [--allow-default-credentials]
 *
 * Two audiences, deliberately separated:
 *
 *   Everyone   GET  /blocklist.json          the list extensions poll
 *              POST /reports                 submit a clone report
 *              GET  /reports/status?...      has this profile been reported?
 *
 *   Admin      GET  /admin                   the moderation dashboard
 *              POST /admin/login             username + password -> session cookie
 *              GET  /admin/reports           review queue
 *              POST /admin/reports/decide    approve -> blocklist, or reject
 *              POST /admin/blocklist/remove  take an entry back off the list
 *              GET  /admin/stats
 *
 * Admin routes accept a signed-in session cookie or HTTP Basic credentials.
 * Report submission is deliberately open -- the point is that ordinary users can
 * flag a clone without an account; the gate belongs at approval, not intake.
 *
 * Reports are deduplicated per (platform, profile): a second report of the same
 * account raises its count and records the reporter rather than creating a new
 * row, so the queue reflects distinct accounts and the count carries the weight
 * of evidence.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = parseInt(argOf('port', process.env.PORT || '8787'), 10);
const ADMIN_USER = argOf('user', process.env.ADMIN_USER || 'admin');
const ADMIN_PASS = argOf('pass', process.env.ADMIN_PASS || 'admin123');
const ALLOW_DEFAULT_REMOTE = args.includes('--allow-default-credentials');
const USING_DEFAULTS = ADMIN_USER === 'admin' && ADMIN_PASS === 'admin123';
const SUBMIT_TOKEN = argOf('submit-token', process.env.SUBMIT_TOKEN || '');
// Behind a reverse proxy every request arrives from 127.0.0.1. Believing that
// would make the entire internet look local -- see isLoopback below.
const TRUST_PROXY = args.includes('--trust-proxy');

// Tunable, because the right ceiling depends on who is behind the address. A
// household NAT or a school shares one address between many honest reporters.
const num = (name, dflt) => {
  const v = parseInt(argOf(name, process.env[name.toUpperCase().replace(/-/g, '_')] || ''), 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const RATE_REPORTS_IP = num('report-rate', 30);      // per address, per minute
const RATE_REPORTS_ACCOUNT = num('account-rate', 10); // per account, per minute
const RATE_LOGIN = num('login-rate', 10);             // per address, per 15 min

// Every field a stranger can set is bounded. Reporting is deliberately open, so
// these caps are the only thing between an anonymous POST and the disk.
const LIMITS = {
  body: 64 * 1024,     // bytes of JSON accepted on any request
  displayName: 80,
  username: 64,
  profileId: 32,
  url: 300,
  postId: 64,
  summary: 400,
  note: 400,
  reporter: 64,
  keys: 500,           // rows one bulk decision may touch
  listEntries: 5000,   // ids+usernames accepted in one list edit
  posts: 20,           // evidence entries kept per account
  notes: 50,           // notes kept per account
  reporters: 1000,     // distinct reporters remembered per account
  accounts: 20000      // accounts tracked before new ones are refused
};

// A fingerprint of the code actually running, reported on /health.
//
// Dev tooling copies this server into a scratch directory and leaves it running
// between sessions. Without this, a process started from an older copy answers
// /health perfectly well and silently serves stale code -- which is how a
// long-retired sign-in gate can outlive the commit that replaced it. Callers
// compare this against the source they expect and restart on a mismatch.
const BUILD = (() => {
  const h = crypto.createHash('sha256');
  try {
    h.update(fs.readFileSync(__filename));
    const pub = path.join(__dirname, 'public');
    for (const f of fs.readdirSync(pub).sort()) {
      h.update(f);
      h.update(fs.readFileSync(path.join(pub, f)));
    }
  } catch (e) { return 'unknown'; }
  return h.digest('hex').slice(0, 12);
})();
const STORE = path.join(__dirname, 'blocklist.json');
const REPORTS = path.join(__dirname, 'reports.json');

const REASONS = ['clone', 'impersonation', 'scam', 'harassment', 'spam', 'other'];
const PLATFORMS = ['facebook', 'threads'];

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------
function loadList() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return {
      ids: Array.isArray(raw.ids) ? raw.ids.map(String) : [],
      usernames: Array.isArray(raw.usernames) ? raw.usernames.map(s => String(s).toLowerCase()) : [],
      docIdOverrides: raw.docIdOverrides && typeof raw.docIdOverrides === 'object' ? raw.docIdOverrides : {}
    };
  } catch (e) {
    return { ids: [], usernames: [], docIdOverrides: {} };
  }
}
// Write through a temporary file and rename over the target. A crash or a full
// disk midway through writeFileSync would otherwise leave a truncated store,
// and the blocklist is the one file this whole system depends on.
function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function saveList(list) { writeJson(STORE, list); }

// Keys are user-influenced, so the map holding them gets no prototype. Looking
// up db.reports['__proto__'] on a normal object returns Object.prototype -- which
// is truthy, and would then be written to as if it were a report.
function bareMap(src) {
  const out = Object.create(null);
  for (const k of Object.keys(src || {})) out[k] = src[k];
  return out;
}
function loadReports() {
  try {
    const raw = JSON.parse(fs.readFileSync(REPORTS, 'utf8'));
    return { reports: bareMap(raw && typeof raw === 'object' ? raw.reports : null) };
  } catch (e) { return { reports: Object.create(null) }; }
}
function saveReports(db) { writeJson(REPORTS, db); }

function etagOf(obj) {
  return '"' + crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 24) + '"';
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

/** Who is calling, for rate limiting. */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.slice(0, 64);
  }
  return ((req.socket && req.socket.remoteAddress) || '').slice(0, 64);
}

/**
 * Is this connection from the machine running the server?
 *
 * This decides whether the shipped default credentials are accepted, so it has
 * to be conservative. Put this server behind nginx and every request genuinely
 * arrives from 127.0.0.1 -- so a forwarding header is treated as proof the hop
 * is not local, unless the operator says the proxy is theirs.
 */
function isLoopback(req) {
  if (!TRUST_PROXY &&
      (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded'])) {
    return false;
  }
  const a = clientIp(req);
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Is the browser talking to us over TLS? Decides the cookie's Secure flag. */
function isSecureReq(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (!TRUST_PROXY) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// ---------------------------------------------------------------------------
// input limits
// ---------------------------------------------------------------------------

// Control characters serve no purpose in a name, a note or a URL, and they
// make both the dashboard and the log unreadable.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Trim a caller-supplied string to a sane length, without control characters. */
function clip(v, max) {
  if (v == null) return '';
  // Control characters serve no purpose in a name or a note, and they make both
  // the dashboard and the log unreadable. Newlines survive in free text.
  const s = String(v).replace(CONTROL_CHARS, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Accept only an ordinary web URL.
 *
 * The dashboard renders these as links the owner clicks. A "javascript:" URL in
 * that position runs in the dashboard's origin carrying the admin session, which
 * would let an anonymous reporter approve their own report. Anything that is not
 * http(s) is dropped rather than stored.
 */
function safeUrl(v, max) {
  if (v == null) return null;
  // Deliberately not clipped. Truncating a URL does not shorten it, it produces
  // a different URL that still parses and points somewhere else -- so an
  // over-long one is refused rather than quietly rewritten.
  const s = String(v).replace(CONTROL_CHARS, '').trim();
  if (!s || s.length > max) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.href.length > max ? null : u.href;
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// reporter identity and reputation
// ---------------------------------------------------------------------------
//
// A report is only as good as who filed it, and the previous scheme keyed that
// on a UUID the extension generated for itself -- so clearing extension storage
// minted a brand new reporter and any report's count could be inflated forever
// by one person.
//
// Reports now carry the platform account behind them. This is NOT verified and
// cannot be: fb_dtsg, lsd and the session cookies are opaque artifacts only Meta
// can validate, and validating them means Meta's API. What it buys is cost --
// inflating a count means acquiring real accounts rather than clearing a key --
// and, more importantly, it gives reputation something stable to attach to.
const REPORTER_RE = /^(facebook|threads):\d{4,24}$/;

// The raw account id never reaches the disk. A stable per-server HMAC keeps
// everything reputation needs -- "is this the same person as last time" -- while
// leaving the store useless to anyone who copies it. The owner can still ban a
// persistent bad actor: they ban the pseudonym.
const SALT_FILE = path.join(__dirname, '.reporter-salt');
const REPORTER_SALT = (() => {
  try { return fs.readFileSync(SALT_FILE, 'utf8').trim(); } catch (e) {}
  const salt = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 }); } catch (e) {}
  return salt;
})();
function pseudonym(accountRef) {
  return 'acct_' + crypto.createHmac('sha256', REPORTER_SALT)
    .update(accountRef).digest('hex').slice(0, 16);
}

// Jeffreys prior: an unknown reporter sits at 0.5, a long record pulls hard
// toward 0 or 1 without ever quite arriving. One bad call does not ruin someone
// with a good history, and one lucky call does not buy trust.
const TRUST_FLOOR = 0.25;
function weightOf(rec) {
  const a = rec.approved || 0, r = rec.rejected || 0;
  return (a + 0.5) / (a + r + 1);
}

/**
 * Reputation, recomputed from the decided reports every time it is needed.
 *
 * Deliberately not stored. A running tally has to be un-done when a decision is
 * revoked, and every bug in that path is a reporter whose score is quietly
 * wrong forever. Recomputing is O(reports) on a store that is capped anyway.
 */
function reputation(db) {
  const rep = Object.create(null);
  const bump = (who, field) => {
    if (!hasOwn(rep, who)) rep[who] = { approved: 0, rejected: 0 };
    rep[who][field]++;
  };
  for (const r of Object.values(db.reports)) {
    const field = r.status === 'approved' ? 'approved'
                : r.status === 'rejected' ? 'rejected' : null;
    if (!field) continue;                    // pending teaches us nothing yet
    for (const who of (r.reporters || [])) bump(who, field);
  }
  for (const who of Object.keys(rep)) rep[who].weight = weightOf(rep[who]);
  return rep;
}

const trustOf = (rep, who) => (hasOwn(rep, who) ? rep[who].weight : weightOf({}));

/**
 * Annotate a report with who stands behind it.
 *
 * `score` is the count weighted by trust, and it -- not the raw count -- is what
 * the queue is ranked by. Ten reports from accounts that have never been right
 * about anything should not outrank two from people who consistently are.
 */
function withTrust(r, rep) {
  const reporters = r.reporters || [];
  const score = reporters.reduce((n, who) => n + trustOf(rep, who), 0);
  const best = reporters.reduce((m, who) => Math.max(m, trustOf(rep, who)), 0);
  return Object.assign({}, r, {
    score: Math.round(score * 100) / 100,
    // Held: nobody behind this report has a usable record. It stays in the
    // store and stays visible, but it does not get to jump the queue.
    held: reporters.length > 0 && best < TRUST_FLOOR,
    trust: reporters.map(who => ({
      who,
      weight: Math.round(trustOf(rep, who) * 100) / 100,
      approved: hasOwn(rep, who) ? rep[who].approved : 0,
      rejected: hasOwn(rep, who) ? rep[who].rejected : 0
    }))
  });
}

// ---------------------------------------------------------------------------
// where a report came from, and when
// ---------------------------------------------------------------------------
//
// A blocklist of a few thousand clones cannot be worked through by one account:
// the platforms checkpoint an account that blocks at volume, which is exactly
// the failure this is meant to prevent. So the list splits in two. Hiding is
// free and applies to everything; blocking is expensive and has to be spent on
// the few accounts that matter to this person right now.
//
// Deciding which those are needs to know where a clone is operating and whether
// it is still active, so reports carry a coarse origin -- the reporter's IANA
// time zone and language, both of which the browser already knows and neither
// of which requires an IP lookup, a geo database, or a third-party service.

// "Asia/Ho_Chi_Minh", "UTC", "Europe/London". Deliberately narrow: this string
// is used as an object key and shown on a dashboard.
const REGION_RE = /^[A-Za-z]{2,}(?:\/[A-Za-z0-9_+-]{1,40}){0,2}$/;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

const DAY_BUCKETS = 14;    // days of history kept per account
const REGION_CAP = 24;     // distinct regions remembered per account
const LANG_CAP = 16;
const HALF_LIFE_DAYS = 7;  // a clone reported a week ago counts half as much

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Add one to obj[key], evicting the smallest entry when full. */
function bump(obj, key, cap) {
  if (!key) return;
  if (!hasOwn(obj, key)) {
    const keys = Object.keys(obj);
    if (keys.length >= cap) {
      // Evict the least-reported, not the oldest: a region with a single stray
      // report is the one worth forgetting.
      let worst = keys[0];
      for (const k of keys) if (obj[k] < obj[worst]) worst = k;
      delete obj[worst];
    }
    obj[key] = 0;
  }
  obj[key]++;
}

/** Keep only the most recent day buckets, so a long-lived record stays bounded. */
function trimDays(days) {
  const keys = Object.keys(days).sort();
  while (keys.length > DAY_BUCKETS) delete days[keys.shift()];
}

const validRegion = (v) => { const s = clip(v, 64); return REGION_RE.test(s) ? s : null; };
const validLang = (v) => { const s = clip(v, 16); return LANG_RE.test(s) ? s.toLowerCase() : null; };

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

/** Reports in the last `n` day buckets. */
function velocity(days, n) {
  const cutoff = dayKey(Date.now() - (n - 1) * 86400000);
  let total = 0;
  for (const k of Object.keys(days || {})) if (k >= cutoff) total += days[k];
  return total;
}

/**
 * How strongly this account's reports come from a given region.
 *
 * Smoothed, so a clone with two reports from your city does not outrank one
 * with fifty from it purely because both happen to be 100% local.
 */
function affinity(tally, key, total) {
  if (!key) return 1;                       // caller gave no region: stay neutral
  const here = (tally && hasOwn(tally, key)) ? tally[key] : 0;
  return (here + 0.5) / (total + 1);
}

/**
 * Rank the blockable accounts for one client.
 *
 * Everything here is quantised to whole days on purpose. A continuously-decaying
 * score would change on every request, which would change the ETag on every
 * request, which would turn a cheap 304 into a full download every time the
 * extension polls.
 */
function rankTargets(db, list, opts) {
  const region = validRegion(opts.region);
  const lang = validLang(opts.lang);
  const platform = PLATFORMS.includes(opts.platform) ? opts.platform : null;
  const rep = reputation(db);
  const onList = new Set(list.ids.map(String));
  const today = Date.now();
  const out = [];

  for (const r of Object.values(db.reports)) {
    // Only things actually on the blocklist, and only ones we can name by id:
    // a block is issued against a numeric id, never a username.
    if (r.status !== 'approved') continue;
    if (!r.profileId || !onList.has(String(r.profileId))) continue;
    if (platform && r.platform !== platform) continue;

    const days = r.days || {};
    const total = Object.values(r.regions || {}).reduce((n, v) => n + v, 0);

    const trust = (r.reporters || []).reduce((n, who) => n + trustOf(rep, who), 0);
    const ageDays = Math.max(0,
      Math.floor((today - Date.parse(r.lastReportAt || r.updatedAt || r.createdAt || 0)) / 86400000));
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const vel = velocity(days, 7);
    const regionAff = affinity(r.regions, region, total);
    const langAff = affinity(r.langs, lang, total);

    // Region never zeroes a target out -- a clone that is merely hot elsewhere
    // should still be reachable -- but it dominates the ordering when it fits.
    const locality = 0.25 + 0.75 * Math.max(regionAff, langAff * 0.8);
    const rank = trust * recency * (1 + vel) * locality;

    out.push({
      platform: r.platform,
      id: String(r.profileId),
      username: r.username || null,
      displayName: r.displayName || null,
      rank: Math.round(rank * 1000) / 1000,
      // Shown in the dashboard and in the extension's own log, so a target that
      // looks wrong can be explained rather than just distrusted.
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
 * The trending matrix: regions down the side, days across.
 *
 * This is the view that answers "is a wave starting, and where" -- which is the
 * question that decides whose clones are worth spending a block budget on.
 */
function trendMatrix(db, opts) {
  const span = Math.min(Math.max(parseInt(opts.days, 10) || DAY_BUCKETS, 1), DAY_BUCKETS);
  const days = [];
  for (let i = span - 1; i >= 0; i--) days.push(dayKey(Date.now() - i * 86400000));
  const dayIdx = new Map(days.map((d, i) => [d, i]));

  const totals = Object.create(null);
  const rows = Object.create(null);
  const perRegion = Object.create(null);

  for (const r of Object.values(db.reports)) {
    const rd = r.days || {};
    for (const reg of Object.keys(r.regions || {})) {
      if (!hasOwn(rows, reg)) rows[reg] = new Array(span).fill(0);
      if (!hasOwn(perRegion, reg)) perRegion[reg] = [];
      // A record's day buckets are not split by region -- one account rarely
      // spans several -- so the account's dominant region carries its history.
      totals[reg] = (totals[reg] || 0) + r.regions[reg];
      perRegion[reg].push(r);
    }
    const dominant = Object.keys(r.regions || {})
      .sort((a, b) => r.regions[b] - r.regions[a])[0];
    if (!dominant) continue;
    for (const d of Object.keys(rd)) {
      if (dayIdx.has(d)) rows[dominant][dayIdx.get(d)] += rd[d];
    }
  }

  const regions = Object.keys(rows).sort((a, b) => totals[b] - totals[a]).slice(0, 12);
  const rep = reputation(db);
  const topByRegion = Object.create(null);
  for (const reg of regions) {
    topByRegion[reg] = (perRegion[reg] || [])
      .map(r => ({
        key: r.key,
        displayName: r.displayName || null,
        username: r.username || null,
        platform: r.platform,
        status: r.status,
        last7: velocity(r.days, 7),
        reports: (r.reporters || []).length,
        trust: Math.round((r.reporters || [])
          .reduce((n, who) => n + trustOf(rep, who), 0) * 100) / 100
      }))
      .sort((a, b) => (b.last7 - a.last7) || (b.trust - a.trust))
      .slice(0, 5);
  }

  return {
    days,
    regions,
    matrix: regions.map(reg => rows[reg]),
    totals: regions.map(reg => totals[reg]),
    topByRegion
  };
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------
// Fixed windows per caller. Crude, but it is the difference between an open
// endpoint and an open invitation: without it one script can fill the disk with
// reports, or work a password list at line speed.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.n++;
  if (b.n > max) return { ok: false, retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
  return { ok: true, retryAfter: 0 };
}
// Both maps are unbounded otherwise: one caller per key, forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
  for (const [sid, rec] of sessions) if (now - rec.at > SESSION_TTL_MS) sessions.delete(sid);
}, 5 * 60 * 1000).unref();

// Browser sessions, held in memory. Restarting the server signs everyone out,
// which is the right trade for a self-hosted tool: no session store to keep,
// and no stale credential surviving a redeploy.
const SESSION_TTL_MS = 12 * 3600 * 1000;
const sessions = new Map();

const MAX_SESSIONS = 200;
function newSession(user) {
  // Bounded, so repeated sign-ins cannot grow memory without limit. The oldest
  // goes first; for a single-owner tool this is never reached in practice.
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = Array.from(sessions.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  const sid = crypto.randomBytes(24).toString('base64url');
  sessions.set(sid, { user, at: Date.now() });
  return sid;
}
function sessionUser(sid) {
  const rec = sid && sessions.get(sid);
  if (!rec) return null;
  if (Date.now() - rec.at > SESSION_TTL_MS) { sessions.delete(sid); return null; }
  return rec.user;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Constant-time comparison, so a wrong password cannot be discovered by
 *  measuring how long the check takes. */
function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) {
    // Compare something of equal length anyway, so length alone does not leak.
    crypto.timingSafeEqual(A, A);
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

function credentialsValid(user, pass) {
  // Both halves are always evaluated; && would short-circuit on the username
  // and reintroduce the timing signal safeEqual exists to remove.
  const okUser = safeEqual(user || '', ADMIN_USER);
  const okPass = safeEqual(pass || '', ADMIN_PASS);
  return okUser && okPass;
}

/** HTTP Basic, for scripts and curl. The dashboard uses a session cookie. */
function basicAuth(req) {
  const m = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (e) { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/**
 * Admin access: a signed-in browser session, or HTTP Basic credentials.
 *
 * The shipped defaults (admin / admin123) are public knowledge, so they are
 * accepted from loopback only. Deploying to a public host without changing them
 * would otherwise hand the review queue and the blocklist to anyone who reads
 * this file. Pass --allow-default-credentials to override that deliberately.
 */
function isAdmin(req) {
  if (USING_DEFAULTS && !ALLOW_DEFAULT_REMOTE && !isLoopback(req)) return false;
  if (sessionUser(parseCookies(req)['3que_sid'])) return true;
  const basic = basicAuth(req);
  return !!(basic && credentialsValid(basic.user, basic.pass));
}

// Reporting stays open: the whole point is that ordinary users can flag a clone
// without an account or a credential. The gate belongs at approval, not intake.
function canSubmit(req) { return !SUBMIT_TOKEN || bearer(req) === SUBMIT_TOKEN; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Collect Buffers and decode once at the end.
    //
    // Appending each chunk to a string decodes every chunk independently, and a
    // multi-byte character split across a chunk boundary is destroyed by that --
    // which for names like "Nguyễn Văn A" means the report arrives
    // corrupted. Concatenating first keeps the character whole.
    // Refuse on the declared length before reading a byte, so an oversized
    // upload is rejected at the door rather than after we have buffered it.
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > LIMITS.body) { reject(new Error('body too large')); return; }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // A chunked request declares no length, so the running total is still the
      // check that matters.
      if (size > LIMITS.body) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Sent on everything. nosniff stops a JSON body being re-interpreted as script;
// DENY keeps the dashboard out of a frame; no-referrer stops profile URLs in the
// query string leaking to whatever the admin clicks through to.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer'
};

// CORS is for the extension, which posts reports and polls the list from a
// facebook.com or threads.com page. Admin routes are same-origin only -- the
// dashboard is served from this server -- so they advertise no cross-origin
// access at all. res.corsOk is set per request in the handler below.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-none-match',
  'access-control-expose-headers': 'etag'
};

function send(res, status, obj, extra) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  }, SECURITY_HEADERS, res.corsOk ? CORS_HEADERS : {}, extra || {}));
  res.end(body);
}

const normUser = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');
// Bounded on both ends: an unbounded digit run is still "a number", and a
// megabyte of them would sail through as a profile id.
const isId = (v) => /^\d{4,24}$/.test(String(v || '').trim());

/** Doc-id overrides are a map of short opaque strings; treat them as such. */
function sanitizeOverrides(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = Object.create(null);
  let n = 0;
  for (const k of Object.keys(v)) {
    if (++n > 100) break;
    const key = clip(k, 64), val = clip(v[k], 64);
    if (key && val) out[key] = val;
  }
  return out;
}

/** One stable key per reported account, so repeats aggregate. */
function reportKey(platform, profileId, username) {
  const p = PLATFORMS.includes(platform) ? platform : 'unknown';
  return isId(profileId) ? `${p}:${String(profileId).trim()}` : `${p}:@${normUser(username)}`;
}

function normalizeInput(body) {
  const ids = [], usernames = [];
  let seen = 0;
  const take = (v) => {
    if (++seen > LIMITS.listEntries) return;
    const s = clip(v, LIMITS.username);
    if (!s) return;
    if (isId(s)) ids.push(s); else usernames.push(normUser(s));
  };
  if (Array.isArray(body)) body.forEach(take);
  else {
    (body.ids || []).forEach(take);
    (body.usernames || []).forEach(take);
    (body.blocked || []).forEach((e) => {
      if (e && typeof e === 'object') { if (e.id) take(e.id); if (e.username) take(e.username); }
      else take(e);
    });
  }
  return { ids, usernames };
}

/** Put an approved report onto the blocklist. */
function addToList(report) {
  const list = loadList();
  let changed = false;
  if (isId(report.profileId) && !list.ids.includes(String(report.profileId))) {
    list.ids.push(String(report.profileId)); changed = true;
  }
  const u = normUser(report.username);
  // Only fall back to the username when there is no numeric id: ids survive
  // renames, usernames do not.
  if (!isId(report.profileId) && u && !list.usernames.includes(u)) {
    list.usernames.push(u); changed = true;
  }
  if (changed) saveList(list);
  return changed;
}

function removeFromList(report) {
  const list = loadList();
  const before = list.ids.length + list.usernames.length;
  if (report.profileId) list.ids = list.ids.filter(x => x !== String(report.profileId));
  const u = normUser(report.username);
  if (u) list.usernames = list.usernames.filter(x => x !== u);
  const changed = (list.ids.length + list.usernames.length) !== before;
  if (changed) saveList(list);
  return changed;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname.replace(/\/+$/, '') || '/';

  // The extension calls these from a facebook.com / threads.com page, so they
  // answer cross-origin. Everything else -- the whole admin surface -- is
  // same-origin only and advertises no CORS at all, so a hostile page cannot
  // read a response even if it somehow arrives authenticated.
  res.corsOk = (p === '/blocklist.json' || p === '/reports' || p === '/reports/status' || p === '/health');

  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }
  if (p === '/health') { send(res, 200, { ok: true, uptime: process.uptime(), build: BUILD }); return; }

  // ---- the moderation dashboard ----------------------------------------
  //
  // Served here rather than shipped in the extension: this is the owner's tool.
  // Putting it in a distributed extension would place the admin token in every
  // user's copy, and moderating should not require the extension at all.
  //
  // The page itself is public; every byte of data it shows comes from /admin/*
  // routes that demand the token.
  if ((p === '/admin' || p === '/admin/admin.css' || p === '/admin/admin.js') && req.method === 'GET') {
    const FILES = {
      '/admin': ['admin.html', 'text/html; charset=utf-8'],
      '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8'],
      '/admin/admin.js': ['admin.js', 'text/javascript; charset=utf-8']
    };
    // Whitelisted names only -- never join user input into a path.
    const [file, type] = FILES[p];
    try {
      const body = fs.readFileSync(path.join(__dirname, 'public', file));
      res.writeHead(200, Object.assign({
        'content-type': type,
        'cache-control': 'no-store',
        // The dashboard renders text supplied by strangers. Its own script and
        // stylesheet are the only ones that may run, it may talk only to this
        // origin, and nothing inline is allowed -- so a payload that reached the
        // page as data still has no way to execute.
        'content-security-policy': [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self'",
          "connect-src 'self'",
          "img-src 'self' data:",
          "form-action 'none'",
          "frame-ancestors 'none'",
          "base-uri 'none'"
        ].join('; ')
      }, SECURITY_HEADERS));
      res.end(body);
    } catch (e) {
      send(res, 500, { ok: false, error: 'dashboard asset missing: ' + file });
    }
    return;
  }

  // ---- public: the list -----------------------------------------------
  if (p === '/blocklist.json' && req.method === 'GET') {
    const list = loadList();

    // Two lists, because the two layers cost completely different things.
    //
    // ids/usernames is everything: hiding a clone in the DOM is free and
    // carries no risk, so there is no reason to ration it.
    //
    // targets is a ranked, budgeted slice: a real platform block is what gets
    // an account checkpointed, so it has to be spent on the few clones that are
    // active now and operating where this person is. The client asks for what
    // its own rate limiter still has room for.
    const budget = Math.min(Math.max(parseInt(url.searchParams.get('budget'), 10) || 25, 1), 200);
    const wantsTargets = url.searchParams.has('region') || url.searchParams.has('platform') ||
                         url.searchParams.has('budget') || url.searchParams.has('lang');
    let payload = list;
    if (wantsTargets) {
      const ranked = rankTargets(loadReports(), list, {
        region: url.searchParams.get('region'),
        lang: url.searchParams.get('lang'),
        platform: url.searchParams.get('platform')
      });
      payload = Object.assign({}, list, {
        targets: ranked.slice(0, budget),
        targetsAvailable: ranked.length,
        budget
      });
    }
    const etag = etagOf(payload);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, Object.assign({ etag }, SECURITY_HEADERS, CORS_HEADERS));
      res.end(); return;
    }
    send(res, 200, payload, { etag });
    return;
  }

  // ---- public: submit a report -----------------------------------------
  if (p === '/reports' && req.method === 'POST') {
    if (!canSubmit(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return; }
    // Open to anyone, so it is bounded per caller: 30 a minute is far above what
    // a person clicking "report" can produce and far below what a script can.
    const rl = rateLimit('report:' + clientIp(req), RATE_REPORTS_IP, 60 * 1000);
    if (!rl.ok) {
      send(res, 429, { ok: false, error: 'too many reports, slow down' },
        { 'retry-after': String(rl.retryAfter) });
      return;
    }
    let body;
    try { body = await readBody(req); } catch (e) { send(res, 400, { ok: false, error: e.message }); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { ok: false, error: 'expected a JSON object' }); return;
    }

    const platform = PLATFORMS.includes(body.platform) ? body.platform : null;
    const profileId = clip(body.profileId, LIMITS.profileId);
    const username = normUser(clip(body.username, LIMITS.username));
    if (!platform) { send(res, 400, { ok: false, error: 'platform must be facebook or threads' }); return; }
    if (!isId(profileId) && !username) {
      send(res, 400, { ok: false, error: 'need a numeric profileId or a username' }); return;
    }
    const reason = REASONS.includes(body.reason) ? body.reason : 'clone';

    const db = loadReports();
    const key = reportKey(platform, profileId, username);
    const now = new Date().toISOString();
    // Signed-out reports are refused. A report with no account behind it costs
    // nothing to produce, so it cannot be allowed to carry any weight, and
    // accepting it at zero weight would only fill the store.
    const claimed = clip(body.reporter, LIMITS.reporter);
    if (!REPORTER_RE.test(claimed)) {
      send(res, 401, { ok: false, error: 'signed-out',
        message: 'Sign in to Facebook or Threads before reporting.' });
      return;
    }
    const reporter = pseudonym(claimed);

    // A second limit, per account rather than per address: one account behind a
    // pool of addresses is the shape mass-reporting actually takes.
    const arl = rateLimit('acct:' + reporter, RATE_REPORTS_ACCOUNT, 60 * 1000);
    if (!arl.ok) {
      send(res, 429, { ok: false, error: 'too many reports from this account' },
        { 'retry-after': String(arl.retryAfter) });
      return;
    }

    let rec = hasOwn(db.reports, key) ? db.reports[key] : null;
    if (!rec) {
      // Refuse to open new files once the store is full rather than growing the
      // disk without limit. Existing reports still accumulate evidence.
      if (Object.keys(db.reports).length >= LIMITS.accounts) {
        send(res, 507, { ok: false, error: 'report store is full' }); return;
      }
      rec = db.reports[key] = {
        key, platform,
        profileId: isId(profileId) ? profileId : null,
        username: username || null,
        displayName: clip(body.displayName, LIMITS.displayName) || null,
        url: safeUrl(body.url, LIMITS.url),
        reason,
        status: 'pending',
        count: 0,
        reporters: [],
        notes: [],
        // Evidence: the posts people pointed at when reporting. Kept as a list
        // because the case against a clone is usually cumulative -- one post
        // may be ambiguous where three are not.
        posts: [],
        // Where this clone is operating and when it was last active. Both drive
        // the ranking that decides whose block budget it is worth spending.
        regions: Object.create(null),
        langs: Object.create(null),
        days: Object.create(null),
        lastReportAt: now,
        createdAt: now,
        updatedAt: now
      };
    }
    if (!Array.isArray(rec.posts)) rec.posts = [];

    // Late-arriving detail improves the record even on a repeat report.
    if (!rec.profileId && isId(profileId)) rec.profileId = profileId;
    if (!rec.username && username) rec.username = username;
    if (!rec.displayName && body.displayName) rec.displayName = clip(body.displayName, LIMITS.displayName) || null;
    if (!rec.url && body.url) rec.url = safeUrl(body.url, LIMITS.url);

    // Attach the post this report came from, if it names one.
    if (body.postUrl || body.contentSummary) {
      const postUrl = safeUrl(body.postUrl, LIMITS.url);
      const summary = clip(body.contentSummary, LIMITS.summary) || null;
      // A rejected URL should not silently become a post with no link, and a
      // post with neither link nor text is not evidence of anything.
      if (postUrl || summary) {
        const already = postUrl && rec.posts.some(x => x.url === postUrl);
        if (!already) {
          rec.posts.push({
            url: postUrl,
            postId: clip(body.postId, LIMITS.postId) || null,
            summary,
            by: reporter,
            at: now
          });
          if (rec.posts.length > LIMITS.posts) rec.posts = rec.posts.slice(-LIMITS.posts);
        }
      }
    }

    const isNewReporter = !rec.reporters.includes(reporter);
    if (isNewReporter && rec.reporters.length < LIMITS.reporters) rec.reporters.push(reporter);
    if (isNewReporter) rec.count++;
    const note = clip(body.note, LIMITS.note);
    // Notes are appended on every submission, not only new reporters, so this
    // list is the one an attacker can grow fastest.
    if (note) {
      rec.notes.push({ at: now, by: reporter, text: note });
      if (rec.notes.length > LIMITS.notes) rec.notes = rec.notes.slice(-LIMITS.notes);
    }
    // Records created before this existed have no buckets; fill them in rather
    // than special-casing every read.
    if (!rec.regions) rec.regions = Object.create(null);
    if (!rec.langs) rec.langs = Object.create(null);
    if (!rec.days) rec.days = Object.create(null);

    bump(rec.regions, validRegion(body.region), REGION_CAP);
    bump(rec.langs, validLang(body.lang), LANG_CAP);
    bump(rec.days, dayKey(Date.now()), DAY_BUCKETS + 4);
    trimDays(rec.days);
    // Distinct from updatedAt, which an admin decision also moves. Recency has
    // to mean "last seen active", not "last touched".
    rec.lastReportAt = now;

    rec.updatedAt = now;
    // A previously rejected account being reported again deserves another look.
    if (rec.status === 'rejected' && isNewReporter) rec.status = 'pending';
    saveReports(db);

    send(res, 200, {
      ok: true, key, status: rec.status, count: rec.count,
      duplicate: !isNewReporter,
      alreadyBlocked: rec.status === 'approved'
    });
    return;
  }

  // ---- public: has this profile been reported/blocked? -----------------
  if (p === '/reports/status' && req.method === 'GET') {
    const platform = clip(url.searchParams.get('platform'), 16);
    const profileId = clip(url.searchParams.get('profileId'), LIMITS.profileId);
    const username = clip(url.searchParams.get('username'), LIMITS.username);
    const key = reportKey(platform, profileId, username);
    const rec = loadReports().reports[key];
    const list = loadList();
    const blocked = (profileId && list.ids.includes(String(profileId))) ||
                    (username && list.usernames.includes(normUser(username)));
    send(res, 200, {
      ok: true, key,
      reported: !!rec,
      status: rec ? rec.status : null,
      count: rec ? rec.count : 0,
      blocked: !!blocked
    });
    return;
  }

  // ---- admin sign-in ----------------------------------------------------
  if (p === '/admin/login' && req.method === 'POST') {
    // A password guess costs one request; without this, a list can be worked
    // through at line speed. Ten a quarter-hour is generous for a person who
    // mistyped and useless to a script.
    const rl = rateLimit('login:' + clientIp(req), RATE_LOGIN, 15 * 60 * 1000);
    if (!rl.ok) {
      send(res, 429, { ok: false, error: 'too many sign-in attempts, try again later' },
        { 'retry-after': String(rl.retryAfter) });
      return;
    }
    let body;
    try { body = await readBody(req); } catch (e) { send(res, 400, { ok: false, error: e.message }); return; }
    if (!body || typeof body !== 'object') { send(res, 400, { ok: false, error: 'expected a JSON object' }); return; }

    if (USING_DEFAULTS && !ALLOW_DEFAULT_REMOTE && !isLoopback(req)) {
      send(res, 403, { ok: false,
        error: 'This server still uses the default credentials, so sign-in is limited to the ' +
               'machine it runs on. Start it with --user and --pass to allow remote access.' });
      return;
    }
    if (!credentialsValid(body.username, body.password)) {
      send(res, 401, { ok: false, error: 'Wrong username or password' });
      return;
    }
    const sid = newSession(clip(body.username, LIMITS.reporter));
    send(res, 200, { ok: true, user: ADMIN_USER, usingDefaults: USING_DEFAULTS }, {
      // HttpOnly keeps the session out of reach of page scripts; SameSite=Strict
      // means another site cannot ride it; Secure keeps it off plaintext HTTP
      // once there is TLS to keep it on.
      'set-cookie': `3que_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; ` +
                    `${isSecureReq(req) ? 'Secure; ' : ''}Max-Age=${SESSION_TTL_MS / 1000}`
    });
    return;
  }

  if (p === '/admin/logout' && req.method === 'POST') {
    const sid = parseCookies(req)['3que_sid'];
    if (sid) sessions.delete(sid);
    send(res, 200, { ok: true }, { 'set-cookie': '3que_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return;
  }

  // Who am I? Lets the dashboard decide between the gate and the app without
  // provoking a 401 in the console on every load.
  if (p === '/admin/session' && req.method === 'GET') {
    const user = sessionUser(parseCookies(req)['3que_sid']);
    send(res, 200, {
      ok: true, signedIn: !!user, user: user || null,
      usingDefaults: USING_DEFAULTS,
      loopback: isLoopback(req)
    });
    return;
  }

  // ---- everything below is admin ---------------------------------------
  if (p.startsWith('/admin')) {
    if (!isAdmin(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return; }

    if (p === '/admin/reports' && req.method === 'GET') {
      const want = url.searchParams.get('status');
      const db = loadReports();
      const rep = reputation(db);
      const all = Object.values(db.reports);
      const rows = (want ? all.filter(r => r.status === want) : all)
        .map(r => withTrust(r, rep))
        // Ranked by trust-weighted score, not by raw count: ten reports from
        // accounts that have never been right should not outrank two from
        // people who consistently are. Held reports sink to the bottom.
        .sort((a, b) => (a.held ? 1 : 0) - (b.held ? 1 : 0) ||
                        (b.score - a.score) ||
                        (b.updatedAt < a.updatedAt ? -1 : 1));
      send(res, 200, { ok: true, count: rows.length, reports: rows });
      return;
    }

    if (p === '/admin/reports/decide' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { send(res, 400, { ok: false, error: e.message }); return; }
      const decision = body.decision;
      if (!['approve', 'reject', 'revoke'].includes(decision)) {
        send(res, 400, { ok: false, error: 'decision must be approve, reject or revoke' }); return;
      }
      // One key or many: a moderator clearing a queue should not have to make
      // one request per row.
      const keys = Array.isArray(body.keys) && body.keys.length ? body.keys
                 : (body.key ? [body.key] : []);
      if (!keys.length) { send(res, 400, { ok: false, error: 'need key or keys' }); return; }
      if (keys.length > LIMITS.keys) {
        send(res, 400, { ok: false, error: `at most ${LIMITS.keys} keys per request` }); return;
      }

      const db = loadReports();
      const at = new Date().toISOString();
      const by = clip(body.by, LIMITS.reporter) || 'admin';
      const note = clip(body.note, LIMITS.note);
      const done = [], missing = [];
      let listChanged = 0;

      for (const k of keys) {
        // hasOwn, not a bare lookup: db.reports['__proto__'] on an ordinary
        // object hands back Object.prototype, which is truthy, and the loop
        // below would then write a status onto it.
        const key = clip(k, LIMITS.url);
        const rec = hasOwn(db.reports, key) ? db.reports[key] : null;
        if (!rec) { missing.push(key); continue; }
        if (decision === 'approve') { if (addToList(rec)) listChanged++; rec.status = 'approved'; }
        if (decision === 'reject') { rec.status = 'rejected'; }
        // revoke undoes an approval: off the list, back to pending review.
        if (decision === 'revoke') { if (removeFromList(rec)) listChanged++; rec.status = 'pending'; }
        rec.decidedAt = at;
        rec.decidedBy = by;
        if (note) {
          rec.notes.push({ at, by, text: note });
          if (rec.notes.length > LIMITS.notes) rec.notes = rec.notes.slice(-LIMITS.notes);
        }
        rec.updatedAt = at;
        done.push({ key, status: rec.status });
      }
      saveReports(db);

      send(res, 200, {
        ok: missing.length === 0, decided: done, missing, listChanged,
        // Single-key callers keep the original shape.
        key: done.length === 1 ? done[0].key : undefined,
        status: done.length === 1 ? done[0].status : undefined
      });
      return;
    }

    if (p === '/admin/blocklist/remove' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { send(res, 400, { ok: false, error: e.message }); return; }
      const norm = normalizeInput(body);
      const list = loadList();
      const dropIds = new Set(norm.ids), dropNames = new Set(norm.usernames);
      const before = list.ids.length + list.usernames.length;
      list.ids = list.ids.filter(x => !dropIds.has(x));
      list.usernames = list.usernames.filter(x => !dropNames.has(x));
      saveList(list);

      // Keep the review queue honest: anything taken off the list is no longer
      // "approved", or the admin view would contradict the list itself.
      const db = loadReports();
      for (const rec of Object.values(db.reports)) {
        if (rec.status !== 'approved') continue;
        if ((rec.profileId && dropIds.has(String(rec.profileId))) ||
            (rec.username && dropNames.has(normUser(rec.username)))) {
          rec.status = 'pending';
          rec.updatedAt = new Date().toISOString();
        }
      }
      saveReports(db);

      send(res, 200, { ok: true, removed: before - (list.ids.length + list.usernames.length) });
      return;
    }

    if (p === '/admin/stats' && req.method === 'GET') {
      const db = loadReports();
      const all = Object.values(db.reports);
      const list = loadList();
      const by = (s) => all.filter(r => r.status === s).length;

      // Object.create(null) throughout: these are keyed by reporter names and
      // other caller-supplied strings, and "__proto__" as a key on an ordinary
      // object rewrites the prototype instead of counting anything.
      const tally = (fn) => {
        const m = Object.create(null);
        for (const r of all) { const k = fn(r); if (k) m[k] = (m[k] || 0) + 1; }
        return Object.entries(m).sort((a, b) => b[1] - a[1]);
      };

      // Reports per day for the last fortnight, oldest first, so the dashboard
      // can show whether the queue is growing or being kept up with.
      const days = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        days.push({ day: d, count: 0 });
      }
      const dayIndex = new Map(days.map((d, i) => [d.day, i]));
      for (const r of all) {
        const d = String(r.createdAt || '').slice(0, 10);
        if (dayIndex.has(d)) days[dayIndex.get(d)].count++;
      }

      // Reporter volume, which is what surfaces both the most helpful users and
      // anyone mass-reporting.
      const reporters = Object.create(null);
      for (const r of all) for (const who of (r.reporters || [])) {
        reporters[who] = (reporters[who] || 0) + 1;
      }
      // Volume alone flatters a mass-reporter. Carrying the weight alongside it
      // is what separates a prolific useful reporter from a prolific wrong one.
      const rep = reputation({ reports: db.reports });
      const topReporters = Object.entries(reporters)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([who, n]) => [who, n, Math.round(trustOf(rep, who) * 100) / 100]);
      const distrusted = Object.keys(rep).filter(w => rep[w].weight < TRUST_FLOOR).length;
      const heldCount = all.filter(r => {
        const rs = r.reporters || [];
        return rs.length > 0 && rs.every(w => trustOf(rep, w) < TRUST_FLOOR);
      }).length;

      const withEvidence = all.filter(r => (r.posts || []).length > 0).length;

      send(res, 200, {
        ok: true,
        reports: {
          total: all.length, pending: by('pending'),
          approved: by('approved'), rejected: by('rejected'),
          withEvidence,
          held: heldCount,
          totalSubmissions: all.reduce((n, r) => n + (r.count || 0), 0)
        },
        reporters: { known: Object.keys(rep).length, distrusted, trustFloor: TRUST_FLOOR },
        blocklist: { ids: list.ids.length, usernames: list.usernames.length },
        byPlatform: tally(r => r.platform),
        byReason: tally(r => r.reason),
        perDay: days,
        topReporters
      });
      return;
    }

    // The trending matrix: where clone activity is concentrated, and when.
    //
    // This is the view that answers "is a wave starting, and where", which is
    // the question that decides whose clones are worth a block budget.
    if (p === '/admin/trends' && req.method === 'GET') {
      const db = loadReports();
      send(res, 200, Object.assign({ ok: true },
        trendMatrix(db, { days: url.searchParams.get('days') })));
      return;
    }

    // What this server would tell a client in a given region to block, and why.
    // Lets the owner see the ranking before trusting it.
    if (p === '/admin/targets' && req.method === 'GET') {
      const ranked = rankTargets(loadReports(), loadList(), {
        region: url.searchParams.get('region'),
        lang: url.searchParams.get('lang'),
        platform: url.searchParams.get('platform')
      });
      send(res, 200, { ok: true, count: ranked.length, targets: ranked.slice(0, 100) });
      return;
    }

    // The live blocklist, for the management tab.
    if (p === '/admin/blocklist' && req.method === 'GET') {
      const list = loadList();
      const all = Object.values(loadReports().reports);
      // Attach whatever we know about each entry, so an admin removing
      // something can see why it was added.
      const describe = (value, kind) => {
        const rec = all.find(r => kind === 'id'
          ? String(r.profileId) === String(value)
          : normUser(r.username) === normUser(value));
        return {
          value, kind,
          platform: rec ? rec.platform : null,
          displayName: rec ? rec.displayName : null,
          reports: rec ? rec.count : 0,
          key: rec ? rec.key : null
        };
      };
      send(res, 200, {
        ok: true,
        entries: list.ids.map(v => describe(v, 'id'))
          .concat(list.usernames.map(v => describe(v, 'username')))
      });
      return;
    }
  }

  // ---- legacy direct list editing (admin) -------------------------------
  if ((p === '/blocklist.json' || p === '/add' || p === '/remove') && req.method === 'POST') {
    if (!isAdmin(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return; }
    let body;
    try { body = await readBody(req); } catch (e) { send(res, 400, { ok: false, error: e.message }); return; }
    const norm = normalizeInput(body);
    let list = loadList();
    if (p === '/blocklist.json') {
      list = {
        ids: Array.from(new Set(norm.ids)),
        usernames: Array.from(new Set(norm.usernames)),
        docIdOverrides: sanitizeOverrides(body.docIdOverrides) || list.docIdOverrides
      };
    } else if (p === '/add') {
      list.ids = Array.from(new Set(list.ids.concat(norm.ids)));
      list.usernames = Array.from(new Set(list.usernames.concat(norm.usernames)));
    } else {
      const di = new Set(norm.ids), dn = new Set(norm.usernames);
      list.ids = list.ids.filter(x => !di.has(x));
      list.usernames = list.usernames.filter(x => !dn.has(x));
    }
    saveList(list);
    send(res, 200, { ok: true, count: list.ids.length + list.usernames.length });
    return;
  }

  send(res, 404, { ok: false, error: 'not found' });
});

// A connection that dribbles a request forever costs a socket for as long as it
// likes unless something bounds it.
server.requestTimeout = 30 * 1000;
server.headersTimeout = 20 * 1000;
server.keepAliveTimeout = 10 * 1000;
server.maxHeadersCount = 100;

server.listen(PORT, () => {
  const list = loadList();
  const reports = Object.values(loadReports().reports);
  console.log(`3Que server on http://localhost:${PORT}`);
  console.log(`  blocklist : ${list.ids.length} ids, ${list.usernames.length} usernames`);
  console.log(`  reports   : ${reports.length} (${reports.filter(r => r.status === 'pending').length} pending)`);
  console.log(`  dashboard : http://localhost:${PORT}/admin`);
  console.log(`  admin user: ${ADMIN_USER}`);
  console.log(`  reporting : ${SUBMIT_TOKEN ? 'token required' : 'open (anyone can report)'}`);
  console.log(`  limits    : ${LIMITS.body / 1024}KB body, ${RATE_REPORTS_IP} reports/min/IP, ` +
              `${RATE_REPORTS_ACCOUNT}/min/account, ${RATE_LOGIN} sign-ins/15min/IP`);
  if (TRUST_PROXY) console.log('  proxy     : trusting X-Forwarded-For / X-Forwarded-Proto');
  if (USING_DEFAULTS) {
    console.log('');
    console.log('  !! Using the default credentials admin/admin123.');
    console.log(`  !! Admin sign-in is therefore restricted to this machine${
      ALLOW_DEFAULT_REMOTE ? ' -- OVERRIDDEN by --allow-default-credentials' : ''}.`);
    console.log('  !! Set --user and --pass before exposing this server.');
  }
});
