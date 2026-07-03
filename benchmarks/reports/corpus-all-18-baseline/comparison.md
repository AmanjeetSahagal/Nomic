# Corpus comparison

| Mode | Tasks | Recall@5 | Recall@10 | MRR | NDCG@10 | Median tokens | P95 tokens | Median ms | P95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bm25 | 18 | 0.278 | 0.278 | 0.250 | 0.215 | 5305 | 10820 | 39.8 | 75.2 |
| heuristic | 18 | 0.111 | 0.167 | 0.119 | 0.100 | 3878 | 7091 | 130.0 | 480.9 |

## First relevant rank

| Comparison | Count | Percentage |
|---|---:|---:|
| Heuristic improves first relevant rank | 1 | 5.6% |
| Same rank | 13 | 72.2% |
| Heuristic worsens first relevant rank | 4 | 22.2% |

Paired tasks: 18. Mean heuristic token savings: 29.7%.

## Retrieval misses

| Mode | Repository | Task type | Tasks | No primary hit @5 | No primary hit @10 | MRR |
|---|---|---|---:|---:|---:|---:|
| bm25 | django/django | bug-localization | 8 | 3 | 3 | 0.563 |
| bm25 | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| bm25 | microsoft/TypeScript | bug-localization | 8 | 8 | 8 | 0.000 |
| bm25 | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |
| heuristic | django/django | bug-localization | 8 | 6 | 6 | 0.250 |
| heuristic | django/django | feature-location | 1 | 1 | 1 | 0.000 |
| heuristic | microsoft/TypeScript | bug-localization | 8 | 8 | 7 | 0.018 |
| heuristic | microsoft/TypeScript | feature-location | 1 | 1 | 1 | 0.000 |

## Execution failures

| Repository | Task type | Count |
|---|---|---:|
| none | none | 0 |
