#!/usr/bin/env python3
"""Fetch current-patch champion win/pick rates by role from OP.GG's internal
API and write data/meta.json. Unofficial endpoint — may break without notice.

Usage: python3 fetch_meta.py
"""
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

# op.gg region slug from Riot platform id
OPGG_REGION = {"na1": "na", "euw1": "euw", "eun1": "eune", "kr": "kr", "br1": "br",
               "jp1": "jp", "oc1": "oce", "tr1": "tr", "ru": "ru", "la1": "lan", "la2": "las"}


def main():
    cfg = json.loads((ROOT / "config.json").read_text())
    region = OPGG_REGION.get(cfg["platform"], "na")
    url = f"https://lol-api-champion.op.gg/api/{region}/champions/ranked"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as r:
        raw = json.load(r)

    champs = {}
    for c in raw["data"]:
        positions = {}
        for pos in c.get("positions") or []:
            s = pos["stats"]
            positions[pos["name"]] = {
                "winRate": s["win_rate"],
                "pickRate": s["pick_rate"],
                "roleRate": s.get("role_rate", 0),
                "games": s["play"],
            }
        avg = c.get("average_stats") or {}
        champs[str(c["id"])] = {
            "winRate": avg.get("win_rate"),
            "pickRate": avg.get("pick_rate"),
            "banRate": avg.get("ban_rate"),
            "games": avg.get("play", 0),
            "tier": avg.get("tier"),
            "positions": positions,
        }

    out = {
        "patch": raw["meta"]["version"],
        "region": region,
        "matchCount": raw["meta"].get("match_count"),
        "analyzedAt": raw["meta"].get("analyzed_at"),
        "champions": champs,
    }
    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "meta.json").write_text(json.dumps(out))
    print(f"Wrote data/meta.json — patch {out['patch']}, {len(champs)} champions, "
          f"{out['matchCount']:,} matches ({region})")


if __name__ == "__main__":
    main()
