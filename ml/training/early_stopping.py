class EarlyStopping:
    def __init__(self, patience=10): self.patience=patience; self.best=float("inf"); self.remaining=patience
    def update(self, loss):
        if loss < self.best: self.best=loss; self.remaining=self.patience; return True
        self.remaining-=1; return False
    @property
    def should_stop(self): return self.remaining<=0
