# Feature schema

`ranking-features-v1` contains 28 ordered numeric features recorded in [`ml/feature-manifest.json`](../../ml/feature-manifest.json). Extraction is deterministic, offline, and patch-independent. Missing values are zero. Categorical IDs use stable hashing, never process-randomized hashes. Model metadata stores schema version, feature count, mean, scale, and checksum; runtime rejects any mismatch.

Graph fields are limited to inbound dependency count and candidate-generation distance. Semantic scores are deliberately absent from v1 so non-default expansion cannot leak into the first experiment.
