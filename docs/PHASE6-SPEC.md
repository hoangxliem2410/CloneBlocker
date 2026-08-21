# Phase 6 contract — English and Vietnamese

Normative. Done last on purpose: phases 1–5 rewrote most of the UI copy, and
translating a string twice is wasted work.

## The extension

Chrome's own mechanism, because it is the only one that can localise the
extension's *name and description* in the store listing and the browser's own
UI:

```
_locales/en/messages.json     the source of truth for keys
_locales/vi/messages.json
manifest.json    "default_locale": "en",
                 "name": "__MSG_appName__",
                 "description": "__MSG_appDesc__"
```

Key naming: `screen_element`, lowercase with underscores — `popup_reportButton`,
`options_modePassiveTitle`, `activity_needsTab`. Every message carries a
`description` field saying where it appears; a translator with no context
produces confident nonsense.

Substitution uses `chrome.i18n.getMessage(key, [args])` with `$1`-style
placeholders — never string concatenation around a translated fragment, which
produces sentences no other language can reorder.

A three-line helper (`src/common/i18n.js`, loaded before the page scripts):

```js
globalThis.CB_T = (key, ...args) => chrome.i18n.getMessage(key, args.map(String)) || key;
```

Falling back to the key rather than to empty text means a missing translation
shows up as an obvious `popup_reportButton` in the UI instead of a blank
control that looks broken.

**Scope:** popup, options, activity, and the in-page report chip and sheet
(including the reason labels, which are the strings a Vietnamese user is most
likely to be reading). Also the service worker's user-visible error strings —
they surface in the popup and on the activity page, so they must be keys too.

**Not in scope:** log lines behind `settings.debug`, code comments, and
anything only a developer sees.

## The dashboard and the public page

`chrome.i18n` does not exist outside an extension, so these carry a small
hand-rolled dictionary (`hosting/i18n.js`, shared by both):

```js
const DICT = { en: { key: 'text' }, vi: { key: 'text' } };
globalThis.CB_T = (key, ...args) => ...;   // same signature as the extension helper
```

- The **public page** defaults to Vietnamese (its audience is the people being
  impersonated) with an `en`/`vi` toggle that persists in `localStorage`.
- The **dashboard** stays English-only for now; it has one user, and
  translating an admin tool nobody else opens is not worth the maintenance.
  Structure `hosting/i18n.js` so adding it later is only data.

## Vietnamese specifics

- Tag labels: `clone` → *Tài khoản giả mạo*, `impersonation` → *Mạo danh*,
  `scam` → *Lừa đảo*, `harassment` → *Quấy rối*, `spam` → *Spam*, `redbull` →
  *Bò đỏ*, `other` → *Khác*.
- Diacritics are not optional. Every file is UTF-8 without a BOM; verify the
  rendered page, not just the JSON, because a mangled `ế` is invisible in a
  diff and obvious to a reader.
- Do not translate the product name.

## Verification

`tools/check.js` gains:
1. **Key parity** — every key in `_locales/en` exists in `_locales/vi` and vice
   versa, and every key both files carry has a non-empty message.
2. **No orphans** — every `CB_T('key')` used in `src/` exists in `en`, and
   (warning, not failure) every key in `en` is referenced somewhere.
3. **No hardcoded UI strings** — the page HTML files carry no bare
   user-visible text outside elements marked `data-i18n`, so a string added
   later cannot skip translation unnoticed.

And a real render check: load the extension with `--lang=vi`, open the popup
and options, and confirm Vietnamese text actually appears — key parity proves
the files agree, not that the browser picked the locale up.
