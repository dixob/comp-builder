# Comp Builder

Team composition optimizer for a fixed group of League of Legends players.
It combines personal champion/role records with a current-patch role-meta prior,
role comfort, and available draft matchup evidence. Mastery and role-game filters
control eligibility. The optimizer and manual picker use the same complete pool,
including low-sample picks with role support. Unsupported roles require the
shared **Allow unproven roles** opt-in, which defaults off.

Shared matches already contribute to personal records. Additional champion-pair
and player-pair win-rate bonuses are excluded from production scoring to avoid
counting that team success repeatedly; the old bonuses remain offline comparisons.

The exact weights, shrinkage constants, and every adjustment term are
documented in [SCORING.md](SCORING.md).

A **Team profile** panel also reads the comp's shape — damage mix
(physical/magic/true), frontline, and crowd control — from per-champion
combat averages over the cached matches (`compute_profiles.py`). It's
advisory only and never feeds the composition score.

Default recommendations require ten personal games in the role or qualifying
role-meta coverage (100 games and 10% role share). Mastery and role-game ranges
still apply. Experimental roles remain available through the explicit opt-in;
manual picks and the optimizer always share the same eligibility rules.

**[Open the app](https://dixob.github.io/comp-builder/)** — pick who plays
which role and let it optimize the champions, or let it optimize the full
role assignment.

In Draft mode (bans and enemy picks entered by hand, or streamed live from
champ select by `lcu_bridge.py`) the composition score becomes a ticker: the
number animates on every draft event, a delta chip attributes each move to
what caused it ("▼ −6.9 pts · Aurora banned"), and a sparkline tracks the whole
draft — hover a dot for the event behind it. Each enemy pick also gets a
**Best answers** row: eligible replacements ranked by the full composition
score when all five picks are set, or by slot score while the draft is incomplete.
Matchup win rates and sample sizes remain visible; tapping an answer locks it in.

## Refreshing the data

```
cp config.example.json config.json   # add your Riot API key + accounts
python3 fetch_data.py                # player mastery + match history (+ champion profiles)
python3 fetch_meta.py                # current-patch meta win rates
```

Commit the regenerated `data/*.json` and push. `config.json` is gitignored —
never commit an API key.

## Live mode (Cloudflare Worker)

The site can instead load from a free-tier Cloudflare Worker that refreshes
incrementally — a **Refresh** button appears in the header and resumes
persisted match discovery and ingestion. A single Durable Object owns the
history; pending work continues in bounded batches, including background
alarms. OP.GG meta and Data Dragon names refresh on a daily cron. The static
`data/*.json` files remain the fallback whenever the worker is unreachable.

One-time deploy (needs a Riot **Personal** API key — dev keys expire daily):

```
cd worker
npx wrangler login
npx wrangler kv namespace create KV        # paste the printed id into wrangler.toml
npx wrangler secret put RIOT_API_KEY
npx wrangler secret put ADMIN_TOKEN        # any random string; guards /seed
npx wrangler deploy                        # prints your workers.dev URL
```

Then seed it from the local data and point the front-end at it:

```
python3 build_seed.py
curl -X POST "https://<your-worker>.workers.dev/seed" \
     -H "x-admin-token: <ADMIN_TOKEN>" --data-binary @worker/seed_state.json
```

Set `WORKER_URL` in `index.html` to the worker URL, commit, push. Re-seed
the same way if you ever change the roster or want to reset state.

## Scoring and validation

The headline is a **composition score out of 100**, not a calibrated win
probability. Current tuning uses a 10-game Emerald+ role prior and no additive
shared-win synergy bonus. Mastery gates familiarity rather than adding score points;
role comfort is shrunk for small samples. The relative grade compares eligible
single-pick alternatives for the same squad and roles; evidence strength is
shown separately. These labels do not establish a probability of winning.
See [SCORING.md](SCORING.md) for formulas and [SCORING_REVIEW.md](SCORING_REVIEW.md)
for the historical audit.

The **Games in role** range counts this player's games on the champion in the
assigned role, within the selected queue view. Both bounds are hard filters.
Cards explain the role sample, prior and score adjustments. The optimizer
searches all eligible manual picks with the same filters and draft constraints.

With the **League bridge running**, complete live drafts automatically save
pregame scores to Cloudflare for evaluation, even when the website is closed.
The worker calculates scores from actual client picks and its published player
snapshot using the same scoring source as the website. Background collection
uses fixed defaults (all ranked history, standard role weighting), independent
of browser preferences. There are no recording buttons or browser uploads.
The worker collects matching Riot results afterward. Games without a pregame
capture are not reconstructed after the fact.

Developers can download the collection with `python3 scripts/export_evaluation.py`
using the existing admin token. Freeze a queue-specific evaluation plan before
outcomes; see [EVALUATION.md](EVALUATION.md). Collection does not itself establish
an accuracy gain.

The offline tools compare recorded scores and can fit a small regularized model
on earlier outcomes, with separate validation and untouched test periods.
Missing features and incomplete history remain visible. Fitted weights are not
automatically installed in the app. See [EVALUATION.md](EVALUATION.md) for the
plan, matching rules, readiness requirements and CLI.

## Reliable live history

The `StateHub` Durable Object is the sole owner of live roster state. Refresh,
seed and scheduled meta updates are serialized there; KV supplies published
snapshots. The first access backs up the legacy state privately before adopting
it. Do not update the KV `state` key directly after this migration.

Refresh persists pending IDs and per-player discovery progress. It retrieves
pages across the configured window, resumes after failures, and reports when
more work remains. Legacy aggregates stay visibly incomplete while raw match
records are reconstructed; a missing Riot response is not silently treated as
a completed migration.

New local seeds include compact match records and the queue/window policy.
Local fetching, seed rebuilding and combat profiles apply the same policy:
`queue: "ranked"` means Solo/Duo and Flex (420/440), and
`max_match_age_days: 365` is a rolling year (`0` disables the age cutoff).
Historical records outside that policy are excluded from scores, not erased
from the local raw cache. Rebuild seeds with `python3 build_seed.py`; the large
`worker/seed_state.json` artifact is gitignored.

The worker's new Durable Object migration must be deployed together with its
updated configuration. Keep a private backup before replacing any production
seed. A deployment/reseed is separate from running the tests below.

## Shared background scoring

`python3 scripts/build_worker_scoring.py` generates the static worker scorer from
`index.html`. Run it after scoring changes. Wrangler's build hook checks that the
generated file is current; parity tests compare browser and worker outputs.
No runtime code downloads or `eval` are used.

## Checks

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m py_compile history_policy.py fetch_data.py build_seed.py compute_profiles.py scripts/evaluate_predictions.py scripts/validate_scoring_models.py
```

Tests use recorded Riot/OP.GG examples and mocked transport/storage. They
verify implementation behavior; they do not establish improved predictive
accuracy. That requires pregame records and later observed outcomes.
