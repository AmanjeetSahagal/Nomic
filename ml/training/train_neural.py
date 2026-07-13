#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,time
from pathlib import Path
import numpy as np, torch
from ml.common import FEATURES,read_jsonl,seed_everything,validate_rows
from ml.data.generate_pairs import generate
from ml.models.neural_ranker import NomicNeuralRanker,pairwise_loss
from ml.training.early_stopping import EarlyStopping
from ml.training.run_utils import prepare_run,save_normalization
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("dataset",type=Path); parser.add_argument("--output",type=Path,required=True); parser.add_argument("--objective",choices=["margin","ranknet"],default="margin"); parser.add_argument("--seed",type=int,default=42); parser.add_argument("--epochs",type=int,default=100); args=parser.parse_args(); rows=read_jsonl(args.dataset); errors=validate_rows(rows)
    if errors: raise SystemExit("\n".join(errors))
    seed_everything(args.seed); run,_=prepare_run(args.output,{"model":"neural","objective":args.objective,"seed":args.seed},rows,args.seed); training=[r for r in rows if r["split"]=="train"]
    raw=np.asarray([[r["features"][f] for f in FEATURES] for r in training],dtype="float32"); mean,scale=save_normalization(run,raw); lookup={(r["taskId"],r["candidateId"]):r for r in training}; pairs=generate(training,200,args.seed)
    if not pairs: raise ValueError("training split produced no preference pairs")
    positive=torch.tensor(np.asarray([[(lookup[(p["taskId"],p["positiveId"])]["features"][f]-mean[i])/scale[i] for i,f in enumerate(FEATURES)] for p in pairs],dtype="float32")); negative=torch.tensor(np.asarray([[(lookup[(p["taskId"],p["negativeId"])]["features"][f]-mean[i])/scale[i] for i,f in enumerate(FEATURES)] for p in pairs],dtype="float32"))
    model=NomicNeuralRanker(len(FEATURES)); optimizer=torch.optim.AdamW(model.parameters(),lr=1e-3,weight_decay=1e-4); stopping=EarlyStopping(12); best=None; log=(run/"training_log.jsonl").open("w")
    for epoch in range(args.epochs):
        model.train(); optimizer.zero_grad(); loss=pairwise_loss(model(positive),model(negative),args.objective); loss.backward(); optimizer.step(); value=float(loss); log.write(json.dumps({"epoch":epoch,"loss":value})+"\n")
        if stopping.update(value): best={k:v.detach().clone() for k,v in model.state_dict().items()}
        elif stopping.should_stop: break
    log.close(); model.load_state_dict(best); torch.save({"state_dict":model.state_dict(),"mean":torch.from_numpy(mean),"scale":torch.from_numpy(scale),"featureCount":len(FEATURES)},run/"model.pt"); (run/"metrics.json").write_text(json.dumps({"trainingPairLoss":stopping.best,"pairs":len(pairs)},indent=2)+"\n")
if __name__ == "__main__": main()
