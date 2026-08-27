#!/usr/bin/env python3
"""Fetch champion mastery + match history for the configured accounts and
write data/players.json for the composition builder front-end.

Usage: python3 fetch_data.py            (reads config.json)
Re-runs are cheap: individual matches are cached under data/matches/.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data"
MATCH_CACHE = DATA / "matches"

# platform routing value -> regional routing value (for account-v1 / match-v5)
REGION_OF = {
    "na1": "americas", "br1": "americas", "la1": "americas", "la2": "americas",
    "euw1": "europe", "eun1": "europe", "tr1": "europe", "ru": "europe", "me1": "europe",
    "kr": "asia", "jp1": "asia",
    "oc1": "sea", "ph2": "sea", "sg2": "sea", "th2": "sea", "tw2": "sea", "vn2": "sea",
}


class Riot:
    # The old code slept a flat 1.3s after every call to stay under the dev
    # key's 100 req / 2 min. That constant, not Riot, decided how long a
    # backfill took — and it stays wrong either way once the key tier changes.
    # Instead, pace off X-App-Rate-Limit, which every response carries: a dev
    # key reports "100:120,20:1" and a personal key reports something far
    # roomier, so the same script runs correctly on both.
    def __init__(self, api_key: str, platform: str, rps: float = 0):
        self.key = api_key
        self.platform = platform
        self.region = REGION_OF[platform]
        self.min_interval = 1.0 / rps if rps else 1.3  # until the first header
        self.pinned = bool(rps)  # explicit config setting wins over the header
        self.last_call = 0.0

    def _pace(self, headers):
        """Slowest bucket in X-App-Rate-Limit ("100:120,20:1") sets the gap."""
        if self.pinned:
            return
        raw = headers.get("X-App-Rate-Limit")
        if not raw:
            return
        gaps = []
        for bucket in raw.split(","):
            count, _, secs = bucket.partition(":")
            try:
                gaps.append(float(secs) / float(count))
            except ValueError:
                continue
        if gaps:
            # 5% of headroom: bursting right at the limit trips 429s anyway
            self.min_interval = max(gaps) * 1.05

    def get(self, host: str, path: str):
        url = f"https://{host}.api.riotgames.com{path}"
        # Cloudflare rejects the default python-urllib user agent (error 1010)
        req = urllib.request.Request(url, headers={
            "X-Riot-Token": self.key,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        })
        attempt, waits = 0, 0
        while attempt < 6 and waits < 40:
            try:
                gap = self.min_interval - (time.time() - self.last_call)
                if gap > 0:
                    time.sleep(gap)
                self.last_call = time.time()
                with urllib.request.urlopen(req) as resp:
                    self._pace(resp.headers)
                    return json.load(resp)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    # A 429 is a pacing problem, not a failing request — it
                    # must not eat the retry budget, or a long backfill dies
                    # partway through on a healthy key.
                    self._pace(e.headers)
                    wait = int(e.headers.get("Retry-After", "10"))
                    print(f"  rate limited, sleeping {wait}s...", flush=True)
                    time.sleep(wait + 1)
                    waits += 1
                    continue
                if e.code in (500, 502, 503, 504):
                    time.sleep(2 ** attempt)
                    attempt += 1
                else:
                    raise
        raise RuntimeError(f"giving up on {url}")

    def account(self, game_name: str, tag: str):
        return self.get(self.region, f"/riot/account/v1/accounts/by-riot-id/"
                        f"{urllib.parse.quote(game_name)}/{urllib.parse.quote(tag)}")

    def mastery(self, puuid: str):
        return self.get(self.platform, f"/lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}")

    def summoner(self, puuid: str):
        return self.get(self.platform, f"/lol/summoner/v4/summoners/by-puuid/{puuid}")

    def match_ids(self, puuid: str, count: int, queue, start_time: int = 0):
        # queue: int = a single queue id (420 solo, 440 flex); "ranked" = both.
        # The endpoint returns at most 100 ids per call, so page through.
        # start_time (epoch seconds) lets Riot do the age filtering, so `count`
        # stops being the thing that decides how far back the window reaches —
        # it is just a runaway guard now.
        q = "&type=ranked" if queue == "ranked" else f"&queue={queue}" if queue else ""
        if start_time:
            q += f"&startTime={int(start_time)}"
        ids = []
        for start in range(0, count, 100):
            n = min(100, count - start)
            page = self.get(self.region,
                            f"/lol/match/v5/matches/by-puuid/{puuid}/ids?start={start}&count={n}{q}")
            ids.extend(page)
            if len(page) < n:  # ran out of history
                break
        return ids

    def league(self, puuid: str):
        """Ranked entries (one per queue). Unranked players come back as []."""
        return self.get(self.platform, f"/lol/league/v4/entries/by-puuid/{puuid}")

    def match(self, match_id: str):
        cached = MATCH_CACHE / f"{match_id}.json"
        if cached.exists():
            return json.loads(cached.read_text())
        m = self.get(self.region, f"/lol/match/v5/matches/{match_id}")
        cached.write_text(json.dumps(m))
        return m


def ddragon_champions():
    """Champion key (numeric id) -> {id (name slug), name} from Data Dragon (no API key)."""
    with urllib.request.urlopen("https://ddragon.leagueoflegends.com/api/versions.json") as r:
        version = json.load(r)[0]
    url = f"https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/champion.json"
    with urllib.request.urlopen(url) as r:
        raw = json.load(r)["data"]
    return version, {int(c["key"]): {"slug": c["id"], "name": c["name"]} for c in raw.values()}


# --- rank ------------------------------------------------------------------
# Tier drives which slice of the ladder the meta prior is read from: a
# champion's win rate in Emerald is not its win rate in Bronze, and the tool
# was previously scoring everyone against the all-ranks average.
QUEUE_OF = {"RANKED_SOLO_5x5": 420, "RANKED_FLEX_SR": 440}
TIER_ORDER = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD",
              "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"]
DIVISION_ORDER = ["IV", "III", "II", "I"]


def league_entries(riot: "Riot", puuid: str):
    """{queueId: {tier, division, lp, wins, losses}} — {} when fully unranked."""
    out = {}
    for e in riot.league(puuid) or []:
        qid = QUEUE_OF.get(e.get("queueType"))
        if not qid:
            continue
        out[str(qid)] = {
            "tier": e.get("tier"),
            "division": e.get("rank"),
            "lp": e.get("leaguePoints", 0),
            "wins": e.get("wins", 0),
            "losses": e.get("losses", 0),
        }
    return out


def rank_label(ranks, queue_pref=("420", "440")):
    for q in queue_pref:
        r = ranks.get(q)
        if r and r.get("tier"):
            apex = r["tier"] in ("MASTER", "GRANDMASTER", "CHALLENGER")
            div = "" if apex else f" {r['division']}"
            return f"{r['tier'].title()}{div} {r['lp']}LP"
    return ""


def rank_score(r):
    """Sortable ladder position, so a group median can be taken."""
    if not r or not r.get("tier"):
        return None
    t = TIER_ORDER.index(r["tier"]) if r["tier"] in TIER_ORDER else 0
    d = DIVISION_ORDER.index(r["division"]) if r.get("division") in DIVISION_ORDER else 3
    return t * 4 + d


def group_tier(players, queue_pref=("420", "440")):
    """Median tier of the ranked members — the ladder slice to read meta from."""
    scores = []
    for p in players:
        for q in queue_pref:
            s = rank_score((p.get("ranks") or {}).get(q))
            if s is not None:
                scores.append(s)
                break
    if not scores:
        return None
    scores.sort()
    return TIER_ORDER[scores[len(scores) // 2] // 4]


def main():
    cfg_path = ROOT / "config.json"
    if not cfg_path.exists():
        sys.exit("config.json not found — copy config.example.json to config.json and fill it in.")
    cfg = json.loads(cfg_path.read_text())
    DATA.mkdir(exist_ok=True)
    MATCH_CACHE.mkdir(exist_ok=True)

    riot = Riot(cfg["api_key"], cfg["platform"], cfg.get("requests_per_second", 0))
    max_age_days = cfg.get("max_match_age_days", 365)
    window_start = int(time.time() - max_age_days * 86400) if max_age_days else 0
    print("Fetching Data Dragon champion list...")
    dd_version, champs = ddragon_champions()

    players = []
    all_match_ids = set()
    puuid_to_player = {}

    # PUUIDs are encrypted per API application, so cached matches fetched
    # under an older key carry old-style PUUIDs — keep every PUUID we've ever
    # resolved for a player so old matches still attribute to them.
    prev_history = {}
    players_path = DATA / "players.json"
    if players_path.exists():
        for p in json.loads(players_path.read_text())["players"]:
            prev_history[p["riotId"]] = p.get("puuidHistory", [p["puuid"]])

    for riot_id in cfg["riot_ids"]:
        game_name, tag = riot_id.rsplit("#", 1)
        print(f"Resolving {riot_id}...")
        acct = riot.account(game_name, tag)
        puuid = acct["puuid"]
        history = sorted(set(prev_history.get(riot_id, [])) | {puuid})
        for pu in history:
            puuid_to_player[pu] = riot_id
        summoner = riot.summoner(puuid)
        print(f"  mastery...")
        mastery = riot.mastery(puuid)
        print(f"  rank...")
        ranks = league_entries(riot, puuid)
        print(f"  match ids...")
        ids = riot.match_ids(puuid, cfg.get("matches_per_player", 1000),
                             cfg.get("queue"), window_start)
        print(f"    {len(ids)} in the last {max_age_days}d"
              f"{' — ' + rank_label(ranks) if ranks else ' — unranked'}")
        all_match_ids.update(ids)
        players.append({
            "riotId": riot_id,
            "puuid": puuid,
            "puuidHistory": history,
            "profileIconId": summoner.get("profileIconId"),
            "ranks": ranks,
            "mastery": [
                {"championId": m["championId"], "level": m["championLevel"], "points": m["championPoints"]}
                for m in mastery
            ],
            "matchIds": ids,
        })

    print(f"Fetching {len(all_match_ids)} unique matches (cached ones are free)...")
    matches = []
    for i, mid in enumerate(sorted(all_match_ids), 1):
        if i % 25 == 0:
            print(f"  {i}/{len(all_match_ids)}")
        matches.append(riot.match(mid))

    # Per-player per-champion stats, split by role. cs/secs feed cs-per-minute.
    # "q" carries the same counters split by queue id so the front-end can
    # score on a single queue (flex-only toggle).
    # k/d/a are kill/death/assist sums; kg counts the games those sums cover —
    # equal to `games` here, but the worker merges incrementally onto records
    # that may predate these fields, so averages must divide by kg, not games.
    def champ_rec():
        return {"games": 0, "wins": 0, "cs": 0, "secs": 0,
                "k": 0, "d": 0, "a": 0, "kg": 0,
                "roles": defaultdict(lambda: {"games": 0, "wins": 0})}
    champ_stats = defaultdict(lambda: defaultdict(
        lambda: champ_rec() | {"q": defaultdict(champ_rec)}))
    # Per-player overall record split by queue id (420 solo / 440 flex).
    queue_stats = defaultdict(lambda: defaultdict(lambda: {"games": 0, "wins": 0}))
    # Tracked-player-pair synergy: games where two of our accounts shared a
    # team. "roles" splits the record by the duo's role combination so the
    # front-end can weight games in the assigned roles above the rest.
    def pair_rec():
        return {"games": 0, "wins": 0,
                "roles": defaultdict(lambda: {"games": 0, "wins": 0})}
    pair_stats = defaultdict(lambda: pair_rec() | {"q": defaultdict(pair_rec)})
    # Champion-pair synergy, pilot-attributed: only pairs where BOTH champions
    # were piloted by tracked accounts on the same team.  Champ-level pairs from
    # stranger teams would credit e.g. a teammate's Ezreal record to any of our
    # players hovering Ezreal.
    champ_pair_stats = defaultdict(lambda: {"games": 0, "wins": 0,
                                            "q": defaultdict(lambda: {"games": 0, "wins": 0})})

    # Slim per-player match feed for the profiles view — newest RECENT_KEEP
    # games with just what a history row renders.
    RECENT_KEEP = 20
    recent_games = defaultdict(list)

    # Full five-stack games — one team made up entirely of tracked accounts.
    # Kept whole (both scoreboards) for the match-history tab.
    stacks = []

    def scoreboard_row(p, rid=None):
        row = {
            "champ": p["championId"],
            "role": p.get("teamPosition") or "UNKNOWN",
            "k": p.get("kills", 0), "d": p.get("deaths", 0), "a": p.get("assists", 0),
            "cs": p.get("totalMinionsKilled", 0) + p.get("neutralMinionsKilled", 0),
            "dmg": p.get("totalDamageDealtToChampions", 0),
            "gold": p.get("goldEarned", 0),
        }
        if rid:
            row["rid"] = rid
        else:
            row["name"] = p.get("riotIdGameName") or p.get("summonerName") or "?"
        return row

    # Only count matches newer than this — old games say little about current
    # form (the raw match stays cached either way).
    max_age_days = cfg.get("max_match_age_days", 365)
    cutoff_ms = (time.time() - max_age_days * 86400) * 1000 if max_age_days else 0
    for m in matches:
        if m["info"].get("gameStartTimestamp", 0) < cutoff_ms:
            continue
        parts = m["info"]["participants"]
        dur = m["info"]["gameDuration"]
        if dur > 20000:  # pre-11.20 matches report milliseconds
            dur //= 1000
        qid = m["info"]["queueId"]
        end_ts = (m["info"].get("gameEndTimestamp")
                  or m["info"].get("gameStartTimestamp", 0) + dur * 1000)
        for p in parts:
            rid = puuid_to_player.get(p["puuid"])
            if rid:
                pos = p.get("teamPosition") or "UNKNOWN"
                cs_val = p.get("totalMinionsKilled", 0) + p.get("neutralMinionsKilled", 0)
                for s in (champ_stats[rid][p["championId"]],
                          champ_stats[rid][p["championId"]]["q"][qid]):
                    s["games"] += 1
                    s["wins"] += p["win"]
                    s["cs"] += cs_val
                    s["secs"] += dur
                    s["k"] += p.get("kills", 0)
                    s["d"] += p.get("deaths", 0)
                    s["a"] += p.get("assists", 0)
                    s["kg"] += 1
                    r = s["roles"][pos]
                    r["games"] += 1
                    r["wins"] += p["win"]
                q = queue_stats[rid][qid]
                q["games"] += 1
                q["wins"] += p["win"]
                recent_games[rid].append({
                    "id": m["metadata"]["matchId"], "ts": end_ts, "q": qid,
                    "champ": p["championId"], "role": pos, "win": int(p["win"]),
                    "k": p.get("kills", 0), "d": p.get("deaths", 0),
                    "a": p.get("assists", 0), "cs": cs_val, "secs": dur,
                })
        for team_id in (100, 200):
            team = [p for p in parts if p["teamId"] == team_id]
            won = bool(team and team[0]["win"])
            tracked_parts = sorted(
                (p for p in team if p["puuid"] in puuid_to_player),
                key=lambda p: (puuid_to_player[p["puuid"]], p["championId"]))
            if len(tracked_parts) == 5:
                stacks.append({
                    "id": m["metadata"]["matchId"], "ts": end_ts, "q": qid,
                    "secs": dur, "win": int(won),
                    "us": [scoreboard_row(p, puuid_to_player[p["puuid"]])
                           for p in tracked_parts],
                    "them": [scoreboard_row(p)
                             for p in parts if p["teamId"] != team_id],
                })
            for i in range(len(tracked_parts)):
                for j in range(i + 1, len(tracked_parts)):
                    pi, pj = tracked_parts[i], tracked_parts[j]
                    key = (puuid_to_player[pi["puuid"]], puuid_to_player[pj["puuid"]])
                    # role combo is oriented to the (a, b) key order above
                    combo = ((pi.get("teamPosition") or "UNKNOWN") + "|" +
                             (pj.get("teamPosition") or "UNKNOWN"))
                    for s in (pair_stats[key], pair_stats[key]["q"][qid]):
                        s["games"] += 1
                        s["wins"] += won
                        r = s["roles"][combo]
                        r["games"] += 1
                        r["wins"] += won
                    ckey = (puuid_to_player[pi["puuid"]], pi["championId"],
                            puuid_to_player[pj["puuid"]], pj["championId"])
                    for cp in (champ_pair_stats[ckey], champ_pair_stats[ckey]["q"][qid]):
                        cp["games"] += 1
                        cp["wins"] += won

    def rec_out(s):
        return {"games": s["games"], "wins": s["wins"], "cs": s["cs"],
                "secs": s["secs"], "k": s["k"], "d": s["d"], "a": s["a"],
                "kg": s["kg"], "roles": dict(s["roles"])}

    for p in players:
        p["champions"] = [
            {"championId": cid, **rec_out(s),
             "q": {str(qid): rec_out(t) for qid, t in s["q"].items()}}
            for cid, s in sorted(champ_stats[p["riotId"]].items(), key=lambda kv: -kv[1]["games"])
        ]
        p["queues"] = {str(qid): s for qid, s in queue_stats[p["riotId"]].items()}
        p["recent"] = sorted(recent_games[p["riotId"]],
                             key=lambda g: -g["ts"])[:RECENT_KEEP]
        del p["matchIds"]

    out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "ddragonVersion": dd_version,
        "groupTier": group_tier(players),
        "champions": {str(k): v for k, v in champs.items()},
        "players": players,
        "playerPairs": [
            {"a": a, "b": b, "games": s["games"], "wins": s["wins"],
             "roles": {k: dict(v) for k, v in s["roles"].items()},
             "q": {str(q): {"games": v["games"], "wins": v["wins"],
                            "roles": {k: dict(r) for k, r in v["roles"].items()}}
                   for q, v in s["q"].items()}}
            for (a, b), s in pair_stats.items()
        ],
        "championPairs": [
            {"pa": pa, "a": a, "pb": pb, "b": b, "games": s["games"], "wins": s["wins"],
             "q": {str(q): dict(v) for q, v in s["q"].items()}}
            for (pa, a, pb, b), s in champ_pair_stats.items() if s["games"] >= 2
        ],
        "stacks": sorted(stacks, key=lambda g: -g["ts"]),
    }
    (DATA / "players.json").write_text(json.dumps(out))
    print(f"Wrote data/players.json ({len(players)} players, {len(matches)} matches, "
          f"group tier {out['groupTier'] or 'unranked'}).")

    import compute_profiles
    compute_profiles.main()


if __name__ == "__main__":
    main()
