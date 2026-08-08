# Candidate generation before reranking

Model training is gated on reviewed labels and adequate candidate recall. A reranker cannot recover a positive file that is absent from its candidate pool, so candidate generation and conditional reranking must be evaluated separately.

The experimental diagnostic compares these file candidate sources without changing the production retriever:

- file-body BM25;
- title-only BM25;
- exact-symbol lookup that can inject a previously absent file;
- code-like exact-identifier lookup over symbols and chunks;
- symbol-name BM25 mapped back to files;
- 24-line chunk BM25 mapped back to containing files;
- validated filename and path matches;
- bounded test-to-implementation and one-hop structural expansion;
- unions and reciprocal-rank fusion of those lexical sources.

It reports Recall@10/20/50/100/200, primary-file recall, production-file recall excluding tests, a symbol-file recall proxy, candidate count, latency, and repository breakdowns. Top 100 and 200 are diagnostic cutoffs, not deployment defaults.

Run the frozen reviewed corpus directly:

```bash
npm run corpus:candidates -- \
  --inputs benchmarks/corpus/v1/ranking-corpus-100-reviewed-v1.json \
  --adjudication benchmarks/corpus/v1/review/ranking-corpus-100-reviewed-v1.json \
  --output benchmarks/results/candidate-generation-100-reviewed

npm run corpus:classify-failures -- \
  --results benchmarks/results/candidate-generation-100-reviewed \
  --taxonomy benchmarks/corpus/v1/review/ranking-corpus-100-failure-taxonomy.json

npm run corpus:candidates -- \
  --inputs benchmarks/corpus/v1/ranking-corpus-100-reviewed-v1.json \
  --adjudication benchmarks/corpus/v1/review/ranking-corpus-100-reviewed-v1.json \
  --max-file-size-bytes 5000000 \
  --output benchmarks/results/candidate-generation-100-high-recall

npm run corpus:classify-failures -- \
  --results benchmarks/results/candidate-generation-100-high-recall \
  --taxonomy benchmarks/corpus/v1/review/ranking-corpus-100-high-recall-failure-taxonomy.json
```

The reviewed v1 corpus contains 40 Django, 40 TypeScript, and 20 VS Code tasks. Five bad candidates were rejected or corrected during adjudication. The manifest and registry validate with no errors or warnings.

On frozen labels, lexical RRF Recall@50 is 68%: Django 97.5%, TypeScript 32.5%, and VS Code 80%. BM25 file Recall@50 is 63%, and BM25 plus exact-symbol Recall@50 is 62%. The values happen to match the earlier draft-label RRF headline, but these results come from a fresh run over the corrected frozen corpus.

All 32 RRF misses at 50 are reviewed: 21 parser/indexing omissions caused by TypeScript's roughly 3.1 MB `checker.ts` exceeding the 1 MB index limit, three vocabulary mismatches, three cutoff failures, two large/generic files, two cross-file architectural dependencies, and one symbol-mentioned miss. The versioned taxonomy is not inferred by the evaluation tool.

The miss review exposed a concrete indexing omission: TypeScript's `checker.ts` is roughly 3.1 MB and was excluded by the default 1 MB ceiling. An audit-only 5 MB run raises file BM25 Recall@50 from 63% to 70% and lexical RRF Recall@50 from 68% to 78%; lexical RRF reaches 90% at 200. This does not change the production index limit, and its much higher cold indexing cost is a deployment constraint.

Adding title-only retrieval, exact identifier injection, chunk retrieval, bounded test expansion, and one-hop structural expansion raises high-recall RRF to 89% at 50 and 96% at 200. By repository at 50, it reaches Django 97.5%, TypeScript 87.5%, and VS Code 75%. The source oracle union is 96% at 50 and 98% at 200. Exact identifiers solve five unique top-50 misses and title BM25 solves three; test expansion solves none uniquely on this corpus, so it should not receive additional fusion weight.

Postings and reuse of the body-BM25 seed ranking reduce mean warm high-recall generation latency from roughly 1,773 ms to 279 ms on this audit. The optimized result reproduces the same 11 misses. For comparison, body BM25 averages 61 ms and lexical RRF 163 ms. These figures exclude cold repository indexing and one-time candidate-index preparation.

At the initial high-recall checkpoint, all 11 remaining top-50 misses were reviewed: seven were fusion dilution, two vocabulary mismatch, one symbol-index omission, and one true cutoff failure. Alternative fixed fusion weights did not recover a top-50 miss and were rejected. Training remained closed because Recall@200 cleared the 95% target while Recall@50 was one task below the 90% target.

A bounded reserved-slot policy closes the final gate without adding a retrieval source: keep the top 35 all-source fused candidates, then add up to five novel exact-identifier candidates, five title candidates, three symbol candidates, and two body-BM25 candidates, deduplicating before every reservation. It recovers the multi-file `findLast` task at rank 40, with no regressions across the 100-task corpus. Reserved fusion reaches 90% Recall@50, 92% Recall@100, and 96% Recall@200. By repository at 50 it reaches Django 97.5%, TypeScript 90%, and VS Code 75%.

All ten remaining misses are reviewed: six fusion-dilution cases, two vocabulary mismatches, one symbol-index omission, and one cutoff failure. The candidate gate is now open. The frozen pool contains 5,000 rows in 100 groups of 50 with all 28 `ranking-features-v1` values and checksummed provenance. Production behavior remains unchanged; the 5 MB policy and reserved fusion are experimental inputs for controlled model evaluation.

A subsequent exact-graph reachability audit freezes lexical RRF top-ten seeds and evaluates bounded one- and two-hop traversal without changing this pool. Two hops recover two reserved-fusion top-200 misses but neither of the two files absent from the complete existing-source oracle. The graph investment gate therefore stops. See [graph-reachability.md](graph-reachability.md).
