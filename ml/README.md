# Learned ranking pipeline

Create a virtual environment, install `requirements.txt`, and run:

```bash
python ml/train.py path/to/candidate-features.jsonl
```

Every JSONL row must contain `taskId`, `repositoryId`, `split`, `label`, and the features in `feature-manifest.json`. Repository-level split validation fails training if a repository appears in more than one split. Generated ONNX artifacts are intentionally not committed until trained on the reviewed public corpus.

For the within-repository historical evaluation, include `mergedAt` on every row and pass `--split-strategy temporal`. The trainer then enforces monotonic train/validation/test chronology per repository. Keep repository-held-out evaluation as a separate run using the default `repository` strategy.
