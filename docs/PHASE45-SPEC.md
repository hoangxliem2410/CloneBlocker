# Phase 4 + 5 contract — transparency site and Google sign-in

Normative. Implementers must not invent fields or rename them.

## Phase 4 — the public list

Publishing a profile publicly is a **deliberate, per-target act**, never a
side effect of approving it (owner decision, recorded in ROADMAP). Approval
puts an account on the blocklist; publishing puts a named accusation on a web
page, and those are not the same decision.

### Schema

- `decisions/{key}` gains an optional boolean `public`. Absent or false means
  the target is blocked but not named publicly. Admin-only, like the rest of
  the decision document.
- `hosting/logic.js` gains `buildPublicView(records, rep)` returning:

```jsonc
{
  "v": 1,
  "updatedAt": "ISO",
  "counts": { "published": 12, "blocked": 240, "reports": 613, "byTag": { "clone": 8 } },
  "profiles": [
    {
      "platform": "threads",
      "id": "9100000001",              // may be null for username-only targets
      "username": "someone",
      "displayName": "Someone",
      "tag": "clone",
      "reports": 4,                    // unique reporters
      "firstReported": "2026-08-07",   // UTC day
      "lastActive": "2026-08-21",
      "regions": ["Asia/Ho_Chi_Minh"], // top 3 by tally, names only, no counts
      "evidence": [                    // ONLY entries that carry an https post URL
        { "url": "https://...", "summary": "quoted text, may be null" }
      ]
    }
  ]
}
```

Rules for what may appear, all of them load-bearing:

- **status must be `approved` AND `decision.public === true`.** Anything else
  is absent entirely.
- **Reporter identities never appear.** No `acct_` pseudonyms, no counts per
  reporter — only the total. The hashes are admin-only and stay that way.
- **Evidence needs a URL.** A quoted summary with no post link behind it is an
  unverifiable claim about a named person; drop the entry rather than publish
  it. (Summaries with a URL are kept — the link is the proof.)
- **No notes.** Moderator notes are internal.
- Region names only, never per-region counts, which would narrow a reporter.

Published to Firestore as `blocklist/publicView` (public read, admin write),
same envelope as `blocklist/current`: a `json` string field plus `updatedAt`.
The dashboard writes it in the same operation that republishes the blocklist,
so the two can never disagree.

### Hosting layout

The admin dashboard moves from `/` to `/admin/`. `/` becomes the public page.
This changes the URL the owner uses — say so in the README and in the setup
tool's output.

```
hosting/index.html      public transparency page  (new)
hosting/public.js       its logic                 (new)
hosting/public.css      its styles                (new)
hosting/admin/index.html  the dashboard (moved, was hosting/index.html)
hosting/admin/admin.js    (moved)
hosting/admin/admin.css   (moved)
hosting/logic.js        shared by both, stays at the root
```

`firebase.json` needs no rewrite rules; directory index resolution handles
`/admin/`. The CSP header block already covers both.

The public page reads `blocklist/publicView` **unauthenticated** over the same
Firestore REST endpoint the extension uses. `tools/publish-static.js` also
mirrors it to `hosting/transparency.json` (gitignored, generated) so the CDN
can serve it without a database read.

### The page itself

Static, no build step, no framework, same textContent-only discipline as the
dashboard, and the `link()` https guard reused verbatim for every evidence
link. Contents: a plain explanation of what the list is and how a profile gets
on it; the stats strip; a tag filter and a search box; one card per profile
with its tag, report count, dates, regions and evidence links. A visible note
that reporters are anonymous and that removal requests go to the repository's
issues. Vietnamese and English (Phase 6 does the extension; this page carries
its own small dictionary and defaults to Vietnamese with an en toggle).

## Phase 5 — Google sign-in

- `firebase-setup.js` enables the Google provider through the Identity Toolkit
  admin API (`defaultSupportedIdpConfigs`), documenting the console fallback if
  the call is unavailable.
- `firestore.rules`: `isAdmin()` becomes a membership test against a **list**
  of UIDs, written as a literal in the rules file. A Google sign-in mints a
  different UID than the password account, so both must be able to be admin.
- `firebase-setup.js --add-admin <uid>` appends a UID to that list and
  redeploys the rules. `--list-admins` prints the current list. The existing
  UID-pinning code becomes the same mechanism rather than a separate one.
- The dashboard gate grows **Sign in with Google** (`signInWithPopup`,
  `GoogleAuthProvider`) above the existing email/password form, which stays as
  a fallback. On a successful sign-in whose UID is not in the allowlist, the
  page must say exactly that — "signed in as X, which is not an admin of this
  project" plus the UID to hand to `--add-admin` — rather than showing an
  empty dashboard or a bare permission error. Getting locked out of your own
  dashboard with no way to learn your own UID is the failure mode here.
