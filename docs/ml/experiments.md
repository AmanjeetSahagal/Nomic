# First ranking experiment

The first controlled model comparison uses the frozen `ranking-corpus-100-reserved-fusion-v1` dataset and preserves task groups. It does not randomly split candidate rows.

- train: 40 Django tasks, 2,000 rows, 39 groups with a positive;
- validation: four TypeScript tasks dated before 2023, 200 rows, all with a positive;
- test: 36 newer TypeScript tasks and 20 VS Code tasks, 2,800 rows, 47 groups with a positive.

The deterministic comparator is the frozen candidate order represented by `bm25Rank`. On the 56-task test split it reaches 46.4% end-to-end Recall@5, 0.302 MRR, and 0.303 NDCG@10. Its conditional metrics over the 47 test tasks containing a positive are 55.3% Recall@5, 0.360 MRR, and 0.361 NDCG@10.

Neither learned model clears that comparator:

| Model | Test Recall@5 | Test MRR | Test NDCG@10 |
| --- | ---: | ---: | ---: |
| deterministic candidate order | 46.4% | 0.302 | 0.303 |
| logistic regression, seed 42 | 10.7% | 0.114 | 0.092 |
| LightGBM LambdaRank, seed 42 | 41.1% | 0.238 | 0.262 |
| pairwise MLP, three-seed mean | 28.6% | 0.201 | 0.190 |

Pairwise-MLP test results use seeds 42, 43, and 44 and sample standard deviation:

| Metric | Mean | Std. dev. | Best run | Worst run |
| --- | ---: | ---: | ---: | ---: |
| end-to-end Recall@5 | 28.6% | 14.6 pp | 41.1% (seed 44) | 12.5% (seed 42) |
| end-to-end MRR | 0.201 | 0.071 | 0.246 (seed 44) | 0.120 (seed 42) |
| end-to-end NDCG@10 | 0.190 | 0.092 | 0.244 (seed 44) | 0.084 (seed 42) |
| conditional Recall@5 | 34.0% | 17.4 pp | 48.9% (seed 44) | 14.9% (seed 42) |
| conditional MRR | 0.239 | 0.084 | 0.293 (seed 44) | 0.142 (seed 42) |
| conditional NDCG@10 | 0.227 | 0.110 | 0.290 (seed 44) | 0.100 (seed 42) |

This is an honest negative result. The candidate pool is adequate for early experiments, but 40 training tasks do not support a stable cross-ecosystem learned ranker with the current features. LightGBM is the strongest learned option in this run, yet it still regresses Recall@5, MRR, and NDCG@10. The baseline remains active, and no ONNX export or production latency claim is warranted.

The regression is not isolated to one test repository. LightGBM ties baseline Recall@5 on TypeScript at 44.4% but lowers MRR from 0.255 to 0.213; on VS Code it lowers Recall@5 from 50% to 35% and MRR from 0.387 to 0.281. Neural seed 44 is the strongest neural run, tying TypeScript Recall@5 while still regressing VS Code and aggregate ranking quality.

A post-run distribution audit identifies a preregistration requirement for the next experiment. `fileExtensionId`, `repositoryLanguageId`, and `symbolTypeId` are categorical identifiers, but v1 passes their integer codes directly to every model. Treating arbitrary category codes as continuous or ordinal is not semantically valid. Among positive rows, the absolute standardized train-to-test difference is 12.0 for file extension and 8.1 for repository language; positive test rows also contain larger chunks and deeper paths. These observations explain a plausible source of cross-repository instability but do not rescue or invalidate the reported negative result. Do not tune a replacement against this test split. Before evaluating on newly collected held-out tasks, preregister categorical encoding, remove direct repository-identity leakage, and fit all normalization or vocabulary state on training data only.

The compact machine-readable record is `benchmarks/corpus/v1/experiments/ranking-models-v1.json`. Raw local runs are reproducible but ignored because their prediction files duplicate the 5,000-row frozen dataset.
