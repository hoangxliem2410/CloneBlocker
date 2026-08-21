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
  const T = globalThis.CB_T;
  const $ = (id) => document.getElementById(id);

  function sw(type, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      setTimeout(() => done({ ok: false, error: T('common_workerSilent') }), 10000);
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) { done({ ok: false, error: chrome.runtime.lastError.message }); return; }
        done(res || { ok: false, error: T('common_noResponse') });
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

  /**
   * How many Facebook or Threads tabs are open, anywhere.
   *
   * The count, not a yes/no. "Nothing is moving because there is nowhere for
   * it to run" and "nothing looks like it is moving because six tabs are
   * sharing one block at a time" are the same picture from the outside and
   * opposite situations underneath, and only the number tells them apart.
   *
   * null means the lookup itself failed. A warning that might be wrong is
   * worse than no warning, so callers say nothing rather than guess.
   */
  async function siteTabCount() {
    try {
      const tabs = await chrome.tabs.query({ url: SITE_TAB_URLS });
      return (tabs || []).length;
    } catch (e) {
      return null;
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
    if (!ts) return T('time_never');
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return T('time_secondsAgo', s);
    if (s < 3600) return T('time_minutesAgo', Math.floor(s / 60));
    if (s < 86400) return T('time_hoursAgo', Math.floor(s / 3600));
    return T('time_daysAgo', Math.floor(s / 86400));
  }
  const inMs = (ms) => ms < 60000
    ? T('time_seconds', Math.ceil(ms / 1000))
    : T('time_minutes', Math.ceil(ms / 60000));

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
   * What kind of account this is, when the published list says.
   *
   * Two places know: the ranked target record, and the flat `idTags` map that
   * covers every published id including the ones no target record was kept
   * for. Nothing is shown when neither knows -- a chip reading "Something
   * else" on every row of a list published before tags existed would be
   * inventing a verdict nobody reached.
   */
  function tagFor(id) {
    const bl = state && state.blocklist;
    if (!bl) return null;
    const t = (bl.targets || []).find(x => String(x.id) === String(id));
    const tag = (t && t.tag) || (bl.idTags || {})[String(id)] || null;
    return (globalThis.CB_TAGS || []).includes(tag) ? tag : null;
  }

  /** The tag chip for a target, or nothing at all. */
  function tagChip(id) {
    const tag = tagFor(id);
    return tag ? chip((globalThis.CB_TAG_LABELS || {})[tag] || tag, 'tag') : null;
  }

  /**
   * The honest reason line. A warm target is on the list AND was on screen;
   * a cold one was suggested by the published trending metadata, and its
   * `why` says with what force.
   */
  function reasonFor(entry) {
    const bits = [];
    if (entry.warm) {
      bits.push(T('activity_reasonWarm'));
    } else {
      bits.push(T('activity_reasonSuggested'));
      const w = entry.why;
      if (w) {
        if (w.velocity7d) bits.push(T('activity_reasonVelocity', w.velocity7d));
        if (w.recentDays === 0) bits.push(T('activity_reasonToday'));
        else if (w.recentDays != null && w.recentDays <= 7) bits.push(T('activity_reasonDaysAgo', w.recentDays));
        if (w.region >= 0.5) bits.push(T('activity_reasonNearYou'));
      }
      if (entry.rank != null) bits.push(T('activity_reasonRank', entry.rank));
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
   * do nothing about from here, so those win. Then a recent failure. Then the
   * two ways work can be going nowhere with nothing visibly wrong: both
   * switches off, and no tab anywhere to run a block in.
   *
   * Note what is NOT here any more. A queue that is not moving because six
   * tabs are sharing one block at a time is not a stall and gets no banner --
   * the queue note says "paced" and names the tabs. The banner is for the
   * cases where nothing will happen until the reader does something.
   */
  function renderBanner(stats, ctx) {
    const b = $('banner');
    const pausedFor = stats.pausedUntil && stats.pausedUntil > Date.now()
      ? stats.pausedUntil - Date.now() : 0;
    const err = stats.lastError;
    const oldErr = stats.lastErrorAt && (Date.now() - stats.lastErrorAt) > 3600 * 1000;
    if (pausedFor) {
      // Whole sentences, both of them, rather than one stem with the resume
      // time bolted on: where "resumes in" belongs relative to the rest is a
      // question only the translation can answer.
      b.textContent = T(stats.halted ? 'activity_haltedResumes' : 'activity_pausedResumes',
        inMs(pausedFor));
      b.className = 'banner warn';
    } else if (err && !oldErr) {
      b.textContent = err + (stats.lastErrorAt ? '  (' + ago(stats.lastErrorAt) + ')' : '');
      b.className = 'banner err';
    } else if (ctx.nothingOn) {
      b.textContent = T('activity_bannerNothingOn');
      b.className = 'banner warn';
    } else if (ctx.needsTab) {
      // One message per case rather than a count spliced into a sentence: the
      // singular and the plural of this differ by more than an 's' in English
      // and by nothing at all in Vietnamese, and neither fits a fragment.
      b.textContent = ctx.actionable === 1
        ? T('activity_needsTabOne') : T('activity_needsTabMany', ctx.actionable);
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
      add(T('activity_syncSource'), T('activity_noList'));
    } else {
      let src = bl.source || '';
      try { src = new URL(bl.source).host + new URL(bl.source).pathname; } catch (e) {}
      add(T('activity_syncSource'), src);
      // The etag is a Firestore updateTime (an ISO instant) or a CDN hash;
      // show the one as a time and the other as a short fingerprint.
      const tag = String(bl.etag || '').replace(/"/g, '');
      const ver = !tag ? '' : /^\d{4}-\d{2}-\d{2}T/.test(tag)
        ? T('activity_listUpdated', tag.slice(0, 16).replace('T', ' '))
        : T('activity_listVersion', tag.slice(0, 10));
      add(T('activity_syncLastSynced'), ago(bl.fetchedAt) + (ver ? '  ·  ' + ver : ''));
      add(T('activity_syncHideList'),
        T('activity_hideListValue', bl.ids.length, bl.usernames.length));
      add(T('activity_syncBlockTargets'), bl.targetsAvailable
        ? T('activity_targetsTaken', (bl.targets || []).length, bl.targetsAvailable)
        : String((bl.targets || []).length));
      if ((bl.pending || []).length) {
        add(T('activity_syncAwaitingReview'), T('activity_awaitingReviewValue', bl.pending.length));
      }
    }
    add(T('activity_syncRefreshEvery'), T('activity_refreshEveryValue', s.settings.refreshMinutes || 60));
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
    $('tFailed').textContent = stats.abandoned
      ? T('activity_failedGaveUp', stats.failed || 0, stats.abandoned)
      : String(stats.failed || 0);
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

    // Why nothing is moving, when nothing is moving -- and, just as much, why
    // it IS moving when it looks like it is not. A switched-off list, a
    // missing tab and a queue being drained one block at a time all look
    // identical from the outside: rows that sit there. Only one of the three
    // is fixed by opening a tab, and the third is not a fault at all.
    const bits = [];
    if (!s.settings.platformBlockEnabled) {
      bits.push(T('activity_queuePaused'));
    } else if (ctx.nothingOn) {
      bits.push(T('activity_queueNothingOn'));
    } else {
      if (s.settings.platformBlockDryRun) bits.push(T('activity_queueDryRun'));
      if (ctx.cold && !ctx.modes.fromList) {
        bits.push(ctx.cold === 1
          ? T('activity_queueListOffOne') : T('activity_queueListOffMany', ctx.cold));
      }
      if (ctx.actionable && ctx.tabs === 0) {
        bits.push(ctx.actionable === 1
          ? T('activity_queueNoTabOne') : T('activity_queueNoTabMany', ctx.actionable));
      } else if (ctx.actionable && ctx.tabs > 0) {
        // Said out loud because the alternative is a user opening five tabs to
        // go five times faster and never finding out that the gate is one
        // block at a time for the whole browser, on purpose.
        bits.push(ctx.tabs === 1
          ? T('activity_queuePacedOne') : T('activity_queuePacedMany', ctx.tabs));
      }
    }
    $('queueNote').textContent = bits.join(' · ');

    for (const e of entries.slice(0, 100)) {
      const key = e.platform + ':' + e.id;
      const cool = cooldowns[key] && cooldowns[key] > now ? cooldowns[key] - now : 0;
      const meta = (s.blocklist && (s.blocklist.targets || []).find(t => String(t.id) === String(e.id))) || {};
      host.appendChild(row(
        nameFor(e.id, e.platform) || T('common_profile', e.id),
        reasonFor({ warm: e.warm, rank: e.rank, why: meta.why }),
        [
          chip(e.platform, 'plat'),
          tagChip(e.id),
          chip(T(e.warm ? 'activity_chipSeen' : 'activity_chipSuggested'), e.warm ? 'warm' : 'cold'),
          cool ? chip(T('activity_chipRetryIn', inMs(cool)), 'warn') : null,
          failures[key] ? chip(T('activity_chipFailedTries', failures[key]), 'bad') : null
        ]));
    }
    if (entries.length > 100) {
      host.appendChild(el('p', 'note', T('activity_andMore', entries.length - 100)));
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
        nameFor(e.id, e.platform) || T('common_profile', e.id),
        reasonFor(e) + (e.detail ? ' — ' + e.detail : ''),
        [
          chip(e.platform, 'plat'),
          tagChip(e.id),
          e.dryRun ? chip(T('activity_chipDryRun'), 'dry')
            : e.ok ? chip(T('activity_chipBlocked'), 'ok') : chip(T('activity_chipFailed'), 'bad'),
          chip(ago(e.at), 'time')
        ]));
    }
  }

  async function render() {
    const s = await sw(P.SW.GET_STATE);
    if (!s.ok) { $('banner').textContent = s.error; $('banner').className = 'banner err'; return; }
    state = s;
    // The facts the banner and the queue note both read, worked out once.
    const cold = coldQueued(s);
    const total = Object.values(s.queue || {}).reduce((n, a) => n + a.length, 0);
    const modes = globalThis.CB_BLOCK_MODES(s.settings);
    const on = !!s.settings.platformBlockEnabled;
    const tabs = await siteTabCount();
    // Work an open tab could actually carry out. Cold targets are excluded
    // while the list is switched off: they are parked by a setting, and
    // telling their owner to open a tab would not move them.
    const actionable = total - (modes.fromList ? 0 : cold);
    const nothingOn = on && !modes.seen && !modes.fromList;
    // A genuine stall, as opposed to a paced queue: there is work, and
    // nowhere in the whole browser for it to run.
    const needsTab = on && !nothingOn && actionable > 0 && tabs === 0;
    const ctx = { cold, total, actionable, tabs, modes, nothingOn, needsTab };
    renderBanner(s.stats || {}, ctx);
    renderTiles(s);
    renderSync(s);
    renderQueue(s, ctx);
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
    $('refresh').textContent = T('activity_refreshing');
    await sw(P.SW.REFRESH_NOW);
    $('refresh').disabled = false;
    $('refresh').textContent = T('activity_refreshNow');
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
    chrome.tabs.onCreated.addListener(soon);
    chrome.tabs.onUpdated.addListener((id, ch) => { if (ch && ch.url) soon(); });
  } catch (e) { /* the page is still correct without it, just slower */ }
})();
