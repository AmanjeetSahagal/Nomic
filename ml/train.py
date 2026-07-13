#!/usr/bin/env python3
"""Compatibility dispatcher for the versioned training entry points."""
from __future__ import annotations
import argparse, subprocess, sys
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("model",choices=["logistic","lightgbm","neural"]); parser.add_argument("args",nargs=argparse.REMAINDER); options=parser.parse_args(); module=f"ml.training.train_{options.model}"; raise SystemExit(subprocess.call([sys.executable,"-m",module,*options.args]))
if __name__ == "__main__": main()
