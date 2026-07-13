#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from pathlib import Path
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("report",type=Path); parser.add_argument("output",type=Path); args=parser.parse_args(); data=json.loads(args.report.read_text()); failures=sorted(data["perTask"].items(),key=lambda item:(item[1]["recallAt5"],item[1]["mrr"]))[:20]; args.output.write_text("# Error analysis\n\n"+"\n".join(f"- `{task}`: first relevant rank {metrics['firstRelevantRank']}" for task,metrics in failures)+"\n")
if __name__ == "__main__": main()
