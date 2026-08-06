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
    def __init__(self, api_key: str, platform: str):
        self.key = api_key
        self.platform = platform
        self.region = REGION_OF[platform]

    def get(self, host: str, path: str):
        url = f"https://{host}.api.riotgames.com{path}"
        # Cloudflare rejects the default python-urllib user agent (error 1010)
        req = urllib.request.Request(url, headers={
            "X-Riot-Token": self.key,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        })
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req) as resp:
                    time.sleep(1.3)  # stay under the dev-key 100 req / 2 min limit
                    return json.load(resp)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = int(e.headers.get("Retry-After", "10"))
                    print(f"  rate limited, sleeping {wait}s...")
                    time.sleep(wait + 1)
                elif e.code in (500, 502, 503, 504):
                    time.sleep(2 ** attempt)
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

    def match_ids(self, puuid: str, count: int, queue):
        # queue: int = a single queue id (420 solo, 440 flex); "ranked" = both.
        # The endpoint returns at most 100 ids per call, so page through.
        q = "&type=ranked" if queue == "ranked" else f"&queue={queue}" if queue else ""
        ids = []
        for start in range(0, count, 100):
            n = min(100, count - start)
            page = self.get(self.region,
                            f"/lol/match/v5/matches/by-puuid/{puuid}/ids?start={start}&count={n}{q}")
            ids.extend(page)
            if len(page) < n:  # ran out of history
                break
        return ids

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


def main():
    cfg_path = ROOT / "config.json"
    if not cfg_path.exists():
        sys.exit("config.json not found — copy config.example.json to config.json and fill it in.")
    cfg = json.loads(cfg_path.read_text())
    DATA.mkdir(exist_ok=True)
    MATCH_CACHE.mkdir(exist_ok=True)

    riot = Riot(cfg["api_key"], cfg["platform"])
    print("Fetching Data Dragon champion list...")
    dd_version, champs = ddragon_champions()

    players = []
    all_match_ids = set()
    puuid_to_player = {}

    for riot_id in cfg["riot_ids"]:
        game_name, tag = riot_id.rsplit("#", 1)
        print(f"Resolving {riot_id}...")
        acct = riot.account(game_name, tag)
        puuid = acct["puuid"]
        puuid_to_player[puuid] = riot_id
        summoner = riot.summoner(puuid)
        print(f"  mastery...")
        mastery = riot.mastery(puuid)
        print(f"  match ids...")
        ids = riot.match_ids(puuid, cfg.get("matches_per_player", 60), cfg.get("queue"))
        all_match_ids.update(ids)
        players.append({
            "riotId": riot_id,
            "puuid": puuid,
            "profileIconId": summoner.get("profileIconId"),
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

    # Per-player per-champion stats, split by role.
    champ_stats = defaultdict(lambda: defaultdict(
        lambda: {"games": 0, "wins": 0, "roles": defaultdict(lambda: {"games": 0, "wins": 0})}))
    # Per-player overall record split by queue id (420 solo / 440 flex).
    queue_stats = defaultdict(lambda: defaultdict(lambda: {"games": 0, "wins": 0}))
    # Tracked-player-pair synergy: games where two of our accounts shared a team.
    pair_stats = defaultdict(lambda: {"games": 0, "wins": 0})
    # Global champion-pair synergy from every team seen in the fetched matches.
    champ_pair_stats = defaultdict(lambda: {"games": 0, "wins": 0})

    for m in matches:
        parts = m["info"]["participants"]
        for p in parts:
            rid = puuid_to_player.get(p["puuid"])
            if rid:
                s = champ_stats[rid][p["championId"]]
                s["games"] += 1
                s["wins"] += p["win"]
                r = s["roles"][p.get("teamPosition") or "UNKNOWN"]
                r["games"] += 1
                r["wins"] += p["win"]
                q = queue_stats[rid][m["info"]["queueId"]]
                q["games"] += 1
                q["wins"] += p["win"]
        for team_id in (100, 200):
            team = [p for p in parts if p["teamId"] == team_id]
            won = bool(team and team[0]["win"])
            tracked = sorted(p["puuid"] for p in team if p["puuid"] in puuid_to_player)
            for i in range(len(tracked)):
                for j in range(i + 1, len(tracked)):
                    key = (puuid_to_player[tracked[i]], puuid_to_player[tracked[j]])
                    pair_stats[key]["games"] += 1
                    pair_stats[key]["wins"] += won
            cids = sorted(p["championId"] for p in team)
            for i in range(len(cids)):
                for j in range(i + 1, len(cids)):
                    cp = champ_pair_stats[(cids[i], cids[j])]
                    cp["games"] += 1
                    cp["wins"] += won

    for p in players:
        p["champions"] = [
            {"championId": cid, "games": s["games"], "wins": s["wins"], "roles": dict(s["roles"])}
            for cid, s in sorted(champ_stats[p["riotId"]].items(), key=lambda kv: -kv[1]["games"])
        ]
        p["queues"] = {str(qid): s for qid, s in queue_stats[p["riotId"]].items()}
        del p["matchIds"]

    out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "ddragonVersion": dd_version,
        "champions": {str(k): v for k, v in champs.items()},
        "players": players,
        "playerPairs": [
            {"a": a, "b": b, **s} for (a, b), s in pair_stats.items()
        ],
        "championPairs": [
            {"a": a, "b": b, **s} for (a, b), s in champ_pair_stats.items() if s["games"] >= 2
        ],
    }
    (DATA / "players.json").write_text(json.dumps(out))
    print(f"Wrote data/players.json ({len(players)} players, {len(matches)} matches).")


if __name__ == "__main__":
    main()
