# Training

The pipeline trains class-weighted logistic regression, LightGBM LambdaRank, and the specified 64→32 MLP. Neural training uses bounded task-balanced preference pairs, with hard negatives ordered first, and supports margin and RankNet losses. Seeds are applied to Python, NumPy, and PyTorch. Each run writes configuration, split manifest, schema, normalization, training log, metrics, model, and analysis artifacts under `ml/runs/<run-id>`.

Run at least three seeds before any promotion decision. Training is offline and uses reviewed public tasks only.
