/**
 * The one translation helper, shared by every surface the extension paints.
 *
 * chrome.i18n already does the work; this exists to give it a short name, one
 * argument shape, and one behaviour that matters more than either: a message
 * that is missing falls back to its KEY, never to empty text. A button reading
 * `popup_reportButton` is an obvious bug somebody reports on sight; a blank
 * button just looks broken and gets lived with.
 *
 * Loaded before the page scripts on every extension page, first in the
 * content-script bundle, and imported first by the service worker, so
 * everything downstream may assume CB_T exists. It tolerates chrome.i18n being
 * absent on purpose: protocol.js loads this vocabulary too, and protocol.js is
 * also read by the Node harnesses, where there is no extension API at all.
 */
(function () {
  'use strict';

  const i18n = (typeof chrome !== 'undefined' && chrome.i18n &&
                typeof chrome.i18n.getMessage === 'function') ? chrome.i18n : null;

  /**
   * CB_T('activity_needsTabMany', 4) -> "4 profiles from the list are waiting…"
   *
   * Substitution goes through getMessage's own $1 placeholders rather than
   * through concatenation at the call site, because a sentence glued together
   * out of translated fragments is a sentence no other language may reorder --
   * and Vietnamese reorders almost all of them. Arguments are stringified
   * first: getMessage silently drops a number.
   */
  function t(key, ...args) {
    if (!i18n) return key;
    return i18n.getMessage(key, args.map(String)) || key;
  }

  /**
   * A message may mark part of itself as emphasis (`<b>…</b>`) or as code
   * (`<c>…</c>`). That is the whole markup vocabulary, and the text is rebuilt
   * here out of nodes this function creates, so a translation can never
   * introduce an element of its own -- nothing is ever parsed as HTML.
   *
   * The alternative was to cut every emphasised sentence into three keys and
   * glue them back together in the page, which is exactly the concatenation
   * the rest of this file exists to avoid. This way the emphasis travels with
   * the sentence and a translator may put it wherever their grammar wants it.
   */
  const MARKED = /<(b|c)>([\s\S]*?)<\/\1>/g;
  const ELEMENT_FOR = { b: 'strong', c: 'code' };

  function fill(el, text) {
    el.textContent = '';
    let at = 0, m;
    MARKED.lastIndex = 0;
    while ((m = MARKED.exec(text))) {
      if (m.index > at) el.appendChild(document.createTextNode(text.slice(at, m.index)));
      const inner = document.createElement(ELEMENT_FOR[m[1]]);
      inner.textContent = m[2];
      el.appendChild(inner);
      at = m.index + m[0].length;
    }
    if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
  }

  /**
   * Translate the static markup of a page (or of one subtree).
   *
   * The pages carry `data-i18n` attributes and no text of their own, which is
   * what lets tools/check.js prove that a string added to a page later cannot
   * quietly skip translation.
   */
  function apply(scope) {
    const root = scope || document;
    for (const el of root.querySelectorAll('[data-i18n]')) fill(el, t(el.dataset.i18n));
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    }
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      el.title = t(el.dataset.i18nTitle);
    }
    for (const el of root.querySelectorAll('[data-i18n-label]')) {
      el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    }
  }

  globalThis.CB_T = t;
  globalThis.CB_FILL_I18N = fill;
  globalThis.CB_APPLY_I18N = apply;

  // Extension pages only. This file also runs as a content script at
  // document_start, and there the document belongs to Facebook or Threads:
  // sweeping their DOM would find nothing (our in-page UI lives in a shadow
  // root and translates itself) and rewriting their <html lang> would be
  // vandalism.
  if (typeof document !== 'undefined' && location.protocol === 'chrome-extension:') {
    const run = () => {
      // Says what the page is actually written in, which is what spellcheck,
      // hyphenation and a screen reader's voice all key off.
      if (i18n) document.documentElement.lang = i18n.getMessage('@@ui_locale').replace(/_/g, '-');
      apply(document);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
  }
})();
