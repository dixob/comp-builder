"""Mechanical model checks on recorded matches, never historical predictions.

Win/loss labels and compositions come from checked-in scoreboards. Meta values
are projected into feature columns solely to test numerical code and time
boundaries. These inputs must not be used to report product accuracy.
"""
from copy import deepcopy
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import validate_scoring_models as models
from test_evaluation import PLAYERS, recorded_case


def recorded_inputs():
    records, matches = [], []
    stacks = {stack["id"]: stack for stack in PLAYERS["stacks"]}
    for index in range(len(stacks)):
        try:
            record, match = recorded_case(index)
        except IndexError:
            break
        if record["queue"] != 440:
            continue
        prior = record["scores"]["current"]
        record["captureStage"] = "pregame"
        record["components"] = {"personal": prior, "meta": prior, "player": prior,
                                "comfort": 0, "rolePenalty": 0, "matchup": 0,
                                "championSynergy": 0, "playerSynergy": 0, "rawTotal": prior}
        stack = stacks[record["id"]]
        match["info"]["gameDuration"] = stack["secs"]
        match["info"]["gameEndTimestamp"] = stack["ts"]
        records.append(record)
        matches.append(match)
    order = sorted(range(len(records)), key=lambda i: matches[i]["info"]["gameStartTimestamp"])
    return [records[i] for i in order], [matches[i] for i in order]


class ScoringModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records, cls.matches = recorded_inputs()
        cls.plan = {"schemaVersion": 1,
                    "validationFrom": cls.records[len(cls.records) // 2]["capturedAt"],
                    "testFrom": cls.records[len(cls.records) * 3 // 4]["capturedAt"],
                    "queue": 440, "modelVersion": cls.records[0]["modelVersion"],
                    "comparisonScores": ["current", "metaOnly", "constant50"],
                    "primaryMetric": "logLoss"}

    def test_finite_fit_with_correlated_and_constant_recorded_features(self):
        rows = models.ev.link_records(self.records, self.matches)[0]
        x, y = [models.components(row) for row in rows], [row["outcome"] for row in rows]
        fitted = models.fit_logistic(x, y, models.FEATURES)
        self.assertLess(fitted["iterations"], 5001)
        probabilities = [models.predict(fitted, features) for features in x]
        self.assertTrue(all(0 < p < 1 for p in probabilities))
        self.assertEqual(fitted["scales"][3:], [1.0] * 5)
        # The numerical optimizer cannot be worse on its penalized fitting
        # objective than the feasible intercept-only initialization.
        loss = -sum(v * math.log(p) + (1-v) * math.log(1-p)
                    for v, p in zip(y, probabilities)) / len(y)
        loss += .1 / 2 * sum(w*w for w in fitted["weights"])
        rate = sum(y) / len(y)
        initial = -rate * math.log(rate) - (1-rate) * math.log(1-rate)
        self.assertLessEqual(loss, initial + 1e-10)

    def test_calibration_is_monotonic(self):
        rows = models.ev.link_records(self.records, self.matches)[0]
        x = [[row["scores"]["current"]] for row in rows]
        fitted = models.fit_logistic(x, [row["outcome"] for row in rows], ["current"], nonnegative=True)
        ordered = sorted(row[0] for row in x)
        predictions = [models.predict(fitted, [value]) for value in ordered]
        self.assertEqual(predictions, sorted(predictions))
        self.assertGreaterEqual(fitted["weights"][0], 0)

    def test_validation_never_fits_or_evaluates_calibrator(self):
        report = models.validate_models(self.records, self.matches, self.plan,
                                        min_train=2, min_validation=2, min_evaluation=2)
        self.assertEqual(report["status"], "evaluated")
        self.assertIsNone(report["fittedModels"]["currentCalibrator"])
        self.assertNotIn("calibratedCurrent", report["evaluation"])
        self.assertIn("trainedComponents", report["evaluation"])

    def test_future_records_do_not_change_fitted_parameters(self):
        report = models.validate_models(self.records, self.matches, self.plan, split="test",
                                        min_train=2, min_validation=2, min_evaluation=2)
        self.assertEqual(report["status"], "evaluated")
        future_id = report["evaluationMatchIds"][-1]
        reduced = models.validate_models([r for r in self.records if r["id"] != future_id], self.matches,
                                         self.plan, split="test", min_train=2, min_validation=2,
                                         min_evaluation=2)
        self.assertEqual(report["fittedModels"], reduced["fittedModels"])
        self.assertNotEqual(report["inputRecordsSha256"], reduced["inputRecordsSha256"])
        fitting_ids = set(report["fittedModels"]["trainingMatchIds"] + report["fittedModels"]["calibrationMatchIds"])
        self.assertFalse(fitting_ids & set(report["evaluationMatchIds"]))

    def test_time_boundaries_require_available_outcomes_and_frozen_model(self):
        rows = models.ev.link_records(self.records, self.matches)[0]
        plan = deepcopy(self.plan)
        validation = models.ev.timestamp(plan["validationFrom"])
        train = next(deepcopy(row) for row in rows if row["startMs"] < validation)
        train["outcomeAvailableMs"] = validation  # exact-cutoff boundary probe
        selected = next(deepcopy(row) for row in rows if validation <= row["startMs"] < models.ev.timestamp(plan["testFrom"]))
        selected["capturedAt"] = models.ev.iso(validation - 1)
        partitions, excluded = models.partition_rows([train, selected], plan)
        self.assertTrue(all(not values for values in partitions.values()))
        self.assertEqual(excluded["outcome_after_model_freeze"], 1)
        self.assertEqual(excluded["capture_precedes_model_freeze"], 1)

    def test_missing_features_and_insufficient_data_never_produce_fitted_results(self):
        records = deepcopy(self.records)
        for record in records:
            record.pop("components")
        result = models.validate_models(records, self.matches, self.plan)
        self.assertEqual(result["status"], "insufficient_data")
        self.assertNotIn("fittedModels", result)
        self.assertNotIn("evaluation", result)
        self.assertGreater(result["exclusions"]["frozenFeatures"]["missing_frozen_components"], 0)
        empty = models.validate_models([], [], self.plan)
        self.assertEqual(empty["status"], "insufficient_data")

    def test_fit_rejects_invalid_and_single_class_inputs(self):
        rows = models.ev.link_records(self.records, self.matches)[0]
        wins = [row for row in rows if row["outcome"] == 1]
        with self.assertRaises(ValueError):
            models.fit_logistic([models.components(row) for row in wins], [row["outcome"] for row in wins], models.FEATURES)
        for penalty in (0, -1, float("nan"), True):
            with self.assertRaises(ValueError):
                models.validate_models([], [], self.plan, regularization=penalty)

    def test_plan_cannot_overwrite_generated_comparisons(self):
        for name in ("trainedComponents", "trainingBaseRate", "calibratedCurrent", "referenceCurrent"):
            plan = deepcopy(self.plan)
            plan["comparisonScores"].append(name)
            with self.assertRaisesRegex(ValueError, "generated model names"):
                models.validate_models([], [], plan)


if __name__ == "__main__":
    unittest.main()
