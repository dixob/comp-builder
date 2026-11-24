"""Shared local history policy and portable match ledger (no network calls)."""
import time

PROFILE_FIELDS = (
    "physicalDamageDealtToChampions", "magicDamageDealtToChampions",
    "trueDamageDealtToChampions", "totalDamageTaken", "damageSelfMitigated",
    "timeCCingOthers", "totalDamageShieldedOnTeammates",
)
PARTICIPANT_FIELDS = (
    "puuid", "teamId", "championId", "teamPosition", "win", "kills", "deaths",
    "assists", "totalMinionsKilled", "neutralMinionsKilled",
    "totalDamageDealtToChampions", "goldEarned", "riotIdGameName",
    "riotIdTagline", "summonerName", *PROFILE_FIELDS,
)
INFO_FIELDS = (
    "gameStartTimestamp", "gameEndTimestamp", "gameCreation", "gameDuration",
    "queueId", "gameVersion",
)


def match_exclusion(match, config, now_ms=None):
    """Return the exclusion reason, or None when a match meets the policy.

    'ranked' is exactly Solo/Duo and Flex (420/440). None means all queues.
    Missing timestamps/participants are never treated as usable history.
    """
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    info = match.get("info") or {}
    timestamp = info.get("gameStartTimestamp") or info.get("gameCreation") or 0
    if not timestamp or not info.get("participants") or not (match.get("metadata") or {}).get("matchId"):
        return "invalid"
    queue = config.get("queue")
    actual_queue = info.get("queueId")
    if queue == "ranked":
        if actual_queue not in (420, 440):
            return "queue"
    elif queue is not None and queue != 0 and queue != "":
        if str(actual_queue) != str(queue):
            return "queue"
    days = config.get("max_match_age_days", config.get("maxMatchAgeDays", 365))
    if days and timestamp < now_ms - days * 86400000:
        return "expired"
    return None


def compact_match(match):
    """Keep the real fields used by aggregation, attribution and evaluation."""
    info = match["info"]
    return {
        "metadata": {"matchId": match["metadata"]["matchId"]},
        "info": {
            **{key: info[key] for key in INFO_FIELDS if key in info},
            "participants": [
                {key: part[key] for key in PARTICIPANT_FIELDS if key in part}
                for part in info["participants"]
            ],
        },
    }
