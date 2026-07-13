#!/usr/bin/env python3
from __future__ import annotations
import argparse,hashlib,json,subprocess
from pathlib import Path
import torch
from ml.common import FEATURES
from ml.models.neural_ranker import NomicNeuralRanker
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("checkpoint",type=Path); parser.add_argument("output",type=Path); parser.add_argument("--corpus",default="nomic-ranking-corpus-v1"); args=parser.parse_args(); checkpoint=torch.load(args.checkpoint,map_location="cpu",weights_only=True); model=NomicNeuralRanker(len(FEATURES)); model.load_state_dict(checkpoint["state_dict"]); model.eval(); args.output.parent.mkdir(parents=True,exist_ok=True)
    torch.onnx.export(model,torch.zeros((2,len(FEATURES))),args.output,input_names=["features"],output_names=["scores"],dynamic_axes={"features":{0:"candidates"},"scores":{0:"candidates"}},opset_version=17)
    try: commit=subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()
    except Exception: commit="unknown"
    metadata={"model_version":"0.1.0","model_type":"pairwise-mlp","feature_schema_version":"ranking-features-v1","feature_count":len(FEATURES),"model_sha256":hashlib.sha256(args.output.read_bytes()).hexdigest(),"training_corpus":args.corpus,"training_commit":commit,"held_out_repositories":[],"normalization":{"mean":checkpoint["mean"].tolist(),"scale":checkpoint["scale"].tolist()},"metrics":{},"safety":{"mode":"direct"}}
    Path(str(args.output)+".metadata.json").write_text(json.dumps(metadata,indent=2)+"\n")
if __name__ == "__main__": main()
