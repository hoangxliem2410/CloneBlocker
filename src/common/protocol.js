/**
 * Shared constants for the MAIN <-> ISOLATED world bridge and the
 * ISOLATED <-> service-worker message channel.
 *
 * Loaded as a plain (non-module) content script, so it publishes onto the
 * isolated world's global object. The MAIN-world script keeps its own copy of
 * the wire strings, because the two worlds cannot share JS objects at all --
 * only structured-cloneable messages via window.postMessage.
 */
(function () {
  'use strict';

  const PROTOCOL = {
    // window.postMessage envelope marker. Every bridge frame carries this.
    MARK: '__cloneblocker_bridge__',

    // Handshake. MAIN announces readiness; ISOLATED replies with a session
    // nonce that both sides then require on every subsequent frame.
    MAIN_READY: 'main:ready',
    HELLO: 'iso:hello',
    HELLO_ACK: 'main:hello-ack',

    // ISOLATED -> MAIN
    RESOLVE_IDS: 'iso:resolve-ids',        // ask MAIN to identify authors of DOM nodes
    PLATFORM_BLOCK: 'iso:platform-block',  // ask MAIN to run a real block mutation
    PROBE_CAPABILITY: 'iso:probe',         // ask MAIN what block strategies are available
    DUMP_MODULES: 'iso:dump-modules',      // debug: list registered modules matching a pattern
    SET_CONFIG: 'iso:set-config',

    // MAIN -> ISOLATED
    IDENTITY: 'main:identity',             // author id/username discovered for a node
    STORE_SNAPSHOT: 'main:store-snapshot', // batch of user records from the Relay store
    BLOCK_RESULT: 'main:block-result',
    CAPABILITY: 'main:capability',
    MODULES: 'main:modules',
    VIEWER: 'main:viewer',                 // logged-in user id

    // ISOLATED/popup/options <-> service worker (chrome.runtime.sendMessage)
    SW: {
      GET_STATE: 'sw:get-state',
      GET_BLOCKLIST: 'sw:get-blocklist',
      REFRESH_NOW: 'sw:refresh-now',
      GET_SETTINGS: 'sw:get-settings',
      SET_SETTINGS: 'sw:set-settings',
      REPORT_STATS: 'sw:report-stats',
      ENQUEUE_PLATFORM_BLOCK: 'sw:enqueue-platform-block',
      QUEUE_CLAIM: 'sw:queue-claim',       // content script asks for next queued target
      QUEUE_RESULT: 'sw:queue-result',

      // Clone reporting. Users submit; an admin reviews and decides.
      SUBMIT_REPORT: 'sw:submit-report',
      REPORT_STATUS: 'sw:report-status',
      BLOCKLIST_UPDATED: 'sw:blocklist-updated', // SW -> tabs broadcast
      LOG: 'sw:log'
    }
  };

  /**
   * The one tag vocabulary, shared with hosting/logic.js and firestore.rules.
   *
   * A reporter's `reason` is a vote and a target's `tag` is the verdict, but
   * they are the same words -- which is what lets a verdict be derived from
   * the votes at all.
   *
   * Order is load-bearing three times over, so it is a decision rather than a
   * tidy-up: it is the order every list of them is shown in, the FIRST entry
   * is what the report sheet offers before anyone touches it, and ties between
   * equally popular reasons break towards whatever comes first.
   *
   * 'redbull' leads because it is what this deployment is mostly used to
   * report; putting the common case first is the difference between a reporter
   * confirming a pre-filled answer and hunting through a list every time. New
   * tags go before 'other', which stays the bucket of last resort.
   */
  const TAGS = ['redbull', 'clone', 'impersonation', 'scam', 'harassment', 'spam', 'other'];

  /**
   * The label for each tag. One dictionary rather than one per page, because
   * three copies of "Scam or fraud" is three chances for the report sheet, the
   * options page and the activity chips to end up naming the same thing
   * differently -- and a user who ticks a box has to be able to recognise it
   * in the sheet they filled in. Now that there are two languages, it is also
   * three chances to translate one of them and forget the others.
   */
  const TAG_LABELS_EN = {
    clone: 'Clone / fake account',
    impersonation: 'Impersonating someone',
    scam: 'Scam or fraud',
    harassment: 'Harassment',
    spam: 'Spam',
    redbull: 'Redbull',
    other: 'Something else'
  };

  /**
   * Resolved through CB_T, so one vocabulary serves both languages -- with the
   * English above as the fallback rather than the key.
   *
   * CB_T answers with the key when a message is missing, which is what you want
   * for a control that would otherwise render blank. It is not what you want
   * here: this file is also loaded by the Node harnesses and by anything that
   * imports the protocol without an extension around it, and a report sheet
   * offering "tag_redbull" as a reason would be worse than one offering plain
   * English. So a key echoed straight back is read as "no translation
   * available" and the English wins.
   */
  function tagLabel(tag) {
    const key = 'tag_' + tag;
    const t = globalThis.CB_T;
    const label = t ? t(key) : key;
    return label === key ? (TAG_LABELS_EN[tag] || tag) : label;
  }

  /**
   * Resolved on READ, not once at load.
   *
   * This used to be a plain object built in a loop right here, which froze
   * every label in whatever language was in force the instant protocol.js
   * parsed -- before the language override had been fetched from storage. The
   * result was a report sheet whose headings and buttons were Vietnamese and
   * whose reason list was English: the one part of that dialog somebody has to
   * read carefully, in the wrong language. A getter per tag costs nothing and
   * cannot go stale.
   */
  const TAG_LABELS = {};
  for (const tag of TAGS) {
    Object.defineProperty(TAG_LABELS, tag, {
      enumerable: true,
      get: () => tagLabel(tag)
    });
  }

  // Storage keys (chrome.storage.local unless noted).
  const KEYS = {
    SETTINGS: 'settings',          // sync
    BLOCKLIST: 'blocklist',        // local: { ids, usernames, etag, fetchedAt, source }
    QUEUE: 'platformQueue',        // local: pending real-block targets
    DONE: 'platformDone',          // local: ids already platform-blocked
    STATS: 'stats',                // local
    LEARNED: 'learnedTemplates',   // local: captured request templates per platform
    REPORTED: 'reportedCache'      // local: { key: {status,count,blocked,at} }
  };

  // The blocklist lives at one address, baked in. It used to be a text field,
  // which made the first thing a new user saw a question they had no way to
  // answer. Overridable through storage (the harnesses do exactly that) but
  // no UI writes it any more.
  const LIST_URL =
    'https://firestore.googleapis.com/v1/projects/clone-blocker2/databases/(default)/documents/blocklist/current';

  const DEFAULT_SETTINGS = {
    listUrl: LIST_URL,
    listAuthHeader: '',      // optional "Authorization: ..." value
    refreshMinutes: 60,

    // Reporting. apiBase is derived from listUrl when left blank, so the common
    // case needs no extra configuration.
    apiBase: '',
    /**
     * Which language the extension's own pages speak.
     *
     * 'auto' means whatever the browser is set to, which is what chrome.i18n
     * does on its own and is right for almost everybody. The override exists
     * because it is NOT right for everybody: plenty of people run an
     * English-language Chrome and would rather read Vietnamese, and Chrome
     * offers no per-extension language control -- changing it means changing
     * the whole browser and restarting it.
     *
     * One thing the override cannot reach: the extension's name and
     * description in chrome://extensions and the Web Store come from the
     * manifest, which Chrome resolves before any of our code runs.
     */
    uiLanguage: 'auto',      // 'auto' | 'en' | 'vi'

    reportUiEnabled: true,   // the in-page report affordance on profiles
    // Reporting and blocking are usually the same intent: the person filing
    // the report wants this account gone from their feed now, not once a
    // moderator has read it. So the sheet offers both at once and ticks it by
    // default. It is a remembered preference rather than a fresh default each
    // time -- someone who unticks it means it.
    reportAlsoBlocks: true,
    reportHoverDelayMs: 350,
    reporterId: '',          // set on first use; identifies repeat reports
    submitToken: '',         // only if the server was started with --submit-token

    /**
     * What the extension is allowed to block. Two independent switches, not
     * two halves of one dial.
     *
     *   blockSeen     -- profiles that turn up on the page while you browse.
     *                    They were on your screen anyway, which is the pattern
     *                    the platform finds unremarkable, so these go quickly.
     *   blockFromList -- the ranked list itself: accounts that are active near
     *                    you but that you may never scroll past. Never on your
     *                    screen, which is the pattern that draws a checkpoint,
     *                    so these are paced slowly under a tighter ceiling.
     *
     * These used to be one `mode` with values 'passive' and 'active', which
     * said they were alternatives. They never were -- the old 'active' meant
     * BOTH -- and the radio buttons made "work the list but leave what I scroll
     * past alone" unsayable. Two tick boxes say what is actually true.
     */
    blockSeen: true,
    blockFromList: true,

    /**
     * Which kinds of account this install is willing to spend a block on.
     *
     * An array matched by inclusion rather than a map of flags, so a tag added
     * in a later release is NOT blocked by an existing install until its owner
     * ticks it. A new category must never start acting on its own.
     *
     * Hiding ignores this entirely: everything approved is hidden regardless.
     * Hiding is free and reversible, so rationing it by kind would buy nothing
     * and only make the list look incomplete.
     */
    blockTags: TAGS.slice(),

    // DOM suppression: hide a listed profile's content without touching your
    // account. Off by default -- real blocks are the product; this is for
    // people who also want the whole list gone from view immediately,
    // including profiles they will never scroll past.
    hideEnabled: false,
    hideMode: 'collapse',    // 'collapse' | 'placeholder' | 'blur'
    hideComments: true,
    hideFeedPosts: true,

    // The master switch behind the modes. On by default: the pacing, the
    // ceilings and the randomised delays are the safety mechanism now, and
    // they ship at cautious values. Surfaced as "Pause blocking" rather than
    // as a mode. (Test harnesses force this off -- a test run must never
    // block anyone for real.)
    platformBlockEnabled: true,
    platformBlockDryRun: false,

    // Raw request fallbacks (hand-built GraphQL, Instagram REST). OFF by
    // default and deliberately so: hand-crafted requests carrying CSRF tokens
    // to Meta endpoints were observed forcing the signed-in session to log
    // out, while driving the site's own Relay code never did. Without this,
    // only the platform's own code path is used.
    allowRawNetworkFallback: false,
    maxBlocksPerHour: 15,
    maxBlocksPerDay: 60,
    // Cold targets -- ones the server nominated that this browser has never
    // seen -- get a much tighter ceiling of their own. A run of blocks against
    // strangers is the pattern that draws a checkpoint; blocking someone whose
    // profile is on the screen in front of you is not.
    maxColdBlocksPerHour: 4,
    minDelayMs: 20000,       // between cold blocks
    maxDelayMs: 45000,
    warmMinDelayMs: 4000,    // between blocks of profiles that were on screen
    warmMaxDelayMs: 11000,

    // How many ranked targets to take at a time. Whether to take any at all
    // is `mode`; this is only the batch size.
    targetBudget: 25,
    // Sent with the blocklist request so the server can rank by where a clone
    // is actually operating. Coarse by construction: a time zone and a language
    // tag, both of which the browser already tells every site you visit.
    shareRegion: true,

    debug: false
  };

  /**
   * Which mode is in force, tolerating settings written before modes existed.
   *
   * `acceptServerTargets: false` was the old way to say "only block what I
   * see", so an install carrying it lands in passive rather than silently
   * gaining a behaviour its owner had turned off.
   */
  function blockModes(settings) {
    const s = settings || {};
    // Explicit pair wins.
    if (typeof s.blockSeen === 'boolean' || typeof s.blockFromList === 'boolean') {
      return { seen: s.blockSeen !== false, fromList: s.blockFromList !== false };
    }
    // Then the single mode that replaced acceptServerTargets, then
    // acceptServerTargets itself. An install that had turned the ranked list
    // off must not gain it back by upgrading; the whole point of reading the
    // old keys is that nobody's settings change under them.
    if (s.mode === 'passive') return { seen: true, fromList: false };
    if (s.mode === 'active') return { seen: true, fromList: true };
    return { seen: true, fromList: s.acceptServerTargets !== false };
  }

  /** Kept so a caller that only wants the old vocabulary still reads right. */
  function modeOf(settings) {
    return blockModes(settings).fromList ? 'active' : 'passive';
  }

  globalThis.CB_LIST_URL = LIST_URL;
  globalThis.CB_MODE_OF = modeOf;
  globalThis.CB_BLOCK_MODES = blockModes;
  globalThis.CB_TAGS = TAGS;
  globalThis.CB_TAG_LABELS = TAG_LABELS;
  globalThis.CB_PROTOCOL = PROTOCOL;
  globalThis.CB_KEYS = KEYS;
  globalThis.CB_DEFAULT_SETTINGS = DEFAULT_SETTINGS;
})();
