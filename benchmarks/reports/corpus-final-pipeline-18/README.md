# Final 18-task retrieval pipeline

This is the headline benchmark for Nomic's promoted default retrieval design: body BM25, exact-symbol evidence, and query-relevant chunk packing. Graph, semantic, broad structural expansion, and path overrides are disabled by default.

| Method | Recall@5 | Recall@10 | MRR | NDCG@10 | Median tokens | P95 latency |
|---|---:|---:|---:|---:|---:|---:|
| BM25 | 0.056 | 0.167 | 0.070 | 0.084 | 120,277 | 78.7 ms |
| BM25 + packing | 0.056 | 0.167 | 0.070 | 0.084 | 5,550 | 86.8 ms |
| BM25 + symbols + packing | 0.278 | 0.278 | 0.250 | 0.214 | 5,305 | 97.8 ms |

Packing reduces median context by 95.4% without changing BM25 ranking metrics. Exact-symbol evidence materially improves code-specific ranking while the final warm P95 remains below the 100 ms release gate. There were zero benchmark execution failures.

Absolute recall remains low, especially on TypeScript. This report supports the selected architecture; it does not claim that retrieval coverage is solved.

## Default and experimental controls

The engine defaults to `Bm25SymbolPackedRetriever`. Experimental behavior is opt-in:

- `NOMIC_ENABLE_PATH_OVERRIDE=1`
- `NOMIC_ENABLE_GRAPH_EXPANSION=1`
- `NOMIC_ENABLE_SEMANTIC_EXPANSION=1`
- `NOMIC_RETRIEVAL_BACKEND=heuristic`

## Reproduction

- Tasks: 18 reviewed Django and TypeScript tasks
- Warm-up: 1 query per task and method
- Repetitions: 5
- Manifest SHA-256: `7c98dfd2305832360b8b4101e28d8cb7858f1d30f1458b40247e15d1cf48ce20`
- Runner SHA-256: `652576b12acb7a246ad5d9bd54cdb775a9f2664fb993a6fcf2b7f9b5bcbd167b`
- Retriever SHA-256: `37bd492463badb1fd7ab95b603d767fe904ddcf3f1f1dce3677ae28a6f488773`

```bash
npm run corpus:benchmark -- --mode bm25_body,bm25_packed,bm25_symbol_packed
```

