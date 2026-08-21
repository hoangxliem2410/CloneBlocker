/**
 * The public transparency page.
 *
 * This page names people. Everything about it is written for that: it reads
 * one document, renders it with textContent only, and re-checks every URL
 * before it becomes an href. The strings on it were typed by strangers about
 * named strangers, which makes this the most XSS-sensitive surface in the
 * project — a single innerHTML here would let a reporter write script into a
 * page the accused, their friends, and anyone searching their name will open.
 *
 * Where the data comes from, in order:
 *
 *   1. /transparency.json — the static mirror tools/publish-static.js writes.
 *      Preferred when it exists: the CDN serves it with a real ETag, so the
 *      page costs no database read no matter how many people open it.
 *   2. blocklist/publicView over the Firestore REST endpoint, unauthenticated.
 *      The rules make that document world-readable precisely so this page can
 *      work before (or without) a static deploy.
 *
 * No Firebase SDK: this is one GET of one document and needs no auth, so
 * pulling in the modular SDK would be a large dependency to do less.
 *
 * Not one string of its own: every word this page says lives in the shared
 * dictionary in hosting/i18n.js and arrives through CB_T, the same call the
 * extension makes. That is what keeps the two halves of the product readable
 * as one thing, and what makes a language other than these two a table rather
 * than a rewrite.
 */

// Which surface's strings CB_T answers with. Done before anything renders,
// and never again: the language changes underneath this, the surface does not.
CB_I18N.use('public');

// Where a person who believes they are listed in error goes. Named as a
// constant so the note and any future page can never quote different ones.
const ISSUES_URL = 'https://github.com/hoangxliem2410/CloneBlocker/issues';

// The tag order the chips follow, read off the dictionary rather than
// re-declared, so a tag that gains a label gains a chip by itself. Anything in
// the data that is not in here still renders, appended, under its raw name: an
// unlabelled tag must never make a profile invisible.
const TAG_ORDER = CB_I18N.keys()
  .filter(k => k.startsWith('tag_'))
  .map(k => k.slice(4));

// -- where the data lives ---------------------------------------------------

const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

// Hardcoded, like LIST_URL in the extension: this page has exactly one
// production database behind it, and reading the project id out of
// /__/firebase/init.json would add a round trip to every load to learn a
// constant. The emulator is the local case, by hostname, and nothing else.
const FIRESTORE = LOCAL
  ? 'http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents'
  : 'https://firestore.googleapis.com/v1/projects/clone-blocker2/databases/(default)/documents';

const STATIC_MIRROR = 'transparency.json';

// -- state ------------------------------------------------------------------

let view = null;        // the publicView payload, once read
let source = null;      // 'static' | 'live', for the footer
let tagFilter = '';     // '' means every tag
let query = '';

const $ = (id) => document.getElementById(id);

// -- helpers ----------------------------------------------------------------

/**
 * The label for a tag, or the tag itself.
 *
 * protocol.js reads the same key the same way in the extension, down to the
 * idiom: CB_T hands back the key when nothing has translated it, so a key
 * echoed straight back means "no label for this tag" and the raw name is
 * shown. A tag the dictionary has never heard of must still name itself --
 * rendering it as `tag_something` would be worse than plain.
 */
function tagLabel(tag) {
  const key = 'tag_' + tag;
  const label = CB_T(key);
  return label === key ? tag : label;
}

/** A tag we have a colour for, or the neutral one. */
function tagClass(tag) {
  return 'tag-' + (TAG_ORDER.includes(tag) ? tag : 'other');
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/**
 * A link, or nothing.
 *
 * The dashboard's guard, tightened by one scheme. buildPublicView already drops
 * every evidence entry whose URL is not https, so anything reaching this page
 * over http is either a payload that did not come from the builder or a URL
 * that was rewritten in transit — in both cases the answer is to render the
 * text and no link at all. The check runs here, at the point of use, rather
 * than being trusted from the rules or the builder: this is the last place
 * before a stranger's string becomes an href.
 */
function link(href, cls) {
  let u;
  try { u = new URL(href, location.origin); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  const a = el('a', cls, href);
  a.href = u.href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  return a;
}

function num(n) {
  const v = Number(n);
  if (!isFinite(v)) return CB_T('none');
  try { return new Intl.NumberFormat(CB_I18N.lang() === 'vi' ? 'vi-VN' : 'en-US').format(v); }
  catch (e) { return String(v); }
}

/**
 * A UTC day, formatted without ever constructing a Date.
 *
 * buildPublicView emits plain 'YYYY-MM-DD' UTC days. Parsing one into a Date
 * and formatting it locally would shift it by a day for every reader west of
 * Greenwich, which on a page whose whole claim is "first reported on this day"
 * is a falsehood for the sake of a nicer month name.
 */
function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return CB_T('none');
  return CB_I18N.lang() === 'vi'
    ? m[3] + '/' + m[2] + '/' + m[1]
    : m[1] + '-' + m[2] + '-' + m[3];
}

/** An ISO instant down to the minute, in UTC, for the footer. */
function fmtStamp(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso || ''));
  if (!m) return CB_T('none');
  return fmtDay(m[1]) + ' ' + m[2] + ' UTC';
}

/**
 * Diacritic-blind folding for search.
 *
 * Vietnamese names carry marks that most people will not type into a search
 * box, and a filter that only matches "Nguyễn" when you type "Nguyễn" is a
 * filter nobody can use. NFD splits the marks off so they can be dropped; đ
 * has no decomposition and is spelled out.
 */
function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase();
}

// -- reading the list -------------------------------------------------------

/**
 * Accept either shape of published view.
 *
 * publish-static.js may mirror the payload itself or the Firestore envelope it
 * came in (a `json` string field, as blocklist.json is written today). Reading
 * both costs four lines and means the page cannot be broken by a decision the
 * snapshot tool has not made yet.
 */
function unwrap(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (Array.isArray(doc.profiles)) return doc;
  const raw = typeof doc.json === 'string' ? doc.json
    : (doc.fields && doc.fields.json && doc.fields.json.stringValue);
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.profiles) ? parsed : null;
  } catch (e) { return null; }
}

async function readStatic() {
  let res;
  try { res = await fetch(STATIC_MIRROR, { cache: 'no-cache' }); }
  catch (e) { return null; }
  if (!res.ok) return null;
  try { return unwrap(await res.json()); } catch (e) { return null; }
}

async function readFirestore() {
  let res;
  try { res = await fetch(FIRESTORE + '/blocklist/publicView'); }
  catch (e) { return null; }
  if (!res.ok) return null;
  try { return unwrap(await res.json()); } catch (e) { return null; }
}

async function load() {
  const mirrored = await readStatic();
  if (mirrored) { view = mirrored; source = 'static'; return true; }
  const live = await readFirestore();
  if (live) { view = live; source = 'live'; return true; }
  return false;
}

// -- rendering: the parts that are the same whatever the data says ----------

function renderLangToggle() {
  const box = $('langToggle');
  clear(box);
  for (const { code, label } of CB_I18N.locales()) {
    const b = el('button', null, code.toUpperCase());
    b.type = 'button';
    b.setAttribute('aria-pressed', String(code === CB_I18N.lang()));
    b.title = label;
    b.addEventListener('click', () => setLang(code));
    box.appendChild(b);
  }
}

function renderIntro() {
  const box = $('intro');
  clear(box);
  box.appendChild(el('p', 'eyebrow', CB_T('introEyebrow')));
  box.appendChild(el('h1', null, CB_T('title')));
  box.appendChild(el('p', 'lede', CB_T('lede')));
  box.appendChild(el('p', 'lede', CB_T('lede2')));

  const list = el('ol', 'steps');
  [['step1t', 'step1b'], ['step2t', 'step2b'], ['step3t', 'step3b']].forEach((pair, i) => {
    const li = el('li', 'step');
    li.appendChild(el('span', 'n', String(i + 1)));
    li.appendChild(el('h3', null, CB_T(pair[0])));
    li.appendChild(el('p', null, CB_T(pair[1])));
    list.appendChild(li);
  });
  box.appendChild(el('p', 'eyebrow howhd', CB_T('howEyebrow')));
  box.appendChild(list);
}

function renderNotice() {
  const box = $('notice');
  clear(box);
  box.appendChild(el('h2', null, CB_T('noticeTitle')));
  box.appendChild(el('p', null, CB_T('noticeAnon')));
  box.appendChild(el('p', null, CB_T('noticeJudgement')));

  // Built out of three nodes rather than one string with markup in it: the
  // whole page holds the line that no HTML is ever assembled from text.
  const appeal = el('p');
  appeal.appendChild(document.createTextNode(CB_T('noticeAppealBefore')));
  const a = link(ISSUES_URL);
  if (a) appeal.appendChild(a);
  else appeal.appendChild(document.createTextNode(ISSUES_URL));
  appeal.appendChild(document.createTextNode(CB_T('noticeAppealAfter')));
  box.appendChild(appeal);
}

function renderFoot() {
  const box = $('foot');
  clear(box);
  if (!view) return;
  box.appendChild(document.createTextNode(CB_T('footUpdated') + ' ' + fmtStamp(view.updatedAt)));
  box.appendChild(el('span', 'sep', '·'));
  box.appendChild(document.createTextNode(
    source === 'static' ? CB_T('footSourceStatic') : CB_T('footSourceLive')));
}

// -- rendering: the data ----------------------------------------------------

function renderStats() {
  const box = $('stats');
  clear(box);
  if (!view) { box.hidden = true; return; }
  box.hidden = false;

  const counts = view.counts || {};
  const grid = el('div', 'statgrid');
  const tile = (cls, value, key) => {
    const d = el('div', 'stat' + (cls ? ' ' + cls : ''));
    d.appendChild(el('div', 'sv', num(value)));
    d.appendChild(el('div', 'sk', CB_T(key)));
    return d;
  };
  grid.appendChild(tile('lead', counts.published, 'statPublished'));
  grid.appendChild(tile('', counts.blocked, 'statBlocked'));
  grid.appendChild(tile('', counts.reports, 'statReports'));
  box.appendChild(grid);
  box.appendChild(el('p', 'statnote', CB_T('statNote')));
}

/** Every tag actually present, in the canonical order, with its headcount. */
function tagCounts() {
  const counts = Object.create(null);
  for (const p of (view && view.profiles) || []) {
    const tag = String(p && p.tag || 'other');
    counts[tag] = (counts[tag] || 0) + 1;
  }
  const known = TAG_ORDER.filter(tag => counts[tag]);
  const rest = Object.keys(counts).filter(tag => !TAG_ORDER.includes(tag)).sort();
  return known.concat(rest).map(tag => [tag, counts[tag]]);
}

function renderControls() {
  const box = $('controls');
  clear(box);
  const present = tagCounts();
  if (!view || !present.length) { box.hidden = true; return; }
  box.hidden = false;

  const filter = el('div', 'tagfilter');
  filter.appendChild(el('span', 'eyebrow', CB_T('filterLabel')));

  const chip = (tag, label, count) => {
    const b = el('button', 'tagchip ' + (tag ? tagClass(tag) : 'all'), label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(tagFilter === tag));
    b.appendChild(el('span', 'n', String(count)));
    b.addEventListener('click', () => {
      tagFilter = tag;
      renderControls();
      renderCards();
    });
    return b;
  };

  filter.appendChild(chip('', CB_T('filterAll'), (view.profiles || []).length));
  for (const [tag, n] of present) filter.appendChild(chip(tag, tagLabel(tag), n));
  box.appendChild(filter);

  const wrap = el('div', 'searchwrap');
  const input = el('input');
  input.type = 'search';
  input.value = query;
  input.placeholder = CB_T('searchPlaceholder');
  input.setAttribute('aria-label', CB_T('searchLabel'));
  input.addEventListener('input', () => { query = input.value; renderCards(); });
  wrap.appendChild(input);
  box.appendChild(wrap);
}

function matches(p) {
  if (tagFilter && String(p.tag || 'other') !== tagFilter) return false;
  const q = fold(query).trim();
  if (!q) return true;
  const hay = fold([p.displayName, p.username, p.id, p.platform, tagLabel(p.tag)]
    .filter(Boolean).join(' '));
  return hay.includes(q);
}

/**
 * One profile.
 *
 * Nothing in here is interpolated into markup and nothing is trusted: the name,
 * the username, the quoted post text and the region names are all strangers'
 * strings, set as text; the only URL that becomes an href went through link().
 */
function profileCard(p) {
  const tag = String(p.tag || 'other');
  const card = el('article', 'profile ' + tagClass(tag));

  const head = el('div', 'head');
  const name = p.displayName
    ? el('h3', 'name', p.displayName)
    : el('h3', 'name unnamed', CB_T('unnamed'));
  head.appendChild(name);
  head.appendChild(el('span', 'tag ' + tagClass(tag), tagLabel(tag)));
  card.appendChild(head);

  const ident = el('p', 'ident');
  ident.appendChild(document.createTextNode(
    p.username ? '@' + p.username : '(' + CB_T('noUsername') + ')'));
  ident.appendChild(el('span', 'sep', '·'));
  ident.appendChild(document.createTextNode(String(p.platform || '')));
  if (p.id) {
    ident.appendChild(el('span', 'sep', '·'));
    ident.appendChild(document.createTextNode(String(p.id)));
  }
  card.appendChild(ident);

  const facts = el('div', 'facts');
  const fact = (key, value, big) => {
    const d = el('div', 'fact');
    d.appendChild(el('div', 'k', CB_T(key)));
    d.appendChild(el('div', 'v' + (big ? ' big' : ''), value));
    return d;
  };
  facts.appendChild(fact('factReports', num(p.reports), true));
  facts.appendChild(fact('factFirst', fmtDay(p.firstReported)));
  facts.appendChild(fact('factLast', fmtDay(p.lastActive)));
  // Region identifiers are printed whole, underscores opened out: "Asia/Ho Chi
  // Minh" says where without inviting the guess that "Ho Chi Minh" alone does.
  const regions = (p.regions || []).map(r => String(r).replace(/_/g, ' '));
  facts.appendChild(fact('factRegions', regions.length ? regions.join(', ') : CB_T('none')));
  card.appendChild(facts);

  const ev = el('div', 'evidence');
  ev.appendChild(el('p', 'eyebrow', CB_T('evidenceEyebrow')));
  const usable = (p.evidence || []).filter(e => e && link(e.url));
  if (!usable.length) {
    ev.appendChild(el('p', 'noevidence', CB_T('noEvidence')));
  } else {
    usable.forEach((e, i) => {
      const row = el('div', 'exhibit');
      row.appendChild(el('span', 'en', CB_T('exhibit', i + 1)));
      if (e.summary) row.appendChild(el('p', 'quote', String(e.summary)));
      const a = link(e.url);
      if (a) row.appendChild(a);
      ev.appendChild(row);
    });
  }
  card.appendChild(ev);
  return card;
}

function renderCards() {
  const box = $('cards');
  const state = $('state');
  const line = $('resultline');
  clear(box);

  const all = (view && view.profiles) || [];
  const shown = all.filter(matches);

  for (const p of shown) box.appendChild(profileCard(p));

  line.hidden = !all.length;
  line.textContent = CB_T('resultCount', num(shown.length), num(all.length));

  if (!all.length) { state.textContent = CB_T('emptyList'); state.className = 'state'; }
  else if (!shown.length) { state.textContent = CB_T('emptyFilter'); state.className = 'state'; }
  else state.textContent = '';
}

// -- language ---------------------------------------------------------------

const LANG_KEY = 'cb.public.lang';

/**
 * What the reader last chose, or nothing.
 *
 * Deliberately unvalidated: CB_I18N.setLang refuses a code the dictionary does
 * not have and leaves the surface's own default in force -- Vietnamese,
 * because the list is about Vietnamese-language accounts and is read
 * overwhelmingly by their targets. Naming the two languages again here would
 * be a second copy of the list, and the one nobody updates.
 */
function readLang() {
  try { return localStorage.getItem(LANG_KEY); }
  catch (e) { return null; }   // private mode, or storage denied
}

function setLang(next) {
  // The module is the one that decides: a code it does not have is refused and
  // the language in force comes back unchanged, so a stale value out of
  // localStorage can never leave the page half-rendered in a language that
  // does not exist.
  const now = CB_I18N.setLang(next);
  if (now !== next) return;
  try { localStorage.setItem(LANG_KEY, now); } catch (e) { /* nothing to do */ }
  document.documentElement.lang = now;
  renderAll();
}

function renderAll() {
  // The tab title is a string like any other: a reader who switches to English
  // and then looks at their tabs should not find the Vietnamese one there.
  document.title = 'Clone Blocker — ' + CB_T('introEyebrow');
  renderLangToggle();
  $('brandName').textContent = CB_T('brand');
  $('registerHd').textContent = CB_T('registerEyebrow');
  renderIntro();
  renderNotice();
  renderStats();
  renderControls();
  renderCards();
  renderFoot();
}

// -- boot -------------------------------------------------------------------

(async function boot() {
  document.documentElement.lang = CB_I18N.setLang(readLang());

  // The prose renders before the fetch resolves: the explanation of what this
  // list is and the note about being listed in error are the parts a person who
  // believes they are on it needs, and they must not wait on a database.
  renderAll();
  $('state').textContent = CB_T('loading');

  const ok = await load();
  if (!ok) {
    $('state').textContent = CB_T('loadError');
    $('state').className = 'state bad';
    return;
  }
  renderAll();
})();
