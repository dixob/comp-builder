# Evaluating Compy predictions

Complete live drafts automatically save pregame scores for evaluation. No manual
recording is needed. The evaluator joins these decisions to real Riot match-v5
outcomes; it never reconstructs past predictions from today's player aggregates.

## Automatic collection

Keep the **League bridge running** during champ select. The website can be closed;
Draft mode and browser preferences have no effect on collection. No bridge
update is required. Both teams need five distinct picks, and all five allied
players and roles must be recognized. Unknown teammates/roles, incomplete or
stale feeds, and games without bridge observations are not captured.

DraftHub schedules a durable alarm on a complete draft. It freezes the last
published player/meta snapshot, fetches up to 15 relevant matchup tables with
three-second network timeouts, and runs a static scorer generated from the
website source. Missing or incompatible matchup tables are recorded explicitly.
If the draft closes or changes during those reads, the unfinished capture is
abandoned. Computation time and the player/meta source timestamps are retained.

The `server-standard-v1` policy uses all ranked history (`flexOnly: false`),
standard role weighting (`strictRole: false`) and the website's default candidate
filters. Actual client picks are scored even when those defaults would not
recommend them. Freeze this policy in collection notes; do not mix it with old
browser records or different settings when evaluating one configuration.

Predictions are frozen in durable storage before delivery to StateHub. Retries
reuse the original score and computation timestamp, including when the draft
has since closed. Receipt time may be later; no retry recomputes against later
outcomes. A source hash ties each record to the generated scoring implementation.
First observation for an unchanged draft wins; changed allied picks, roles or
enemy picks may replace it with another pregame observation. This is not a promise
to capture the final instant of champ select.

Public prediction uploads are disabled. An internal Durable Object route stores
worker-computed records; authenticated exports remain available. The bridge feed
itself is still unauthenticated, so observed identities and timing must still be
checked against real Riot results. Older `live-draft-browser` exports remain
readable; new records use `live-draft-worker` provenance.

After capture, durable alarms refresh match history about every five minutes for
24 hours (subject to Riot rate limits/backfill). The worker retains matching raw
compact Riot evidence separately from predictions. Matching requires identical
players, roles, champions, queue, all five enemy champions and a start strictly
after computation within 15 minutes for automatic records (manual records retain
the six-hour maximum). This reduces false matches after dodges or re-queues. Later refreshes also reconcile delayed history. Dodges and missed or
ambiguous matches remain visible; the offline evaluator rejects ambiguous matches
and duplicate match counts. No record is labelled a loss simply because no result
was found. Stored outcome evidence survives rolling history expiry.

Storage is capped at 1,000 draft/model records; it stops accepting new records
rather than silently deleting old evidence. Export and arrange administrative
archival before reaching the cap. Records are not exposed by public data routes.

Download records and real outcome evidence using `admin_token` in ignored
`config.json`, or the `COMPY_ADMIN_TOKEN` environment variable:

```sh
python3 scripts/export_evaluation.py --output evaluation-output
python3 scripts/evaluate_predictions.py evaluation-output/records.json \
  --matches evaluation-output/matches --plan /absolute/path/compy-plan.json \
  --split validation --output evaluation-output/validation.json
```

The export uses authenticated `GET /evaluation` with pagination. `records.json`
contains pregame snapshots, `matches/` contains actual Riot evidence, and
`collection.json` shows matched IDs (including empty or ambiguous associations).
Export files are ignored by Git. Freeze a collection plan before looking at
outcomes; automatic capture does not automatically train or promote a model.

## Optional developer capture

1. Freeze the collection plan below before collecting outcomes. Set the intended
   queue and roles, and choose the final five players and champions before the
   game begins. If the composition changes, capture it again before game start.
2. In Chrome DevTools on the app, run the following command. Save the copied JSON
   to a file outside the repository. This captures the current score immediately;
   it does not save anything in browser storage. Use `100` for blue side, `200`
   for red, or leave `null` when unknown.

   ```js
   copy(JSON.stringify({
     schemaVersion: 1,
     records: [predictionRecord(
       slots.map((slot, i) => ({...slot, role: ROLES[i]})),
       new Date().toISOString(),
       null
     )]
   }, null, 2));
   ```

3. Complete the match and refresh the roster data as usual. Raw Riot match JSON
   must be available in `data/matches/` for offline evaluation; the live worker's
   aggregate counters alone are not enough. Combine captures into one `records`
   array without changing their timestamps, scores, or evidence.
4. Use the fixed chronological boundaries in the plan: earlier games for training,
   the next interval for validation, and the latest interval as an untouched test
   set. Do not reconstruct missing pregame captures after a match.

Records saved with the previous interface are left intact. To recover them in
Chrome DevTools, run `copy(localStorage.getItem("compy.predictions.v1"))` and save
the JSON before clearing browser storage. The evaluator also accepts that array
format.

Do not repeatedly inspect the final test scores while tuning. Tune using `--split validation`; use the test period once when the design is fixed. The evaluator does not fit or tune anything automatically.

## Freeze a collection plan

For the next **100 real games**, use collection as a pilot to check matching,
coverage and obvious calibration problems. One hundred games is an operational
target, not a claim of enough statistical power to detect a small improvement.
Record the final played composition consistently, including losses and drafts
that do not follow the recommendation. Unplayed alternatives have no observed
outcome.

Before collecting outcomes, copy [evaluation-plan.example.json](evaluation-plan.example.json)
and save a plan such as the following JSON. These dates
and comparisons are an example; choose the queue, model, chronological dates
and a practical improvement threshold before inspecting results. Freeze the
file for that collection period.

```json
{
  "schemaVersion": 1,
  "validationFrom": "2027-01-01T00:00:00Z",
  "testFrom": "2027-02-01T00:00:00Z",
  "testUntil": "2027-03-01T00:00:00Z",
  "queue": 440,
  "modelVersion": "2026-11-24.3",
  "capturePolicy": "server-standard-v1",
  "comparisonScores": ["current", "noSynergy", "shrunkPersonal", "metaOnly", "constant50"],
  "primaryMetric": "logLoss",
  "requireCompleteHistory": true,
  "notes": "Next 100 eligible Flex games; frozen before outcomes."
}
```

Required fields are `schemaVersion: 1`, `validationFrom`, `testFrom`, a positive
integer `queue`, a nonempty `modelVersion`, unique `comparisonScores` including
`current`, and `primaryMetric` (`logLoss` or `brier`). Optional fields are
`minimumPracticalImprovement` (nonnegative), `requireCompleteHistory`,
`minimumDurationSeconds` (nonnegative), an exclusive `testUntil` timestamp, and
`notes`, and a nonempty `capturePolicy`. The example fixes `server-standard-v1`
to exclude browser or unknown capture settings from comparisons. Unknown fields are rejected to expose misspelled settings. An effect threshold records the decision rule;
it does not establish statistical significance or automatically promote a model.
The evaluator enforces date/cohort filters, not the 100-game collection target;
keep the intended stopping rule in the frozen notes and collection procedure.

```sh
python3 scripts/evaluate_predictions.py /absolute/path/compy-records.json \
  --matches data/matches \
  --plan /absolute/path/compy-plan.json \
  --split validation \
  --output /tmp/compy-validation.json
```

The report includes the plan and its SHA-256 digest over canonical JSON
(sorted keys, compact encoding, UTF-8), so formatting changes do not change the
digest. The plan restricts comparisons to the declared model, actual queue and
scores on the same eligible matches. Missing required scores are reported and
excluded. A duration threshold applies only if declared; it must not be chosen
after seeing which outcomes it removes.

Use the validation period for development and the test period once after the
candidate is fixed. If the pilot yields too few eligible games, extend collection
under a new declared plan rather than changing exclusions or dates to improve
the reported result.

## Run the evaluator

Python 3.10 or newer is sufficient; there are no extra dependencies. From the repository root:

```sh
python3 scripts/evaluate_predictions.py /absolute/path/compy-records.json \
  --matches data/matches \
  --validation-from 2026-12-01 \
  --test-from 2026-12-15 \
  --output /tmp/compy-evaluation.json
```

The example dates are prospective boundaries, not a claim that those outcomes already exist. Choose boundaries appropriate to your collection plan. Date-only boundaries use midnight UTC. Timezone-aware ISO timestamps are also accepted.

`--split test` is the default. `--split train` and `--split validation` select earlier partitions. If matching records exist but boundaries are absent, the evaluator reports the need for fixed boundaries and does not print performance metrics.

Exit codes are:

- `0`: the selected split contains matched games and was evaluated.
- `2`: no matched games, no games in the declared cohort or selected split, or missing split boundaries. These are data-readiness states, not successful accuracy results.
- `1`: malformed input, invalid configuration, or a file error.

The report is printed as JSON and can optionally be written with `--output`.
Without a plan, `--queue 440` restricts the actual matched queue and
`--require-complete-history` excludes records whose history is incomplete or
unknown. Explicit dates, queue or completeness arguments that conflict with a
plan are errors.
Older exports remain usable by default; missing provenance must not be silently
treated as complete history.

## Exact matching and exclusions

An eligible outcome requires all five recorded players, champions and assigned roles to appear on one actual team. Player identity uses a recorded PUUID/PUUID history when available, with a case-insensitive Riot ID fallback. The game's queue must match the record: `ranked` accepts 420 and 440; an integer accepts only that exact queue.

The saved timestamp must be **strictly earlier** than `gameStartTimestamp`. When meta analysis/fetch or player-data timestamps are recorded, they must not be later than capture. These checks cannot prove that a manually edited record is authentic; preserve original exports. The game must begin within six hours of capture; `--horizon-hours` can shorten that window but cannot extend it. If the source lacks a reliable start timestamp or five consistent team outcomes, it is not eligible.

Each input record must resolve to exactly one match. More than one eligible match is ambiguous and excluded. Repeated identical export rows are deduplicated by record ID. Conflicting records with the same ID are excluded. If two distinct decisions claim one match, both are excluded rather than counting the same result twice or silently choosing a favorable prediction. Retain only the final intended pregame record in the evaluation input when this happens; preserve the original export as an audit trail.

An optional `matchedMatchId` can disambiguate two otherwise eligible games, but it cannot bypass queue, timing, team or composition checks. Repeated identical raw match files are deduplicated. Conflicting files for the same match ID are excluded.

The report includes exclusion counts. `no_eligible_match` can mean the game has not finished, its raw file is missing, the final draft changed, the queue differs, or the record was captured too late. It does not mean a loss.

## Metrics and comparisons

For each scoring-model version, the evaluator reports:

- Brier score and log loss, treating saved 0–1 heuristic scores as probabilities **for diagnostics only**. Lower is better; this does not establish that the UI score is calibrated.
- ROC AUC for discrimination, with ties handled explicitly; it is unavailable when a group contains only one outcome class. It does not measure calibration or recommendation benefit.
- Reliability bins containing sample count, average predicted score, observed win rate and a 95% Wilson interval for the observed proportion. These intervals do not account for dependence across games or uncertainty in the model.
- Results by actual queue, actual game patch, side and weakest-pick effective sample band (`under_5`, `5_to_19`, `20_plus`, or `unknown`). The game patch comes from the match, not from current meta. The saved meta patch is retained separately.
- Without a plan, a constant 50% baseline and each variant shared by every record in the version's comparison group. Variants absent in some records are listed under `omittedNonCommonScores` instead of comparing different cohorts silently. A plan reports only its declared comparisons on the same eligible cohort.
- Paired differences between the current score and each reference, with descriptive 95% bootstrap intervals when at least two UTC day blocks exist. Whole days are resampled, keeping each actual match as one outcome. Negative differences favor the current score. Dependence across days and small samples can still make these intervals overconfident.
- History-completeness and data-readiness counts, including missing information. Readiness is about the available data, not certification that a model is accurate.

Current browser exports include `current`, `previous`, `metaOnly`,
`shrunkPersonal`, `playerOnly`, `noSynergy`, `noMastery`, `noComfort`,
`noMatchup`, `noRolePenalty`, `noChampionSynergy`, `noPlayerSynergy`,
`priorK20`, `priorK40`, and `synergyHalf`. Some variants may be identical after a
feature is disabled; that is expected. The saved scores must be generated at
capture time. Do not populate missing variants later from updated data.

Different model versions are never pooled into a single “current” metric. A small or empty test split should lead to more prospective collection, not a stronger claim. Do not infer recommendation quality from probability metrics alone: an unplayed alternative still has no observed result.

## Validate a learned alternative offline

`scripts/validate_scoring_models.py` uses the same actual-match joins, frozen
plan and cohort filters. It requires the raw components captured by model
`2026-11-24.3`; it never reconstructs missing features from today's aggregates.
Earlier exports still work with the general evaluator, but cannot supply
uncaptured components for this comparison.

The candidate is a small regularized logistic model fitted on the training
period, with one observed outcome per match. It learns contributions from
personal, meta and player records, role comfort, role penalty, matchup residual,
champion synergy and player synergy. This tests whether the existing signals
help predict outcomes without treating ten pair records as ten independent
wins. It is not a hierarchical player model and does not infer unavailable
opponent skill.

```text
component model = sigmoid(intercept + sum(coefficient[j] × component[j]))
calibratedCurrent = sigmoid(intercept + slope × currentScore), slope >= 0
```

The component names are `personal`, `meta`, `player`, `comfort`, `rolePenalty`,
`matchup`, `championSynergy`, and `playerSynergy`. Training standardization and
coefficient fitting use training data only; calibration standardization and
fitting use validation data only. The nonnegative calibration slope preserves
the current score's ordering. These formulas are schematic: report coefficients
apply to standardized inputs, with their means and scales stored alongside them.

```sh
python3 scripts/validate_scoring_models.py /absolute/path/compy-records.json \
  --matches data/matches \
  --plan /absolute/path/compy-plan.json \
  --split validation \
  --output /tmp/compy-model-validation.json
```

The default `--split validation` evaluates the training-fitted component model
(`trainedComponents`) against the recorded baselines and a smoothed training
win-rate baseline (`trainingBaseRate`). It does not fit a calibrator. Once the model and
settings are fixed, `--split test` also fits a sigmoid calibration of the current
score on the validation period, then evaluates both alternatives on the untouched
test period. Calibration changes the probability scale; it cannot establish that
an unplayed recommendation would improve the outcome.

Freeze CLI settings alongside the plan. Defaults are `--regularization 0.1`, `--min-train 100`,
`--min-validation 50`, and `--min-evaluation 30`. These are operational guards,
not statistical power guarantees. The next-100-game pilot can therefore check
collection before there is enough data for this training/validation/test workflow.
Rows missing components or an explicit pregame capture stage are excluded and
reported. Insufficient eligible rows, a training period without both wins and
losses, or a calibration period without both when requesting test evaluation
produce an `insufficient_data` result and exit code `2`, rather than fitted
accuracy claims. Invalid inputs/configuration use exit code `1`.

Fitting also requires a reliable game-end time before the relevant cutoff.
A game that starts before a split boundary but ends after it cannot contribute
an outcome to the model frozen at that boundary. Evaluation records must have
been captured at or after that model's fitting cutoff. Exclusions remain visible.

Reports include configuration, the plan and input fingerprints. Preserve them
with the original exports and raw match data. No fitted model is automatically
installed in the app, and no accuracy improvement is assumed. Keep the original
test period sealed until the candidate is final; changing features, regularization
or exclusions in response to its results requires a new future test period.
Paired metric differences in this report are **candidate minus current**;
negative Brier/log-loss differences favor the candidate. This direction differs
from the general evaluator's current-minus-reference comparisons.

## Export contract

The wrapper is `{"schemaVersion": 1, "records": [...]}`. Each record contains `id`, timezone-aware `capturedAt`, `modelVersion`, `queue`, `comp`, and `scores`. `comp` has five entries with `riotId`, numeric `championId`, one distinct League role, and optional `puuid`/`puuidHistory`. Scores are finite numbers from zero to one and must include `current`.

Optional provenance includes `meta`, `settings`, `history`, `candidates`, `opponents` and `evidence`. For sample bands, `evidence` can be a list or an object with a `picks` list; each of the five picks supplies `effectiveGames`. The evaluator also accepts `assign` and `puuids` aliases for compatibility.

New records also capture `captureStage: "pregame"`, optional `side` (`100` for
blue, `200` for red, or `null` when unknown), `evaluationCohort`,
`gradeComparison`, and up to three `alternatives`. If a side is supplied, it
must match the actual team. The offline evaluator reports actual side from the
match even when no side was captured pregame; that retrospective field must not
be used to invent a missing pregame model input.

Optional `components`, when present, must contain exactly the eight feature
names above plus `rawTotal`, all finite numbers. Means of the five personal/meta
scores and role adjustments are distinct from sums of the ten pair adjustments.
The `player` feature is the mean of each player's selected-queue overall record
shrunk toward 50% with a 10-game prior. The app's current formula does not add
that separate player baseline to its existing personal score.

Absent optional fields remain compatible with older schema-1 exports. The tools
report unavailable components and unknown/incomplete history instead of filling
them from future information. Saved alternatives are context for recommendation
review, never extra training outcomes.

## Tests

```sh
python3 -m unittest discover -s tests -p 'test_evaluation.py' -v
python3 -m unittest discover -s tests -p 'test_scoring_models.py' -v
```

Tests mechanically project actual checked-in scoreboards and meta statistics into the evaluator's input shape. Test timestamps probe before/at/after boundaries. Those test inputs are not historical predictions and must not be included in an accuracy report. No fictional match outcomes are created.

## Keeping the background scorer aligned

Run `python3 scripts/build_worker_scoring.py` after changing the website scoring
section. The generated `worker/src/scoring.generated.mjs` contains static code
with isolated state per draft, not a second hand-maintained formula. Wrangler
runs `--check` before deployment, and tests compare browser and worker scores,
components, evidence and comparison grades using recorded data.
