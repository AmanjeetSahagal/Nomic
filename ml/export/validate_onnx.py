#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
import numpy as np,onnxruntime as ort,torch
from ml.common import FEATURES
from ml.models.neural_ranker import NomicNeuralRanker
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("checkpoint",type=Path); parser.add_argument("model",type=Path); parser.add_argument("--tolerance",type=float,default=1e-5); args=parser.parse_args(); checkpoint=torch.load(args.checkpoint,map_location="cpu",weights_only=True); model=NomicNeuralRanker(len(FEATURES)); model.load_state_dict(checkpoint["state_dict"]); model.eval(); session=ort.InferenceSession(str(args.model),providers=["CPUExecutionProvider"])
    for count in (1,7):
        values=np.random.default_rng(42).normal(size=(count,len(FEATURES))).astype("float32"); expected=model(torch.from_numpy(values)).detach().numpy(); actual=session.run(["scores"],{"features":values})[0]
        if not np.allclose(expected,actual,atol=args.tolerance,rtol=args.tolerance) or not np.isfinite(actual).all(): raise SystemExit("ONNX parity validation failed")
    try: session.run(["scores"],{"features":np.zeros((1,len(FEATURES)-1),dtype="float32")}); raise SystemExit("invalid feature count was accepted")
    except Exception: pass
    print("ONNX parity, batch shape, finite output, and feature-count checks passed")
if __name__ == "__main__": main()
