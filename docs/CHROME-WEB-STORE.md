# Publishing to the Chrome Web Store

What the store requires, what this extension already satisfies, what still has
to be decided, and the copy to paste into each field.

Researched against the live policy pages on **21 August 2026**. The policy set
that took effect on **1 August 2026** is three weeks old at the time of
writing, and it tightened exactly the areas this extension touches — data
collection and disclosure. Re-check before submitting if much time has passed.

---

## 1. Account, before anything else

| | |
|---|---|
| Developer account | One-time **US$5**, per account, not per extension. No renewal. |
| Email verification | Required before publishing. |
| **Trader / non-trader** | Required declaration for every developer, from the EU Digital Services Act. If you declare **trader**, the name, address, email and phone you give are **published at the bottom of the public listing**. |

Trader status is a legal question about you, not about the extension: it turns
on whether you are acting for purposes relating to a trade, business or
profession. A free hobby extension with no monetisation is normally
non-trader — but the declaration is yours to make, and getting it wrong is a
compliance problem rather than a store one. Verification is separate from the
$5 fee and costs nothing.

---

## 2. Image assets

All generated, all reproducible: `node tools/make-store-assets.js`.

| Asset | Size | Required | File |
|---|---|---|---|
| Store icon | 128×128, 96px artwork + 16px transparent frame | yes | `store/icon128.png` |
| Small promo tile | 440×280 | yes | `store/small-promo-440x280.png` |
| Marquee promo tile | 1400×560 | no — but needed to be eligible for featuring | `store/marquee-1400x560.png` |
| Screenshots | 1280×800, 1–5 of them, square corners, full bleed | at least 1 | `store/screenshot-1..4-1280x800.png` |
| Extension icons | 16/32/48/128 | yes | `icons/icon*.png` |

The store's guidance for tiles is *avoid text, stay legible at half size, fill
the region, saturated colour, don't just replicate a screenshot* — hence a
mark, a wordmark, and one line, rather than a shrunken UI.

**The four screenshots**

1. **Hero** — the claim, no UI.
2. **The two modes** — the passive/active split, drawn rather than captured
   (see below).
3. **Options page** — a real capture of the mode picker, which is now the first
   thing on the page.
4. **Moderation dashboard** — a real capture, entirely synthetic fixture data.

Screenshot 2 is drawn rather than captured, and it and the options capture were
both brought forward with the modes: the explainer is "Two modes, because they
cost different things" (passive/active), and the options shot no longer hunts
for a heading or fills in an endpoint field, because neither exists. One
display-only correction survives in the generator: a dev session forces
blocking off for safety and the page honestly says so, which is the harness's
state rather than the product's, so the paused note is cleared in the DOM for
the capture without writing any setting.

Screenshot 2 is drawn instead of captured on purpose. The obvious second image
is the popup, but on a page where the site has not yet loaded its own block
module the popup honestly reports that, in red, and it stays there until the
user opens a profile menu. The choice was to misconfigure the extension for a
prettier picture or to explain the actual model — so it explains the model.

The popup is still captured by the tool, but only to a temporary directory that
is deleted afterwards. It must not be committed: its Page capability panel
prints **Signed in as `<numeric account id>`**, so a copy in the repository
would publish the real account of whoever generated it.

**Worth adding before you submit:** a fifth screenshot of a clone actually
disappearing from a real feed. That one has to be yours — it can only be taken
against a signed-in account, and only you can consent to publishing what is on
that screen.

---

## 3. Listing copy

### Name (45 max) — 13 used

```
Clone Blocker
```

### Short description (132 max) — 120 used

Also the `description` field in `manifest.json`; the store reads it from there.

```
Hide clone accounts impersonating you on Facebook and Threads — and block the most active ones at a safe, rationed pace.
```

It leads with hiding, which now ships switched off — worth revisiting, but not
on its own: this string is `description` in `manifest.json`, so any rewrite has
to change both in the same commit and land under 132 characters again. Left
alone here deliberately rather than by oversight.

### Category

**Social & Communication.** (Not *Productivity* — the store dislikes category
mismatches, and this is not a productivity tool.)

### Detailed description

```
Someone is running accounts that pretend to be you. Clone Blocker blocks them
for real — through Facebook's and Threads' own block mechanism, at a pace that
keeps your own account out of trouble.

The one thing you choose is how far it goes looking.

PASSIVE — block the clones you run into
Only profiles that turn up on the page while you browse. They were on your
screen anyway, so blocking them is the most ordinary thing an account can do:
these go through quickly and stay well clear of the rate limits.

ACTIVE — also work through the list
Adds the clones the list says are most active near you, whether or not you ever
scroll past them. Grinding through strangers is what gets an account
checkpointed, so this half is paced slowly and held to an hourly ceiling you
set — set it to zero and nobody you have not seen is ever blocked. It also
needs a Facebook or Threads tab open, because a block is issued through the
site's own code, in the page.

Every delay, cap and ceiling is yours to change, and the cautious values are
the ones it ships with. A pause switch stops all of it at once, and a dry run
resolves everything and sends nothing.

HIDE THEM AS WELL, IF YOU WANT
An extra, switched off by default: hiding makes every listed profile's posts
and comments disappear as the page loads. It happens entirely in your browser,
sends nothing, changes nothing on your account, has no limit, and covers the
whole list rather than a budgeted slice.

REPORT A CLONE IN TWO CLICKS
Hover a name in the feed, or open the profile, and file a report with the
posts that prove it. Reports go to a human reviewer, and nothing reaches the
blocklist until it is approved.

NOTHING TO SET UP
The blocklist address is built into the extension and the list itself is
public and read-only. There is no account to create, no key to paste, no
permission prompt to accept: install it and it starts working. The whole
thing — extension, backend, moderation dashboard, one-command setup — is open
source if you would rather run your own copy of it.

WHAT IT SENDS, AND WHERE
Only to that one backend, and nowhere else:
  • the blocklist request itself — which carries nothing about you: deciding
    which clones are active near you happens locally, in your browser;
  • when you file a report: the reported profile's ID or username, the reason
    you pick, any note and post links you add, and a hash of your own platform
    account ID — so that reports can be weighed by reputation and one account
    cannot flood the queue;
  • optionally, your time zone and language with that report, so the reviewer
    can see where a clone is active. This is a single switch and you can turn
    it off.
Your account ID never leaves the browser in the clear — only a truncated
hash of it does — and the report store is readable only by the one admin
account that reviews reports. There is no analytics, no tracking, no ad
network, and no third-party service anywhere.

REQUIREMENTS
Chrome 120 or newer, and a Facebook or Threads account to block from. Source,
backend and documentation:
https://github.com/hoangxliem2410/CloneBlocker

Not affiliated with, endorsed by, or connected to Meta, Facebook or Threads.
```

### URLs

| Field | Value |
|---|---|
| Homepage | `https://github.com/hoangxliem2410/CloneBlocker` |
| Support | `https://github.com/hoangxliem2410/CloneBlocker/issues` |
| **Privacy policy** | must be a public URL — see §5 |

---

## 4. Privacy tab

Every field here is mandatory, and the store states plainly that a listing
whose privacy fields contradict the extension's actual behaviour may be
removed. These are written to match the code.

### Single purpose

```
Block, and optionally hide, accounts that impersonate the user on Facebook and
Threads, working from a reviewed blocklist the extension fetches from one
fixed address.
```

Hiding, blocking and reporting are one purpose, not three: reporting is how an
account gets onto the list, blocking and hiding are how the list is applied.
Nothing in the extension serves any other end.

### Permission justifications

| Permission | Justification to paste |
|---|---|
| `storage` | Stores the user's settings and the cached blocklist so the list does not have to be re-fetched on every page load. Nothing is stored anywhere else. |
| `alarms` | Refreshes the blocklist on the user's chosen interval, and paces platform blocks so they are never issued in a burst. |
| `host_permissions` — facebook.com, threads.net, threads.com | The extension's entire function is to block, and optionally hide, impersonator accounts on these two sites. It reads the page to find profiles from the list and issues a block through the site's own interface. |
| `host_permissions` — firestore.googleapis.com, clone-blocker2.web.app | The backend. The published blocklist document is read from Firestore's public REST endpoint and the reports a user files are written back to it; the Hosting origin serves the same list as a CDN-cached static snapshot. Both addresses are fixed in the extension, which is why they are required rather than optional: there is nothing for the user to type and no runtime permission request anywhere in the product. |

### Data collection disclosures

Tick these, and be prepared to explain each:

| Category | Collected? | What, and why |
|---|---|---|
| Personally identifiable information | **Yes** | A pseudonym of the user's own Facebook/Threads numeric account ID, sent with a report only. Necessary so that reports can be weighted by the reporter's track record and so a single account cannot flood the queue. The ID is hashed in the browser (truncated SHA-256) before sending; the raw ID never leaves the machine, and the report store is readable only by the backend owner under Firestore security rules. |
| User activity | **Yes** | The reports the user chooses to file: the reported account, the reason, an optional note, optional links to posts. |
| Website content | **Yes** | Only what the user attaches to a report — public post URLs and an optional short quote of the content they are reporting. |
| Location | **Yes, coarse, optional** | IANA time zone and BCP-47 language, from the browser, attached to reports only — never to list fetches — and only when **Send my time zone and language** is on. No IP lookup, no geolocation API, no geo database. Shows the reviewer where a reported clone is active; the ranking of which clones to block is computed locally in the user's browser and sends nothing. |
| Authentication information | No | |
| Financial / health / personal communications | No | |

### Limited Use certification

You must certify that the data is used only for the disclosed single purpose.
That is true here — it goes to the one backend the extension is built against
and nowhere else, and there is no analytics, telemetry, ad network or
third-party endpoint anywhere in the code. Grep it: the only network
destinations are the two Meta origins and the `LIST_URL` constant in
`src/common/protocol.js`.

### Notes for the reviewer

This field matters because the extension's effect is only visible on Facebook
and Threads. Suggested text:

```
The extension works on install with no configuration: it ships pointed at
our Firebase project's public, read-only blocklist, and the backend origins
it needs are declared as required permissions, so there is no setup step and
no permission prompt anywhere in the product.

Please note that content hiding ships DISABLED. A fresh install blocks but
does not hide, so nothing visibly changes on the page until you turn hiding
on — Settings > Advanced > "Hide their content" > Enable hiding. With that
on, content from any listed account disappears on the next page load.

To exercise it end to end:
  1. Install it, then load Threads (threads.com) or Facebook.
  2. Switch hiding on as above to see the list applied to the page. Hiding
     runs entirely in the browser and sends nothing.
  3. The list is served read-only from Firestore's public REST endpoint at
     https://firestore.googleapis.com/v1/projects/clone-blocker2/databases/(default)/documents/blocklist/current
     — open it in a browser to see the exact bytes the extension fetches.
  4. Settings > "Dry run" resolves a real block and sends nothing, if you
     want to watch the blocking path without changing an account.

Real blocking is on by default but tightly paced, and the user picks how far
it goes. Passive mode blocks only profiles that appeared on the page in front
of them, at a human rhythm. Active mode (the default) additionally works
through the published list, capped at 4 per hour and paced 20-45s apart, and
only while a Facebook or Threads tab is open — the block is issued by the
site's own code, from a content script.
```

---

## 5. Privacy policy

Required, because the extension collects user data. It must be a live URL in
the dashboard field.

`PRIVACY.md` is in the repository root. GitHub renders it at
`https://github.com/hoangxliem2410/CloneBlocker/blob/main/PRIVACY.md`, which is
a public URL and is accepted. If you would rather have a cleaner one, turn on
GitHub Pages and use `https://hoangxliem2410.github.io/CloneBlocker/PRIVACY`.

---

## 6. Where this could be rejected

Ordered by how likely it is to actually happen. None of these are fatal, but
pretending they are not there would waste a review cycle.

### a. A reviewer installs it and nothing happens — *most likely*

A fresh install now fetches a real list, but hiding ships **off** and blocking
is silent and paced, so there is still nothing on screen for a reviewer to
point at in the first minute. This is a common rejection reason and it is not
really a policy problem, just an unlucky first impression. The reviewer-notes
text in §4 exists for exactly this, and its first paragraph is the one that
matters: tell them where the hide switch is. If it gets rejected on these
grounds anyway, the cheapest answer is a listing screenshot of a real feed with
hiding on, not a change to the defaults.

### b. List-nominated blocks and "related user action"

Store policy is explicit that an extension must not send messages for the user
without a chance to confirm, and requires related user action before each
injected affiliate link. Blocking is neither of those things — but it is an
action taken on a third-party site on the user's behalf, and blocks that the
user never saw coming are the closest thing here to that pattern.

What argues for it: the cold ceiling defaults to 4/hour; the user sets every
cap; the mode picker is the first thing on the options page and passive mode
turns list-nominated blocks off in one click. Blocking itself is ON by default
(an owner decision, 2026-08-21), so the per-account pacing and that visible
choice are the whole defence in a review dispute.

What argues against it: the default mode is **active**, so the trending
metadata published with the list can put an account the user has never seen
into the queue, and it will be blocked without a per-account confirmation.
(The ranking itself runs locally in the extension, but the effect a reviewer
would care about is the same: the list's publisher chooses candidates the user
never looked at.)

**Worth considering before submitting:** ship the default as **passive**. Then
every block in a default install traces to a profile the user looked at, and
working through the list becomes something they opt into knowingly. It costs
little — a user who wants the list worked through is exactly the user who will
find the mode picker, since it is the first control on the page.

### c. Meta's terms of service — *the risk that is not ours to fix*

Facebook and Threads terms prohibit automated interaction with their services.
This extension drives their own in-page block operation, which is a much
gentler thing than a scraper, and it exists to protect users from
impersonation — but it is still automation of a Meta account.

Store policy forbids infringing third-party rights and interfering with
third-party infrastructure. Google does not generally police a platform's ToS
on that platform's behalf, but it does act on complaints. If Meta complains,
the listing goes. That risk cannot be engineered away while the extension
blocks anything, and it is worth going in with eyes open rather than being
surprised by it.

### d. List-supplied `docIdOverrides`

The blocklist response may carry `docIdOverrides`, which changes which
persisted GraphQL operation the extension calls. This is configuration data,
not code, and MV3's rule is about executing remotely-hosted *logic*. But it
does let whoever publishes the list change what a request does, and a
thorough reviewer may ask.
The answer is that the operation is always one the page itself already
exposes, and the override only selects among them — say so if asked.

---

## 7. Pre-submission checklist

- [x] Manifest V3
- [x] `name` ≤ 45 (12)
- [x] `description` ≤ 132 (120 — it was 135 and would have been rejected at upload)
- [x] Icons 16/32/48/128 present and referenced
- [x] Store icon with the 96-in-128 transparent frame
- [x] Small promo tile 440×280
- [x] Marquee tile 1400×560
- [x] At least one 1280×800 screenshot (four)
- [x] No real accounts, real names or real reports in any asset
- [x] Privacy policy written and in the repo
- [ ] Developer account registered, $5 paid, email verified
- [ ] Trader / non-trader declared
- [ ] Privacy policy URL pasted into the dashboard
- [ ] Single purpose, permission justifications, data disclosures filled in
- [ ] Limited Use certification ticked
- [ ] Reviewer notes pasted
- [ ] Confirm the default mode: it currently ships **active** (§6b)
- [x] Store assets regenerated against the passive/active modes (§2)
- [ ] `npm test` green, then zip: everything except `tools/`, `docs/`, `store/`, `hosting/`, the Firebase config files (`firebase.json`, `firestore.rules`, `firestore.indexes.json`, `.firebaserc`) and `.env`

The upload zip only needs what the extension actually loads: `manifest.json`,
`src/`, `icons/`. The backend and the tooling are for you, not for Chrome, and
shipping them only widens what a reviewer has to read.

---

## Sources

- [Supplying Images — Chrome for Developers](https://developer.chrome.com/docs/webstore/images)
- [Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Policy updates effective 1 August 2026](https://developer.chrome.com/blog/cws-policy-updates-2026)
- [Listing Requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements/)
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Privacy Policies](https://developer.chrome.com/docs/webstore/program-policies/privacy)
- [Disclosure Requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements)
- [Trader/Non-Trader identification and verification](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure)
- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [Review process](https://developer.chrome.com/docs/webstore/review-process)
