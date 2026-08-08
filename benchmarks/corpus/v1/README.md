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

Each reviewed task pins:

- the verified repository state immediately before the focused fix as `baseCommit`;
- the verified focused fix endpoint as `patchCommit`, including contiguous ticket commits where required;
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

Run the implemented BM25 and heuristic comparison with exact pre-fix checkouts:

```bash
npm run corpus:benchmark -- --mode all --repository django/django --limit 1
# Full reviewed pilot:
npm run corpus:benchmark -- --mode all
# Controlled component ladder:
npm run corpus:benchmark -- --mode ablations
# Promoted final pipeline report:
npm run corpus:benchmark -- --mode bm25_body,bm25_packed,bm25_symbol_packed
```

The runner writes `run-metadata.json`, `per-task-results.jsonl`, `aggregate-results.json`, `head-to-head.json`, `quality-breakdown.json`, `failure-analysis.json`, `stage-summary.json`, `failure-summary.json`, `failures.jsonl`, and `comparison.md` under the ignored `benchmarks/results/` directory. The report separates retrieval misses from execution failures and includes cold/warm stage timing plus median/P95 token and latency distributions.

## Pilot acceptance gate

- Current reviewed corpus: 100 accepted tasks (40 Django, 40 TypeScript, 20 VS Code), each with production-file labels and resolvable base-tree symbol evidence.
- Five bad candidates were rejected or corrected during the uniform evidence review.
- The frozen 1 MB lexical baseline is 68% Recall@50. Audit-only 5 MB reserved fusion reaches 90% Recall@50 and 96% Recall@200, opening the controlled-training gate without changing production behavior.
- Both BM25 and heuristic baselines.
- Machine-readable per-task and aggregate results.
- Manual analysis of the ten worst failures.
