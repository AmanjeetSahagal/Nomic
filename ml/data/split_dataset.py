#!/usr/bin/env python3
"""Assign task-level repository-held-out or within-repository temporal splits."""
from __future__ import annotations
import argparse
from collections import defaultdict
from pathlib import Path
from ml.common import read_jsonl, write_jsonl

def split_repository(rows, validation_repositories, test_repositories):
    for row in rows:
        row["split"] = "test" if row["repository"] in test_repositories else "validation" if row["repository"] in validation_repositories else "train"
    return rows
def split_temporal(rows):
    tasks={};
    for row in rows: tasks[row["taskId"]]=(row["repository"],row.get("createdAt"))
    if any(not date for _,date in tasks.values()): raise ValueError("temporal split requires createdAt for every task")
    by_repo=defaultdict(list)
    for task,(repo,date) in tasks.items(): by_repo[repo].append((date,task))
    assignment={}
    for values in by_repo.values():
        values.sort(); n=len(values); train=max(1,int(n*.7)); validation=max(train+1,int(n*.85))
        for position,(_,task) in enumerate(values): assignment[task]="train" if position<train else "validation" if position<validation else "test"
    for row in rows: row["split"]=assignment[row["taskId"]]
    return rows
def split_first_experiment(rows, typescript_cutoff="2023-01-01T00:00:00Z"):
    """Train on Django, validate on older TypeScript, test on newer TypeScript and VS Code."""
    assignment={}
    for row in rows:
        task=row["taskId"]
        if task in assignment: continue
        repository=row["repository"]; created=row.get("createdAt")
        if repository == "django/django": split="train"
        elif repository == "microsoft/TypeScript":
            if not created: raise ValueError("first-experiment split requires TypeScript createdAt")
            split="validation" if created < typescript_cutoff else "test"
        elif repository == "microsoft/vscode": split="test"
        else: raise ValueError(f"first-experiment split does not define repository {repository}")
        assignment[task]=split
    for row in rows: row["split"]=assignment[row["taskId"]]
    return rows
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("dataset",type=Path); parser.add_argument("output",type=Path); parser.add_argument("--strategy",choices=["repository","temporal","first-experiment"],default="repository"); parser.add_argument("--validation-repository",action="append",default=[]); parser.add_argument("--test-repository",action="append",default=[]); parser.add_argument("--typescript-cutoff",default="2023-01-01T00:00:00Z"); args=parser.parse_args()
    rows=read_jsonl(args.dataset)
    rows=split_temporal(rows) if args.strategy=="temporal" else split_first_experiment(rows,args.typescript_cutoff) if args.strategy=="first-experiment" else split_repository(rows,set(args.validation_repository),set(args.test_repository))
    write_jsonl(args.output,rows)
if __name__ == "__main__": main()
