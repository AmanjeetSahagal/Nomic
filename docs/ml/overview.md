# Learned ranking overview

Ranking—not candidate generation—is the ML problem. BM25 produces at most 50 candidates; deterministic v1 features describe lexical score, symbols, paths, file category, chunks, and repository scale; a small model assigns reranking scores. Exact-symbol safety policies are model metadata and must be benchmarked. The feature is experimental and baseline remains the default until all promotion criteria pass across three seeds.

The 18-task corpus is a frozen baseline benchmark, not sufficient training data. Initial training requires at least 100 reviewed public-repository tasks across multiple repositories.
