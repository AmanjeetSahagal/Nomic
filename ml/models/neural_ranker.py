from __future__ import annotations
try:
    import torch
    from torch import nn
except ImportError as error:
    raise ImportError("Neural training requires the optional 'torch' dependency") from error

class NomicNeuralRanker(nn.Module):
    def __init__(self, feature_count: int) -> None:
        super().__init__()
        self.network = nn.Sequential(nn.Linear(feature_count,64),nn.ReLU(),nn.Dropout(.15),nn.Linear(64,32),nn.ReLU(),nn.Linear(32,1))
    def forward(self, features: torch.Tensor) -> torch.Tensor: return self.network(features).squeeze(-1)

def pairwise_loss(positive_scores, negative_scores, objective="margin", margin=.2):
    if objective == "ranknet": return torch.nn.functional.softplus(-(positive_scores-negative_scores)).mean()
    return torch.nn.functional.margin_ranking_loss(positive_scores,negative_scores,torch.ones_like(positive_scores),margin=margin)
