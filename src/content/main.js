/**
 * Content-script orchestrator (ISOLATED world).
 *
 * Boot order matters here:
 *   1. Start the bridge handshake immediately -- the MAIN world may already be
 *      waiting, and its module hook is only useful if we can reach it.
 *   2. Load settings + blocklist from the service worker and start hiding.
 *      Layer 1 must not wait on anything network-bound.
 *   3. Only once everything is settled, consider the opt-in platform-block
 *      worker.
 */
(function () {
  'use strict';

  const P = globalThis.TQ_PROTOCOL;
  const bridge = globalThis.TQ_BRIDGE;
  const identity = globalThis.TQ_IDENTITY;
  const dom = globalThis.TQ_DOM;
  const report = globalThis.TQ_REPORT;

  let settings = Object.assign({}, globalThis.TQ_DEFAULT_SETTINGS);
  let workerRunning = false;

  function log(...a) { if (settings.debug) console.debug('[3Que]', ...a); }

  async function boot() {
    bridge.beginHandshake();

    // Settings first -- debug flag changes how noisy everything else is.
    const s = await bridge.sw(P.SW.GET_SETTINGS);
    if (s && s.ok && s.settings) settings = Object.assign(settings, s.settings);
    bridge.setDebug(settings.debug);

    await identity.loadAliases();

    const bl = await bridge.sw(P.SW.GET_BLOCKLIST);
    if (bl && bl.ok && bl.blocklist) {
      identity.setBlocklist(bl.blocklist);
      log('blocklist loaded', identity.stats());
      // Numeric ids are actionable immediately; nothing has to be discovered
      // for them first.
      maybeSeedQueue();
    } else {
      log('no blocklist available yet', bl && bl.error);
    }

    dom.updateSettings(settings);
    dom.start();

    // The in-page report affordance. Independent of the hiding layer: someone
    // may want to report clones without hiding anything, or vice versa.
    if (report) {
      report.updateSettings(settings);
      report.start();
    }

    // Push config the MAIN world needs (doc_id overrides, learned template).
    bridge.on(P.HELLO_ACK, () => pushMainConfig());
    if (bridge.isHandshakeDone()) pushMainConfig();

    // Keep the id<->username map fed from every Relay store sweep.
    bridge.on(P.STORE_SNAPSHOT, (payload) => {
      const res = identity.learnMany(payload && payload.users) || { learned: 0, relevant: 0 };
      if (res.learned) {
        log('learned', res.learned, 'pairs,', res.relevant, 'blocklist-relevant');
        if (res.relevant) {
          // One of these pairs bridges a blocklist entry to something on the
          // page. Verdicts cached before we knew that are now wrong, and their
          // signatures have not changed, so a plain re-scan would skip them.
          dom.invalidateDecisions();
        }
        dom.scan();
      }
      // Report resolved ids for blocklist usernames back to the worker queue.
      maybeSeedQueue();
    });

    // Capture mode: the MAIN world saw a real block request go by.
    bridge.on(P.CAPABILITY, (payload) => {
      if (!payload || !payload.capturedTemplate) return;
      // The bridge's emit() only catches synchronous throws, so an async
      // listener has to own its rejections (storage quota, dead context).
      (async () => {
        const key = 'learnedTemplate_' + bridge.state.platform;
        const next = Object.assign({ at: Date.now() }, payload.capturedTemplate);
        const existing = (await chrome.storage.local.get(key))[key];

        // Not every captured request is worth keeping. Rank them, and never let
        // a weaker capture displace a stronger one: a persisted-query request
        // (doc_id + operation name) is the real thing, while a bare URL with no
        // operation is usually a REST attempt that may well have failed.
        const score = (t) => {
          if (!t) return -1;
          let s = 0;
          if (t.docId) s += 10;
          if (t.friendlyName) s += 5;
          if (t.fields && Object.keys(t.fields).length > 3) s += 2;
          return s;
        };
        if (score(next) < score(existing)) {
          log('ignoring weaker captured template', next.url);
          return;
        }
        await bridge.sw(P.SW.LOG, { level: 'info', msg: 'captured block request template' });
        await chrome.storage.local.set({ [key]: next });
        pushMainConfig();
      })().catch((e) => log('could not persist captured template', e && e.message));
    });

    // The service worker refreshed the list from your server.
    bridge.onSw(P.SW.BLOCKLIST_UPDATED, async () => {
      const fresh = await bridge.sw(P.SW.GET_BLOCKLIST);
      if (fresh && fresh.ok && fresh.blocklist) {
        identity.setBlocklist(fresh.blocklist);
        dom.rescanAll();
        lastSeeded = '';   // a replaced list must re-seed even if it is the same size
        maybeSeedQueue();
        log('blocklist refreshed', identity.stats());
      }
    });

    // React to settings edits made in the options page.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !changes[globalThis.TQ_KEYS.SETTINGS]) return;
        settings = Object.assign(settings, changes[globalThis.TQ_KEYS.SETTINGS].newValue || {});
        bridge.setDebug(settings.debug);
        dom.updateSettings(settings);
        if (report) report.updateSettings(settings);
        pushMainConfig();
        startWorkerIfEnabled();
      });
    } catch (e) { /* context gone */ }

    // Probe what the MAIN world can do. This has to be repeated, not one-shot:
    // Meta streams its bundles in over several seconds, so an early probe can
    // legitimately report zero modules and no Relay environment, and a stale
    // snapshot of that would misreport the extension as non-functional.
    for (const delay of [2500, 6000, 12000, 25000]) {
      setTimeout(() => bridge.send(P.PROBE_CAPABILITY, {}), delay);
    }

    startStoreSweep();
    startWorkerIfEnabled();
  }

  /**
   * Periodically sweep Meta's Relay store for id<->username pairs.
   *
   * This has to run on its own schedule rather than only when the DOM layer
   * asks a question. If every visible post happens to match on username alone,
   * the DOM layer never needs a round-trip -- and we would never learn the
   * numeric ids behind those usernames. Those ids are exactly what a real
   * platform block requires, so without this the Layer 2 queue would sit empty
   * even though the profiles are right there on screen.
   *
   * The sweep is a plain in-memory walk of records the page already fetched:
   * no network, and only a few hundred records on a typical view.
   */
  function startStoreSweep() {
    const sweep = () => {
      if (document.hidden) return;
      bridge.send(P.RESOLVE_IDS, { nodes: [] });
    };
    setTimeout(sweep, 4000);
    setInterval(sweep, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sweep(); });
  }

  async function pushMainConfig() {
    let learnedTemplate = null;
    let docIdOverrides = {};
    try {
      const key = 'learnedTemplate_' + bridge.state.platform;
      const got = await chrome.storage.local.get([key, 'docIdOverrides']);
      learnedTemplate = got[key] || null;
      docIdOverrides = got.docIdOverrides || {};
    } catch (e) { /* ignore */ }
    bridge.send(P.SET_CONFIG, {
      debug: settings.debug, learnedTemplate, docIdOverrides,
      allowRawNetworkFallback: !!settings.allowRawNetworkFallback
    });
  }

  /** Tell the service worker which blocked profiles now have a numeric id, so
   *  it can queue them for a real platform block.
   *
   *  Called after every store sweep, so it only forwards when the resolvable
   *  set has actually grown -- otherwise each open tab would ship the whole id
   *  list across the message channel every 15 seconds for no reason. */
  let lastSeeded = '';
  async function maybeSeedQueue() {
    if (!settings.platformBlockEnabled) return;
    const ids = identity.blockableIds();
    if (!ids.length) return;
    const sig = ids.length + ':' + ids[ids.length - 1];
    if (sig === lastSeeded) return;
    lastSeeded = sig;
    await bridge.sw(P.SW.ENQUEUE_PLATFORM_BLOCK, {
      platform: bridge.state.platform,
      ids,
      // These came out of the page in front of the user. Blocking someone whose
      // posts you are actually looking at is ordinary behaviour, so it is paced
      // normally rather than rationed like a target the server nominated.
      warm: true
    });
  }

  // -- platform block worker (Layer 2, opt-in) ------------------------------
  //
  // The service worker owns the queue and the rate limiter; this tab is only a
  // pair of hands. It claims one target at a time under a lease, so multiple
  // open Facebook tabs cannot double-block the same profile.
  function startWorkerIfEnabled() {
    if (workerRunning || !settings.platformBlockEnabled) return;
    // Seed before starting rather than waiting for a Relay store sweep to do
    // it. Ids that are already on the list need no discovery at all, and making
    // the queue depend on a sweep meant Layer 2 could sit there reporting
    // nothing to do while the target was right there in the blocklist.
    maybeSeedQueue();
    workerRunning = true;
    log('platform-block worker starting (dryRun=' + settings.platformBlockDryRun + ')');
    workerLoop().catch((e) => {
      workerRunning = false;
      log('worker stopped', e && e.message);
    });
  }

  async function workerLoop() {
    // Give the page time to settle; a freshly-loaded tab has not yet loaded the
    // lazy modules the block mutation lives in.
    await sleep(8000);

    while (settings.platformBlockEnabled) {
      const claim = await bridge.sw(P.SW.QUEUE_CLAIM, { platform: bridge.state.platform });

      if (!claim || !claim.ok || !claim.target) {
        // Nothing to do, or the limiter says wait.
        await sleep(Math.max(30000, (claim && claim.retryInMs) || 60000));
        continue;
      }

      const targetId = claim.target;
      // The service worker sets the pace: short after a profile that was on
      // screen, long after one the server nominated.
      const pauseAfterMs = Number(claim.nextDelayMs) || 0;
      const wasDryRun = settings.platformBlockDryRun !== false;
      let outcome;
      try {
        outcome = await bridge.request(P.PLATFORM_BLOCK, {
          targetId,
          dryRun: wasDryRun
        }, 45000);
      } catch (e) {
        outcome = { ok: false, detail: 'MAIN world timeout: ' + (e && e.message) };
      }

      const res = (outcome && outcome.result) || {};
      await bridge.sw(P.SW.QUEUE_RESULT, {
        platform: bridge.state.platform,
        target: targetId,
        // Only cold attempts count against the cold ceiling.
        warm: !!claim.warm,
        ok: !!(outcome && outcome.ok),
        // Taken from what we asked for, never from the echoed result. The
        // result is structured-cloned and can come back null, which would make
        // a dry run look like a genuine block: the target would be retired to
        // "done" and would consume rate-limit budget without anyone having
        // actually been blocked.
        dryRun: wasDryRun,
        rateLimited: !!res.rateLimited,
        checkpoint: !!res.checkpoint,
        loggedOut: !!res.loggedOut,
        detail: (outcome && outcome.detail) || '',
        attempts: (outcome && outcome.attempts) || []
      });

      if (res.loggedOut) {
        // The platform rejected the session. Every further attempt would fail
        // the same way, so stop and let the user sign in again.
        log('session rejected -- halting worker; sign in again');
        workerRunning = false;
        return;
      }

      if (res.checkpoint) {
        // The account hit a challenge. Stop rather than digging in deeper; this
        // needs a human in the site's own UI. Clear the running flag on the way
        // out, or re-enabling platform blocking after resolving the challenge
        // would do nothing in this tab until it was reloaded.
        log('checkpoint detected -- halting worker');
        workerRunning = false;
        return;
      }

      // Randomised delay. Fixed intervals are exactly what automation
      // detection looks for, and blocking is a rate-limit-sensitive mutation.
      //
      // The interval comes from the claim, which knows whether this target was
      // on the page or nominated by the server. Falls back to the cold setting
      // when the worker is talking to an older service worker.
      const lo = Math.max(2000, settings.minDelayMs | 0);
      const hi = Math.max(lo + 1000, settings.maxDelayMs | 0);
      const wait = res.rateLimited
        ? 15 * 60 * 1000                        // backed off hard on a 429
        : (pauseAfterMs || lo + Math.floor(Math.random() * (hi - lo)));
      await sleep(wait);
    }
    workerRunning = false;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Expose a little surface for the popup to query this tab.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      // Round-trip probe: verifies the isolated world can issue a correlated
      // request to the MAIN world and get its answer back. Used by the test
      // suite, because a response that fails to echo its ticket does not error
      // -- it just hangs until timeout, which is easy to miss.
      if (msg && msg.type === 'tab:probe-bridge') {
        const t0 = Date.now();
        bridge.request(P.RESOLVE_IDS, { nodes: [] }, 8000)
          .then((res) => respond({ ok: true, ms: Date.now() - t0, hasAnswers: Array.isArray(res && res.answers) }))
          .catch((e) => respond({ ok: false, ms: Date.now() - t0, error: String(e && e.message) }));
        return true;
      }
      // Diagnostic: resolve which block strategy would be used for a target and
      // report what it would send. dryRun is hardcoded true here and is NOT
      // taken from settings -- this path must never be able to block anyone,
      // whatever the extension is configured to do.
      if (msg && msg.type === 'tab:dry-block') {
        bridge.request(P.PLATFORM_BLOCK, { targetId: String(msg.targetId || ''), dryRun: true }, 30000)
          .then((res) => respond({ ok: true, dryRun: true, res }))
          .catch((e) => respond({ ok: false, error: String(e && e.message) }));
        return true;
      }
      if (msg && msg.type === 'tab:dump-modules') {
        bridge.request(P.DUMP_MODULES, { pattern: msg.pattern || 'block' }, 20000)
          .then((res) => respond({ ok: true, res }))
          .catch((e) => respond({ ok: false, error: String(e && e.message) }));
        return true;
      }
      // Popup entry point: report the profile this page is showing.
      if (msg && msg.type === 'tab:report-current') {
        respond(report ? report.reportCurrentProfile() : { ok: false, error: 'report UI not loaded' });
        return true;
      }
      if (!msg || msg.type !== 'tab:status') return;
      // Ask for a fresh capability report rather than serving the last
      // snapshot, which may predate the page finishing its bundle load.
      const base = {
        ok: true,
        platform: bridge.state.platform,
        viewerId: bridge.state.viewerId,
        handshake: bridge.isHandshakeDone(),
        identity: identity.stats(),
        dom: dom.stats(),
        // Who this page is about, so the popup can offer an action for it
        // rather than a page of switches.
        profile: report ? report.currentProfileInfo() : null,
        unresolved: identity.unresolvedUsernames().slice(0, 25)
      };
      bridge.request(P.PROBE_CAPABILITY, {}, 5000)
        .then((cap) => respond(Object.assign(base, { capability: cap || bridge.state.capability })))
        .catch(() => respond(Object.assign(base, { capability: bridge.state.capability })));
      return true;
    });
  } catch (e) { /* ignore */ }

  boot().catch((e) => console.warn('[3Que] boot failed', e));
})();
