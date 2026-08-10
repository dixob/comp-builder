#!/usr/bin/env python3
"""Build the Cloudflare Worker's initial KV state from the local data.

Recomputes every counter the worker maintains incrementally (champ/role/queue
records, pair synergy, combat-profile sums) from data/matches/*.json, and
carries over mastery / profile icons / champion names / meta from the fetched
JSONs. Writes worker/seed_state.json; upload it with:

    curl -X POST "$WORKER_URL/seed" -H "x-admin-token: $ADMIN_TOKEN" \
         --data-binary @worker/seed_state.json

Keys are canonicalized the same way the worker does (player pairs: riotIds
sorted; champ pairs: sorted by riotId then championId) so incremental merges
land on the same counters.

Run after fetch_data.py / fetch_meta.py. No API calls.
"""
import glob
import json
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent

PROFILE_FIELDS = {
    "phys": "physicalDamageDealtToChampions",
    "magic": "magicDamageDealtToChampions",
    "true": "trueDamageDealtToChampions",
    "taken": "totalDamageTaken",
    "mitig": "damageSelfMitigated",
    "cc": "timeCCingOthers",
    "shield": "totalDamageShieldedOnTeammates",
}


def main():
    cfg = json.loads((ROOT / "config.json").read_text())
    # Only count matches newer than this — old games say little about current
    # form, and champ game counts should reflect roughly the current season.
    max_age_days = cfg.get("max_match_age_days", 365)
    cutoff_ms = (time.time() - max_age_days * 86400) * 1000 if max_age_days else 0
    src = json.loads((ROOT / "data" / "players.json").read_text())
    meta_path = ROOT / "data" / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else None

    # PUUIDs are encrypted per API application — cached matches fetched under
    # an older key carry old-style PUUIDs, so map every PUUID we've ever seen.
    rid_of = {pu: p["riotId"] for p in src["players"]
              for pu in p.get("puuidHistory", [p["puuid"]])}
    players = {
        p["riotId"]: {
            "profileIconId": p.get("profileIconId"),
            "mastery": p["mastery"],
            "champs": {}, "queues": {},
        }
        for p in src["players"]
    }
    # player pairs carry a per-role-combo split ("TOP|JUNGLE" keyed on the
    # sorted pair order) so synergy can be weighted to the assigned roles
    player_pairs = defaultdict(lambda: {"games": 0, "wins": 0, "roles": {}, "q": {}})
    champ_pairs = defaultdict(lambda: {"games": 0, "wins": 0, "q": {}})
    profile_sums = defaultdict(lambda: {k: 0 for k in PROFILE_FIELDS} | {"games": 0})
    processed = []

    skipped_old = 0
    for f in sorted(glob.glob(str(ROOT / "data" / "matches" / "*.json"))):
        m = json.loads(Path(f).read_text())
        if m["info"].get("gameStartTimestamp", 0) < cutoff_ms:
            skipped_old += 1
            continue
        processed.append(m["metadata"]["matchId"])
        parts = m["info"]["participants"]

        dur = m["info"]["gameDuration"]
        if dur > 20000:  # pre-11.20 matches report milliseconds
            dur //= 1000
        qid = str(m["info"]["queueId"])
        for p in parts:
            ps = profile_sums[p["championId"]]
            ps["games"] += 1
            for k, field in PROFILE_FIELDS.items():
                ps[k] += p.get(field, 0)

            rid = rid_of.get(p["puuid"])
            if not rid:
                continue
            pl = players[rid]
            c = pl["champs"].setdefault(str(p["championId"]),
                                        {"games": 0, "wins": 0, "cs": 0, "secs": 0,
                                         "roles": {}, "q": {}})
            pos = p.get("teamPosition") or "UNKNOWN"
            cs_val = p.get("totalMinionsKilled", 0) + p.get("neutralMinionsKilled", 0)
            for s in (c, c["q"].setdefault(qid, {"games": 0, "wins": 0, "cs": 0,
                                                 "secs": 0, "roles": {}})):
                s["games"] += 1
                s["wins"] += p["win"]
                s["cs"] += cs_val
                s["secs"] += dur
                r = s["roles"].setdefault(pos, {"games": 0, "wins": 0})
                r["games"] += 1
                r["wins"] += p["win"]
            q = pl["queues"].setdefault(qid, {"games": 0, "wins": 0})
            q["games"] += 1
            q["wins"] += p["win"]

        for team_id in (100, 200):
            team = [p for p in parts if p["teamId"] == team_id]
            tracked = [p for p in team if p["puuid"] in rid_of]
            if len(tracked) < 2:
                continue
            won = int(bool(team[0]["win"]))
            tracked.sort(key=lambda p: (rid_of[p["puuid"]], p["championId"]))
            for i in range(len(tracked)):
                for j in range(i + 1, len(tracked)):
                    pi, pj = tracked[i], tracked[j]
                    pk = "|".join(sorted([rid_of[pi["puuid"]], rid_of[pj["puuid"]]]))
                    ck = (f"{rid_of[pi['puuid']]}|{pi['championId']}:"
                          f"{rid_of[pj['puuid']]}|{pj['championId']}")
                    # tracked is sorted by riotId, so this combo matches pk's order
                    combo = ((pi.get("teamPosition") or "UNKNOWN") + "|" +
                             (pj.get("teamPosition") or "UNKNOWN"))
                    pp = player_pairs[pk]
                    ppq = pp["q"].setdefault(qid, {"games": 0, "wins": 0, "roles": {}})
                    for s in (pp, ppq):
                        s["games"] += 1
                        s["wins"] += won
                        r = s["roles"].setdefault(combo, {"games": 0, "wins": 0})
                        r["games"] += 1
                        r["wins"] += won
                    for s in (champ_pairs[ck], champ_pairs[ck]["q"].setdefault(qid, {"games": 0, "wins": 0})):
                        s["games"] += 1
                        s["wins"] += won

    state = {
        "config": {
            "platform": cfg["platform"],
            "queue": cfg.get("queue"),
            "riotIds": [{"riotId": p["riotId"], "puuid": p["puuid"],
                         "puuids": p.get("puuidHistory", [p["puuid"]])}
                        for p in src["players"]],
        },
        "players": players,
        "playerPairs": dict(player_pairs),
        "champPairs": dict(champ_pairs),
        "profileSums": {str(k): v for k, v in profile_sums.items()},
        "processed": processed,
        "championNames": src["champions"],
        "ddragonVersion": src["ddragonVersion"],
        "meta": meta,
        "lastRefresh": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    out = ROOT / "worker" / "seed_state.json"
    out.write_text(json.dumps(state))
    print(f"Wrote {out.relative_to(ROOT)} — {len(processed)} matches "
          f"({skipped_old} older than {max_age_days}d skipped), "
          f"{len(players)} players, {len(champ_pairs)} champ pairs, "
          f"{out.stat().st_size // 1024} KB.")


if __name__ == "__main__":
    main()
