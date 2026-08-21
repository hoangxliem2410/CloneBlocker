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
2. **Two layers** — the hide/block split, drawn rather than captured (see below).
3. **Options page** — a real capture, clipped to the Layer 2 budget controls.
4. **Moderation dashboard** — a real capture, entirely synthetic fixture data.

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

### Name (45 max) — 12 used

```
3Que Blocker
```

### Short description (132 max) — 120 used

Also the `description` field in `manifest.json`; the store reads it from there.

```
Hide clone accounts impersonating you on Facebook and Threads — and block the most active ones at a safe, rationed pace.
```

### Category

**Social & Communication.** (Not *Productivity* — the store dislikes category
mismatches, and this is not a productivity tool.)

### Detailed description

```
Someone is running accounts that pretend to be you. 3Que Blocker deals with
them in two ways, because the two cost very different things.

HIDE THEM — free, and covers everything
Every profile on your list disappears as the page loads: their posts, their
comments, their profile pages. Hiding happens entirely in your browser, sends
nothing, changes nothing on your account, and has no limit. It runs on the
whole list.

BLOCK THEM — rationed, on purpose
A real platform block is the thing that gets an account checkpointed if you do
too many of them, which is the exact failure this extension exists to avoid.
So blocking is opt-in, off by default, and paced:

  • Profiles you actually see on screen are blocked at a normal pace. Blocking
    someone whose profile is in front of you is what ordinary people do.
  • Accounts suggested by your server that you have never seen are held to a
    separate, much tighter hourly ceiling — which you set, and which you can
    set to zero to never block anyone you have not seen.
  • Every delay, cap and ceiling is yours to change. The cautious values are
    the ones it ships with.

REPORT A CLONE IN TWO CLICKS
Hover a name in the feed, or open the profile, and file a report with the
posts that prove it.

YOU RUN THE LIST
3Que Blocker does not ship a blocklist and does not host one. It fetches from
a server you run — that backend is open source and included, with no
dependencies. Reports arrive in your own moderation dashboard, ranked by
reporter reputation and by where the clone is currently active, and nothing
reaches the blocklist until you approve it.

WHAT IT SENDS, AND WHERE
Only to the server you configure, and nowhere else:
  • the blocklist request itself;
  • when you file a report: the reported profile's ID or username, the reason
    you pick, any note and post links you add, and your own platform account
    ID — so that reports can be weighed by reputation and abuse can be
    rate-limited;
  • optionally, your time zone and language, so suggestions can be ranked
    towards clones active near you. This is a single switch and you can turn
    it off.
Your account ID is stored by the backend only as a salted hash. There is no
analytics, no tracking, no ad network, and no third-party service of any kind.

REQUIREMENTS
You need somewhere to run the backend — a laptop, a Raspberry Pi, or any small
VPS. Setup is `node server/server.js`. Source, backend and documentation:
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
Suppress and block accounts that impersonate the user on Facebook and Threads,
using a blocklist the user supplies from their own server.
```

Hiding, blocking and reporting are one purpose, not three: reporting is how an
account gets onto the list, hiding and blocking are how the list is applied.
Nothing in the extension serves any other end.

### Permission justifications

| Permission | Justification to paste |
|---|---|
| `storage` | Stores the user's settings and the cached blocklist so the list does not have to be re-fetched on every page load. Nothing is stored anywhere else. |
| `alarms` | Refreshes the blocklist on the user's chosen interval, and paces platform blocks so they are never issued in a burst. |
| `host_permissions` — facebook.com, threads.net, threads.com | The extension's entire function is to hide and block impersonator accounts on these two sites. It reads the page to find profiles from the user's list and, when the user has enabled it, issues a block through the site's own interface. |
| `optional_host_permissions` — `https://*/*` | The blocklist lives on a server the **user** runs and whose address they type into the options page, so the origin cannot be known in advance. This is optional, never granted at install, and requested at runtime for **only** the single origin the user entered, via a Chrome permission prompt they must accept. |
| `optional_host_permissions` — `http://localhost/*` | Many users run the included backend on their own machine, where it is reached over plain HTTP on localhost. Same optional, per-origin, user-accepted flow. |

### Data collection disclosures

Tick these, and be prepared to explain each:

| Category | Collected? | What, and why |
|---|---|---|
| Personally identifiable information | **Yes** | The user's own Facebook/Threads numeric account ID, sent with a report only. Necessary so that reports can be weighted by the reporter's track record and so a single account cannot flood the queue. The backend stores it only as a salted HMAC pseudonym; the raw ID is never written to disk. |
| User activity | **Yes** | The reports the user chooses to file: the reported account, the reason, an optional note, optional links to posts. |
| Website content | **Yes** | Only what the user attaches to a report — public post URLs and an optional short quote of the content they are reporting. |
| Location | **Yes, coarse, optional** | IANA time zone and BCP-47 language, from the browser, sent only when **Send my time zone and language** is on. No IP lookup, no geolocation API, no geo database. Used to rank which clones are worth spending a block on. |
| Authentication information | No | |
| Financial / health / personal communications | No | |

### Limited Use certification

You must certify that the data is used only for the disclosed single purpose.
That is true here — it goes to the user's own server and nowhere else, and
there is no analytics, telemetry, ad network or third-party endpoint anywhere
in the code. Grep it: the only network destinations are the two Meta origins
and the endpoint the user typed.

### Notes for the reviewer

This field matters more than usual here, because an unconfigured install shows
a reviewer nothing at all. Suggested text:

```
This extension has no built-in blocklist by design — it fetches from a server
the user runs, so out of the box it is inert.

To exercise it end to end:
  1. git clone https://github.com/hoangxliem2410/CloneBlocker
  2. node server/server.js --port 8787
  3. In the extension's options, set the endpoint to
     http://localhost:8787/blocklist.json and press "Grant access", then
     "Test & refresh now".
  4. Add an account to the list at http://localhost:8787/admin
     (default sign-in admin / admin123), then load Threads or Facebook.

Layer 1 (hiding) works immediately and sends nothing.
Layer 2 (platform blocking) is OFF by default and additionally ships with a
dry-run switch on, so nothing can be blocked until the user deliberately
turns both off.
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

There is no default blocklist, so a fresh install does nothing visible. This is
a common rejection reason and it is not really a policy problem, just an
unlucky first impression. The reviewer-notes text in §4 exists for this. If it
gets rejected once on these grounds, consider shipping a tiny default list of
known-impersonator accounts so the extension demonstrates itself.

### b. Server-nominated blocks and "related user action"

Store policy is explicit that an extension must not send messages for the user
without a chance to confirm, and requires related user action before each
injected affiliate link. Blocking is neither of those things — but it is an
action taken on a third-party site on the user's behalf, and blocks that the
user never saw coming are the closest thing here to that pattern.

What already argues for it: platform blocking is **off** by default; dry run is
**on** by default; the cold ceiling defaults to 4/hour; the user sets every cap;
`acceptServerTargets` can be turned off entirely.

What argues against it: with blocking enabled, `acceptServerTargets` defaults
to **true**, so the server can nominate an account the user has never seen and
it will be blocked without a per-account confirmation.

**Worth considering before submitting:** default `acceptServerTargets` to
`false`. Then every block in a default install traces to a profile the user
looked at, and the server-suggestion feature becomes something they switch on
knowingly. It costs little — a user who wants suggestions is exactly the user
who will find the setting.

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

### d. `https://*/*` in optional_host_permissions

Broad patterns draw scrutiny even when optional. The justification is genuine —
a user-supplied server address cannot be enumerated ahead of time — and the
runtime request is scoped to the single origin the user typed. Keep the
justification text in §4 verbatim; it is the whole answer.

### e. Server-pushed `docIdOverrides`

The blocklist response may carry `docIdOverrides`, which changes which
persisted GraphQL operation the extension calls. This is configuration data,
not code, and MV3's rule is about executing remotely-hosted *logic*. But it
does let a server change what a request does, and a thorough reviewer may ask.
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
- [ ] Decide on `acceptServerTargets` default (§6b)
- [ ] `npm test` green, then zip: everything except `server/`, `tools/`, `docs/`, `store/`, `.env`

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
