from __future__ import annotations
import json, os, platform, subprocess, time
from collections import Counter
from pathlib import Path
from ml.common import FEATURES
def prepare_run(output, config, rows, seed):
    run=Path(output); run.mkdir(parents=True,exist_ok=True)
    try: commit=subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()
    except Exception: commit="unknown"
    manifest={"randomSeed":seed,"gitCommit":commit,"corpusVersion":config.get("corpus_version","nomic-ranking-corpus-v1"),"featureSchemaVersion":"ranking-features-v1","repositories":{split:sorted({r["repository"] for r in rows if r.get("split")==split}) for split in ("train","validation","test")},"taskCounts":{split:len({r["taskId"] for r in rows if r.get("split")==split}) for split in ("train","validation","test")},"candidateCount":len(rows),"classDistribution":Counter(r["label"] for r in rows),"hardware":platform.platform(),"python":platform.python_version(),"startedAt":time.time()}
    try:
        import yaml
        (run/"config.yaml").write_text(yaml.safe_dump(config,sort_keys=True))
    except ImportError: (run/"config.yaml").write_text(json.dumps(config,indent=2)+"\n")
    (run/"split_manifest.json").write_text(json.dumps(manifest,indent=2,default=dict)+"\n"); (run/"feature_schema.json").write_text(json.dumps({"version":"ranking-features-v1","features":FEATURES},indent=2)+"\n"); (run/"error_analysis.md").write_text("# Error analysis\n\nPopulate after held-out evaluation.\n")
    return run,manifest
def save_normalization(run, x):
    import numpy as np
    mean=np.asarray(x,dtype="float32").mean(0); scale=np.asarray(x,dtype="float32").std(0); scale[scale<1e-12]=1
    values={"mean":mean.tolist(),"scale":scale.tolist()}; (run/"normalization.json").write_text(json.dumps(values,indent=2)+"\n"); return mean,scale
