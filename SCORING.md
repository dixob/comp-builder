# Composition scoring

Compy ranks candidate compositions with a **score out of 100**. It does not
estimate a calibrated match-win probability. Historical player and meta win
rates remain percentages; score adjustments are displayed as points.

The current model is `2026-11-24.3`, implemented in the scoring section of
[index.html](index.html). The [review](SCORING_REVIEW.md) records the original
audit; [EVALUATION.md](EVALUATION.md) explains how to test predictions against
future outcomes. The current coefficients are conservative heuristics, not
learned or validated accuracy improvements.

Version `.3` keeps those numerical weights. It makes draft recommendations use
the full composition objective, replaces absolute score verdicts with a bounded
single-swap comparison, separates evidence labels, and records raw components
for prospective model validation.

## Composition score

```text
raw = mean(individual score + draft matchup residual for each slot)
      + sum(champion-pair and player-pair adjustments over all ten pairs)
score = 100 × clamp(raw, 0.05, 0.95)
```

Clamping is a display/model bound, not probability calibration. Team-profile
advice (damage mix, frontline, CC, shielding) does not alter the score.
The raw value is retained before clamping so ablations and single-swap
comparisons do not lose differences at the display limits.

## Relative grade and draft answers

The relative grade holds the **same five players and role assignments** fixed.
For each unlocked slot, it checks up to 15 candidates from that player's filtered
role pool, changing one champion at a time. It scores each resulting composition
with the complete formula above, including all pair adjustments and known draft
matchups, using the raw value before display limits.

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
a lane. Cards label each fallback. Role viability is a separate eligibility
preference, not inferred from that fallback alone.

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

## Synergy

Pair adjustments remain strongly shrunk and now use a common scale of 0.4,
down from 0.5. Both positive and negative effects are 20% smaller.

Pilot-attributed champion-pair records count only those two players on those
two champions on the same team:

```text
expected = mean(overall champion meta WRs)
adj = (shrunk(wins, games, K=100, prior=expected) − expected)
      × 0.4 × games / (games + 10)
```

Player-pair records count games in the assigned role combination fully, and
other role combinations at 0.3 (zero in strict Role WR mode):

```text
adj = (shrunk(weightedWins, weightedGames, K=20, prior=0.5) − 0.5)
      × 0.4 × 0.25 × weightedGames / (weightedGames + 10)
```

The 0.25 factor reduces overlap among ten pair rows from the same five-stack.
It does not eliminate correlated evidence or identify causal chemistry. The
champion-pair expectation also does not control for pilots or assigned roles.
These limitations remain visible in the review; the prospective log includes
a no-synergy comparison instead of asserting that synergy improves accuracy.

## Filters and search

The **Games in role** range counts observed player × champion × assigned-role
games. Both minimum and maximum apply to the active queue view. Weighted
off-role games do not satisfy this filter. Old all-role slider settings reset
rather than changing meaning silently.

Mastery and role-game ranges, bans and draft exclusions are hard candidate
filters. Normal and worst-comp fallbacks stay inside them. A currently chosen
manual pick can stay visible outside the role-game range with a warning;
explicit draft locks remain manual constraints.

Role viability prefers a personal role sample of at least ten games or a meta
role with at least 100 games and 10% role share. Normal search prefers viable
picks with at least five games, then viable picks, then other eligible picks.
The last fallback can include off-meta choices. Strict mode uses in-role games
for the five-game preference; otherwise it uses all champion games.

Both full and assigned-role search consider up to **eight candidates per
player/role**. Full search uses optimistic branch bounds to avoid unnecessary
combinations. It reports the best found in that pool, not a global optimum over
every champion. Role share breaks equal scores lexicographically; it no longer
adds an undisclosed two-point candidate-order bonus. Worst-comp search remains
a deliberately limited candidate search too.

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
Complete live drafts automatically upload those snapshots while the website is
open in Draft mode and the League bridge is running. Manual board changes are
excluded. Cloudflare stores the server receipt time, deduplicates each draft and
model, and collects matching Riot outcomes separately. There are no recording
buttons; see EVALUATION.md for collection limits and authenticated export. The evaluator requires actual future match outcomes, checks
identity/composition/queue/timing, avoids duplicate match counts, and reports
Brier score, log loss, ROC AUC and calibration bins on chronological splits.

Exports retain the separate unclipped component means/sums, raw total, grade
comparison, up to three one-swap alternatives and optional pregame side. Saved
alternatives have no observed outcomes. The current-score ablations remove
terms from the raw total before applying the display clamp. Additional comparisons
include no matchup, no role penalty, each synergy type removed separately,
half synergy, 20/40-game prior strengths and a player-record-only baseline.
These are frozen diagnostic comparisons, not endorsed replacements.

The offline validation script can fit a small regularized logistic model on
earlier real outcomes and a separate sigmoid calibration on validation data.
It evaluates held-out outcomes and reports missing-data/readiness failures;
it does not install fitted weights in the app. A hierarchical model and learned
pilot-adjusted synergy remain future work. Existing coefficients and new
alternatives have no claimed accuracy gain without prospective evidence.
