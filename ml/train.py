#!/usr/bin/env python3
"""Train reproducible Nomic ranking baselines from versioned JSONL features."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import onnxmltools
from onnxmltools.convert.common.data_types import FloatTensorType
from sklearn.linear_model import LogisticRegression
from skl2onnx import convert_sklearn


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_rows(path: Path, features: list[str], split_strategy: str) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    required = {"taskId", "repositoryId", "split", "label", "features"}
    for row in rows:
        missing = required - row.keys()
        if missing:
            raise ValueError(f"row missing fields: {sorted(missing)}")
        absent_features = set(features) - row["features"].keys()
        if absent_features:
            raise ValueError(f"row missing features: {sorted(absent_features)}")
    validate_splits(rows, split_strategy)
    return rows


def validate_splits(rows: list[dict[str, Any]], split_strategy: str) -> None:
    if split_strategy == "temporal":
        for row in rows:
            if "mergedAt" not in row:
                raise ValueError("temporal splits require mergedAt on every row")
        ranks = {"train": 0, "validation": 1, "test": 2}
        by_repository: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            by_repository.setdefault(row["repositoryId"], []).append(row)
        for repository, repository_rows in by_repository.items():
            ordered = sorted(repository_rows, key=lambda row: row["mergedAt"])
            seen = [ranks[row["split"]] for row in ordered]
            if seen != sorted(seen):
                raise ValueError(f"temporal split order moves backward for {repository}")
        return
    repositories: dict[str, set[str]] = {}
    for row in rows:
        repositories.setdefault(row["repositoryId"], set()).add(row["split"])
    leaked = [repository for repository, splits in repositories.items() if len(splits) > 1]
    if leaked:
        raise ValueError(f"repository split leakage detected: {sorted(leaked)}")


def matrix(rows: list[dict[str, Any]], features: list[str], split: str) -> tuple[np.ndarray, np.ndarray, list[int]]:
    selected = sorted((row for row in rows if row["split"] == split), key=lambda row: row["taskId"])
    x = np.asarray([[float(row["features"][name]) for name in features] for row in selected], dtype=np.float32)
    y = np.asarray([int(row["label"]) for row in selected], dtype=np.int32)
    groups: list[int] = []
    previous = None
    for row in selected:
        if row["taskId"] != previous:
            groups.append(0)
            previous = row["taskId"]
        groups[-1] += 1
    return x, y, groups


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("feature-manifest.json"))
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("artifacts"))
    parser.add_argument("--split-strategy", choices=["repository", "temporal"], default="repository")
    args = parser.parse_args()

    manifest = load_manifest(args.manifest)
    features = manifest["features"]
    rows = load_rows(args.dataset, features, args.split_strategy)
    x_train, y_train, train_groups = matrix(rows, features, "train")
    x_validation, y_validation, validation_groups = matrix(rows, features, "validation")
    if not len(x_train) or len(set(y_train.tolist())) < 2:
        raise ValueError("training split must contain positive and negative candidates")

    args.output.mkdir(parents=True, exist_ok=True)
    logistic = LogisticRegression(random_state=42, max_iter=1000).fit(x_train, y_train)
    logistic_onnx = convert_sklearn(
        logistic,
        initial_types=[("features", FloatTensorType([None, len(features)]))],
        target_opset=17,
    )
    (args.output / "logistic-baseline.onnx").write_bytes(logistic_onnx.SerializeToString())

    ranker = lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        n_estimators=200,
        learning_rate=0.05,
        num_leaves=31,
        random_state=42,
        deterministic=True,
        verbosity=-1,
    )
    fit_args: dict[str, Any] = {"group": train_groups}
    if len(x_validation):
        fit_args.update(eval_set=[(x_validation, y_validation)], eval_group=[validation_groups], eval_at=[5, 10])
    ranker.fit(x_train, y_train, **fit_args)
    ranker_onnx = onnxmltools.convert_lightgbm(
        ranker,
        initial_types=[("features", FloatTensorType([None, len(features)]))],
        target_opset=17,
    )
    (args.output / "ranker.onnx").write_bytes(ranker_onnx.SerializeToString())
    (args.output / "model-manifest.json").write_text(
        json.dumps({
            "featureVersion": manifest["featureVersion"],
            "modelVersion": "lightgbm-lambdarank-v1",
            "featureCount": len(features),
            "trainingRows": len(x_train),
            "validationRows": len(x_validation),
            "randomSeed": 42,
        }, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
