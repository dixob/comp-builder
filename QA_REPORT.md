# UAT and QA report — 2026-11-25

## Result

Covered browser workflows and automated checks pass after the fixes in this workspace.
Validation used the Codex in-app browser against the local app, the connected live API,
and the checked-in Riot/OP.GG records. This report records predeployment validation;
subsequent deployment status is recorded separately in the release history.

- **73 JavaScript tests passed**, including browser/worker scoring parity and generated-source freshness.
- **41 Python tests passed**; Python compilation and `git diff --check` also passed.
- Independent checks covered **80 optimized boards** across all-ranked/Flex and normal/Role WR settings.
- Lane-probability checks covered **307 recorded enemy teams** and **173 single-champion priors**.
- Browser layouts inspected at **390×844**, **768×1024**, and **1440×1000**.

No fictional match histories or model-authored outcomes were generated. Regression cases
use existing recorded data and mechanical boundary, storage, or transport probes.

## Defects fixed

| Area | Reproduced problem | Resolution |
|---|---|---|
| Matchup scoring | Independent enemy-lane estimates could exceed 100% in a lane; a recorded case reached 282.26%, permitting up to 8.47 slot points despite the nominal 3-point cap. | Normalize excess lane mass across all enemies. Preserve missing evidence. Scoring, warnings, and displayed probabilities share the same weights. |
| Ranked results and locks | Choosing a Best answer, or moving a locked role, left other cached result tabs able to overwrite the lock. | Invalidate and regenerate all relevant ranked results under the new locks. |
| Champion eligibility | Allow unproven roles admitted 14 recorded game-mode mastery IDs absent from the champion catalog. | Shared candidate pool requires a catalog entry. |
| Manual enemy draft | Two enemies could be assigned the same certain lane; a sixth enemy affected scoring despite not fitting the map. | Unique lane assignments, swaps for existing lane locks, a five-pick limit, and clear input feedback. |
| Mixed live/manual draft | A new live five-pick draft combined with five manual entries into ten effective enemies. | Live picks take precedence; manual guesses fill only remaining slots. Conflicting manual bans and stale lane locks are removed. |
| Removing enemy picks | Readding a removed enemy silently restored its old lane lock. | Clear manual lane state on removal. |
| Empty No repeats search | Empty results threw a TypeError when reading the first composition. | Empty lists render filter guidance without relaxing constraints. Browser reproduced before and retested after. |
| Saved settings | Malformed Fearless JSON could prevent initialization; invalid numeric filters produced unusable pools; minimum role games 31 reloaded as 30. | Validate persisted data and preserve reachable filter bounds. |
| Live update ordering | Late polling responses could overwrite newer WebSocket state or apply after Draft was disabled. | Reject stale timestamps and obsolete evaluation updates. |
| API fallback | A stalled live request could block startup indefinitely. | Bounded live/static requests, including body parsing; bounded refresh requests. |
| League bridge | Failed draft-close uploads could terminate the bridge; remote failures unnecessarily reset the local League connection. | Retry uploads and retain session state until acknowledged. |
| Worker errors | Rejected asynchronous route handlers bypassed the outer error handler. | Await delegated handlers so failures return JSON with CORS. |
| Accessibility and presentation | Result loading, sorting, profile links, and history expansion lacked keyboard controls; mobile explanation lines ran together. | Keyboard-operable controls, focus restoration, sort/expanded semantics, and preserved explanation line breaks. |
| Score explanation | “Individual baseline” included matchup adjustments while its tooltip omitted them. | Label it “Average slot score” and explicitly include known matchup residuals. |

Scoring version is now **2026-11-24.6**. The generated worker scorer matches the website.
The original-model comparison retains its historical lane inference. Scoring documentation
and the example evaluation plan were updated for the new version.

## Browser acceptance coverage

| Workflow | Observed result |
|---|---|
| Live startup and freshness | Loaded ten players, current history, patch 16.23, Emerald+ NA meta, and separate personal/meta timestamps. |
| Full optimization | Returned complete compositions with distinct players/champions and ranked alternatives. |
| Score reconciliation | Default live result was 73.4/100; displayed slot scores were 73.1, 72.2, 70.2, 74.8, and 76.6. Their rounded mean is 73.38, consistent with the headline. |
| Evidence explanations | Displayed observed role games, weighted games, prior weight/source, comfort, penalty, and matchup residual. |
| Queue/role settings | Flex-only and Role WR changed the relevant records/scores; filters and header state remained synchronized. |
| Fixed-role and worst searches | Fixed-role optimization and invalid-squad guidance worked. Worst results were ordered from lowest score upward. |
| Ranked result selection | Mouse and Enter loaded results; a Best-answer lock remained intact when a later ranked result was loaded. |
| Empty and incomplete states | Duplicate players and incomplete boards withheld the score. Tight filters with No repeats showed explicit empty-pool guidance and no new exception. |
| Filter persistence and unproven roles | Minimum role games 31 survived reload. Unsupported roles were opt-in. No missing-catalog `#600xx` options appeared. |
| Bans and role locks | Banning Garen removed it from eligible picks and changed the score. With Lock roles enabled, all five player assignments stayed fixed. |
| Enemy picks and lanes | Enter committed picks; inferred lanes and manual lane changes updated the map. Conflicting manual assignments no longer produced two certain enemies in one lane. |
| Invalid draft inputs | A sixth enemy was rejected with five visible pins and an unchanged score. Unknown champion text produced actionable feedback. Clear removed the manual draft. |
| Best answers | Choices used full-composition deltas and included observed matchup rates/sample sizes. A higher raw matchup win rate did not automatically outrank stronger personal evidence. |
| Matchup advisories | Darius produced an unfavorable estimate for Garen. Keep dismissed the warning without changing the score; Swap it replaced the avoided pick. |
| Profiles | Player switching, Flex-only records, evidence tables, and keyboard sorting worked. |
| Match history | Expanded both teams' scoreboards, loaded another 25 games, and toggled details with Enter/Space. Remakes were identified separately. |
| Leaderboard | Metric sorting, role filters, and keyboard navigation into a player's profile worked. |
| Fearless | Enable/disable and visible state worked. Actual exclusion after a newly completed game was not exercised live. |
| Compy chat | The live product correctly answered that 73/100 is not a 73% win probability. |
| Responsive layouts | Desktop, tablet light mode, and phone cards/expanded explanations were inspected. Wide data tables/navigation use their scroll containers. |
| API unavailable | A temporary local test entry point returned an unavailable API. Static data loaded, optimization worked, Refresh was hidden, and the score explicitly flagged incomplete/unverified history. The temporary entry point was removed. |

The console error captured during the original empty-results reproduction did not recur
after the fix. An initial data refresh replaced a browser automation input target once;
the input test succeeded after the refresh completed. This was not treated as a scoring failure.

## Scoring assessment

The arithmetic, eligibility, constraints, displayed breakdowns, optimizer ranking, and
browser/worker parity are consistent within the covered tests. Best-scoring boards had no
improving eligible single swap. The lane normalization fixes a concrete overcounting
problem; it does not claim improved predictive accuracy.

Remaining modeling limits:

- Scores are recommendation heuristics, **not calibrated win probabilities**.
- Independent optimized boards ranged approximately 73.82–74.51 at the top and
  35.51–36.58 at the bottom across the four recorded-data configurations.
- Some top picks have only 11–21 observed role games. Selecting the maximum over many
  candidates can favor unusually successful small samples; shrinkage does not prove
  that those rankings generalize.
- Role comfort, the off-role penalty, meta population transfer, and matchup residuals
  still require prospective evaluation. Team-profile advice does not affect the score.
- Normalized enemy weights are conservative heuristic weights, not a fitted joint
  distribution over legal five-role assignments. Unknown lane evidence stays unknown.
- The local evaluation export contains **zero pregame prediction/outcome pairs**.
  It cannot establish accuracy, calibration, or improvement over a baseline.
- Live history was complete with zero pending work during this run. The checked-in
  fallback is separately marked incomplete: 1,180 cached matches and ten pending items.

## Limits and release status

The actual League client was not in champ select. End-to-end live picks, a completed
game's automatic evaluation capture/result matching, Cloudflare alarms, network outage
recovery on a real client, and real-game Fearless exclusions remain unverified live.
Those code paths have automated coverage, but mocks do not replace that acceptance run.

This was one Codex browser engine, not a cross-browser or physical touch-device test.
The frontend and worker require the normal release process before users receive these
fixes. No deployment or production reseed was performed as part of the QA run itself.

## Re-run

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/build_worker_scoring.py --check
python3 -m py_compile history_policy.py fetch_data.py build_seed.py compute_profiles.py lcu_bridge.py scripts/evaluate_predictions.py scripts/validate_scoring_models.py
git diff --check
```
