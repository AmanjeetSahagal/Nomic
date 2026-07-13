#!/usr/bin/env python3
"""Convert reviewed task exports with top-50 BM25 candidates into versioned JSONL."""
from __future__ import annotations
import argparse
from pathlib import Path
from ml.common import write_jsonl
from ml.data.extract_features import extract

def label_for(task, candidate):
    path = candidate["path"]
    override = task.get("labelOverrides", {}).get(path)
    if override is not None: return int(override), "manual"
    positives = task.get("positiveFiles", [])
    if candidate.get("isTest") and path in positives: return 1, "patch-test"
    candidates_by_path = {value["path"]: value for value in task.get("candidates", [])}
    primary = next((positive for positive in positives if not candidates_by_path.get(positive, {}).get("isTest")), None)
    if path == primary: return 3, "patch-primary"
    if path in positives: return 1 if candidate.get("isTest") else 2, "patch-test" if candidate.get("isTest") else "patch-supporting"
    if path in task.get("supportingFiles", []): return 1, "manual"
    return 0, "retrieved-negative"

def build(tasks):
    rows=[]
    for task in tasks:
        candidates=task.get("candidates",[])[:50]; scores=sorted((float(c.get("bm25Score",c.get("score",0))) for c in candidates), reverse=True)
        for rank,candidate in enumerate(candidates,1):
            label,source=label_for(task,candidate)
            rows.append({"taskId":task["taskId"],"repository":task["repository"],"baseCommit":task["baseCommit"],"patchCommit":task.get("patchCommit"),"createdAt":task.get("createdAt"),"query":task["query"],"candidateId":candidate.get("id",candidate["path"]),"candidatePath":candidate["path"],"candidateSymbol":candidate.get("symbol"),"label":label,"labelSource":source,"negativeType":candidate.get("negativeType","high-bm25" if label==0 and rank<=10 else "random"),"features":extract(task["query"],candidate,rank,scores[0] if scores else 0,scores[1] if len(scores)>1 else 0,task.get("metadata",{}))})
    return rows

def main():
    import json
    parser=argparse.ArgumentParser(); parser.add_argument("tasks",type=Path); parser.add_argument("output",type=Path); args=parser.parse_args()
    tasks=[json.loads(line) for line in args.tasks.read_text().splitlines() if line.strip()]; write_jsonl(args.output,build(tasks))
if __name__ == "__main__": main()
