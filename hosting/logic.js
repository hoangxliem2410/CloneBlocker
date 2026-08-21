/**
 * The server's brain, extracted. Pure functions, no DOM, no SDK, no deps.
 *
 * Everything here is ported verbatim from server/server.js (see git history
 * for the original). The dashboard runs it in the admin's browser; the test
 * suite runs it in Node -- which is the point of keeping it pure: the same
 * bytes are what is tested and what is deployed.
 *
 * The one structural change from the server era: aggregation. The server kept
 * one mutable record per reported account and updated it on every submission.
 * Firestore holds one immutable document per reporter×target instead (the doc
 * id is the dedup), so the per-account record the rest of this file expects is
 * REBUILT from those documents on every read. Derivation instead of mutation
 * is also what makes the old "the list and the report store must never
 * disagree" invariant structural rather than transactional.
 */
(function () {
  'use strict';

  // -- constants (verbatim) --------------------------------------------------

  // One vocabulary, two jobs: the reason a reporter picks is a vote, the tag a
  // target carries is the verdict. Keeping them the same list is what lets a
  // verdict be derived from the votes at all, so REASONS is an alias rather
  // than a second list somebody has to remember to update.
  //
  // Order is load-bearing twice over: it breaks ties when several reasons are
  // equally popular, and it is the order the dashboard and the report sheet
  // show. New tags go before 'other', which stays the bucket of last resort.
  const TAGS = ['redbull', 'clone', 'impersonation', 'scam', 'harassment', 'spam', 'other'];
  const REASONS = TAGS;
  const PLATFORMS = ['facebook', 'threads'];
  const DAY_BUCKETS = 14;    // days of history kept per account
  const REGION_CAP = 24;     // distinct regions remembered per account
  const LANG_CAP = 16;
  const HALF_LIFE_DAYS = 7;  // a clone reported a week ago counts half as much
  const TRUST_FLOOR = 0.25;
  const TARGET_PUBLISH_CAP = 2000;  // newest targets kept in the public doc

  /**
   * The ranking dials, published in the list so the owner can turn them
   * without shipping an extension update.
   *
   * These values ARE today's ranking: velocityWeight 1 and localityFloor 0.25
   * reproduce the old hardcoded expression term for term, and
   * uniqueReporterBoost 0 makes the new boost factor exactly 1. This phase
   * makes the dials exist; it deliberately does not turn any of them.
   */
  const RANK_WEIGHTS = {
    halfLifeDays: HALF_LIFE_DAYS,  // recency = 0.5 ^ (ageDays / halfLifeDays)
    velocityWeight: 1,             // (1 + velocityWeight * velocity7d)
    localityFloor: 0.25,           // locality never falls below this
    localityLangFactor: 0.8,       // language counts a little less than region
    uniqueReporterBoost: 0         // 1 + boost * log2(1 + uniqueReporters)
  };

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const normUser = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');
  const isId = (v) => /^\d{4,24}$/.test(String(v || '').trim());

  // -- tallies (verbatim) ----------------------------------------------------

  /** Add one to obj[key], evicting the smallest entry when full. */
  function bump(obj, key, cap) {
    if (!key) return;
    if (!hasOwn(obj, key)) {
      const keys = Object.keys(obj);
      if (keys.length >= cap) {
        // Evict the least-reported, not the oldest: a region with a single
        // stray report is the one worth forgetting.
        let worst = keys[0];
        for (const k of keys) if (obj[k] < obj[worst]) worst = k;
        delete obj[worst];
      }
      obj[key] = 0;
    }
    obj[key]++;
  }

  /** Keep only the most recent day buckets, so a long-lived record stays bounded. */
  function trimDays(days) {
    const keys = Object.keys(days).sort();
    while (keys.length > DAY_BUCKETS) delete days[keys.shift()];
  }

  /** Reports in the last `n` day buckets. */
  function velocity(days, n) {
    const cutoff = dayKey(Date.now() - (n - 1) * 86400000);
    let total = 0;
    for (const k of Object.keys(days || {})) if (k >= cutoff) total += days[k];
    return total;
  }

  /**
   * How strongly this account's reports come from a given region.
   *
   * Smoothed, so a clone with two reports from your city does not outrank one
   * with fifty from it purely because both happen to be 100% local.
   */
  function affinity(tally, key, total) {
    if (!key) return 1;                       // caller gave no region: stay neutral
    const here = (tally && hasOwn(tally, key)) ? tally[key] : 0;
    return (here + 0.5) / (total + 1);
  }

  // -- tags ------------------------------------------------------------------

  /**
   * The tag the reports themselves argue for: the most common reason.
   *
   * Ties go to whichever comes first in TAGS, which is why that order is not
   * cosmetic. Scanning in TAGS order with a strict `>` gives that for free.
   * A target with no usable reason at all falls back to the head of the list,
   * which is also what the report sheet offers first -- one decision about
   * what this deployment is mostly for, honoured in both places rather than
   * spelled out twice and drifting apart.
   */
  function modalTag(reasons) {
    let best = null, bestN = 0;
    for (const t of TAGS) {
      const n = (reasons && hasOwn(reasons, t)) ? reasons[t] : 0;
      if (n > bestN) { best = t; bestN = n; }
    }
    return best || TAGS[0];
  }

  /** The verdict: what the admin said, or failing that what the reports say. */
  function effectiveTag(decision, reasons) {
    const override = decision && decision.tag;
    return TAGS.includes(override) ? override : modalTag(reasons);
  }

  // -- reputation (verbatim) -------------------------------------------------

  // Jeffreys prior: an unknown reporter sits at 0.5, a long record pulls hard
  // toward 0 or 1 without ever quite arriving. One bad call does not ruin
  // someone with a good history, and one lucky call does not buy trust.
  function weightOf(rec) {
    const a = rec.approved || 0, r = rec.rejected || 0;
    return (a + 0.5) / (a + r + 1);
  }

  /** Recomputed from decided records every call -- never accumulated. */
  function reputation(records) {
    const rep = Object.create(null);
    const add = (who, field) => {
      if (!hasOwn(rep, who)) rep[who] = { approved: 0, rejected: 0 };
      rep[who][field]++;
    };
    for (const r of records) {
      const field = r.status === 'approved' ? 'approved'
                  : r.status === 'rejected' ? 'rejected' : null;
      if (!field) continue;                    // pending teaches us nothing yet
      for (const who of (r.reporters || [])) add(who, field);
    }
    for (const who of Object.keys(rep)) rep[who].weight = weightOf(rep[who]);
    return rep;
  }

  const trustOf = (rep, who) => (hasOwn(rep, who) ? rep[who].weight : weightOf({}));

  /**
   * Annotate a report with who stands behind it.
   *
   * `score` is the count weighted by trust, and it -- not the raw count -- is
   * what the queue is ranked by.
   */
  function withTrust(r, rep) {
    const reporters = r.reporters || [];
    const score = reporters.reduce((n, who) => n + trustOf(rep, who), 0);
    const best = reporters.reduce((m, who) => Math.max(m, trustOf(rep, who)), 0);
    return Object.assign({}, r, {
      score: Math.round(score * 100) / 100,
      // Held: nobody behind this report has a usable record. It stays in the
      // store and stays visible, but it does not get to jump the queue.
      held: reporters.length > 0 && best < TRUST_FLOOR,
      trust: reporters.map(who => ({
        who,
        weight: Math.round(trustOf(rep, who) * 100) / 100,
        approved: hasOwn(rep, who) ? rep[who].approved : 0,
        rejected: hasOwn(rep, who) ? rep[who].rejected : 0
      }))
    });
  }

  /** The queue ordering: held last, then trust-weighted score, then recency. */
  function sortQueue(rows) {
    return rows.sort((a, b) =>
      (a.held ? 1 : 0) - (b.held ? 1 : 0) ||
      (b.score - a.score) ||
      (b.updatedAt < a.updatedAt ? -1 : 1));
  }

  // -- aggregation: report documents -> per-account records ------------------

  /**
   * Rebuild the server-era per-account records from immutable report docs.
   *
   * @param reportDocs   [{ id, createTime: ISO, data: {platform, target, ...} }]
   * @param decisionDocs [{ id: 'platform~target', data: {status, by, at, note} }]
   */
  function aggregate(reportDocs, decisionDocs) {
    const decisions = new Map();
    for (const d of decisionDocs || []) {
      decisions.set(d.id.replace('~', ':'), d.data || {});
    }

    const groups = new Map();
    for (const doc of reportDocs || []) {
      const data = doc.data || {};
      if (!PLATFORMS.includes(data.platform) || !data.target) continue;
      const key = data.platform + ':' + data.target;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(doc);
    }

    const records = [];
    for (const [key, docs] of groups) {
      docs.sort((a, b) => (a.createTime < b.createTime ? -1 : 1));
      const first = docs[0].data;
      const rec = {
        key,
        platform: first.platform,
        profileId: null, username: null, displayName: null, url: null,
        reason: REASONS.includes(first.reason) ? first.reason : TAGS[0],
        // Every vote, not just the first reporter's: `reason` above is what
        // opened the case, `reasons` is what the case has come to be about.
        reasons: Object.create(null),
        tag: TAGS[0],
        status: 'pending',
        // The transparency opt-in, separate from status on purpose: blocking an
        // account and naming it on a public page are two decisions, and a
        // record that has only had the first taken must not carry the second.
        public: false,
        count: 0,
        reporters: [],
        notes: [],
        posts: [],
        regions: Object.create(null),
        langs: Object.create(null),
        days: Object.create(null),
        lastReportAt: docs[docs.length - 1].createTime,
        createdAt: docs[0].createTime,
        updatedAt: docs[docs.length - 1].createTime
      };

      for (const doc of docs) {
        const d = doc.data, at = doc.createTime;
        // Late-arriving detail fills gaps but never overwrites.
        if (!rec.profileId && isId(d.profileId)) rec.profileId = String(d.profileId);
        if (!rec.username && d.username) rec.username = normUser(d.username);
        if (!rec.displayName && d.displayName) rec.displayName = d.displayName;
        if (!rec.url && d.url) rec.url = d.url;

        // Unknown reasons are dropped rather than tallied: a key outside the
        // vocabulary could win the vote and become a tag nothing can match.
        if (REASONS.includes(d.reason)) {
          rec.reasons[d.reason] = (rec.reasons[d.reason] || 0) + 1;
        }

        if (!rec.reporters.includes(d.reporterHash)) {
          rec.reporters.push(d.reporterHash);
          rec.count++;
        }
        if (d.note) rec.notes.push({ at, by: d.reporterHash, text: d.note });
        if (d.postUrl || d.contentSummary) {
          const already = d.postUrl && rec.posts.some(x => x.url === d.postUrl);
          if (!already) {
            rec.posts.push({
              url: d.postUrl || null, postId: d.postId || null,
              summary: d.contentSummary || null, by: d.reporterHash, at
            });
          }
        }
        bump(rec.regions, d.region || null, REGION_CAP);
        bump(rec.langs, d.lang ? String(d.lang).toLowerCase() : null, LANG_CAP);
        bump(rec.days, dayKey(Date.parse(at)), DAY_BUCKETS + 4);
        trimDays(rec.days);
      }
      rec.notes = rec.notes.slice(-50);
      rec.posts = rec.posts.slice(-20);

      const dec = decisions.get(key);
      if (dec && ['approved', 'rejected', 'pending'].includes(dec.status)) {
        rec.status = dec.status;
        rec.decidedAt = dec.at || null;
        rec.decidedBy = dec.by || 'admin';
        if (dec.at && dec.at > rec.updatedAt) rec.updatedAt = dec.at;
        // A NEW reporter arriving after a rejection reopens the case -- the
        // server did this imperatively; here it falls out of the data.
        if (rec.status === 'rejected' && dec.at && rec.lastReportAt > dec.at) {
          rec.status = 'pending';
        }
      }
      // Read off the decision document rather than the status block above,
      // because it is not a status: a case reopened by a late report keeps
      // whatever the admin last said about publishing it.
      rec.public = !!(dec && dec.public === true);
      // The admin's tag survives a reopening: a verdict about what an account
      // IS does not stop being true because one more person reported it.
      rec.tag = effectiveTag(dec, rec.reasons);
      records.push(rec);
    }
    return records;
  }

  // -- ranking (verbatim formulas) -------------------------------------------

  /**
   * Fill a partial or absent weight set from the defaults.
   *
   * A list published before rankWeights existed carries none, and must rank
   * exactly as it did then -- so "absent" and "the defaults" are the same
   * thing here. A single nonsensical dial falls back on its own rather than
   * discarding the rest: a half-life of zero would divide by zero and take
   * every other tuned value down with it.
   */
  function rankWeightsOf(weights) {
    const src = (weights && typeof weights === 'object') ? weights : {};
    const num = (k) => {
      const v = Number(src[k]);
      return Number.isFinite(v) ? v : RANK_WEIGHTS[k];
    };
    const halfLifeDays = num('halfLifeDays');
    return {
      halfLifeDays: halfLifeDays > 0 ? halfLifeDays : RANK_WEIGHTS.halfLifeDays,
      velocityWeight: num('velocityWeight'),
      localityFloor: num('localityFloor'),
      localityLangFactor: num('localityLangFactor'),
      uniqueReporterBoost: num('uniqueReporterBoost')
    };
  }

  /**
   * Rank published target metadata for one client.
   *
   * On the server this ran per-request with the caller's region; now it runs
   * where the region already lives -- the client -- and nothing is sent.
   * Everything is quantised to whole days on purpose, so recomputation within
   * a day is deterministic and the queue does not churn between polls.
   *
   * `weights` is whatever the published list carried; omitting it ranks with
   * RANK_WEIGHTS, which is the ranking as it has always been.
   */
  function rankTargets(targets, ctx, weights) {
    const w = rankWeightsOf(weights);
    const region = ctx && ctx.region ? String(ctx.region) : null;
    const lang = ctx && ctx.lang ? String(ctx.lang).toLowerCase() : null;
    const platform = ctx && PLATFORMS.includes(ctx.platform) ? ctx.platform : null;
    const today = Date.now();
    const out = [];

    for (const t of targets || []) {
      if (!t || !isId(t.id)) continue;
      if (platform && t.platform !== platform) continue;

      const days = t.days || {};
      // Quirk ported from the server: the language affinity divides by the
      // REGION total. Kept as-is so rankings match the old ones exactly.
      const total = Object.values(t.regions || {}).reduce((n, v) => n + v, 0);

      const trust = Number(t.trust) || 0;
      const ageDays = Math.max(0,
        Math.floor((today - Date.parse(t.last || 0)) / 86400000));
      const recency = Math.pow(0.5, ageDays / w.halfLifeDays);
      const vel = velocity(days, 7);
      const regionAff = affinity(t.regions, region, total);
      const langAff = affinity(t.langs, lang, total);
      const reporters = Math.max(0, Number(t.reporters) || 0);

      // Region never zeroes a target out -- a clone that is merely hot
      // elsewhere should still be reachable -- but it dominates the ordering
      // when it fits.
      const locality = w.localityFloor
        + (1 - w.localityFloor) * Math.max(regionAff, langAff * w.localityLangFactor);
      // Trust is linear in the number of reporters, so one confident voice can
      // outweigh several independent ones. This says how much independence is
      // worth on top of that -- and at the shipped 0 it is exactly 1, i.e. it
      // says nothing at all until an owner decides otherwise.
      const boost = 1 + w.uniqueReporterBoost * Math.log2(1 + reporters);
      const rank = trust * recency * (1 + w.velocityWeight * vel) * locality * boost;

      out.push({
        platform: t.platform,
        id: String(t.id),
        username: t.username || null,
        displayName: t.displayName || null,
        rank: Math.round(rank * 1000) / 1000,
        why: {
          trust: Math.round(trust * 100) / 100,
          recentDays: ageDays,
          velocity7d: vel,
          region: Math.round(regionAff * 100) / 100,
          lang: Math.round(langAff * 100) / 100,
          reporters
        }
      });
    }
    out.sort((a, b) => (b.rank - a.rank) || (a.id < b.id ? -1 : 1));
    return out;
  }

  // -- publish: records + decisions -> the public document -------------------

  /**
   * Build the payload of blocklist/current.
   *
   * Verbatim publish semantics from the server's addToList/removeFromList:
   * an approved report with a numeric id publishes the ID ONLY (ids survive
   * renames, usernames do not); the username is the fallback for reports that
   * never resolved an id. Pending and rejected publish nothing, and -- the
   * safety-critical line -- only approved, id-bearing accounts ever appear in
   * `targets`, because a platform block is issued against a numeric id.
   */
  function buildPublish(records, rep, manual) {
    const m = manual || {};
    const ids = [], usernames = [], targets = [];

    for (const r of records) {
      // Reported-but-not-yet-reviewed accounts used to be listed here, as
      // `pending`, so the in-page chip could say "already reported" about
      // somebody else's report. That published an unreviewed accusation to a
      // world-readable document: anyone could file reports, with no account
      // and no review, and have any profile they liked named publicly as
      // reported. It also contradicted the rule this project states
      // everywhere else -- that naming an account in public is a separate
      // decision a person takes about that account, one at a time.
      //
      // The chip now answers from what this browser itself reported, which is
      // the only part of the question it was ever entitled to know.
      if (r.status !== 'approved') continue;
      if (isId(r.profileId)) {
        if (!ids.includes(String(r.profileId))) ids.push(String(r.profileId));
      } else {
        const u = normUser(r.username);
        if (u && !usernames.includes(u)) usernames.push(u);
      }
    }
    for (const v of (m.ids || [])) if (isId(v) && !ids.includes(String(v))) ids.push(String(v));
    for (const v of (m.usernames || [])) {
      const u = normUser(v);
      if (u && !usernames.includes(u)) usernames.push(u);
    }

    const eligible = records
      .filter(r => r.status === 'approved' && isId(r.profileId))
      .sort((a, b) => (b.lastReportAt < a.lastReportAt ? -1 : 1))
      .slice(0, TARGET_PUBLISH_CAP);
    // The tag of every id that gets published, not just the capped slice of
    // targets: warm blocking meets an id with no target record behind it and
    // still has to decide whether this user wants that kind of account blocked.
    const tagById = new Map();
    for (const r of records) {
      if (r.status !== 'approved' || !isId(r.profileId)) continue;
      const id = String(r.profileId);
      if (!tagById.has(id)) tagById.set(id, TAGS.includes(r.tag) ? r.tag : 'clone');
    }
    const idTags = {};
    // A manually listed id has no reports and so no verdict to derive. 'other'
    // rather than 'clone': it is the tag every install blocks by default but
    // the one an owner narrowing their tags would drop first, which is the
    // right way round for an entry nobody voted on.
    for (const id of ids) idTags[id] = tagById.has(id) ? tagById.get(id) : 'other';

    for (const r of eligible) {
      targets.push({
        platform: r.platform,
        id: String(r.profileId),
        username: r.username || null,
        displayName: r.displayName || null,
        tag: TAGS.includes(r.tag) ? r.tag : 'clone',
        trust: Math.round((r.reporters || [])
          .reduce((n, who) => n + trustOf(rep, who), 0) * 100) / 100,
        // The headcount behind the trust score. Trust already sums their
        // weights; this is how many people that sum is spread across.
        reporters: (r.reporters || []).length,
        last: String(r.lastReportAt || r.updatedAt || r.createdAt).slice(0, 10),
        days: Object.assign({}, r.days),
        regions: Object.assign({}, r.regions),
        langs: Object.assign({}, r.langs)
      });
    }

    return {
      v: 1,
      updatedAt: new Date().toISOString(),
      ids, usernames,
      docIdOverrides: (m.docIdOverrides && typeof m.docIdOverrides === 'object')
        ? m.docIdOverrides : {},
      targets,
      idTags,
      // Shipped with the list so both rankers agree without an extension
      // update. Whatever the admin doc holds wins; absent, these are the
      // values every ranker already falls back to.
      rankWeights: rankWeightsOf(m.rankWeights)
    };
  }

  // -- publish: the public transparency view ---------------------------------

  // An evidence link that reaches the page must be https. The rules accept
  // http as well and records predating them may hold anything at all, but a
  // page that names people should not send anyone to a link that can be
  // rewritten in transit, and there is nothing an http-only citation proves
  // that an https one does not.
  const isHttps = (u) => /^https:\/\//i.test(String(u || '').trim());

  const PUBLIC_REGION_CAP = 3;   // region NAMES shown per profile

  /**
   * Build the payload of blocklist/publicView.
   *
   * Everything about this function is subtraction. The blocklist is a list of
   * ids an extension acts on; this is a page that says in public that a named
   * account is a clone or a scammer, so what it may carry is drawn far tighter
   * than what the dashboard holds:
   *
   *   - Approved AND opted in. `public` is a separate, deliberate decision from
   *     the dashboard (see aggregate); approving alone never names anyone.
   *   - No reporter identities. Not the acct_ pseudonyms, not per-reporter
   *     counts, not trust weights -- only how many people reported. The
   *     pseudonyms are stable across targets, so publishing even one would let
   *     anyone reconstruct who reported what.
   *   - Evidence needs a link. A quoted summary with no post behind it is an
   *     unverifiable claim about a named person, so the entry is dropped
   *     rather than published; a summary WITH a link is kept, because the link
   *     is what makes it checkable.
   *   - No moderator notes, and region NAMES without their counts -- "two
   *     reports from Asia/Ho_Chi_Minh" narrows a reporter in a way the bare
   *     name does not.
   *
   * `rep` never reaches the output. It orders it: the same trust-weighted sum
   * the queue is ranked by decides which profiles lead, so the best-evidenced
   * cases are at the top of the page and the number behind that ordering stays
   * inside this function.
   */
  function buildPublicView(records, rep) {
    const trust = rep || Object.create(null);
    const scoreOf = (r) =>
      (r.reporters || []).reduce((n, who) => n + trustOf(trust, who), 0);
    const day = (v) => String(v || '').slice(0, 10);
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

    // Ordering is total on purpose -- score, then the most recently active,
    // then the key -- so republishing an unchanged store produces a
    // byte-identical list of profiles rather than a reshuffled one.
    const chosen = (records || [])
      .filter(r => r.status === 'approved' && r.public === true)
      .sort((a, b) =>
        (scoreOf(b) - scoreOf(a)) ||
        cmp(day(b.lastReportAt), day(a.lastReportAt)) ||
        cmp(a.key, b.key));

    const profiles = chosen.map(r => ({
      platform: r.platform,
      // Username-only targets are published as themselves rather than dropped:
      // the page is about who an account claims to be, and that is the
      // username. Blocking still needs the id; naming does not.
      id: isId(r.profileId) ? String(r.profileId) : null,
      username: r.username || null,
      displayName: r.displayName || null,
      tag: TAGS.includes(r.tag) ? r.tag : 'clone',
      // The headcount, and nothing about who is in it.
      reports: (r.reporters || []).length,
      firstReported: day(r.createdAt),
      lastActive: day(r.lastReportAt || r.updatedAt || r.createdAt),
      regions: Object.keys(r.regions || {})
        .sort((a, b) => (r.regions[b] - r.regions[a]) || (a < b ? -1 : 1))
        .slice(0, PUBLIC_REGION_CAP),
      evidence: (r.posts || [])
        .filter(p => p && isHttps(p.url))
        .map(p => ({ url: String(p.url), summary: p.summary || null }))
    }));

    const byTag = {};
    for (const p of profiles) byTag[p.tag] = (byTag[p.tag] || 0) + 1;

    return {
      v: 1,
      updatedAt: new Date().toISOString(),
      counts: {
        // What this page shows, against what it is a window onto: `blocked` is
        // every approved target and `reports` every submission ever filed,
        // decided or not, so a reader can see how small the named slice is
        // next to the work behind it.
        published: profiles.length,
        blocked: (records || []).filter(r => r.status === 'approved').length,
        reports: (records || []).reduce((n, r) => n + (r.count || 0), 0),
        byTag
      },
      profiles
    };
  }

  // -- stats (verbatim shapes) -----------------------------------------------

  function buildStats(records, rep, list) {
    const all = records;
    const by = (s) => all.filter(r => r.status === s).length;
    const tally = (fn) => {
      const m = Object.create(null);
      for (const r of all) { const k = fn(r); if (k) m[k] = (m[k] || 0) + 1; }
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };

    // Reports per day for the last fortnight, oldest first, so the dashboard
    // can show whether the queue is growing or being kept up with.
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ day: d, count: 0 });
    }
    const dayIndex = new Map(days.map((d, i) => [d.day, i]));
    for (const r of all) {
      const d = String(r.createdAt || '').slice(0, 10);
      if (dayIndex.has(d)) days[dayIndex.get(d)].count++;
    }

    const reporters = Object.create(null);
    for (const r of all) for (const who of (r.reporters || [])) {
      reporters[who] = (reporters[who] || 0) + 1;
    }
    // Volume alone flatters a mass-reporter. Carrying the weight alongside it
    // is what separates a prolific useful reporter from a prolific wrong one.
    const topReporters = Object.entries(reporters)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([who, n]) => [who, n, Math.round(trustOf(rep, who) * 100) / 100]);
    const distrusted = Object.keys(rep).filter(w => rep[w].weight < TRUST_FLOOR).length;
    const heldCount = all.filter(r => {
      const rs = r.reporters || [];
      return rs.length > 0 && rs.every(w => trustOf(rep, w) < TRUST_FLOOR);
    }).length;
    const withEvidence = all.filter(r => (r.posts || []).length > 0).length;

    return {
      ok: true,
      reports: {
        total: all.length, pending: by('pending'),
        approved: by('approved'), rejected: by('rejected'),
        withEvidence,
        held: heldCount,
        totalSubmissions: all.reduce((n, r) => n + (r.count || 0), 0)
      },
      reporters: { known: Object.keys(rep).length, distrusted, trustFloor: TRUST_FLOOR },
      blocklist: { ids: list.ids.length, usernames: list.usernames.length },
      byPlatform: tally(r => r.platform),
      byReason: tally(r => r.reason),
      perDay: days,
      topReporters
    };
  }

  // -- trends (verbatim) -----------------------------------------------------

  function trendMatrix(records, opts) {
    const span = Math.min(Math.max(parseInt(opts && opts.days, 10) || DAY_BUCKETS, 1), DAY_BUCKETS);
    const days = [];
    for (let i = span - 1; i >= 0; i--) days.push(dayKey(Date.now() - i * 86400000));
    const dayIdx = new Map(days.map((d, i) => [d, i]));

    const totals = Object.create(null);
    const rows = Object.create(null);
    const perRegion = Object.create(null);
    const rep = reputation(records);

    for (const r of records) {
      const rd = r.days || {};
      for (const reg of Object.keys(r.regions || {})) {
        if (!hasOwn(rows, reg)) rows[reg] = new Array(span).fill(0);
        if (!hasOwn(perRegion, reg)) perRegion[reg] = [];
        // A record's day buckets are not split by region -- one account rarely
        // spans several -- so the account's dominant region carries its history.
        totals[reg] = (totals[reg] || 0) + r.regions[reg];
        perRegion[reg].push(r);
      }
      const dominant = Object.keys(r.regions || {})
        .sort((a, b) => r.regions[b] - r.regions[a])[0];
      if (!dominant) continue;
      for (const d of Object.keys(rd)) {
        if (dayIdx.has(d)) rows[dominant][dayIdx.get(d)] += rd[d];
      }
    }

    const regions = Object.keys(rows).sort((a, b) => totals[b] - totals[a]).slice(0, 12);
    const topByRegion = Object.create(null);
    for (const reg of regions) {
      topByRegion[reg] = (perRegion[reg] || [])
        .map(r => ({
          key: r.key,
          displayName: r.displayName || null,
          username: r.username || null,
          platform: r.platform,
          status: r.status,
          last7: velocity(r.days, 7),
          reports: (r.reporters || []).length,
          trust: Math.round((r.reporters || [])
            .reduce((n, who) => n + trustOf(rep, who), 0) * 100) / 100
        }))
        .sort((a, b) => (b.last7 - a.last7) || (b.trust - a.trust))
        .slice(0, 5);
    }

    return {
      days,
      regions,
      matrix: regions.map(reg => rows[reg]),
      totals: regions.map(reg => totals[reg]),
      topByRegion
    };
  }

  // -- exports ---------------------------------------------------------------

  const API = {
    REASONS, TAGS, PLATFORMS, DAY_BUCKETS, HALF_LIFE_DAYS, TRUST_FLOOR,
    RANK_WEIGHTS,
    dayKey, normUser, isId, bump, trimDays, velocity, affinity,
    modalTag, effectiveTag, rankWeightsOf,
    weightOf, reputation, trustOf, withTrust, sortQueue,
    aggregate, rankTargets, buildPublish, buildPublicView, buildStats, trendMatrix
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined') globalThis.CB_LOGIC = API;
})();
