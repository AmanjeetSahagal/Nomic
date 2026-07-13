# Ranking dataset

Tasks are checked out immediately before their fix. Queries contain only pre-fix issue information. Patch text, post-fix comments, revealing commit messages, and future paths are forbidden.

Labels are graded: primary production file 3, supporting production file 2, relevant test/support 1, irrelevant 0. Automatic labels retain provenance and manual overrides win. Top-ranked misses, same-package files, similarly named symbols, and related tests are preferred hard negatives. Candidate rows are never randomly split: repository-held-out or task-level temporal splits are required. Validation rejects task, base-commit, patch, and normalized-query leakage.
