#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from pathlib import Path
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("reports",type=Path,nargs="+"); parser.add_argument("--output",type=Path,required=True); args=parser.parse_args(); rows=[]
    for report in args.reports:
        data=json.loads(report.read_text()); metrics=data["aggregate"]; rows.append((report.stem,metrics))
    lines=["# Learned ranking comparison","","| Method | Recall@5 | Recall@10 | MRR | NDCG@10 |","|---|---:|---:|---:|---:|"]+[f"| {name} | {m['recallAt5']:.3f} | {m['recallAt10']:.3f} | {m['mrr']:.3f} | {m['ndcgAt10']:.3f} |" for name,m in rows]; args.output.write_text("\n".join(lines)+"\n")
if __name__ == "__main__": main()
