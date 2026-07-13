#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path
import numpy as np
from ml.common import FEATURES,matrix,read_jsonl,seed_everything,validate_rows
from ml.models.logistic_ranker import create
from ml.training.run_utils import prepare_run,save_normalization
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("dataset",type=Path); parser.add_argument("--output",type=Path,required=True); parser.add_argument("--seed",type=int,default=42); args=parser.parse_args(); rows=read_jsonl(args.dataset); errors=validate_rows(rows)
    if errors: raise SystemExit("\n".join(errors))
    seed_everything(args.seed); run,_=prepare_run(args.output,{"model":"logistic","seed":args.seed},rows,args.seed)
    _,x,y,_=matrix(rows,"train"); mean,scale=save_normalization(run,x); model=create(args.seed).fit((np.asarray(x)-mean)/scale,np.asarray(y)>0)
    import joblib; joblib.dump(model,run/"model.joblib"); coefficients=dict(zip(FEATURES,model.coef_[0].tolist())); (run/"metrics.json").write_text(json.dumps({"featureCoefficients":coefficients},indent=2)+"\n")
if __name__ == "__main__": main()
