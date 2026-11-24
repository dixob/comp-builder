#!/usr/bin/env python3
"""Evaluate saved pregame Compy records against actual Riot match outcomes.

Uses the Python standard library only. It never reconstructs historic
predictions using present-day aggregates, fits weights, or labels unplayed comps.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import re
import math
import random
from pathlib import Path
import sys

ROLES = {"TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"}
MAX_HORIZON_HOURS = 6
COMPONENT_NAMES = {"personal", "meta", "player", "comfort", "rolePenalty", "matchup",
                   "championSynergy", "playerSynergy", "rawTotal"}
PLAN_REQUIRED = {"schemaVersion", "validationFrom", "testFrom", "queue", "modelVersion",
                 "comparisonScores", "primaryMetric"}
PLAN_OPTIONAL = {"minimumPracticalImprovement", "notes", "requireCompleteHistory", "minimumDurationSeconds", "testUntil", "capturePolicy"}


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def timestamp(value, *, allow_date=False):
    if not isinstance(value, str):
        raise ValueError("timestamp must be an ISO string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        if allow_date and len(value) == 10:
            parsed = parsed.replace(tzinfo=timezone.utc)
        else:
            raise ValueError("timestamp must include a timezone")
    return parsed.timestamp() * 1000


def iso(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def canonical_id(value):
    return str(value or "").strip().casefold()


def queue_matches(scope, queue):
    if scope == "ranked":
        return queue in (420, 440)
    return type(scope) is int and scope == queue


def validate_plan(plan):
    """Validate an explicit, fixed cohort and comparison contract; no defaults are fitted."""
    if not isinstance(plan, dict):
        raise ValueError("experiment plan must be an object")
    missing, unknown = PLAN_REQUIRED - set(plan), set(plan) - PLAN_REQUIRED - PLAN_OPTIONAL
    if missing or unknown:
        raise ValueError(f"plan fields missing={sorted(missing)}, unknown={sorted(unknown)}")
    if type(plan["schemaVersion"]) is not int or plan["schemaVersion"] != 1:
        raise ValueError("plan schemaVersion must be 1")
    if timestamp(plan["validationFrom"], allow_date=True) >= timestamp(plan["testFrom"], allow_date=True):
        raise ValueError("plan validationFrom must precede testFrom")
    if "testUntil" in plan and timestamp(plan["testUntil"], allow_date=True) <= timestamp(plan["testFrom"], allow_date=True):
        raise ValueError("plan testUntil must be strictly after testFrom")
    if type(plan["queue"]) is not int or plan["queue"] <= 0:
        raise ValueError("plan queue must be a positive integer")
    if not isinstance(plan["modelVersion"], str) or not plan["modelVersion"].strip():
        raise ValueError("plan modelVersion must be a nonempty string")
    if "capturePolicy" in plan and (not isinstance(plan["capturePolicy"], str) or not plan["capturePolicy"].strip()):
        raise ValueError("plan capturePolicy must be a nonempty string")
    names = plan["comparisonScores"]
    if (not isinstance(names, list) or not names or
            any(not isinstance(n, str) or not n.strip() for n in names) or
            len(set(names)) != len(names) or "current" not in names):
        raise ValueError("plan comparisonScores must be unique nonempty names including current")
    if plan["primaryMetric"] not in ("logLoss", "brier"):
        raise ValueError("plan primaryMetric must be logLoss or brier")
    for field in ("minimumPracticalImprovement", "minimumDurationSeconds"):
        if field in plan and (not finite_number(plan[field]) or plan[field] < 0):
            raise ValueError(f"plan {field} must be a finite nonnegative number")
    if "notes" in plan and not isinstance(plan["notes"], str):
        raise ValueError("plan notes must be a string")
    if "requireCompleteHistory" in plan and type(plan["requireCompleteHistory"]) is not bool:
        raise ValueError("plan requireCompleteHistory must be boolean")
    return deepcopy(plan)


def load_plan(path):
    return validate_plan(json.loads(Path(path).read_text()))


def plan_digest(plan):
    """SHA256 of validated sorted compact JSON, UTF-8; whitespace does not change it."""
    canonical = json.dumps(validate_plan(plan), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def history_snapshot(record):
    """Preserve explicit pregame completeness; missing is unknown, never assumed complete."""
    history, cohort = record.get("history") or {}, record.get("evaluationCohort") or {}
    complete = cohort.get("historyComplete", history.get("complete"))
    return complete if type(complete) is bool else None, cohort.get("historyStatus", history.get("status"))


def validate_record(record):
    if not isinstance(record, dict) or not record.get("id") or not record.get("modelVersion"):
        raise ValueError("id and modelVersion are required")
    captured = timestamp(record.get("capturedAt"))
    automatic = record.get("automatic")
    if automatic is not None:
        if (not isinstance(automatic, dict) or automatic.get("source") not in ("live-draft-browser", "live-draft-worker")
                or not automatic.get("sessionId")):
            raise ValueError("automatic captures require server receipt provenance")
        if automatic["source"] == "live-draft-browser":
            if automatic.get("receivedAt") != record.get("capturedAt"):
                raise ValueError("browser capture must use server receipt time")
        elif (automatic.get("computedAt") != record.get("capturedAt")
              or timestamp(automatic.get("receivedAt")) < captured
              or not isinstance(automatic.get("scoringSourceSha"), str)
              or not re.fullmatch(r"[0-9a-f]{64}", automatic["scoringSourceSha"])):
            raise ValueError("worker capture requires computation time, receipt time and scoring source hash")
    for key in ("analyzedAt", "fetchedAt"):
        source_time = (record.get("meta") or {}).get(key)
        if source_time and timestamp(source_time) > captured:
            raise ValueError("meta provenance is later than prediction capture")
    if record.get("dataGeneratedAt") and timestamp(record["dataGeneratedAt"]) > captured:
        raise ValueError("player data is later than prediction capture")
    if record.get("captureStage") not in (None, "pregame"):
        raise ValueError("captureStage must be pregame when supplied")
    if record.get("side") is not None and (type(record["side"]) is not int or record["side"] not in (100, 200)):
        raise ValueError("side must be null, 100 or 200")
    for field in ("history", "evaluationCohort", "settings"):
        if record.get(field) is not None and not isinstance(record[field], dict):
            raise ValueError(f"{field} must be an object or null")
    history, cohort = record.get("history") or {}, record.get("evaluationCohort") or {}
    for source, field in ((history, "complete"), (cohort, "historyComplete")):
        if field in source and source[field] is not None and type(source[field]) is not bool:
            raise ValueError("history completeness must be boolean or null")
    if (type(history.get("complete")) is bool and type(cohort.get("historyComplete")) is bool
            and history["complete"] != cohort["historyComplete"]):
        raise ValueError("conflicting history completeness snapshots")
    components = record.get("components")
    if components is not None:
        if not isinstance(components, dict) or set(components) != COMPONENT_NAMES:
            raise ValueError("components must contain all nine declared pregame component names")
        if any(not finite_number(v) for v in components.values()):
            raise ValueError("components must be finite numeric pregame values")
    evidence = record.get("evidence")
    if evidence is not None:
        rows = evidence if isinstance(evidence, list) else evidence.get("picks", []) if isinstance(evidence, dict) else None
        if not isinstance(rows, list):
            raise ValueError("evidence must be a picks list or an object containing picks")
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("each evidence pick must be an object")
            for key in ("effectiveGames", "effectiveSample", "effectiveWins", "playerGames", "playerWins"):
                if key in row and (not finite_number(row[key]) or row[key] < 0):
                    raise ValueError("evidence counts must be finite and nonnegative")
            for wins, games in (("effectiveWins", "effectiveGames"), ("playerWins", "playerGames")):
                if wins in row and games in row and row[wins] > row[games]:
                    raise ValueError("evidence wins cannot exceed games")
            if "priorSource" in row and row["priorSource"] not in ("role", "overall", "neutral"):
                raise ValueError("evidence priorSource is invalid")
    comp = record.get("comp", record.get("assign"))
    if not isinstance(comp, list) or len(comp) != 5:
        raise ValueError("exactly five comp slots are required")
    if {slot.get("role") for slot in comp} != ROLES:
        raise ValueError("all five distinct roles are required")
    if len({canonical_id(slot.get("riotId")) for slot in comp}) != 5:
        raise ValueError("five distinct players are required")
    if len({slot.get("championId") for slot in comp}) != 5:
        raise ValueError("five distinct champions are required")
    for slot in comp:
        if "#" not in str(slot.get("riotId", "")) or type(slot.get("championId")) is not int:
            raise ValueError("each slot needs a Riot ID and numeric championId")
    scope = record.get("queue")
    if scope != "ranked" and not (type(scope) is int and scope > 0):
        raise ValueError("queue must be ranked or an explicit positive queue ID")
    scores = record.get("scores")
    if not isinstance(scores, dict) or "current" not in scores:
        raise ValueError("scores.current is required")
    for value in scores.values():
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("scores must be finite values between zero and one")
    if any(not isinstance(name, str) or not name for name in scores):
        raise ValueError("score names must be nonempty strings")
    return comp


def player_matches(slot, participant):
    aliases = set(slot.get("puuidHistory") or slot.get("puuids") or [])
    if slot.get("puuid"):
        aliases.add(slot["puuid"])
    if participant.get("puuid") and participant["puuid"] in aliases:
        return True
    rid = f"{participant.get('riotIdGameName', '')}#{participant.get('riotIdTagline', '')}"
    return canonical_id(rid) == canonical_id(slot["riotId"])


def match_record(record, comp, match, horizon_ms):
    info = match.get("info", {})
    start = info.get("gameStartTimestamp", 0)
    if type(start) not in (int, float) or not math.isfinite(start) or start <= 0:
        return None
    captured = timestamp(record["capturedAt"])
    if record.get("automatic"):
        horizon_ms = min(horizon_ms, 15 * 60 * 1000)
    if not captured < start <= captured + horizon_ms:
        return None
    if not queue_matches(record["queue"], info.get("queueId")):
        return None
    explicit = record.get("matchedMatchId")
    match_id = match.get("metadata", {}).get("matchId")
    if not match_id or (explicit and explicit != match_id):
        return None
    participants = info.get("participants", [])
    for team_id in (100, 200):
        if record.get("side") is not None and record["side"] != team_id:
            continue
        team = [p for p in participants if p.get("teamId") == team_id]
        if record.get("automatic"):
            expected = [p.get("championId") for p in record.get("opponents", [])]
            opponents = [p.get("championId") for p in participants if p.get("teamId") != team_id]
            if (len(expected) != 5 or any(type(cid) is not int for cid in expected + opponents)
                    or sorted(expected) != sorted(opponents)):
                continue
        if len(team) != 5:
            continue
        matched = []
        for slot in comp:
            found = [i for i, p in enumerate(team)
                     if player_matches(slot, p)
                     and p.get("championId") == slot["championId"]
                     and p.get("teamPosition") == slot["role"]]
            if len(found) != 1:
                break
            matched.append(found[0])
        if len(matched) != 5 or len(set(matched)) != 5:
            continue
        outcomes = {p.get("win") for p in team}
        if len(outcomes) != 1 or any(type(x) is not bool for x in outcomes):
            return None
        evidence = record.get("evidence") or {}
        rows = evidence if isinstance(evidence, list) else evidence.get("picks", [])
        samples = [r.get("effectiveGames", r.get("effectiveSample")) for r in rows if isinstance(r, dict)]
        samples = [n for n in samples if type(n) in (int, float) and math.isfinite(n) and n >= 0]
        minimum = min(samples) if len(samples) == 5 else None
        band = "unknown" if minimum is None else "under_5" if minimum < 5 else "5_to_19" if minimum < 20 else "20_plus"
        version = str(info.get("gameVersion", ""))
        complete, history_status = history_snapshot(record)
        duration = info.get("gameDuration")
        if not finite_number(duration) or duration < 0:
            duration = None
        finished = info.get("gameEndTimestamp")
        if not finite_number(finished) or finished <= start:
            finished = start + duration * 1000 if duration is not None and duration > 0 else None
        if finished is not None and not finite_number(finished):
            finished = None
        # Do not forward player identities or unplayed alternatives into a fitted model.
        evidence_fields = {"role", "championId", "effectiveGames", "effectiveSample", "effectiveWins",
                           "priorSource", "prior", "playerGames", "playerWins"}
        evidence_snapshot = [{k: deepcopy(v) for k, v in pick.items() if k in evidence_fields}
                             for pick in rows if isinstance(pick, dict)]
        return {
            "recordId": record["id"], "matchId": match_id,
            "modelVersion": str(record["modelVersion"]),
            "capturedAt": record["capturedAt"], "matchStart": iso(start), "startMs": start,
            "queue": info["queueId"], "patch": ".".join(version.split(".")[:2]) or "unknown",
            "metaPatch": (record.get("meta") or {}).get("patch", "unknown"),
            "sampleBand": band, "outcome": int(next(iter(outcomes))),
            "scores": {**record["scores"], "constant50": 0.5},
            "components": deepcopy(record.get("components")),
            "captureStage": record.get("captureStage"),
            "capturedSide": record.get("side"), "actualSide": team_id,
            "gameDurationSeconds": duration,
            "outcomeAvailableMs": finished,
            "historyComplete": complete, "historyStatus": history_status,
            "evidence": evidence_snapshot,
            "provenance": {"automatic": deepcopy(record.get("automatic")),
                           "meta": deepcopy(record.get("meta")),
                           "dataGeneratedAt": record.get("dataGeneratedAt"),
                           "history": deepcopy(record.get("history")),
                           "evaluationCohort": deepcopy(record.get("evaluationCohort")),
                           "settings": deepcopy(record.get("settings"))},
        }
    return None


def link_records(records, matches, horizon_hours=MAX_HORIZON_HOURS):
    if not 0 < horizon_hours <= MAX_HORIZON_HOURS:
        raise ValueError("matching horizon must be greater than zero and at most six hours")
    reasons = Counter()
    unique = {}
    conflicts = set()
    for record in records:
        try:
            validate_record(record)
        except (TypeError, ValueError, KeyError, AttributeError):
            reasons["invalid_record"] += 1
            continue
        key = str(record["id"])
        if key in conflicts:
            reasons["conflicting_record_id"] += 1
        elif key in unique:
            if record == unique[key]:
                reasons["duplicate_export_record"] += 1
            else:
                del unique[key]
                conflicts.add(key)
                reasons["conflicting_record_id"] += 2
        else:
            unique[key] = record
    # Repeated cache files must not manufacture an ambiguous second match.
    by_id = {}
    match_conflicts = set()
    for match in matches:
        key = match.get("metadata", {}).get("matchId")
        if not key or key in match_conflicts:
            continue
        if key in by_id and by_id[key] != match:
            del by_id[key]
            match_conflicts.add(key)
        else:
            by_id[key] = match
    reasons["conflicting_match_files"] = len(match_conflicts)
    matched = []
    for record in unique.values():
        comp = validate_record(record)
        possibilities = [result for m in by_id.values()
                         if (result := match_record(record, comp, m, horizon_hours * 3600000))]
        if not possibilities:
            reasons["no_eligible_match"] += 1
        elif len(possibilities) > 1:
            reasons["ambiguous_match"] += 1
        else:
            matched.append(possibilities[0])
    owners = Counter(row["matchId"] for row in matched)
    unambiguous = []
    for row in matched:
        if owners[row["matchId"]] != 1:
            reasons["multiple_records_for_match"] += 1
        else:
            unambiguous.append(row)
    return sorted(unambiguous, key=lambda row: row["startMs"]), dict(reasons)


def filter_cohort(rows, *, queue=None, require_complete_history=False, plan=None):
    """Filter matched rows without changing their captured scores or features.

    Counts are mutually exclusive, in filter order; missing-score detail is
    reported separately by evaluate(). Matching/ambiguity checks happen first.
    """
    if queue is not None and (type(queue) is not int or queue <= 0):
        raise ValueError("queue filter must be a positive integer")
    if type(require_complete_history) is not bool:
        raise ValueError("require_complete_history must be boolean")
    if plan is not None:
        plan = validate_plan(plan)
        if queue is not None and queue != plan["queue"]:
            raise ValueError("explicit queue conflicts with experiment plan")
        if require_complete_history and not plan.get("requireCompleteHistory", False):
            raise ValueError("complete-history filter conflicts with experiment plan")
        queue = plan["queue"]
        require_complete_history = require_complete_history or plan.get("requireCompleteHistory", False)
    reasons, selected = Counter(), []
    for row in rows:
        if queue is not None and row["queue"] != queue:
            reasons["queue_filter"] += 1
        elif plan and row["modelVersion"] != plan["modelVersion"]:
            reasons["model_version_filter"] += 1
        elif plan and "capturePolicy" in plan and ((row.get("provenance") or {}).get("settings") or {}).get("capturePolicy") != plan["capturePolicy"]:
            reasons["capture_policy_filter"] += 1
        elif require_complete_history and row.get("historyComplete") is not True:
            reasons["history_incomplete" if row.get("historyComplete") is False else "history_unknown"] += 1
        elif plan and "testUntil" in plan and row["startMs"] >= timestamp(plan["testUntil"], allow_date=True):
            reasons["after_test_window"] += 1
        elif plan and "minimumDurationSeconds" in plan and row.get("gameDurationSeconds") is None:
            reasons["duration_unknown"] += 1
        elif plan and row.get("gameDurationSeconds", 0) is not None and row.get("gameDurationSeconds", 0) < plan.get("minimumDurationSeconds", 0):
            reasons["below_minimum_duration"] += 1
        elif plan and not set(plan["comparisonScores"]).issubset(row["scores"]):
            reasons["missing_comparison_scores"] += 1
        else:
            selected.append(row)
    return selected, dict(reasons)


def readiness(rows):
    """Descriptive capture coverage, not a sample-size or accuracy certification."""
    return {
        "matchedGames": len(rows),
        "historyCounts": {"complete": sum(r.get("historyComplete") is True for r in rows),
                          "incomplete": sum(r.get("historyComplete") is False for r in rows),
                          "unknown": sum(r.get("historyComplete") is None for r in rows)},
        "componentsAvailable": sum(r.get("components") is not None for r in rows),
        "capturedSideAvailable": sum(r.get("capturedSide") in (100, 200) for r in rows),
        "explicitPregameStage": sum(r.get("captureStage") == "pregame" for r in rows),
        "observedDays": len({r["matchStart"][:10] for r in rows}),
        "notice": "Coverage counts only; sparse data and dependent sessions do not establish accuracy or readiness to deploy.",
    }


def auc(values):
    """ROC AUC via average ranks, including ties; undefined for a single class."""
    positives = sum(y for _, y in values)
    negatives = len(values) - positives
    if not positives or not negatives:
        return None
    ordered, positive_rank_sum, index = sorted(values), 0.0, 0
    while index < len(ordered):
        end = index + 1
        while end < len(ordered) and ordered[end][0] == ordered[index][0]:
            end += 1
        mean_rank = (index + 1 + end) / 2
        positive_rank_sum += mean_rank * sum(y for _, y in ordered[index:end])
        index = end
    return (positive_rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def wilson_interval(successes, n):
    """95% Wilson binomial proportion interval; not a time-dependence correction."""
    if not n:
        return None
    z = 1.959963984540054
    p, denominator = successes / n, 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    radius = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return [max(0.0, center - radius), min(1.0, center + radius)]


def metrics(rows, score_name):
    values = [(r["scores"][score_name], r["outcome"]) for r in rows if score_name in r["scores"]]
    if not values:
        return {"n": 0, "brier": None, "logLoss": None, "auc": None, "reliability": []}
    n = len(values)
    bins = []
    for i in range(10):
        sample = [(p, y) for p, y in values if min(int(p * 10), 9) == i]
        if sample:
            bins.append({"lower": i / 10, "upper": (i + 1) / 10, "n": len(sample),
                         "meanScore": sum(p for p, _ in sample) / len(sample),
                         "observedWinRate": sum(y for _, y in sample) / len(sample),
                         "observedWinRateInterval95": wilson_interval(sum(y for _, y in sample), len(sample)),
                         "intervalMethod": "Wilson binomial proportion only; ignores dependence between matches"})
    eps = 1e-15
    return {
        "n": n,
        "brier": sum((p - y) ** 2 for p, y in values) / n,
        "logLoss": -sum(y * math.log(max(eps, min(1 - eps, p)))
                        + (1 - y) * math.log(max(eps, min(1 - eps, 1 - p))) for p, y in values) / n,
        "meanScore": sum(p for p, _ in values) / n,
        "observedWinRate": sum(y for _, y in values) / n,
        "auc": auc(values),
        "reliability": bins,
    }


def paired_day_bootstrap(rows, reference, draws=1000):
    """Paired score differences; resample whole UTC days, never player rows."""
    if type(draws) is not int or draws <= 0:
        raise ValueError("bootstrap draws must be a positive integer")
    if not rows or any("current" not in r["scores"] or reference not in r["scores"] for r in rows):
        raise ValueError("paired comparison requires both scores on every row of a nonempty cohort")
    days = defaultdict(list)
    for row in rows:
        days[row["matchStart"][:10]].append(row)
    estimate = {
        metric: metrics(rows, "current")[metric] - metrics(rows, reference)[metric]
        for metric in ("brier", "logLoss")
    }
    result = {"reference": reference, "difference": "current minus reference; negative is better",
              "dayBlocks": len(days), "estimate": estimate, "interval95": None}
    if len(days) < 2:
        result["warning"] = "At least two observed UTC days are needed for a day-block interval."
        return result
    blocks = list(days.values())
    rng = random.Random(0)
    samples = {"brier": [], "logLoss": []}
    for _ in range(draws):
        sample = [row for _ in blocks for row in rng.choice(blocks)]
        current, other = metrics(sample, "current"), metrics(sample, reference)
        for metric in samples:
            samples[metric].append(current[metric] - other[metric])
    result["interval95"] = {}
    for metric, values in samples.items():
        values.sort()
        result["interval95"][metric] = [values[int(draws * .025)], values[min(draws - 1, int(draws * .975))]]
    result["bootstrapDraws"] = draws
    result["warning"] = "Descriptive day-block interval; dependence across days and sparse data may still understate uncertainty."
    return result


def summarize(rows, comparison_scores=None):
    # Never pool a score name across different scoring implementations.
    versions = defaultdict(list)
    for row in rows:
        versions[row["modelVersion"]].append(row)
    result = {}
    for version, group in versions.items():
        common = set.intersection(*(set(r["scores"]) for r in group))
        if comparison_scores is not None and not set(comparison_scores).issubset(common):
            raise ValueError("all planned comparison scores must be present on the identical cohort")
        names = sorted(common) if comparison_scores is None else list(comparison_scores)
        models = {name: {"overall": metrics(group, name)} for name in names}
        for field in ("queue", "patch", "sampleBand", "actualSide"):
            for name in names:
                models[name]["by" + field[0].upper() + field[1:]] = {
                    str(value): metrics([r for r in group if r.get(field) == value], name)
                    for value in sorted({r.get(field) for r in group}, key=str)
                }
        union = set.union(*(set(r["scores"]) for r in group))
        result[version] = {"matchedGames": len(group), "models": models,
                           "omittedNonCommonScores": sorted(union - common),
                           "unplannedScores": sorted(common - set(names)) if comparison_scores is not None else [],
                           "readiness": readiness(group),
                           "comparisons": [paired_day_bootstrap(group, name) for name in names if name != "current"],
                           "smallSampleWarning": "Do not infer a reliable improvement from sparse bins or few days."}
    return result


def evaluate(records, matches, validation_from=None, test_from=None, split="test", horizon_hours=6,
             *, queue=None, require_complete_history=False, plan=None):
    if split not in ("train", "validation", "test"):
        raise ValueError("split must be train, validation, or test")
    if plan is not None:
        plan = validate_plan(plan)
        for explicit, field in ((validation_from, "validationFrom"), (test_from, "testFrom")):
            if explicit is not None and timestamp(explicit, allow_date=True) != timestamp(plan[field], allow_date=True):
                raise ValueError(f"explicit boundary conflicts with plan {field}")
        validation_from, test_from = plan["validationFrom"], plan["testFrom"]
    validation_ms = timestamp(validation_from, allow_date=True) if validation_from else None
    test_ms = timestamp(test_from, allow_date=True) if test_from else None
    if validation_ms is not None and test_ms is not None and validation_ms >= test_ms:
        raise ValueError("validation-from must precede test-from")
    # Validate cohort options even when no eligible records exist.
    filter_cohort([], queue=queue, require_complete_history=require_complete_history, plan=plan)
    all_linked, exclusions = link_records(records, matches, horizon_hours)
    linked, cohort_exclusions = filter_cohort(all_linked, queue=queue, require_complete_history=require_complete_history, plan=plan)
    exclusions.update(cohort_exclusions)
    report = {
        "status": "no_matched_games", "inputRecords": len(records), "matchedGames": len(linked),
        "matchedBeforeCohortFilter": len(all_linked),
        "exclusions": exclusions, "horizonHours": horizon_hours,
        "filters": {"queue": plan["queue"] if plan else queue,
                    "requireCompleteHistory": require_complete_history or bool(plan and plan.get("requireCompleteHistory"))},
        "readinessBeforeCohortFilter": readiness(all_linked), "readiness": readiness(linked),
        "notice": "Heuristic scores are evaluated as probabilities for diagnostics only. No model was fitted or calibrated. Unplayed alternatives have no observed outcome.",
    }
    if plan:
        report.update({"plan": plan, "planSha256": plan_digest(plan),
                       "planHashEncoding": "validated sorted compact JSON, UTF-8, ensure_ascii=False",
                       "missingPlannedScoresBeforeCohortFilter": {
                           name: sum(name not in r["scores"] for r in all_linked)
                           for name in plan["comparisonScores"]},
                       "decisionNotice": "The declared metric and practical-improvement threshold do not automatically select or promote a model."})
    if not linked:
        if all_linked:
            report["status"] = "no_games_in_cohort"
        report["evaluation"] = {}
        return report
    if not validation_from or not test_from:
        report["status"] = "split_boundaries_required"
        report["message"] = "Declare fixed --validation-from and --test-from UTC boundaries before reporting metrics."
        return report
    partitions = {"train": [], "validation": [], "test": []}
    for row in linked:
        name = "train" if row["startMs"] < validation_ms else "validation" if row["startMs"] < test_ms else "test"
        partitions[name].append(row)
    selected = partitions[split]
    report.update({
        "status": "evaluated" if selected else "no_games_in_selected_split", "selectedSplit": split,
        "boundaries": {"validationFrom": iso(validation_ms), "testFrom": iso(test_ms)},
        "splitCounts": {key: len(value) for key, value in partitions.items()},
        "evaluation": summarize(selected, plan["comparisonScores"] if plan else None),
        "selectedReadiness": readiness(selected),
        "matchedRecords": [{k: v for k, v in row.items() if k not in ("startMs", "scores")} for row in selected],
    })
    return report


def load_records(path):
    document = json.loads(Path(path).read_text())
    if isinstance(document, list):
        return document
    if not isinstance(document, dict) or document.get("schemaVersion") != 1 or not isinstance(document.get("records"), list):
        raise ValueError("expected a schemaVersion: 1 export with a records array")
    return document["records"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("records", help="JSON exported by Compy before games were played")
    parser.add_argument("--matches", type=Path, default=Path("data/matches"), help="directory of Riot match-v5 JSON files")
    parser.add_argument("--validation-from", help="fixed UTC date or timezone-aware ISO timestamp")
    parser.add_argument("--test-from", help="fixed UTC date or timezone-aware ISO timestamp")
    parser.add_argument("--split", choices=("train", "validation", "test"), default="test")
    parser.add_argument("--horizon-hours", type=float, default=6)
    parser.add_argument("--queue", type=int, help="restrict outcome cohort to an explicit queue ID, e.g. 440")
    parser.add_argument("--require-complete-history", action="store_true", help="exclude incomplete or unknown pregame history")
    parser.add_argument("--plan", type=Path, help="strict experiment-plan JSON with fixed cohort, boundaries and comparison scores")
    parser.add_argument("--output", type=Path, help="optional report JSON path; stdout always prints report")
    args = parser.parse_args(argv)
    try:
        records = load_records(args.records)
        files = sorted(args.matches.glob("*.json"))
        matches = [json.loads(path.read_text()) for path in files]
        plan = load_plan(args.plan) if args.plan else None
        report = evaluate(records, matches, args.validation_from, args.test_from, args.split, args.horizon_hours,
                          queue=args.queue, require_complete_history=args.require_complete_history, plan=plan)
        report["matchFiles"] = len(files)
        rendered = json.dumps(report, indent=2, allow_nan=False)
        if args.output:
            args.output.write_text(rendered + "\n")
        print(rendered)
        return 0 if report["status"] == "evaluated" else 2
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(f"Evaluation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
