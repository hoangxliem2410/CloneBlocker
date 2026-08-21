/**
 * The translation helper for the hosted pages, and the strings they say.
 *
 * chrome.i18n does not exist outside an extension, so the two halves of this
 * product cannot share a mechanism. They can share a shape: CB_T(key, ...args)
 * with $1-style placeholders, resolving to a locale the page never has to pass
 * in, falling back to a readable string rather than to nothing. Written once in
 * src/common/i18n.js over chrome.i18n, written again here over a plain object,
 * and called identically in both places -- so a person reading public.js and a
 * person reading popup.js are reading the same idiom.
 *
 * Loaded as a classic script before the page script, which is all the CSP in
 * firebase.json permits and all this needs to be.
 */
(function () {
  'use strict';

  // -- the public transparency page ----------------------------------------
  //
  // Vietnamese first, and not merely alphabetically: this list is about
  // Vietnamese-language accounts and is read overwhelmingly by the people
  // being impersonated. English is the second language here, not the neutral
  // one, which is why `base` below is vi and why an untranslated string on
  // this surface falls back to Vietnamese.
  const PUBLIC = {
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
      resultCount: 'Đang hiện $1 trong $2 hồ sơ',
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
      exhibit: 'Bài $1',
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

      tag_clone: 'Nhân bản',
      tag_impersonation: 'Mạo danh',
      tag_scam: 'Lừa đảo',
      tag_harassment: 'Quấy rối',
      tag_spam: 'Spam',
      tag_redbull: 'Bò đỏ',
      tag_other: 'Khác'
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
      resultCount: 'Showing $1 of $2 profiles',
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
      exhibit: 'Post $1',
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

      tag_clone: 'Clone',
      tag_impersonation: 'Impersonation',
      tag_scam: 'Scam',
      tag_harassment: 'Harassment',
      tag_spam: 'Spam',
      tag_redbull: 'Red bull',
      tag_other: 'Other'
    }  };

  /**
   * Every surface, and the language each one is written in first.
   *
   * One entry today. The dashboard is English-only by decision -- it has a
   * single user, and translating an admin tool nobody else opens is upkeep
   * with no reader -- but the day that changes it is a table of strings and
   * one line here, and nothing below this point moves:
   *
   *     dashboard: { base: 'en', locales: ADMIN }
   */
  const DICT = {
    public: { base: 'vi', locales: PUBLIC }
  };

  let surface = DICT.public;
  let lang = surface.base;

  /**
   * Own properties only.
   *
   * Every lookup below is by a name that came from somewhere else -- a key
   * written in the page, a language code read back out of localStorage -- and
   * a plain object answers to `constructor` and `__proto__` whether or not
   * anybody put them there. Without this, setLang('__proto__') would leave the
   * page claiming to be written in a language that does not exist, and
   * CB_T('constructor') would render a function.
   */
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  /**
   * CB_T('resultCount', 12, 40) -> "Đang hiện 12 trong 40 hồ sơ"
   *
   * Two fallbacks, in the order that keeps a page readable. A key the current
   * language has not translated yet resolves in the surface's base language,
   * which is what chrome.i18n does with default_locale and for the same
   * reason: a Vietnamese sentence on an English page is a rough edge, and a
   * blank one is a bug. A key no language has at all resolves to itself, so it
   * shows up in the UI as `resultCount` -- ugly enough that somebody reports
   * it, rather than an empty element nobody notices.
   *
   * Substitution goes through $1 placeholders rather than concatenation at the
   * call site, so a translator may put the number wherever their grammar wants
   * it. Arguments are stringified, matching the extension helper exactly.
   */
  function t(key, ...args) {
    const table = surface.locales[lang];
    const base = surface.locales[surface.base];
    let s = own(table, key) ? table[key] : null;
    if (s == null && own(base, key)) s = base[key];
    if (s == null) return key;
    args.forEach((v, i) => { s = s.split('$' + (i + 1)).join(String(v)); });
    return s;
  }

  globalThis.CB_T = t;

  globalThis.CB_I18N = {
    /** Pick the surface whose strings CB_T resolves against. Once, at boot. */
    use(name) {
      if (!own(DICT, name)) return false;
      surface = DICT[name];
      lang = surface.base;
      return true;
    },

    /** The language in force. */
    lang() { return lang; },

    /**
     * Switch language. Returns the code actually in force, so a caller that
     * was handed a stale value out of localStorage learns it was refused
     * rather than rendering half a page in a language that does not exist.
     */
    setLang(code) {
      if (own(surface.locales, code)) lang = code;
      return lang;
    },

    /**
     * The languages this surface offers, in dictionary order, each labelled in
     * its own words -- a toggle that says "English" in Vietnamese is a toggle
     * for people who already read Vietnamese.
     */
    locales() {
      return Object.keys(surface.locales)
        .map(code => ({ code, label: surface.locales[code].lang || code }));
    },

    /**
     * Every key this surface defines, in one language -- the base one unless
     * another is named. Lets a page derive a list from the dictionary instead
     * of re-declaring one beside it (the tag chips are built this way, so a
     * tag that gains a label gains a chip by itself), and lets tools/check.js
     * ask each language what it holds rather than being told what to expect.
     */
    keys(code) {
      return Object.keys(own(surface.locales, code)
        ? surface.locales[code]
        : surface.locales[surface.base]);
    }
  };
})();
