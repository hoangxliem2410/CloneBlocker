/**
 * Unit tests for the service worker's queue, leases and rate limiter.
 *
 * The browser test runs with platform blocking disabled (deliberately -- it
 * must never block anyone for real), which leaves this logic uncovered there:
 * the two switches that decide what gets queued at all, and the gate that
 * decides how fast the browser as a whole may spend it. It is also the logic
 * most likely to misbehave in ways a user would not notice quickly: a starved
 * queue or a limiter that fails to count looks like "nothing is happening"
 * rather than an error.
 *
 * Drives the real message handler, so serialize() and the storage round-trips
 * are exercised exactly as they run in the extension.
 *
 *   node tools/queue-test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

// ---- chrome API mock ------------------------------------------------------
const store = { local: {}, sync: {} };
function area(name) {
  return {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (store[name][k] !== undefined) out[k] = clone(store[name][k]);
      return out;
    },
    async set(obj) { for (const k of Object.keys(obj)) store[name][k] = clone(obj[k]); },
    async remove(key) {
      for (const k of (Array.isArray(key) ? key : [key])) delete store[name][k];
    }
  };
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

let messageHandler = null;
let alarmHandler = null;
const alarms = new Map();

// Tabs and the toolbar badge are things the worker READS, not just calls it
// makes: a queued cold block has nowhere to run unless a Facebook or Threads
// tab is open, and the badge is the only place that says so. So the mock has
// to be able to answer "nothing is open" and to remember what the badge was
// last told.
let openTabs = [];                       // [{ id, url }] as chrome.tabs.query sees them
const badge = { text: null, color: null };

/**
 * chrome.tabs.query, matching url patterns the way the real one does.
 *
 * Answering every query with every tab would let a "no Facebook tab open"
 * case pass while a Threads tab was open, which is the opposite of the
 * condition under test.
 */
function tabMatches(tab, patterns) {
  if (!patterns) return true;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((p) => new RegExp('^' + String(p)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*') + '$').test(tab.url || ''));
}

global.chrome = {
  storage: { local: area('local'), sync: area('sync'), onChanged: { addListener() {} } },
  alarms: {
    onAlarm: { addListener(fn) { alarmHandler = fn; } },
    async get(n) { return alarms.get(n) || null; },
    async clear(n) { alarms.delete(n); },
    async create(n, o) { alarms.set(n, Object.assign({ name: n }, o)); }
  },
  runtime: {
    lastError: null,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { messageHandler = fn; } }
  },
  tabs: {
    async query(info) { return openTabs.filter(t => tabMatches(t, info && info.url)).map(clone); },
    sendMessage() {}
  },
  action: {
    async setBadgeText(o) { badge.text = o ? o.text : undefined; },
    async setBadgeBackgroundColor(o) { badge.color = o ? o.color : undefined; }
  },
  permissions: { async contains() { return true; } }
};

// ---- harness --------------------------------------------------------------
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function send(type, payload) {
  return new Promise((resolve) => {
    const ret = messageHandler({ type, payload }, {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'handler did not keep the port open' });
  });
}

async function setSettings(patch) {
  return send('sw:set-settings', patch);
}
async function state() { return send('sw:get-state'); }

/**
 * Fast-forward past the pacing gate.
 *
 * One gate paces the whole browser: after a block, nobody may claim again
 * until the randomised delay has run. A real tab gets past it by sleeping for
 * seconds; a test gets past it by moving the clock, because the suite is
 * about which target is served and in what order, not about waiting. The
 * tests that are genuinely about the gate never call this.
 */
function openGate() {
  if (store.local.stats) delete store.local.stats.gateUntil;
}

/**
 * Time passing, expressed as every deadline moving back.
 *
 * A lease is ninety seconds, so the tests that are genuinely about waiting
 * cannot wait. Rather than mock the clock out from under the whole worker,
 * this ages what the queue actually keeps -- the gate, the leases, the
 * cooldowns -- which is what the passage of time looks like from storage. Only
 * deadlines: the timestamps the rate limiter counts are a different question
 * and the tests that care about those set them directly.
 */
function rewind(ms) {
  const st = store.local.stats;
  if (st && st.gateUntil) st.gateUntil -= ms;
  for (const map of ['leases', 'cooldowns']) {
    const m = store.local[map];
    if (m) for (const k of Object.keys(m)) m[k] -= ms;
  }
}

async function reset(settings) {
  store.local = {};
  store.sync = {};
  openTabs = [];
  badge.text = null;
  badge.color = null;
  await setSettings(Object.assign({
    platformBlockEnabled: true,
    platformBlockDryRun: false,
    maxBlocksPerHour: 100,
    maxBlocksPerDay: 100,
    listUrl: ''
  }, settings || {}));
}

(async () => {
  // CB_SW lets the regression check below point this at a modified copy.
  const swFile = process.env.CB_SW || path.join(__dirname, '..', 'src', 'background', 'service-worker.js');
  const swPath = pathToFileURL(swFile).href;
  await import(swPath);
  if (!messageHandler) { check('service worker registered a message handler', false); finish(); return; }
  check('service worker registered a message handler', true);

  // -- 1. a permanently failing target must not starve the queue ------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['1111111111', '2222222222', '3333333333'] });

  openGate();
  const first = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: first.target, ok: false, dryRun: false, detail: 'simulated failure'
  });
  openGate();
  const second = await send('sw:queue-claim', { platform: 'facebook' });

  check('a failed target goes into cooldown instead of being retried immediately',
    second.target && second.target !== first.target,
    `first=${first.target} second=${second.target}`);

  // -- 2. repeated failures abandon the target ------------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['4444444444'] });
  let abandonedAfter = null;
  for (let i = 1; i <= 8; i++) {
    // Clear the cooldown so we can drive the failure count deterministically
    // without waiting out the real backoff.
    store.local.cooldowns = {};
    openGate();
    const c = await send('sw:queue-claim', { platform: 'facebook' });
    if (!c.target) { abandonedAfter = i - 1; break; }
    await send('sw:queue-result', { platform: 'facebook', target: c.target, ok: false, dryRun: false, detail: 'x' });
  }
  const st2 = await state();
  check('a target is abandoned after repeated failures rather than retried forever',
    (st2.queue.facebook || []).length === 0 && (st2.stats.abandoned || 0) === 1,
    `queue=${JSON.stringify(st2.queue.facebook)} abandoned=${st2.stats.abandoned} afterClaims=${abandonedAfter}`);

  // -- 3. failed real attempts count toward the hourly cap ------------------
  await reset({ maxBlocksPerHour: 2 });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['5555555555', '6666666666', '7777777777'] });
  let realAttempts = 0;
  for (let i = 0; i < 6; i++) {
    openGate();
    const c = await send('sw:queue-claim', { platform: 'facebook' });
    if (!c.target) break;
    realAttempts++;
    await send('sw:queue-result', { platform: 'facebook', target: c.target, ok: false, dryRun: false, detail: 'x' });
  }
  check('failed real attempts count toward the hourly cap',
    realAttempts === 2, `made ${realAttempts} attempts with cap 2`);

  // -- 4. dry runs do not count toward the cap, but do rotate ---------------
  await reset({ maxBlocksPerHour: 2, platformBlockDryRun: true });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['8888888888', '9999999999'] });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    openGate();
    const c = await send('sw:queue-claim', { platform: 'facebook' });
    if (!c.target) break;
    seen.push(c.target);
    await send('sw:queue-result', { platform: 'facebook', target: c.target, ok: true, dryRun: true });
  }
  const st4 = await state();
  check('dry runs rotate through the queue instead of repeating the first entry',
    new Set(seen).size === 2, `claimed ${JSON.stringify(seen)}`);
  check('dry runs do not consume the rate limit',
    !(st4.stats.attemptTimes || []).length && (st4.stats.dryRuns || 0) === 2,
    `attemptTimes=${(st4.stats.attemptTimes || []).length} dryRuns=${st4.stats.dryRuns}`);
  check('dry runs leave targets queued',
    (st4.queue.facebook || []).length === 2, JSON.stringify(st4.queue.facebook));

  // -- 5. concurrent claims are serialised, not shared out ------------------
  //
  // This used to assert that two tabs claiming at once got two DIFFERENT
  // targets, which is the flooding it should have been preventing: five open
  // tabs meant five blocks in the same second, five times the rate the caps
  // were chosen for. Leases only stopped two tabs taking the same profile.
  // One gate now paces the whole browser, so the second tab is told to wait.
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['1212121212', '3434343434'] });
  const [a, b] = await Promise.all([
    send('sw:queue-claim', { platform: 'facebook' }),
    send('sw:queue-claim', { platform: 'facebook' })
  ]);
  const got = [a, b].filter(x => x.target);
  const waiting = [a, b].filter(x => !x.target);
  check('two tabs claiming at once yield exactly one block',
    got.length === 1 && waiting.length === 1, `a=${a.target} b=${b.target}`);
  check('and the other tab is told when to come back, not left guessing',
    waiting[0] && waiting[0].retryInMs > 0, JSON.stringify(waiting[0]));

  // Five tabs, one after another, with nothing reported: still one block.
  await reset();
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['1111111111', '2222222222', '3333333333', '4444444444', '5555555555'] });
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => send('sw:queue-claim', { platform: 'facebook' })));
  check('five tabs claiming at once still yield exactly one block',
    five.filter(x => x.target).length === 1,
    JSON.stringify(five.map(x => x.target)));

  // The gate opens again once the result lands, so work does not stall.
  const served = five.find(x => x.target);
  await send('sw:queue-result',
    { platform: 'facebook', target: served.target, ok: true, dryRun: true, warm: true });
  // The gate re-arms with the DELAY, not with the lease: work resumes after
  // seconds, not after a minute and a half. Both halves matter -- a gate that
  // never reopened would be a queue that stopped.
  const stillWaiting = await send('sw:queue-claim', { platform: 'facebook' });
  const settings0 = (await state()).settings;
  check('the pause after a result is the warm delay, not the lease',
    !stillWaiting.target &&
    stillWaiting.retryInMs > 0 &&
    stillWaiting.retryInMs <= (settings0.warmMaxDelayMs | 0) + 500,
    `retryInMs=${stillWaiting.retryInMs} warmMax=${settings0.warmMaxDelayMs}`);
  openGate();
  const nextServed = await send('sw:queue-claim', { platform: 'facebook' });
  check('and once it has run, the next tab is served',
    !!nextServed.target && nextServed.target !== served.target,
    `${served.target} -> ${nextServed.target}`);

  // -- 6. success retires the target ---------------------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['5656565656'] });
  openGate();
  const c6 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', { platform: 'facebook', target: c6.target, ok: true, dryRun: false });
  const st6 = await state();
  check('a successful block is retired from the queue and recorded as done',
    (st6.queue.facebook || []).length === 0 &&
    (st6.done.facebook || []).includes('5656565656') &&
    (st6.stats.attemptTimes || []).length === 1,
    `queue=${JSON.stringify(st6.queue.facebook)} done=${JSON.stringify(st6.done.facebook)}`);

  // -- 7. a checkpoint halts everything -------------------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7878787878'] });
  openGate();
  const c7 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: c7.target, ok: false, dryRun: false, checkpoint: true, detail: 'challenge'
  });
  const st7 = await state();
  openGate();
  const after7 = await send('sw:queue-claim', { platform: 'facebook' });
  check('a checkpoint disables platform blocking and stops handing out work',
    st7.settings.platformBlockEnabled === false && !after7.target,
    `enabled=${st7.settings.platformBlockEnabled} nextTarget=${after7.target}`);

  // -- 8. already-blocked targets are not re-queued -------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9090909090'] });
  openGate();
  const c8 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', { platform: 'facebook', target: c8.target, ok: true, dryRun: false });
  const re = await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9090909090'] });
  check('a completed target is not re-queued when the list is re-sent',
    re.added === 0, `added=${re.added}`);

  // -- 9. removing someone from the list must un-queue them -----------------
  // The queue used to only ever grow, so taking a profile off the server list
  // did not stop it being blocked -- its id was already pending from an
  // earlier fetch.
  await reset();
  store.local.blocklist = { ids: ['111111111', '222222222'], usernames: [] };
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['111111111', '222222222'] });
  const beforePrune = (await state()).queue.facebook || [];

  // Simulate the next fetch returning a list with one entry removed.
  const { pruneForTest } = globalThis;
  store.local.blocklist = { ids: ['111111111'], usernames: [] };
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: [] });   // no-op enqueue
  // Drive the prune the same way refreshBlocklist does.
  await send('sw:prune-test', { ids: ['111111111'] });
  const afterPrune = (await state()).queue.facebook || [];

  const idOf = (e) => (typeof e === 'string' ? e : e && e.id);
  check('removing a profile from the list removes it from the queue',
    beforePrune.length === 2 && afterPrune.length === 1 && idOf(afterPrune[0]) === '111111111',
    `before=${JSON.stringify(beforePrune.map(idOf))} after=${JSON.stringify(afterPrune.map(idOf))}`);

  // -- 8. warm before cold --------------------------------------------------
  //
  // Blocking someone whose profile is on the page is what an ordinary person
  // does; working through a list of accounts they have never seen is what gets
  // an account checkpointed. The queue has to know the difference.
  await reset({ maxColdBlocksPerHour: 2 });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: [{ id: '6000000001', rank: 99 }], warm: false });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6000000002'], warm: true });

  openGate();
  const w1 = await send('sw:queue-claim', { platform: 'facebook' });
  check('a profile that was on screen is claimed before a server-nominated one',
    w1.target === '6000000002' && w1.warm === true,
    `${w1.target} warm=${w1.warm}`);
  check('the claim carries a short pause after a warm block',
    w1.nextDelayMs > 0 && w1.nextDelayMs <= 12000, String(w1.nextDelayMs));

  await send('sw:queue-result',
    { platform: 'facebook', target: '6000000002', ok: true, warm: true });

  openGate();
  const c1 = await send('sw:queue-claim', { platform: 'facebook' });
  check('the cold target is claimed once nothing warm is left',
    c1.target === '6000000001' && c1.warm === false, `${c1.target} warm=${c1.warm}`);
  check('a cold block is paced far more slowly than a warm one',
    c1.nextDelayMs >= 20000, String(c1.nextDelayMs));

  // -- 9. the cold ceiling must not stop warm work --------------------------
  await send('sw:queue-result',
    { platform: 'facebook', target: '6000000001', ok: true, warm: false });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6000000003', '6000000004'], warm: false });
  openGate();
  const c2 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result',
    { platform: 'facebook', target: c2.target, ok: true, warm: false });

  // Two cold blocks spent against a ceiling of two.
  openGate();
  const c3 = await send('sw:queue-claim', { platform: 'facebook' });
  check('cold work stops at its hourly ceiling',
    !c3.target && c3.coldHeld === true, `${c3.target} held=${c3.coldHeld}`);

  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6000000005'], warm: true });
  openGate();
  const w2 = await send('sw:queue-claim', { platform: 'facebook' });
  check('warm work continues after the cold ceiling is reached',
    w2.target === '6000000005' && w2.warm === true, `${w2.target} warm=${w2.warm}`);

  // -- 10. seeing a cold target on screen promotes it -----------------------
  await reset({ maxColdBlocksPerHour: 0 });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: [{ id: '6100000001', rank: 5 }], warm: false });
  openGate();
  const before = await send('sw:queue-claim', { platform: 'facebook' });
  check('with no cold budget at all, a cold target is not handed out',
    !before.target, String(before.target));

  const promo = await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6100000001'], warm: true });
  check('re-seeing it on screen promotes it rather than duplicating it',
    promo.promoted === 1 && promo.added === 0 && promo.queued === 1,
    JSON.stringify(promo));
  openGate();
  const after = await send('sw:queue-claim', { platform: 'facebook' });
  check('once promoted it is claimable, because it is now the ordinary case',
    after.target === '6100000001' && after.warm === true,
    `${after.target} warm=${after.warm}`);

  // -- 11. rank orders cold work --------------------------------------------
  await reset({ maxColdBlocksPerHour: 50 });
  await send('sw:enqueue-platform-block', {
    platform: 'facebook', warm: false,
    ids: [{ id: '6200000001', rank: 1 }, { id: '6200000002', rank: 50 }, { id: '6200000003', rank: 10 }]
  });
  openGate();
  const r1 = await send('sw:queue-claim', { platform: 'facebook' });
  check('the highest-ranked cold target goes first',
    r1.target === '6200000002', `${r1.target} rank=${r1.rank}`);

  // -- 12. warmth survives a blocklist refresh ------------------------------
  await send('sw:prune-test', { ids: ['6200000002', '6200000003'] });
  const st = await state();
  const remaining = (st.queue.facebook || []).map(e => (typeof e === 'string' ? e : e.id));
  check('pruning to the fresh list keeps entries with their warmth intact',
    remaining.length === 2 && remaining.indexOf('6200000001') < 0,
    JSON.stringify(remaining));

  // -- 13. a recorded failure stops being shown once it stops being true ----
  //
  // stats.lastError was written in three places and cleared in none, so the
  // first block that could not run pinned its message to the popup for good --
  // through later successes, through signing back in, through turning platform
  // blocking off. These lock the clearing behaviour in.
  await reset({ maxColdBlocksPerHour: 50 });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000001'], warm: true });
  openGate();
  const f1 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: f1.target, ok: false, dryRun: false,
    detail: "the site's own block operation is not loaded on this page yet"
  });
  const afterFail = await state();
  check('a failed block records what went wrong',
    /not loaded on this page/.test(afterFail.stats.lastError || ''),
    JSON.stringify(afterFail.stats.lastError));
  check('and records when, so a stale one can be told apart from a live one',
    typeof afterFail.stats.lastErrorAt === 'number' && afterFail.stats.lastErrorAt > 0,
    String(afterFail.stats.lastErrorAt));

  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000002'], warm: true });
  openGate();
  const f2 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', { platform: 'facebook', target: f2.target, ok: true, dryRun: false });
  const afterOk = await state();
  check('a block that works clears the earlier failure',
    !afterOk.stats.lastError && !afterOk.stats.lastErrorAt,
    JSON.stringify(afterOk.stats.lastError));

  // A dry run resolves a strategy end to end, so it settles the question too.
  await reset({ platformBlockDryRun: true, maxColdBlocksPerHour: 50 });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000003'], warm: true });
  openGate();
  const d1 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: d1.target, ok: false, dryRun: true, detail: 'nothing to drive' });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000004'], warm: true });
  openGate();
  const d2 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', { platform: 'facebook', target: d2.target, ok: true, dryRun: true });
  const afterDry = await state();
  check('a successful dry run clears it as well',
    !afterDry.stats.lastError, JSON.stringify(afterDry.stats.lastError));

  // Every recorded error is about blocking, so switching blocking off makes
  // all of them historical.
  await reset({ maxColdBlocksPerHour: 50 });
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7300000005'], warm: true });
  openGate();
  const f3 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: f3.target, ok: false, dryRun: false, detail: 'signed out' });
  check('the failure is recorded before blocking is turned off',
    !!(await state()).stats.lastError, 'recorded');
  await setSettings({ platformBlockEnabled: false });
  const afterOff = await state();
  check('turning platform blocking off clears the message it was about',
    !afterOff.stats.lastError, JSON.stringify(afterOff.stats.lastError));

  // -- 14. the Firestore list path ------------------------------------------
  //
  // The blocklist can now live in a Firestore document; the service worker
  // must decode the envelope, rank the published metadata LOCALLY (nothing
  // about the browser is sent), and file reports as create-only documents.
  // The shipped default: the list comes off Hosting as plain JSON with a real
  // HTTP ETag, and reports go to Firestore through an apiBase that can no
  // longer be derived from the list URL. Both halves are checked, because the
  // failure mode of getting this wrong is a working list and silently broken
  // reporting.
  {
    const CDN = 'https://clone-blocker2.web.app/blocklist.json';
    const FS  = 'https://firestore.googleapis.com/v1/projects/clone-blocker2' +
                '/databases/(default)/documents';
    const published = { v: 1, ids: ['5100000001'], usernames: ['someclone'],
                        idTags: { '5100000001': 'redbull' }, targets: [] };
    const seen = [];
    global.fetch = async (url, opts) => {
      seen.push({ url: String(url), method: (opts || {}).method || 'GET' });
      if (String(url).startsWith(CDN)) {
        return { ok: true, status: 200,
          headers: { get: (h) => (h.toLowerCase() === 'etag' ? 'W/"abc123"' : null) },
          text: async () => JSON.stringify(published),
          json: async () => published };
      }
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => '{}', json: async () => ({}) };
    };

    await reset({ platformBlockEnabled: true });
    await setSettings({ listUrl: CDN, apiBase: FS });
    const r = await send('sw:refresh-now');
    check('a plain JSON list on the CDN decodes',
      r.ok && r.blocklist.ids.includes('5100000001') &&
      r.blocklist.usernames.includes('someclone'),
      JSON.stringify(r.blocklist && r.blocklist.ids));
    check('and its HTTP ETag is kept for the next poll',
      r.blocklist.etag === 'W/"abc123"', String(r.blocklist.etag));
    check('the published tag survives the CDN shape',
      (r.blocklist.idTags || {})['5100000001'] === 'redbull',
      JSON.stringify(r.blocklist.idTags));
    check('no request went to Firestore to read the list',
      seen.every(c => !/firestore/.test(c.url)),
      JSON.stringify(seen.map(c => c.url)));
    // A static file cannot use a ranking hint, and on a CDN a per-user query
    // string is the difference between an edge-cached 304 and a fresh
    // transfer per install per hour -- besides putting the reader's timezone
    // in somebody's HTTP logs for nothing.
    check('and the CDN is asked for the plain URL, describing nobody',
      seen[0] && seen[0].url === CDN, seen[0] && seen[0].url);

    seen.length = 0;
    await send('sw:submit-report', { platform: 'threads', profileId: '5100000009',
      username: 'someclone', reason: 'redbull', viewerId: '778899' });
    const wrote = seen.find(c => c.method === 'POST');
    check('a report still reaches Firestore, not the CDN',
      !!wrote && wrote.url.startsWith(FS + '/reports?documentId='),
      wrote ? wrote.url.slice(0, 100) : JSON.stringify(seen));
  }

  // These drive the real refresh/submit/status handlers with fetch stubbed.
  {
    const FS_URL = 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents/blocklist/current';
    const today = new Date().toISOString().slice(0, 10);
    const old10 = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const published = {
      v: 1, updatedAt: new Date().toISOString(),
      ids: ['4100000001', '4100000002', '63082166531'],
      usernames: ['threads'],
      docIdOverrides: { probe: 'x' },
      pending: ['threads:@maybe.clone'],
      targets: [
        // Fresh + active vs stale + idle, equal trust. The fresh one must win
        // in EVERY region: worst-case locality 0.25 gives 2*1*(1+3)*0.25 = 2,
        // the stale one at best 2*0.5^(10/7)*1*1 ~= 0.74 -- so the assertion
        // holds no matter what timezone the test machine is in.
        { platform: 'threads', id: '4100000002', trust: 2, last: old10,
          username: 'stale.clone', displayName: null,
          days: {}, regions: { 'America/Sao_Paulo': 2 }, langs: { 'pt-br': 2 } },
        { platform: 'threads', id: '4100000001', trust: 2, last: today,
          username: 'fresh.clone', displayName: 'Fresh Clone',
          days: { [today]: 3 }, regions: { 'Asia/Ho_Chi_Minh': 3 }, langs: { 'vi-vn': 3 } }
      ]
    };
    const envelope = {
      name: 'projects/demo-clone/databases/(default)/documents/blocklist/current',
      fields: { json: { stringValue: JSON.stringify(published) } },
      createTime: '2026-08-21T00:00:00Z', updateTime: '2026-08-21T03:04:05Z'
    };

    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(envelope),
        json: async () => envelope
      };
    };

    await reset({ maxColdBlocksPerHour: 50, platformBlockEnabled: true });
    await setSettings({ listUrl: FS_URL });
    const r = await send('sw:refresh-now');
    check('a Firestore document envelope decodes into the published list',
      r.ok && r.blocklist && r.blocklist.ids.length === 3 &&
      r.blocklist.usernames.includes('threads'),
      JSON.stringify(r.blocklist && r.blocklist.ids));
    // The published list is the one name source that arrives without anybody
    // having laid eyes on the account. It has to be read whatever the user's
    // switches say: whether they want the list WORKED THROUGH is a different
    // question from whether Activity may say who an account is.
    check('a refresh learns the names the list carries',
      store.local.idNames &&
      store.local.idNames['threads:4100000001'] &&
      store.local.idNames['threads:4100000001'].u === 'fresh.clone' &&
      store.local.idNames['threads:4100000001'].d === 'Fresh Clone' &&
      store.local.idNames['threads:4100000002'].u === 'stale.clone',
      JSON.stringify(store.local.idNames || {}));
    check('a target with no display name is not given an empty one',
      store.local.idNames &&
      store.local.idNames['threads:4100000002'].d === null,
      JSON.stringify((store.local.idNames || {})['threads:4100000002']));

    check('no ranking hints are appended to a Firestore URL',
      calls.length === 1 && !calls[0].url.includes('budget=') &&
      !calls[0].url.includes('region='), calls[0] && calls[0].url);

    // The exact bug this was: names were read out of the array the worker
    // rebuilds for the QUEUE, which is only populated when list blocking is
    // on -- and which had dropped the name fields anyway.
    {
      store.local.idNames = {};
      await setSettings({ blockFromList: false });
      await send('sw:refresh-now');
      const learned = store.local.idNames || {};
      check('names are learned even with list blocking switched off',
        learned['threads:4100000001'] && learned['threads:4100000001'].u === 'fresh.clone',
        JSON.stringify(learned));
      check('and no cold targets are queued while it is off',
        !(store.local.blocklist.targets || []).length,
        JSON.stringify((store.local.blocklist.targets || []).length));
      await setSettings({ blockFromList: true });
    }

    check('published metadata is ranked locally, freshest and most active first',
      r.blocklist.targets.length === 2 &&
      r.blocklist.targets[0].id === '4100000001' &&
      typeof r.blocklist.targets[0].rank === 'number' &&
      r.blocklist.targets[0].rank > r.blocklist.targets[1].rank,
      JSON.stringify(r.blocklist.targets.map(t => [t.id, t.rank])));
    check('the why fields survive local ranking',
      r.blocklist.targets[0].why &&
      r.blocklist.targets[0].why.velocity7d === 3 &&
      typeof r.blocklist.targets[0].why.region === 'number',
      JSON.stringify(r.blocklist.targets[0].why));
    check('the document updateTime stands in for the etag',
      r.blocklist.etag === '2026-08-21T03:04:05Z', String(r.blocklist.etag));
    // Inverted deliberately. The list used to carry every reported-but-
    // unreviewed key so the chip could say "already reported" about somebody
    // else's report -- which published an unreviewed accusation to a document
    // anyone on the internet can read, filed by anyone, with no account.
    check('an unreviewed accusation is not cached from the list',
      !r.blocklist.pending || r.blocklist.pending.length === 0,
      JSON.stringify(r.blocklist.pending));
    check('docIdOverrides still hot-patch through the Firestore path',
      (store.local.docIdOverrides || {}).probe === 'x',
      JSON.stringify(store.local.docIdOverrides));

    const st = await state();
    const queued = (st.queue.threads || []).map(e => (typeof e === 'string' ? e : e.id));
    check('locally-ranked targets are seeded into the cold queue',
      queued.includes('4100000001') && queued.includes('4100000002'),
      JSON.stringify(queued));

    // Status answers come from the cached document, no network at all.
    calls.length = 0;
    const stat1 = await send('sw:report-status',
      { platform: 'threads', profileId: '4100000001', force: true });
    check('an approved id answers blocked from the cached list, no fetch',
      stat1.ok && stat1.blocked === true && stat1.status === 'approved' && calls.length === 0,
      JSON.stringify(stat1));
    // A target this browser has never reported is simply unknown -- not
    // "pending", which would be repeating a stranger's accusation.
    const stat2 = await send('sw:report-status',
      { platform: 'threads', username: 'maybe.clone', force: true });
    check('somebody else’s report is not something we claim to know about',
      stat2.ok && stat2.blocked === false && stat2.status === null,
      JSON.stringify(stat2));

    // But our own submission still shows as pending afterwards, and keeps
    // showing -- that is the half of the chip worth having, and it needs no
    // public list to work.
    {
      store.local.reportedCache = { 'threads:@maybe.clone':
        { status: 'pending', count: 1, blocked: false, at: 1 } };   // long stale
      const mine = await send('sw:report-status',
        { platform: 'threads', username: 'maybe.clone', force: true });
      check('our own report still reads pending, however old the record',
        mine.ok && mine.status === 'pending', JSON.stringify(mine));
      delete store.local.reportedCache;
    }

    // Submitting a report becomes a create-only document write.
    calls.length = 0;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => '{}', json: async () => ({}) };
    };
    const sub = await send('sw:submit-report', {
      platform: 'threads', profileId: '9990001111', username: 'Fake.Person',
      displayName: 'x'.repeat(300), reason: 'clone', note: 'they copied me',
      viewerId: '2904880000'
    });
    const call = calls[0];
    const sent = call && JSON.parse(call.opts.body);
    const docId = call && decodeURIComponent(call.url.split('documentId=')[1]);
    check('the report goes to the reports collection as a create',
      sub.ok && call && call.url.includes('/documents/reports?documentId=') &&
      call.opts.method === 'POST', call && call.url);
    check('the document id IS the dedup key',
      sent && docId === sent.fields.dedupKey.stringValue &&
      /^threads~9990001111~acct_[0-9a-f]{24}$/.test(docId), docId);
    check('the raw viewer id appears nowhere in the write',
      call && !call.opts.body.includes('2904880000'), 'checked body');
    check('fields are clipped to the caps the rules enforce',
      sent && sent.fields.displayName.stringValue.length === 80 &&
      sent.fields.username.stringValue === 'fake.person',
      sent && String(sent.fields.displayName.stringValue.length));

    // A 409 means this account already reported this target.
    global.fetch = async () => ({ ok: false, status: 409, headers: { get: () => null },
      text: async () => '{}', json: async () => ({}) });
    const dup = await send('sw:submit-report', {
      platform: 'threads', profileId: '9990001111', viewerId: '2904880000'
    });
    check('a create conflict is reported as a duplicate, not an error',
      dup.ok && dup.duplicate === true, JSON.stringify(dup));

    // -- the static-hosting split: list from the CDN, reports to Firestore.
    // publish-static.js serves the blob as a plain file; reports then need
    // apiBase to carry the Firestore documents base.
    await setSettings({
      listUrl: 'https://demo.web.app/blocklist.json',
      apiBase: 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents'
    });
    const splitCalls = [];
    global.fetch = async (url, opts) => {
      splitCalls.push(String(url));
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => '{}', json: async () => ({}) };
    };
    const splitSub = await send('sw:submit-report', {
      platform: 'threads', profileId: '9990005555', viewerId: '2904880000'
    });
    check('with a static list URL, reports still go to Firestore via apiBase',
      splitSub.ok && splitCalls.length === 1 &&
      splitCalls[0].includes('/documents/reports?documentId=threads~9990005555~acct_'),
      splitCalls[0] && splitCalls[0].slice(30, 130));

    delete global.fetch;
  }

  // -- 14b. the activity ledger ---------------------------------------------
  //
  // Every attempt is recorded with what was known about the target at the
  // time -- rank and why come from the queue entry and the published metadata,
  // both of which are gone from the queue the moment a block succeeds.
  {
    await reset({ maxColdBlocksPerHour: 50 });
    store.local.blocklist = { ids: [], usernames: [], pending: [],
      targets: [{ id: '7500000001', platform: 'facebook', rank: 4.2,
                  why: { trust: 1.5, recentDays: 0, velocity7d: 3, region: 0.8, lang: 0.8 } }],
      fetchedAt: Date.now(), source: 'x', count: 0 };
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: [{ id: '7500000001', rank: 4.2 }], warm: false });
    openGate();
    const c = await send('sw:queue-claim', { platform: 'facebook' });
    await send('sw:queue-result',
      { platform: 'facebook', target: c.target, ok: true, dryRun: false, warm: false });
    const log1 = store.local.blockLog || [];
    check('a successful block lands in the ledger with its rank and why',
      log1.length === 1 && log1[0].ok && log1[0].rank === 4.2 &&
      log1[0].why && log1[0].why.velocity7d === 3 && log1[0].warm === false,
      JSON.stringify(log1[0]));

    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['7500000002'], warm: true });
    openGate();
    const c2 = await send('sw:queue-claim', { platform: 'facebook' });
    await send('sw:queue-result',
      { platform: 'facebook', target: c2.target, ok: false, dryRun: false, warm: true, detail: 'no mutation' });
    const log2 = store.local.blockLog || [];
    check('a failure is recorded with its detail, newest first',
      log2.length === 2 && !log2[0].ok && log2[0].detail === 'no mutation' && log2[0].warm === true,
      JSON.stringify(log2[0]));

    const st = await state();
    check('the ledger rides along in sw:get-state for the activity page',
      Array.isArray(st.blockLog) && st.blockLog.length === 2 &&
      st.cooldowns !== undefined && st.failures !== undefined,
      'blockLog=' + (st.blockLog || []).length);
  }

  // -- 15. the change probe -------------------------------------------------
  //
  // Firestore ignores If-None-Match, so every scheduled poll used to download
  // the whole published blob even when nothing had changed. The worker now
  // probes with a masked read first and only fetches the body when the
  // document's updateTime moved. The probe lives on the NON-forced path, which
  // only the alarm reaches -- so these fire the captured alarm listener and
  // observe the result through the fetch log and stored state.
  {
    const FS_URL = 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents/blocklist/current';
    const ALARM = { name: 'cb-refresh-blocklist' };
    const tick = () => new Promise(r => setTimeout(r, 120));
    const mkEnvelope = (updateTime, ids) => ({
      name: 'projects/demo-clone/databases/(default)/documents/blocklist/current',
      fields: { json: { stringValue: JSON.stringify({
        v: 1, ids, usernames: [], docIdOverrides: {}, pending: [], targets: [] }) } },
      createTime: '2026-08-21T00:00:00Z', updateTime
    });

    const calls = [];
    let envelope = mkEnvelope('2026-08-21T10:00:00Z', ['5550001111']);
    global.fetch = async (url) => {
      calls.push(String(url));
      const masked = String(url).includes('mask.fieldPaths=rev');
      const body = masked
        ? { name: envelope.name, fields: {}, createTime: envelope.createTime,
            updateTime: envelope.updateTime }
        : envelope;
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => JSON.stringify(body), json: async () => body };
    };

    await reset({});
    await setSettings({ listUrl: FS_URL });

    // Forced refresh = first load: no probe, straight to the body.
    const r1 = await send('sw:refresh-now');
    check('a forced refresh skips the probe and fetches the body',
      r1.ok && calls.length === 1 && !calls[0].includes('mask.fieldPaths'),
      calls.join(' | ').slice(0, 100));

    // Unchanged document via the alarm: one masked probe, no blob.
    calls.length = 0;
    alarmHandler(ALARM); await tick();
    const cached1 = store.local.blocklist;
    check('an unchanged document costs one masked probe, not the blob',
      calls.length === 1 && calls[0].includes('mask.fieldPaths=rev') &&
      cached1.etag === '2026-08-21T10:00:00Z',
      JSON.stringify({ calls: calls.length }));
    check('the cached list is stamped fresh even without a download',
      Date.now() - cached1.fetchedAt < 5000, String(Date.now() - cached1.fetchedAt) + 'ms');

    // Changed document: the probe notices and the full body follows.
    envelope = mkEnvelope('2026-08-21T11:22:33Z', ['5550001111', '5550002222']);
    calls.length = 0;
    alarmHandler(ALARM); await tick();
    const cached2 = store.local.blocklist;
    check('a changed document is detected by the probe and fetched in full',
      calls.length === 2 && calls[0].includes('mask.fieldPaths=rev') &&
      !calls[1].includes('mask.fieldPaths') && cached2.ids.length === 2,
      JSON.stringify({ calls: calls.length, ids: cached2.ids }));
    check('the new etag is the new updateTime',
      cached2.etag === '2026-08-21T11:22:33Z', String(cached2.etag));

    // A dead probe must never break the refresh.
    envelope = mkEnvelope('2026-08-21T12:00:00Z', ['5550003333']);
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('mask.fieldPaths')) throw new Error('probe down');
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => JSON.stringify(envelope), json: async () => envelope };
    };
    calls.length = 0;
    alarmHandler(ALARM); await tick();
    check('a failing probe falls through to the full fetch',
      store.local.blocklist.ids[0] === '5550003333' && calls.length === 2,
      JSON.stringify(store.local.blocklist.ids));

    delete global.fetch;
  }

  // -- 16. passive and active ------------------------------------------------
  //
  // The mode is the only decision the options page asks anyone to make, and
  // the difference is invisible from inside the extension: passive looks
  // exactly like active with an empty list. So these drive a real refresh
  // whose payload carries ranked targets, and watch what reaches the queue.
  {
    const FS_URL = 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents/blocklist/current';
    const today = new Date().toISOString().slice(0, 10);
    const published = {
      v: 1, updatedAt: new Date().toISOString(),
      ids: ['8100000001', '8100000002'], usernames: [], docIdOverrides: {}, pending: [],
      // Same trust era, different activity, so the ranking is deterministic
      // wherever this runs: neither target names a region or a language, so
      // locality is identical and only trust and velocity separate them.
      targets: [
        { platform: 'facebook', id: '8100000001', trust: 2, last: today,
          days: { [today]: 2 }, regions: {}, langs: {} },
        { platform: 'facebook', id: '8100000002', trust: 1, last: today,
          days: {}, regions: {}, langs: {} }
      ]
    };
    const envelope = {
      name: 'projects/demo-clone/databases/(default)/documents/blocklist/current',
      fields: { json: { stringValue: JSON.stringify(published) } },
      createTime: '2026-08-21T00:00:00Z', updateTime: '2026-08-21T09:00:00Z'
    };
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(envelope), json: async () => envelope
    });
    const queuedIds = async () =>
      ((await state()).queue.facebook || []).map(e => (typeof e === 'string' ? e : e.id));

    // Passive: the list still arrives, but nobody is queued off the back of it.
    await reset({ mode: 'passive', listUrl: FS_URL, maxColdBlocksPerHour: 50 });
    const rp = await send('sw:refresh-now');
    check('passive mode still fetches and keeps the whole list',
      rp.ok && rp.blocklist.ids.length === 2,
      JSON.stringify(rp.blocklist && rp.blocklist.ids));
    const passiveQueue = await queuedIds();
    check('passive mode seeds none of the ranked targets',
      (rp.blocklist.targets || []).length === 0 && passiveQueue.length === 0,
      JSON.stringify(passiveQueue));

    // The profile in front of you is still blocked, at warm pacing: that is
    // the whole of what passive means, not "do nothing".
    const warmAdd = await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8100000001'], warm: true });
    openGate();
    const warmClaim = await send('sw:queue-claim', { platform: 'facebook' });
    check('passive mode still queues a profile that turned up on screen',
      warmAdd.added === 1 && warmClaim.target === '8100000001' && warmClaim.warm === true,
      `added=${warmAdd.added} target=${warmClaim.target} warm=${warmClaim.warm}`);
    check('and paces it as warm work, seconds rather than half a minute',
      warmClaim.nextDelayMs > 0 && warmClaim.nextDelayMs <= 12000, String(warmClaim.nextDelayMs));

    // Active: the identical payload, and now the ranked targets are the point.
    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50 });
    const ra = await send('sw:refresh-now');
    const seeded = await queuedIds();
    check('active mode seeds the same payload as cold work',
      ra.ok && seeded.length === 2 &&
      seeded.includes('8100000001') && seeded.includes('8100000002'),
      JSON.stringify(seeded));
    openGate();
    const coldClaim = await send('sw:queue-claim', { platform: 'facebook' });
    check('what it seeded is cold: best rank first, paced slowly',
      coldClaim.target === '8100000001' && coldClaim.warm === false &&
      coldClaim.nextDelayMs >= 20000,
      `${coldClaim.target} warm=${coldClaim.warm} delay=${coldClaim.nextDelayMs}`);

    // An install written before modes existed. Its stored settings carry
    // acceptServerTargets and no mode at all, which is why this writes sync
    // storage directly: going through set-settings would merge today's
    // defaults in and hide the very thing under test.
    store.local = {};
    store.sync = { settings: {
      listUrl: FS_URL, platformBlockEnabled: true, platformBlockDryRun: false,
      maxColdBlocksPerHour: 50, acceptServerTargets: false
    } };
    const rl = await send('sw:refresh-now');
    const legacyQueue = await queuedIds();
    check('an install that refused server targets before modes existed stays passive',
      rl.ok && (rl.blocklist.targets || []).length === 0 && legacyQueue.length === 0,
      JSON.stringify(legacyQueue));
    const legacyMode = (await state()).settings.mode;
    check('and it reports the mode it actually behaves as',
      legacyMode === 'passive', String(legacyMode));

    // The same vintage with the flag the other way round is an ordinary active
    // install: the fallback must not sweep every old install into passive.
    store.local = {};
    store.sync = { settings: {
      listUrl: FS_URL, platformBlockEnabled: true, maxColdBlocksPerHour: 50,
      acceptServerTargets: true
    } };
    const rl2 = await send('sw:refresh-now');
    check('an equally old install that accepted them is active',
      rl2.ok && (await queuedIds()).length === 2, JSON.stringify(await queuedIds()));

    // Pausing outranks the mode entirely.
    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50,
                  platformBlockEnabled: false });
    const rpaused = await send('sw:refresh-now');
    check('with blocking paused, even active mode queues nobody',
      rpaused.ok && (await queuedIds()).length === 0, JSON.stringify(await queuedIds()));
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8100000002'], warm: true });
    openGate();
    const pausedClaim = await send('sw:queue-claim', { platform: 'facebook' });
    check('and nothing already queued is handed out, warm or not',
      !pausedClaim.target, String(pausedClaim.target));

    delete global.fetch;
  }

  // -- 17. the toolbar badge -------------------------------------------------
  //
  // Cold targets are issued through the site's own code, so they only move
  // while a Facebook or Threads tab is open -- and nothing else in the product
  // says so: the queue just sits there looking healthy. The badge is the only
  // signal that reaches someone who is not looking at the extension at all,
  // so it has to be right about every condition it depends on.
  {
    await reset({ mode: 'active', maxColdBlocksPerHour: 50 });
    await send('sw:enqueue-platform-block', { platform: 'facebook', warm: false,
      ids: [{ id: '8300000001', rank: 3 }, { id: '8300000002', rank: 2 }] });

    // Picking a mode is what the options page writes, and writing settings is
    // what re-evaluates the badge.
    await setSettings({ mode: 'active' });
    check('cold work with nowhere to run puts the count on the badge',
      badge.text === '2' && badge.color === '#b7791f',
      `text=${JSON.stringify(badge.text)} color=${badge.color}`);

    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['8300000003'], warm: true });
    await setSettings({ mode: 'active' });
    check('warm entries are not counted: they only ever arrive while a tab is open',
      badge.text === '2', JSON.stringify(badge.text));

    openTabs = [{ id: 11, url: 'https://www.facebook.com/' }];
    await setSettings({ mode: 'active' });
    check('the badge clears once there is a tab for the work to run in',
      badge.text === '', JSON.stringify(badge.text));

    // A Threads tab counts too, and a tab on anything else does not.
    openTabs = [{ id: 12, url: 'https://www.threads.com/@someone' }];
    await setSettings({ mode: 'active' });
    check('a Threads tab is somewhere for the work to run as well',
      badge.text === '', JSON.stringify(badge.text));
    openTabs = [{ id: 13, url: 'https://example.com/' }];
    await setSettings({ mode: 'active' });
    check('an unrelated tab is not, and the warning comes back',
      badge.text === '2', JSON.stringify(badge.text));

    openTabs = [];
    await setSettings({ mode: 'passive' });
    check('passive mode is not waiting on a tab, so the badge clears',
      badge.text === '', JSON.stringify(badge.text));
    await setSettings({ mode: 'active', platformBlockEnabled: false });
    check('paused blocking is not waiting on a tab either',
      badge.text === '', JSON.stringify(badge.text));

    // A checkpoint owns the badge outright: it is the more urgent message and
    // the count would overwrite it.
    await reset({ mode: 'active', maxColdBlocksPerHour: 50 });
    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['8300000004'], warm: true });
    openGate();
    const cp = await send('sw:queue-claim', { platform: 'facebook' });
    await send('sw:queue-result', { platform: 'facebook', target: cp.target, ok: false,
      dryRun: false, checkpoint: true, detail: 'challenge' });
    check('a checkpoint marks the badge itself', badge.text === '!', JSON.stringify(badge.text));
    await send('sw:enqueue-platform-block', { platform: 'facebook', warm: false,
      ids: [{ id: '8300000005', rank: 1 }] });
    await setSettings({ mode: 'active' });
    check('and keeps it while halted, whatever else is queued',
      badge.text === '!', JSON.stringify(badge.text));
  }

  // -- 18. blockTags: which kinds of account get blocked ---------------------
  //
  // The setting rations BLOCKS, not the list: an unticked kind stays listed
  // and stays hidden. Both queueing paths have to honour it -- cold seeding
  // from the ranked slice, and the warm sweep the content script drives -- and
  // exactly one thing has to get past it, the button a person pressed.
  {
    const FS_URL = 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents/blocklist/current';
    const today = new Date().toISOString().slice(0, 10);
    const published = {
      v: 1, updatedAt: new Date().toISOString(),
      ids: ['8500000001', '8500000002', '8500000003'],
      usernames: [], docIdOverrides: {}, pending: [],
      // The flat map covers ids with no target record behind them, which is
      // the only thing warm blocking has to go on.
      idTags: { '8500000001': 'clone', '8500000002': 'redbull', '8500000003': 'spam' },
      targets: [
        { platform: 'facebook', id: '8500000001', tag: 'clone', trust: 2, last: today,
          days: { [today]: 2 }, regions: {}, langs: {}, reporters: 2 },
        { platform: 'facebook', id: '8500000002', tag: 'redbull', trust: 1, last: today,
          days: {}, regions: {}, langs: {}, reporters: 1 }
      ]
    };
    const envelope = {
      name: 'projects/demo-clone/databases/(default)/documents/blocklist/current',
      fields: { json: { stringValue: JSON.stringify(published) } },
      createTime: '2026-08-21T00:00:00Z', updateTime: '2026-08-21T12:00:00Z'
    };
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(envelope), json: async () => envelope
    });
    const queuedIds = async () =>
      ((await state()).queue.facebook || []).map(e => (typeof e === 'string' ? e : e.id));
    const ALL_BUT_REDBULL =
      ['clone', 'impersonation', 'scam', 'harassment', 'spam', 'other'];

    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50 });
    const rAll = await send('sw:refresh-now');
    check('with every kind ticked -- the shipped default -- all of them seed',
      rAll.ok && (await queuedIds()).length === 2, JSON.stringify(await queuedIds()));
    check('the published tag map is cached with the list',
      (rAll.blocklist.idTags || {})['8500000002'] === 'redbull',
      JSON.stringify(rAll.blocklist.idTags));
    check('and ranking does not strip a target of its tag',
      (rAll.blocklist.targets || []).every(t => t.tag),
      JSON.stringify((rAll.blocklist.targets || []).map(t => [t.id, t.tag])));

    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50,
                  blockTags: ALL_BUT_REDBULL });
    await send('sw:refresh-now');
    const seeded = await queuedIds();
    check('an unticked kind is left out of the cold queue',
      seeded.includes('8500000001') && !seeded.includes('8500000002'),
      JSON.stringify(seeded));

    // The content script forwards every listed id it sees. Scrolling past one
    // is not a decision about it, so the filter applies.
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000002'], warm: true });
    check('nor is it queued when the page sweep runs into it',
      !(await queuedIds()).includes('8500000002'), JSON.stringify(await queuedIds()));

    // Pressing Block now is. Dropping that click would leave a dead button and
    // nothing on screen to explain it.
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000002'], warm: true, userInitiated: true });
    check('but an explicit Block now goes through anyway',
      (await queuedIds()).includes('8500000002'), JSON.stringify(await queuedIds()));

    // An id the list published no tag for -- or a whole list published before
    // tags existed -- counts as 'other', which every install blocks until its
    // owner narrows the set.
    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50 });
    await send('sw:refresh-now');
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000009'], warm: true });
    check("an untagged id counts as 'other' and is still blocked",
      (await queuedIds()).includes('8500000009'), JSON.stringify(await queuedIds()));
    await setSettings({ blockTags: ['clone'] });
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000008'], warm: true });
    check("...and is refused once 'other' is unticked",
      !(await queuedIds()).includes('8500000008'), JSON.stringify(await queuedIds()));

    // Ticking nothing is a real answer -- "hide them, block nobody" -- and has
    // to be distinguishable from a settings object that has never met the key.
    await reset({ mode: 'active', listUrl: FS_URL, maxColdBlocksPerHour: 50,
                  blockTags: [] });
    await send('sw:refresh-now');
    await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8500000001'], warm: true });
    check('ticking no kinds at all blocks nobody unprompted',
      (await queuedIds()).length === 0, JSON.stringify(await queuedIds()));
    check('and the list itself is untouched: hiding is tag-blind',
      ((await state()).blocklist.ids || []).length === 3,
      JSON.stringify((await state()).blocklist.ids));

    delete global.fetch;
  }

  // -- 19. the two rankers must stay in step --------------------------------
  //
  // The same formula is written out twice: rankPublishedTargets() in the
  // service worker, and rankTargets() in hosting/logic.js, which the worker
  // cannot import and which is what the dashboard preview and the Firebase
  // suite rank with. Nothing would announce them drifting -- both would go on
  // returning a plausible order, and the admin's preview would quietly stop
  // describing what any client actually does.
  //
  // So the worker's real output, read back off the stored list, is compared
  // against the module's on the same fixture: with the privacy setting off
  // (neutral locality), with it on (the machine's own region and language),
  // and with the published dials turned away from their defaults.
  {
    const L = require(path.join(__dirname, '..', 'hosting', 'logic.js'));
    const FS_URL = 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents/blocklist/current';
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

    // The worker reads its context from Intl and navigator; the module takes
    // it as an argument. Deriving both from the same two calls is what makes
    // "the same input" true -- and keying part of the fixture on it is what
    // stops locality collapsing to a constant on whatever machine this runs.
    const region = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
    })();
    const lang = (() => {
      try { return ((globalThis.navigator && navigator.language) || '').trim().toLowerCase() || null; }
      catch (e) { return null; }
    })();
    const HERE = region || 'Asia/Ho_Chi_Minh';
    const THERE = HERE === 'America/Sao_Paulo' ? 'Europe/Paris' : 'America/Sao_Paulo';
    const MINE = lang || 'vi-vn';
    const FOREIGN = MINE === 'pt-br' ? 'fr-fr' : 'pt-br';

    const fixture = [
      { platform: 'threads', id: '7700000001', tag: 'clone', trust: 2.5, last: day(0),
        days: { [day(0)]: 4, [day(1)]: 2 }, regions: { [HERE]: 6 }, langs: { [MINE]: 6 }, reporters: 6 },
      { platform: 'threads', id: '7700000002', tag: 'clone', trust: 2.5, last: day(0),
        days: { [day(0)]: 4 }, regions: { [THERE]: 6 }, langs: { [FOREIGN]: 6 }, reporters: 6 },
      { platform: 'facebook', id: '7700000003', tag: 'spam', trust: 0.75, last: day(9),
        days: { [day(9)]: 1 }, regions: { [HERE]: 1 }, langs: { [MINE]: 1 }, reporters: 1 },
      { platform: 'facebook', id: '7700000004', tag: 'redbull', trust: 1.5, last: day(3),
        days: { [day(3)]: 2, [day(2)]: 1 }, regions: { [HERE]: 2, [THERE]: 1 },
        langs: { [MINE]: 2, [FOREIGN]: 1 }, reporters: 3 },
      // No tallies at all: the smoothed affinities have to agree on an empty
      // denominator too, which is where the ported divide-by-region quirk bites.
      { platform: 'threads', id: '7700000005', tag: 'other', trust: 1, last: day(1),
        days: {}, regions: {}, langs: {}, reporters: 0 },
      { platform: 'threads', id: '7700000006', tag: 'scam', trust: 1, last: day(1),
        days: { [day(1)]: 3 }, regions: { [THERE]: 2 }, langs: { [MINE]: 5 }, reporters: 2 }
    ];

    const listOf = (weights) => {
      const published = {
        v: 1, updatedAt: new Date().toISOString(),
        ids: fixture.map(t => t.id), usernames: [], docIdOverrides: {}, pending: [],
        idTags: Object.fromEntries(fixture.map(t => [t.id, t.tag])),
        targets: fixture
      };
      if (weights) published.rankWeights = weights;
      return {
        name: 'projects/demo-clone/databases/(default)/documents/blocklist/current',
        fields: { json: { stringValue: JSON.stringify(published) } },
        createTime: '2026-08-21T00:00:00Z', updateTime: new Date().toISOString()
      };
    };

    // Both round to three decimals, so exact agreement is the expectation and
    // the epsilon only forgives the last bit of a double.
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    const agree = (mine, theirs) =>
      mine.length === theirs.length && mine.every((t, i) => {
        const o = theirs[i];
        return t.id === o.id && near(t.rank, o.rank) &&
          t.why.recentDays === o.why.recentDays &&
          t.why.velocity7d === o.why.velocity7d &&
          near(t.why.trust, o.why.trust) &&
          near(t.why.region, o.why.region) &&
          near(t.why.lang, o.why.lang) &&
          t.why.reporters === o.why.reporters;
      });
    const shown = (rows) => JSON.stringify(rows.map(t => [t.id, t.rank]));

    async function rankedByWorker(settings, weights) {
      global.fetch = async () => {
        const envelope = listOf(weights);
        return { ok: true, status: 200, headers: { get: () => null },
                 text: async () => JSON.stringify(envelope), json: async () => envelope };
      };
      await reset(Object.assign({ mode: 'active', listUrl: FS_URL,
        maxColdBlocksPerHour: 50, targetBudget: 50 }, settings));
      const r = await send('sw:refresh-now');
      return (r.blocklist && r.blocklist.targets) || [];
    }

    const blind = await rankedByWorker({ shareRegion: false });
    check('the worker ranks every published target, none dropped',
      blind.length === fixture.length, String(blind.length));
    check('with shareRegion off both rankers agree on neutral locality',
      agree(blind, L.rankTargets(fixture, {})),
      shown(blind) + ' vs ' + shown(L.rankTargets(fixture, {})));

    const local = await rankedByWorker({ shareRegion: true });
    check('with shareRegion on both rankers agree on this machine\'s context',
      agree(local, L.rankTargets(fixture, { region, lang })),
      shown(local) + ' vs ' + shown(L.rankTargets(fixture, { region, lang })));
    check('and the local context actually changed the ordering it agreed on',
      shown(local) !== shown(blind) || !region,
      shown(local) + ' vs ' + shown(blind));

    // The dials are published so the owner can turn them without shipping an
    // extension update; a worker that ignored one would go on ranking sensibly
    // while disagreeing with everything the dashboard showed.
    const tuned = { halfLifeDays: 3, velocityWeight: 2, localityFloor: 0.5,
                    localityLangFactor: 0.5, uniqueReporterBoost: 1 };
    const dialled = await rankedByWorker({ shareRegion: true }, tuned);
    check('both rankers read the published weights the same way',
      agree(dialled, L.rankTargets(fixture, { region, lang }, tuned)),
      shown(dialled) + ' vs ' + shown(L.rankTargets(fixture, { region, lang }, tuned)));
    check('and the tuned weights are not silently the defaults',
      shown(dialled) !== shown(local) ||
      dialled.some((t, i) => !near(t.rank, local[i].rank)),
      shown(dialled) + ' vs ' + shown(local));

    delete global.fetch;
  }

  // -- 20. the two switches --------------------------------------------------
  //
  // blockSeen and blockFromList are not two halves of one dial. The radio they
  // replaced could only say "just what I see" or "both", so "work through the
  // list but leave what I scroll past alone" was unsayable -- and that is the
  // combination worth proving hardest, because nothing before this could
  // express it at all.
  //
  // Both sources are driven the way the extension drives them: a real refresh
  // whose payload carries ranked targets for the cold side, and a real enqueue
  // marked warm for the side that comes off the page in front of you.
  {
    const FS_URL = 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents/blocklist/current';
    const today = new Date().toISOString().slice(0, 10);
    const published = {
      v: 1, updatedAt: new Date().toISOString(),
      ids: ['8200000001', '8200000002'], usernames: [], docIdOverrides: {}, pending: [],
      targets: [
        { platform: 'facebook', id: '8200000001', trust: 2, last: today,
          days: { [today]: 2 }, regions: {}, langs: {} },
        { platform: 'facebook', id: '8200000002', trust: 1, last: today,
          days: {}, regions: {}, langs: {} }
      ]
    };
    const envelope = {
      name: 'projects/demo-clone/databases/(default)/documents/blocklist/current',
      fields: { json: { stringValue: JSON.stringify(published) } },
      createTime: '2026-08-21T00:00:00Z', updateTime: '2026-08-21T09:00:00Z'
    };
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(envelope), json: async () => envelope
    });
    const queuedIds = async () =>
      ((await state()).queue.facebook || []).map(e => (typeof e === 'string' ? e : e.id));

    // A profile on the list that this browser has never met until it scrolls
    // past, so what these prove is the switch rather than the seeding.
    const ON_SCREEN = '8200000003';

    /**
     * Run both sources past one settings object and report what each of them
     * managed to queue.
     *
     * Kept apart, because the whole question is whether one can be on while
     * the other is off: a single count would pass just as happily if the
     * wrong source had filled it.
     */
    async function bothSources(settings) {
      await reset(Object.assign({ listUrl: FS_URL, maxColdBlocksPerHour: 50 }, settings));
      const r = await send('sw:refresh-now');
      const fromList = await queuedIds();
      await send('sw:enqueue-platform-block',
        { platform: 'facebook', ids: [ON_SCREEN], warm: true });
      const after = await queuedIds();
      return { ok: r.ok, listKept: (r.blocklist && r.blocklist.ids) || [],
               fromList, seen: after.filter(id => !fromList.includes(id)) };
    }

    // The combination the radio could not say: work the list, leave what
    // scrolls past alone.
    const listOnly = await bothSources({ blockSeen: false, blockFromList: true });
    check('blockSeen off, blockFromList on: the ranked list still seeds cold work',
      listOnly.fromList.length === 2 &&
      listOnly.fromList.includes('8200000001') && listOnly.fromList.includes('8200000002'),
      JSON.stringify(listOnly.fromList));
    check('and a profile that turns up on screen is not queued',
      listOnly.seen.length === 0, JSON.stringify(listOnly.seen));
    // Seeded is not the same as workable: the cold side has to survive the
    // claim too, or "the list keeps running" would be a claim about storage.
    openGate();
    const listOnlyClaim = await send('sw:queue-claim', { platform: 'facebook' });
    check('and the cold work it seeded is handed out, paced as cold',
      listOnlyClaim.target === '8200000001' && listOnlyClaim.warm === false &&
      listOnlyClaim.nextDelayMs >= 20000,
      `${listOnlyClaim.target} warm=${listOnlyClaim.warm} delay=${listOnlyClaim.nextDelayMs}`);

    // The converse: what is in front of you, and nothing else.
    const seenOnly = await bothSources({ blockSeen: true, blockFromList: false });
    check('blockSeen on, blockFromList off: the list still arrives in full',
      seenOnly.ok && seenOnly.listKept.length === 2, JSON.stringify(seenOnly.listKept));
    check('but none of its ranked targets are queued',
      seenOnly.fromList.length === 0, JSON.stringify(seenOnly.fromList));
    check('and a profile that turns up on screen still is',
      seenOnly.seen.includes(ON_SCREEN), JSON.stringify(seenOnly.seen));

    // Both off is a real setting -- the extension still hides, still reports,
    // still keeps the list -- and it has to be quiet from both directions.
    const neither = await bothSources({ blockSeen: false, blockFromList: false });
    check('both switches off: neither source queues anybody',
      neither.fromList.length === 0 && neither.seen.length === 0,
      `fromList=${JSON.stringify(neither.fromList)} seen=${JSON.stringify(neither.seen)}`);

    // Pressing a button is a decision, not a sweep. The popup's Block now and
    // the report sheet's block-too tick box both send userInitiated, and it
    // has to outrank the standing preference: a control that silently did
    // nothing would be worse than no control at all.
    const byHand = await send('sw:enqueue-platform-block',
      { platform: 'facebook', ids: ['8200000004'], warm: true, userInitiated: true });
    check('but a block the user asked for by hand still goes through',
      byHand.added === 1 && (await queuedIds()).includes('8200000004'),
      JSON.stringify(await queuedIds()));

    // The ordinary shipped state, where the two do not interfere.
    const both = await bothSources({ blockSeen: true, blockFromList: true });
    check('both switches on: the list and the page each queue their own',
      both.fromList.length === 2 && both.seen.includes(ON_SCREEN),
      `fromList=${JSON.stringify(both.fromList)} seen=${JSON.stringify(both.seen)}`);

    /**
     * An install written before the pair existed.
     *
     * Its settings go straight into sync storage: going through set-settings
     * would merge today's defaults in and hide the very thing under test,
     * which is what the worker makes of a settings object that has neither
     * blockSeen nor blockFromList in it.
     */
    async function legacyInstall(stored) {
      store.local = {};
      store.sync = { settings: Object.assign({
        listUrl: FS_URL, platformBlockEnabled: true, platformBlockDryRun: false,
        maxColdBlocksPerHour: 50
      }, stored) };
      const r = await send('sw:refresh-now');
      const fromList = await queuedIds();
      await send('sw:enqueue-platform-block',
        { platform: 'facebook', ids: [ON_SCREEN], warm: true });
      const after = await queuedIds();
      return { ok: r.ok, targets: (r.blocklist && r.blocklist.targets) || [], fromList,
               seen: after.filter(id => !fromList.includes(id)),
               settings: (await state()).settings };
    }

    const wasPassive = await legacyInstall({ mode: 'passive' });
    check('an install carrying mode passive still refuses cold work end to end',
      wasPassive.ok && wasPassive.targets.length === 0 && wasPassive.fromList.length === 0,
      JSON.stringify(wasPassive.fromList));
    check('and still blocks what it sees, which is all passive ever meant',
      wasPassive.seen.includes(ON_SCREEN), JSON.stringify(wasPassive.seen));
    check('and it reads back as the pair it behaves as',
      wasPassive.settings.blockSeen === true && wasPassive.settings.blockFromList === false,
      `seen=${wasPassive.settings.blockSeen} fromList=${wasPassive.settings.blockFromList}`);

    // Older still: the flag that predates modes entirely. Somebody who turned
    // server targets off must not get them back by upgrading twice.
    const refusedTargets = await legacyInstall({ acceptServerTargets: false });
    check('an install carrying acceptServerTargets false refuses it the same way',
      refusedTargets.ok && refusedTargets.targets.length === 0 &&
      refusedTargets.fromList.length === 0, JSON.stringify(refusedTargets.fromList));
    check('and it too keeps blocking what turns up on screen',
      refusedTargets.seen.includes(ON_SCREEN), JSON.stringify(refusedTargets.seen));

    delete global.fetch;
  }

  // -- 21. one pacing gate for the whole browser -----------------------------
  //
  // The gate is what stops five open tabs producing five times the rate the
  // caps were chosen for. Section 5 proves it holds between tabs on one site;
  // the question here is what it does across the two sites, because a gate
  // kept per platform would let a Facebook tab and a Threads tab block in the
  // same second and quietly double the rate again. Facebook and Threads are
  // one Meta account, and the account is the thing that gets checkpointed --
  // so one gate covers the browser, not one per site.
  {
    await reset();
    await send('sw:enqueue-platform-block', { platform: 'threads', ids: ['9100000001'], warm: true });
    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9100000002'], warm: true });

    openGate();
    const onThreads = await send('sw:queue-claim', { platform: 'threads' });
    const onFacebook = await send('sw:queue-claim', { platform: 'facebook' });
    check('a block in flight on Threads holds a Facebook tab back too',
      onThreads.target === '9100000001' && !onFacebook.target && onFacebook.retryInMs > 0,
      `threads=${onThreads.target} facebook=${onFacebook.target} retry=${onFacebook.retryInMs}`);

    await send('sw:queue-result',
      { platform: 'threads', target: onThreads.target, ok: true, dryRun: true, warm: true });
    const stillHeld = await send('sw:queue-claim', { platform: 'facebook' });
    const s21 = (await state()).settings;
    check('and the pause after that block lands is shared across both sites',
      !stillHeld.target && stillHeld.retryInMs > 0 &&
      stillHeld.retryInMs <= (s21.warmMaxDelayMs | 0) + 500,
      `retryInMs=${stillHeld.retryInMs} warmMax=${s21.warmMaxDelayMs}`);

    openGate();
    const servedNext = await send('sw:queue-claim', { platform: 'facebook' });
    check('once the pause has run the other site is served, not starved',
      servedNext.target === '9100000002', String(servedNext.target));
  }

  // -- 22. a tab that dies mid-block must not wedge the queue ----------------
  //
  // The gate is shut by the claim and reopened by the result, so a tab that is
  // closed, crashed or navigated away between the two never reports anything.
  // Nothing would notice: there is no error and no failed target, just a
  // browser that stopped blocking. The claim bounds the shut gate by the lease
  // for exactly this reason, and a bound is only worth having if it is tested.
  {
    // The worker's lease window. Hardcoded because it is a module-local const
    // in the service worker: if it moves, this should fail loudly rather than
    // quietly stop testing anything.
    const LEASE_MS = 90 * 1000;

    await reset();
    await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9200000001'], warm: true });
    openGate();
    const claimed = await send('sw:queue-claim', { platform: 'facebook' });

    // The tab is gone. No result is ever reported for this target.
    const wedged = await send('sw:queue-claim', { platform: 'facebook' });
    const s22 = (await state()).settings;
    check('with a block in flight the gate is shut for the lease, not for the delay',
      claimed.target === '9200000001' && !wedged.target &&
      wedged.retryInMs > (s22.warmMaxDelayMs | 0) && wedged.retryInMs <= LEASE_MS,
      `retryInMs=${wedged.retryInMs} warmMax=${s22.warmMaxDelayMs} lease=${LEASE_MS}`);

    rewind(LEASE_MS + 1000);
    const recovered = await send('sw:queue-claim', { platform: 'facebook' });
    check('and once the lease has run out the target is claimable again',
      recovered.target === '9200000001',
      `target=${recovered.target} retry=${recovered.retryInMs}`);
    check('with nothing lost from the queue while it was held',
      ((await state()).queue.facebook || []).length === 1,
      JSON.stringify((await state()).queue.facebook));
  }

  finish();
})().catch((e) => { console.error('harness error:', e); process.exitCode = 1; });

function finish() {
  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  }
  process.exitCode = failed.length ? 1 : 0;
}
