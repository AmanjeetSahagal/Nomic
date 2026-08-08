# Learned ranking overview

The learned model solves reranking, not candidate generation. It cannot recover a positive file absent from its candidate pool. Candidate recall is therefore a separate training gate, with file BM25, symbol-first retrieval, path injection, and lexical fusion evaluated before any model experiment. See [candidate-generation.md](candidate-generation.md).

Once that gate passes, deterministic v1 features describe lexical score, symbols, paths, file category, chunks, and repository scale; a small model assigns reranking scores. Exact-symbol safety policies are model metadata and must be benchmarked. The feature is experimental and baseline remains the default until all promotion criteria pass across three seeds.

The versioned `ranking-corpus-100-reviewed-v1` corpus contains 100 reviewed public tasks across Django, TypeScript, and VS Code. The frozen 1 MB lexical RRF baseline is 68% Recall@50. Audit-only 5 MB reserved fusion reaches 90% Recall@50 and 96% Recall@200 using the existing title, identifier, symbol, chunk, path, test, and bounded structural sources. The controlled-training gate is open and a checksummed 5,000-row candidate dataset is frozen, while production behavior remains unchanged.

The first repository- and time-held-out experiment is complete. Logistic regression, LightGBM LambdaRank, and a three-seed pairwise MLP all regress against deterministic candidate order on the 56-task TypeScript and VS Code test split. No learned artifact is promoted. Exact results and split caveats are in [experiments.md](experiments.md).

An offline exact-graph reachability audit also completed. Bounded two-hop traversal recovered two fusion-level top-200 misses at negligible warm traversal latency, but it recovered neither existing-source-oracle miss. The preregistered graph investment gate therefore stops; production and learned-ranking inputs remain unchanged. See [graph-reachability.md](graph-reachability.md).
