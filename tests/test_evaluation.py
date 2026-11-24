"""Mechanical checks using recorded roster scoreboards and OP.GG statistics.

The test-only pregame timestamps are boundary probes, not historical predictions;
they must never be included in an accuracy report. Outcomes and compositions
are copied from real records, never invented.
"""
from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import json
import math
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("evaluate_predictions", ROOT / "scripts/evaluate_predictions.py")
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)
PLAYERS = json.loads((ROOT / "data/players.json").read_text())
META = json.loads((ROOT / "data/meta.json").read_text())
POSITION = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MID", "BOTTOM": "ADC", "UTILITY": "SUPPORT"}


def recorded_case(index=0):
    # Convert a real checked-in full-team scoreboard to the minimal match-v5
    # projection consumed by the evaluator. This makes tests portable without
    # committing the private, gitignored raw-match cache.
    stack = [s for s in PLAYERS["stacks"]
             if len(s["us"]) == 5 and {p["role"] for p in s["us"]} == evaluator.ROLES][index]
    comp, participants = [], []
    for p in stack["us"]:
        identity = next(x for x in PLAYERS["players"] if x["riotId"] == p["rid"])
        name, tag = p["rid"].rsplit("#", 1)
        comp.append({"riotId": p["rid"], "championId": p["champ"], "role": p["role"],
                     "puuid": identity["puuid"], "puuidHistory": identity.get("puuidHistory", [])})
        participants.append({"puuid": identity["puuid"], "riotIdGameName": name, "riotIdTagline": tag,
                             "championId": p["champ"], "teamPosition": p["role"], "teamId": 100,
                             "win": bool(stack["win"])})
    start = stack["ts"] - stack["secs"] * 1000
    match = {"metadata": {"matchId": stack["id"]},
             "info": {"gameStartTimestamp": start, "gameDuration": stack["secs"],
                      "queueId": stack["q"], "participants": participants}}
    priors = []
    for slot in comp:
        champion = META["champions"].get(str(slot["championId"]), {})
        position = champion.get("positions", {}).get(POSITION[slot["role"]], {})
        priors.append(position.get("winRate", champion.get("winRate") or .5))
    record = {"id": stack["id"], "modelVersion": "mechanical-fixture-not-a-prediction",
              "capturedAt": evaluator.iso(start - 1), "queue": stack["q"], "comp": comp,
              "scores": {"current": sum(priors) / 5, "metaOnly": sum(priors) / 5},
              "meta": {"patch": META["patch"]}}
    return record, match


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.record, self.match = recorded_case()

    def test_exact_recorded_team_matches_once(self):
        linked, excluded = evaluator.link_records([self.record], [self.match, deepcopy(self.match)])
        self.assertEqual(len(linked), 1)
        self.assertEqual(linked[0]["outcome"], int(self.match["info"]["participants"][0]["win"]))
        self.assertEqual(linked[0]["scores"]["constant50"], .5)

    def test_requires_strictly_pregame_capture_and_bounded_window(self):
        start = self.match["info"]["gameStartTimestamp"]
        for captured in (start, start + 1, start - 6 * 3600000 - 1):
            self.record["capturedAt"] = evaluator.iso(captured)
            linked, reasons = evaluator.link_records([self.record], [self.match])
            self.assertEqual(linked, [])
            self.assertEqual(reasons["no_eligible_match"], 1)
        with self.assertRaises(ValueError):
            evaluator.link_records([self.record], [self.match], horizon_hours=7)

    def test_queue_role_and_champion_must_match(self):
        record = deepcopy(self.record)
        record["queue"] = 420 if self.record["queue"] != 420 else 440
        self.assertFalse(evaluator.link_records([record], [self.match])[0])
        for field in ("championId", "role"):
            record = deepcopy(self.record)
            record["comp"][0][field], record["comp"][1][field] = record["comp"][1][field], record["comp"][0][field]
            self.assertFalse(evaluator.link_records([record], [self.match])[0])

    def test_identity_uses_riot_id_when_alias_is_missing(self):
        for slot in self.record["comp"]:
            slot.pop("puuid")
            slot.pop("puuidHistory")
        self.assertEqual(len(evaluator.link_records([self.record], [self.match])[0]), 1)

    def test_duplicate_exports_deduplicate_but_two_decisions_are_ambiguous(self):
        linked, reasons = evaluator.link_records([self.record, deepcopy(self.record)], [self.match])
        self.assertEqual(len(linked), 1)
        self.assertEqual(reasons["duplicate_export_record"], 1)
        second = deepcopy(self.record)
        second["id"] += "-second-record"
        linked, reasons = evaluator.link_records([self.record, second], [self.match])
        self.assertEqual(linked, [])
        self.assertEqual(reasons["multiple_records_for_match"], 2)

    def test_rejects_conflicting_ids_and_invalid_scores(self):
        second = deepcopy(self.record)
        second["capturedAt"] = evaluator.iso(self.match["info"]["gameStartTimestamp"] - 2)
        self.assertFalse(evaluator.link_records([self.record, second], [self.match])[0])
        for value in (float("nan"), 1.01, -.1, True):
            record = deepcopy(self.record)
            record["scores"]["current"] = value
            _, reasons = evaluator.link_records([record], [self.match])
            self.assertEqual(reasons["invalid_record"], 1)

    def test_fixed_chronological_boundaries_and_metrics(self):
        start = self.match["info"]["gameStartTimestamp"]
        result = evaluator.evaluate([self.record], [self.match])
        self.assertEqual(result["status"], "split_boundaries_required")
        result = evaluator.evaluate([self.record], [self.match], evaluator.iso(start - 2000), evaluator.iso(start - 1000))
        self.assertEqual(result["selectedSplit"], "test")
        self.assertEqual(result["splitCounts"], {"train": 0, "validation": 0, "test": 1})
        metric = result["evaluation"][self.record["modelVersion"]]["models"]["current"]["overall"]
        y = int(self.match["info"]["participants"][0]["win"])
        self.assertAlmostEqual(metric["brier"], (self.record["scores"]["current"] - y) ** 2)
        self.assertEqual(sum(b["n"] for b in metric["reliability"]), 1)
        self.assertEqual(evaluator.evaluate([self.record], [self.match], evaluator.iso(start + 1), evaluator.iso(start + 2))["status"], "no_games_in_selected_split")

    def test_future_provenance_is_rejected(self):
        self.record["meta"]["analyzedAt"] = evaluator.iso(self.match["info"]["gameStartTimestamp"])
        _, reasons = evaluator.link_records([self.record], [self.match])
        self.assertEqual(reasons["invalid_record"], 1)

    def test_day_block_comparisons_use_real_distinct_dates(self):
        first = evaluator.link_records([self.record], [self.match])[0][0]
        second = None
        for index in range(1, len(PLAYERS["stacks"])):
            try:
                record, match = recorded_case(index)
            except IndexError:
                break
            if evaluator.iso(match["info"]["gameStartTimestamp"])[:10] != first["matchStart"][:10]:
                second = evaluator.link_records([record], [match])[0][0]
                break
        self.assertIsNotNone(second, "recorded data must contain two distinct dates")
        report = evaluator.paired_day_bootstrap([first, second], "metaOnly", draws=100)
        self.assertEqual(report["dayBlocks"], 2)
        self.assertEqual(report["estimate"]["brier"], 0)
        self.assertEqual(report["interval95"]["brier"], [0, 0])

    def test_no_data_is_not_an_accuracy_result(self):
        result = evaluator.evaluate([], [])
        self.assertEqual(result["status"], "no_matched_games")
        self.assertEqual(result["evaluation"], {})

    def plan_for_case(self):
        start = self.match["info"]["gameStartTimestamp"]
        return {"schemaVersion": 1, "validationFrom": evaluator.iso(start - 2000),
                "testFrom": evaluator.iso(start - 1000), "testUntil": evaluator.iso(start + 1),
                "queue": self.record["queue"], "modelVersion": self.record["modelVersion"],
                "comparisonScores": ["current", "metaOnly", "constant50"], "primaryMetric": "logLoss",
                "minimumPracticalImprovement": 0}

    def test_plan_cohort_and_canonical_hash(self):
        plan = self.plan_for_case()
        report = evaluator.evaluate([self.record], [self.match], plan=plan)
        self.assertEqual(report["status"], "evaluated")
        self.assertEqual(report["planSha256"], evaluator.plan_digest(dict(reversed(list(plan.items())))))
        self.assertEqual(len(report["planSha256"]), 64)
        self.assertEqual(set(report["evaluation"][self.record["modelVersion"]]["models"]), set(plan["comparisonScores"]))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            path.write_text(json.dumps(plan, indent=2))
            self.assertEqual(evaluator.load_plan(path), plan)
        for kwargs in ({"queue": 420 if plan["queue"] != 420 else 440},
                       {"validation_from": evaluator.iso(self.match["info"]["gameStartTimestamp"] - 3000)},
                       {"test_from": evaluator.iso(self.match["info"]["gameStartTimestamp"] - 500)},
                       {"require_complete_history": True}):
            with self.assertRaises(ValueError):
                evaluator.evaluate([self.record], [self.match], plan=plan, **kwargs)

    def test_strict_plan_rejects_malformed_or_unknown_options_even_without_data(self):
        for changes in ({"schemaVersion": True}, {"queue": True}, {"primaryMetric": "accuracy"},
                        {"comparisonScores": ["current", "current"]}, {"comparisonScores": ["metaOnly"]},
                        {"minimumPracticalImprovement": float("nan")}, {"minimumDurationSeconds": -1},
                        {"requireCompleteHistory": "true"}, {"unrecognized": 1}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                evaluator.evaluate([], [], plan={**self.plan_for_case(), **changes})
        plan = self.plan_for_case()
        plan["testUntil"] = plan["testFrom"]
        with self.assertRaises(ValueError):
            evaluator.evaluate([], [], plan=plan)

    def test_plan_excludes_wrong_cohorts_and_missing_scores_without_comparing_partial_rows(self):
        plan = self.plan_for_case()
        cases = [({"queue": 420 if plan["queue"] != 420 else 440}, "queue_filter"),
                 ({"modelVersion": "absent-model-version"}, "model_version_filter"),
                 ({"comparisonScores": ["current", "noSynergy"]}, "missing_comparison_scores"),
                 ({"testUntil": evaluator.iso(self.match["info"]["gameStartTimestamp"])}, "after_test_window"),
                 ({"minimumDurationSeconds": self.match["info"]["gameDuration"] + 1}, "below_minimum_duration")]
        for changes, reason in cases:
            with self.subTest(reason=reason):
                report = evaluator.evaluate([self.record], [self.match], plan={**plan, **changes})
                self.assertEqual(report["status"], "no_games_in_cohort")
                self.assertEqual(report["exclusions"][reason], 1)
                self.assertEqual(report["evaluation"], {})
        missing_duration = deepcopy(self.match)
        missing_duration["info"].pop("gameDuration")
        report = evaluator.evaluate([self.record], [missing_duration], plan={**plan, "minimumDurationSeconds": 0})
        self.assertEqual(report["exclusions"]["duration_unknown"], 1)

    def test_plan_missing_score_keeps_one_identical_comparison_cohort(self):
        second_record = second_match = None
        for index in range(1, len(PLAYERS["stacks"])):
            try:
                record, match = recorded_case(index)
            except IndexError:
                break
            if record["queue"] == self.record["queue"]:
                second_record, second_match = record, match
                break
        self.assertIsNotNone(second_record)
        second_record["scores"].pop("metaOnly")
        starts = [self.match["info"]["gameStartTimestamp"], second_match["info"]["gameStartTimestamp"]]
        plan = {**self.plan_for_case(), "validationFrom": evaluator.iso(min(starts) - 2),
                "testFrom": evaluator.iso(min(starts) - 1), "testUntil": evaluator.iso(max(starts) + 1)}
        report = evaluator.evaluate([self.record, second_record], [self.match, second_match], plan=plan)
        self.assertEqual(report["matchedBeforeCohortFilter"], 2)
        self.assertEqual(report["matchedGames"], 1)
        self.assertEqual(report["exclusions"]["missing_comparison_scores"], 1)
        self.assertEqual(report["missingPlannedScoresBeforeCohortFilter"]["metaOnly"], 1)
        models = report["evaluation"][self.record["modelVersion"]]["models"]
        self.assertEqual({model["overall"]["n"] for model in models.values()}, {1})
        linked = evaluator.link_records([self.record, second_record], [self.match, second_match])[0]
        with self.assertRaises(ValueError):
            evaluator.paired_day_bootstrap(linked, "metaOnly")

    def test_plan_boundaries_assign_equal_timestamps_to_later_split(self):
        start = self.match["info"]["gameStartTimestamp"]
        validation = {**self.plan_for_case(), "validationFrom": evaluator.iso(start),
                      "testFrom": evaluator.iso(start + 1), "testUntil": evaluator.iso(start + 2)}
        report = evaluator.evaluate([self.record], [self.match], split="validation", plan=validation)
        self.assertEqual(report["splitCounts"], {"train": 0, "validation": 1, "test": 0})
        test = {**self.plan_for_case(), "testFrom": evaluator.iso(start)}
        report = evaluator.evaluate([self.record], [self.match], plan=test)
        self.assertEqual(report["splitCounts"], {"train": 0, "validation": 0, "test": 1})

    def test_history_filter_preserves_unknown_and_incomplete_distinction(self):
        rows, _ = evaluator.link_records([self.record], [self.match])
        self.assertIsNone(rows[0]["historyComplete"])
        selected, reasons = evaluator.filter_cohort(rows, require_complete_history=True)
        self.assertEqual(selected, [])
        self.assertEqual(reasons, {"history_unknown": 1})
        # Completeness flags are predicate probes; the historical outcome is unchanged.
        for complete in (False, True):
            record = deepcopy(self.record)
            record["history"] = {"complete": complete}
            record["evaluationCohort"] = {"historyComplete": complete}
            report = evaluator.evaluate([record], [self.match], plan={**self.plan_for_case(), "requireCompleteHistory": True})
            self.assertEqual(report["matchedGames"], int(complete))
            self.assertEqual(report["readinessBeforeCohortFilter"]["historyCounts"]["complete" if complete else "incomplete"], 1)
        record["evaluationCohort"]["historyComplete"] = False
        self.assertEqual(evaluator.link_records([record], [self.match])[1]["invalid_record"], 1)

    def test_capture_snapshots_pass_through_without_player_identity_or_outcome_features(self):
        record = deepcopy(self.record)
        # Mechanically project the existing meta-only score into the new snapshot schema.
        # These are contract probes, never historical model features or predictions.
        score = record["scores"]["current"]
        record["components"] = {name: 0.0 for name in evaluator.COMPONENT_NAMES}
        record["components"].update({"personal": score, "meta": score, "player": score, "rawTotal": score})
        record["captureStage"], record["side"] = "pregame", 100
        record["history"] = deepcopy(PLAYERS["history"])
        record["evidence"] = []
        for slot in record["comp"]:
            player = next(p for p in PLAYERS["players"] if p["riotId"] == slot["riotId"])
            champion = next(c for c in player["champions"] if c["championId"] == slot["championId"])
            record["evidence"].append({"riotId": slot["riotId"], "championId": slot["championId"], "role": slot["role"],
                                       "effectiveGames": champion["games"], "effectiveWins": champion["wins"], "priorSource": "neutral"})
        linked, _ = evaluator.link_records([record], [self.match])
        row = linked[0]
        self.assertEqual(row["components"], record["components"])
        self.assertEqual(row["capturedSide"], 100)
        self.assertEqual(row["actualSide"], 100)
        self.assertEqual(row["captureStage"], "pregame")
        self.assertEqual(row["historyComplete"], PLAYERS["history"]["complete"])
        self.assertEqual(row["evidence"][0]["effectiveWins"], record["evidence"][0]["effectiveWins"])
        self.assertNotIn("riotId", row["evidence"][0])
        record["components"]["personal"] = 0
        record["history"]["complete"] = not PLAYERS["history"]["complete"]
        self.assertEqual(row["components"]["personal"], score)
        self.assertEqual(row["provenance"]["history"]["complete"], PLAYERS["history"]["complete"])

    def test_invalid_new_snapshots_and_future_player_data_are_rejected(self):
        probes = [{"side": 300}, {"side": True}, {"captureStage": "postgame"},
                  {"components": {name: float("inf") for name in evaluator.COMPONENT_NAMES}},
                  {"components": {"personal": .5}}, {"evaluationCohort": {"historyComplete": "true"}},
                  {"evidence": [{"effectiveGames": 0, "effectiveWins": 1}]},
                  {"dataGeneratedAt": evaluator.iso(self.match["info"]["gameStartTimestamp"])}]
        for probe in probes:
            with self.subTest(fields=list(probe)):
                _, reasons = evaluator.link_records([{**self.record, **probe}], [self.match])
                self.assertEqual(reasons["invalid_record"], 1)

    def test_side_is_matched_only_when_captured_and_outcome_time_uses_observed_duration(self):
        record = {**self.record, "side": 200}
        self.assertEqual(evaluator.link_records([record], [self.match])[1]["no_eligible_match"], 1)
        row = evaluator.link_records([self.record], [self.match])[0][0]
        self.assertIsNone(row["capturedSide"])
        self.assertEqual(row["outcomeAvailableMs"], row["startMs"] + self.match["info"]["gameDuration"] * 1000)
        no_duration = deepcopy(self.match)
        no_duration["info"].pop("gameDuration")
        self.assertIsNone(evaluator.link_records([self.record], [no_duration])[0][0]["outcomeAvailableMs"])
        no_duration["info"]["gameEndTimestamp"] = row["outcomeAvailableMs"]
        self.assertEqual(evaluator.link_records([self.record], [no_duration])[0][0]["outcomeAvailableMs"], row["outcomeAvailableMs"])

    def test_auc_ties_and_wilson_intervals_use_recorded_outcomes(self):
        rows = []
        for index in range(len(PLAYERS["stacks"])):
            try:
                record, match = recorded_case(index)
            except IndexError:
                break
            rows.extend(evaluator.link_records([record], [match])[0])
            if len(rows) >= 12 and len({row["outcome"] for row in rows}) == 2:
                break
        self.assertEqual({row["outcome"] for row in rows}, {0, 1})
        values = [(row["scores"]["current"], row["outcome"]) for row in rows]
        positives = [p for p, y in values if y]
        negatives = [p for p, y in values if not y]
        pairwise = sum(1 if p > q else .5 if p == q else 0 for p in positives for q in negatives) / (len(positives) * len(negatives))
        self.assertAlmostEqual(evaluator.metrics(rows, "current")["auc"], pairwise)
        tied = evaluator.metrics(rows, "constant50")
        self.assertEqual(tied["auc"], .5)
        self.assertIsNone(evaluator.metrics(rows[:1], "current")["auc"])
        interval = tied["reliability"][0]["observedWinRateInterval95"]
        self.assertLess(interval[0], tied["observedWinRate"])
        self.assertGreater(interval[1], tied["observedWinRate"])
        self.assertTrue(all(math.isfinite(x) and 0 <= x <= 1 for x in interval))
        self.assertIn("proportion only", tied["reliability"][0]["intervalMethod"])


if __name__ == "__main__":
    unittest.main()

class AutomaticEvaluationTests(unittest.TestCase):
    def test_automatic_capture_checks_opponents_receipt_and_shorter_horizon(self):
        match = json.loads((ROOT / 'tests/fixtures/recorded-flex-match.json').read_text())
        team = [p for p in match['info']['participants'] if p['teamId'] == 100]
        captured = evaluator.iso(match['info']['gameStartTimestamp'] - 60000)
        record = {'id': match['metadata']['matchId'], 'modelVersion': 'transport-baseline',
                  'capturedAt': captured, 'captureStage': 'pregame', 'queue': 440,
                  'scores': {'current': .5},
                  'comp': [{'riotId': p['riotIdGameName']+'#'+p['riotIdTagline'],
                            'puuid': p['puuid'], 'championId': p['championId'], 'role': p['teamPosition']}
                           for p in team],
                  'opponents': [{'championId': p['championId']} for p in match['info']['participants'] if p['teamId'] == 200],
                  'automatic': {'source': 'live-draft-browser', 'sessionId': match['metadata']['matchId'], 'receivedAt': captured}}
        self.assertEqual(len(evaluator.link_records([record], [match])[0]), 1)
        wrong = deepcopy(record)
        wrong['opponents'][0]['championId'] = team[0]['championId']
        self.assertFalse(evaluator.link_records([wrong], [match])[0])
        early = deepcopy(record)
        early['capturedAt'] = evaluator.iso(match['info']['gameStartTimestamp'] - 16 * 60000)
        early['automatic']['receivedAt'] = early['capturedAt']
        self.assertFalse(evaluator.link_records([early], [match])[0])
        del record['automatic']['receivedAt']
        with self.assertRaises(ValueError):
            evaluator.validate_record(record)

    def test_worker_provenance_allows_later_receipt_but_never_changes_computation_time(self):
        record, _ = recorded_case()
        captured = evaluator.timestamp(record['capturedAt'])
        source = (ROOT / 'worker/src/scoring.generated.mjs').read_text()
        digest = evaluator.re.search(r'SCORING_SOURCE_SHA = "([0-9a-f]+)"', source).group(1)
        record['automatic'] = {'source': 'live-draft-worker', 'sessionId': record['id'],
                               'computedAt': record['capturedAt'], 'receivedAt': evaluator.iso(captured + 120000),
                               'scoringSourceSha': digest}
        evaluator.validate_record(record)
        for key, value in [('computedAt', evaluator.iso(captured + 1)),
                           ('receivedAt', evaluator.iso(captured - 1)), ('scoringSourceSha', '')]:
            wrong = deepcopy(record)
            wrong['automatic'][key] = value
            with self.assertRaises(ValueError):
                evaluator.validate_record(wrong)

    def test_capture_policy_plan_excludes_browser_and_missing_settings(self):
        record, match = recorded_case()
        record['settings'] = {'capturePolicy': 'server-standard-v1'}
        rows, _ = evaluator.link_records([record], [match])
        plan = {'schemaVersion': 1, 'validationFrom': '2027-01-01', 'testFrom': '2027-02-01',
                'queue': match['info']['queueId'], 'modelVersion': record['modelVersion'],
                'comparisonScores': ['current'], 'primaryMetric': 'logLoss', 'capturePolicy': 'server-standard-v1'}
        self.assertEqual(len(evaluator.filter_cohort(rows, plan=plan)[0]), 1)
        for settings in ({}, {'capturePolicy': 'actual-live-picks-v1'}):
            record['settings'] = settings
            rows, _ = evaluator.link_records([record], [match])
            selected, reasons = evaluator.filter_cohort(rows, plan=plan)
            self.assertEqual(selected, [])
            self.assertEqual(reasons, {'capture_policy_filter': 1})
