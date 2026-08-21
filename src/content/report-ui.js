/**
 * In-page clone reporting (ISOLATED world).
 *
 * Puts a small "Report" affordance on profile links wherever they appear --
 * feed posts, comments, reply threads, profile headers -- so someone can flag a
 * clone at the moment they notice it, without leaving the page or hunting for
 * the extension.
 *
 * Two deliberate implementation choices:
 *
 *   Shadow DOM. Every piece of our UI lives inside a closed-ish shadow root on
 *   a single host element. Facebook and Threads ship enormous global
 *   stylesheets and rotate class names constantly; without a shadow boundary
 *   our widget would inherit their styles and, worse, could be caught by their
 *   own selectors. It also keeps us from leaking styles into their page.
 *
 *   Hover with a delay, not a permanent badge. Injecting a visible control next
 *   to every author on screen would be its own kind of vandalism, and would
 *   fight the feed's virtualisation. The chip is summoned by intent instead.
 */
(function () {
  'use strict';

  const P = globalThis.CB_PROTOCOL;
  const T = globalThis.CB_T;
  const bridge = globalThis.CB_BRIDGE;
  const identity = globalThis.CB_IDENTITY;

  const PLATFORM = bridge.state.platform;
  const settings = { reportUiEnabled: true, reportHoverDelayMs: 350, debug: false };

  // The reasons offered here ARE the tag vocabulary, in its order: a reason is
  // a vote for a tag, so one the tags do not contain is a vote nothing can
  // ever count. Built from the shared list rather than written out again --
  // a second copy is the copy that goes stale when a category is added.
  const REASONS = (globalThis.CB_TAGS || [])
    .map(t => [t, (globalThis.CB_TAG_LABELS || {})[t] || t]);

  function log(...a) { if (settings.debug) console.debug('[CloneBlocker/report]', ...a); }

  // -- identity of a hovered anchor -----------------------------------------
  const FB_RESERVED = /^(profile\.php|photo|photo\.php|watch|groups|pages|events|marketplace|reel|reels|stories|share|permalink|posts|videos|hashtag|search|messages|notifications|friends|settings|privacy|help|policies|login|reg|home|gaming|weather|fundraisers|saved|memories|bookmarks|ads|business|legal|terms|about|careers|people|places|games|live|media|story\.php|browse|allactivity|pages_feed|pg|me)$/i;

  function identityFromAnchor(a) {
    const href = a.getAttribute('href') || '';
    let m;
    if ((m = href.match(/profile\.php\?id=(\d+)/))) {
      return { profileId: m[1], username: null };
    }
    if ((m = href.match(/(?:threads\.(?:net|com))?\/@([A-Za-z0-9._]+)/))) {
      return { profileId: null, username: m[1] };
    }
    if ((m = href.match(/^https?:\/\/[^/]*facebook\.com\/([A-Za-z0-9.\-]+)(?:[/?#]|$)/)) ||
        (m = href.match(/^\/([A-Za-z0-9.\-]+)(?:[/?#]|$)/))) {
      if (!FB_RESERVED.test(m[1])) return { profileId: null, username: m[1] };
    }
    return null;
  }

  /** Fill in whichever half of the identity we can from the learned alias map. */
  function enrich(ident) {
    const out = Object.assign({}, ident);
    if (!out.profileId && out.username) {
      const id = identity.idForUsername(out.username);
      if (id) out.profileId = id;
    }
    if (!out.username && out.profileId) {
      const u = identity.usernameForId(out.profileId);
      if (u) out.username = u;
    }
    return out;
  }

  /** Is this identity the signed-in user? Reporting yourself is never wanted,
   *  and the site links to your own profile in its navigation constantly. */
  function isViewer(ident) {
    const me = bridge.state.viewerId;
    if (!me) return false;
    if (ident.profileId && String(ident.profileId) === String(me)) return true;
    const myName = identity.usernameForId(me);
    if (myName && ident.username && identity.norm(ident.username) === identity.norm(myName)) return true;
    return false;
  }

  const CHROME_LABELS = /^(profile|home|search|messages|notifications|activity|saved|insights|feeds|settings|menu|more)$/i;

  function displayNameFor(anchor) {
    let t = (anchor.textContent || '').trim();
    // Some links repeat their label ("ProfileProfile") because of visually
    // hidden text; collapse that before judging it.
    const half = t.slice(0, t.length / 2);
    if (half && half + half === t) t = half;
    if (t && t.length <= 60 && !/^https?:/.test(t) && !CHROME_LABELS.test(t)) return t;
    const img = anchor.querySelector && anchor.querySelector('img[alt]');
    if (img) return (img.getAttribute('alt') || '').slice(0, 60);
    return '';
  }

  function profileUrlFor(ident) {
    if (PLATFORM === 'threads') {
      return ident.username ? 'https://www.threads.com/@' + ident.username : null;
    }
    if (ident.profileId) return 'https://www.facebook.com/profile.php?id=' + ident.profileId;
    return ident.username ? 'https://www.facebook.com/' + ident.username : null;
  }

  // -- shadow host ----------------------------------------------------------
  let host = null, root = null, chip = null, modal = null;
  let hoverTimer = null, currentAnchor = null, currentIdent = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }

    .chip {
      position: fixed; z-index: 2147483647;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; border-radius: 999px;
      background: #1c1e21; color: #fff;
      font-size: 12px; font-weight: 600; line-height: 1;
      border: 1px solid rgba(255,255,255,.18);
      box-shadow: 0 4px 14px rgba(0,0,0,.35);
      cursor: pointer; user-select: none;
      opacity: 0; transform: translateY(2px);
      transition: opacity .12s ease, transform .12s ease;
    }
    .chip.show { opacity: 1; transform: translateY(0); }
    .chip:hover { background: #33363a; }
    .chip.reported { background: #7a4b00; }
    .chip.blocked  { background: #6b1f1f; }
    .chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #ff6b6b; }

    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center;
    }
    .sheet {
      width: min(420px, calc(100vw - 32px));
      background: #fff; color: #16181c;
      border-radius: 14px; overflow: hidden;
      box-shadow: 0 18px 50px rgba(0,0,0,.4);
    }
    @media (prefers-color-scheme: dark) {
      .sheet { background: #1e2127; color: #e8eaed; }
      .sheet input, .sheet select, .sheet textarea {
        background: #16181c; color: #e8eaed; border-color: #333;
      }
      .who, .post { background: #16181c !important; }
    }
    .hd { padding: 14px 16px; font-size: 15px; font-weight: 700;
          border-bottom: 1px solid rgba(128,128,128,.25); }
    .bd { padding: 14px 16px; }
    .who { display: flex; flex-direction: column; gap: 2px;
           background: #f2f3f5; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
    .who .n { font-weight: 700; font-size: 13px; }
    .who .m { font-size: 12px; opacity: .7; word-break: break-all; }
    .post { background: #f2f3f5; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
    .plabel { font-size: 11px; font-weight: 700; text-transform: uppercase;
              letter-spacing: .05em; opacity: .6; margin-bottom: 4px; }
    .psummary { font-size: 13px; line-height: 1.4; max-height: 96px; overflow: hidden;
                white-space: pre-wrap; word-break: break-word; }
    .purl { display: block; margin-top: 6px; font-size: 11px; color: #1d6fe0;
            word-break: break-all; text-decoration: none; }
    .purl:hover { text-decoration: underline; }
    label { display: block; font-size: 12px; font-weight: 600; margin: 10px 0 4px; }
    select, textarea {
      width: 100%; padding: 8px 10px; font: inherit; font-size: 13px;
      border: 1px solid rgba(128,128,128,.4); border-radius: 8px; background: #fff;
    }
    textarea { resize: vertical; min-height: 62px; }
    .ft { display: flex; gap: 8px; justify-content: flex-end;
          padding: 12px 16px; border-top: 1px solid rgba(128,128,128,.25); }
    button {
      padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 600;
      border-radius: 8px; border: 1px solid rgba(128,128,128,.4);
      background: transparent; color: inherit; cursor: pointer;
    }
    button.primary { background: #1d6fe0; border-color: #1d6fe0; color: #fff; }
    button.primary:disabled { opacity: .6; cursor: default; }
    .note { font-size: 12px; opacity: .75; margin-top: 10px; }
    .err { color: #c0392b; font-size: 12px; margin-top: 10px; }
    .ok  { color: #2e7d32; font-size: 13px; }
    .badge { display:inline-block; padding:2px 7px; border-radius:999px;
             font-size:11px; font-weight:700; background:#eee; color:#333; margin-left:6px; }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-cloneblocker-ui', '');
    // Keep the host itself inert; only children inside the shadow root paint.
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
  }

  // -- the hover chip -------------------------------------------------------
  function hideChip() {
    if (chip) { chip.classList.remove('show'); }
    currentAnchor = null;
  }

  function showChipFor(anchor, ident) {
    ensureHost();
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'chip';
      chip.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
      chip.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        openModal(currentIdent, currentAnchor);
      });
      root.appendChild(chip);
    }
    currentAnchor = anchor;
    currentIdent = ident;

    chip.className = 'chip';
    chip.textContent = '';
    const label = document.createElement('span');
    label.textContent = T('report_chip');
    chip.appendChild(label);

    const r = anchor.getBoundingClientRect();
    // Anchor to the link, nudged clear of it, and kept inside the viewport.
    const top = Math.max(4, Math.min(window.innerHeight - 30, r.top - 26));
    const left = Math.max(4, Math.min(window.innerWidth - 96, r.left));
    chip.style.top = top + 'px';
    chip.style.left = left + 'px';
    requestAnimationFrame(() => chip.classList.add('show'));

    // Decorate with what we already know, then refresh from the server.
    bridge.sw(P.SW.REPORT_STATUS, {
      platform: PLATFORM, profileId: ident.profileId, username: ident.username
    }).then((st) => {
      if (!chip || currentAnchor !== anchor) return;
      if (st && st.blocked) {
        chip.classList.add('blocked');
        label.textContent = T('report_chipBlocked');
      } else if (st && st.status === 'pending') {
        chip.classList.add('reported');
        label.textContent = st.count > 1
          ? T('report_chipReportedCount', st.count) : T('report_chipReported');
      }
    }).catch(() => {});
  }

  function onPointerOver(ev) {
    if (!settings.reportUiEnabled) return;
    const t = ev.target;
    if (!t || t.nodeType !== 1) return;
    if (host && host.contains(t)) return;

    const anchor = t.closest && t.closest('a[href]');
    if (!anchor) { scheduleHide(); return; }
    if (anchor === currentAnchor) return;

    // Site chrome links to profiles too -- the sidebar "Profile" entry, the
    // account switcher. Those are navigation, not someone you encountered in
    // content, and their link text makes a nonsense display name.
    if (anchor.closest('nav, [role="navigation"], [role="banner"], header')) { scheduleHide(); return; }

    const ident = identityFromAnchor(anchor);
    if (!ident) { scheduleHide(); return; }

    const enriched = enrich(ident);
    if (isViewer(enriched)) { scheduleHide(); return; }   // never offer to report yourself

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showChipFor(anchor, enriched),
                            Math.max(0, settings.reportHoverDelayMs | 0));
  }

  let hideTimer = null;
  function scheduleHide() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideChip, 400);
  }

  // -- the report sheet -----------------------------------------------------
  function closeModal() {
    if (modal) { modal.remove(); modal = null; }
  }

  /**
   * @param context optional {postUrl, summary, postId} when the report was
   *   raised from a specific post rather than from a bare profile link. The
   *   dialog shows exactly what will be sent -- someone confirming a report
   *   should be able to see the post it refers to, not just a name.
   */
  function openModal(ident, anchor, context) {
    ensureHost();
    closeModal();
    hideChip();

    const ctx = context || {};
    const name = (anchor ? displayNameFor(anchor) : '') || ctx.displayName || '';
    const url = ctx.postUrl || profileUrlFor(ident);

    modal = document.createElement('div');
    modal.className = 'backdrop';
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    // The skeleton carries data-i18n keys and no text of its own, so this
    // dialog picks up a language the same way the extension's own pages do --
    // and a string added here later cannot quietly skip translation.
    sheet.innerHTML = `
      <div class="hd" data-i18n="report_sheetTitle"></div>
      <div class="bd">
        <div class="who">
          <span class="n"></span>
          <span class="m"></span>
        </div>
        <div class="post" hidden>
          <div class="plabel" data-i18n="report_postLabel"></div>
          <div class="psummary"></div>
          <a class="purl" target="_blank" rel="noreferrer noopener"></a>
        </div>
        <label for="reason" data-i18n="report_reasonLabel"></label>
        <select id="reason"></select>
        <label for="note" data-i18n="report_noteLabel"></label>
        <textarea id="note" data-i18n-placeholder="report_notePlaceholder"></textarea>
        <div class="note" data-i18n="report_disclaimer"></div>
        <div class="err" hidden></div>
      </div>
      <div class="ft">
        <button class="cancel" data-i18n="report_cancel"></button>
        <button class="primary submit" data-i18n="report_submit"></button>
      </div>`;
    globalThis.CB_APPLY_I18N(sheet);
    modal.appendChild(sheet);
    root.appendChild(modal);

    const $ = (s) => sheet.querySelector(s);
    $('.who .n').textContent = name ||
      (ident.username ? '@' + ident.username : T('report_unknownProfile'));
    $('.who .m').textContent = [
      ident.username ? '@' + ident.username : null,
      ident.profileId ? T('report_idValue', ident.profileId) : T('report_noNumericId'),
      PLATFORM
    ].filter(Boolean).join('  ·  ');

    if (ctx.summary || ctx.postUrl) {
      $('.post').hidden = false;
      $('.psummary').textContent = ctx.summary || T('report_noPostText');
      if (ctx.postUrl) {
        $('.purl').textContent = ctx.postUrl;
        $('.purl').href = ctx.postUrl;
      } else {
        $('.purl').remove();
      }
    }

    const sel = $('#reason');
    for (const [value, text] of REASONS) {
      const o = document.createElement('option');
      o.value = value; o.textContent = text;
      sel.appendChild(o);
    }

    // A report has to carry the account behind it, so say so up front rather
    // than letting someone write out a case and lose it to a 401 on submit.
    if (!bridge.state.viewerId) {
      const err = $('.err');
      err.hidden = false;
      err.textContent = T('report_signIn', PLATFORM === 'facebook' ? 'Facebook' : 'Threads');
      $('.submit').disabled = true;
    }

    $('.cancel').addEventListener('click', closeModal);
    $('.submit').addEventListener('click', async () => {
      const btn = $('.submit');
      const err = $('.err');
      btn.disabled = true; btn.textContent = T('report_sending');
      err.hidden = true;

      const res = await bridge.sw(P.SW.SUBMIT_REPORT, {
        platform: PLATFORM,
        // Who is filing this. The server refuses reports with no account behind
        // them, so a signed-out viewer is told rather than silently dropped.
        viewerId: bridge.state.viewerId || null,
        profileId: ident.profileId,
        username: ident.username,
        displayName: name,
        url,
        reason: sel.value,
        note: $('#note').value.slice(0, 400),
        postUrl: ctx.postUrl || null,
        postId: ctx.postId || null,
        contentSummary: ctx.summary || null
      });

      if (!res || !res.ok) {
        btn.disabled = false; btn.textContent = T('report_submit');
        err.hidden = false;
        err.textContent = (res && res.error) || T('report_sendFailed');
        return;
      }
      // Built out of nodes rather than out of a string of HTML, which is what
      // lets the status word and the count be separate translated messages
      // instead of fragments concatenated around markup.
      const bd = sheet.querySelector('.bd');
      bd.textContent = '';
      const ok = document.createElement('div');
      ok.className = 'ok';
      ok.textContent = T(res.duplicate ? 'report_duplicate' : 'report_sent');
      const foot = document.createElement('div');
      foot.className = 'note';
      foot.appendChild(document.createTextNode(T('report_statusLabel') + ' '));
      const status = document.createElement('b');
      // Server vocabulary, translated where we know the word and shown raw
      // where we do not -- a status nobody has a message for is still better
      // read than swallowed.
      status.textContent = res.status === 'pending' ? T('report_statusPending')
        : res.status === 'approved' ? T('report_statusApproved') : String(res.status);
      foot.appendChild(status);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = res.count === 1
        ? T('report_countOne') : T('report_countMany', res.count);
      foot.appendChild(badge);
      foot.appendChild(document.createElement('br'));
      foot.appendChild(document.createTextNode(T('report_adminReviews')));
      bd.appendChild(ok);
      bd.appendChild(foot);
      sheet.querySelector('.ft').textContent = '';
      const done = document.createElement('button');
      done.className = 'primary'; done.textContent = T('report_done');
      done.addEventListener('click', closeModal);
      sheet.querySelector('.ft').appendChild(done);
    });

    sel.focus();
  }

  // -- public entry points (used by the popup) ------------------------------

  /** Whose profile is this page showing, from the URL alone? */
  function identityFromLocation() {
    if (PLATFORM === 'threads') {
      const m = location.pathname.match(/^\/@([A-Za-z0-9._]+)/);
      return m ? { profileId: null, username: m[1] } : null;
    }
    const m = location.search.match(/[?&]id=(\d+)/);
    if (m) return { profileId: m[1], username: null };
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (seg && !FB_RESERVED.test(seg)) return { profileId: null, username: seg };
    return null;
  }

  /**
   * What the popup needs to offer an action for this page, without opening
   * anything. Reporting and blocking are both about a specific profile, so a
   * popup that cannot name the profile can only offer generic settings -- which
   * is what it used to do.
   */
  function currentProfileInfo() {
    const ident = identityFromLocation();
    if (!ident) return null;
    const enriched = enrich(ident);
    const hit = identity.match({ id: enriched.profileId, username: enriched.username });
    return {
      profileId: enriched.profileId || null,
      username: enriched.username || null,
      isViewer: isViewer(enriched),
      listed: !!hit,
      listedBy: hit ? hit.by : null
    };
  }

  /** Report whatever profile this page is currently showing. */
  function reportCurrentProfile() {
    let anchor = null;
    const ident = identityFromLocation();
    if (!ident) return { ok: false, error: T('report_notAProfile') };
    const enriched = enrich(ident);
    if (isViewer(enriched)) return { ok: false, error: T('report_ownProfile') };
    // Prefer a real byline anchor so the display name comes out right.
    anchor = document.querySelector('a[href*="' + (ident.username || ident.profileId) + '"]');
    openModal(enriched, anchor);
    return { ok: true, ident: enriched };
  }

  // ==========================================================================
  // Threads: a report button in each post's action bar.
  //
  // The hover chip is fine for a name in passing, but reporting a clone is
  // usually prompted by a *post*, and the report is far more useful to a
  // reviewer when it carries that post. So on Threads the button sits in the
  // action row next to Share, and the report it raises includes the permalink
  // and a summary of the content.
  // ==========================================================================
  const MARK_ATTR = 'data-cloneblocker-report-btn';
  const SHARE_LABELS = /^(share|send to|send)$/i;
  const ACTION_LABELS = /^(like|reply|repost|share|send to|send)$/i;

  /** Pull the reportable facts out of a post container. */
  function extractPostContext(container) {
    let permalink = null, authorHref = null;
    const anchors = container.querySelectorAll('a[href]');
    for (const a of anchors) {
      const h = a.getAttribute('href') || '';
      if (!permalink && /\/@[^/]+\/post\//.test(h)) permalink = h;
      if (!authorHref && /^\/@[^/]+$/.test(h)) authorHref = h;
    }
    // The permalink also names the author, which is the most reliable source:
    // a repost shows one name in the header and another on the post itself.
    let username = null;
    const pm = permalink && permalink.match(/^\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/);
    if (pm) username = pm[1];
    else if (authorHref) username = authorHref.replace(/^\/@/, '');

    // Content summary: the longest auto-direction text block that is not the
    // author's own handle or an interface label.
    let best = '';
    for (const el of container.querySelectorAll('span[dir="auto"], div[dir="auto"]')) {
      const t = (el.innerText || '').trim();
      if (t.length <= best.length) continue;
      if (username && t === username) continue;
      if (/^(translate|edited|follow|reply|repost|share|like)$/i.test(t)) continue;
      best = t;
    }
    // Trim trailing interface words the text nodes tend to absorb.
    best = best.replace(/\s*\bTranslate\s*$/i, '').trim();

    return {
      username,
      postId: pm ? pm[2] : null,
      postUrl: permalink ? new URL(permalink, location.origin).href : null,
      summary: best ? best.slice(0, 280) : ''
    };
  }

  function reportIconSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-label', T('report_iconLabel'));
    const flag = document.createElementNS(ns, 'path');
    flag.setAttribute('d', 'M4 21V4.5C4 4.5 6 3 9.5 3s5 1.5 8.5 1.5c1 0 2-.2 2-.2v9s-1 .5-2.5.5c-3.5 0-5-1.5-8.5-1.5S4 14 4 14');
    svg.appendChild(flag);
    return svg;
  }

  /** Find the Share control's wrapper inside a post's action row. */
  function findShareSlot(container) {
    const svgs = container.querySelectorAll('svg[aria-label]');
    for (const svg of svgs) {
      const label = (svg.getAttribute('aria-label') || '').trim();
      if (!SHARE_LABELS.test(label)) continue;
      const btn = svg.closest('[role="button"],button,div[tabindex]');
      if (!btn) continue;
      // Sit alongside the other actions: use the button's own wrapper so the
      // row's flex layout treats ours the same way it treats theirs.
      const slot = btn.parentElement && btn.parentElement.children.length === 1
        ? btn.parentElement : btn;
      // Only accept it if this really is the action row -- a post can contain
      // other share affordances (embedded quotes carry their own).
      const row = slot.parentElement;
      if (!row) continue;
      let siblingActions = 0;
      for (const s of row.querySelectorAll('svg[aria-label]')) {
        if (ACTION_LABELS.test((s.getAttribute('aria-label') || '').trim())) siblingActions++;
      }
      if (siblingActions >= 2) return slot;
    }
    return null;
  }

  function buildThreadButton(container) {
    const btn = document.createElement('div');
    btn.setAttribute(MARK_ATTR, '1');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', T('report_buttonLabel'));
    btn.title = T('report_buttonLabel');
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'gap:4px', 'height:36px', 'min-width:36px', 'padding:0 8px',
      'border-radius:999px', 'cursor:pointer', 'color:inherit', 'opacity:.62',
      'transition:opacity .12s ease,background-color .12s ease', 'user-select:none'
    ].join(';');
    btn.appendChild(reportIconSvg());

    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1';
      btn.style.backgroundColor = 'rgba(128,128,128,.15)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.opacity = '.62';
      btn.style.backgroundColor = 'transparent';
    });

    const activate = (e) => {
      // Posts are themselves clickable; without this the click also navigates.
      e.preventDefault();
      e.stopPropagation();
      const ctx = extractPostContext(container);
      const ident = enrich({ profileId: null, username: ctx.username });
      if (isViewer(ident)) {
        // Nothing useful to do, and reporting yourself is never intended.
        return;
      }
      openModal(ident, null, Object.assign({ displayName: ctx.username ? '@' + ctx.username : '' }, ctx));
    };
    btn.addEventListener('click', activate, true);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activate(e);
    });
    return btn;
  }

  let injectQueued = false;
  function injectThreadButtons() {
    if (PLATFORM !== 'threads' || !settings.reportUiEnabled) return;
    const containers = document.querySelectorAll('[data-pressable-container]');
    let added = 0;
    for (const c of containers) {
      // React reuses these nodes, so an existing button may belong to a post
      // that is no longer displayed here; keying on the permalink keeps it
      // honest.
      const slot = findShareSlot(c);
      if (!slot || !slot.parentElement) continue;
      const row = slot.parentElement;
      const existing = row.querySelector('[' + MARK_ATTR + ']');
      const ctx = extractPostContext(c);
      if (existing) {
        if (existing.getAttribute('data-cloneblocker-post') === (ctx.postUrl || '')) continue;
        existing.remove();
      }
      const btn = buildThreadButton(c);
      btn.setAttribute('data-cloneblocker-post', ctx.postUrl || '');
      slot.insertAdjacentElement('afterend', btn);
      added++;
    }
    if (added) log('injected', added, 'thread report buttons');
  }

  function queueInject() {
    if (injectQueued) return;
    injectQueued = true;
    const run = () => { injectQueued = false; injectThreadButtons(); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 });
    else setTimeout(run, 120);
  }

  function startThreadButtons() {
    if (PLATFORM !== 'threads') return;
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList' && r.addedNodes.length) { queueInject(); return; }
      }
    });
    const attach = () => {
      obs.observe(document.documentElement || document, { childList: true, subtree: true });
      queueInject();
    };
    if (document.documentElement) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
    // The feed virtualises aggressively; a periodic pass catches rows the
    // observer's batching coalesced away.
    setInterval(queueInject, 3000);
  }

  function removeThreadButtons() {
    for (const b of document.querySelectorAll('[' + MARK_ATTR + ']')) b.remove();
  }

  function updateSettings(next) {
    Object.assign(settings, next || {});
    if (!settings.reportUiEnabled) { hideChip(); closeModal(); removeThreadButtons(); }
    else queueInject();
  }

  function start() {
    // Both, deliberately. pointerover is the modern event, but it is not
    // always synthesised for programmatic mouse input, and mouseover is the
    // one every path reliably produces. onPointerOver is idempotent for a
    // given anchor, so receiving both costs nothing.
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('mouseover', onPointerOver, true);
    document.addEventListener('pointerdown', (e) => {
      if (host && host.contains(e.target)) return;
      hideChip();
    }, true);
    window.addEventListener('scroll', hideChip, { passive: true, capture: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideChip(); closeModal(); } });
    startThreadButtons();
  }

  globalThis.CB_REPORT = {
    start, updateSettings, reportCurrentProfile, currentProfileInfo, openModal
  };
})();
