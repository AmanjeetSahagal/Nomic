#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from collections import defaultdict
from pathlib import Path
from ml.common import read_jsonl
from ml.evaluation.metrics import aggregate,task_metrics
def evaluate(rows,score_key="score"):
    tasks=defaultdict(list)
    for row in rows: tasks[row["taskId"]].append(row)
    per_task={task:task_metrics([r["label"] for r in sorted(values,key=lambda row:(-float(row.get(score_key,row["features"]["bm25Score"])),row["candidateId"]))]) for task,values in tasks.items()}
    return {"aggregate":aggregate(list(per_task.values())),"perTask":per_task}
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("predictions",type=Path); parser.add_argument("--output",type=Path); args=parser.parse_args(); result=evaluate(read_jsonl(args.predictions)); text=json.dumps(result,indent=2)+"\n"; args.output.write_text(text) if args.output else print(text,end="")
if __name__ == "__main__": main()
