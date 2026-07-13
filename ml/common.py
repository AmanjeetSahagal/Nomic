"""Shared schema and JSONL helpers. This module intentionally has no ML dependencies."""
from __future__ import annotations

import hashlib
import json
import random
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = "ranking-features-v1"
FEATURES = [
    "bm25Score", "normalizedBm25Score", "bm25Rank", "topScoreMargin",
    "exactSymbolMatch", "prefixSymbolMatch", "symbolTokenOverlap", "matchingSymbolCount", "symbolTypeId",
    "filenameOverlap", "pathTokenOverlap", "directoryDepth", "fileExtensionId",
    "isImplementationFile", "isTestFile", "isDocumentationFile", "isGeneratedFile",
    "queryTermCoverage", "rareTermMatchCount", "identifierOverlap", "commentOverlap",
    "chunkTokenCount", "symbolLineCount", "codeToCommentRatio", "repositoryLanguageId",
    "repositoryFileCountBucket", "inboundDependencyCount", "dependencyDistance",
]
SPLITS = ("train", "validation", "test")

def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]

def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")

def stable_id(value: str, modulo: int = 127) -> int:
    # FNV-1a over ASCII category names; kept byte-for-byte aligned with TypeScript runtime extraction.
    value_hash = 2166136261
    for character in value.lower():
        value_hash ^= ord(character)
        value_hash = (value_hash * 16777619) & 0xFFFFFFFF
    return value_hash % modulo

def validate_rows(rows: list[dict[str, Any]], require_split: bool = True, split_strategy: str = "repository") -> list[str]:
    errors: list[str] = []
    task_fields = {"taskId", "repository", "baseCommit", "query", "candidateId", "candidatePath", "label", "labelSource", "features"}
    task_splits: dict[str, set[str]] = defaultdict(set)
    commit_splits: dict[str, set[str]] = defaultdict(set)
    patch_splits: dict[str, set[str]] = defaultdict(set)
    query_splits: dict[str, set[str]] = defaultdict(set)
    repository_splits: dict[str, set[str]] = defaultdict(set)
    for number, row in enumerate(rows, 1):
        missing = task_fields - row.keys()
        if missing: errors.append(f"row {number}: missing {sorted(missing)}"); continue
        if row["label"] not in (0, 1, 2, 3): errors.append(f"row {number}: label outside 0..3")
        absent = set(FEATURES) - row["features"].keys()
        extra = set(row["features"]) - set(FEATURES)
        if absent or extra: errors.append(f"row {number}: feature mismatch absent={sorted(absent)} extra={sorted(extra)}")
        split = row.get("split")
        if require_split and split not in SPLITS: errors.append(f"row {number}: invalid split {split!r}")
        if split in SPLITS:
            repository_splits[row["repository"]].add(split)
            task_splits[row["taskId"]].add(split); commit_splits[row["baseCommit"]].add(split)
            query_splits[hashlib.sha256(row["query"].strip().lower().encode()).hexdigest()].add(split)
            if row.get("patchCommit"): patch_splits[row["patchCommit"]].add(split)
    for name, values in (("task", task_splits), ("base commit", commit_splits), ("patch", patch_splits), ("query", query_splits)):
        for key, splits in values.items():
            if len(splits) > 1: errors.append(f"{name} leakage: {key} appears in {sorted(splits)}")
    if split_strategy == "repository":
        for repository, splits in repository_splits.items():
            if len(splits) > 1: errors.append(f"repository leakage: {repository} appears in {sorted(splits)}")
    return errors

def matrix(rows: list[dict[str, Any]], split: str):
    selected = sorted((row for row in rows if row.get("split") == split), key=lambda row: (row["taskId"], row["candidateId"]))
    x = [[float(row["features"].get(feature, 0.0)) for feature in FEATURES] for row in selected]
    y = [int(row["label"]) for row in selected]
    groups = Counter(row["taskId"] for row in selected)
    return selected, x, y, [groups[task] for task in dict.fromkeys(row["taskId"] for row in selected)]

def seed_everything(seed: int) -> None:
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except ImportError: pass
    try:
        import torch
        torch.manual_seed(seed); torch.use_deterministic_algorithms(True)
    except ImportError: pass
