/** Popup: live status for the active tab plus the two master switches. */
(function () {
  'use strict';

  const P = globalThis.TQ_PROTOCOL;
  const $ = (id) => document.getElementById(id);

  function sw(type, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      // A service worker that keeps the port open but never responds would
      // otherwise hang the popup with no feedback at all.
      setTimeout(() => done({ ok: false, error: 'service worker did not respond' }), 10000);
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) { done({ ok: false, error: chrome.runtime.lastError.message }); return; }
        done(res || { ok: false, error: 'no response' });
      });
    });
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  async function activeTabStatus() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !/facebook\.com|threads\.(net|com)/.test(tab.url || '')) return null;
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'tab:status' }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res || null);
      });
    });
  }

  async function render() {
    const state = await sw(P.SW.GET_STATE);
    const settings = (state && state.settings) || {};
    const bl = state && state.blocklist;

    $('listCount').textContent = bl
      ? `${bl.ids.length} ids, ${bl.usernames.length} usernames`
      : 'not loaded';
    $('listAge').textContent = bl ? ago(bl.fetchedAt) : '—';

    const stats = (state && state.stats) || {};
    if (stats.lastError) {
      $('listError').textContent = stats.lastError;
      $('listError').classList.remove('hidden');
    } else {
      $('listError').classList.add('hidden');
    }

    $('hideEnabled').checked = settings.hideEnabled !== false;
    $('platformBlockEnabled').checked = !!settings.platformBlockEnabled;
    $('platformBlockDryRun').checked = settings.platformBlockDryRun !== false;

    const platform = (state && state.queue) ? Object.keys(state.queue) : [];
    const queued = platform.reduce((n, k) => n + ((state.queue[k] || []).length), 0);
    const doneCount = state && state.done
      ? Object.keys(state.done).reduce((n, k) => n + ((state.done[k] || []).length), 0) : 0;
    // A checkpoint pause is otherwise invisible: blocking silently stops and
    // the extension just looks broken, so say so plainly.
    const pausedFor = stats.pausedUntil && stats.pausedUntil > Date.now()
      ? Math.ceil((stats.pausedUntil - Date.now()) / 60000) : 0;
    if (pausedFor) {
      $('queueNote').textContent =
        `Paused for ${pausedFor > 90 ? Math.ceil(pausedFor / 60) + 'h' : pausedFor + 'm'}` +
        (stats.halted ? ' after an account checkpoint. Resolve it on the site, then use ' +
                        'Reset queue & stats in Settings.' : ' by rate limiting.');
    } else {
      $('queueNote').textContent = settings.platformBlockEnabled
        ? `${queued} queued · ${doneCount} blocked · ${stats.succeeded || 0} ok / ${stats.failed || 0} failed` +
          (stats.abandoned ? ` · ${stats.abandoned} gave up` : '')
        : 'Platform blocking is off — content is only hidden locally.';
    }

    // Per-tab capability.
    const tabStatus = await activeTabStatus();
    if (!tabStatus) {
      $('platform').textContent = 'not on a supported site';
      $('capBridge').textContent = '—';
      $('capNote').textContent = 'Open a Facebook or Threads tab to see page status.';
      return;
    }

    $('platform').textContent = tabStatus.platform;
    $('hiddenCount').textContent = tabStatus.dom ? String(tabStatus.dom.hidden) : '—';
    $('capBridge').textContent = tabStatus.handshake ? 'connected' : 'not connected';
    $('capViewer').textContent = tabStatus.viewerId || 'signed out';

    const cap = tabStatus.capability;
    if (!cap) {
      $('capRelay').textContent = 'probing…';
      $('capMutation').textContent = 'probing…';
      return;
    }
    $('capRelay').textContent = cap.hasRelay
      ? `${cap.relayEnv} (${cap.relayRecords} records)` : 'unavailable';

    const cands = cap.blockMutationCandidates || [];
    if (cands.length) {
      const top = cands[0];
      $('capMutation').textContent = top.params ? top.params.name : top.name;
      $('capNote').textContent = top.params
        ? `doc_id ${top.params.id} discovered at runtime.`
        : 'Module found but not yet evaluated.';
    } else if (cap.hasLearnedTemplate) {
      $('capMutation').textContent = 'learned from captured request';
      $('capNote').textContent = 'Using a request template captured from a real block.';
    } else {
      $('capMutation').textContent = 'not found yet';
      $('capNote').textContent =
        'Facebook loads the block mutation lazily. Open a profile and block one person ' +
        'manually — the extension captures that request and reuses its shape afterwards.';
    }
  }

  async function onToggle(id, key) {
    const el = $(id);
    el.addEventListener('change', async () => {
      await sw(P.SW.SET_SETTINGS, { [key]: el.checked });
      render();
    });
  }

  $('refresh').addEventListener('click', async () => {
    $('refresh').disabled = true;
    $('refresh').textContent = 'Refreshing…';
    const res = await sw(P.SW.REFRESH_NOW);
    $('refresh').disabled = false;
    $('refresh').textContent = 'Refresh list now';
    if (!res.ok) {
      $('listError').textContent = res.error || 'refresh failed';
      $('listError').classList.remove('hidden');
    } else {
      $('listError').classList.add('hidden');
    }
    render();
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Reporting has to happen in the page: the report sheet is rendered by the
  // content script, which is what knows the profile's identity. The popup just
  // asks, then gets out of the way so the sheet is visible.
  $('reportProfile').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !/facebook\.com|threads\.(net|com)/.test(tab.url || '')) {
      $('reportNote').textContent = 'Open a Facebook or Threads profile first.';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'tab:report-current' }, (res) => {
      if (chrome.runtime.lastError) {
        $('reportNote').textContent = 'Reload the page and try again.';
        return;
      }
      if (!res || !res.ok) {
        $('reportNote').textContent = (res && res.error) ||
          'Could not identify a profile on this page.';
        return;
      }
      window.close();
    });
  });

  onToggle('hideEnabled', 'hideEnabled');
  onToggle('platformBlockEnabled', 'platformBlockEnabled');
  onToggle('platformBlockDryRun', 'platformBlockDryRun');

  render();
})();
