#!/usr/bin/env python3
"""Generate bounded, task-balanced preference pairs with hard-negative priority."""
from __future__ import annotations
import argparse, random
from collections import defaultdict
from pathlib import Path
from ml.common import read_jsonl, write_jsonl
def generate(rows, cap=200, seed=42):
    rng=random.Random(seed); tasks=defaultdict(list)
    for row in rows: tasks[row["taskId"]].append(row)
    output=[]
    for task_id,candidates in sorted(tasks.items()):
        possible=[(a,b) for a in candidates for b in candidates if a["label"]>b["label"]]
        def priority(pair):
            kind=pair[1].get("negativeType",""); weight=0 if kind in {"high-bm25","same-package","similar-symbol"} else 1
            return (weight,-pair[1]["features"]["bm25Score"],pair[0]["candidateId"],pair[1]["candidateId"])
        possible.sort(key=priority); hard=possible[:int(cap*.85)]; remaining=possible[len(hard):]; rng.shuffle(remaining)
        for positive,negative in (hard+remaining[:max(0,cap-len(hard))])[:cap]: output.append({"taskId":task_id,"positiveId":positive["candidateId"],"negativeId":negative["candidateId"],"positiveFeatures":positive["features"],"negativeFeatures":negative["features"],"labelGap":positive["label"]-negative["label"]})
    return output
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("dataset",type=Path); parser.add_argument("output",type=Path); parser.add_argument("--cap",type=int,default=200); parser.add_argument("--seed",type=int,default=42); args=parser.parse_args(); write_jsonl(args.output,generate(read_jsonl(args.dataset),args.cap,args.seed))
if __name__ == "__main__": main()
