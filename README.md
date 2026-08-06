# Comp Builder

Team composition optimizer for a fixed group of League of Legends players.
It blends three signals to estimate a five-man comp's win rate:

- **Personal records** — each player's champion win rates by role and queue
  (solo/flex/clash), pulled from the Riot API
- **Current-patch meta** — per-champion, per-role win rates from ~1.3M ranked
  games (OP.GG), used as the Bayesian prior so small samples don't lie
- **Synergy** — the group's actual shared-game record, measured against
  expectation: player duos, plus pilot-attributed champ pairs (only games
  where those two players piloted those two champions themselves)

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

## Refreshing the data

```
cp config.example.json config.json   # add your Riot API key + accounts
python3 fetch_data.py                # player mastery + match history (+ champion profiles)
python3 fetch_meta.py                # current-patch meta win rates
```

Commit the regenerated `data/*.json` and push. `config.json` is gitignored —
never commit an API key.
