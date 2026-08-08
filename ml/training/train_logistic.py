#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from collections import defaultdict
from pathlib import Path
import numpy as np
from ml.common import FEATURES,matrix,read_jsonl,seed_everything,validate_rows,write_jsonl
from ml.evaluation.metrics import aggregate,task_metrics
from ml.models.logistic_ranker import create
from ml.training.run_utils import prepare_run,save_normalization
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("dataset",type=Path); parser.add_argument("--output",type=Path,required=True); parser.add_argument("--seed",type=int,default=42); parser.add_argument("--split-strategy",choices=["repository","temporal"],default="repository"); args=parser.parse_args(); rows=read_jsonl(args.dataset); errors=validate_rows(rows,split_strategy=args.split_strategy)
    if errors: raise SystemExit("\n".join(errors))
    seed_everything(args.seed); run,_=prepare_run(args.output,{"model":"logistic","seed":args.seed,"split_strategy":args.split_strategy},rows,args.seed)
    _,x,y,_=matrix(rows,"train"); mean,scale=save_normalization(run,x); model=create(args.seed).fit((np.asarray(x)-mean)/scale,np.asarray(y)>0)
    predictions=[]
    for row in rows:
        vector=np.asarray([float(row["features"].get(feature,0.0)) for feature in FEATURES])
        predictions.append({**row,"score":float(model.predict_proba(((vector-mean)/scale).reshape(1,-1))[0,1]),"baselineScore":-float(row["features"]["bm25Rank"])})
    write_jsonl(run/"predictions.jsonl",predictions)
    metrics={"featureCoefficients":dict(zip(FEATURES,model.coef_[0].tolist())),"splits":{}}
    for split in ("train","validation","test"):
        selected=[row for row in predictions if row["split"]==split]
        metrics["splits"][split]={"tasks":len({row["taskId"] for row in selected}),"baseline":evaluate(selected,"baselineScore"),"learned":evaluate(selected,"score")}
    import joblib; joblib.dump(model,run/"model.joblib"); (run/"metrics.json").write_text(json.dumps(metrics,indent=2)+"\n")
def evaluate(rows,score_key):
    tasks=defaultdict(list)
    for row in rows: tasks[row["taskId"]].append(row)
    def result(values):
        ranked=sorted(values,key=lambda row:(-float(row[score_key]),row["candidateId"])); return task_metrics([row["label"] for row in ranked])
    end_to_end=[result(values) for values in tasks.values()]
    conditional=[result(values) for values in tasks.values() if any(row["label"]>0 for row in values)]
    return {"endToEnd":aggregate(end_to_end),"conditional":aggregate(conditional),"conditionalTasks":len(conditional)}
if __name__ == "__main__": main()
