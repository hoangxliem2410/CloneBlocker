/**
 * Popup: what you can do about the profile in front of you.
 *
 * This used to be a status readout with the master switches and a Page
 * capability panel attached -- Bridge, Relay store, Block mutation, doc_ids.
 * All of that is diagnostics, it belongs in Settings, and it crowded out the
 * only two things anyone opens this popup to do: report the profile they are
 * looking at, or block it. Those are now the first thing in the window, named
 * after the actual profile.
 */
(function () {
  'use strict';

  const P = globalThis.TQ_PROTOCOL;
  const $ = (id) => document.getElementById(id);
  const show = (id, on) => $(id).classList.toggle('hidden', !on);

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

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !/facebook\.com|threads\.(net|com)/.test(tab.url || '')) return null;
    return tab;
  }

  async function tabStatus(tab) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'tab:status' }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res || null);
      });
    });
  }

  /** The label for whoever this page is about. */
  function nameOf(profile) {
    if (!profile) return null;
    if (profile.username) return '@' + profile.username;
    if (profile.profileId) return 'profile ' + profile.profileId;
    return null;
  }

  let current = { tab: null, profile: null, platform: null };

  async function render() {
    const state = await sw(P.SW.GET_STATE);
    const settings = (state && state.settings) || {};
    const stats = (state && state.stats) || {};
    const bl = state && state.blocklist;

    $('hideEnabled').checked = settings.hideEnabled !== false;
    $('listLine').textContent = bl
      ? `${bl.ids.length + bl.usernames.length} on your list · ${ago(bl.fetchedAt)}`
      : 'list not loaded';

    const tab = await activeTab();
    current.tab = tab;
    if (!tab) {
      $('platform').textContent = 'not a supported site';
      $('who').textContent = 'Not on Facebook or Threads';
      $('whoState').textContent = '';
      $('whoState').className = 'state';
      show('reportProfile', false);
      show('blockProfile', false);
      $('actionNote').textContent = 'Open a Facebook or Threads profile to report or block it.';
      $('hiddenCount').textContent = '—';
      $('blockingNote').textContent = '';
      show('blockError', false);
      return;
    }

    const status = await tabStatus(tab);
    current.platform = (status && status.platform) || null;
    $('platform').textContent = current.platform || 'loading…';
    $('hiddenCount').textContent = status && status.dom ? String(status.dom.hidden) : '—';

    if (!status) {
      $('who').textContent = 'Page not ready';
      $('whoState').textContent = '';
      $('whoState').className = 'state';
      show('reportProfile', false);
      show('blockProfile', false);
      $('actionNote').textContent = 'Reload the page and open this again.';
      return;
    }

    renderPage(status, settings);
    renderBlockingNote(state, settings, stats, status);
  }

  /** The action card: who this is, and the one or two things to do about it. */
  function renderPage(status, settings) {
    const profile = status.profile || null;
    current.profile = profile;
    const label = nameOf(profile);

    if (!label) {
      $('who').textContent = 'No profile on this page';
      $('whoState').textContent = '';
      $('whoState').className = 'state';
      show('reportProfile', false);
      show('blockProfile', false);
      $('actionNote').textContent =
        'Open someone’s profile, or hover any name in the feed and use the Report chip.';
      return;
    }

    $('who').textContent = label;

    if (profile.isViewer) {
      $('whoState').textContent = 'This is you';
      $('whoState').className = 'state you';
      show('reportProfile', false);
      show('blockProfile', false);
      $('actionNote').textContent = '';
      return;
    }

    if (profile.listed) {
      $('whoState').textContent = 'On your blocklist';
      $('whoState').className = 'state listed';
    } else {
      $('whoState').textContent = 'Not on your blocklist';
      $('whoState').className = 'state clear';
    }

    show('reportProfile', true);
    $('reportProfile').textContent = profile.listed
      ? 'Report again' : 'Report as a clone';

    // Blocking needs a numeric target, and blocking someone whose profile is
    // open is the cheap case -- so this offer is only made when it can
    // actually be honoured.
    const canBlock = settings.platformBlockEnabled && !!profile.profileId;
    show('blockProfile', canBlock);
    if (canBlock) {
      $('blockProfile').textContent = 'Block now';
      $('blockProfile').disabled = false;
    }

    // Only say something that is true of *this* profile. "Blocking is off, so
    // it is only hidden" is misleading for someone who is not on the list at
    // all -- they are not being hidden either.
    if (settings.platformBlockEnabled && !profile.profileId) {
      $('actionNote').textContent =
        'Blocking needs this profile’s numeric ID, which the page has not revealed yet. ' +
        'Scroll the profile once, or report it and let the server resolve it.';
    } else if (!settings.platformBlockEnabled && profile.listed) {
      $('actionNote').textContent =
        'Platform blocking is off, so this profile is hidden but not blocked.';
    } else {
      $('actionNote').textContent = '';
    }
  }

  /** One line about the background queue, and any failure worth showing. */
  function renderBlockingNote(state, settings, stats, status) {
    const queued = state && state.queue
      ? Object.keys(state.queue).reduce((n, k) => n + ((state.queue[k] || []).length), 0) : 0;
    // A checkpoint pause is otherwise invisible: blocking silently stops and
    // the extension just looks broken, so say so plainly.
    const pausedFor = stats.pausedUntil && stats.pausedUntil > Date.now()
      ? Math.ceil((stats.pausedUntil - Date.now()) / 60000) : 0;

    if (pausedFor) {
      $('blockingNote').textContent =
        `Blocking paused for ${pausedFor > 90 ? Math.ceil(pausedFor / 60) + 'h' : pausedFor + 'm'}` +
        (stats.halted ? ' after an account checkpoint. Resolve it on the site, then use ' +
                        'Reset queue & stats in Settings.' : ' by rate limiting.');
    } else if (settings.platformBlockEnabled && queued) {
      $('blockingNote').textContent = `${queued} waiting to be blocked, paced in the background.`;
    } else {
      $('blockingNote').textContent = '';
    }

    // A recorded failure is only worth showing while it is still true. A
    // signed-out complaint is plainly stale once the page reports a viewer,
    // and anything older than the last hour is history rather than status.
    const err = stats.lastError;
    const staleSignedOut = err && /Signed out of the site/.test(err) && status.viewerId;
    const old = stats.lastErrorAt && (Date.now() - stats.lastErrorAt) > 3600 * 1000;
    if (err && !staleSignedOut && !old) {
      $('blockError').textContent = stats.lastErrorAt
        ? `${err}  (${ago(stats.lastErrorAt)})` : err;
      show('blockError', true);
    } else {
      show('blockError', false);
    }
  }

  // -- actions ---------------------------------------------------------------

  $('hideEnabled').addEventListener('change', async () => {
    await sw(P.SW.SET_SETTINGS, { hideEnabled: $('hideEnabled').checked });
    render();
  });

  // Reporting has to happen in the page: the report sheet is rendered by the
  // content script, which is what knows the profile's identity. The popup just
  // asks, then gets out of the way so the sheet is visible.
  $('reportProfile').addEventListener('click', () => {
    if (!current.tab) return;
    chrome.tabs.sendMessage(current.tab.id, { type: 'tab:report-current' }, (res) => {
      if (chrome.runtime.lastError) {
        $('actionNote').textContent = 'Reload the page and try again.';
        return;
      }
      if (!res || !res.ok) {
        $('actionNote').textContent = (res && res.error) || 'Could not identify a profile here.';
        return;
      }
      window.close();
    });
  });

  $('blockProfile').addEventListener('click', async () => {
    const p = current.profile;
    if (!p || !p.profileId || !current.platform) return;
    $('blockProfile').disabled = true;
    $('blockProfile').textContent = 'Queueing…';
    // warm: this profile is on screen right now, which is the pattern the
    // platform finds unremarkable, so it is paced normally rather than being
    // held to the cold ceiling.
    const res = await sw(P.SW.ENQUEUE_PLATFORM_BLOCK, {
      platform: current.platform, ids: [p.profileId], warm: true
    });
    if (res && res.ok !== false) {
      $('blockProfile').textContent = 'Queued';
      $('actionNote').textContent = 'Queued — it goes out in the next few seconds.';
    } else {
      $('blockProfile').disabled = false;
      $('blockProfile').textContent = 'Block now';
      $('actionNote').textContent = (res && res.error) || 'Could not queue that block.';
    }
  });

  $('refresh').addEventListener('click', async (e) => {
    e.preventDefault();
    $('listLine').textContent = 'refreshing…';
    const res = await sw(P.SW.REFRESH_NOW);
    if (!res.ok) $('listLine').textContent = res.error || 'refresh failed';
    render();
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  render();
})();
