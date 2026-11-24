# Compy scoring review — November 24, 2026

> Follow-up implementation: the reliability, scoring, search, explanation and
> prospective-evaluation changes are now implemented in the working tree. See
> [SCORING.md](SCORING.md), [README.md](README.md) and [EVALUATION.md](EVALUATION.md).
> The audit below preserves the pre-change findings. Empirical calibration,
> learned weights and a hierarchical replacement model still require future
> outcome data; they are not claimed as completed or validated.
> The `.3` follow-up adds relative single-swap grades, consistent draft answers,
> raw-component capture, frozen evaluation plans and an offline model-validation
> tool. Numerical app weights remain unchanged; no accuracy gain is claimed.

## Decision

Reduce synergy moderately and increase the role-specific Emerald+ prior slightly, but treat these as conservative tuning. The largest accuracy gains are likely to come from complete, consistent match history and honest validation—not another hand-selected coefficient.

The current output can rank compositions. It has not been shown to estimate their probability of winning. Averaging five historical player win rates, then adding mastery, role comfort, matchup and overlapping pair effects, does not establish a calibrated probability. A displayed 62% does not yet mean comparable teams win 62% of the time. Clamping to 5–95% does not solve this.

This review combines source inspection, recorded roster data, direct OP.GG cohort comparisons, and published statistical guidance. It is **not an out-of-time accuracy backtest**. No fictional matches or outcomes were generated.

## Changes implemented in this working copy

| Change | Before | After | Interpretation |
|---|---|---|---|
| Synergy scale | 0.5 | 0.4 | Both positive and negative pair adjustments are 20% smaller. |
| Individual prior strength | 8 | 10 | More shrinkage toward the champion’s current role meta WR. |
| Game-range slider | Total champion games | Champion games in assigned role | Both bounds use actual role games, including Flex-only filtering. |
| Worst-comp fallbacks | Could bypass game/mastery filters | Stay within hard filters | An empty pool stays empty instead of silently violating the slider. |
| Meta cohort | Local inferred rank; live unspecified | Explicit `emerald_plus` default | Local fetch, seeded config, worker and counters agree. |
| Counter cache | Region/champion/role | Also tier and meta patch | Rank/patch changes cannot reuse the previous cache key. |
| Provenance | Data Dragon asset version shown as patch | Meta provider’s patch, cohort, analysis time | Solo/Duo meta is distinguished from personal Flex-only data. |
| Refresh metadata | Could imply success after failed meta fetch | Last successful meta fetch retained | Failed refreshes do not make old meta appear newly fetched. |

Role records now appear on selected champion cards even with the Role WR toggle off. Previously saved all-role slider limits are not reused with a new meaning. Manually selected picks remain visible, with a warning when outside the role range.

The refreshed fallback meta is patch **16.23**, NA Emerald+, **1,219,106 matches**, with 173 champions and 268 published role rows. These are local changes; deployment is separate.

### How much stronger is the prior?

For effective personal games `g`, the meta weight is `K / (g + K)`. Effective games include discounted off-role evidence in scoring; the slider never uses that discount.

| Effective personal games | Old K=8 | New K=10 |
|---:|---:|---:|
| 5 | 61.5% | 66.7% |
| 10 | 44.4% | 50.0% |
| 20 | 28.6% | 33.3% |
| 50 | 13.8% | 16.7% |

Increasing K pulls losing records upward and winning records downward toward the prior; it does not simply award higher scores to meta champions. Across every recorded local player/champion/role combination, including nonviable picks, the median absolute individual-score change is **0.382 percentage points**, with a 90th percentile of **1.120 points** using the refreshed meta. This is a sensitivity check, not evidence of better predictions.

## What the audit found

### 1. Fix match completeness before fitting weights

`worker/src/index.js` refreshes only the five newest IDs per player. If someone plays more than five games between refreshes, older unseen games can disappear from the query window. Processing is capped at twelve matches per call, but the next catch-up call can hit the three-minute debounce and return `remaining: 0`. The UI then stops even with a backlog.

**Recommendation:** persist a per-player ingestion cursor, page until reaching known history, maintain a durable pending-ID queue, and report remaining work truthfully. Rate limiting should delay ingestion rather than discard coverage. Reconcile against Riot periodically and mark the date through which history is complete.

### 2. The stated history window does not stay consistent

Local fetch/reseed uses an age cutoff; live aggregates only add games. In the inspected live-state snapshot, 1,786 IDs were processed. Of 1,467 with locally available nonzero timestamps, **282 predate November 24, 2025**, despite a 365-day configuration. The oldest observed match is August 28, 2025. The remaining 319 lack usable local evidence, so these are coverage-qualified counts.

`build_seed.py` also scans cached matches without applying the configured queue filter. The same available processed sample contains **936 Solo/Duo, 526 Flex, and five queue-710 games** despite ranked configuration.

**Recommendation:** define one shared queue/window policy for fetch, seed and worker. Retain timestamped per-match contributions so old games can expire, or rebuild from an authoritative event log. Do not claim a rolling year until the live path enforces it. Investigate the existing non-ranked records before dropping or reclassifying them.

### 3. Pair samples are too small to support strong claims

The live snapshot contains **461 champion-pair records**, median **two games**, with **460 below ten games**. It contains **821 champion-role rows**, median **two games**, with **630 below five**. The smaller checked-in fallback separately has 239 champion pairs (all below ten) and 639 role rows (520 below five). These are different datasets and should not be conflated.

A five-stack win appears in five player records and ten duo records, as well as champion-pair records. Reducing synergy magnitude helps, but a flat overlap discount cannot identify which pair caused success. Strong players, favorable opponents and stable five-stacks can all look like chemistry. Microsoft's [TrueSkill explanation](https://www.microsoft.com/en-us/research/project/trueskill-ranking-system/) similarly notes the difficulty of distinguishing players who always play together.

**Recommendation:** initially compare the model against a no-synergy baseline. Later estimate a strongly regularized pair residual beyond player/champion/role strength, with match/session-level uncertainty. Retain synergy only if it improves held-out performance. Do not add another large meta-synergy term before establishing incremental value.

### 4. Meta provenance and missing lanes matter

Direct OP.GG API checks returned 684,889 matches for exact `emerald`, versus 1,219,106 for `emerald_plus`. The unspecified default happened to match Emerald+ at inspection time. The explicit change therefore improves consistency and auditability; it does **not** currently imply a different live cohort. OP.GG's [champion page](https://op.gg/lol/champions?tier=emerald_plus&type=ranked&region=na) identifies Emerald+ and Ranked Solo/Duo. Preserve the API response's patch, rather than trusting a page URL's patch parameter.

Fifteen of 173 champions have published role shares totaling less than 85%. Examples: Heimerdinger lists Top at 61.8%, Cassiopeia Mid at 69.3%, and Neeko Support at 75.1%. Missing rows are incomplete coverage, not proof the champion cannot play those roles. Current `metaWR()` subtracts four points for missing-role fallback, so a stronger prior also strengthens this assumption.

**Recommendation:** fetch missing role details when possible. Distinguish “insufficient meta coverage” from “off-meta.” Show whether the prior is observed role data, overall-champion fallback, or neutral fallback. Keep the existing penalty unchanged until alternatives can be compared. Emerald+ Solo/Duo is a useful transfer prior for flex, not an exact population match for every player.

Riot explicitly distinguishes [Data Dragon assets](https://developer.riotgames.com/docs/lol#data-dragon) from regional client versions; the asset version should not certify the patch of statistical data.

### 5. Several adjustments count related evidence twice

Mastery adds up to three points on top of records that already reflect champion experience. Role comfort is an unshrunk frequency bonus: a player with all recorded games in one role can receive **+9.6 points**, regardless of whether that share is based on two games or two hundred. These terms can outweigh the requested synergy adjustment.

`dAdj()` compares raw matchup WR with 50%, although champion meta strength is already in the baseline. Champion-pair expectations use champion overall meta WR, without the pilots' baseline or their assigned roles. These are not clean interaction effects.

**Recommendation:** run ablations removing mastery, role comfort and matchup terms separately. Use mastery primarily as familiarity/eligibility evidence until it demonstrates independent value. Shrink role comfort by its sample size. For later matchup modeling, estimate residual performance relative to the two champions' baseline strengths, with regularization. Riot's [champion learning-curve discussion](https://www.leagueoflegends.com/en-gb/news/dev/dev-balancing-new-champions/) supports treating experience as relevant, but does not validate a universal linear mastery bonus.

### 6. “Optimize” is a limited search

The full optimizer considers the top three local candidates per player/role; fixed-role optimization considers eight. A pick excluded from the three can produce a better overall comp because of champion conflicts or interactions. Candidate ordering also includes a role-share adjustment up to two points, described previously as a tiebreaker even though it can reverse meaningful differences.

**Recommendation:** benchmark top-three search against a wider or exact search on manageable fixed squads. Measure lost score and runtime before changing the search budget. Use lexicographic role-share ordering if it is intended only to break ties. Prefer “best found” over claiming a mathematical global optimum.

### 7. Protect state updates from races

Refresh and scheduled meta refresh both read and rewrite the whole KV state. Overlapping writers can overwrite newer records even if their changes concern different fields.

**Recommendation:** serialize mutations through a single Durable Object or another transactional owner; use KV for published read snapshots. A backup and reconciliation strategy should precede aggregate-format changes. A process-local lock is not sufficient across worker instances.

## A validation plan that can support accuracy claims

1. **Log decisions prospectively.** Store model version, predicted score, actual chosen comp, alternative candidates, filters, queue, patch, data completeness, pregame timestamps, side and opponent composition when known. Link the eventual outcome once per match. Keep historical meta snapshots; today's meta cannot stand in for a past patch.
2. **Reconstruct only pre-match evidence.** Exclude the evaluated match and every later match from its personal/pair aggregates. Keep every player/pair row belonging to one match in the same split. Use earlier calendar/patch blocks for training, later blocks for tuning, and the latest untouched period for final testing. With irregular match timing, choose calendar blocks rather than blindly applying equally spaced splits. See [time-series validation guidance](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).
3. **Compare simple baselines.** Start with 50%, meta-only, player baseline, shrunk player/champion/role WR, the old full heuristic, and this revision. Compare no-synergy/no-mastery/no-comfort variants. Tune only a small predefined grid, such as prior K in 8/10/20 and synergy in 0/0.2/0.4, to avoid selecting noise from many experiments.
4. **Measure probabilities and uncertainty.** Report Brier score, log loss and reliability plots, segmented by queue, patch and role-sample band. Use match/session block bootstrap intervals. Brier alone mixes calibration and discrimination; see [calibration guidance](https://scikit-learn.org/stable/modules/calibration.html). Do not calibrate and report performance on the same outcomes.
5. **Measure recommendations separately.** Track empty-role pools, real candidate coverage, top-three stability after one added match, user override rates, search quality versus wider search, and response time. Replay can evaluate the comp actually played; it cannot prove an unplayed recommendation would have won.
6. **Adopt complexity only when it earns its place.** A hierarchical player/champion/role model is a sensible next model for sparse records. [Stan's repeated binary-trial case study](https://mc-stan.org/learn-stan/case-studies/pool-binary-trials.html) demonstrates partial pooling and held-out comparison. If enough opponent data becomes available, compare a regularized logistic model of team feature differences, side and residual interactions. Avoid extensive tuning on a small holdout; [Cawley and Talbot](https://jmlr.org/papers/v11/cawley10a.html) document model-selection overfitting.

Do not claim an improvement when differences are within uncertainty, or accept an aggregate gain that hides a material loss in the intended Flex use case. If current history cannot support leakage-free reconstruction, start prospective collection and keep the score explicitly heuristic meanwhile.

## Usability priorities

- Rename the headline to **Composition score** until probability calibration is established; avoid probability-like verdicts such as “Favored” without an opponent model.
- Show “why this pick”: role record, prior source/weight, and the largest adjustments. Distinguish a reliable personal pick from an exploratory meta pick.
- Show evidence strength based on effective sample and coverage, not just a hard minimum. A five-game minimum is an eligibility preference, not a confidence guarantee.
- When no full comp satisfies filters, identify the constrained player/role and suggest a specific relaxation; never silently bypass the filters.
- Separate “strongest estimated comp” from “practice/new picks,” rather than treating a maximum-games cap as predictive evidence.
- Display data age/completeness and current settings alongside results. Keep one-click locking and make manual exceptions explicit.

Recommended order: finish the current modest tuning and role filter; repair ingestion/window/queue consistency and write serialization; instrument predictions; evaluate simple baselines and ablations; only then fit more complex scoring. The follow-up implements the practical reliability and usability fixes plus prospective evaluation. Fitted model replacement and proof of accuracy remain dependent on future outcomes.

## Verification

Run `node --test tests/*.test.mjs` and `python3 -m py_compile fetch_meta.py build_seed.py`. Regression checks use recorded Riot/OP.GG data, including candidate filtering across strict and flex modes, old-setting migration, shrinkage direction, synergy scaling, and worker meta/cache behavior. UI checks use the Codex browser. These establish implementation behavior, not predictive accuracy.
