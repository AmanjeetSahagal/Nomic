# Corpus comparison

| Mode | Tasks | Recall@5 | Recall@10 | MRR | NDCG@10 | Median tokens | P95 tokens | Median ms | P95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bm25_body | 18 | 0.056 | 0.167 | 0.070 | 0.084 | 120277 | 269846 | 7.3 | 78.7 |
| bm25_packed | 18 | 0.056 | 0.167 | 0.070 | 0.084 | 5550 | 12816 | 13.0 | 86.8 |
| bm25_symbol_packed | 18 | 0.278 | 0.278 | 0.250 | 0.214 | 5305 | 10820 | 13.3 | 97.8 |

## Retrieval misses

| Mode | Repository | Task type | Tasks | No primary hit @5 | No primary hit @10 | MRR |
|---|---|---|---:|---:|---:|---:|
| bm25_body | django/django | bug-localization | 8 | 7 | 5 | 0.157 |
| bm25_body | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_body | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_body | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_packed | django/django | bug-localization | 8 | 7 | 5 | 0.157 |
| bm25_packed | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_packed | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_packed | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_symbol_packed | django/django | bug-localization | 8 | 3 | 3 | 0.563 |
| bm25_symbol_packed | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_symbol_packed | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_symbol_packed | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |

## Execution failures

| Repository | Task type | Count |
|---|---|---:|
| none | none | 0 |
