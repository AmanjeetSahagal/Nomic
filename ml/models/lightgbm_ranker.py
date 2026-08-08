def create(seed=42, **overrides):
    import lightgbm as lgb
    options=dict(objective="lambdarank",metric="ndcg",n_estimators=500,learning_rate=.05,num_leaves=31,min_child_samples=20,feature_fraction=.9,bagging_fraction=.9,reg_lambda=1.0,random_state=seed,deterministic=True,n_jobs=1,verbosity=-1)
    options.update(overrides); return lgb.LGBMRanker(**options)
