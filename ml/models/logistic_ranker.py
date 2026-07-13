def create(seed=42, class_weight="balanced"):
    from sklearn.linear_model import LogisticRegression
    return LogisticRegression(random_state=seed,max_iter=2000,class_weight=class_weight)
