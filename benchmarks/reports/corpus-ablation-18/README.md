# 18-task retrieval ablation report

This report isolates the retrieval components that produced the frozen `corpus-18-baseline-v1` result. It contains 162 task-mode measurements over the same 18 reviewed Django and TypeScript tasks.

## Result

Query-aware chunk packing is valuable independently of ranking. Body-only BM25 and body-only BM25 plus packing have identical Recall@5/10, MRR, and NDCG@10, while median selected context falls from 120,277 to 5,550 tokens.

Exact symbol evidence produces most of the observed ranking gain:

| Configuration | Recall@5 | MRR | NDCG@10 | Median tokens | P95 latency |
|---|---:|---:|---:|---:|---:|
| Body BM25 | 0.056 | 0.070 | 0.084 | 120,277 | 89.0 ms |
| Body BM25 + packing | 0.056 | 0.070 | 0.084 | 5,550 | 140.1 ms |
| BM25 + exact path | 0.306 | 0.150 | 0.156 | 95,290 | 69.3 ms |
| BM25 + exact symbol | 0.278 | 0.250 | 0.214 | 121,638 | 80.9 ms |
| BM25 + path + symbol | 0.278 | 0.250 | 0.215 | 126,299 | 99.3 ms |
| Path + symbol + packing | 0.278 | 0.250 | 0.215 | 5,305 | 97.2 ms |
| Body BM25 + graph | 0.056 | 0.028 | 0.035 | 5,728 | 147.1 ms |
| Body BM25 + semantic | 0.111 | 0.067 | 0.079 | 12,392 | 212.7 ms |
| Frozen heuristic | 0.111 | 0.119 | 0.100 | 3,878 | 523.8 ms |

Graph expansion and semantic fusion do not justify their quality or latency cost in the current implementation. The heuristic's P95 stage timing is dominated by structural retrieval at 436.6 ms; semantic retrieval contributes 78.3 ms P95.

## Tie decomposition

The original 13 ties are not evidence of parity:

- 2 tasks are successful same-rank ties.
- 11 tasks are failures for both methods in the top 10.
- In 10 of those failures, the primary file is absent from both candidate pools.

The heuristic improves one TypeScript task and worsens four Django tasks. Three of the four regressions remove a BM25 top-two result from the heuristic candidate pool entirely.

## Recommendation

Keep BM25 ranking, exact symbol evidence, and query-aware packing. Treat exact paths as a separate high-confidence override rather than another unnormalized additive feature. Disable unconditional graph and semantic expansion. Only invoke additional retrieval when lexical confidence is low, and evaluate that gate against this report before adoption.

Do not train a learned ranker yet. Candidate generation fails on most TypeScript tasks, so reranking cannot solve the dominant error class.

## Reproduction record

- Run date: 2026-07-03
- Tasks: 18
- Modes: 9
- Task-mode results: 162
- Warm-up: 1 query per task and mode
- Measured repetitions: 5
- Baseline tag: `corpus-18-baseline-v1`
- Manifest SHA-256: `7c98dfd2305832360b8b4101e28d8cb7858f1d30f1458b40247e15d1cf48ce20`
- Runner SHA-256: `d46adbd572d1758f3ec0b89feef96668f1e0fa753ebf8ac9ed360f9e7b147874`
- Retriever SHA-256: `17007ba07b3f19637801a941e17f7c975e4d3edecb1bfbb2df83b51a2a7507dc`

```bash
npm run corpus:benchmark -- --mode ablations
```

