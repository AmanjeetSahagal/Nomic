# Nomic public corpus v1

This corpus evaluates whether Nomic retrieves the files and symbols needed to solve real historical coding tasks. The synthetic benchmark remains a smoke test and is not evidence of retrieval quality.

## Repository progression

1. `django/django` and `microsoft/TypeScript`: pipeline development and initial baselines.
2. `microsoft/vscode`: large TypeScript product architecture.
3. `pytorch/pytorch`: mixed Python/C++ localization.
4. `llvm/llvm-project`: hardest held-out C++ evaluation.

Repository scopes, exclusions, roles, and held-out status are versioned in `manifest.json`.

## Task construction

The collector accepts only explicitly issue-linked merged pull requests. Queries contain the issue title and body available before the fix. Pull-request titles, commit messages, patches, post-fix comments, and future repository state are excluded from queries.

Each task pins:

- the first parent of the merged patch as `baseCommit`;
- the merged patch commit;
- issue and pull-request provenance;
- patch-touched files;
- grade 3 primary implementation files;
- grade 2 supporting changed files;
- optional grade 1 relevant-but-unchanged files and symbols;
- a temporal train/validation/test split.

Automatically generated labels are drafts. A reviewer must inspect the issue, patch, and proposed labels before accepting a task into `manifest.json`.

## Collection workflow

Start with ten tasks, not the final corpus:

```bash
GITHUB_TOKEN=... npm run corpus:collect -- --repo django/django --limit 10 --scan 150
npm run corpus:review -- --draft benchmarks/corpus/v1/drafts/django-django.json --list
```

Edit incorrect relevance labels directly in the draft, then record decisions:

```bash
npm run corpus:review -- --draft benchmarks/corpus/v1/drafts/django-django.json --accept task-id-1,task-id-2
npm run corpus:review -- --draft benchmarks/corpus/v1/drafts/django-django.json --reject task-id-3 --notes "Patch is too broad"
npm run corpus:validate
npm run corpus:stats
```

The collector logs rejected candidates and reasons in the draft. Drafts, repository caches, and generated benchmark results are not committed.

## Filtering policy

Keep tasks only when the issue predates the fix, the patch is reconstructable, natural-language context is meaningful, production code and a regression test change, no more than 15 production files change, and the issue/patch link is explicit. Reject documentation-only, generated, dependency, localization, release, formatting, security, reverted, test-only, and excessively broad changes.

## Evaluation protocol

Temporal split:

- Train: fixes merged before 2024.
- Validation: fixes merged during 2024.
- Test: fixes merged during 2025.

Also report repository-held-out evaluation, initially holding out LLVM and later rotating PyTorch. Never construct a query from information created after the fix.

Compare BM25, heuristic, semantic-only when available, hybrid retrieval, and later the trained ranker. Report Recall@5/10, MRR, graded NDCG@10, selected tokens, context precision, query P50/P95, index time, peak memory, and index size. Record machine details, cold/warm status, one warm-up, five measured repetitions, configuration version, Git commit, and per-task failures.

## Pilot acceptance gate

- Two repositories: Django and TypeScript.
- Ten reviewed tasks during pipeline debugging, then 50 total.
- Both BM25 and heuristic baselines.
- Machine-readable per-task and aggregate results.
- Manual analysis of the ten worst failures.
