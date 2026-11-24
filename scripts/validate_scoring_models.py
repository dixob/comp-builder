#!/usr/bin/env python3
"""Offline validation of small scoring models from genuine pregame snapshots.

One observed match is one training row. Fit a regularized component model on
train data; fit an optional monotonic calibration on validation data; evaluate
on a later period. Nothing is installed in the app or sent to a model service.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import sys

try:
    from . import evaluate_predictions as ev
except ImportError:
    import evaluate_predictions as ev


FEATURES = ("personal", "meta", "player", "comfort", "rolePenalty", "matchup",
            "championSynergy", "playerSynergy")
ALGORITHM_VERSION = "2026-11-24.1"


def digest(value):
    hasher = hashlib.sha256()
    encoder = json.JSONEncoder(sort_keys=True, separators=(",", ":"), allow_nan=False)
    for chunk in encoder.iterencode(value):
        hasher.update(chunk.encode())
    return hasher.hexdigest()


def sigmoid(value):
    if value >= 0:
        return 1 / (1 + math.exp(-value))
    exp_value = math.exp(value)
    return exp_value / (1 + exp_value)


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def fit_logistic(features, outcomes, names, regularization=.1, nonnegative=False):
    """Minimize mean log loss + L2/2 on standardized slopes, not intercept.

    Standardization uses fitting rows only. A conservative Lipschitz step and
    projected gradient descent keep the scalar calibrator monotonic. This is
    deliberately a fixed small model, not an automated hyperparameter search.
    """
    if not numeric(regularization) or regularization <= 0:
        raise ValueError("regularization must be finite and positive")
    if not features or len(features) != len(outcomes) or not names:
        raise ValueError("fitting requires aligned, nonempty features and outcomes")
    if any(type(y) is not int or y not in (0, 1) for y in outcomes) or set(outcomes) != {0, 1}:
        raise ValueError("fitting requires both observed wins and losses")
    if any(len(row) != len(names) or not all(numeric(v) for v in row) for row in features):
        raise ValueError("features must be complete finite numeric vectors")
    n, width = len(features), len(names)
    means = [sum(row[j] / n for row in features) for j in range(width)]
    scales = [math.sqrt(sum((row[j] - means[j]) ** 2 / n for row in features))
              for j in range(width)]
    scales = [value if value > 1e-12 else 1.0 for value in scales]
    if not all(numeric(v) for v in means + scales):
        raise ValueError("feature scale exceeds numerical limits")
    x = [[1.0] + [(row[j] - means[j]) / scales[j] for j in range(width)] for row in features]
    base_rate = sum(outcomes) / n
    weights = [math.log(base_rate / (1 - base_rate))] + [0.0] * width
    # The Hessian spectral norm is bounded by its unregularized trace + L2.
    step = 1 / (sum(sum(v * v for v in row) for row in x) / (4 * n) + regularization)
    for iteration in range(1, 5001):
        gradient = [0.0] + [regularization * value for value in weights[1:]]
        for row, y in zip(x, outcomes):
            residual = (sigmoid(sum(a * b for a, b in zip(row, weights))) - y) / n
            for j, value in enumerate(row):
                gradient[j] += residual * value
        next_weights = [value - step * grad for value, grad in zip(weights, gradient)]
        if nonnegative:
            next_weights[1:] = [max(0.0, value) for value in next_weights[1:]]
        movement = max(abs(a - b) for a, b in zip(weights, next_weights))
        weights = next_weights
        if movement < 1e-9:
            break
    else:
        raise ValueError("model did not converge; no comparison was produced")
    return {"features": list(names), "means": means, "scales": scales,
            "intercept": weights[0], "weights": weights[1:], "regularization": regularization,
            "nonnegativeSlopes": nonnegative, "iterations": iteration, "fitMatches": n,
            "objective": "mean log loss + regularization / 2 * squared standardized slopes"}


def predict(model, values):
    if len(values) != len(model["features"]) or not all(numeric(v) for v in values):
        raise ValueError("prediction requires the complete frozen feature vector")
    linear = model["intercept"] + sum(
        weight * (value - mean) / scale
        for weight, value, mean, scale in zip(model["weights"], values, model["means"], model["scales"]))
    return sigmoid(linear)


def components(row):
    snapshot = row.get("components")
    if not isinstance(snapshot, dict) or not all(numeric(snapshot.get(name)) for name in FEATURES):
        return None
    return [snapshot[name] for name in FEATURES]


def partition_rows(rows, plan):
    """Require fitting outcomes to exist before the next model's freeze time."""
    validation = ev.timestamp(plan["validationFrom"], allow_date=True)
    test = ev.timestamp(plan["testFrom"], allow_date=True)
    partitions = {"train": [], "validation": [], "test": []}
    excluded = Counter()
    for row in rows:
        if components(row) is None:
            excluded["missing_frozen_components"] += 1
            continue
        if row.get("captureStage") != "pregame":
            excluded["missing_pregame_stage"] += 1
            continue
        start = row["startMs"]
        split = "train" if start < validation else "validation" if start < test else "test"
        captured = ev.timestamp(row["capturedAt"])
        if split != "train" and captured < (validation if split == "validation" else test):
            excluded["capture_precedes_model_freeze"] += 1
            continue
        if split != "test":
            available = row.get("outcomeAvailableMs")
            boundary = validation if split == "train" else test
            if not numeric(available) or available < start:
                excluded["missing_reliable_outcome_time"] += 1
                continue
            if available >= boundary:
                excluded["outcome_after_model_freeze"] += 1
                continue
        partitions[split].append(row)
    return partitions, dict(excluded)


def validate_models(records, matches, plan, *, split="validation", regularization=.1,
                    min_train=100, min_validation=50, min_evaluation=30):
    if split not in ("validation", "test"):
        raise ValueError("split must be validation or test")
    if any(type(n) is not int or n < 2 for n in (min_train, min_validation, min_evaluation)):
        raise ValueError("minimum sample guards must be integers of at least two")
    if not numeric(regularization) or regularization <= 0:
        raise ValueError("regularization must be finite and positive")
    # Validate even when called directly; use the same contract as the CLI.
    plan = ev.validate_plan(plan)
    reserved = {"trainedComponents", "trainingBaseRate", "calibratedCurrent", "referenceCurrent"}
    collisions = reserved.intersection(plan["comparisonScores"])
    if collisions:
        raise ValueError(f"plan comparisonScores uses generated model names: {sorted(collisions)}")
    linked, exclusions = ev.link_records(records, matches)
    rows, cohort_exclusions = ev.filter_cohort(linked, plan=plan)
    partitions, feature_exclusions = partition_rows(rows, plan)
    config = {"algorithmVersion": ALGORITHM_VERSION,
              "split": split, "regularization": regularization, "minTrain": min_train,
              "minValidation": min_validation, "minEvaluation": min_evaluation,
              "features": list(FEATURES), "calibration": "sigmoid(a + b * current), b >= 0"}
    report = {"status": "insufficient_data", "selectedSplit": split, "plan": plan,
              "planSha256": ev.plan_digest(plan), "configuration": config,
              "configurationSha256": digest(config),
              "inputRecordsSha256": digest(records),
              "inputMatchesSha256": digest(matches),
              "exclusions": {"matching": exclusions, "cohort": cohort_exclusions,
                             "frozenFeatures": feature_exclusions},
              "splitCounts": {key: len(value) for key, value in partitions.items()},
              "notice": "Offline comparison only; no model deployed. Sample guards are operational, not a power calculation. Unplayed alternatives have no observed outcome."}
    train, validation, selected = partitions["train"], partitions["validation"], partitions[split]
    failures = []
    if len(train) < min_train:
        failures.append(f"train requires at least {min_train} eligible matches")
    if len(selected) < min_evaluation:
        failures.append(f"{split} requires at least {min_evaluation} eligible matches")
    if {row["outcome"] for row in train} != {0, 1}:
        failures.append("train requires observed wins and losses")
    if split == "test":
        if len(validation) < min_validation:
            failures.append(f"calibration requires at least {min_validation} validation matches")
        if {row["outcome"] for row in validation} != {0, 1}:
            failures.append("calibration requires observed wins and losses")
    if failures:
        report["readiness"] = failures
        return report

    component_model = fit_logistic([components(row) for row in train],
                                   [row["outcome"] for row in train], FEATURES, regularization)
    calibrator = None
    if split == "test":
        calibrator = fit_logistic([[row["scores"]["current"]] for row in validation],
                                  [row["outcome"] for row in validation], ["current"],
                                  regularization, nonnegative=True)
    # Compare a smoothed training-period base rate alongside constant 50%.
    baseline = (sum(row["outcome"] for row in train) + 1) / (len(train) + 2)
    scored = deepcopy(selected)
    for row in scored:
        row["scores"] = {name: row["scores"][name] for name in plan["comparisonScores"]}
        row["scores"]["trainedComponents"] = predict(component_model, components(row))
        row["scores"]["trainingBaseRate"] = baseline
        if calibrator:
            row["scores"]["calibratedCurrent"] = predict(calibrator, [row["scores"]["current"]])
    names = list(scored[0]["scores"])
    model_report = {"componentModel": component_model, "currentCalibrator": calibrator,
                    "trainingBaseRate": baseline, "trainingMatchIds": [row["matchId"] for row in train],
                    "calibrationMatchIds": [row["matchId"] for row in validation] if calibrator else [],
                    "componentFreezeTime": plan["validationFrom"],
                    "calibrationFreezeTime": plan["testFrom"] if calibrator else None}
    comparisons = []
    for name in names:
        if name == "current":
            continue
        # Reuse paired day-block machinery, with candidate minus current.
        paired = deepcopy(scored)
        for row in paired:
            row["scores"]["referenceCurrent"] = row["scores"]["current"]
            row["scores"]["current"] = row["scores"][name]
        comparison = ev.paired_day_bootstrap(paired, "referenceCurrent")
        comparison.update({"candidate": name, "reference": "current",
                           "difference": "candidate minus current; negative is better"})
        comparisons.append(comparison)
    report.update({"status": "evaluated", "fittedModels": model_report,
                   "evaluation": {name: ev.metrics(scored, name) for name in names},
                   "comparisons": comparisons,
                   "evaluationMatchIds": [row["matchId"] for row in scored],
                   "calibrationNotice": "Calibrator fitted only on validation and evaluated only on test. Validation output omits the fitted calibrator."})
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("records", type=Path, help="original Compy pregame export")
    parser.add_argument("--matches", type=Path, default=Path("data/matches"))
    parser.add_argument("--plan", type=Path, required=True, help="frozen evaluation plan")
    parser.add_argument("--split", choices=("validation", "test"), default="validation")
    parser.add_argument("--regularization", type=float, default=.1)
    parser.add_argument("--min-train", type=int, default=100)
    parser.add_argument("--min-validation", type=int, default=50)
    parser.add_argument("--min-evaluation", type=int, default=30)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        records = ev.load_records(args.records)
        matches = [json.loads(path.read_text()) for path in sorted(args.matches.glob("*.json"))]
        report = validate_models(records, matches, ev.load_plan(args.plan), split=args.split,
                                 regularization=args.regularization, min_train=args.min_train,
                                 min_validation=args.min_validation, min_evaluation=args.min_evaluation)
        rendered = json.dumps(report, indent=2, allow_nan=False)
        if args.output:
            args.output.write_text(rendered + "\n")
        print(rendered)
        return 0 if report["status"] == "evaluated" else 2
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as exc:
        print(f"Model validation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
