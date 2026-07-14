# Ranking corpus 100-task review gate

The acquisition target is 40 Django, 40 TypeScript, and 20 VS Code tasks. The frozen manifest supplies 9 Django and 9 TypeScript tasks. Expansion queues supply 35 Django drafts (31 needed), 31 TypeScript drafts, and 20 VS Code drafts.

No expansion task may move from `draft` to `accepted` until a reviewer checks:

1. The issue existed before the fix and the query contains only pre-fix evidence.
2. `baseCommit` is the commit immediately before the fix and `patchCommit` is reconstructable.
3. The patch changes production behavior and includes a regression test or validation file.
4. Exactly one main implementation file is graded 3 unless the fix genuinely has multiple co-primary files.
5. Supporting implementation files are graded 2 and tests/supporting context are graded 1.
6. Relevant symbols and base-commit line ranges are recorded where the index can resolve them.
7. Generated, release, documentation-only, dependency, localization, and security-sensitive tasks remain rejected.

Candidate shards under `benchmarks/results/ranking-corpus-100/` contain exactly 50 deterministic records per task and all 28 `ranking-features-v1` values. All-negative groups remain useful for candidate-generation evaluation but must not be sampled as pairwise ranking tasks.
