export type CorpusLanguage = "typescript" | "python" | "cpp";
export type CorpusSplit = "train" | "validation" | "test";
export type TaskType = "bug-localization" | "feature-location" | "repository-navigation";
export type ReviewStatus = "draft" | "accepted" | "rejected";

export interface CorpusRepository {
  id: string;
  url: string;
  languages: CorpusLanguage[];
  stage: 1 | 2 | 3 | 4;
  difficulty: "medium-high" | "high" | "very-high" | "extreme";
  role: string;
  scopePaths?: string[];
  excludedPaths: string[];
  heldOutEvaluation?: boolean;
}

export interface CorpusSymbolLabel {
  name: string;
  path: string;
  grade: 1 | 2 | 3;
  startLine?: number;
  endLine?: number;
}

export interface CorpusTask {
  id: string;
  repositoryId: string;
  baseCommit: string;
  patchCommit: string;
  pullRequest: { number: number; url: string; mergedAt: string };
  issue: { number: number; url: string; title: string; body: string; createdAt: string };
  query: string;
  taskType: TaskType;
  relevance: {
    primaryFiles: string[];
    supportingFiles: string[];
    relevantUnchangedFiles: string[];
    symbols: CorpusSymbolLabel[];
  };
  patchTouchedFiles: string[];
  labels: string[];
  split: CorpusSplit;
  review: { status: ReviewStatus; reviewedAt?: string; notes?: string };
  provenance: { collectorVersion: string; collectedAt: string; queryUsesPreFixEvidenceOnly: true };
}

export interface CorpusManifest {
  schemaVersion: 1;
  name: string;
  repositories: CorpusRepository[];
  tasks: CorpusTask[];
}

export interface CorpusValidationResult {
  errors: string[];
  warnings: string[];
  counts: { repositories: number; tasks: number; accepted: number; rejected: number; draft: number };
}

export interface RejectedCorpusCandidate {
  pullRequestNumber: number;
  pullRequestUrl: string;
  reasons: string[];
}

export interface CorpusCollectionDraft {
  schemaVersion: 1;
  repository: CorpusRepository;
  collectedAt: string;
  tasks: CorpusTask[];
  rejected: RejectedCorpusCandidate[];
}
