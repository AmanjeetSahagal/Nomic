# Corpus comparison

| Mode | Tasks | Recall@5 | Recall@10 | MRR | NDCG@10 | Median tokens | P95 tokens | Median ms | P95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bm25 | 18 | 0.278 | 0.278 | 0.250 | 0.215 | 5305 | 10820 | 49.9 | 97.2 |
| bm25_body | 18 | 0.056 | 0.167 | 0.070 | 0.084 | 120277 | 269846 | 6.4 | 89.0 |
| bm25_packed | 18 | 0.056 | 0.167 | 0.070 | 0.084 | 5550 | 12816 | 40.9 | 140.1 |
| bm25_path | 18 | 0.306 | 0.306 | 0.150 | 0.156 | 95290 | 163570 | 6.7 | 69.3 |
| bm25_symbol | 18 | 0.278 | 0.278 | 0.250 | 0.214 | 121638 | 245633 | 7.1 | 80.9 |
| bm25_path_symbol | 18 | 0.278 | 0.278 | 0.250 | 0.215 | 126299 | 247540 | 7.8 | 99.3 |
| bm25_graph | 18 | 0.056 | 0.056 | 0.028 | 0.035 | 5728 | 26774 | 62.6 | 147.1 |
| bm25_semantic | 18 | 0.111 | 0.111 | 0.067 | 0.079 | 12392 | 83160 | 77.8 | 212.7 |
| heuristic | 18 | 0.111 | 0.167 | 0.119 | 0.100 | 3878 | 7091 | 146.8 | 523.8 |

## First relevant rank

| Comparison | Count | Percentage |
|---|---:|---:|
| Heuristic improves first relevant rank | 1 | 5.6% |
| Same rank | 13 | 72.2% |
| Heuristic worsens first relevant rank | 4 | 22.2% |

Successful same-rank ties: 2. Both failed in top 10: 11. Correct file absent from both candidate pools: 10.

Paired tasks: 18. Mean heuristic token savings: 29.7%.

## Retrieval misses

| Mode | Repository | Task type | Tasks | No primary hit @5 | No primary hit @10 | MRR |
|---|---|---|---:|---:|---:|---:|
| bm25 | django/django | bug-localization | 8 | 3 | 3 | 0.563 |
| bm25 | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25 | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25 | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_body | django/django | bug-localization | 8 | 7 | 5 | 0.157 |
| bm25_body | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_body | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_body | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_graph | django/django | bug-localization | 8 | 7 | 7 | 0.063 |
| bm25_graph | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_graph | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_graph | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_packed | django/django | bug-localization | 8 | 7 | 5 | 0.157 |
| bm25_packed | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_packed | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_packed | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_path | django/django | bug-localization | 8 | 3 | 3 | 0.296 |
| bm25_path | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_path | microsoft/TypeScript | bug-localization | 8 | 7 | 7 | 0.042 |
| bm25_path | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_path_symbol | django/django | bug-localization | 8 | 3 | 3 | 0.563 |
| bm25_path_symbol | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_path_symbol | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_path_symbol | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_semantic | django/django | bug-localization | 8 | 6 | 6 | 0.150 |
| bm25_semantic | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_semantic | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_semantic | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_symbol | django/django | bug-localization | 8 | 3 | 3 | 0.563 |
| bm25_symbol | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25_symbol | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25_symbol | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| heuristic | django/django | bug-localization | 8 | 6 | 6 | 0.250 |
| heuristic | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| heuristic | microsoft/TypeScript | bug-localization | 8 | 8 | 7 | 0.018 |
| heuristic | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |

## Execution failures

| Repository | Task type | Count |
|---|---|---:|
| none | none | 0 |
