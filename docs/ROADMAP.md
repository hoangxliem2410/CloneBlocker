# Roadmap — todo.txt implementation plan

Source: `todo.txt` (owner, 2026-08-21). Items renumbered into build order;
the original numbering is kept in brackets. Each phase is independently
shippable and leaves every suite green.

## Where the ten items actually stand

Three of them are largely built already and need re-surfacing, not rebuilding:

| todo | existing machinery |
|---|---|
| [1] ranking by unique reports, geo, time | `rank = trust × recency × (1+velocity7d) × locality` — trust already sums per-unique-reporter weights, locality is region/language affinity, recency+velocity are the time axis |
| [3][4] passive/active modes | the warm/cold split: warm = on-screen targets at 4–11s pacing, cold = ranked list targets under the 4/hour ceiling |
| [5] "keep a tab open" | true mechanic today — blocks execute through a content script, so no open tab means the cold queue stalls; it just isn't surfaced anywhere |

The genuinely new work: tags, the transparency site, Google sign-in, i18n.

---

## Phase 1 — Product shape: modes, hardcoded source, tab guidance
*(todo 2, 3, 4, 5 — extension only, no schema changes)*

**Hardcode the list source [2].** `LIST_URL` becomes a constant in
`protocol.js`; the whole "Blocklist source" section (endpoint, auth header,
Grant access, refresh interval) leaves the options page. The settings key
stays internally — the harnesses and e2e point it at the emulator through
storage — but no UI writes it. `optional_host_permissions` drops to nothing
(the two required origins cover the product; e2e patches its own manifest
copy for the emulator origin). README loses the self-hosting pitch.

**Passive / Active modes [3][4].** One new setting `mode: 'passive' | 'active'`
(default: active, since Layer 2 now defaults on) that maps onto existing
switches — passive ⇒ `acceptServerTargets: false` (block only what appears on
screen, warm pacing, effectively no rate-limit pressure), active ⇒ warm +
ranked cold targets under the cold ceiling. Options page restructures around
one mode picker with two plain paragraphs; the expert pacing fields fold into
a collapsed "Advanced" block.

**ASSUMPTION TO CONFIRM:** "remove the layer 1" is read as *retire the
layer terminology*, not the hiding feature. Hiding stays, always-on and
invisible (one toggle in Advanced) — it is free, covers the whole list
including profiles never seen, and removing it would be a regression the
rest of the todo does not imply. Say the word if hiding itself should go.

**Tab-open guidance [5].** The popup and activity page check
`chrome.tabs.query` for an open Facebook/Threads tab whenever cold work is
queued: none open ⇒ a plain banner — "Active blocking needs a Facebook or
Threads tab open. N waiting." Plus a toolbar badge count on the same
condition. (A pinned background tab or offscreen document would remove the
constraint entirely — out of scope, noted as future work.)

## Phase 2 — Tags
*(todo 6, 8 — rules, logic, dashboard, extension, in that order)*

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
store screenshots/description is a separate marketing decision.

## Phase 3 — Ranking tune-up
*(todo 1 — mostly logic.js + published payload)*

- Publish `rankWeights` in the payload (`{recencyHalfLife, velocityWeight,
  localityFloor, uniqueReporterBoost}`) with today's values as defaults, so
  the owner tunes ranking from the dashboard without shipping extension
  updates. The SW ranks with published weights when present.
- Add an explicit unique-reporter term: today two reporters ≈ trust 1.5 vs
  one ≈ 0.75 (linear in trust). Option: `(1 + log2(uniqueReporters))`
  multiplier so 4 independent reporters outrank one high-trust reporter —
  A/B-able via the published weights rather than hardcoded.
- Port the same weights into the dashboard's preview so what the admin sees
  is what clients compute.

## Phase 4 — Public transparency site
*(todo 9 — hosting + publish pipeline)*

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
  (b) evidence quotes shown only when a post URL backs them. Both are cheap;
  the plan assumes (a) manual opt-in per target unless told otherwise.

## Phase 5 — Google sign-in for the dashboard
*(todo 10 — auth config + rules + dashboard gate)*

- Enable the Google provider (`firebase-setup.js` gains the Identity Toolkit
  `defaultSupportedIdpConfigs` call; console fallback documented).
- Dashboard gate grows a "Sign in with Google" button
  (`signInWithPopup(GoogleAuthProvider)`); email/password stays as fallback.
- Rules `isAdmin()` becomes a UID *list*. A Google sign-in mints a different
  UID than the password account, so: sign in once with Google, the setup tool
  (new `--add-admin <uid|email>` flag) pins it alongside the existing UID and
  redeploys rules.
- **NEEDS FROM OWNER:** which Google account(s) count as admin.

## Phase 6 — i18n: English + Vietnamese
*(todo 7 — last, so strings only churn once)*

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

Tags (2) precede the transparency site (4) because the site is organised by
tag. i18n (6) is last because phases 1–4 rewrite most UI strings. Google
auth (5) is independent and can slot anywhere. Every phase ends with the
full suite (check, queue, firebase, e2e, dashboard-visual) plus a live
deploy where hosting or rules changed.

## Open decisions (answer these, everything else proceeds on defaults)

1. **Hiding**: stays always-on under the new mode model? *(plan assumes yes)*
2. **Transparency site**: automatic for every approved target, or per-target
   opt-in from the dashboard? *(plan assumes opt-in)*
3. **Google admin account**: which address(es) to pin.
4. **Redbull tag in store marketing**: in the product regardless; in the
   listing copy or not.
