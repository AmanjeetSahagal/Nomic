from __future__ import annotations
import unittest
from ml.common import FEATURES, stable_id, validate_rows
from ml.data.build_dataset import build
from ml.data.generate_pairs import generate
from ml.data.split_dataset import split_first_experiment, split_repository
from ml.evaluation.metrics import task_metrics

class PipelineTests(unittest.TestCase):
    def task(self):
        return {"taskId":"repo-1","repository":"org/repo","baseCommit":"abc","query":"fix AuthService registration","positiveFiles":["src/auth.ts"],"metadata":{"language":"typescript","fileCount":100},"candidates":[{"path":"src/auth.ts","bm25Score":5,"symbols":[{"name":"AuthService","kind":"class","startLine":1,"endLine":20}],"content":"class AuthService {}"},{"path":"test/auth.test.ts","bm25Score":4,"isTest":True,"content":"test auth"}]}
    def test_features_and_labels_are_complete_and_deterministic(self):
        first=build([self.task()]); second=build([self.task()]); self.assertEqual(first,second); self.assertEqual(set(first[0]["features"]),set(FEATURES)); self.assertEqual(first[0]["label"],3)
    def test_pairs_prefer_higher_labels(self):
        rows=build([self.task()]); pairs=generate(rows,cap=10); self.assertEqual(len(pairs),1); self.assertEqual(pairs[0]["positiveId"],"src/auth.ts")
    def test_leakage_is_rejected(self):
        rows=build([self.task()]); split_repository(rows,set(),set()); rows[0]["split"]="train"; rows[1]["split"]="test"; self.assertTrue(any("task leakage" in error for error in validate_rows(rows)))
    def test_grouped_ranking_metrics(self):
        metrics=task_metrics([3,0,1]); self.assertEqual(metrics["recallAt5"],1); self.assertEqual(metrics["mrr"],1)
    def test_stable_category_hash_matches_runtime_fnv(self):
        self.assertEqual(stable_id("typescript"), 40)
    def test_first_experiment_split_is_repository_and_time_held_out(self):
        rows=[{"taskId":"d","repository":"django/django","createdAt":"2025-01-01"},{"taskId":"old","repository":"microsoft/TypeScript","createdAt":"2022-01-01"},{"taskId":"new","repository":"microsoft/TypeScript","createdAt":"2025-01-01"},{"taskId":"v","repository":"microsoft/vscode","createdAt":"2020-01-01"}]
        assigned=split_first_experiment(rows)
        self.assertEqual({row["taskId"]:row["split"] for row in assigned},{"d":"train","old":"validation","new":"test","v":"test"})
if __name__ == "__main__": unittest.main()
