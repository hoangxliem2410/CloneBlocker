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
 * The dictionary is the whole top of the file on purpose. Phase 6 lifts it
 * into hosting/i18n.js as-is; keeping it in one object, with no string
 * anywhere below it, is what makes that a move rather than a rewrite.
 */

// -- strings ----------------------------------------------------------------

const STRINGS = {
  vi: {
    lang: 'Tiếng Việt',
    brand: 'clone-blocker / công khai',

    introEyebrow: 'Danh sách công khai',
    title: 'Những tài khoản đã bị báo cáo, xem xét và công bố',
    lede: 'Đây là danh sách các tài khoản Facebook và Threads mà người dùng đã báo cáo là nhân bản, mạo danh, lừa đảo hoặc quấy rối. Mỗi hồ sơ trên trang này đều đã được một người đọc và quyết định công bố.',
    lede2: 'Đây không phải là phán quyết của Facebook hay Threads, và cũng không phải kết quả của một thuật toán.',

    howEyebrow: 'Một hồ sơ lên đây bằng cách nào',
    step1t: 'Người dùng báo cáo',
    step1b: 'Người cài tiện ích gửi báo cáo về một tài khoản, kèm đường dẫn tới bài viết làm bằng chứng.',
    step2t: 'Một người xem xét',
    step2b: 'Không có gì tự động lên đây. Một quản trị viên đọc báo cáo cùng bằng chứng rồi tự quyết định.',
    step3t: 'Chỉ công bố khi có người quyết định công bố',
    step3b: 'Bị chặn và bị nêu tên là hai quyết định khác nhau. Phần lớn tài khoản bị chặn không bao giờ xuất hiện ở đây.',

    statPublished: 'Nêu tên tại đây',
    statBlocked: 'Tổng số bị chặn',
    statReports: 'Báo cáo đã nhận',
    statNote: 'Con số ở giữa là toàn bộ danh sách chặn. Con số bên trái là phần đã có người quyết định nêu tên công khai — luôn nhỏ hơn nhiều, và đó là chủ ý.',

    registerEyebrow: 'Hồ sơ',
    filterLabel: 'Lọc theo nhãn',
    filterAll: 'Tất cả',
    searchPlaceholder: 'Tìm theo tên, @tên người dùng hoặc ID…',
    searchLabel: 'Tìm trong danh sách',
    resultCount: 'Đang hiện {n} trong {total} hồ sơ',
    loading: 'Đang tải danh sách…',
    loadError: 'Không đọc được danh sách. Hãy tải lại trang sau ít phút.',
    emptyList: 'Chưa có hồ sơ nào được công bố.',
    emptyFilter: 'Không có hồ sơ nào khớp. Hãy chọn lại nhãn hoặc tìm từ khoá khác.',

    unnamed: 'Không có tên hiển thị',
    noUsername: 'không có tên người dùng',
    factReports: 'Số người báo cáo',
    factFirst: 'Báo cáo lần đầu',
    factLast: 'Hoạt động gần nhất',
    factRegions: 'Khu vực',
    evidenceEyebrow: 'Bằng chứng',
    exhibit: 'Bài {n}',
    noEvidence: 'Hồ sơ này không có đường dẫn bài viết nào được công bố.',
    none: '—',

    noticeTitle: 'Cần đọc trước khi tin trang này',
    noticeAnon: 'Người báo cáo là ẩn danh. Trang này không bao giờ cho biết ai đã báo cáo một tài khoản, và chúng tôi cũng không công bố số liệu nào có thể chỉ ra họ — chỉ có tổng số người báo cáo khác nhau.',
    noticeJudgement: 'Việc bị nêu tên ở đây là nhận định của một người, không phải phán quyết của Facebook hay Threads. Chúng tôi có thể sai, và đôi khi đã sai.',
    noticeAppealBefore: 'Nếu bạn cho rằng mình bị nêu tên nhầm, hãy mở một issue tại ',
    noticeAppealAfter: '. Chúng tôi sẽ xem lại và gỡ hồ sơ nếu không đủ căn cứ.',

    footUpdated: 'Cập nhật lần cuối',
    footSourceStatic: 'nguồn: bản sao tĩnh',
    footSourceLive: 'nguồn: đọc trực tiếp',

    tags: {
      clone: 'Nhân bản',
      impersonation: 'Mạo danh',
      scam: 'Lừa đảo',
      harassment: 'Quấy rối',
      spam: 'Spam',
      redbull: 'Bò đỏ',
      other: 'Khác'
    }
  },

  en: {
    lang: 'English',
    brand: 'clone-blocker / public',

    introEyebrow: 'Public register',
    title: 'Accounts that were reported, read by a person, and published',
    lede: 'This is a list of Facebook and Threads accounts that people reported as clones, impersonators, scams or harassment. Every profile on this page was read by a person, who then decided to publish it.',
    lede2: 'It is not a ruling by Facebook or Threads, and it is not the output of an algorithm.',

    howEyebrow: 'How a profile gets here',
    step1t: 'Someone reports it',
    step1b: 'A person using the extension reports an account and links the posts that show why.',
    step2t: 'A person reviews it',
    step2b: 'Nothing arrives here automatically. A moderator reads the reports and the evidence and decides.',
    step3t: 'Published only when someone decides to publish it',
    step3b: 'Blocking an account and naming it are two different decisions. Most blocked accounts never appear here.',

    statPublished: 'Named here',
    statBlocked: 'Blocked in total',
    statReports: 'Reports received',
    statNote: 'The middle number is the whole blocklist. The left one is the part a person chose to name in public — far smaller, deliberately.',

    registerEyebrow: 'Profiles',
    filterLabel: 'Filter by tag',
    filterAll: 'All',
    searchPlaceholder: 'Search by name, @username or ID…',
    searchLabel: 'Search the list',
    resultCount: 'Showing {n} of {total} profiles',
    loading: 'Loading the list…',
    loadError: 'Could not read the list. Reload the page in a few minutes.',
    emptyList: 'No profile has been published yet.',
    emptyFilter: 'Nothing matches. Pick another tag or search for something else.',

    unnamed: 'No display name',
    noUsername: 'no username',
    factReports: 'Unique reporters',
    factFirst: 'First reported',
    factLast: 'Last active',
    factRegions: 'Regions',
    evidenceEyebrow: 'Evidence',
    exhibit: 'Post {n}',
    noEvidence: 'No post links are published for this profile.',
    none: '—',

    noticeTitle: 'Read this before you believe this page',
    noticeAnon: 'Reporters are anonymous. This page never says who reported an account, and publishes no figure that could narrow it down — only how many different people did.',
    noticeJudgement: 'Being listed here is one person’s judgement, not a ruling by Facebook or Threads. We can be wrong, and we have been.',
    noticeAppealBefore: 'If you believe you are listed here by mistake, open an issue at ',
    noticeAppealAfter: '. We will look again and take the profile down if the case is not strong enough.',

    footUpdated: 'Last updated',
    footSourceStatic: 'source: static mirror',
    footSourceLive: 'source: live read',

    tags: {
      clone: 'Clone',
      impersonation: 'Impersonation',
      scam: 'Scam',
      harassment: 'Harassment',
      spam: 'Spam',
      redbull: 'Red bull',
      other: 'Other'
    }
  }
};

// Where a person who believes they are listed in error goes. Named as a
// constant so the note and any future page can never quote different ones.
const ISSUES_URL = 'https://github.com/hoangxliem2410/CloneBlocker/issues';

// The tag order the chips follow, taken from the dictionary rather than
// re-declared, so a tag added to the labels shows up in the filter by itself.
// Anything in the data that is not in here still renders, appended, under its
// raw name: an unlabelled tag must never make a profile invisible.
const TAG_ORDER = Object.keys(STRINGS.vi.tags);

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

let lang = 'vi';
let view = null;        // the publicView payload, once read
let source = null;      // 'static' | 'live', for the footer
let tagFilter = '';     // '' means every tag
let query = '';

const $ = (id) => document.getElementById(id);

// -- helpers ----------------------------------------------------------------

function t(key, vars) {
  const table = STRINGS[lang] || STRINGS.vi;
  let s = table[key];
  if (s == null) s = STRINGS.vi[key];
  if (s == null) return key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

function tagLabel(tag) {
  const table = (STRINGS[lang] || STRINGS.vi).tags;
  return table[tag] || tag;
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
  if (!isFinite(v)) return t('none');
  try { return new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US').format(v); }
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
  if (!m) return t('none');
  return lang === 'vi' ? m[3] + '/' + m[2] + '/' + m[1] : m[1] + '-' + m[2] + '-' + m[3];
}

/** An ISO instant down to the minute, in UTC, for the footer. */
function fmtStamp(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso || ''));
  if (!m) return t('none');
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
  for (const code of ['vi', 'en']) {
    const b = el('button', null, code.toUpperCase());
    b.type = 'button';
    b.setAttribute('aria-pressed', String(code === lang));
    b.title = STRINGS[code].lang;
    b.addEventListener('click', () => setLang(code));
    box.appendChild(b);
  }
}

function renderIntro() {
  const box = $('intro');
  clear(box);
  box.appendChild(el('p', 'eyebrow', t('introEyebrow')));
  box.appendChild(el('h1', null, t('title')));
  box.appendChild(el('p', 'lede', t('lede')));
  box.appendChild(el('p', 'lede', t('lede2')));

  const list = el('ol', 'steps');
  [['step1t', 'step1b'], ['step2t', 'step2b'], ['step3t', 'step3b']].forEach((pair, i) => {
    const li = el('li', 'step');
    li.appendChild(el('span', 'n', String(i + 1)));
    li.appendChild(el('h3', null, t(pair[0])));
    li.appendChild(el('p', null, t(pair[1])));
    list.appendChild(li);
  });
  box.appendChild(el('p', 'eyebrow howhd', t('howEyebrow')));
  box.appendChild(list);
}

function renderNotice() {
  const box = $('notice');
  clear(box);
  box.appendChild(el('h2', null, t('noticeTitle')));
  box.appendChild(el('p', null, t('noticeAnon')));
  box.appendChild(el('p', null, t('noticeJudgement')));

  // Built out of three nodes rather than one string with markup in it: the
  // whole page holds the line that no HTML is ever assembled from text.
  const appeal = el('p');
  appeal.appendChild(document.createTextNode(t('noticeAppealBefore')));
  const a = link(ISSUES_URL);
  if (a) appeal.appendChild(a);
  else appeal.appendChild(document.createTextNode(ISSUES_URL));
  appeal.appendChild(document.createTextNode(t('noticeAppealAfter')));
  box.appendChild(appeal);
}

function renderFoot() {
  const box = $('foot');
  clear(box);
  if (!view) return;
  box.appendChild(document.createTextNode(t('footUpdated') + ' ' + fmtStamp(view.updatedAt)));
  box.appendChild(el('span', 'sep', '·'));
  box.appendChild(document.createTextNode(
    source === 'static' ? t('footSourceStatic') : t('footSourceLive')));
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
    d.appendChild(el('div', 'sk', t(key)));
    return d;
  };
  grid.appendChild(tile('lead', counts.published, 'statPublished'));
  grid.appendChild(tile('', counts.blocked, 'statBlocked'));
  grid.appendChild(tile('', counts.reports, 'statReports'));
  box.appendChild(grid);
  box.appendChild(el('p', 'statnote', t('statNote')));
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
  filter.appendChild(el('span', 'eyebrow', t('filterLabel')));

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

  filter.appendChild(chip('', t('filterAll'), (view.profiles || []).length));
  for (const [tag, n] of present) filter.appendChild(chip(tag, tagLabel(tag), n));
  box.appendChild(filter);

  const wrap = el('div', 'searchwrap');
  const input = el('input');
  input.type = 'search';
  input.value = query;
  input.placeholder = t('searchPlaceholder');
  input.setAttribute('aria-label', t('searchLabel'));
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
    : el('h3', 'name unnamed', t('unnamed'));
  head.appendChild(name);
  head.appendChild(el('span', 'tag ' + tagClass(tag), tagLabel(tag)));
  card.appendChild(head);

  const ident = el('p', 'ident');
  ident.appendChild(document.createTextNode(
    p.username ? '@' + p.username : '(' + t('noUsername') + ')'));
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
    d.appendChild(el('div', 'k', t(key)));
    d.appendChild(el('div', 'v' + (big ? ' big' : ''), value));
    return d;
  };
  facts.appendChild(fact('factReports', num(p.reports), true));
  facts.appendChild(fact('factFirst', fmtDay(p.firstReported)));
  facts.appendChild(fact('factLast', fmtDay(p.lastActive)));
  // Region identifiers are printed whole, underscores opened out: "Asia/Ho Chi
  // Minh" says where without inviting the guess that "Ho Chi Minh" alone does.
  const regions = (p.regions || []).map(r => String(r).replace(/_/g, ' '));
  facts.appendChild(fact('factRegions', regions.length ? regions.join(', ') : t('none')));
  card.appendChild(facts);

  const ev = el('div', 'evidence');
  ev.appendChild(el('p', 'eyebrow', t('evidenceEyebrow')));
  const usable = (p.evidence || []).filter(e => e && link(e.url));
  if (!usable.length) {
    ev.appendChild(el('p', 'noevidence', t('noEvidence')));
  } else {
    usable.forEach((e, i) => {
      const row = el('div', 'exhibit');
      row.appendChild(el('span', 'en', t('exhibit', { n: i + 1 })));
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
  line.textContent = t('resultCount', { n: num(shown.length), total: num(all.length) });

  if (!all.length) { state.textContent = t('emptyList'); state.className = 'state'; }
  else if (!shown.length) { state.textContent = t('emptyFilter'); state.className = 'state'; }
  else state.textContent = '';
}

// -- language ---------------------------------------------------------------

const LANG_KEY = 'cb.public.lang';

function readLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'vi' || saved === 'en') return saved;
  } catch (e) { /* private mode, or storage denied: fall through to the default */ }
  // Vietnamese by default because the list is about Vietnamese-language
  // accounts and is read overwhelmingly by their targets; English is the
  // second language here, not the neutral one.
  return 'vi';
}

function setLang(next) {
  if (next !== 'vi' && next !== 'en') return;
  lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* nothing to do */ }
  document.documentElement.lang = next;
  renderAll();
}

function renderAll() {
  // The tab title is a string like any other: a reader who switches to English
  // and then looks at their tabs should not find the Vietnamese one there.
  document.title = 'Clone Blocker — ' + t('introEyebrow');
  renderLangToggle();
  $('brandName').textContent = t('brand');
  $('registerHd').textContent = t('registerEyebrow');
  renderIntro();
  renderNotice();
  renderStats();
  renderControls();
  renderCards();
  renderFoot();
}

// -- boot -------------------------------------------------------------------

(async function boot() {
  lang = readLang();
  document.documentElement.lang = lang;

  // The prose renders before the fetch resolves: the explanation of what this
  // list is and the note about being listed in error are the parts a person who
  // believes they are on it needs, and they must not wait on a database.
  renderAll();
  $('state').textContent = t('loading');

  const ok = await load();
  if (!ok) {
    $('state').textContent = t('loadError');
    $('state').className = 'state bad';
    return;
  }
  renderAll();
})();
