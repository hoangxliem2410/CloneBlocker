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
| Screenshots | 1280×800, 1–5 of them, square corners, full bleed | at least 1 | `store/screenshot-1..2-1280x800.png` |
| Extension icons | 16/32/48/128 | yes | `icons/icon*.png` |

The store's guidance for tiles is *avoid text, stay legible at half size, fill
the region, saturated colour, don't just replicate a screenshot* — hence a
mark, a wordmark, and one line, rather than a shrunken UI.

**The mark**

A red cow wearing a livestock ear tag. *Bò đỏ* — red cow — is what Vietnamese
readers call the paid commenters who swarm a post to shout down whoever is
speaking, and the complaint about them is that they are a herd: one opinion, in
one set of words, from a hundred accounts that all look alike. Which is the
same thing this extension is for, so one mark carries both halves.

The joke is aimed at the herd and nothing else. A flag or a national symbol
with a line through it would be a different joke — one about a country rather
than about astroturfing — and both less funny and far more likely to get the
listing pulled. Reviewers have no obligation to work out which one you meant.

The tag replaced a slash across the cow's face and, before that, a prohibition
ring around it. The slash ran diagonally through the muzzle, so the face lost
half of itself exactly where pixels got scarce; the ring read as "blocked"
perfectly at 16px and shrank the cow to an unidentifiable smudge. The tag says
the same thing without spending any of the face, and being the only asymmetric
element in the mark, it is also what makes the silhouette recognisable small.

**The two screenshots**

1. **Poster** — the marquee again: same field, same herd, same yellow
   punchline. *Bò đỏ ơi, cỏ ở đằng kia.* — hey red cow, the grass is that way.
   A dismissal rather than an insult, which is both funnier and the honest
   description of the product: it does not argue with the herd, it sends them
   somewhere else.
2. **The product** — real captures of the options page with the popup in front
   of it, framed in the poster's clothes.

It was four. Two of them were drawn explainers standing in front of two real
captures, doing the captures' job — describing an interface that was sitting
right there — and the drawn ones went stale against the product twice. One
poster to land the joke and one photograph of the thing itself is the whole
listing.

Both captures are taken with the interface in **Vietnamese**, driven through
the options page's own language picker. A listing that makes its joke in
Vietnamese and then shows an English interface is quietly telling the reader
the translation is marketing. The picker's previous value is read back and
restored in a `finally`, so the dev browser it borrowed is left as it was
found.

Two other display-only corrections live in the generator, both because a dev
session is not a fresh install:

- The options page is captured with the paused note cleared in the DOM. A dev
  session forces blocking off for safety and the page honestly says so; that is
  the harness's state, not the product's. Nothing is written to settings.
- The popup is captured with blocking **on** and dry run **on**, and the queue
  emptied. On is what a fresh install ships with, and it has to agree with the
  options page in the same image — a picture where the popup says blocking is
  paused and the settings beside it say it is running contradicts itself, and
  the reader cannot tell which half is the product. Dry run stays armed
  regardless: that browser is signed in to real accounts, and no screenshot is
  worth arming live blocking to take. The previous values are read back and
  restored in a `finally`.

The popup capture goes to a temporary directory that is deleted afterwards. It
must not be committed: its Page capability panel prints **Signed in as
`<numeric account id>`**, so a copy in the repository would publish the real
account of whoever generated it.

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

### Short description (132 max) — 117 used

Also the extension's own description; the store reads it from there. Since the
i18n phase that is `appDesc` in `_locales/en/messages.json` (and its Vietnamese
counterpart), reached from `manifest.json` as `__MSG_appDesc__` — the store
serves whichever one matches the shopper's language.

```
Report a clone once. When it is approved, everyone running Clone Blocker blocks that account on Facebook and Threads.
```

The Vietnamese the store serves to a Vietnamese shopper, from
`_locales/vi/messages.json`, at 124 characters:

```
Báo cáo một tài khoản giả mạo. Được duyệt xong, mọi người dùng Clone Blocker đều chặn tài khoản đó trên Facebook và Threads.
```

It used to lead with hiding, which ships switched off — so the first thing a
shopper read was the one feature that does nothing until they find a tick box.
It now leads with the shared list, which is the actual product: one person
reports, a human approves, and every installed copy blocks that account. Both
strings are `appDesc`, reached from the manifest as `__MSG_appDesc__`, so any
rewrite has to change both locales together and land under 132 characters in
each.

### Category

**Social & Communication.** (Not *Productivity* — the store dislikes category
mismatches, and this is not a productivity tool.)

### Detailed description

```
Someone is running accounts that pretend to be you. Clone Blocker blocks them
for real — through Facebook's and Threads' own block mechanism, at a pace that
keeps your own account out of trouble.

ONE REPORT PROTECTS EVERYBODY
This is the part that matters. When you report a clone, it does not just get
blocked for you. It goes to a human reviewer, and once it is approved that
account joins the shared blocklist that every copy of Clone Blocker follows —
so everybody running the extension blocks them too, whether or not they ever
laid eyes on that account. The list is one list, built out of reports that
people sent and a person approved. You are not maintaining your own.

What you choose is where it looks. Two switches, both on to begin with, and
each one works on its own.

BLOCK THE CLONES YOU RUN INTO
Profiles that turn up on the page while you browse. They were on your screen
anyway, so blocking them is the most ordinary thing an account can do: these go
through quickly and stay well clear of the rate limits.

WORK THROUGH THE LIST AS WELL
The clones the list says are most active near you, whether or not you ever
scroll past them. Grinding through strangers is what gets an account
checkpointed, so this half is paced slowly and held to an hourly ceiling you
set. Turn it off and the extension only ever blocks what you have actually
seen; leave it on and turn the other one off and it works the list alone.

Blocking of either kind needs a Facebook or Threads tab open, because a block
is issued through the site's own code, in the page. One tab is enough and any
of them will do — and opening more does not block anything faster, because the
pacing is shared across the whole browser rather than kept per tab.

Every delay, cap and ceiling is yours to change, and the cautious values are
the ones it ships with. A pause switch stops all of it at once, and a dry run
resolves everything and sends nothing.

HIDE THEM AS WELL, IF YOU WANT
An extra, switched off by default: hiding makes every listed profile's posts
and comments disappear as the page loads. It happens entirely in your browser,
sends nothing, changes nothing on your account, has no limit, and covers the
whole list rather than a budgeted slice.

REPORTING TAKES TWO CLICKS
Hover a name in the feed, or open the profile, and file a report with the
posts that prove it. "Block this profile too" is ticked already, so the block
goes out for you straight away while the report goes off to be read. Nothing
reaches the shared blocklist until a person approves it. Some reviewed accounts
are additionally named on a public page we publish — that is a separate
decision a person makes about each one, and nothing about you as the reporter
is ever published.

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
hash of it does — and the report store is readable only by the moderator who
reviews reports. There is no analytics, no tracking, no ad network, and no
third-party service anywhere.

IN ENGLISH AND VIETNAMESE
Tiếng Việt và tiếng Anh. Every screen — the popup, the settings, the activity
log, and the report form you fill in on the page itself — is fully translated,
and it follows the language your browser is already in. Nothing to choose.

REQUIREMENTS
Chrome 120 or newer, and a Facebook or Threads account to block from. Source,
backend and documentation:
https://github.com/hoangxliem2410/CloneBlocker

Not affiliated with, endorsed by, or connected to Meta, Facebook or Threads.
```

**Say the Vietnamese in Vietnamese.** The audience this was built for reads
Vietnamese, and a listing that only claims translation in English is claiming it
to the wrong people — hence the one line above that is in the language it is
talking about. The store lets the whole listing be localised per language in the
dashboard; that is worth doing before launch, and the strings already exist in
`_locales/vi/messages.json` for everything inside the extension. The short
description translates itself: the store serves `appDesc` from whichever locale
matches the shopper.

**Still undecided: whether the `redbull` tag is named here.** The extension
ships it either way — *Bò đỏ* / "Redbull" is one of the
seven tags a reporter can pick and one of the tick boxes in Settings. The copy
above does not name it, which is the absence of a decision rather than a
decision. Naming a politically-charged category in a public listing invites a
kind of review attention, and a kind of coordinated user reporting, that "scam"
does not; leaving it out costs nothing in the listing and hides nothing from
anyone who installs it. The owner's call, recorded as open in
[`ROADMAP.md`](ROADMAP.md).

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

**One thing the backend does with reports has to be disclosed here even though
no extension code touches it.** Some of the *reported* accounts are named on a
public web page the same project serves —
`https://clone-blocker2.web.app/` — and a reviewer who reads the privacy policy
will find it, so it should not first appear as a surprise. The wording to add if
the field allows more than the sentence above:

```
Reports are reviewed by a person. Some reported accounts are additionally
named on a public page run by the same project, but only when a moderator
opts that specific account in — approval alone never publishes anyone.
Nothing about the person who filed a report is ever published: the page
carries a headcount and no reporter identity of any kind.
```

The distinction that matters in a review dispute is that publication is about
the **reported** account, never the **user of the extension**. A user who
installs it and files reports has nothing published about them under any
circumstances, and a user who installs it and files nothing sends nothing at
all.

### Permission justifications

| Permission | Justification to paste |
|---|---|
| `storage` | Stores the user's settings and the cached blocklist so the list does not have to be re-fetched on every page load. Nothing is stored anywhere else. |
| `alarms` | Refreshes the blocklist on the user's chosen interval, and paces platform blocks so they are never issued in a burst. |
| `host_permissions` — facebook.com, threads.net, threads.com | The extension's entire function is to block, and optionally hide, impersonator accounts on these two sites. It reads the page to find profiles from the list and issues a block through the site's own interface. |
| `host_permissions` — firestore.googleapis.com, clone-blocker2.web.app | The backend. The published blocklist document is read from Firestore's public REST endpoint and the reports a user files are written back to it; the Hosting origin serves the same list as a CDN-cached static snapshot. Both addresses are fixed in the extension, which is why they are required rather than optional: there is nothing for the user to type and no runtime permission request anywhere in the product. |

That is the whole of it, and the table is meant to be checked against
`manifest.json` rather than trusted: **two** API permissions, `storage` and
`alarms`; **five** host patterns, `*.facebook.com`, `*.threads.net`,
`*.threads.com`, `firestore.googleapis.com` and `clone-blocker2.web.app`; and no
`optional_host_permissions` block at all, which is why there is no prompt
anywhere in the product. There is deliberately no `tabs` permission: the popup
and the activity page ask `chrome.tabs.query` whether a Facebook or Threads tab
is open, and the host permissions the extension already holds for those two
sites are what makes that answerable without a broader one.

### Data collection disclosures

Tick these, and be prepared to explain each:

| Category | Collected? | What, and why |
|---|---|---|
| Personally identifiable information | **Yes** | A pseudonym of the user's own Facebook/Threads numeric account ID, sent with a report only. Necessary so that reports can be weighted by the reporter's track record and so a single account cannot flood the queue. The ID is hashed in the browser (truncated SHA-256) before sending; the raw ID never leaves the machine, and the report store is readable only by the backend owner under Firestore security rules. |
| User activity | **Yes** | The reports the user chooses to file: the reported account, the reason (one of seven tags), an optional note, optional links to posts. |
| Website content | **Yes** | Only what the user attaches to a report — public post URLs and an optional short quote of the content they are reporting. If a moderator later opts the *reported* account in to the project's public page, those links and quotes can appear there; the user's note never does, and nothing identifying the reporter ever does. |
| Location | **Yes, coarse, optional** | IANA time zone and BCP-47 language, from the browser, attached to reports only — never to list fetches — and only when **Send my time zone and language** is on. No IP lookup, no geolocation API, no geo database. Shows the reviewer where a reported clone is active; the ranking of which clones to block is computed locally in the user's browser and sends nothing. |
| Authentication information | No | |
| Financial / health / personal communications | No | |

None of it is sold, rented, or used for anything but review. The one route by
which any of it becomes public is the transparency page described under Single
purpose, and that route is closed to everything in the first and last rows of
this table: the reporter pseudonym, the time zone and the language are
admin-only by construction and are never published, not even in aggregate — the
page carries how many different people reported an account and nothing else
about them.

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

Real blocking is on by default but tightly paced, and the user picks where it
may look. Two independent tick boxes, both on by default: "Block clones I run
into" covers profiles that appeared on the page in front of them, at a human
rhythm; "Work through the list too" additionally blocks accounts from the
published list, capped at 4 per hour and paced 20-45s apart. Either can be turned off
without the other. Blocking of any kind runs only while a Facebook or Threads
tab is open — the block is issued by the site's own code, from a content script
— and the pace is held by one gate in the service worker covering the whole
browser, so several open tabs do not block any faster than one. Settings also
carries a tick box per kind of account (clone, impersonation, scam, harassment,
spam, other), so a user can narrow what a block is ever spent on.

The extension is in English and Vietnamese and follows the browser's own UI
language; launching Chrome with --lang=vi shows the Vietnamese build of every
screen.

Our privacy policy mentions a public page that names some REPORTED accounts.
That page is served by our Firebase project, not by the extension: no code in
this upload reads it, links to it, or sends anything to it, and nothing about
a person who uses the extension is ever published on it.
```

That list of tags stops at "other" and does not name `redbull`, for the same
undecided reason §3 does not — and the reviewer-notes field is read by exactly
the audience the concern is about. If the owner decides the tag belongs in the
listing, it belongs here too, and both change together.

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

A fresh install fetches a real list, but hiding ships **off** and blocking is
silent and paced, so there is nothing on screen for a reviewer to point at in
the first minute. This is a common rejection reason and it is not really a
policy problem, just an unlucky first impression.

**What now answers it: `src/welcome/welcome.html`.** Installing opens it in a
tab, once. It teaches exactly one thing — find the profile, click the block
button, it is blocked — and then says what approval leads to, which is the
product. A reviewer who reads it knows what to try within thirty seconds, and
the two buttons on it open Facebook and Threads so they can try it without
typing an address.

It fires from `chrome.runtime.onInstalled` only when `reason === 'install'`,
and is additionally gated on a `welcomedAt` flag in `chrome.storage.local`.
The flag is what stops an unpacked reload — which reports itself as an install
— from opening a tab every time somebody saves a file. Local storage is wiped
on uninstall, so a genuine reinstall does show it again, which is right.
`chrome.tabs.create` needs no permission beyond what the manifest already
declares, so this added nothing to the permission list.

The reviewer-notes text in §4 still matters for the hide switch. If it gets
rejected on these grounds anyway, the cheapest answer is a listing screenshot
of a real feed with hiding on, not a change to the defaults.

### b. List-nominated blocks and "related user action"

Store policy is explicit that an extension must not send messages for the user
without a chance to confirm, and requires related user action before each
injected affiliate link. Blocking is neither of those things — but it is an
action taken on a third-party site on the user's behalf, and blocks that the
user never saw coming are the closest thing here to that pattern.

What argues for it: the cold ceiling defaults to 4/hour; the user sets every
cap; the two switches are the first thing on the options page, and unticking
**Work through the list too** turns list-nominated blocks off in one click while
leaving everything else working. Blocking itself is ON by default (an owner
decision, 2026-08-21), so the per-account pacing and that visible choice are
the whole defence in a review dispute.

What argues against it: **`blockFromList` ships ticked**, so the trending
metadata published with the list can put an account the user has never seen
into the queue, and it will be blocked without a per-account confirmation.
(The ranking itself runs locally in the extension, but the effect a reviewer
would care about is the same: the list's publisher chooses candidates the user
never looked at.)

**Worth considering before submitting:** ship `blockFromList` **unticked**,
leaving `blockSeen` on. Then every block in a default install traces to a
profile the user looked at, and working through the list becomes something they
opt into knowingly. It costs little — a user who wants the list worked through
is exactly the user who will find the switch, since it is the first control on
the page. This is a cleaner change than it was under the old mode picker: the
two switches are independent, so turning one default off does not quietly turn
anything else off with it.

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

### d. The public page, read as part of the product

The privacy policy discloses that the same backend names some reported accounts
on a public page. No code in the upload touches it — but a reviewer reads the
policy, and "this developer publishes a list of named people" is a sentence that
can attract questions the extension itself would never raise.

What answers them: publication requires a person to opt each account in
individually, and approving a report never publishes anyone; the page carries no
reporter identity of any kind; every published claim is backed by an `https`
link to the post it rests on, or it is not published at all; the page says in its
own words that it is one person's judgement rather than a ruling by Facebook or
Threads; and it prints a removal address. The disclosure is deliberately in the
policy rather than left to be discovered — a reviewer finding it themselves
after it was omitted is a much worse conversation.

### e. List-supplied `docIdOverrides`

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
- [x] At least one 1280×800 screenshot (two)
- [x] First-run guide opens on install and says what a report leads to (§6a)
- [x] No real accounts, real names or real reports in any asset
- [x] Privacy policy written and in the repo
- [ ] Developer account registered, $5 paid, email verified
- [ ] Trader / non-trader declared
- [ ] Privacy policy URL pasted into the dashboard
- [ ] Single purpose, permission justifications, data disclosures filled in
- [ ] Limited Use certification ticked
- [ ] Reviewer notes pasted
- [ ] Confirm the defaults for the two switches: `blockSeen` and
      `blockFromList` both currently ship **on** (§6b)
- [x] Decide whether the `redbull` tag is named in the listing copy (§3) —
      **decided: yes, it leads.** The mark is a red cow, the tiles and both
      screenshots run the *bò đỏ* joke in Vietnamese, and the reviewer notes
      should say plainly what the word means: internet slang for paid
      pro-government commenters, aimed at a posting behaviour and not at any
      nationality. Reviewers should not have to work that out from a cow.
- [ ] Localise the listing itself into Vietnamese in the dashboard (§3); the
      in-extension strings are already there
- [x] `_locales/en` and `_locales/vi` at key parity, checked by `check.js`
- [x] Store assets regenerated — the drawn explainer that said "two modes" is
      gone entirely, and the listing is down to one poster and one real
      capture (§2)
- [ ] `npm test` green, then zip: everything except `tools/`, `docs/`, `store/`, `hosting/`, the Firebase config files (`firebase.json`, `firestore.rules`, `firestore.indexes.json`, `.firebaserc`) and `.env`

The upload zip only needs what the extension actually loads: `manifest.json`,
`src/`, `icons/`, `_locales/`. The backend and the tooling are for you, not for
Chrome, and shipping them only widens what a reviewer has to read. `_locales/`
is not optional: a manifest declaring `default_locale` without it is refused at
load, so an upload that leaves it out fails before anyone reads a line of it.

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
