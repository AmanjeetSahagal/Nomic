from __future__ import annotations
import math, statistics
def task_metrics(labels):
    relevant=[i for i,label in enumerate(labels) if label>0]; first=relevant[0]+1 if relevant else None
    def recall(k): return int(any(label>0 for label in labels[:k]))
    def dcg(k): return sum((2**label-1)/math.log2(i+2) for i,label in enumerate(labels[:k]))
    ideal=sorted(labels,reverse=True)
    return {"recallAt5":recall(5),"recallAt10":recall(10),"mrr":0 if first is None else 1/first,"ndcgAt5":dcg(5)/max(dcg_for(ideal,5),1e-12),"ndcgAt10":dcg(10)/max(dcg_for(ideal,10),1e-12),"top1Accuracy":int(bool(labels and labels[0]>0)),"firstRelevantRank":first}
def dcg_for(labels,k): return sum((2**label-1)/math.log2(i+2) for i,label in enumerate(labels[:k]))
def aggregate(tasks):
    keys=["recallAt5","recallAt10","mrr","ndcgAt5","ndcgAt10","top1Accuracy"]
    output={key:sum(task[key] for task in tasks)/max(1,len(tasks)) for key in keys}; ranks=[t["firstRelevantRank"] for t in tasks if t["firstRelevantRank"] is not None]
    output.update(meanFirstRelevantRank=sum(ranks)/max(1,len(ranks)),medianFirstRelevantRank=statistics.median(ranks) if ranks else None); return output
