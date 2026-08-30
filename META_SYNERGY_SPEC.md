# Meta champion-pair synergy as the prior for pilot-attributed pairs

Status: spec, not implemented. Written 2026-08-12.

## Problem

`champPairAdjRaw` ([index.html:1093](index.html)) measures a champ pair against a flat
baseline — the mean of the two champions' *individual* meta win rates:

```js
const expected = (metaWR(ca, null) + metaWR(cb, null)) / 2;
return (shrunk(s.wins, s.games, K_PAIR, expected) - expected) * SYNERGY_WEIGHT * (s.games / (s.games + 10));
```

That baseline knows nothing about whether the two champions actually work together. So a
2-game personal row is the *only* evidence the model has about a pairing, and with `K_PAIR = 20`
it still moves the score enough to flip a pick. Observed: SmashBrother's Yasuo beat his Ekko
for mid on the strength of one `Yasuo + fallenbanditfan Ezreal 2W/0L` row, despite Ekko scoring
higher individually (66.1% vs 65.9%).

Two records are being conflated. `champPairIdx` answers *"do these two players, on these two
champions, win together?"*. What's missing is *"do these two champions work together for
anyone?"* — which has millions of games behind it.

And the first question currently has no usable answer either: **all 216 champ-pair rows in
`data/players.json` sit at 2–5 games** (180 of them at exactly 2). This is not a patch artifact —
personal records span the group's whole match history, not the current patch. There is no sample
size at which the pilot-attributed champ-pair term is currently meaningful, so today the model is
reading noise and the optimizer is acting on it.

## Data source

**Verified working**, no API key:

```
GET https://lol-api-champion.op.gg/api/{region}/champions/ranked/{championId}/{POS}/synergies
```

`{POS}` ∈ `TOP | JUNGLE | MID | ADC | SUPPORT` — the same slugs `OPGG_POS` already maps to, and
the same host/route family `worker/src/index.js:336` already uses for `/counters`.

Response: `{ data: [...50 rows...], meta: { version, cached_at, total_play } }`. Each row:

```json
{ "champion_id": 245, "position": "MID", "synergy_champion_id": 902, "synergy_position": "SUPPORT",
  "play": 344, "win": 182, "win_rate": 0.52907, "score_rank": 9, "score": 0,
  "synergy_tier_data": { "tier": 3, "rank": 20, "rank_prev": 20, "rank_prev_patch": 27 } }
```

Top 10 partners per partner-position (TOP/JUNGLE/ADC/SUPPORT/ALL) = 50 rows, one request covering
every pairing that champion+role has. `win` and `play` arrive as integers, which drops straight
into the existing `shrunk(wins, games, k, prior)` machinery.

Ignore the `ALL` bucket (position-agnostic, double-counts the others). `score` is often 0 — do not
depend on it; use `win`/`play`.

### Sample sizes actually observed (NA, patch 16.15, default tier slice)

| pairing | n per partner | 95% CI on the pair WR |
|---|---|---|
| Caitlyn ADC × SUPPORT | 1,159 – 3,184 | ±1.7 – 2.9pp |
| Ekko MID × JUNGLE | 354 – 812 | ±3.4 – 5.2pp |

Bot lane clears noise comfortably (Caitlyn+Thresh +2.6pp ± 1.9; Seraphine −2.9 ± 2.7). Mid–jungle
is measurable but marginal (Graves +2.7 ± 3.4; Bel'Veth −4.6 ± 4.5) — individual rows there are
near the noise floor, which the shrinkage below handles without a hard cutoff.

Note: the HTML page at `op.gg/lol/champions/<key>/synergies/<pos>` returns the same fields at
3–8× *smaller* samples (a narrower slice). Use the JSON route, not the page scrape.

### Query params (verified)

Both `?version=` and `?tier=` work, and both change the slice:

| query | reported version | total_play | top row |
|---|---|---|---|
| *(none)* | 16.15 | 10,961 | 344 |
| `?version=16.16` | — | — | **0 rows** |
| `?version=16.14` | 16.14 | 13,458 | 323 |
| `?tier=emerald` | 16.15 | 6,852 | 211 |
| `?version=16.14&tier=all` | 16.14 | 52,870 | 1,327 |

Two consequences, both load-bearing:

- **A just-released patch returns an empty array, not an error.** `version=16.16` gives
  `{data: [], meta: {...}}` with 200. Code must treat empty as "no data for this patch" and fall
  through, never as "these champions have no synergy."
- **Do not reach for `tier=all` to get samples up.** It is a ~4× larger pool, but the whole
  quantity here is a *difference* between the pair's WR and the two champions' individual WRs, and
  those individual WRs come from `data/meta.json`, which `fetch_meta.py:36` deliberately fetches on
  the default slice (with a comment explaining that `tier=all` "would quietly move every prior").
  Mixing a `tier=all` pair WR against a default-slice baseline puts a slice artifact straight into
  the synergy term. **The synergy request must carry the same tier as the meta pull** — reuse
  `fetch_meta.py`'s resolved `tier` verbatim, including the empty case. Get samples up by pooling
  patches (§8), which holds the slice constant.

## Design

The meta pair row becomes the **prior the personal row shrinks toward**, replacing the flat
`expected`, and the personal row's shrinkage constant is raised so that it takes real evidence to
override a league-wide measurement. Those are two changes, not one — §3 shows why the first alone
does not achieve the second.

### 1. Worker route

Add `/synergies` next to `counters()` in `worker/src/index.js`, same shape, same KV pattern:

- validate `champ` (number) and `pos` ∈ the five OPGG positions — reuse the `counters()` guard
- key `synergies:${region}:${champ}:${pos}`, TTL `COUNTERS_TTL` (24h; synergy moves as slowly as matchups)
- upstream fetch with the existing `User-Agent` header
- keep only what scoring needs, to stay under KV value limits and cut parse cost:
  `{ champ, pos, synergies: rows.filter(r => r.synergy_position !== "ALL").map(r => ({ c: r.synergy_champion_id, p: r.synergy_position, play: r.play, win: r.win })) }`
- register at `worker/src/index.js:404` alongside the `/counters` line
- the upstream URL carries the meta pull's tier and the pooled patch pair — see §8; the cache key
  must include both (`synergies:${region}:${tier}:${patch}:${champ}:${pos}`) or a patch rollover
  will serve stale rows for a day

### 2. Client fetch

Mirror `ensureCounters` ([index.html:978](index.html)) exactly — it already solves the lazy-fetch,
placeholder-so-we-don't-refetch, re-render-on-arrival problem:

```js
let synergyIdx = {};   // "cid|POS" -> { "synCid|SYNPOS": {play, win} }
function ensureSynergies(cid, role) { /* same body as ensureCounters, /synergies path */ }
```

On arrival call `draftChanged(false)` as `ensureCounters` does. Clear `synergyIdx` where
`counterIdx` is cleared on data reload (`index.html:2479` neighbourhood).

**Symmetry differs from counters.** `matchupRec` flips `win` when reading the reverse direction
(`{ play, win: play - win }`) because a matchup is adversarial. Synergy is not — both champions
share the same wins. The reverse lookup is a plain read:

```js
function metaPairRec(ca, ra, cb, rb) {
  const a = (synergyIdx[ca + "|" + OPGG_POS[ra]] || {})[cb + "|" + OPGG_POS[rb]];
  if (a) return a;
  return (synergyIdx[cb + "|" + OPGG_POS[rb]] || {})[ca + "|" + OPGG_POS[ra]] || null;
}
```

The reverse path matters: each page lists only its top 10 per position, so A→B and B→A are both
partial and their union covers materially more pairs than either alone.

### 3. Scoring change

Two separate changes are needed, and it matters that they're understood as separate — **adding the
meta prior does not, by itself, quiet the 2-game rows.**

Since `shrunk(w, g, K, p) − p = (w − p·g)/(g + K)`, re-pointing the prior from `base` to `metaExp`
changes the personal term by `(base − metaExp)·g/(g + K)` — a quantity that goes to zero exactly
when `g` is small. Worked through for the Yasuo row (w=2, g=2, K_PAIR=20, ×`SYNERGY_WEIGHT`
×`g/(g+10)`):

| prior | personal contribution |
|---|---|
| `base` = 0.500 (today) | 0.38pp |
| `metaExp` = 0.520 | 0.36pp |

A 4% reduction. The prior **adds** a well-measured signal; it does not **attenuate** a badly
measured one. That needs its own lever.

#### 3a. Damp the pilot-attributed term

Every champ-pair row in `data/players.json` is n = 2–5 games (216 rows; 180 of them are exactly 2,
max is 5). At `K_PAIR = 20` a 2-0 row still moves a pair ~0.4pp, which is the entire mechanism
behind the Yasuo pick. Split the constant so champ pairs and player duos can be tuned apart —
duos genuinely have evidence (35 rows, median 42 games, max 256) and should keep `K_PAIR = 20`:

```js
const K_CHAMP_PAIR = 100;   // pilot-attributed champ pairs: ~100 shared games for half weight
```

| row | K_PAIR = 20 (today) | K_CHAMP_PAIR = 100 |
|---|---|---|
| 2W-0L (the Yasuo row) | 0.38pp | 0.08pp |
| 5W-0L (group's largest) | 0.60pp | 0.38pp |
| hypothetical 20W-5L | 4.3pp | 2.0pp |

**State this plainly to whoever approves the change:** on the current dataset this makes the
personal champ-pair term nearly silent, because the group has never played the same champ pair more
than five times. That is the intended consequence — the term stops asserting things it can't
support — but it is a visible behaviour change, not a no-op.

#### 3b. Add the meta prior

```js
const K_META_PAIR = 200;          // meta pair row reaches half weight at 200 games
const META_PAIR_WEIGHT = 0.25;    // deliberately below SYNERGY_WEIGHT — see "Calibration"
const META_PAIR_CLAMP = 0.02;     // no single champ pair moves a comp more than 2pp

function champPairAdjRaw(pa, ca, ra, pb, cb, rb) {
  const key = (pa < pb || (pa === pb && ca <= cb))   // unchanged — matches build_seed.py's
    ? pa + "|" + ca + ":" + pb + "|" + cb            // canonicalization by (riotId, championId)
    : pb + "|" + cb + ":" + pa + "|" + ca;

  // individual strength, already counted by indScore — see pairBase() below
  const base = (pairBase(ca, ra) + pairBase(cb, rb)) / 2;

  // league-wide: do these two champions work together, in these two roles?
  const mp = metaPairRec(ca, ra, cb, rb);
  const metaExp = mp
    ? clamp(shrunk(mp.win, mp.play, K_META_PAIR, base), base - META_PAIR_CLAMP, base + META_PAIR_CLAMP)
    : base;

  // this group: do THESE pilots win on them, relative to that expectation?
  const s = champPairIdx[key];
  const est = s ? shrunk(s.wins, s.games, K_CHAMP_PAIR, metaExp) : metaExp;

  const meta = (metaExp - base) * META_PAIR_WEIGHT;
  const own  = (est - metaExp) * SYNERGY_WEIGHT * (s ? s.games / (s.games + 10) : 0);
  return meta + own;
}
```

Three things this gets right that a naive version doesn't:

- **The two terms are weighted separately.** They measure different populations; summing them at
  one weight treats a 3,000-game league effect and a 2-game personal streak as the same kind of
  evidence.
- **The personal term is a delta from `metaExp`, not from `base`.** Otherwise the meta effect gets
  counted twice for any pair that also has a personal record.
- **`(est − metaExp)` keeps the `g/(g+10)` damp; `(metaExp − base)` does not.** Meta rows are
  already sample-weighted by `shrunk` at n in the hundreds-to-thousands; damping them again would
  suppress the only well-measured term in the model.

#### 3c. `pairBase` — do *not* reuse `metaWR` here

`metaWR(cid, role)` subtracts `OFF_META_PRIOR_PENALTY` (0.04) when a champion has no meta presence
in that role ([index.html:903](index.html)). That penalty is correct for `indScore` and actively
wrong as a pair baseline: lowering `base` makes `(w − base·g)` **larger**, so an off-meta pick
would collect *inflated* pair credit on top of the individual penalty it already pays. Use a
baseline that reports strength only:

```js
// Meta WR for a champ in a role, with no off-meta penalty: this is a baseline
// to measure a PAIR against, and the off-role penalty is already charged once
// by indScore. Charging it here would pay the pick back through the synergy term.
function pairBase(champId, role) {
  const m = META && META.champions[champId];
  if (!m) return 0.5;
  const pos = role && m.positions[OPGG_POS[role]];
  if (pos && pos.games >= 100) return pos.winRate;
  return m.winRate ?? 0.5;
}
```

`champPairAdjRaw`'s signature changes to take roles (`ra`, `rb`) — today it's called with no role
at all. Both call sites already have them: `champPairAdj` has `A.role`/`B.role`
([index.html:1101](index.html)) and `optimize`'s inner loop has `ROLES[i]`/`ROLES[j]`
([index.html:1220](index.html)).

### 4. `buildPairBoost` becomes unsound — must be fixed in the same change

`optimize()` prunes whole role-permutations with an upper bound built from `pairBoostIdx`
([index.html:1051](index.html)), which is the max positive `champPairAdjRaw` over **champ pairs
that appear in `champPairIdx`**. Once meta-only pairs can return a positive adjustment, that
bound is no longer an upper bound and the optimizer will silently prune comps that should have won.

Fix: compute the bound from the actual candidate lists for the permutation being considered,
rather than from a precomputed personal-pairs index. Inside the existing per-perm loop the
candidate arrays are already in hand (≤3 champs per slot), so:

```js
for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
  let best = 0;
  for (const x of cands[i]) for (const y of cands[j])
    best = Math.max(best, champPairAdjRaw(perm[i], x, ROLES[i], perm[j], y, ROLES[j]));
  champSynBound += best;
}
```

~90 extra evaluations per permutation against 243 combos × 10 pairs in the inner loop — roughly 4%
overhead, and the bound gets *tighter* than the current one, so some of that is won back in
pruning. `buildPairBoost()` and `pairBoostIdx` can then be deleted.

### 5. Prefetch

Scoring needs a row for every (candidate champ, role) pair the optimizer touches — 5 slots × 8
candidates in `optimizeChamps`, ≤3 in `optimize`. One request per (champ, role) covers all four
partner positions, so the working set is ~40 requests, KV-cached worker-side after the first.

Prefetch on the same triggers `ensureEnemyCounters` uses, plus on slot/candidate change:

```js
for (let i = 0; i < 5; i++)
  for (const cid of candidates(slots[i].player, ROLES[i], 8)) ensureSynergies(cid, ROLES[i]);
```

Missing data falls back to `base`, so scores are always valid — they just sharpen when rows land,
exactly as counters already behave.

### 6. Offline mode

The worker is optional; `data/meta.json` mode must still work. Extend `fetch_meta.py` to write
`data/synergies.json` for every (champ, position) with `roleRate ≥ 0.10` — ~250 requests, same
cadence as the existing meta pull, and it already resolves the `tier` that §"Query params" requires
these calls to match. Do the §8 patch pooling here too, and record `{patch, prevPatch, tier}` in the
file so a stale pull is diagnosable. Load it into `synergyIdx` where `META` is loaded. Without the
file, `metaPairRec` returns null everywhere and behaviour is exactly today's.

### 7. Display

The synergy tooltip ([index.html:2388](index.html)) currently says pairs are measured "vs their
average meta WR" — that stops being true. Rewrite to name both levels, and show the split in the
score card: `Synergy adjustment: ▲ +1.1pp (champs +0.7, this group +0.4)`. The whole point is that
a 2-game row can no longer masquerade as a comp-level insight, and the card should make that visible.

### 8. Patch freshness and pooling

A just-shipped patch has thin or absent synergy data — at the time of writing the app header reads
patch 16.16.1 while op.gg's newest published slice is 16.15, and `?version=16.16` returns zero rows.
Pooling the previous patch is explicitly acceptable, and is the right way to raise samples because
it holds the tier slice constant (unlike `tier=all`, see "Query params").

Pool in the worker, before caching, so the client never sees the seam:

```js
const PREV_PATCH_WEIGHT = 0.5;   // last patch is half a game per game

// rows keyed `${synergy_champion_id}|${synergy_position}`; current patch first
for (const r of cur)  acc[k(r)] = { play: r.play, win: r.win };
for (const r of prev) {
  const a = acc[k(r)] || (acc[k(r)] = { play: 0, win: 0 });
  a.play += r.play * PREV_PATCH_WEIGHT;
  a.win  += r.win  * PREV_PATCH_WEIGHT;
}
```

`shrunk` takes `(wins, games)` and does not care that they are fractional, so weighted pooling needs
no other change. Details that will bite otherwise:

- **Which two patches.** Ask for the patch `data/meta.json` reports (op.gg's own newest, not the
  client's live patch) and the one below it. Decrementing the minor version fails across a season
  boundary (16.1 has no 16.0) — when minor is 1, skip pooling rather than guess.
- **Empty ≠ error.** A 200 with `data: []` means that patch isn't published yet. Fall through to the
  older patch; only report an error if *both* come back empty.
- **Never pool across a patch that changed one of the champions.** This is the case where pooling is
  most tempting and least valid — a durability nerf is exactly when a pairing's synergy moves. There
  is no patch-note feed here, so the honest mitigation is the weight, not a filter: `0.5` means a
  stale pairing is outvoted within one patch of real data.
- **Halve the TTL during a transition.** `COUNTERS_TTL` is 24h; while the newest patch is still
  returning empty, a shorter TTL (say 6h) picks up op.gg's first publish the same day instead of the
  next.

Shipping without pooling is a legitimate first cut — `metaPairRec` returns null, every pair falls
back to `base`, and scoring is exactly today's. Pooling is what stops the feature going dark for the
first days of every patch.

## Calibration

`META_PAIR_WEIGHT = 0.25` is a starting value, not a derived one. Rationale: a comp has 10 champ
pairs; typical shrunk deltas run 1–3pp, so an unweighted sum swings the comp total by ±10pp or
more, against a current synergy display that lives in the ±1pp range. With the ±2pp per-pair clamp,
0.25 bounds a full comp's meta contribution at ±5pp worst case (10 × 2pp × 0.25) and puts the
realistic range near ±2pp. If the numbers need tuning later, move `META_PAIR_WEIGHT` first and
leave `K_META_PAIR` alone.

Two biases to keep in view, neither of which the shrinkage fixes:

- **Pair deltas are not independent effects.** Five champions' worth of pairwise win rates don't
  add up to a comp's win rate. Treat the sum as a ranking signal, not a calibrated probability.
- **Coverage correlates with pick rate.** op.gg lists the top 10 partners *by pick rate*, so an
  absent pairing scores 0 while a listed one can score up to ±0.5pp. Popular pairings are therefore
  the only ones that can gain, which tilts the optimizer toward meta-standard pairs — a real
  directional bias, not just missing data. The reverse lookup in `metaPairRec` widens coverage but
  does not remove the tilt.

## Verification

1. `metaPairRec(Caitlyn, BOTTOM, Thresh, UTILITY)` returns `{play: 2566, win: 1373}` — the reverse
   lookup should return the same row when queried Thresh-first.
2. The case that motivated this, tested as **two** separate assertions, because §3a and §3b act
   through different mechanisms:
   - §3a alone (`K_CHAMP_PAIR = 100`, no meta rows loaded): the Yasuo pair's personal contribution
     drops 0.38pp → 0.08pp, and mid should already flip to **Ekko** on the 0.2pp individual gap.
     This is the noise-suppression test.
   - §3b alone (meta rows loaded, `K_CHAMP_PAIR` left at 20): mid may or may not flip; what must
     hold is that the comp's synergy figure now moves when bot/support champs change *even with no
     personal pair rows at all*. This is the signal-addition test.

   Do not merge these into one assertion. If only the combined case is checked and it passes, a
   broken §3b hides behind a working §3a.
3. A comp where no champ pair has *either* a personal or a meta row must score identically to
   today's build (regression guard on the fallback path).
4. `optimize()` on the current roster must return the same top comp with the bound in §4 as with
   the bound disabled entirely (correctness check on the pruning change).
