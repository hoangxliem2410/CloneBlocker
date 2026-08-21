/**
 * Options page: the mode picker, blocklist status, and everything else folded
 * into Advanced.
 *
 * The page used to open on a text field asking for a server endpoint, which is
 * a question a new user has no way to answer. The address is baked into
 * protocol.js now, so the first thing here is the only real decision: how hard
 * the extension should work.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const KEYS = globalThis.CB_KEYS;
  const modeOf = globalThis.CB_MODE_OF;
  const $ = (id) => document.getElementById(id);

  // Fields that map straight onto a settings key of the same name. Two things
  // deliberately stay out: `mode` (a pair of radios, not one input) and
  // `platformBlockEnabled` (shown inverted, as "Pause blocking").
  const TEXT_FIELDS = ['apiBase', 'submitToken'];
  const NUM_FIELDS = ['maxBlocksPerHour', 'maxBlocksPerDay',
    'minDelayMs', 'maxDelayMs', 'maxColdBlocksPerHour', 'targetBudget',
    'warmMinDelayMs', 'warmMaxDelayMs'];
  const BOOL_FIELDS = ['shareRegion',
    'hideEnabled', 'hideFeedPosts', 'hideComments',
    'platformBlockDryRun', 'allowRawNetworkFallback',
    'reportUiEnabled', 'debug'];
  const SELECT_FIELDS = ['hideMode'];

  // `blockTags` is none of the above: an array of tags, rendered as one
  // checkbox per tag and read back as the list of ticked ones.
  const TAGS = globalThis.CB_TAGS || [];
  const TAG_LABELS = globalThis.CB_TAG_LABELS || {};

  function sw(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(res || { ok: false, error: 'no response' });
      });
    });
  }

  function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /**
   * The "which kinds get blocked" boxes, built from the shared tag list.
   *
   * Generated rather than written into the HTML because protocol.js is where
   * the vocabulary lives; a hand-written copy here would be the one that
   * forgets a category the day one is added. Insertion order is TAGS order, so
   * the boxes read in the same order as the report sheet's reasons.
   */
  const tagInputs = new Map();
  for (const tag of TAGS) {
    const label = document.createElement('label');
    label.className = 'toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'blockTag_' + tag;
    const text = document.createElement('span');
    text.textContent = TAG_LABELS[tag] || tag;
    label.appendChild(box);
    label.appendChild(text);
    $('blockTags').appendChild(label);
    tagInputs.set(tag, box);
  }

  /** Ticking none of them is a real choice, but a silent one. Say it out loud. */
  function renderTagNote() {
    const none = [...tagInputs.values()].every(b => !b.checked);
    $('blockTagsNote').classList.toggle('hidden', !none);
  }

  async function load() {
    const res = await sw(P.SW.GET_SETTINGS);
    const s = (res && res.settings) || {};
    for (const f of TEXT_FIELDS) $(f).value = s[f] || '';
    for (const f of NUM_FIELDS) $(f).value = s[f] != null ? s[f] : '';
    for (const f of BOOL_FIELDS) $(f).checked = !!s[f];
    for (const f of SELECT_FIELDS) if (s[f]) $(f).value = s[f];

    // modeOf tolerates installs written before modes existed, so the picker
    // agrees with what the service worker will actually do.
    const mode = modeOf(s);
    $('modePassive').checked = mode === 'passive';
    $('modeActive').checked = mode === 'active';

    // Inverted on purpose: the switch means "blocking is on", the control means
    // "pause it". Only an explicit false counts as paused, so a settings object
    // missing the key reads as running, exactly like the default.
    $('pauseBlocking').checked = s.platformBlockEnabled === false;
    renderPaused();

    // An install written before this setting existed blocks every kind, which
    // is exactly what it did then. An empty array is a deliberate "block
    // nothing", so it is not treated as missing.
    const chosen = Array.isArray(s.blockTags) ? s.blockTags : TAGS;
    for (const [tag, box] of tagInputs) box.checked = chosen.includes(tag);
    renderTagNote();

    await refreshList();
    await refreshDiag();
    await refreshLearnedStatus();
  }

  async function save() {
    const patch = {};
    for (const f of TEXT_FIELDS) patch[f] = $(f).value.trim();
    for (const f of NUM_FIELDS) {
      const n = parseInt($(f).value, 10);
      if (!Number.isNaN(n)) patch[f] = n;
    }
    for (const f of BOOL_FIELDS) patch[f] = $(f).checked;
    for (const f of SELECT_FIELDS) patch[f] = $(f).value;

    patch.mode = $('modeActive').checked ? 'active' : 'passive';
    patch.platformBlockEnabled = !$('pauseBlocking').checked;
    // Filtered through TAGS so the stored array is always vocabulary, in
    // vocabulary order, whatever the DOM happens to contain.
    patch.blockTags = TAGS.filter(t => tagInputs.get(t).checked);

    // Keep the delay range coherent rather than letting it invert.
    if (patch.maxDelayMs <= patch.minDelayMs) patch.maxDelayMs = patch.minDelayMs + 5000;

    await sw(P.SW.SET_SETTINGS, patch);
    renderPaused();
    renderTagNote();
  }

  for (const f of TEXT_FIELDS.concat(NUM_FIELDS)) {
    $(f).addEventListener('change', save);
  }
  for (const f of BOOL_FIELDS.concat(SELECT_FIELDS)) {
    $(f).addEventListener('change', save);
  }
  for (const f of ['modePassive', 'modeActive', 'pauseBlocking']) {
    $(f).addEventListener('change', save);
  }
  for (const box of tagInputs.values()) box.addEventListener('change', save);

  /**
   * Pause lives in Advanced, so on a collapsed page the mode picker would
   * otherwise claim work is happening while nothing is. Say so where the claim
   * is made.
   */
  function renderPaused() {
    $('pausedNote').classList.toggle('hidden', !$('pauseBlocking').checked);
  }

  // -- blocklist status ------------------------------------------------------
  async function refreshList() {
    const state = await sw(P.SW.GET_STATE);
    const bl = state && state.ok && state.blocklist;
    if (!bl) {
      $('listSynced').textContent = 'never';
      $('listCounts').textContent = 'not loaded yet';
      return;
    }
    $('listSynced').textContent = ago(bl.fetchedAt);
    $('listSynced').title = bl.fetchedAt ? new Date(bl.fetchedAt).toLocaleString() : '';
    $('listCounts').textContent =
      `${plural(bl.ids.length, 'profile id')} · ${plural(bl.usernames.length, 'username')}`;
  }

  $('refreshList').addEventListener('click', async () => {
    setStatus($('listStatus'), 'Checking…');
    const res = await sw(P.SW.REFRESH_NOW);
    setStatus($('listStatus'),
      res.ok ? (res.unchanged ? 'Already up to date' : 'Updated') : (res.error || 'failed'),
      res.ok ? 'ok' : 'bad');
    await refreshList();
    refreshDiag();
  });

  // -- actions --------------------------------------------------------------
  $('clearLearned').addEventListener('click', async () => {
    await chrome.storage.local.remove(['learnedTemplate_facebook', 'learnedTemplate_threads']);
    setStatus($('learnedStatus'), 'Cleared', 'ok');
    refreshLearnedStatus();
  });

  $('resetQueue').addEventListener('click', async () => {
    await chrome.storage.local.remove([KEYS.QUEUE, KEYS.DONE, KEYS.STATS, 'leases']);
    try { await chrome.action.setBadgeText({ text: '' }); } catch (e) { /* ignore */ }
    refreshDiag();
  });

  $('refreshDiag').addEventListener('click', refreshDiag);


  async function refreshLearnedStatus() {
    const got = await chrome.storage.local.get(['learnedTemplate_facebook', 'learnedTemplate_threads']);
    const parts = [];
    for (const p of ['facebook', 'threads']) {
      const t = got['learnedTemplate_' + p];
      if (t) parts.push(`${p}: ${t.friendlyName || t.url}`);
    }
    setStatus($('learnedStatus'), parts.length ? parts.join(' · ') : 'none captured yet',
      parts.length ? 'ok' : '');
  }

  /**
   * Page capability, read from a real tab.
   *
   * This used to occupy a quarter of the popup -- Bridge, Relay store, Block
   * mutation, doc_ids -- which is diagnostics, not something anyone acts on.
   * The options page cannot use the active tab (that is this page), so it
   * looks for the first supported tab that is open.
   */
  async function pageCapability() {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({
        url: ['*://*.facebook.com/*', '*://*.threads.net/*', '*://*.threads.com/*']
      });
    } catch (e) { return { error: String((e && e.message) || e) }; }
    const tab = tabs && tabs[0];
    if (!tab) return 'no Facebook or Threads tab open';
    const status = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'tab:status' }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res || null);
      });
    });
    if (!status) return 'tab is open but the content script did not answer -- reload it';

    const cap = status.capability || {};
    const cands = cap.blockMutationCandidates || [];
    return {
      tab: tab.url ? tab.url.slice(0, 90) : null,
      platform: status.platform,
      bridge: status.handshake ? 'connected' : 'not connected',
      signedInAs: status.viewerId || 'signed out',
      relayStore: cap.hasRelay ? `${cap.relayEnv} (${cap.relayRecords} records)` : 'unavailable',
      blockMutation: cands.length
        ? (cands[0].params ? `${cands[0].params.name} (doc_id ${cands[0].params.id})` : cands[0].name)
        : (cap.hasLearnedTemplate ? 'learned from a captured request' : 'not loaded on this page yet'),
      hiddenOnPage: status.dom ? status.dom.hidden : null,
      profile: status.profile || null
    };
  }

  async function refreshDiag() {
    const state = await sw(P.SW.GET_STATE);
    if (!state.ok) { $('diag').textContent = state.error || 'unavailable'; return; }
    const bl = state.blocklist;
    const view = {
      mode: modeOf(state.settings || {}),
      blocklist: bl ? {
        ids: bl.ids.length,
        usernames: bl.usernames.length,
        fetchedAt: new Date(bl.fetchedAt).toLocaleString(),
        etag: bl.etag,
        source: bl.source
      } : null,
      queue: Object.fromEntries(Object.entries(state.queue || {}).map(([k, v]) => [k, v.length])),
      blocked: Object.fromEntries(Object.entries(state.done || {}).map(([k, v]) => [k, v.length])),
      stats: state.stats || {}
    };
    if (view.stats.blockTimes) {
      view.stats.blocksLastHour = view.stats.blockTimes.filter(t => Date.now() - t < 3600e3).length;
      view.stats.blocksLast24h = view.stats.blockTimes.length;
      delete view.stats.blockTimes;
    }
    if (view.stats.pausedUntil) {
      view.stats.pausedUntil = new Date(view.stats.pausedUntil).toLocaleString();
    }
    view.page = await pageCapability();
    $('diag').textContent = JSON.stringify(view, null, 2);
  }

  document.getElementById('openActivity').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('src/activity/activity.html') });
  });

  load();
})();
