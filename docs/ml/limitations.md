# Limitations

Patch-derived labels are noisy proxies for useful coding context: modified files can be incidental, and untouched files can be important. Repository-held-out evaluation reduces but cannot eliminate ecosystem and language bias. A compact structured model cannot infer behavior absent from retrieval signals.

A reviewed 100-task corpus and frozen 5,000-row candidate dataset support controlled experiments. The frozen 1 MB lexical baseline remains 68% Recall@50. Audit-only 5 MB reserved fusion reaches 90% Recall@50 and 96% Recall@200, with TypeScript at 90% Recall@50. The larger index ceiling substantially increases cold indexing cost and has not changed production behavior.

The first model comparison is a negative result. Logistic regression, LightGBM LambdaRank, and all three pairwise-MLP seeds regress against deterministic candidate order on the held-out test split. The neural results also have high seed variance. The split is intentionally difficult and small: 40 Django training tasks, four older TypeScript validation tasks, and 56 newer TypeScript plus VS Code test tasks. The four-task validation set is too small for reliable hyperparameter selection, and the ten all-negative groups cap end-to-end metrics independently of reranking quality. No learned artifact should be exported, deployed, or described as an improvement from this experiment.

The v1 preprocessing also treats categorical feature IDs as continuous values. That creates arbitrary ordering and severe out-of-distribution values when moving from Django to TypeScript and VS Code. This must be preregistered and corrected before a new held-out evaluation; changing it after observing the current test results cannot turn the current run into confirmatory evidence.
