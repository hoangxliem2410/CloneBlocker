/**
 * Unit tests for the service worker's queue, leases and rate limiter.
 *
 * The browser test runs with Layer 2 disabled (deliberately -- it must never
 * block anyone for real), which leaves this logic uncovered there. It is also
 * the logic most likely to misbehave in ways a user would not notice quickly:
 * a starved queue or a limiter that fails to count looks like "nothing is
 * happening" rather than an error.
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
const alarms = new Map();

global.chrome = {
  storage: { local: area('local'), sync: area('sync'), onChanged: { addListener() {} } },
  alarms: {
    onAlarm: { addListener() {} },
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
  tabs: { async query() { return []; }, sendMessage() {} },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
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

async function reset(settings) {
  store.local = {};
  store.sync = {};
  await setSettings(Object.assign({
    platformBlockEnabled: true,
    platformBlockDryRun: false,
    maxBlocksPerHour: 100,
    maxBlocksPerDay: 100,
    listUrl: ''
  }, settings || {}));
}

(async () => {
  // TQ_SW lets the regression check below point this at a modified copy.
  const swFile = process.env.TQ_SW || path.join(__dirname, '..', 'src', 'background', 'service-worker.js');
  const swPath = pathToFileURL(swFile).href;
  await import(swPath);
  if (!messageHandler) { check('service worker registered a message handler', false); finish(); return; }
  check('service worker registered a message handler', true);

  // -- 1. a permanently failing target must not starve the queue ------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['1111111111', '2222222222', '3333333333'] });

  const first = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: first.target, ok: false, dryRun: false, detail: 'simulated failure'
  });
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

  // -- 5. concurrent claims never hand out the same target ------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['1212121212', '3434343434'] });
  const [a, b] = await Promise.all([
    send('sw:queue-claim', { platform: 'facebook' }),
    send('sw:queue-claim', { platform: 'facebook' })
  ]);
  check('concurrent claims from two tabs get different targets',
    a.target && b.target && a.target !== b.target, `a=${a.target} b=${b.target}`);

  // -- 6. success retires the target ---------------------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['5656565656'] });
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
  const c7 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result', {
    platform: 'facebook', target: c7.target, ok: false, dryRun: false, checkpoint: true, detail: 'challenge'
  });
  const st7 = await state();
  const after7 = await send('sw:queue-claim', { platform: 'facebook' });
  check('a checkpoint disables platform blocking and stops handing out work',
    st7.settings.platformBlockEnabled === false && !after7.target,
    `enabled=${st7.settings.platformBlockEnabled} nextTarget=${after7.target}`);

  // -- 8. already-blocked targets are not re-queued -------------------------
  await reset();
  await send('sw:enqueue-platform-block', { platform: 'facebook', ids: ['9090909090'] });
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

  const w1 = await send('sw:queue-claim', { platform: 'facebook' });
  check('a profile that was on screen is claimed before a server-nominated one',
    w1.target === '6000000002' && w1.warm === true,
    `${w1.target} warm=${w1.warm}`);
  check('the claim carries a short pause after a warm block',
    w1.nextDelayMs > 0 && w1.nextDelayMs <= 12000, String(w1.nextDelayMs));

  await send('sw:queue-result',
    { platform: 'facebook', target: '6000000002', ok: true, warm: true });

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
  const c2 = await send('sw:queue-claim', { platform: 'facebook' });
  await send('sw:queue-result',
    { platform: 'facebook', target: c2.target, ok: true, warm: false });

  // Two cold blocks spent against a ceiling of two.
  const c3 = await send('sw:queue-claim', { platform: 'facebook' });
  check('cold work stops at its hourly ceiling',
    !c3.target && c3.coldHeld === true, `${c3.target} held=${c3.coldHeld}`);

  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6000000005'], warm: true });
  const w2 = await send('sw:queue-claim', { platform: 'facebook' });
  check('warm work continues after the cold ceiling is reached',
    w2.target === '6000000005' && w2.warm === true, `${w2.target} warm=${w2.warm}`);

  // -- 10. seeing a cold target on screen promotes it -----------------------
  await reset({ maxColdBlocksPerHour: 0 });
  await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: [{ id: '6100000001', rank: 5 }], warm: false });
  const before = await send('sw:queue-claim', { platform: 'facebook' });
  check('with no cold budget at all, a cold target is not handed out',
    !before.target, String(before.target));

  const promo = await send('sw:enqueue-platform-block',
    { platform: 'facebook', ids: ['6100000001'], warm: true });
  check('re-seeing it on screen promotes it rather than duplicating it',
    promo.promoted === 1 && promo.added === 0 && promo.queued === 1,
    JSON.stringify(promo));
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
