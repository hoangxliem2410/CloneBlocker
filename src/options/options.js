/** Options page: settings, host-permission grant, and diagnostics. */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const KEYS = globalThis.CB_KEYS;
  const $ = (id) => document.getElementById(id);

  const TEXT_FIELDS = ['listUrl', 'listAuthHeader', 'apiBase', 'submitToken'];
  const NUM_FIELDS = ['refreshMinutes', 'maxBlocksPerHour', 'maxBlocksPerDay',
    'minDelayMs', 'maxDelayMs', 'maxColdBlocksPerHour', 'targetBudget',
    'warmMinDelayMs', 'warmMaxDelayMs'];
  const BOOL_FIELDS = ['acceptServerTargets', 'shareRegion',
    'hideEnabled', 'hideFeedPosts', 'hideComments',
                       'platformBlockEnabled', 'platformBlockDryRun',
                       'allowRawNetworkFallback', 'reportUiEnabled', 'debug'];
  const SELECT_FIELDS = ['hideMode'];

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

  async function load() {
    const res = await sw(P.SW.GET_SETTINGS);
    const s = (res && res.settings) || {};
    for (const f of TEXT_FIELDS) $(f).value = s[f] || '';
    for (const f of NUM_FIELDS) $(f).value = s[f] != null ? s[f] : '';
    for (const f of BOOL_FIELDS) $(f).checked = !!s[f];
    for (const f of SELECT_FIELDS) if (s[f]) $(f).value = s[f];
    await refreshPermStatus();
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

    // Keep the delay range coherent rather than letting it invert.
    if (patch.maxDelayMs <= patch.minDelayMs) patch.maxDelayMs = patch.minDelayMs + 5000;

    await sw(P.SW.SET_SETTINGS, patch);
  }

  for (const f of TEXT_FIELDS.concat(NUM_FIELDS)) {
    $(f).addEventListener('change', save);
  }
  for (const f of BOOL_FIELDS.concat(SELECT_FIELDS)) {
    $(f).addEventListener('change', save);
  }

  // -- host permission ------------------------------------------------------
  function originOf(url) {
    try { return new URL(url).origin + '/*'; } catch (e) { return null; }
  }

  async function refreshPermStatus() {
    const url = $('listUrl').value.trim();
    const origin = originOf(url);
    if (!origin) { setStatus($('permStatus'), ''); return; }
    const has = await chrome.permissions.contains({ origins: [origin] });
    setStatus($('permStatus'),
      has ? `Access granted for ${origin}` : `Access not granted for ${origin} — click Grant access`,
      has ? 'ok' : 'bad');
  }

  $('listUrl').addEventListener('change', refreshPermStatus);

  $('grant').addEventListener('click', async () => {
    const origin = originOf($('listUrl').value.trim());
    if (!origin) { setStatus($('permStatus'), 'Enter a valid URL first', 'bad'); return; }
    // Must be called from inside a user gesture, which this click is.
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [origin] }); }
    catch (e) { setStatus($('permStatus'), String(e && e.message), 'bad'); return; }
    setStatus($('permStatus'),
      granted ? `Access granted for ${origin}` : 'Permission denied',
      granted ? 'ok' : 'bad');
  });

  // -- actions --------------------------------------------------------------
  $('testFetch').addEventListener('click', async () => {
    await save();
    setStatus($('fetchStatus'), 'Fetching…');
    const res = await sw(P.SW.REFRESH_NOW);
    if (res.ok) {
      const bl = res.blocklist || {};
      setStatus($('fetchStatus'),
        `OK — ${(bl.ids || []).length} ids, ${(bl.usernames || []).length} usernames` +
        (res.unchanged ? ' (unchanged)' : ''), 'ok');
    } else {
      setStatus($('fetchStatus'), res.error || 'failed', 'bad');
    }
    refreshDiag();
  });

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

  load();
})();
