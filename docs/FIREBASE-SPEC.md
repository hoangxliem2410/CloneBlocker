# Firebase migration — the contract

The Node backend (`server/server.js`) is replaced by Firebase, **Spark plan only**:
Firestore for data, Hosting for the dashboard, Auth for the admin. No Cloud
Functions, no server code running anywhere. Project: `clone-blocker2`,
Firestore in `asia-southeast1`.

Every formula and semantic below is ported from `server/server.js` verbatim —
where the port deliberately diverges, the divergence is listed in §8.

## 1. Where the intelligence moves

| was (server, request-time) | becomes |
|---|---|
| per-request target ranking by region/lang | **extension**, locally, from published per-target metadata |
| reputation, trends, stats aggregation | **dashboard**, in the admin's browser (`hosting/logic.js`) |
| report validation + caps | **Firestore security rules** (reject, never truncate) + extension pre-clipping |
| approve/reject/revoke → list edits | **derivation**: published list is a pure function of (reports, decisions, manual) |
| reporter pseudonym (HMAC + secret salt) | client-side unkeyed SHA-256 (see §8) |
| per-IP rate limits, ETag/304, sessions, Basic auth | gone (server-only concepts) |

Privacy improves in one place: the extension **no longer sends region/lang to
anyone when fetching the list** — it ranks locally with values that never leave
the machine. Reports still carry tz/lang (gated by `shareRegion`) because the
trending matrix is built from them.

## 2. Firestore data model

### `blocklist/current` — public read, admin write
Fields: `json` (string — the entire published payload as JSON), `updatedAt`
(timestamp), `rev` (integer, bump on publish).

Published payload inside `json`:
```jsonc
{
  "v": 1,
  "updatedAt": "ISO",
  "ids": ["63082166531", ...],          // hide + block layer (numeric ids)
  "usernames": ["somename", ...],       // hide layer only, lowercase, no @
  "docIdOverrides": {},                 // opaque string→string, ≤100, ≤64 chars each
  "targets": [                          // per-target ranking METADATA (not ranked!)
    { "platform": "threads", "id": "9100000001",
      "username": "x" , "displayName": "Y",
      "trust": 1.5,                     // Σ trustOf(reporters) — computed at publish
      "last": "2026-08-21",             // UTC day of lastReportAt
      "days":    { "2026-08-21": 3 },   // ≤14 buckets, UTC YYYY-MM-DD
      "regions": { "Asia/Ho_Chi_Minh": 4 },   // ≤24 keys
      "langs":   { "vi-vn": 4 } }       // ≤16 keys, lowercase
  ]
}
```
`targets` contains **only approved, id-bearing targets whose id is in `ids`**
(pending is never blockable — the single most safety-critical invariant).

**No `pending` array.** Removed in the security pass. Reports can be created by anyone -- no account, no review -- so an array of reported-but-unreviewed keys on the one world-readable document let a stranger have any profile they chose named publicly as reported. It also contradicted the rule stated everywhere else here: naming an account in public is a separate decision a person takes about that account, one at a time. The in-page chip now answers from what the browser itself reported, which is the only part of the question it was ever entitled to know.
Publish caps `targets` at the 2000 most recent to stay far under the 1MB doc cap.

### `reports/{dedupKey}` — public **create-only**; admin read/update/delete
`dedupKey = platform + '~' + target + '~' + reporterHash`
`target` = numeric id (4–24 digits) or `'@' + username` (lowercase, no leading @ in the name itself).
One document per reporter×target: a repeat report by the same account is a
**409 create conflict**, which is the dedup (was: `duplicate: true`).

Fields (all set at create; rules validate — see §3):
`platform, target, profileId?, username?, displayName?, url?, reason, note?,
postUrl?, postId?, contentSummary?, region?, lang?, reporterHash, dedupKey`.
Report time = the document's implicit `createTime` (no client clock trusted).

### `decisions/{platform}~{target}` — admin only
`{ status: 'approved' | 'rejected' | 'pending', by, at (timestamp), note? }`
`'pending'` = revoked/reopened (server semantics: revoke → pending, not rejected).

### `admin/manual` — admin only
`{ ids: [...], usernames: [...], docIdOverrides: {} }` — manual blocklist
entries and the doc-id hot-patch map, merged at publish.

## 3. Security rules (firestore.rules)

- `blocklist/*`: `read: true`, write admin-only.
- `reports/*`: `create` open with full shape validation; `read/update/delete`
  admin-only. Validation (mirrors the server's LIMITS — rules **reject**, the
  extension clips before sending):
  - keys ⊆ the field list above; `platform in ['facebook','threads']`
  - `target` matches `^(\d{4,24}|@[a-z0-9._]{1,64})$`
  - `profileId` absent or `\d{4,24}`; `username` absent or ≤64
  - `displayName` ≤80, `note` ≤400, `contentSummary` ≤400, `postId` ≤64
  - `url`/`postUrl` absent or `https?://…` ≤300
  - `reason in ['clone','impersonation','scam','harassment','spam','other']`
  - `region` absent or matches `^[A-Za-z]{2,}(/[A-Za-z0-9_+-]{1,40}){0,2}$` ≤64
  - `lang` absent or `^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$` ≤16
  - `reporterHash` matches `^acct_[0-9a-f]{24}$`
  - `dedupKey == platform + '~' + target + '~' + reporterHash` **and** `reportId == dedupKey`
- `decisions/*`, `admin/*`: admin only.
- Admin = `request.auth.uid == '<pinned UID>'` (pinned by tools/firebase-setup.js;
  public sign-up is disabled at the Auth config level as well).

## 4. hosting/ — the dashboard (Firebase Hosting)

Files: `index.html` (ported admin.html), `admin.css` (ported), `admin.js`
(ported rendering + new data layer), `logic.js` (pure compute, shared with
tests — `globalThis`/`module.exports` dual export, zero deps, no DOM).

- SDK: Firebase JS v10+ modular from `https://www.gstatic.com/firebasejs/`,
  config from the reserved URL `/__/firebase/init.json`. When
  `location.hostname` is localhost/127.0.0.1, connect to the Auth (9099) and
  Firestore (8080) emulators.
- Auth: `signInWithEmailAndPassword` gate (email + password fields),
  `onAuthStateChanged` boot, `signOut`. Delete usingDefaults/loopback logic.
- Data: read ALL of `reports` + `decisions` + `admin/manual` on refresh; feed
  `logic.js`.

`hosting/logic.js` exports (all pure):
- `aggregate(reportDocs, decisionDocs)` → per-target records in the OLD server
  record shape: `{ key, platform, profileId, username, displayName, url, reason,
  status, count, reporters[], notes[], posts[], regions{}, langs{}, days{},
  lastReportAt, createdAt, updatedAt, decidedAt?, decidedBy? }`.
  - key = `platform + ':' + (profileId || '@'+username)` (server `reportKey`)
  - count = distinct reporter docs; posts deduped by url; days bucketed from
    each doc's createTime (UTC `toISOString().slice(0,10)`), trimmed to 14;
    fill-don't-overwrite for profileId/username/displayName/url.
  - status from decisions (default `'pending'`).
- `reputation(records)` → verbatim port: only approved/rejected teach;
  `weightOf = (a + 0.5) / (a + r + 1)`; `TRUST_FLOOR = 0.25`;
  `trustOf(rep, who) = rep[who] ? rep[who].weight : 0.5`.
- `withTrust(record, rep)` → verbatim: `score` (2dp), `held` = reporters.length>0
  && best < 0.25, `trust[]` chips.
- `buildStats(records, rep, list)` → the exact `/admin/stats` shape.
- `buildTrends(records, days=14)` → the exact `/admin/trends` shape (dominant-
  region attribution, top-12 regions, topByRegion 5 rows sorted last7 then trust).
- `buildPublish(records, rep, manual)` → the §2 published payload.
  Publish semantics (verbatim from addToList/removeFromList):
  - approved + valid numeric profileId → id into `ids` (username NOT added)
  - approved + no id + username → username into `usernames`
  - status pending/rejected → nothing (and never into `targets`)
  - manual.ids/usernames merged in; docIdOverrides from manual
  - per-target `trust` = Σ trustOf over its reporters (rank's trust input)
- `sortQueue(rows)` → verbatim: held last, score desc, updatedAt desc.

Dashboard actions:
- approve/reject/revoke (single + bulk ≤500): write `decisions/{key}`, then
  recompute + write `blocklist/current` (publish after every decision — the
  transactional invariant "list and status never disagree" becomes structural).
- blocklist tab: entries derived from the published list + provenance; Remove →
  decision `'pending'` for reported targets / manual-list removal for manual ones
  (matches `/admin/blocklist/remove` reopening approved reports).
- XSS: textContent-only rendering and the `link()` https-check ported untouched.

## 5. Extension changes (src/)

`src/background/service-worker.js`:
- **Firestore detection**: a fetched body shaped `{ name, fields }` with
  `fields.json.stringValue` decodes to the published payload, then flows through
  the existing `normalizeBlocklist`. All legacy shapes keep working (self-hosted
  servers / static files stay supported).
- `isFirestoreUrl(url)`: `/\/v1\/projects\/[^/]+\/databases\/[^/]+\/documents\//`.
  For such URLs `withClientContext` appends **nothing** (no budget/region/lang).
- **Local ranking** `rankTargets(meta, ctx)` — verbatim formulas:
  `recency = 0.5^(ageDays/7)` from `last`; `velocity` = Σ buckets ≥ today-6;
  `affinity(tally, key, total) = key ? (tally[key]||0 + 0.5)/(total + 1) : 1`
  with **total = Σ region tallies for BOTH region and lang** (server quirk,
  ported as-is); `locality = 0.25 + 0.75*max(regionAff, 0.8*langAff)`;
  `rank = trust * recency * (1 + vel) * locality` (3dp); sort rank desc, id asc;
  slice to `remainingBudget()`. ctx from `Intl`/`navigator` — never transmitted.
  `shareRegion === false` ⇒ rank with null region/lang (locality 1 for all).
- **submitReport** against a Firestore listUrl: compute
  `reporterHash = 'acct_' + hex(sha256(platform + ':' + viewerId)).slice(0,24)`
  (crypto.subtle), clip all fields to LIMITS client-side, build
  `POST {base}/reports?documentId={dedupKey}` with Firestore-typed fields
  (stringValue only; omit null fields). 200 → `{ok, duplicate:false}`;
  409 → `{ok, duplicate:true}`; 403 → clear error. Signed-out is detected
  client-side before any write (already the case).
- **reportStatus** against a Firestore listUrl: no network — derive from the
  cached list: `blocked` = id/username membership, `status` = 'approved' if
  blocked else 'pending' if this browser filed the report else null (the list
  carries no `pending` array — see below). Keep the response
  shape `{ ok, key, status, count, blocked }` (count 0 when unknown).
- Keep: ETag header handling (dead against Firestore but alive for legacy),
  queue/warm/cold logic untouched.

`src/options/options.html|js`: endpoint help text now shows the Firestore URL
pattern first; everything else unchanged. No new settings.

## 6. Tooling

- `tools/firebase-setup.js` — already written: provisions APIs, DB, web app,
  auth, admin user, pins the UID into rules, seeds the doc, `--deploy`.
- `tools/firebase-test.js` — runs under
  `firebase emulators:exec --only firestore --project demo-clone "node tools/firebase-test.js"`.
  Zero-dep REST against the emulator (`FIRESTORE_EMULATOR_HOST`), admin
  simulated with an unsigned JWT (`alg:none`, `user_id` = pinned test UID —
  rules file is loaded with a test UID via a temp copy). Covers: the rules
  matrix (every §3 validation, accept + reject cases), create-only dedup (409),
  public blocklist read, denied report reads/decision writes, PLUS the logic
  suite: `require('../hosting/logic.js')` with fixture docs asserting the
  ported behaviors (VN>BR regional flip and its reverse, pending-never-target,
  id-vs-username publish asymmetry, revoke reopens + claws back trust, held
  ordering, stats shape, trends matrix shape, lang-affinity-over-region-total
  quirk, day-quantised determinism).
- `tools/e2e-test.js` — swap `startServer()` for the Firestore emulator: seed
  `blocklist/current` via emulator REST (`Authorization: Bearer owner`), point
  `listUrl` at `http://127.0.0.1:8080/v1/projects/demo-clone/databases/(default)/documents/blocklist/current`,
  grant that origin in the patched manifest. Every downstream check unchanged.
  Add one check: the SW derives ranked targets locally from published metadata.
- `tools/dashboard-visual.js` — emulators (firestore+auth+hosting), seed the
  same representative fixture through the REAL rules (client REST, not owner),
  create the admin user in the Auth emulator, sign in through the real gate,
  screenshot gate + dashboard, keep the DOM assertions.
- `tools/dev-session.js` — replace the detached-server block with the emulator
  (`emulators:start --only firestore --import/--export-on-exit` in the session
  dir); extension points at the emulator URL. Chrome half unchanged.
- `package.json` scripts: `test` = check + queue + firebase + e2e;
  `emulators`, `deploy` helpers. `server` script removed.

## 7. Deleted
`server/` (entire directory), `tools/server-test.js`, `tools/report-test.js`
(their behaviors live on in firebase-test per the §6 mapping). Git history
keeps them.

## 8. Deliberate divergences (documented honestly)

1. **Pseudonym is an unkeyed hash now.** The server HMAC'd with a secret salt;
   a pure client cannot hold a secret. `acct_` + 24 hex of SHA-256. Reports are
   admin-read-only, so the hash is defense-in-depth, not the primary barrier —
   but a determined party with candidate account ids CAN verify a guess offline.
   Accepted; documented in PRIVACY.md.
2. **Per-IP and per-account rate limits are gone.** Structural dedup (one doc
   per reporter×target) + shape caps remain. A hostile signed-in account can
   file many reports for many targets; the dashboard's reputation weighting and
   held-queue absorb it, the admin deletes junk. App Check is the future answer.
3. **Duplicate re-reports are inert.** The server updated evidence/lastReportAt
   on duplicates; a create-only model makes a same-reporter repeat a no-op.
   Fresh activity signal now comes only from NEW reporters.
4. **ETag/304 → full-body polls.** The published doc is tens of KB read hourly;
   day-quantised ranking keeps queue churn at zero within a day.
5. **507 store-full and the 20k-account cap are unenforced** (no rules
   equivalent without counters); the 2000-target publish cap bounds the public
   doc instead.
6. **`GET /reports/status` had platform `'unknown'` tolerance** — gone; the
   extension always sends a real platform.
