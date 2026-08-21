# Phase 2 + 3 contract — tags and tunable ranking

The one source of truth for the data shape. Everything below is normative;
implementers must not invent fields or rename them.

## Tags

```
TAGS = ['clone', 'impersonation', 'scam', 'harassment', 'spam', 'redbull', 'other']
```

`redbull` is new. Labels: en `Redbull`, vi `Bò đỏ`.
The reason a reporter picks and the tag a target carries are the same
vocabulary — a report's `reason` is a vote, a target's `tag` is the verdict.

**Effective tag of a target** = `decisions/{key}.tag` if the admin set one,
otherwise the modal (most common) `reason` across that target's reports, ties
broken by TAGS order, falling back to `'clone'` when a target somehow has none.

### Schema deltas

- `firestore.rules`: the reason enum gains `redbull`. Decision documents gain
  an OPTIONAL `tag` field, validated against TAGS.
- `hosting/logic.js` `aggregate()`: each record gains
  `reasons: { <reason>: count }` (tallied across its report docs) and
  `tag: <effective tag>`.
- `buildPublish()` payload gains:
  - each entry of `targets` gains `tag` and `reporters` (unique reporter count)
  - a new top-level `idTags: { "<id>": "<tag>" }` covering every published id,
    so warm blocking can filter without carrying the whole target record
  - a new top-level `rankWeights` (below)

## Ranking weights

Published so the owner can tune ranking from the dashboard without shipping
an extension update. `buildPublish` emits them; both rankers read them and
fall back to these exact values when the payload omits them, so an old
payload ranks exactly as it does today.

```js
rankWeights = {
  halfLifeDays: 7,        // recency = 0.5 ^ (ageDays / halfLifeDays)
  velocityWeight: 1,      // (1 + velocityWeight * velocity7d)
  localityFloor: 0.25,    // locality = floor + (1-floor) * max(regionAff, langFactor*langAff)
  localityLangFactor: 0.8,
  uniqueReporterBoost: 0  // 1 + boost * log2(1 + uniqueReporters)
}
```

**Formula:**
```
recency  = 0.5 ^ (ageDays / halfLifeDays)
locality = localityFloor + (1 - localityFloor) * max(regionAff, localityLangFactor * langAff)
boost    = 1 + uniqueReporterBoost * Math.log2(1 + reporters)
rank     = trust * recency * (1 + velocityWeight * velocity7d) * locality * boost
```

`uniqueReporterBoost` ships at **0**, which makes `boost` exactly 1 and the
formula byte-identical to today's. That is deliberate: this phase makes the
weights tunable and adds the term, it does not change anybody's ranking.
Turning it up is an owner decision made later, from the dashboard.

Rounding, sort order (rank desc, then id asc) and the `why` object are
unchanged, except `why` gains `reporters` (the unique count).

**Two rankers must stay in step:** `hosting/logic.js rankTargets()` (dashboard
preview + tests) and `rankPublishedTargets()` in
`src/background/service-worker.js` (a service worker cannot import the module).
Any change to one is a change to both, and the test suites compare them.

## Extension setting

```js
blockTags: ['clone', 'impersonation', 'scam', 'harassment', 'spam', 'redbull', 'other']
```

An array of the tags this user is willing to block, defaulting to all of them.
An array rather than a map, and matched by inclusion, so that a tag introduced
in a later release is **not** blocked by an existing install until its owner
opts in — a new category should never start acting on its own.

- **Cold seeding** filters `record.targets` by `blockTags.includes(t.tag)`.
- **Warm enqueue** looks the id up in `idTags` (absent ⇒ treat as `'other'`)
  and refuses ids whose tag is not selected.
- **Hiding is tag-blind**: everything approved is hidden regardless. Hiding is
  free and reversible; rationing it would buy nothing.
