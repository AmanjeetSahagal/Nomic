# Candidate generation before reranking

Model training is gated on reviewed labels and adequate candidate recall. A reranker cannot recover a positive file that is absent from its candidate pool, so candidate generation and conditional reranking must be evaluated separately.

The experimental diagnostic compares these file candidate sources without changing the production retriever:

- file-body BM25;
- exact-symbol lookup that can inject a previously absent file;
- symbol-name BM25 mapped back to files;
- validated filename and path matches;
- unions and reciprocal-rank fusion of those lexical sources.

It reports Recall@10/20/50/100/200, primary-file recall, production-file recall excluding tests, a symbol-file recall proxy, candidate count, latency, and repository breakdowns. Top 100 and 200 are diagnostic cutoffs, not deployment defaults.

Run the frozen 100-task selection with the source manifests and existing dataset shards as the task-ID authority:

```bash
npm run corpus:candidates -- \
  --inputs benchmarks/corpus/v1/manifest.json,benchmarks/corpus/v1/drafts/django-django-expansion.json,benchmarks/corpus/v1/drafts/microsoft-TypeScript-expansion.json,benchmarks/corpus/v1/drafts/microsoft-vscode.json \
  --task-ids-from benchmarks/results/ranking-corpus-100/frozen-18.jsonl,benchmarks/results/ranking-corpus-100/django.jsonl,benchmarks/results/ranking-corpus-100/typescript.jsonl,benchmarks/results/ranking-corpus-100/vscode.jsonl \
  --output benchmarks/results/candidate-generation-100
```

The output includes `adjudication.json`, `failure-taxonomy.json`, `training-gate.json`, aggregate metrics, and per-task rows. Draft-label results are explicitly provisional. Failure taxonomy remains blocked until the corresponding task is reviewed; it is never inferred as ground truth by the tool.

Training may begin only when all task labels are frozen, leakage checks pass, candidate Recall@50 meets the chosen engineering gate, and every repository/split has meaningful positive coverage. Reranking results must later be labeled conditional on a positive being present, alongside separate end-to-end metrics.
