# Comp Builder

Team composition optimizer for a fixed group of League of Legends players.
It blends three signals to estimate a five-man comp's win rate:

- **Personal records** — each player's champion win rates by role and queue
  (solo/flex/clash), pulled from the Riot API
- **Current-patch meta** — per-champion, per-role win rates from ~1.3M ranked
  games (OP.GG), used as the Bayesian prior so small samples don't lie
- **Synergy** — the group's actual shared-game record, measured against
  expectation: player duos (role-weighted — games in the assigned role combo
  count fully, the duo's other games are discounted), plus pilot-attributed
  champ pairs (only games where those two players piloted those two
  champions themselves)

The exact weights, shrinkage constants, and every adjustment term are
documented in [SCORING.md](SCORING.md).

A **Team profile** panel also reads the comp's shape — damage mix
(physical/magic/true), frontline, and crowd control — from per-champion
combat averages over the cached matches (`compute_profiles.py`). It's
advisory only and never feeds the win-rate estimate.

Champions are only pickable where they make sense: the player must actually
play the champ in that role (or the meta must), and a mastery floor filters
out one-game wonders. Role comfort (share of a player's games in each role)
is scored too.

**[Open the app](https://dixob.github.io/comp-builder/)** — pick who plays
which role and let it optimize the champions, or let it optimize the full
role assignment.

In Draft mode (bans and enemy picks entered by hand, or streamed live from
champ select by `lcu_bridge.py`) the estimated win rate becomes a ticker: the
number animates on every draft event, a delta chip attributes each move to
what caused it ("▼ −6.9pp · Aurora banned"), and a sparkline tracks the whole
draft — hover a dot for the event behind it. Each enemy pick also gets a
**Best answers** row: the lane player's strongest meta matchups into it,
drawn from their own filtered champion pool; tapping one locks it in.

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
incrementally — a **Refresh** button appears in the header and pulls the
group's newest games (5 most recent per player, merged into KV-stored
aggregates; ~24 Riot calls worst case, 3-minute debounce). OP.GG meta and
Data Dragon names refresh on a daily cron. The static `data/*.json` files
stay as the fallback whenever the worker is unreachable.

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
