#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from ml.common import FEATURES, read_jsonl, seed_everything, validate_rows, write_jsonl
from ml.data.generate_pairs import generate
from ml.evaluation.metrics import aggregate, task_metrics
from ml.models.neural_ranker import NomicNeuralRanker, pairwise_loss
from ml.training.early_stopping import EarlyStopping
from ml.training.run_utils import prepare_run, save_normalization


def normalized_tensor(rows, mean, scale):
    return torch.tensor(
        np.asarray(
            [
                [
                    (float(row["features"].get(feature, 0.0)) - mean[index])
                    / scale[index]
                    for index, feature in enumerate(FEATURES)
                ]
                for row in rows
            ],
            dtype="float32",
        )
    )


def pair_tensors(rows, pairs, mean, scale):
    lookup = {(row["taskId"], row["candidateId"]): row for row in rows}
    positives = [lookup[(pair["taskId"], pair["positiveId"])] for pair in pairs]
    negatives = [lookup[(pair["taskId"], pair["negativeId"])] for pair in pairs]
    return normalized_tensor(positives, mean, scale), normalized_tensor(negatives, mean, scale)


def evaluate(rows, score_key):
    tasks = defaultdict(list)
    for row in rows:
        tasks[row["taskId"]].append(row)

    def result(values):
        ranked = sorted(
            values,
            key=lambda row: (-float(row[score_key]), row["candidateId"]),
        )
        return task_metrics([row["label"] for row in ranked])

    end_to_end = [result(values) for values in tasks.values()]
    conditional = [
        result(values)
        for values in tasks.values()
        if any(row["label"] > 0 for row in values)
    ]
    return {
        "endToEnd": aggregate(end_to_end),
        "conditional": aggregate(conditional),
        "conditionalTasks": len(conditional),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--objective", choices=["margin", "ranknet"], default="margin")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument(
        "--split-strategy", choices=["repository", "temporal"], default="repository"
    )
    args = parser.parse_args()
    rows = read_jsonl(args.dataset)
    errors = validate_rows(rows, split_strategy=args.split_strategy)
    if errors:
        raise SystemExit("\n".join(errors))

    seed_everything(args.seed)
    run, _ = prepare_run(
        args.output,
        {
            "model": "neural",
            "objective": args.objective,
            "seed": args.seed,
            "split_strategy": args.split_strategy,
        },
        rows,
        args.seed,
    )
    training = [row for row in rows if row["split"] == "train"]
    validation = [row for row in rows if row["split"] == "validation"]
    raw = np.asarray(
        [[row["features"][feature] for feature in FEATURES] for row in training],
        dtype="float32",
    )
    mean, scale = save_normalization(run, raw)
    training_pairs = generate(training, 200, args.seed)
    validation_pairs = generate(validation, 200, args.seed)
    if not training_pairs:
        raise ValueError("training split produced no preference pairs")
    positive, negative = pair_tensors(training, training_pairs, mean, scale)
    validation_positive, validation_negative = pair_tensors(
        validation, validation_pairs, mean, scale
    )

    model = NomicNeuralRanker(len(FEATURES))
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    stopping = EarlyStopping(12)
    best = None
    with (run / "training_log.jsonl").open("w") as log:
        for epoch in range(args.epochs):
            model.train()
            optimizer.zero_grad()
            loss = pairwise_loss(
                model(positive), model(negative), args.objective
            )
            loss.backward()
            optimizer.step()
            model.eval()
            with torch.no_grad():
                validation_loss = pairwise_loss(
                    model(validation_positive),
                    model(validation_negative),
                    args.objective,
                )
            value = float(validation_loss)
            log.write(
                json.dumps(
                    {
                        "epoch": epoch,
                        "trainingPairLoss": float(loss),
                        "validationPairLoss": value,
                    }
                )
                + "\n"
            )
            if stopping.update(value):
                best = {
                    key: tensor.detach().clone()
                    for key, tensor in model.state_dict().items()
                }
            elif stopping.should_stop:
                break

    if best is None:
        raise RuntimeError("neural training did not produce a checkpoint")
    model.load_state_dict(best)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "mean": torch.from_numpy(mean),
            "scale": torch.from_numpy(scale),
            "featureCount": len(FEATURES),
        },
        run / "model.pt",
    )

    model.eval()
    predictions = []
    with torch.no_grad():
        scores = model(normalized_tensor(rows, mean, scale)).tolist()
    for row, score in zip(rows, scores):
        predictions.append(
            {
                **row,
                "score": float(score),
                "baselineScore": -float(row["features"]["bm25Rank"]),
            }
        )
    write_jsonl(run / "predictions.jsonl", predictions)
    metrics = {
        "bestValidationPairLoss": stopping.best,
        "trainingPairs": len(training_pairs),
        "validationPairs": len(validation_pairs),
        "splits": {},
    }
    for split in ("train", "validation", "test"):
        selected = [row for row in predictions if row["split"] == split]
        metrics["splits"][split] = {
            "tasks": len({row["taskId"] for row in selected}),
            "baseline": evaluate(selected, "baselineScore"),
            "learned": evaluate(selected, "score"),
        }
    (run / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")


if __name__ == "__main__":
    main()
