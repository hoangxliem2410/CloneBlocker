/**
 * Moderation dashboard, served by the server.
 *
 * This is the owner's tool, not the users'. It deliberately does not live in
 * the extension: shipping admin tooling inside a distributed extension would
 * put the admin token in every user's copy, and moderating should not require
 * the extension to be installed at all.
 *
 * Auth is a session cookie set by POST /admin/login. The cookie is HttpOnly, so
 * this script never handles the credential after sign-in — there is nothing for
 * a stray script or a browser extension to read back out of storage.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let currentStatus = 'pending';
  let rows = [];
  let blocklist = [];
  const selected = new Set();

  async function api(path, method, body) {
    let res, json = null;
    try {
      res = await fetch(path, {
        method: method || 'GET',
        headers: { 'content-type': 'application/json' },
        // The session cookie rides along; nothing is read from storage here.
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      json = await res.json();
    } catch (e) {
      return { ok: false, error: 'Request failed: ' + (e && e.message) };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, unauthorized: true, data: json,
               error: (json && json.error) || 'Not signed in' };
    }
    return { ok: res.ok, status: res.status, data: json };
  }

  function setConn(text, cls) {
    $('conn').textContent = text;
    $('conn').className = 'status' + (cls ? ' ' + cls : '');
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * A link, or nothing.
   *
   * Every URL here was typed by a stranger. The server rejects anything that is
   * not http(s) on the way in, but records predating that check are still in the
   * store, and one "javascript:" href in this page would run with the session
   * that is reviewing it. Checked again at the point of use.
   */
  function link(href, cls) {
    let u;
    try { u = new URL(href, location.origin); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const a = el('a', cls, href);
    a.href = u.href;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    return a;
  }

  // -- sign-in --------------------------------------------------------------
  function showGate(msg) {
    $('gate').classList.remove('hidden');
    $('app').classList.add('hidden');
    if (msg) { $('gateErr').hidden = false; $('gateErr').textContent = msg; }
  }
  function showApp() {
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
  }
  $('gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('gateErr').hidden = true;
    const out = await api('/admin/login', 'POST', {
      username: $('gateUser').value.trim(),
      password: $('gatePass').value
    });
    if (!out.ok) { showGate(out.error || 'Sign-in failed.'); return; }
    $('gatePass').value = '';
    showApp();
    refresh();
  });
  $('signout').addEventListener('click', async () => {
    await api('/admin/logout', 'POST', {});
    location.reload();
  });

  // -- tabs, filter, bulk ---------------------------------------------------
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentStatus = tab.dataset.status;
      selected.clear();
      refresh();
    });
  }
  $('refresh').addEventListener('click', refresh);
  $('filter').addEventListener('input', render);

  $('selectAll').addEventListener('change', (e) => {
    const visible = visibleRows();
    if (e.target.checked) visible.forEach(r => selected.add(r.key));
    else visible.forEach(r => selected.delete(r.key));
    render();
  });
  $('bulkApprove').addEventListener('click', () => bulk('approve'));
  $('bulkReject').addEventListener('click', () => bulk('reject'));

  async function bulk(decision) {
    if (!selected.size) return;
    const keys = Array.from(selected);
    $('bulkApprove').disabled = $('bulkReject').disabled = true;
    const out = await api('/admin/reports/decide', 'POST', { keys, decision, by: 'dashboard' });
    $('bulkApprove').disabled = $('bulkReject').disabled = false;
    if (!out.ok && !(out.data && out.data.decided)) {
      setConn(out.error || 'bulk action failed', 'bad');
      return;
    }
    selected.clear();
    refresh();
  }

  // -- stats ----------------------------------------------------------------
  function renderStats(d) {
    const r = d.reports || {};
    $('statPending').textContent = r.pending != null ? r.pending : '—';
    $('statApproved').textContent = r.approved != null ? r.approved : '—';
    $('statRejected').textContent = r.rejected != null ? r.rejected : '—';
    $('statSubmissions').textContent = r.totalSubmissions != null ? r.totalSubmissions : '—';
    $('statEvidence').textContent = r.withEvidence != null ? r.withEvidence : '—';
    const rp = d.reporters || {};
    $('statHeld').textContent = r.held != null ? r.held : '—';
    // The tile holds a number; the qualifier belongs in the label under it.
    $('statReporters').textContent = rp.known != null ? rp.known : '—';
    $('statReportersK').textContent = rp.distrusted
      ? `Reporters · ${rp.distrusted} distrusted` : 'Known reporters';
    const b = d.blocklist || {};
    $('statBlocked').textContent = (b.ids || 0) + (b.usernames || 0);

    // Sparkline scaled to the busiest day, so a quiet fortnight still reads.
    const spark = $('spark');
    spark.textContent = '';
    const days = d.perDay || [];
    const max = Math.max(1, ...days.map(x => x.count));
    for (const day of days) {
      const bar = el('div', 'bar');
      bar.style.height = Math.round((day.count / max) * 100) + '%';
      bar.title = day.day + ': ' + day.count + ' report' + (day.count === 1 ? '' : 's');
      spark.appendChild(bar);
    }

    bars($('byPlatform'), d.byPlatform || []);
    bars($('byReason'), d.byReason || []);
    bars($('topReporters'), d.topReporters || []);
  }

  function bars(host, pairs) {
    host.textContent = '';
    if (!pairs.length) { host.appendChild(el('div', 'note', 'No data yet.')); return; }
    const max = Math.max(...pairs.map(p => p[1]));
    for (const pair of pairs) {
      const row = el('div', 'barrow');
      row.appendChild(el('span', 'lbl', pair[0]));
      // A third element, when present, is the reporter's trust weight. Volume
      // alone flatters a mass-reporter; the weight is what separates them.
      row.appendChild(el('span', null,
        pair.length > 2 ? `${pair[1]}  ·  ${Number(pair[2]).toFixed(2)}` : String(pair[1])));
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      fill.style.width = Math.round((pair[1] / max) * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      host.appendChild(row);
    }
  }

  // -- data -----------------------------------------------------------------
  // -- trending matrix ------------------------------------------------------
  //
  // Regions down the side, days across, one cell per region-day. The point is
  // not precision: it is seeing at a glance that something is starting
  // somewhere, which is what decides whose clones get a block budget spent.
  function renderTrends(d) {
    const host = $('trendMatrix');
    host.textContent = '';
    const regions = d.regions || [];
    if (!regions.length) {
      host.appendChild(el('div', 'note', 'No regional data yet. Reports carry a region once clients update.'));
      return;
    }

    const peak = Math.max(1, ...d.matrix.map(row => Math.max(...row)));
    const table = el('div', 'matrix');

    // Header: the day column labels, thinned so they stay readable.
    const head = el('div', 'mrow head');
    head.appendChild(el('div', 'mlbl', ''));
    (d.days || []).forEach((day, i) => {
      const c = el('div', 'mcell lbl', i % 3 === 0 ? day.slice(5) : '');
      head.appendChild(c);
    });
    head.appendChild(el('div', 'mtot', 'total'));
    table.appendChild(head);

    regions.forEach((region, ri) => {
      const row = el('div', 'mrow');
      row.appendChild(el('div', 'mlbl', region));
      (d.matrix[ri] || []).forEach((n, ci) => {
        const cell = el('div', 'mcell', n ? String(n) : '');
        // Intensity, not a colour scale: one channel is enough to read a wave
        // and it survives both themes without a legend.
        cell.style.opacity = n ? String(0.25 + 0.75 * (n / peak)) : '0';
        cell.className = 'mcell' + (n ? ' on' : '');
        cell.title = `${region} · ${(d.days || [])[ci]} · ${n} report${n === 1 ? '' : 's'}`;
        row.appendChild(cell);
      });
      row.appendChild(el('div', 'mtot', String((d.totals || [])[ri] || 0)));
      table.appendChild(row);
    });
    host.appendChild(table);

    // Under it, what is actually driving each region.
    const top = $('trendTop');
    top.textContent = '';
    for (const region of regions.slice(0, 4)) {
      const col = el('div', 'tcol');
      col.appendChild(el('h3', null, region));
      const rows = (d.topByRegion || {})[region] || [];
      if (!rows.length) { col.appendChild(el('div', 'note', 'nothing recent')); }
      for (const r of rows) {
        const line = el('div', 'trow');
        line.appendChild(el('span', 'lbl',
          r.displayName || (r.username ? '@' + r.username : r.key)));
        line.appendChild(el('span', 'n', r.last7 + '/7d'));
        col.appendChild(line);
      }
      top.appendChild(col);
    }
  }

  async function refresh() {
    const stats = await api('/admin/stats');
    if (stats.unauthorized) { showGate('Your session has expired. Sign in again.'); return; }
    if (!stats.ok) { setConn(stats.error || 'Could not reach the server', 'bad'); return; }
    setConn('Connected', 'ok');
    renderStats(stats.data || {});

    const trends = await api('/admin/trends');
    if (trends.ok) renderTrends(trends.data || {});

    if (currentStatus === '__blocklist') {
      const res = await api('/admin/blocklist');
      blocklist = (res.data && res.data.entries) || [];
      rows = [];
    } else {
      const q = currentStatus ? '?status=' + encodeURIComponent(currentStatus) : '';
      const res = await api('/admin/reports' + q);
      if (!res.ok) { setConn(res.error || 'Could not load reports', 'bad'); return; }
      rows = (res.data && res.data.reports) || [];
      blocklist = [];
    }
    render();
  }

  function visibleRows() {
    const q = $('filter').value.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => [r.displayName, r.username, r.profileId, r.platform, r.reason, r.key]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }

  // -- rendering ------------------------------------------------------------
  function render() {
    const host = $('rows');
    host.textContent = '';

    if (currentStatus === '__blocklist') {
      $('bulkbar').classList.add('hidden');
      renderBlocklist(host);
      return;
    }
    const list = visibleRows();
    $('empty').classList.toggle('hidden', list.length > 0);
    $('bulkbar').classList.toggle('hidden', list.length === 0);
    $('selCount').textContent = selected.size + ' selected';
    for (const r of list) host.appendChild(reportRow(r));
  }

  function reportRow(r) {
    const box = el('div', 'report' + (selected.has(r.key) ? ' sel' : ''));

    const top = el('div', 'top');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(r.key);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(r.key); else selected.delete(r.key);
      render();
    });
    top.appendChild(cb);
    top.appendChild(el('span', 'name', r.displayName || (r.username ? '@' + r.username : r.profileId)));
    top.appendChild(el('span', 'count', r.count + ' report' + (r.count === 1 ? '' : 's')));
    // The weighted score, when it disagrees with the raw count. Ten reports
    // worth 0.4 between them is the thing worth seeing at a glance.
    if (r.score != null && Math.abs(r.score - r.count) >= 0.05) {
      top.appendChild(el('span', 'score', 'score ' + r.score.toFixed(2)));
    }
    top.appendChild(el('span', 'reason', r.reason));
    if (r.held) top.appendChild(el('span', 'pill held', 'held: no trusted reporter'));
    if (r.status !== 'pending') top.appendChild(el('span', 'pill ' + r.status, r.status));
    box.appendChild(top);

    box.appendChild(el('div', 'meta', [
      r.username ? '@' + r.username : null,
      r.profileId ? 'id ' + r.profileId : 'no numeric id',
      r.platform
    ].filter(Boolean).join('  ·  ')));

    if (r.url) {
      const a = link(r.url, 'plink');
      if (a) box.appendChild(a);
    }

    // Who stands behind this, and how often they have been right before.
    const trust = r.trust || [];
    if (trust.length) {
      const who = el('div', 'who');
      for (const t of trust) {
        const cls = 'rep' + (t.weight < 0.25 ? ' bad' : t.weight >= 0.75 ? ' good' : '');
        who.appendChild(el('span', cls,
          t.who + '  ' + t.weight.toFixed(2) +
          (t.approved + t.rejected ? ` (${t.approved}✓ ${t.rejected}✗)` : ' (new)')));
      }
      box.appendChild(who);
    }

    // The posts people cited. This is the substance of the case, so it is shown
    // inline rather than hidden behind a detail view.
    const posts = r.posts || [];
    if (posts.length) {
      const det = document.createElement('details');
      det.className = 'evidence';
      det.open = posts.length <= 2;
      det.appendChild(el('summary', null,
        posts.length + ' post' + (posts.length === 1 ? '' : 's') + ' cited'));
      for (const p of posts.slice(-6)) {
        const pd = el('div', 'post');
        if (p.summary) pd.appendChild(el('div', 'txt', p.summary));
        if (p.url) {
          const a = link(p.url, null);
          if (a) pd.appendChild(a);
        }
        det.appendChild(pd);
      }
      box.appendChild(det);
    }

    if (r.notes && r.notes.length) {
      const n = el('div', 'notes');
      for (const note of r.notes.slice(-4)) {
        n.appendChild(el('div', null, '“' + note.text + '” — ' + note.by));
      }
      box.appendChild(n);
    }

    const actions = el('div', 'actions');
    const add = (label, cls, decision) => {
      const b = el('button', 'btn ' + cls, label);
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = '…';
        const out = await api('/admin/reports/decide', 'POST', { key: r.key, decision, by: 'dashboard' });
        if (!out.ok) { b.disabled = false; b.textContent = label; setConn(out.error || 'failed', 'bad'); return; }
        refresh();
      });
      actions.appendChild(b);
    };
    // An approved entry is already on the live list, so the useful action is
    // taking it back off, not approving it again.
    if (r.status === 'approved') add('Remove from blocklist', 'danger', 'revoke');
    else {
      add('Approve → block', 'good', 'approve');
      if (r.status !== 'rejected') add('Reject', 'danger', 'reject');
    }
    box.appendChild(actions);
    return box;
  }

  function renderBlocklist(host) {
    const q = $('filter').value.trim().toLowerCase();
    const list = q
      ? blocklist.filter(e => (e.value + ' ' + (e.displayName || '') + ' ' + (e.platform || ''))
          .toLowerCase().includes(q))
      : blocklist;
    $('empty').classList.toggle('hidden', list.length > 0);

    for (const e of list) {
      const box = el('div', 'report');
      const top = el('div', 'top');
      top.appendChild(el('span', 'name', e.displayName || e.value));
      top.appendChild(el('span', 'pill', e.kind));
      if (e.reports) top.appendChild(el('span', 'count', e.reports + ' reports'));
      box.appendChild(top);
      box.appendChild(el('div', 'meta',
        [e.kind === 'id' ? 'id ' + e.value : '@' + e.value, e.platform].filter(Boolean).join('  ·  ')));

      const actions = el('div', 'actions');
      const b = el('button', 'btn danger', 'Remove from blocklist');
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = '…';
        const body = e.kind === 'id' ? { ids: [e.value] } : { usernames: [e.value] };
        const out = await api('/admin/blocklist/remove', 'POST', body);
        if (!out.ok) { b.disabled = false; b.textContent = 'Remove from blocklist'; setConn(out.error || 'failed', 'bad'); return; }
        refresh();
      });
      actions.appendChild(b);
      box.appendChild(actions);
      host.appendChild(box);
    }
  }

  // -- boot -----------------------------------------------------------------
  (async () => {
    // Ask who we are rather than probing a protected route, so a signed-out
    // load does not log a 401 to the console on every visit.
    const me = await api('/admin/session');
    const d = me.data || {};
    if (d.usingDefaults) {
      $('gateWarn').hidden = false;
      $('gateWarn').textContent = d.loopback
        ? 'This server is using the default credentials (admin / admin123). Change them with --user and --pass before exposing it.'
        : 'This server still uses the default credentials, so sign-in is restricted to the machine it runs on.';
      $('gateUser').value = 'admin';
    }
    if (!d.signedIn) { showGate(); return; }
    showApp();
    refresh();
  })();
})();
