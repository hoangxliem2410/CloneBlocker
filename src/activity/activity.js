/**
 * Activity: the ledger of what blocking has actually done.
 *
 * The popup answers "what can I do about the profile in front of me"; the
 * options page answers "how should this behave". This page answers the third
 * question people actually ask: what has this thing DONE -- who was blocked
 * and why, what is still waiting, and is the list fresh.
 *
 * Everything renders with textContent. Names, ids and failure details all
 * originate from strangers' profiles or from the list owner; none of it gets
 * to be markup here.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const $ = (id) => document.getElementById(id);

  function sw(type, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      setTimeout(() => done({ ok: false, error: 'service worker did not respond' }), 10000);
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) { done({ ok: false, error: chrome.runtime.lastError.message }); return; }
        done(res || { ok: false, error: 'no response' });
      });
    });
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Blocks are issued by the content script, through the site's own code, so a
  // queued block has nowhere to run unless a Facebook or Threads tab is open.
  // These are the same patterns the service worker's badge counts against.
  const SITE_TAB_URLS = [
    'https://*.facebook.com/*', 'https://*.threads.net/*', 'https://*.threads.com/*'
  ];

  /** Is there anywhere for a queued block to run right now? */
  async function siteTabOpen() {
    try {
      const tabs = await chrome.tabs.query({ url: SITE_TAB_URLS });
      return (tabs || []).length > 0;
    } catch (e) {
      // A warning that might be wrong is worse than no warning: if the lookup
      // fails, assume there is a tab and say nothing.
      return true;
    }
  }

  /**
   * Queued targets that nothing on screen will ever trigger.
   *
   * Warm entries were on screen when they were queued, so a tab existed and
   * they drain at once; only the cold ones -- the ranked list's own
   * nominations -- can sit there indefinitely with nowhere to run. A bare
   * string predates the warm flag and the queue treats it as cold.
   */
  function coldQueued(s) {
    let n = 0;
    for (const platform of Object.keys((s && s.queue) || {})) {
      for (const e of s.queue[platform] || []) {
        if (!(e && typeof e === 'object' && e.warm)) n++;
      }
    }
    return n;
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  const inMs = (ms) => ms < 60000 ? Math.ceil(ms / 1000) + 's' : Math.ceil(ms / 60000) + 'm';

  let filter = '';
  let state = null;

  /** displayName/@username for an id, when the published metadata knows it. */
  function nameFor(id, platform) {
    const t = state && state.blocklist &&
      (state.blocklist.targets || []).find(x => String(x.id) === String(id) &&
        (!platform || !x.platform || x.platform === platform));
    if (!t) return null;
    return t.displayName || (t.username ? '@' + t.username : null);
  }

  /**
   * The honest reason line. A warm target is on the list AND was on screen;
   * a cold one was suggested by the published trending metadata, and its
   * `why` says with what force.
   */
  function reasonFor(entry) {
    const bits = [];
    if (entry.warm) {
      bits.push('on your blocklist · seen on screen');
    } else {
      bits.push('suggested from the list');
      const w = entry.why;
      if (w) {
        if (w.velocity7d) bits.push(`active ${w.velocity7d}× in 7 days`);
        if (w.recentDays === 0) bits.push('reported today');
        else if (w.recentDays != null && w.recentDays <= 7) bits.push(`reported ${w.recentDays}d ago`);
        if (w.region >= 0.5) bits.push('active near you');
      }
      if (entry.rank != null) bits.push('rank ' + entry.rank);
    }
    return bits.join(' · ');
  }

  function chip(text, cls) { return el('span', 'pill ' + (cls || ''), text); }

  function row(main, sub, chips) {
    const r = el('div', 'arow');
    const left = el('div', 'aleft');
    left.appendChild(el('div', 'amain', main));
    if (sub) left.appendChild(el('div', 'asub', sub));
    r.appendChild(left);
    const right = el('div', 'aright');
    for (const c of chips) if (c) right.appendChild(c);
    r.appendChild(right);
    return r;
  }

  /**
   * One banner, in order of urgency.
   *
   * A pause or a checkpoint has stopped blocking for a reason the reader can
   * do nothing about from here, so those win. The missing tab comes last: it
   * is a real stall, but only of the cold queue, and only while everything
   * else is healthy.
   */
  function renderBanner(stats, needsTab, cold) {
    const b = $('banner');
    const pausedFor = stats.pausedUntil && stats.pausedUntil > Date.now()
      ? stats.pausedUntil - Date.now() : 0;
    const err = stats.lastError;
    const oldErr = stats.lastErrorAt && (Date.now() - stats.lastErrorAt) > 3600 * 1000;
    if (pausedFor) {
      b.textContent = (stats.halted
        ? 'Halted after an account checkpoint. Resolve it on the site, then use Reset queue & stats in Settings.'
        : 'Paused by rate limiting') + ' — resumes in ' + inMs(pausedFor) + '.';
      b.className = 'banner warn';
    } else if (err && !oldErr) {
      b.textContent = err + (stats.lastErrorAt ? '  (' + ago(stats.lastErrorAt) + ')' : '');
      b.className = 'banner err';
    } else if (needsTab) {
      b.textContent = (cold === 1 ? '1 profile from the list is' : cold + ' profiles from the list are') +
        ' waiting to be blocked. Active blocking runs inside a Facebook or Threads tab — ' +
        'open one and leave it open.';
      b.className = 'banner warn';
    } else {
      b.className = 'banner hidden';
    }
  }

  function renderSync(s) {
    const bl = s.blocklist;
    const host = el('div', 'kv-grid');
    const add = (k, v, cls) => {
      host.appendChild(el('div', 'kk', k));
      host.appendChild(el('div', 'vv' + (cls ? ' ' + cls : ''), v));
    };
    if (!bl) {
      add('source', 'no list configured — open Settings');
    } else {
      let src = bl.source || '';
      try { src = new URL(bl.source).host + new URL(bl.source).pathname; } catch (e) {}
      add('source', src);
      // The etag is a Firestore updateTime (an ISO instant) or a CDN hash;
      // show the one as a time and the other as a short fingerprint.
      const tag = String(bl.etag || '').replace(/"/g, '');
      const ver = !tag ? '' : /^\d{4}-\d{2}-\d{2}T/.test(tag)
        ? 'list updated ' + tag.slice(0, 16).replace('T', ' ') + ' UTC'
        : 'version ' + tag.slice(0, 10);
      add('last synced', ago(bl.fetchedAt) + (ver ? '  ·  ' + ver : ''));
      add('hide list', `${bl.ids.length} ids + ${bl.usernames.length} usernames — hidden everywhere, costs nothing`);
      add('block targets', bl.targetsAvailable
        ? `${(bl.targets || []).length} taken of ${bl.targetsAvailable} suggested`
        : String((bl.targets || []).length));
      if ((bl.pending || []).length) add('awaiting review', String(bl.pending.length) + ' reported, not yet decided');
    }
    add('refresh every', (s.settings.refreshMinutes || 60) + ' min');
    const rows = $('syncRows');
    rows.textContent = '';
    rows.appendChild(host);
  }

  function renderTiles(s) {
    const stats = s.stats || {};
    const hourAgo = Date.now() - 3600e3;
    const blocksHour = (stats.blockTimes || []).filter(t => t > hourAgo).length;
    const blocksDay = (stats.blockTimes || []).length;
    const queued = Object.values(s.queue || {}).reduce((n, a) => n + a.length, 0);
    $('tBlocked').textContent = String(stats.succeeded || 0);
    $('tQueued').textContent = String(queued);
    $('tHour').textContent = blocksHour + '/' + (s.settings.maxBlocksPerHour || '—');
    $('tDay').textContent = blocksDay + '/' + (s.settings.maxBlocksPerDay || '—');
    $('tFailed').textContent = String(stats.failed || 0) +
      (stats.abandoned ? ' +' + stats.abandoned + ' gave up' : '');
    $('tHidden').textContent = s.blocklist ? String(s.blocklist.count || 0) : '—';
  }

  function renderQueue(s, ctx) {
    const host = $('queueRows');
    host.textContent = '';
    const cooldowns = s.cooldowns || {}, failures = s.failures || {};
    const now = Date.now();
    const entries = [];
    for (const platform of Object.keys(s.queue || {})) {
      for (const e of s.queue[platform]) {
        const o = typeof e === 'string' ? { id: e } : e;
        entries.push(Object.assign({ platform }, o));
      }
    }
    // Warm first, then rank — the same order claim() serves them in.
    entries.sort((a, b) => (b.warm ? 1 : 0) - (a.warm ? 1 : 0) || (b.rank || 0) - (a.rank || 0));

    $('queueEmpty').classList.toggle('hidden', entries.length > 0);

    // Why nothing is moving, when nothing is moving. Passive mode and a
    // missing tab look identical from the outside -- a queue that sits there
    // -- and only one of them is fixed by opening a tab.
    const cold = (ctx && ctx.cold) || 0;
    const bits = [];
    if (!s.settings.platformBlockEnabled) {
      bits.push('blocking is paused — these wait until it is switched back on');
    } else {
      if (s.settings.platformBlockDryRun) bits.push('dry run — simulating, sending nothing');
      if (cold && globalThis.CB_MODE_OF(s.settings) === 'passive') {
        bits.push(cold + ' from the list — paused by passive mode');
      } else if (ctx && ctx.needsTab) {
        bits.push(cold + ' from the list need a Facebook or Threads tab open');
      }
    }
    $('queueNote').textContent = bits.join(' · ');

    for (const e of entries.slice(0, 100)) {
      const key = e.platform + ':' + e.id;
      const cool = cooldowns[key] && cooldowns[key] > now ? cooldowns[key] - now : 0;
      const meta = (s.blocklist && (s.blocklist.targets || []).find(t => String(t.id) === String(e.id))) || {};
      host.appendChild(row(
        nameFor(e.id, e.platform) || 'profile ' + e.id,
        reasonFor({ warm: e.warm, rank: e.rank, why: meta.why }),
        [
          chip(e.platform, 'plat'),
          chip(e.warm ? 'seen on screen' : 'suggested', e.warm ? 'warm' : 'cold'),
          cool ? chip('retry in ' + inMs(cool), 'warn') : null,
          failures[key] ? chip(failures[key] + ' failed tries', 'bad') : null
        ]));
    }
    if (entries.length > 100) {
      host.appendChild(el('p', 'note', '… and ' + (entries.length - 100) + ' more'));
    }
  }

  function renderLog(s) {
    const host = $('logRows');
    host.textContent = '';
    let log = s.blockLog || [];
    if (filter === 'ok') log = log.filter(e => e.ok && !e.dryRun);
    if (filter === 'failed') log = log.filter(e => !e.ok);
    if (filter === 'dry') log = log.filter(e => e.dryRun);

    $('logEmpty').classList.toggle('hidden', log.length > 0);

    for (const e of log.slice(0, 200)) {
      host.appendChild(row(
        nameFor(e.id, e.platform) || 'profile ' + e.id,
        reasonFor(e) + (e.detail ? ' — ' + e.detail : ''),
        [
          chip(e.platform, 'plat'),
          e.dryRun ? chip('dry run', 'dry')
            : e.ok ? chip('blocked', 'ok') : chip('failed', 'bad'),
          chip(ago(e.at), 'time')
        ]));
    }
  }

  async function render() {
    const s = await sw(P.SW.GET_STATE);
    if (!s.ok) { $('banner').textContent = s.error; $('banner').className = 'banner err'; return; }
    state = s;
    // The one condition both the banner and the queue note turn on: work that
    // only an open Facebook or Threads tab can carry out, and no such tab.
    const cold = coldQueued(s);
    const needsTab = !!s.settings.platformBlockEnabled &&
      globalThis.CB_MODE_OF(s.settings) === 'active' &&
      cold > 0 && !(await siteTabOpen());
    renderBanner(s.stats || {}, needsTab, cold);
    renderTiles(s);
    renderSync(s);
    renderQueue(s, { cold, needsTab });
    renderLog(s);
  }

  for (const b of document.querySelectorAll('.chipbtn')) {
    b.addEventListener('click', () => {
      document.querySelectorAll('.chipbtn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      filter = b.dataset.f;
      renderLog(state || {});
    });
  }

  $('refresh').addEventListener('click', async () => {
    $('refresh').disabled = true;
    $('refresh').textContent = 'Refreshing…';
    await sw(P.SW.REFRESH_NOW);
    $('refresh').disabled = false;
    $('refresh').textContent = 'Refresh now';
    render();
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  render();
  // The queue drains on its own timers; keep the page honest while it is open.
  setInterval(render, 15000);
  // Opening or closing a Facebook tab changes what this page should say
  // without changing anything in the queue, so watch that end too rather than
  // leaving a stale banner up for another quarter of a minute. Coalesced:
  // restoring a window fires this once per tab.
  try {
    let pending = null;
    const soon = () => { clearTimeout(pending); pending = setTimeout(render, 400); };
    chrome.tabs.onRemoved.addListener(soon);
    chrome.tabs.onUpdated.addListener((id, ch) => { if (ch && ch.url) soon(); });
  } catch (e) { /* the page is still correct without it, just slower */ }
})();
