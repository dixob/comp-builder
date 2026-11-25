# Composition scoring

Compy ranks candidate compositions with a **score out of 100**. It does not
estimate a calibrated match-win probability. Historical player and meta win
rates remain percentages; score adjustments are displayed as points.

The current model is `2026-11-24.6`, implemented in the scoring section of
[index.html](index.html). The [review](SCORING_REVIEW.md) records the original
audit; [EVALUATION.md](EVALUATION.md) explains how to test predictions against
future outcomes. The current coefficients are conservative heuristics, not
learned or validated accuracy improvements.

Version `.6` caps the combined enemy probability for each lane at 100%, so
overlapping flex-pick guesses cannot multiply that lane's matchup adjustment.
The score, advisories and displayed lane probabilities use the same weights.

Version `.5` requires role evidence by default in both manual selection and
optimization. Unsupported roles require the visible **Allow unproven roles**
opt-in. Scores and the removal of pair bonuses are unchanged from `.4`.

Version `.4` searched every eligible manual pick and removed additive shared-win
pair bonuses. Those matches already affect personal records; summing their ten
champion pairs and ten player pairs counted correlated success again. The prior
pair model is retained only as a prospective comparison, not as score points.

## Composition score

```text
raw = mean(individual score + draft matchup residual for each slot)
score = 100 × clamp(raw, 0.05, 0.95)
```

Clamping is a display/model bound, not probability calibration. Team-profile
advice (damage mix, frontline, CC, shielding) does not alter the score.
The raw value is retained before clamping so ablations and single-swap
comparisons do not lose differences at the display limits.

## Relative grade and draft answers

The relative grade holds the **same five players and role assignments** fixed.
For each unlocked slot, it checks every eligible candidate from that player's
filtered role pool, changing one champion at a time. It scores each resulting
composition with the complete formula above, including known draft matchups,
using the raw value before display limits.

The label reports either the best available one-swap improvement in points or
**Best among checked single swaps**. Improvements below 0.05 points are treated
as a display tie. Fully locked drafts and empty alternative pools receive
explicit labels. This is a local comparison within the checked pool, not a
percentile, letter grade, global optimum or probability of winning. Two changes
made together can improve a composition even when no single swap does.

**Best answers** uses the same replacement ranking when all five picks are
complete. For incomplete compositions it uses the slot score and says so.
Locks, candidate filters, unavailable picks and distinct-champion requirements
still apply. A matchup's observed win rate and sample size provide context;
they do not replace the composition objective.

The separate evidence label uses the smallest observed role sample among the
five picks: below 5 games is **Limited role evidence**, 5–19 is **Some role
evidence**, and 20 or more is **Larger role sample**. Incomplete or unverified
history is flagged separately. These are sample descriptions, not calibrated
confidence levels or a measure of how likely the top recommendation is best.

## Individual record and prior

For a player on a champion in an assigned role:

```text
effectiveGames = roleGames + offRoleWeight × (championGames − roleGames)
effectiveWins  = roleWins  + offRoleWeight × (championWins − roleWins)
shrunkRecord   = (effectiveWins + 10 × prior) / (effectiveGames + 10)
```

Off-role weight is 0.3 normally and 0.15 with Role WR enabled. Ten effective
personal games give the personal record and meta prior equal weight.

The prior is OP.GG's current-patch NA Emerald+ Solo/Duo champion win rate in
the assigned role when at least 100 meta games are available. Missing role
coverage falls back to the champion's overall win rate; missing champion data
falls back to 50%. No extra penalty is applied merely because the source omits
a lane. Cards label each fallback. Role evidence is a separate, explicit eligibility
filter; an overall-meta fallback does not establish that a role is supported.

Both local fetch and worker explicitly request the configured tier, defaulting
to `emerald_plus`. Exact `emerald` is a different population. Flex-only changes
personal records, not the Solo/Duo meta source. The UI shows the statistical
patch and analysis timestamp separately from personal-data freshness.

```text
individualScore = shrunkRecord − offRolePenalty + roleComfort
```

The off-role penalty remains 0.04 when the player has champion history but
less than 25% is in this role. This is a heuristic needing ablation validation.

Mastery contributes **zero additive points**. It remains an explicit eligibility
filter and familiarity readout. Removing a universal +3-point bonus avoids
assuming mastery adds predictive value beyond the player's observed record.

## Role comfort

```text
n = total observed role-assigned games for this player in the selected queue view
share = fraction played in this role
roleComfort = 0.12 × (share − 0.2) × n / (n + 20)
```

The sample-size factor prevents a tiny history from receiving the full
role-share adjustment. It is not a calibrated confidence interval. The
unshrunk limit remains +9.6 points for an exclusively single-role player, so
comfort still needs evaluation against a no-comfort baseline.

## Draft matchup residual

For each possible lane opponent with at least 20 matchup games:

```text
p = our champion's role-meta win rate
q = enemy champion's role-meta win rate
expected = p × (1−q) / (p × (1−q) + q × (1−p))
residual = (observedWinRateAgainstEnemy − expected) × games / (games + 50)
adjustment += laneProbability × clamp(residual, −0.03, +0.03)
```

Each enemy's initial lane distribution incorporates role-meta evidence,
personal role coverage and known lane claims. For each lane, divide these
weights by `max(1, sum of all enemy weights for that lane)`. This prevents
multiple flex-pick guesses from implying more than one opponent in a lane.
The denominator includes every enemy pick, including those without a loaded
matchup table. Missing probability mass is not filled in. A unique manual role
assignment remains certain and excludes that lane from the other enemies.
The combined slot adjustment is therefore bounded at ±3 points. This is a
conservative consistency constraint, not a fitted joint role-assignment model.
The `previous` pre-review comparison retains its historical independent lane
weights; the consistency cap applies to production and its current ablations.

The expectation uses the difference in standalone champion log odds. It
centers matchup effects on baseline strength instead of counting every
above-50% matchup as an extra advantage. This is still a heuristic rather
than a fitted interaction model. Lane probabilities support flex picks and
manual role assignments. Counter data is cached by region, tier, patch,
champion and role.

An **Unfavorable matchup estimate** advisory requires a lane probability of at
least 50%, at least 20 matchup games, a negative shrunk residual, and the upper
end of a 95% Wilson interval for our observed matchup win rate below the expected
baseline. That interval covers the observed proportion only: it does not include
uncertainty in the meta baseline, role assignment or opponent selection.
A flag alone never changes the score or removes a pick. Explicit bans, enemy
picks, fearless exclusions and manual avoidance affect availability.

## Shared wins and legacy synergy

Production adds **zero champion-pair or player-pair bonus**. Each slot's personal
record still contains its actual shared matches, but slot scores are averaged
rather than accumulating a bonus for every teammate pair. This removes the
extra pairwise multiplication; it does not make teammates' histories independent
or establish causal chemistry.

The old `.3` pair formulas are retained exclusively for evaluation:

```text
expected = mean(overall champion meta WRs)
championPair = (shrunk(wins, games, K=100, prior=expected) − expected)
              × 0.4 × games / (games + 10)
playerPair = (shrunk(weightedWins, weightedGames, K=20, prior=0.5) − 0.5)
             × 0.4 × 0.25 × weightedGames / (weightedGames + 10)
```

Champion pairs are pilot-attributed. Player-pair role combinations receive full
weight in the assigned roles and 0.3 elsewhere (zero elsewhere in strict mode).
The historical 0.25 discount did not deduplicate overlapping evidence.

Pregame records save the old sums as `legacyPairAdjustments` and frozen score
variants `legacyPairSynergy`, `halfLegacyPairSynergy`, `legacyChampionOnly` and
`legacyPlayerOnly`. Evaluation compares these with the current score on the
same actual matches, with one observed outcome per match. Reintroducing synergy
requires a model that controls for individual strength and repeated match
identity, followed by validation on later matches.

## Filters and search

The **Games in role** range counts observed player × champion × assigned-role
games. Both minimum and maximum apply to the active queue view. Weighted
off-role games do not satisfy this filter. Old all-role slider settings reset
rather than changing meaning silently.

Mastery and role-game ranges, bans and draft exclusions are hard candidate
filters. Manual selection, full search, assigned-role search, worst search and
single-swap recommendations share the same pool: the union of every champion
in the player's history and mastery data, filtered by the active constraints.
Entries absent from the loaded champion catalog are excluded, including
game-mode variant mastery IDs that cannot be selected in the ranked draft.
There is no eight-pick cap, 15-pick comparison cap, mastery-list cutoff, or
five-game preference that hides otherwise eligible choices.

By default, picks require either at least ten personal games on that champion in
that role, or meta coverage in that role with at least 100 games and 10% role
share. This reuses the existing role-support thresholds as a visible shared
eligibility rule; it is not a calibrated accuracy threshold. A three-game Leona
support record can qualify through meta coverage, while a Thresh support record
alone does not qualify Thresh top.

**Allow unproven roles** defaults off and applies to both the picker and every
search. Enabling it permits unsupported roles within the other filters. Those
picks show an exploratory warning. No-repeat searches may return fewer rows
when supported choices run out; they never silently relax the role requirement.
Missing meta requires personal role evidence or the same explicit opt-in.
A selected pick outside current filters stays visible as a disabled option with
a warning. Explicit draft locks preserve that already-selected pick unless it
is unavailable or explicitly avoided; locks do not silently change filters.

Full search enumerates all included five-player squads and role assignments.
Assigned-role search holds the five players and roles fixed. Both use additive
optimistic branch bounds to find the highest raw scores across all eligible
picks, enforcing distinct champions and locks. Worst search uses the same pool
and constraints in reverse. Role share and champion ID break candidate ties,
without changing score points. No-repeat lists exclude prior player/champion
choices between rows while retaining explicit locks.

Cards show observed role games, effective games, prior source and weight, role
comfort, off-role penalty and draft residual. Sample labels describe evidence
size, not statistical certainty. Empty searches identify constrained roles
where possible and suggest changing filters without relaxing them silently.

## History and evaluation

The worker serializes writes through `StateHub`. Its compact match ledger
supports rolling expiry and deterministic aggregation under the configured
queue/window policy. Local fetch, seed and profile scripts use the same policy.
Legacy aggregates stay marked incomplete during reconstruction; missing games
and failed requests remain visible rather than being declared complete.

The `predictionRecord` hook constructs pregame scores and comparison variants.
Cloudflare runs the same scoring source on complete live drafts from the League
bridge, even with the website closed. It uses fixed standard settings and a
frozen published data snapshot, retaining computation time and source hash.
Background retries preserve the original score. Browser prediction uploads are
disabled. Cloudflare collects matching Riot outcomes separately; see EVALUATION.md
for collection limits, settings and authenticated export. The evaluator requires
actual future match outcomes, checks
identity/composition/queue/timing, avoids duplicate match counts, and reports
Brier score, log loss, ROC AUC and calibration bins on chronological splits.

Exports retain the separate unclipped component means/sums, raw total, grade
comparison, up to three one-swap alternatives and optional pregame side. Saved
alternatives have no observed outcomes. The current-score ablations remove
terms from the raw total before applying the display clamp. Additional comparisons
include no matchup, no role penalty, 20/40-game prior strengths, a player-record
baseline and the legacy pair variants described above. Compatibility variants
`noSynergy`, `noChampionSynergy`, `noPlayerSynergy` and `synergyHalf` now equal
the current score because production pair contributions are zero.
These are frozen diagnostic comparisons, not endorsed replacements.

The offline validation script can fit a small regularized logistic model on
earlier real outcomes and a separate sigmoid calibration on validation data.
It evaluates held-out outcomes and reports missing-data/readiness failures;
it does not install fitted weights in the app. A hierarchical model and learned
pilot-adjusted synergy remain future work. Existing coefficients and new
alternatives have no claimed accuracy gain without prospective evidence.
