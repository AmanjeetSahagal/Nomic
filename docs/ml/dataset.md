# Ranking dataset

Tasks are checked out immediately before their fix. Queries contain only pre-fix issue information. Patch text, post-fix comments, revealing commit messages, and future paths are forbidden.

Labels are graded: primary production file 3, supporting production file 2, relevant test/support 1, irrelevant 0. Automatic labels retain provenance and manual overrides win. Top-ranked misses, same-package files, similarly named symbols, and related tests are preferred hard negatives. Candidate rows are never randomly split: repository-held-out or task-level temporal splits are required. Validation rejects task, base-commit, patch, and normalized-query leakage.

The frozen v1 candidate dataset is `benchmarks/corpus/v1/datasets/ranking-corpus-100-reserved-fusion-v1.jsonl`. It contains exactly 5,000 rows: 100 task groups of 50 candidates, 90 groups with a positive and ten all-negative groups. Every row records the reserved-fusion mode, source ranks, graded provenance, negative type, and all 28 `ranking-features-v1` values. Sibling group and manifest files record exact group sizes, indexing policy, feature schema, and SHA-256 checksums.

Regenerate or resume it with:

```bash
npm run corpus:dataset -- \
  --input benchmarks/corpus/v1/ranking-corpus-100-reviewed-v1.json \
  --candidate-mode rrf-reserved-balanced \
  --candidate-limit 50 \
  --max-file-size-bytes 5000000 \
  --resume true \
  --output benchmarks/corpus/v1/datasets/ranking-corpus-100-reserved-fusion-v1.jsonl
```

All-negative groups are valid for end-to-end evaluation but must be excluded from conditional pairwise training because no positive preference pair exists.
