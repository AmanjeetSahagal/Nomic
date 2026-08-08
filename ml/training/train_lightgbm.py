#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from collections import defaultdict
from pathlib import Path
import numpy as np
from ml.common import FEATURES,matrix,read_jsonl,seed_everything,validate_rows,write_jsonl
from ml.evaluation.metrics import aggregate,task_metrics
from ml.models.lightgbm_ranker import create
from ml.training.run_utils import prepare_run
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("dataset",type=Path); parser.add_argument("--output",type=Path,required=True); parser.add_argument("--seed",type=int,default=42); parser.add_argument("--split-strategy",choices=["repository","temporal"],default="repository"); args=parser.parse_args(); rows=read_jsonl(args.dataset); errors=validate_rows(rows,split_strategy=args.split_strategy)
    if errors: raise SystemExit("\n".join(errors))
    seed_everything(args.seed); run,_=prepare_run(args.output,{"model":"lightgbm","seed":args.seed,"split_strategy":args.split_strategy},rows,args.seed); _,x,y,groups=matrix(rows,"train"); _,xv,yv,vg=matrix(rows,"validation")
    model=create(args.seed); kwargs={"group":groups,"callbacks":[]}; train_x=np.asarray(x,dtype="float32"); train_y=np.asarray(y,dtype="int32")
    if xv: import lightgbm as lgb; kwargs.update(eval_set=[(np.asarray(xv,dtype="float32"),np.asarray(yv,dtype="int32"))],eval_group=[vg],eval_at=[5,10],callbacks=[lgb.early_stopping(30)])
    model.fit(train_x,train_y,**kwargs); model.booster_.save_model(str(run/"model.txt")); importance=dict(zip(FEATURES,model.booster_.feature_importance(importance_type="gain").tolist()))
    predictions=[]
    for row in rows:
        vector=[[float(row["features"].get(feature,0.0)) for feature in FEATURES]]
        predictions.append({**row,"score":float(model.predict(vector)[0]),"baselineScore":-float(row["features"]["bm25Rank"])})
    write_jsonl(run/"predictions.jsonl",predictions)
    metrics={"gainImportance":importance,"bestIteration":model.best_iteration_,"splits":{}}
    for split in ("train","validation","test"):
        selected=[row for row in predictions if row["split"]==split]
        metrics["splits"][split]={"tasks":len({row["taskId"] for row in selected}),"baseline":evaluate(selected,"baselineScore"),"learned":evaluate(selected,"score")}
    (run/"metrics.json").write_text(json.dumps(metrics,indent=2)+"\n")
def evaluate(rows,score_key):
    tasks=defaultdict(list)
    for row in rows: tasks[row["taskId"]].append(row)
    def result(values):
        ranked=sorted(values,key=lambda row:(-float(row[score_key]),row["candidateId"])); return task_metrics([row["label"] for row in ranked])
    end_to_end=[result(values) for values in tasks.values()]
    conditional=[result(values) for values in tasks.values() if any(row["label"]>0 for row in values)]
    return {"endToEnd":aggregate(end_to_end),"conditional":aggregate(conditional),"conditionalTasks":len(conditional)}
if __name__ == "__main__": main()
