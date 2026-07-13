# Nomic learned context ranking

This directory contains the experimental, offline learned-reranking pipeline. The shipping default remains the frozen BM25 → exact-symbol boosting → query-relevant chunk-packing pipeline. Models only rerank its top 50 candidates.

## Reproducible workflow

Run commands from the repository root:

```bash
python -m ml.data.build_dataset reviewed-tasks.jsonl candidates.jsonl
python -m ml.data.split_dataset candidates.jsonl split.jsonl --test-repository pytorch/pytorch --validation-repository microsoft/TypeScript
python -m ml.data.validate_dataset split.jsonl
python -m ml.data.generate_pairs split.jsonl pairs.jsonl --seed 42
python -m ml.training.train_logistic split.jsonl --output ml/runs/logistic-42
python -m ml.training.train_lightgbm split.jsonl --output ml/runs/lightgbm-42
python -m ml.training.train_neural split.jsonl --output ml/runs/neural-42 --objective margin
python -m ml.export.export_onnx ml/runs/neural-42/model.pt models/nomic-neural-ranker-v1.onnx
python -m ml.export.validate_onnx ml/runs/neural-42/model.pt models/nomic-neural-ranker-v1.onnx
```

Install the pinned optional training dependencies with `python -m pip install -r ml/requirements.txt`. Runtime inference does not use Python; experimental Node inference loads `onnxruntime-node` only when selected.

Enable a model explicitly:

```bash
NOMIC_RANKING_MODEL_PATH=models/nomic-neural-ranker-v1.onnx nomic context "fix duplicate registration" --ranker neural
```

Missing, corrupt, incompatible, slow, malformed, or unavailable models return the untouched baseline order. Never train on user repositories or prompts without explicit opt-in.
