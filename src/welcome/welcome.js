/**
 * The tab that opens once, the first time the extension is installed.
 *
 * Scope is deliberately one thing: how to block somebody. Not the pacing, not
 * the ceilings, not the hide layer, not the list -- all of which are real and
 * all of which are in Settings, where somebody who wants them will look. A
 * first run that explains everything is a first run nobody finishes, and the
 * one action worth learning on day one is the one the extension is named for.
 *
 * There is no "next" and no state: it is a page, it says three things, and
 * closing it is the whole of finishing it.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Opened in a new tab rather than by navigating this one. Somebody who
  // wants to re-read step 2 after looking at a profile should still have it.
  const open = (url) => chrome.tabs.create({ url });

  $('openFacebook').addEventListener('click', () => open('https://www.facebook.com/'));
  $('openThreads').addEventListener('click', () => open('https://www.threads.com/'));

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
