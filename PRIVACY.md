# Privacy policy — 3Que Blocker

*Last updated: 21 August 2026*

3Que Blocker is a browser extension that hides and blocks accounts
impersonating you on Facebook and Threads. This policy describes every piece of
data it handles and where that data goes.

The short version: **there is no "us".** The extension talks to one backend —
the one you set up and whose address you typed in — and to nowhere else. There
is no analytics, no telemetry, no advertising and no crash reporting. The
included backend is a Firebase project that **you** create and own, which means
the data lives in your project on Google Cloud: Google is the hosting and
infrastructure provider, in the same way a rented server's datacenter would be,
and the project's security rules make reports readable by no account but
yours. Nobody involved in writing this extension operates a server, sees a
report, or can see one.

---

## What stays on your device

Held in Chrome's extension storage, and never transmitted:

- **Your settings** — the blocklist address, refresh interval, whether hiding
  is on, whether platform blocking is on, and every pacing and cap value.
- **The cached blocklist** — so it does not have to be re-fetched on every page.
- **The block queue** — which accounts are pending, which have been done, and
  the timestamps used to keep within your own hourly and daily caps.
- **Captured request templates**, if you enable that option — used only to
  reissue a block on the same site.
- **Your time zone and language, as used for ranking.** The extension decides
  which listed accounts are most active near you by comparing your browser's
  own time zone and language against metadata published with the list — a
  comparison that happens entirely on your machine.

Uninstalling the extension removes all of it.

## What leaves your device, and to where

Everything below goes **only** to the backend you configured.

### Fetching the list

A periodic HTTPS request for your blocklist. **It carries no personal data —
no time zone, no language, nothing about you at all.** Earlier versions sent
your time zone, language and remaining block budget with this request so the
server could rank suggestions; that ranking now happens locally, so the fetch
is anonymous by construction. This is an improvement worth stating plainly:
nothing about you is sent to anyone when the list is fetched.

### Filing a report

Sent only when you deliberately submit a report, and only what is in the form:

- the reported account's profile ID and/or username, and its display name;
- the reason you selected;
- any note you typed and any post links you attached, plus an optional short
  quote of the content you are reporting;
- your **time zone** (for example `Asia/Ho_Chi_Minh`) and **language** (for
  example `vi-VN`) — both values your browser already hands to every site you
  visit, used to show the reviewer where a clone is currently active. This is
  controlled by the **Send my time zone and language** switch in options; turn
  it off and a report carries neither;
- a **pseudonym derived from your own Facebook or Threads account ID**.

That last item deserves an explanation. Your numeric account ID is read from
the page you are already signed in to, so that reports can be weighed against
the reporter's track record and one account cannot flood the queue. The ID
itself is never sent: the extension hashes it in your browser (SHA-256,
truncated) and only the pseudonym leaves your machine. A report cannot be
filed while signed out.

Be clear about what that hash does and does not do. The hash is not keyed with
a secret — an earlier version used a server-held secret salt, and a pure
client-side design has nowhere to keep one — so **someone who already has a
candidate account ID and a copy of the report store could compute the same
hash and confirm a guess**. What prevents that is that the report store is
readable only by the project owner under the security rules; the hash is
defence in depth behind that barrier, not the barrier itself. It cannot be
reversed to discover an unknown account ID.

### Performing a block

When you have turned platform blocking on, the extension issues a block through
Facebook's or Threads' own in-page mechanism, exactly as pressing their Block
button does. That request goes to Facebook or Threads, contains only the target
account, and carries no data from this extension.

## What is never collected

Browsing history, page content beyond what you attach to a report, passwords,
cookies, session tokens, messages, contacts, payment information, device
fingerprints, or anything at all from sites other than facebook.com,
threads.net and threads.com.

## Who else sees it

The data is not sold, rented, or shared. Two parties can technically see it:

- **The owner of the backend you configured.** If that is your own Firebase
  project, that is you, alone — the security rules make reports readable only
  by the one admin account. If you point the extension at a list someone else
  runs, they receive the reports you file — ask them what they do with them,
  because this policy cannot speak for their backend.
- **Google**, as the infrastructure under a Firebase backend. The data sits in
  Firestore inside your Google Cloud project, subject to Google Cloud's own
  terms and privacy commitments, the same way any hosting provider holds the
  disks your data is on. Google is not sent anything by the extension itself;
  it hosts what your project stores.

No analytics service, ad network, or other third party appears anywhere.

## Retention and deletion

Retention is the backend owner's business, since the backend holds the data.
In the included Firebase backend, reports persist until you delete them —
from the moderation dashboard, or directly in the Firestore console, which as
project owner you can always do regardless of what any tooling offers.
Account IDs exist in the store only as truncated hashes; the raw ID is never
stored anywhere.

On your device, clearing the extension's storage or uninstalling it removes
everything it holds.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | Keep your settings and the cached blocklist. |
| `alarms` | Refresh the list on schedule and pace blocks so they never go out in a burst. |
| Access to facebook.com, threads.net, threads.com | The only two sites the extension works on: it reads the page to find listed accounts, and issues blocks when you have enabled that. |
| Access to a backend you choose (optional) | Granted at runtime, for the single address you typed, only after you accept Chrome's prompt. Never requested at install. |

## Children

Not directed at children under 13 and collects nothing about them.

## Changes

Material changes will be reflected here with a new date, and — as the Chrome
Web Store requires — disclosed to users rather than applied quietly.

## Contact

Issues and questions: https://github.com/hoangxliem2410/CloneBlocker/issues

The extension is open source. Every claim in this policy can be checked against
the code rather than taken on trust.
