#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from pathlib import Path
from ml.common import FEATURES,matrix,read_jsonl,seed_everything,validate_rows
from ml.models.lightgbm_ranker import create
from ml.training.run_utils import prepare_run
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("dataset",type=Path); parser.add_argument("--output",type=Path,required=True); parser.add_argument("--seed",type=int,default=42); args=parser.parse_args(); rows=read_jsonl(args.dataset); errors=validate_rows(rows)
    if errors: raise SystemExit("\n".join(errors))
    seed_everything(args.seed); run,_=prepare_run(args.output,{"model":"lightgbm","seed":args.seed},rows,args.seed); _,x,y,groups=matrix(rows,"train"); _,xv,yv,vg=matrix(rows,"validation")
    model=create(args.seed); kwargs={"group":groups,"callbacks":[]};
    if xv: import lightgbm as lgb; kwargs.update(eval_set=[(xv,yv)],eval_group=[vg],eval_at=[5,10],callbacks=[lgb.early_stopping(30)])
    model.fit(x,y,**kwargs); model.booster_.save_model(str(run/"model.txt")); importance=dict(zip(FEATURES,model.booster_.feature_importance(importance_type="gain").tolist())); (run/"metrics.json").write_text(json.dumps({"gainImportance":importance},indent=2)+"\n")
if __name__ == "__main__": main()
