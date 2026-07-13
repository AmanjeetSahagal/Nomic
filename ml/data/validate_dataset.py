#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from collections import Counter
from pathlib import Path
from ml.common import read_jsonl, validate_rows
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("dataset",type=Path); parser.add_argument("--split-strategy",choices=["repository","temporal"],default="repository"); args=parser.parse_args(); rows=read_jsonl(args.dataset); errors=validate_rows(rows,split_strategy=args.split_strategy)
    if errors: raise SystemExit("\n".join(errors))
    print(json.dumps({"rows":len(rows),"tasks":len({r['taskId'] for r in rows}),"repositories":len({r['repository'] for r in rows}),"labels":Counter(r['label'] for r in rows)},default=dict))
if __name__ == "__main__": main()
