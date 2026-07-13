# Evaluation

Primary grouped metrics are Recall@5, Recall@10, MRR, NDCG@5, and NDCG@10. Secondary reporting includes top-1, first-relevant rank, improved/tied/worsened tasks, latency percentiles, tokens, and model size. Compare every method to the exact frozen baseline on held-out repositories and report per-repository failures honestly.

Required ablations add feature families incrementally: BM25, symbols, paths, file category, chunks, all non-graph, then graph and semantic experimental signals. Logistic coefficients and model permutation importance provide explanations.
