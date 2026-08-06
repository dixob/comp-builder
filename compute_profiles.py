#!/usr/bin/env python3
"""Aggregate per-champion combat profiles from the cached match files:
damage mix (physical/magic/true to champions), tankiness (damage taken +
self-mitigated), crowd control (time CCing others), and shielding.

Every participant in every cached match counts — a champion's damage profile
is intrinsic to its kit, so strangers' games are valid signal here (unlike
synergy, which must be pilot-attributed).

No API calls; run any time after fetch_data.py has populated data/matches/.
"""
import glob
import json
import pathlib

ROOT = pathlib.Path(__file__).parent

FIELDS = {
    "phys": "physicalDamageDealtToChampions",
    "magic": "magicDamageDealtToChampions",
    "true": "trueDamageDealtToChampions",
    "taken": "totalDamageTaken",
    "mitig": "damageSelfMitigated",
    "cc": "timeCCingOthers",
    "shield": "totalDamageShieldedOnTeammates",
}


def percentile_ranks(values_by_key):
    """key -> value  =>  key -> rank in [0, 1] (0 = lowest, 1 = highest)."""
    items = sorted(values_by_key.items(), key=lambda kv: kv[1])
    n = len(items)
    return {k: (i / (n - 1) if n > 1 else 0.5) for i, (k, _) in enumerate(items)}


def main():
    agg = {}
    files = glob.glob(str(ROOT / "data" / "matches" / "*.json"))
    for f in files:
        m = json.loads(pathlib.Path(f).read_text())
        for p in m["info"]["participants"]:
            a = agg.setdefault(p["championId"], {k: 0 for k in FIELDS} | {"games": 0})
            a["games"] += 1
            for k, field in FIELDS.items():
                a[k] += p.get(field, 0)

    profiles = {}
    for cid, a in agg.items():
        g = a["games"]
        dmg = a["phys"] + a["magic"] + a["true"]
        profiles[cid] = {
            "games": g,
            # damage mix as shares of damage dealt to champions
            "physShare": round(a["phys"] / dmg, 3) if dmg else 0.0,
            "magicShare": round(a["magic"] / dmg, 3) if dmg else 0.0,
            "trueShare": round(a["true"] / dmg, 3) if dmg else 0.0,
            # per-game means, percentile-ranked below
            "tankAvg": round((a["taken"] + a["mitig"]) / g),
            "ccAvg": round(a["cc"] / g, 1),
            "shieldAvg": round(a["shield"] / g),
        }

    # Percentile ranks among champions with a stable sample.
    stable = {cid: p for cid, p in profiles.items() if p["games"] >= 3}
    for metric, pct_key in (("tankAvg", "tankPct"), ("ccAvg", "ccPct"), ("shieldAvg", "shieldPct")):
        ranks = percentile_ranks({cid: p[metric] for cid, p in stable.items()})
        for cid, p in profiles.items():
            p[pct_key] = round(ranks.get(cid, 0.5), 3)

    out = {"matchCount": len(files), "champions": {str(k): v for k, v in profiles.items()}}
    (ROOT / "data" / "profiles.json").write_text(json.dumps(out))
    print(f"Wrote data/profiles.json — {len(profiles)} champions from {len(files)} matches.")


if __name__ == "__main__":
    main()
