# 18-task retrieval baseline

This directory freezes the first complete paired BM25-versus-heuristic run over all 18 reviewed Django and TypeScript tasks. It is evidence for the baseline configuration, not a claim that the heuristic improves retrieval.

## Conclusion

BM25 is the stronger ranking baseline. The heuristic reduced median packed context from 5,305 to 3,878 tokens, but reduced Recall@10 from 0.278 to 0.167, reduced MRR from 0.250 to 0.119, and increased P95 query latency from 75.2 ms to 480.9 ms.

## Reproduction record

- Run date: 2026-07-03
- Tasks: 18 accepted tasks; 9 `django/django`, 9 `microsoft/TypeScript`
- Modes: `bm25`, `heuristic`
- Warm-up: 1 query per task and mode
- Measured repetitions: 5
- Parser crash fix: `bf57848`
- Frozen retrieval implementation: `98dcb0e`
- Manifest SHA-256: `7c98dfd2305832360b8b4101e28d8cb7858f1d30f1458b40247e15d1cf48ce20`
- Runner SHA-256: `47cbd105e572f8782170d69419fbb4729f59affd0f36dbb7a5bfca2f7221b256`
- Retriever SHA-256: `b6db0acf59767ece252234ec72a42e7a4983184bcc3cd481d3cd359a5edbbce7`

Task IDs, pinned repository commits, labels, and splits are versioned in `benchmarks/corpus/v1/manifest.json`. Per-task rankings and metrics are preserved in `per-task-results.jsonl`; machine details are in `run-metadata.json`.

## Command

```bash
npm run corpus:benchmark -- --mode all
```

