# Learned ranking overview

The learned model solves reranking, not candidate generation. It cannot recover a positive file absent from its candidate pool. Candidate recall is therefore a separate training gate, with file BM25, symbol-first retrieval, path injection, and lexical fusion evaluated before any model experiment. See [candidate-generation.md](candidate-generation.md).

Once that gate passes, deterministic v1 features describe lexical score, symbols, paths, file category, chunks, and repository scale; a small model assigns reranking scores. Exact-symbol safety policies are model metadata and must be benchmarked. The feature is experimental and baseline remains the default until all promotion criteria pass across three seeds.

The 18-task corpus is a frozen baseline benchmark, not sufficient training data. Initial training requires at least 100 reviewed public-repository tasks across multiple repositories.
