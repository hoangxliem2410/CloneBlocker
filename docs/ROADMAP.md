# Roadmap — todo.txt implementation plan

Source: `todo.txt` (owner, 2026-08-21). Items renumbered into build order;
the original numbering is kept in brackets.

**All six phases shipped on 2026-08-21.** This file is a record now, not a
plan: each phase keeps the text it was built from, followed by a **DONE** note
saying where the build actually diverged from it. Where the two disagree, the
note is the truth and the plan above it is history.

---

## Still needs the owner

Two decisions, and nothing else. Neither blocks anything that is built; both
block something that has to happen outside the repository.

1. **Which Google account counts as admin.** The rules hold a uid allowlist,
   and it currently holds exactly one: the email/password account
   `tools/firebase-setup.js` created for itself. A Google sign-in mints a
   *different* uid, so until one is added, signing in with Google reaches the
   dashboard's denied screen — which is built for this and prints the uid it
   saw plus the exact command. Sign in once, then:
   `node tools/firebase-setup.js --add-admin <uid>`.
2. **Whether the `redbull` tag appears in the store listing copy.** It ships in
   the product either way — the vocabulary, the report sheet, the tag filter and
   the public page all carry *Bò đỏ* / *Red bull (state-aligned troll)*. The
   question is only the shop window: a politically-charged category on a public
   listing invites a kind of review attention and user reporting that "scam"
   does not. The listing copy in `docs/CHROME-WEB-STORE.md` §3 does not name it
   today, which is the unmade decision rather than a made one.

## What shipped

| phase | landed in | what it added |
|---|---|---|
| 1 — modes, baked-in list, tab guidance | `db8fe2c` | `mode: passive \| active` as the one primary control, `LIST_URL` compiled in, the "no tab open" badge/banner/note |
| 2 — tags | `7aec010` | one seven-tag vocabulary shared by the rules, `hosting/logic.js` and `protocol.js`; `blockTags` in the extension; tag chip, retag control and tag filter in the dashboard |
| 3 — ranking tune-up | `7aec010` | `rankWeights` published with the list and tuned from the dashboard, with a live top-10 preview; a unique-reporter term that ships at 0 |
| 4 — public transparency site | `acbed3f` | `blocklist/publicView`, the per-target `public` opt-in, the page at the hosting root, `/transparency.json` |
| 5 — Google sign-in | `acbed3f` | `isAdmin()` as a uid allowlist, `--add-admin` / `--list-admins`, a denied screen that tells you your own uid |
| 6 — English + Vietnamese | working tree | `_locales/en` + `_locales/vi` (250 keys each), `CB_T` over `chrome.i18n` and again over `hosting/i18n.js`, `data-i18n` markup, and four locale checks in `check.js` |

Suites at the end of it: `check.js` clean, `queue-test.js` 90, `firebase-test.js`
132, `e2e-test.js` 26, `dashboard-visual.js` green.

The shape that came out the other end: an extension whose one visible choice is
how hard it works, applying a hand-reviewed list it does not have to be told the
address of, filtered by the kinds of account its owner is willing to spend a
block on, in the reader's own language — and, behind it, a moderation dashboard
and a separate public page that names only the accounts a person deliberately
decided to name.

---

## Where the ten items actually stood

Three of them were largely built already and needed re-surfacing, not
rebuilding:

| todo | existing machinery |
|---|---|
| [1] ranking by unique reports, geo, time | `rank = trust × recency × (1+velocity7d) × locality` — trust already sums per-unique-reporter weights, locality is region/language affinity, recency+velocity are the time axis |
| [3][4] passive/active modes | the warm/cold split: warm = on-screen targets at 4–11s pacing, cold = ranked list targets under the 4/hour ceiling |
| [5] "keep a tab open" | true mechanic today — blocks execute through a content script, so no open tab means the cold queue stalls; it just isn't surfaced anywhere |

The genuinely new work: tags, the transparency site, Google sign-in, i18n.

---

## Phase 1 — Product shape: modes, hardcoded source, tab guidance — **DONE**
*(todo 2, 3, 4, 5 — extension only, no schema changes)*

**Shipped 2026-08-21** (`db8fe2c`), with three departures from the plan below.
`mode` became a first-class setting read through `CB_MODE_OF()` rather than a
mapping onto `acceptServerTargets` — that key is gone from the defaults and
survives only as a fallback for installs written before modes existed, so a
legacy install that had server targets switched off lands in passive rather than
silently gaining a behaviour its owner turned off. The README kept its
self-hosting material instead of losing it, moved into the Firebase backend
chapter and cut down, because the accepted payload shapes still have to be
documented somewhere. And the store screenshots were regenerated in the same
commit rather than left for later, so the leftover is smaller than planned: what
still leads with hiding is the one-line store description (`appDesc`), recorded
in `docs/CHROME-WEB-STORE.md` §3, because it is capped at 132 characters in two
languages and is not worth rewriting alone.

One defect surfaced and was fixed on the way: `getSettings` merged the defaults
(`mode: 'active'`) over stored settings before `modeOf` saw them, which made the
back-compat fallback dead code and would have seeded cold targets on a legacy
passive install's first upgrade.

**Hardcode the list source [2].** `LIST_URL` becomes a constant in
`protocol.js`; the whole "Blocklist source" section (endpoint, auth header,
Grant access, refresh interval) leaves the options page. The settings key
stays internally — the harnesses and e2e point it at the emulator through
storage — but no UI writes it. `optional_host_permissions` drops to nothing
(the two required origins cover the product; e2e patches its own manifest
copy for the emulator origin). README loses the self-hosting pitch.

**Passive / Active modes [3][4].** One new setting `mode: 'passive' | 'active'`
(default: active, since real blocking now defaults on) that maps onto existing
switches — passive ⇒ block only what appears on screen, warm pacing,
effectively no rate-limit pressure; active ⇒ warm + ranked cold targets under
the cold ceiling. Options page restructures around one mode picker with two
plain paragraphs; the expert pacing fields fold into a collapsed "Advanced"
block.

**DECIDED (owner, 2026-08-21):** hiding stays but ships **disabled by
default** — the product's default behaviour is real blocks only; the hide
toggle lives in Advanced for those who want the whole list suppressed
instantly. The layer terminology disappears from all UI, and `check.js` fails
the build if it creeps back.

**Tab-open guidance [5].** The popup and activity page check
`chrome.tabs.query` for an open Facebook/Threads tab whenever cold work is
queued: none open ⇒ a plain banner — "Active blocking needs a Facebook or
Threads tab open. N waiting." Plus a toolbar badge count on the same
condition. (A pinned background tab or offscreen document would remove the
constraint entirely — out of scope, noted as future work.)

## Phase 2 — Tags — **DONE**
*(todo 6, 8 — rules, logic, dashboard, extension, in that order)*

**Shipped 2026-08-21** (`7aec010`, together with phase 3 — the two touch the
same published payload, and splitting the commit would have meant publishing a
target shape twice). Built as planned, with two decisions the plan did not
anticipate. The popup's **Block now** carries `userInitiated` and bypasses the
tag filter: the content-script sweep forwards every listed id it passes, so
scrolling past one is not a decision about it, but pressing a button labelled
Block now is — and silently dropping that click would leave a dead button and no
explanation. And a manually-listed id, which has no reports and therefore no
verdict to derive, is published as `other` rather than `clone`: it is the tag
every install blocks by default but the first one an owner narrowing their tags
would drop, which is the right way round for an entry nobody voted on.

The report `reason` enum is the seed of the taxonomy. It becomes the
per-target `tag`, admin-overridable.

- **Schema:** add `redbull` to the reasons enum (rules + report sheet;
  vi label "Bò đỏ", en label "Red bull (state-aligned troll)"). Decision
  docs gain an optional `tag` field (admin override); `aggregate()` keeps
  reason tallies per target; effective tag = admin override ‖ modal reason.
- **Publish:** targets carry `tag`; a parallel `idTags: {id: tag}` map covers
  the flat ids array so warm blocking can filter too.
- **Dashboard:** tag chip on queue rows, a retag control, tag filter tab.
- **Extension:** `blockTags` multi-select in options (default: all tags).
  Filters cold seeding AND warm enqueue; hiding remains tag-blind (hide
  everything approved — cheap and safe).

**Store-listing note [8]:** a politically-charged category on a public
listing invites a different kind of review attention and user reporting
than "scam" does. The tag ships in the product; whether it appears in the
store screenshots/description is a separate marketing decision — still open,
restated at the top of this file.

## Phase 3 — Ranking tune-up — **DONE**
*(todo 1 — mostly logic.js + published payload)*

**Shipped 2026-08-21** (`7aec010`). Built as planned, and deliberately tuned
nothing: the dials ship at the values that reproduce the old hardcoded
expression term for term, and `uniqueReporterBoost` ships at **0**, which makes
its factor exactly 1 and the formula byte-identical to what it was. This phase
made the dials exist. Proven rather than asserted — a 60-target fixture ranked
through HEAD's `logic.js` and through the working tree across five contexts,
compared by exact JSON, plus a check that the two rankers (`hosting/logic.js`
and the service worker's deliberate duplicate) agree at defaults *and* at raised
weights. The published set also gained `localityLangFactor`, which the plan did
not list: the locality term always weighed language differently from region, and
a dial set that could not express that would have been a dial set nobody could
reproduce today's ranking with.

- Publish `rankWeights` in the payload (`{halfLifeDays, velocityWeight,
  localityFloor, localityLangFactor, uniqueReporterBoost}`) with today's values
  as defaults, so the owner tunes ranking from the dashboard without shipping
  extension updates. The SW ranks with published weights when present.
- Add an explicit unique-reporter term: today two reporters ≈ trust 1.5 vs
  one ≈ 0.75 (linear in trust). Option: `(1 + log2(uniqueReporters))`
  multiplier so 4 independent reporters outrank one high-trust reporter —
  A/B-able via the published weights rather than hardcoded.
- Port the same weights into the dashboard's preview so what the admin sees
  is what clients compute.

## Phase 4 — Public transparency site — **DONE**
*(todo 9 — hosting + publish pipeline)*

**Shipped 2026-08-21** (`acbed3f`, with phase 5). Two departures. The page is
the hosting **root** rather than `/list.html` behind a landing index — a landing
page whose only job is to link to one page is a page nobody reads — and the
dashboard moved to `/admin/`. And evidence rules got stricter than "consider":
an evidence entry without an **https** link is dropped rather than published,
because a quoted summary with no post behind it is an unverifiable claim about a
named person, and region **names** are published with no counts at all, because
"two reports from Asia/Ho_Chi_Minh" narrows down a reporter in a way the bare
name does not.

`blocklist/current` and `blocklist/publicView` are written in **one commit**, so
the page can never name someone the list beside it has already dropped;
`publish-static.js` mirrors both for the same reason. The page renders text
strangers wrote about named people, so it was attacked before it was believed:
script tags, an `img` onerror, a `javascript:` href and an HTML-shaped display
name, all seeded and rendered — nothing executed, no `img` element existed, the
hostile href never reached the DOM, and every payload appeared as literal text.

`https://clone-blocker2.web.app/` grows a public page (`/list.html`, linked
from a small landing index; the admin dashboard moves under `/admin/`):

- **Data:** publish writes a second doc `blocklist/publicView` — approved
  targets only, each with displayName/username/id, tag, report count,
  first-reported / last-active days, and evidence (post links + quoted
  summaries). Reporter identities never appear (hashes stay admin-only).
  The static-snapshot tool mirrors it to `/transparency.json` for the CDN.
- **Page:** static, no-build, same textContent-only discipline; tag filter,
  search, per-profile cards with evidence links, stats strip (totals,
  per-tag, reports/day sparkline), vi/en toggle.
- **CAUTION to decide:** this publicly names accounts as clones/scammers on
  a page you own. Approved-only is the floor; consider (a) a per-target
  "publish publicly" checkbox in the dashboard rather than automatic,
  (b) evidence quotes shown only when a post URL backs them.
  **DECIDED (owner, 2026-08-21): (a) — per-target opt-in** via a
  "publish publicly" control in the dashboard. Shipped with (b) as well.

## Phase 5 — Google sign-in for the dashboard — **DONE**
*(todo 10 — auth config + rules + dashboard gate)*

**Shipped 2026-08-21** (`acbed3f`). Built as planned. One addition the plan did
not have: `--add-admin` and `--list-admins` rewrite the allowlist and **re-parse
the file before deploying**, because half-written rules either lock the owner out
or open the database, and both beat neither. And when a Google sign-in succeeds
but is not on the list, the dashboard prints that uid and the exact command to
add it — being locked out of your own dashboard with no way to learn your own
uid was the failure mode worth engineering against.

- Enable the Google provider (`firebase-setup.js` gains the Identity Toolkit
  `defaultSupportedIdpConfigs` call; console fallback documented).
- Dashboard gate grows a "Sign in with Google" button
  (`signInWithPopup(GoogleAuthProvider)`); email/password stays as fallback.
- Rules `isAdmin()` becomes a UID *list*. A Google sign-in mints a different
  UID than the password account, so: sign in once with Google, the setup tool
  (new `--add-admin <uid|email>` flag) pins it alongside the existing UID and
  redeploys rules.
- **NEEDS FROM OWNER:** which Google account(s) count as admin. *(Still open —
  see the top of this file. Everything around it is built and tested; what is
  missing is one uid only the owner can produce.)*

## Phase 6 — i18n: English + Vietnamese — **DONE**
*(todo 7 — last, so strings only churn once)*

**Shipped 2026-08-21.** The extension half went exactly as specified in
`docs/PHASE6-SPEC.md`: `_locales/en` and `_locales/vi`, 250 keys each, every one
carrying a `description` because a translator with no context produces confident
nonsense; the manifest's name and description through `__MSG___`; and one helper
in `src/common/i18n.js`, loaded first everywhere, falling back to the **key**
rather than to empty text so a missing string is an obvious bug rather than a
control that merely looks broken.

Two departures, and one thing the spec called a move that really was one:

- The helper grew past three lines. `CB_T` is the three-line part; alongside it
  are `CB_FILL_I18N` and `CB_APPLY_I18N`, which translate `data-i18n` markup and
  understand exactly two inline marks, `<b>` and `<c>`. The alternative was to
  cut every emphasised sentence into three keys and glue them back together in
  the page — the concatenation the spec exists to forbid. Nothing is ever parsed
  as HTML: the marked text is rebuilt out of nodes the helper creates.
- `hosting/i18n.js` was a **move, not a translation**. Phase 4 had already
  shipped the public page bilingual, with its dictionary in one object at the
  top of `public.js` and a vi/en toggle persisted in `localStorage`, precisely so
  this phase would be a cut-and-paste. It was. What the file added on top is the
  surface table — `DICT = { public: { base: 'vi', locales: PUBLIC } }` — so the
  dashboard becomes one more entry rather than a second mechanism, and the same
  `CB_T(key, ...args)` signature the extension uses, with `$1` placeholders and
  the same two-step fallback (untranslated key ⇒ the surface's base language,
  unknown key ⇒ the key itself). `public.js` now holds no string of its own. The
  dashboard stays **English-only** as planned: it has one user, and translating
  an admin tool nobody else opens is maintenance bought for nothing.
- `TAG_LABELS` resolves through `CB_T` but falls back to **English**, not to the
  key. `protocol.js` is also read by the Node harnesses, where there is no
  extension API at all, and a report sheet offering `tag_redbull` as a reason
  would be worse than one offering plain English.

`check.js` gained four locale checks rather than the three planned: key parity
in both directions, non-empty message *and* non-empty description on every key,
matching `$1` placeholders across the two languages (a translation that drops a
placeholder loses the number the sentence was about), no key the UI asks for
that `en` lacks — plus a warning for keys nothing references — and no
user-visible text in any page's markup outside a `data-i18n` element.

- `_locales/en/messages.json` + `_locales/vi/messages.json`; manifest
  name/description via `__MSG___`; popup, options, activity, and the
  in-page report chip/sheet through a tiny `t()` helper over `chrome.i18n`.
- The transparency site and dashboard get a hand-rolled dictionary (no
  chrome.i18n outside the extension); site defaults to vi with an en toggle,
  dashboard stays en (admin-only) unless asked.
- check.js grows a key-parity check: every key present in both locales,
  no hardcoded UI strings left in the swept files.

---

## Sequencing rationale

Tags (2) preceded the transparency site (4) because the site is organised by
tag. i18n (6) went last because phases 1–4 rewrote most UI strings. Google
auth (5) was independent and slotted in beside the site. Every phase ended with
the full suite (check, queue, firebase, e2e, dashboard-visual) plus a live
deploy where hosting or rules changed. In practice phases 2+3 and 4+5 landed as
one commit each, because each pair rewrote the same file at the same time.

## Open decisions

1. ~~Hiding~~ — decided: kept, **disabled by default**, toggle in Advanced.
   *(Shipped that way in phase 1.)*
2. ~~Transparency site~~ — decided: **per-target opt-in** from the dashboard.
   *(Shipped that way in phase 4, with the evidence-needs-a-link rule as well.)*
3. **Google admin account**: which address(es) to pin. *(Still open. Everything
   else in phase 5 is built; see the top of this file.)*
4. **Redbull tag in store marketing**: in the product regardless; in the
   listing copy or not. *(Still open — needed at store submission.)*
