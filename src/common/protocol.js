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

  const DEFAULT_SETTINGS = {
    // Where the blocklist comes from.
    listUrl: '',
    listAuthHeader: '',      // optional "Authorization: ..." value
    refreshMinutes: 60,

    // Reporting. apiBase is derived from listUrl when left blank, so the common
    // case needs no extra configuration.
    apiBase: '',
    reportUiEnabled: true,   // the in-page report affordance on profiles
    reportHoverDelayMs: 350,
    reporterId: '',          // set on first use; identifies repeat reports
    submitToken: '',         // only if the server was started with --submit-token

    // Layer 1 -- DOM suppression. Always safe; on by default.
    hideEnabled: true,
    hideMode: 'collapse',    // 'collapse' | 'placeholder' | 'blur'
    hideComments: true,
    hideFeedPosts: true,

    // Layer 2 -- real platform blocks. Off by default: it mutates the
    // account and is rate-limit sensitive.
    platformBlockEnabled: false,
    platformBlockDryRun: true,

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

    // How many ranked targets to ask the server for, and whether to accept
    // any at all. With this off the extension only ever blocks what you see.
    acceptServerTargets: true,
    targetBudget: 25,
    // Sent with the blocklist request so the server can rank by where a clone
    // is actually operating. Coarse by construction: a time zone and a language
    // tag, both of which the browser already tells every site you visit.
    shareRegion: true,

    debug: false
  };

  globalThis.CB_PROTOCOL = PROTOCOL;
  globalThis.CB_KEYS = KEYS;
  globalThis.CB_DEFAULT_SETTINGS = DEFAULT_SETTINGS;
})();
