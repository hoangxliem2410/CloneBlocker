# Clone Blocker

A Chrome (Manifest V3) extension that blocks the accounts impersonating you on
**Facebook** and **Threads**, working from a hand-reviewed blocklist it fetches
from a Firebase project on the free plan. The address is compiled in, so there
is nothing to set up and nothing to grant.

No Facebook/Threads SDK. No Graph API. It works by using the sites' own internal
JavaScript — the module registry, the Relay runtime, and the Relay store — from a
MAIN-world content script. See [`docs/RESEARCH.md`](docs/RESEARCH.md) for what that means
and why it was the right call.

It speaks **English and Vietnamese**, and behind it sit two web pages on the
same project: a moderation dashboard only the admin can open, and a
[public list](#the-public-list) naming the accounts someone deliberately decided
to name.

---

## Two switches, plus tags, hiding and reporting

Real blocks are the product, and what a user is asked is where the extension may
go looking for them. Two tick boxes, both on by default, and neither one is the
other's alternative.

**Block clones I run into** (`blockSeen`). Profiles that turn up on the page
while you browse. Every one of them was on your screen anyway, which is the
pattern the platform finds entirely unremarkable, so they go through quickly
(4–11 seconds apart) and barely touch the rate limits.

**Work through the list too** (`blockFromList`). The accounts the published list
says are most active near you, whether or not you ever scroll past them. Those
were never on your screen, which *is* the pattern that draws a checkpoint, so
they are paced slowly (20–45 seconds) and held to a separate hourly ceiling of
their own (`maxColdBlocksPerHour`, default 4).

These were one picker with two positions, *passive* and *active*, until it
became clear that it was describing them as alternatives when they never were:
active always meant both. Worse, the shape made a perfectly reasonable request —
work through the list but leave what I scroll past alone — impossible to say at
all. One tick box each says the true thing: either, both, or neither.

**Untick both and nothing sweeps**, but the extension is not off: it still
hides, still reports, and still blocks the profile you press **Block now** on or
tick the block box for while filing a report. Pressing a button is a decision,
not a sweep, so it outranks the standing preferences — including the per-tag
ones.

**Blocking needs a tab, any tab, and more tabs do not mean more blocks.** Every
block is issued by driving the site's own code from inside a Facebook or Threads
tab, so blocking works whenever at least one of them is open — it does not
matter which, and a background tab counts. It also does not matter how many:
the pace is held by one gate in the service worker covering the whole browser,
not by each tab pacing itself, so five open tabs block at exactly the rate one
does. With none open, work from the list simply waits — the popup, the activity
page and a toolbar badge all say so, with the count.

**Pause blocking** (Advanced) stops both switches. Nothing is lost; queued
profiles wait.

**Hiding — a separate extra, off by default.** Suppresses a listed profile's
posts and comments in your browser without touching your account: it sends
nothing, changes nothing, has no ceiling, and covers the whole list the moment
it loads. It ships **off** because a real block is what the extension is for;
turn it on if you also want the list out of sight immediately, including the
thousands of profiles you will never scroll past.

**Which kinds — tags.** Every listed account carries one tag: *clone*,
*impersonation*, *scam*, *harassment*, *spam*, *Bò đỏ* (red bull —
a state-aligned troll) or *other*. One vocabulary throughout, in which a
reporter's reason is a vote and the target's tag is the verdict. Settings →
**Which kinds get blocked** has a tick box per tag (`blockTags`, all ticked by
default): untick *spam* and spam
accounts stop being blocked, whether they were nominated by the list or walked
past you on the page. It is an array matched by inclusion, so a tag introduced
in a later release is never blocked by an existing install until its owner opts
in — a new category must not start acting on its own. Hiding ignores tags
entirely: hiding is free and reversible, so rationing it by kind would buy
nothing.

**Reporting.** Users flag clone accounts from the page itself; an admin reviews
them and decides what reaches the blocklist. Nothing a user reports is blocked
automatically.

**English and Vietnamese.** Every surface — the popup, Settings, the activity
page, the report chip and sheet, and the reasons inside it — is translated, and
Chrome picks the language from the browser's own UI locale, so there is nothing
to choose. The public list has its own toggle (see below); the moderation
dashboard is English only, because it has one user.

---

## Reporting a clone

**On Threads, every post gets a report button** in its action row, right after
Share:

```
♡ Like    💬 Reply    🔁 Repost    ➤ Share    ⚑ Report clone
```

Clicking it opens a confirmation showing exactly what will be sent — the
username, the numeric id, a summary of the post's content, and a link to the
post — so nobody reports something without seeing what it refers to. The same
detail travels with the report, because a reviewer deciding whether an account
is a clone needs the evidence, not just a name.

**Anywhere else**, hover a profile link — a post author, a commenter, a name in
a reply thread — and a small **Report** chip appears. The chip also shows what
is already known: *Reported* if the account is already awaiting review,
*Blocked* if it is already on the list — derived from the cached list, with no
extra request.

The popup's first action is **Report as a clone**, for the profile the tab is
showing.

The whole widget lives in a Shadow DOM root. Facebook and Threads ship enormous
global stylesheets and rotate class names constantly; without that boundary the
widget would inherit their styles and could be caught by their own selectors.

It deliberately does **not** offer to report you to yourself, and ignores links
in site navigation — the sidebar "Profile" entry is a link to a profile, but it
is not someone you encountered in content.

## The public list

**https://clone-blocker2.web.app/** — a public page naming the accounts that
were reported, read by a person, and then deliberately published. Vietnamese by
default, because its audience is the people being impersonated, with an `en`
toggle that remembers itself.

**Being on the blocklist and being named here are two different decisions.**
Approving a report puts an account on the list every installation polls;
publishing puts a named accusation on a web page strangers will read, and
conflating the two would mean every moderation call quietly became a
publication. So publishing is **per-target opt-in**: the dashboard carries a
separate *Publish publicly* control, and a profile appears here only if it is
both approved **and** opted in. Most blocked accounts never appear at all, and
the page prints both numbers side by side so a reader can see how small the
named slice is.

A published profile carries its display name, username, numeric id, tag, how
many different people reported it, the day it was first reported and the day it
was last active, up to three coarse regions, and links to the posts cited as
evidence.

What it never carries is the load-bearing part:

- **No reporter identity, in any form.** Not the `acct_` pseudonyms, not
  per-reporter counts, not trust weights — only a headcount. The pseudonyms are
  stable across targets, so publishing even one would let anyone reconstruct who
  reported what.
- **No evidence without a link.** A quoted summary with no post behind it is an
  unverifiable claim about a named person, so the entry is dropped rather than
  published. The link must be https.
- **No moderator notes, and no per-region counts** — "two reports from
  `Asia/Ho_Chi_Minh`" narrows down a reporter in a way the bare region name
  does not.

The page says plainly that this is one person's judgement rather than a ruling
by Facebook or Threads, and anyone who believes they are listed by mistake is
pointed at the issue tracker; a profile whose case is not strong enough comes
down.

`blocklist/current` and `blocklist/publicView` are written in **one commit**, so
the page can never name someone the list beside it has already dropped, and
`tools/publish-static.js` mirrors both to the CDN together for the same reason.
The page itself is two classic scripts with no framework and no build step —
`hosting/i18n.js` for every word it says, `hosting/public.js` for the fetch and
the rendering — putting strangers' text about named people on screen through
`textContent` only, with every URL re-checked before it becomes an `href`.

## Moderation dashboard

Served by **Firebase Hosting** from your own project — for this one,
**https://clone-blocker2.web.app/admin/**. Sign in with the Firebase Auth email
and password the setup script created. (Google sign-in is switched off for now;
the allowlist holds UIDs, so adding it later is a matter of adding one more.)
The dashboard used to live at the site
root and moved under `/admin/` when the root became the public transparency
page, so an old bookmark needs updating. There is no server of yours to start or
keep running.

![Moderation dashboard](docs/shots/dashboard.png)

It is deliberately not in the extension. Shipping admin tooling inside a
distributed extension would put the admin credentials in every user's copy, and
moderating should not require the extension to be installed at all.

It gives you:

- **Stats** — pending / approved / rejected, total submissions, blocklist size,
  how many reports carry post evidence, a 14-day sparkline, and breakdowns by
  platform, by reason, and by reporter (which is what surfaces both your most
  useful reporters and anyone mass-reporting).
- **Queue** — tabs for pending, approved, rejected, all, plus the live
  blocklist. Free-text filter across name, @username, id and reason, and a row
  of tag chips to filter by verdict.
- **Tags** — every row shows its tag and where the tag came from: `auto · clone`
  is the modal reason across its reports, anything else is a decision someone
  made. A retag control overrides it, and retagging republishes, because an
  install that has narrowed its `blockTags` is acting on that word.
- **Publish publicly** — the per-target opt-in for the public page, shown per
  row alongside the approve/reject controls, so the rows that are merely blocked
  and the rows that are named in public are visibly different things.
- **Ranking dials** — the published `rankWeights`, tuned here with a live top-10
  preview beside them, so what the admin sees is what clients compute. Tuning
  them is a publish, not a setting.
- **Evidence inline** — the posts people cited, with their text and links, shown
  in the row rather than hidden behind a detail view.
- **Bulk actions** — select several and approve or reject in one request.
- **Blocklist management** — see every entry with why it was added, and remove
  it.

Reports are grouped per account, not per submission: a second person reporting
the same profile raises its count rather than adding a row, so the queue shows
distinct accounts ranked by how many people flagged them. **Approve → block**
puts it on the list every installation polls; an approved entry offers **Remove
from blocklist** instead.

Taking an entry off the list reopens its report rather than leaving it marked
approved, so the queue can never contradict the list itself — and since the
published list is rewritten after every decision, that agreement is structural
rather than something a transaction has to defend.

### Admin access

A short list of UIDs, and nothing else. **Sign in with the moderation account's
email and password.** The setup script creates that account in Firebase Auth
with a random password (written to `.env`, which is gitignored), pins its UID
in the allowlist inside `firestore.rules`, and disables public sign-up at the
Auth configuration level. There is no user database to administer: the rules
recognise the UIDs in that list, and nobody else can create an account to try.

Google sign-in is switched off for now. The provider is not enabled, the
dashboard has no Google button, and `firebase-setup.js` only touches the
provider when asked (`--with-google`). Turning it on later is the only thing
that makes the rest of this section matter.

**A project with nobody pinned is claimed by whoever signs in first.** A UID
compiled into the rules can only be added by editing and deploying that file,
which is a chicken and egg for a Google sign-in: you cannot learn your own UID
without opening a dashboard you cannot open. So when `adminUids()` is empty,
signing in creates `admin/allowlist` with that account inside and it becomes
the admin. The rules do the deciding — the create succeeds only when the
document is absent, only when the single UID inside is the caller's own, and
**only while nobody is pinned**. On a normally provisioned project there is
already an admin, so that door is shut; a second account cannot take a project
that has an owner.

Opening the window is deliberate, because sign-up is disabled by default:

```
node tools/firebase-setup.js --open-claim     # let an account be created
node tools/firebase-setup.js --close-claim    # shut it again
node tools/firebase-setup.js --claim-status   # who has it, is it still open
```

One allowlist, however many ways in. It holds UIDs, not sign-in methods, so a
Google account added later is one more entry rather than a second mechanism:

```
node tools/firebase-setup.js --list-admins            # who can moderate today
node tools/firebase-setup.js --add-admin <uid>        # add one and redeploy
```

You do not have to go hunting for the UID. Sign in first: an account the rules
refuse gets a screen naming it, printing its UID, and spelling out the exact
`--add-admin` command to run — being locked out of your own dashboard with no
way to learn your own UID is the failure mode that screen exists to prevent.

Either way the dashboard holds only a short-lived ID token in the page, and
signing out revokes it. No credentials live in the repository, there are no
defaults to change before exposing anything, and password handling, sign-in
throttling and token expiry are Google's Identity Toolkit rather than code in
this repo.

The privilege itself lives in the rules, not the dashboard. Every read of the
report queue and every decision write is checked server-side against the
admin uid allowlist in the rules, so the dashboard is just a convenience over data that only the
admin could touch anyway — a modified copy of it gains nothing.

**Reporting stays open and anonymous.** The whole point is that an ordinary
user can flag a clone without an account, a credential, or anything to
configure; the gate belongs at approval, not at intake. The rules make report
documents create-only for the public: anyone can file one, nobody but the
admin can read one back, edit one, or delete one.

## Firebase backend

The extension ships pointed at this project's backend, and that address is a
constant — `LIST_URL` in `src/common/protocol.js` — rather than a setting.
Running the whole thing yourself means editing that one line, adding its origin
to `host_permissions` in `manifest.json`, and reloading the extension. It is a
developer action on purpose: a URL field was the first thing a new user used to
meet, and it asked a question most of them had no way to answer.

The backend is a Firebase project on the **Spark (free) plan**: Firestore
holds the data, Hosting serves the public page and the dashboard behind it,
Auth holds the admin accounts. No Cloud Functions, and **no server code running anywhere** — every
piece of the old Node server moved into the extension, into the dashboard's
browser, or into the Firestore security rules:

| was (server, request-time) | is now |
|---|---|
| per-request target ranking by region/language | the **extension**, locally, from published per-target metadata |
| reputation, trends, stats aggregation | the **dashboard**, in the admin's browser (`hosting/logic.js`) |
| report validation and caps | **security rules** (reject, never truncate) + the extension clipping before it sends |
| approve/reject/revoke editing the list | **derivation**: the published list is recomputed from reports + decisions + manual entries after every decision |
| reporter pseudonym (HMAC with a secret salt) | client-side unkeyed SHA-256 (see "What changed", below) |
| per-IP rate limits, ETag/304, sessions, Basic auth | gone — they were server concepts |

The move improves privacy in one place worth saying plainly: **fetching the
list no longer sends anything about you to anyone.** The old server ranked
targets per-request from your region, language and remaining budget; the
extension now ranks locally from metadata published with the list, so those
values never leave your machine. Reports still carry your time zone and
language — the trending matrix is built from them — under the same **Send my
time zone and language** switch as before.

### One-command setup

```
node tools/firebase-setup.js --deploy
```

Zero dependencies, idempotent — every step checks before it creates, so
re-running is safe. It enables the APIs, creates the Firestore database and
the web app registration, turns on email/password and Google sign-in, creates
the admin user, disables public sign-up, puts the admin UID in the
`firestore.rules` allowlist, deploys rules and hosting, and seeds an empty
published list. It uses the credentials the Firebase CLI already holds, so
`firebase login` once is the only prerequisite.

Google sign-in needs an OAuth client id and secret, because the sign-in popup
is an OAuth consent flow and consent is granted to a client rather than to a
project. Pass `--google-client-id` and `--google-client-secret` if you have
them; if the project has no client and none are given, that one step prints the
console page to finish it on by hand and the rest of the run continues.

### Data model

| document | access | holds |
|---|---|---|
| `blocklist/current` | public read, admin write | the entire published payload as one JSON string, plus `rev` and `updatedAt` |
| `blocklist/publicView` | public read, admin write | what the public page renders: opted-in profiles only, no reporter identities. Written in the same commit as `current` |
| `reports/{platform~target~reporterHash}` | public **create only**; admin read/update/delete | one report per reporter×target — the doc id is the dedup key, so a repeat report is a create conflict, not a second row |
| `decisions/{platform}~{target}` | admin only | `approved` / `rejected` / `pending` (revoke reopens as pending), by whom, when — plus the optional `tag` override and the `public` opt-in |
| `admin/manual` | admin only | manually-added ids and usernames, the `docIdOverrides` hot-patch map, and the `rankWeights` dials |

Report shape and limits are enforced in `firestore.rules`, with the same caps
the old server had: display name 80, note and content summary 400 each, URLs
http(s)-only and ≤300 characters, narrow region and language patterns, a
4–24-digit profile id or a lowercase `@username`. The rules **reject**
oversized input rather than truncating it — rules cannot rewrite data — and
the extension clips to the same limits before sending, so an honest client
never trips them. Report time is the document's Firestore `createTime`; no
client clock is trusted.

The hardening habits that still apply survived the move: everything the
dashboard renders goes through `textContent`, and a URL is only rendered as a
link if it parses as http(s) — an anonymous reporter's `javascript:` href
still has no path to the admin's session.

### The published document

`blocklist/current` is what every installation polls. Inside its `json` field:

```jsonc
{
  "v": 1,
  "updatedAt": "ISO",
  "ids": ["63082166531", ...],          // blockable and hideable (numeric ids)
  "usernames": ["somename", ...],       // hiding only — nothing to block by
  "docIdOverrides": {},                 // persisted-query hot patches
  "pending": ["threads:9100000001"],    // report keys, status only — never blockable
  "targets": [                          // per-target ranking METADATA (not ranked)
    { "platform": "threads", "id": "9100000001",
      "username": "x", "displayName": "Y",
      "tag": "clone",                   // the verdict: admin override ‖ modal reason
      "trust": 1.5,                     // Σ reporter trust, computed at publish
      "reporters": 2,                   // headcount that sum is spread across
      "last": "2026-08-21",             // UTC day of the last report
      "days":    { "2026-08-21": 3 },   // ≤14 daily buckets
      "regions": { "Asia/Ho_Chi_Minh": 4 },
      "langs":   { "vi-vn": 4 } }
  ],
  "idTags": { "9100000001": "clone" },  // tag for every id in `ids`, for warm blocking
  "rankWeights": {                      // the ranking dials, tuned from the dashboard
    "halfLifeDays": 7, "velocityWeight": 1,
    "localityFloor": 0.25, "localityLangFactor": 0.8,
    "uniqueReporterBoost": 0
  }
}
```

`targets` holds only approved, id-bearing accounts whose id is already in
`ids`. A pending report can never be blocked — the single most
safety-critical invariant here — and it holds structurally, because the whole
document is recomputed and rewritten after every decision rather than edited
in place.

`idTags` exists because the flat `ids` array is what warm blocking matches
against, and a target resolved from the page you are looking at has no `targets`
record to consult. An id with no reports behind it — one an admin added by
hand — is published as `other`: the tag every install blocks by default, but the
first one an owner narrowing their tags would drop, which is the right way round
for an entry nobody voted on. Nothing in this document says who opted a profile
into the public page; the `public` flag lives on the decision and reaches only
`blocklist/publicView`.

### What changed vs the old server

An honest list, because each of these is a real trade the migration made:

- **The reporter pseudonym is an unkeyed hash now.** The server HMAC'd the
  account id with a secret salt; a pure client has nowhere to keep a secret,
  so the pseudonym is `acct_` + 24 hex characters of a plain SHA-256. Reports
  are admin-read-only, so the hash is defence in depth rather than the
  primary barrier — but someone holding a candidate account id *and* a copy
  of the report store could verify a guess offline, which the salted version
  prevented.
- **Per-IP and per-account rate limits are gone.** What remains is structural
  dedup — one document per reporter×target — and the shape caps in the rules.
  A hostile signed-in account can file many reports for many targets; the
  reputation weighting and the held queue absorb that, and the admin deletes
  junk. App Check is the future answer if it becomes a real problem.
- **Duplicate re-reports are inert.** The server refreshed evidence and
  `lastReportAt` on a duplicate; create-only storage makes a same-reporter
  repeat a no-op. Fresh activity signal now comes only from new reporters.
- **No more `304`s.** Every poll is a full-body read of the published
  document — tens of kilobytes, hourly. Day-quantised ranking keeps the
  content itself stable within a day.
- **The 20,000-account store cap and `507` are unenforced** — rules have no
  counters. The publish step's 2,000-target cap bounds the public document
  instead.

## Polling without paying for it

The list is written rarely and read constantly, so two mechanisms keep the
reads from costing anything:

- **The extension probes before it downloads.** Against a Firestore list URL
  it asks for a single masked field first (~300 bytes) and compares the
  document's `updateTime` to its cache; the full blob is only fetched when the
  list actually changed. An unchanged day costs kilobytes, not megabytes.
- **The list can be served as a static file.** `node tools/publish-static.js`
  snapshots `blocklist/current` to `hosting/blocklist.json` and deploys it;
  `--interval 30` keeps watching and redeploys only when the document changes.
  Firebase Hosting then serves it CDN-cached with a real ETag -- an unchanged
  poll is a genuine `304` with zero bytes of body and **zero Firestore reads**,
  so read quota stops being a function of how many people run the extension.

  Serving the list from that file while reports keep going to the database
  moves only the first of the two addresses:

  | | Value |
  |---|---|
  | `LIST_URL` in `src/common/protocol.js` | `https://<project>.web.app/blocklist.json` |
  | **API base** — Settings → Advanced → Clone reporting | `https://firestore.googleapis.com/v1/projects/<project>/databases/(default)/documents` |

  This project's own Hosting origin is already a declared permission, so the
  snapshot it deploys needs no manifest change; another project's would.

  The trade is freshness: clients see a decision when the snapshot next
  deploys, not the moment it is made. For a blocklist that is exactly the
  right trade.

## Too many clones for one account

A blocklist of a few thousand cannot be worked through by one account. The
platforms checkpoint an account that blocks at volume — which is the failure
this whole thing exists to avoid, arriving by a different road.

So the list is served as **two lists, because the two things you can do with a
clone cost completely different amounts.**

| | what it covers | cost | rationed? |
|---|---|---|---|
| **Hiding** (off by default) | everything on the list | nothing | no |
| **Blocking** | a ranked, budgeted slice | your account | yes, tightly |

Hiding a clone is free and carries no risk, so there is no reason to ration
it — it is off by default because it is not what the extension is *for*, not
because it is expensive. A real block is what gets an account checkpointed, so
it has to be spent on the few clones that are active *now* and operating
*where you are*.

### Warm and cold — what the two switches are underneath

Not all blocks look the same to the platform. Blocking someone whose profile is
on your screen is what an ordinary person does all day. Working through a list of
accounts you have never encountered is not, and it is the pattern that draws a
checkpoint.

So the queue tracks how each target got there:

- **warm** — resolved from the page you are looking at. Paced normally (4–11s),
  limited only by the overall hourly cap.
- **cold** — nominated by the trending metadata published with the list, never
  seen in this browser. Paced slowly (20–45s) and held to a much tighter
  ceiling of its own (`maxColdBlocksPerHour`, default 4).

**`blockSeen` is the warm half; `blockFromList` is the cold half.** That is all
the two switches are underneath, and it is why there are two of them rather
than one dial: the halves carry genuinely different risk, so they get different
pacing, different ceilings, and either can be declined without giving up the
other. Every block runs inside a Facebook or Threads tab, so warm work has one
by definition; cold work is the half that can sit waiting for one, which is
what the badge counts.

**The pacing is per browser, not per tab.** Each open tab runs its own worker
loop, and a loop that paced itself would be fine with one tab and wrong with
five: leases stop two tabs blocking the *same* profile, but nothing stopped
five tabs blocking five *different* ones in the same second — five times the
rate these ceilings were chosen for. So the pace is held in the service worker
instead. One gate for the whole browser: shut while a block is in flight,
bounded by the lease so a tab that dies mid-block cannot wedge the queue, and
shut again for the randomised delay after the result lands. Whichever tab asks
first gets the next target; the rest are told when to come back. It spans both
sites as well as both tabs, because Facebook and Threads are one Meta account
and the account is what gets checkpointed.

Warm is claimed first — it is both the safer and the more relevant signal, so the
two orderings agree far more often than they conflict. Reaching the cold ceiling
never stops warm work: rationing the ordinary case to protect against a risk it
does not carry would just make the extension feel broken.

**Seeing a cold target on screen promotes it to warm.** The same block is
unremarkable now and conspicuous later, so it is taken while it is cheap.

Set `maxColdBlocksPerHour` to **0** to never block anyone who has not appeared
on your screen — the same end as unticking **Work through the list too**, reached by
the ceiling rather than by the switch. The switch is the honest way to say it:
with the ceiling at zero the list still seeds a queue nobody will ever spend.

### The trending matrix

Reports carry a coarse origin: the reporter's IANA time zone and language tag.
Both are things the browser already hands to every site it loads, and neither
needs an IP lookup, a geo database, or a third-party service. Turn it off with
**Send my time zone and language** in options.

The published list carries 14 daily buckets and a region tally per approved
account, and the **extension ranks them locally**:

```
rank = trust × recency × (1 + velocityWeight × velocity7d) × locality × boost

  trust      trust-weighted report score (see "Who filed the report")
  recency    0.5 ^ (days since last report / halfLifeDays)
  velocity   reports in the last 7 days
  locality   localityFloor + (1 − localityFloor) × how much of this clone's
             activity is near you
  boost      1 + uniqueReporterBoost × log2(1 + unique reporters)
```

**The dials are published, not compiled in.** `rankWeights` rides in the list —
`halfLifeDays` 7, `velocityWeight` 1, `localityFloor` 0.25,
`localityLangFactor` 0.8 (language counts a little less than region),
`uniqueReporterBoost` 0 — so the owner can retune ranking from the dashboard
without shipping an extension update, and the dashboard's preview ranks with
exactly the numbers clients will. Those defaults are today's ranking, term for
term: `uniqueReporterBoost` at 0 makes its factor exactly 1, so the formula is
byte-identical to the one that predates the dials. A list published before they
existed carries none, and a single nonsensical value falls back on its own
rather than dragging the tuned ones down with it.

The unique-reporter term is the one worth explaining. Trust is linear, so two
reporters at 0.75 outrank one at 1.5 by nothing at all; raise the boost and four
independent people saying the same thing start to outweigh one reporter with a
long record. Which is right is an empirical question, which is exactly why it is
a dial rather than a decision baked into a release.

"Near you" is your own browser's time zone and language, compared against the
published tallies **on your machine**. The fetch itself carries nothing about
you — the old server did this ranking per-request, which meant telling it your
region and remaining budget on every poll; now nobody learns either. Turn
**Send my time zone and language** off and locality is simply 1 for every
target: the ranking degrades gracefully instead of leaking.

Locality never zeroes a target out — a clone that is merely hot elsewhere
stays reachable, just lower. Everything is quantised to whole days on purpose:
a continuously-decaying score would reorder the queue on every poll, and a
ranking that cannot be reproduced an hour later cannot be inspected either.

The extension takes the top of its own ranking up to what its rate limiter
still has room for, so the slice it acts on is one it can actually spend.

The dashboard shows the matrix — regions down the side, days across, with what
is driving each region underneath — computed in the admin's browser from the
same reports, so the ranking can be inspected before it is trusted.

### Who filed the report

Reports carry the platform account behind them — `facebook:100000000000001`,
read from the page the extension is already running in. A report with no account
is refused with `signed-out`, and the sheet says so before you type rather than
after you submit.

**This is not verified, and it cannot be.** `fb_dtsg`, `lsd` and the session
cookies are opaque artifacts that only Meta can validate, and validating them
means Meta's API — excluded here by design. A patched extension can send any
number it likes. What the binding buys is *cost*: the previous scheme keyed the
reporter on a UUID the extension minted for itself, so clearing extension storage
produced a brand new reporter and one person could raise any report's count
without limit. Inflating a count now takes real accounts, and — more importantly
— it gives reputation something stable to attach to.

The raw account id is never stored. The extension hashes it before it leaves
the browser — SHA-256 of `platform:id`, truncated to a stable pseudonym
(`acct_0f8df7554dc15a7f9be22c31`) — which is everything reputation needs,
*is this the same person as last time*, without keeping the number itself. A
persistent bad actor is still bannable: you ban the pseudonym. The hash is
unkeyed now — a pure client has nowhere to keep a secret salt — which makes
it one honest notch weaker than the old server's HMAC; the trade is spelled
out in "What changed vs the old server" above.

### Reputation

Every decision teaches the system something. Approving a report credits everyone
who filed it; rejecting one debits them. A reporter's weight is
`(approved + 0.5) / (approved + rejected + 1)` — a Jeffreys prior, so an unknown
reporter sits at `0.50`, one bad call does not ruin a good history, and one lucky
call does not buy trust.

Reputation is **recomputed from the decided reports** on every dashboard
refresh, never accumulated. A running tally has to be un-done when a decision is revoked, and
every bug in that path is a reporter whose score is quietly wrong forever.
Revoking an approval takes its credit back automatically.

The queue is ranked by **trust-weighted score**, not raw count: ten reports from
accounts that have never been right about anything should not outrank two from
people who consistently are. A report whose every reporter sits below the trust
floor (`0.25`) is marked **held** and sinks to the bottom — still recorded, still
visible, just not able to jump the queue. Each row shows who stands behind it and
their record (`5✓ 0✗`).

### What this does not stop

Someone with several genuine Meta accounts, patient enough to build a record with
each, can still push a false report through. That is the honest ceiling of any
scheme that does not have Meta vouching for identities. What it costs them is
real accounts and real time, and the moment a decision goes against them, every
account involved loses weight — including on reports they filed earlier.

---

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this directory.
3. That is the whole setup. There is no address to enter and no permission
   prompt to accept: the list's origins are required permissions, so the list
   loads on the first refresh and both switches — **Block clones I run into**
   and **Work through the list too** — start working at their cautious paced
   defaults, as soon as a Facebook or Threads tab is open. Either can be
   unticked in Settings. Hiding waits there too for anyone who wants it, as do
   the per-tag tick boxes, which start with every tag ticked. It comes up in
   Vietnamese if that is what Chrome is running in, and in English otherwise.

Requires Chrome 120+ (`"world": "MAIN"` needs 111; the 30-second `chrome.alarms` floor
and MV3 behaviour here assume 120).

## Publishing to the Chrome Web Store

Everything the listing needs is generated and reproducible:

```
npm run store-assets       # icons, promo tiles, marquee, screenshots -> store/
```

The icons are drawn from distance fields with no dependencies, so they stay
crisp at 16px instead of being a downscaled bitmap. The promo tiles and
screenshots are laid out in HTML and captured at their exact pixel size, and
the screenshots of the extension's own pages are genuine captures from a
browser with it loaded rather than mockups.

**[docs/CHROME-WEB-STORE.md](docs/CHROME-WEB-STORE.md)** has the rest: the
current requirements with sources, the listing copy ready to paste, permission
justifications, the data-collection disclosures, reviewer notes, a
pre-submission checklist — and an honest read on where this could be rejected,
including the parts that cannot be engineered away.

[PRIVACY.md](PRIVACY.md) is the privacy policy the store requires, and its
claims are checkable against the source: the only outbound requests in the
extension go to the two Meta origins and the one baked-in list address.

---

## Self-hosted and static lists

The extension does not require Firebase. Point `LIST_URL` at anything returning
JSON in one of the shapes below (see [Firebase backend](#firebase-backend) for
how) and it works — a static file on any host you control is a complete backend
for hiding, and this is also the escape hatch if you ever want off Google
entirely. `GET <your endpoint>` returning JSON:

```jsonc
// simplest
["100001234567890", "100009876543210"]

// explicit
{ "ids": ["100001234567890"], "usernames": ["some.handle"] }

// records
{ "blocked": [ { "id": "100001234567890", "username": "some.handle" } ] }
```

A plain newline-delimited list of ids also works.

Optionally include `docIdOverrides` to hot-patch a Meta persisted-query rotation without
shipping a new extension build:

```jsonc
{
  "ids": ["100001234567890"],
  "docIdOverrides": { "ProfileCometActionBlockUserMutation": "6305880099497989" }
}
```

**`ETag` / `If-None-Match` is honoured** — a server that returns `304` for an
unchanged list makes refreshes cost almost nothing. (Firestore does not play
this game; the trade is listed under "What changed vs the old server".) An
endpoint behind a token is still supported through the `listAuthHeader`
setting, though — like the address itself — nothing in the UI writes it any
more.

A list in one of these shapes carries no tags, and nothing breaks: an id with no
tag behind it counts as `other`, which every install blocks unless its owner has
unticked that box.

Reporting is the one thing a static file cannot carry: against a plain-JSON
endpoint the extension still hides and blocks, but the report button needs
somewhere to write, which is what the Firestore backend provides.

---

## Why IDs *and* usernames

Facebook rarely puts a numeric profile ID in the DOM — vanity URLs render as
`facebook.com/someone` with nothing else to key on.

The extension solves this by sweeping Meta's Relay store, which holds `id ↔ username`
pairs for everything on screen, and caching that mapping in `chrome.storage`. So a list
expressed purely in numeric IDs still matches a page that only shows usernames, and vice
versa. The mapping improves the more you browse.

Numeric IDs are still the better key: they survive a username change.

---

## Authorship, not mentions

A blocked profile appearing *inside* someone else's post — a comment, a tag, a
"X shared this" — does not take that post down. Only what they actually wrote is
hidden: their own posts, and their own comments wherever those appear.

This matters more than it sounds. Harvesting every link in a story is the easy
implementation, and it makes a blocker feel broken: one blocked person commenting
on a friend's photo would erase the friend's photo. Author extraction is scoped to
the byline (headings/`<strong>` next to the avatar) and excludes anything inside a
nested comment subtree, on both the DOM and Relay paths.

---

## Architecture

```
  Firestore (or any JSON URL)
          │  (fetch: service worker only — page CSP blocks it anywhere else)
          ▼
┌─────────────────────┐
│   service worker    │  blocklist cache · ETag · alarms
│                     │  block queue · leases · rate limiter
└──────────┬──────────┘
           │ chrome.runtime
┌──────────▼──────────┐
│  ISOLATED content   │  chrome.* APIs · DOM suppression · id index
│    scripts          │
└──────────┬──────────┘
           │ window.postMessage  (worlds cannot share objects)
┌──────────▼──────────┐
│  MAIN world script  │  __d hook · require() · Relay env + store
│  (document_start)   │  React fibers · commitMutation · request capture
└─────────────────────┘
```

The split is forced by the platform: MAIN-world scripts get **no `chrome.*` APIs**, and
isolated-world scripts cannot see the page's `require`, its Relay store, or React's
expando properties on DOM nodes.

| File | Role |
|---|---|
| `src/common/i18n.js` | `CB_T` over `chrome.i18n`, and the `data-i18n` sweep every page runs |
| `src/main/inject.js` | Module-registry hook, tokens, Relay, block strategies, request capture |
| `src/content/bridge.js` | MAIN ↔ ISOLATED ↔ service-worker messaging |
| `src/content/identity.js` | Blocklist index, id↔username alias cache |
| `src/content/dom-blocker.js` | Selector engine + MutationObserver |
| `src/content/main.js` | Orchestration, Relay store sweep, block worker |
| `src/background/service-worker.js` | List fetch, local target ranking, queue, rate limiter, alarms |

---

## If it says "block mutation not found"

That is expected, not a failure. Meta ships the block module lazily — it genuinely is not
in the page until something needs it, and neither `Bootloader.loadModules` nor
`requireLazy` can pull it by name (both time out; the loader needs a resource map that
only ships when a component needing it renders).

**Open any profile's "..." menu once.** That loads the module, after which
`require('useTHUserBlockMutation.graphql')` resolves and the extension can drive the
site's own Relay code for the rest of that page load.

The extension also watches `fetch` and `XMLHttpRequest` and captures a real block request
if it sees one — including the generated Relay provider variables that cannot be
reconstructed by hand. That capture is only used when raw fallback is explicitly enabled;
it excludes the extension's own requests, so it cannot learn from its own failures.

---

## Testing

```bash
node tools/check.js            # static: syntax, manifest refs, MV3 CSP, locales
node tools/queue-test.js       # block queue + rate limiter (mocked chrome.*)
node tools/firebase-test.js    # security-rules matrix + ported logic, emulator
node tools/e2e-test.js         # hiding + Relay discovery, browser
node tools/dashboard-visual.js # the dashboard, rendered against fixtures
npm test                       # the first four
```

`check.js` also holds the rules that keep vocabulary from drifting back: the
retired "Layer 1 / Layer 2" framing fails the build if it reappears in anything
a user can read; so does the `mode` setting the two switches replaced — nothing
under `src/` may read it, compare against `'passive'` or `'active'` or call
`CB_MODE_OF` except the two back-compat readers that keep old installs working,
and no page may hardcode either word or keep the radio buttons that wrote it.
The locale checks fail the build if the two message files disagree. Those are key parity in both directions, a non-empty message and a
non-empty description on every key, matching `$1` placeholders across languages,
every key the UI asks for existing in `en` — and no user-visible text anywhere in
a page's markup outside a `data-i18n` element, so a string added later cannot
quietly skip translation.

`firebase-test.js` runs against the Firestore **emulator** and needs no real
project or network. It drives the rules over plain REST — every accept and
reject case in the report validation matrix, a stranger refused reading
reports or writing decisions, the public list readable with no credentials at
all, and a repeat report from the same account bouncing off the create-only
dedup as a conflict. Then it feeds fixture reports through the ported compute
in `hosting/logic.js`: aggregation, reputation and its claw-back on revoke,
held ordering, the id-versus-username publish asymmetry, pending never
reaching the blockable targets, the stats and trends shapes, and the
day-quantised local ranking — including the regional flip in both directions,
because a ranking that only flips one way is a ranking with a bug.

It also holds the public view to its promises against the **serialised bytes**
rather than the intent: that nothing unapproved or un-opted-in appears, that a
search of the whole published JSON finds no `acct_` anywhere, that evidence
without an https link is dropped while a summary behind one survives, that notes
never appear and regions appear without their counts — and that `current` and
`publicView` move together.

`queue-test.js` drives the real service-worker message handler against a mocked
`chrome.*`, covering the block queue, leases and rate limiter — logic the
browser test deliberately never exercises, because it must never block anyone for
real. It verifies that a failing target backs off instead of starving the queue,
that failed *attempts* (not just successes) count toward the caps, that dry runs
rotate without consuming the limit, and that two tabs cannot claim the same
target. It also covers the tag filter — that `blockTags` gates both cold seeding
and warm enqueue, that an unticked tag is skipped in both, that an
untagged id counts as `other`, and that the popup's user-initiated **Block now**
goes through regardless — and that both rankers read the published weights the
same way, at the defaults and at tuned values.

The two switches get all four combinations, driven end to end through a real
refresh for the cold side and a real enqueue for the warm one: `blockSeen` off
with `blockFromList` on (the pair the old radio could not express), the
converse, both, and neither — with **Block now** still going through when
neither is ticked, because pressing a button is a decision rather than a sweep.
Installs written before the pair existed are held to their old behaviour: `mode:
'passive'`, and the older `acceptServerTargets: false`, each still refuse cold
work while still blocking what turns up on screen. The pacing gate gets the
cases a single tab cannot show: five simultaneous claims yield one block, a
block in flight on Threads holds a Facebook tab back too, the pause after a
result is the warm delay rather than the lease, and a tab that dies mid-block
wedges the queue only until its lease expires.

`e2e-test.js` loads the extension into real Chrome and exercises it against live
`threads.com` and `facebook.com`: manifest load, service-worker boot, a list
fetch from a seeded Firestore emulator, bridge handshake, module hook, Relay
discovery, that content from a listed profile is genuinely hidden, and that the
service worker derives its ranked targets locally from the published metadata.
It asserts that **no real block is attempted**.

Current status — **26/26 browser · 90/90 queue · 132/132 firebase · static
clean**, and `dashboard-visual.js` green. A sample of the browser run:

```
PASS  extension service worker started
PASS  blocklist fetched + parsed by service worker      — 1 ids, 1 usernames
PASS  MAIN world hooked Meta module registry            — 4869 modules, 578 graphql
PASS  live Relay environment discovered                 — BarcelonaRelayEnvironment, 593 records
PASS  Relay commitMutation available
PASS  MAIN world request/response round-trip resolves   — 1ms
PASS  content from blocklisted profile is hidden        — 20 hidden, 0 visible
PASS  judged by authorship, not by being mentioned      — mention post stays visible
PASS  the blocked profile's own nested comment is hidden
PASS  placeholder hide mode applies after settings change — 20 placeholders
PASS  disabling hiding restores all content              — 0 hidden, 0 leftover
PASS  no real block was attempted (safety)
PASS  facebook: MAIN world hooked module registry       — 2728 modules, 33 graphql
PASS  facebook: Relay environment reachable             — CometRelayEnvironment
```

Note: current Chrome builds ignore the `--load-extension` switch, so the harness loads the
extension over CDP (`Extensions.loadUnpacked`). Loading unpacked via `chrome://extensions`
in normal use is unaffected.

---

## Verified against a live signed-in account

Real blocking was tested end to end on a real Threads account:

- **Blocking works** via `RelayModern.commitMutation` driven with Threads' own
  operation node (`useTHUserBlockMutation`, `POST /api/graphql`). The block took
  effect and the session survived.
- **Raw request fallbacks are off by default and should stay off.** Hand-built
  CSRF-bearing POSTs to the Instagram REST paths 404 on threads.com *and*
  coincided with Meta invalidating the signed-in session, twice. Driving the
  site's own code never did. See [`docs/RESEARCH.md`](docs/RESEARCH.md).
- **One constraint:** the block module is lazily loaded, so it is only reachable
  after the block UI has been opened once in that page load. `Bootloader` and
  `requireLazy` cannot force it.

---

## Limitations and honest caveats

- **Facebook blocking is verified too.** `ProfileCometActionBlockUserMutation` via
  `POST /api/graphql/`, driven through `commitMutation`. The block appeared in
  Facebook's own Settings -> Blocking list and was reversed from there. On
  Facebook the module loads only once the block **confirmation dialog** is
  raised -- opening the overflow menu is not enough.
- **Blocking on Facebook has an irreversible side effect.** It consumes a
  pending friend request, and unfriends an existing friend. Unblocking restores
  neither.
- **Blocking needs the block module primed.** Until the site has loaded it, the
  extension reports that plainly and does nothing rather than firing a request.
- **Blocking only moves while a tab is open.** Blocks are issued from inside
  facebook.com or threads.com, so with neither open the queue holds and the
  toolbar badge counts what is waiting. Any one tab is enough, and opening more
  buys nothing: one gate in the service worker paces the whole browser. A
  pinned background tab or an offscreen document would lift the constraint;
  neither is built yet.
- **Rate limits are guesses.** No public source documents Meta's block thresholds. The
  defaults are deliberately conservative. Bulk-mutating an account can trigger a
  verification checkpoint — the extension detects that, halts, and stops blocking.
- **Selectors will drift.** Comet and Barcelona generate obfuscated, rotating class names.
  This code keys only on semantic attributes (`role`, `aria-*`, `data-pagelet`,
  `data-pressable-container`), which are far more stable, but nothing here is guaranteed
  against a redesign.
- **Blocking mutates your account.** Blocks are not silently reversible in bulk. Keep dry
  run on until you have watched it resolve a real strategy.
- Automating interactions may be inconsistent with the platforms' terms of service. That
  judgement is yours to make.

---

## Layout

```
manifest.json
_locales/  en/ vi/         messages.json each; the store name and description too
src/  main/ content/ background/ popup/ options/ activity/ common/ ui/
src/common/i18n.js        CB_T and the data-i18n sweep, loaded before everything
firestore.rules           the whole trust model, enforced server-side
firebase.json             Firestore + Hosting + emulator configuration
hosting/index.html        the public transparency page (the site root)
hosting/public.js         its fetch and rendering — textContent only, no strings
hosting/public.css
hosting/i18n.js           CB_T again, over a plain dictionary, for the hosted pages
hosting/admin/            the moderation dashboard, served at /admin/ (English)
hosting/logic.js          pure compute shared by the dashboard and the tests
tools/firebase-setup.js   one-command project provisioning, --add-admin/--list-admins
tools/firebase-test.js    rules matrix + ported logic, against the emulator
tools/publish-static.js   mirrors both published docs to the CDN
tools/fb.js               finds the Firebase CLI wherever it is installed
tools/check.js            static checks, including locale parity
tools/e2e-test.js         end-to-end browser test
tools/dashboard-visual.js the dashboard rendered against fixtures
tools/make-icons.js       dependency-free PNG generation
tools/make-store-assets.js  listing tiles and screenshots, at exact sizes
docs/RESEARCH.md          internals findings, with what is and isn't verified
docs/FIREBASE-SPEC.md     the migration contract, formula by formula
docs/PHASE23-SPEC.md      tags and the ranking dials, normative
docs/PHASE45-SPEC.md      the public page and Google sign-in, normative
docs/PHASE6-SPEC.md       English and Vietnamese, normative
docs/CHROME-WEB-STORE.md  store requirements, listing copy, rejection risks
docs/ROADMAP.md           what was built, phase by phase, and what is still open
store/                    generated listing assets
PRIVACY.md                privacy policy (required by the store)
```
