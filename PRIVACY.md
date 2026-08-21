# Privacy policy — 3Que Blocker

*Last updated: 21 August 2026*

3Que Blocker is a browser extension that hides and blocks accounts
impersonating you on Facebook and Threads. This policy describes every piece of
data it handles and where that data goes.

The short version: **there is no "us".** The extension talks to one server —
the one you set up and whose address you typed in — and to nowhere else. There
is no analytics, no telemetry, no advertising, no crash reporting and no
third-party service anywhere in it. The extension has no server of its own to
send anything to.

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

Uninstalling the extension removes all of it.

## What leaves your device, and to where

Everything below goes **only** to the blocklist server you configured.

### Fetching the list

A periodic HTTPS request for your blocklist. It carries no personal data. If
you have enabled server suggestions, it also carries:

- your **time zone** (for example `Asia/Ho_Chi_Minh`) and **language** (for
  example `vi-VN`), and
- how many blocks your own settings still have room for.

Both come from your browser's own settings — the same values any website you
visit can already read. No IP geolocation, no location API, no geo database is
used or consulted. This is controlled by a single switch, **Send my time zone
and language**, in the extension's options. Turn it off and the request carries
neither.

### Filing a report

Sent only when you deliberately submit a report, and only what is in the form:

- the reported account's profile ID and/or username, and its display name;
- the reason you selected;
- any note you typed and any post links you attached, plus an optional short
  quote of the content you are reporting;
- **your own Facebook or Threads numeric account ID**.

That last item deserves an explanation. It is read from the page you are
already signed in to, and it is sent so that a report can be weighed against
the reporter's track record and so that one account cannot flood the queue.
It is not used to identify you to anyone. The included backend never writes it
to disk in the clear: it is stored as a salted HMAC pseudonym, and the salt
lives only on your server. A report cannot be filed while signed out.

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

No one. Data is not sold, rented, shared, or transmitted to any third party,
because it is never sent anywhere except the server you run. If you host that
server yourself, you are the only party involved. If someone else hosts it for
you, they see the reports you file — ask them what they do with them, because
this policy cannot speak for their server.

## Retention and deletion

Retention is your server's business, since your server holds the data. In the
included backend, reports persist until you delete them from the moderation
dashboard, and account IDs exist only as pseudonyms which cannot be reversed
without the salt file. Deleting the salt file makes every stored pseudonym
permanently unlinkable.

On your device, clearing the extension's storage or uninstalling it removes
everything it holds.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | Keep your settings and the cached blocklist. |
| `alarms` | Refresh the list on schedule and pace blocks so they never go out in a burst. |
| Access to facebook.com, threads.net, threads.com | The only two sites the extension works on: it reads the page to find listed accounts, and issues blocks when you have enabled that. |
| Access to a server you choose (optional) | Granted at runtime, for the single address you typed, only after you accept Chrome's prompt. Never requested at install. |

## Children

Not directed at children under 13 and collects nothing about them.

## Changes

Material changes will be reflected here with a new date, and — as the Chrome
Web Store requires — disclosed to users rather than applied quietly.

## Contact

Issues and questions: https://github.com/hoangxliem2410/CloneBlocker/issues

The extension is open source. Every claim in this policy can be checked against
the code rather than taken on trust.
