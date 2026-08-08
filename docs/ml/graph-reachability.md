# Exact graph reachability audit

The graph experiment is an offline candidate-reachability audit. It does not alter production ranking, candidate fusion, the frozen ranking dataset, or learned-ranker features.

For every reviewed task, the audit freezes the existing lexical RRF top ten as seeds. It builds file-level edges only when the relationship is explicitly present in source: resolved imports, calls or references through imported bindings, extends/implements clauses, source reference directives, and test-to-implementation relationships backed by one of those exact edges. Globally unique symbol names are deliberately not linked because uniqueness is still an inferred target.

Traversal is bidirectional and deterministic. One-hop and two-hop searches retain at most 12 ordered neighbors per visited file and at most 200 files total. Every recovered positive records its lexical seed, edge direction, edge kind, source file, source line, symbol, module, and resolution method.

## Results

The 100-task run reproduces the frozen reserved-fusion baseline exactly: 90% Recall@50 and 96% Recall@200. The complete existing-source oracle remains 98% at 200.

| Method | Reachability | Mean files | P95 warm traversal |
| --- | ---: | ---: | ---: |
| lexical RRF top 10 | 57% | 10.00 | seed generation: 488.9 ms |
| exact one hop | 61% | 52.46 | 0.066 ms |
| bounded exact two hop | 82% | 149.34 | 0.106 ms |

Two-hop traversal recovers two files absent from the current reserved-fusion top 200:

- `django-django-issue-33647-pr-20480`: `django/db/models/query.py` → `django/db/models/expressions.py` ← `tests/backends/postgresql/test_compilation.py`;
- `microsoft-TypeScript-issue-61334-pr-61342`: `src/compiler/semver.ts` → `src/compiler/_namespaces/ts.ts` ← `src/compiler/expressionToTypeNode.ts`.

These are fusion-level recoveries, not new source-oracle recoveries. The graph does not reach either positive absent from every existing source at rank 200:

- TypeScript `matchAll`: `src/lib/es2020.string.d.ts`;
- VS Code terminal monitoring: `outputMonitor.ts` or its reviewed test.

Warm traversal is comfortably below the preregistered 25 ms limit, but graph construction is not free: P95 cold extraction is 21.36 seconds and adjacency preparation is 545.6 ms. The run averages 34,317 edges. Three unique TypeScript stress/invalid fixtures fail AST extraction; all occurrences are recorded rather than silently ignored.

## Decision

The decision gate is closed. Exact graph traversal did not uniquely recover an existing-source-oracle miss, so Nomic should not invest in stronger graph extraction yet. The two fusion-level paths are useful diagnostic evidence for future fusion work, but the next retrieval effort returns to lexical/symbol coverage—particularly declaration-member indexing for `matchAll` and vocabulary bridging for the VS Code output-monitor task.

The compact versioned record is `benchmarks/corpus/v1/graph-reachability-audit-v1.json`. Raw per-task artifacts remain under ignored `benchmarks/results/graph-reachability-100-exact-v1-final` and are checksum-addressed by that record.

Run the audit with:

```bash
npm run corpus:graph-reachability -- \
  --input benchmarks/corpus/v1/ranking-corpus-100-reviewed-v1.json \
  --output benchmarks/results/graph-reachability-100-exact-v1-final \
  --max-file-size-bytes 5000000 \
  --source-oracle-results benchmarks/results/candidate-generation-100-reserved-fusion/per-task-candidate-results.jsonl
```

Use `--reuse-rows <per-task-graph-reachability.jsonl>` only to regenerate aggregation or apply stricter oracle evidence to an unchanged, checksum-verified graph run.
