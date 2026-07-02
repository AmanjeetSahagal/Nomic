import type { CorpusManifest, CorpusTask, CorpusValidationResult } from "./corpus-contracts";

const SHA = /^[a-f0-9]{40}$/;

export function validateCorpus(corpus: CorpusManifest, requireReviewed = true): CorpusValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const repositoryIds = new Set<string>();
  const taskIds = new Set<string>();
  const patchCommits = new Set<string>();

  if (corpus.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  for (const repository of corpus.repositories) {
    if (repositoryIds.has(repository.id)) errors.push(`duplicate repository: ${repository.id}`);
    repositoryIds.add(repository.id);
    if (!repository.url.startsWith("https://github.com/")) warnings.push(`${repository.id}: non-GitHub URL`);
    if (repository.languages.length === 0) errors.push(`${repository.id}: no languages configured`);
  }

  for (const task of corpus.tasks) validateTask(task, repositoryIds, taskIds, patchCommits, errors, warnings, requireReviewed);
  validateTemporalOrder(corpus.tasks, errors);

  const counts = {
    repositories: corpus.repositories.length,
    tasks: corpus.tasks.length,
    accepted: corpus.tasks.filter((task) => task.review.status === "accepted").length,
    rejected: corpus.tasks.filter((task) => task.review.status === "rejected").length,
    draft: corpus.tasks.filter((task) => task.review.status === "draft").length
  };
  return { errors, warnings, counts };
}

function validateTask(
  task: CorpusTask,
  repositoryIds: Set<string>,
  taskIds: Set<string>,
  patchCommits: Set<string>,
  errors: string[],
  warnings: string[],
  requireReviewed: boolean
): void {
  const prefix = task.id || "unnamed task";
  if (taskIds.has(task.id)) errors.push(`${prefix}: duplicate task ID`);
  taskIds.add(task.id);
  if (!repositoryIds.has(task.repositoryId)) errors.push(`${prefix}: unknown repository ${task.repositoryId}`);
  if (!SHA.test(task.baseCommit)) errors.push(`${prefix}: invalid base commit`);
  if (!SHA.test(task.patchCommit)) errors.push(`${prefix}: invalid patch commit`);
  if (task.baseCommit === task.patchCommit) errors.push(`${prefix}: base and patch commits are identical`);
  if (patchCommits.has(task.patchCommit)) errors.push(`${prefix}: duplicate patch commit`);
  patchCommits.add(task.patchCommit);
  if (new Date(task.issue.createdAt) >= new Date(task.pullRequest.mergedAt)) errors.push(`${prefix}: issue does not predate fix`);
  if (task.query.trim().length < 40) errors.push(`${prefix}: query is shorter than 40 characters`);
  if (!task.provenance.queryUsesPreFixEvidenceOnly) errors.push(`${prefix}: query provenance allows post-fix evidence`);
  if (task.relevance.primaryFiles.length === 0) errors.push(`${prefix}: no primary files`);
  const touched = new Set(task.patchTouchedFiles);
  for (const file of [...task.relevance.primaryFiles, ...task.relevance.supportingFiles]) {
    if (!touched.has(file)) errors.push(`${prefix}: changed relevance label ${file} is absent from patchTouchedFiles`);
  }
  const relevanceFiles = [...task.relevance.primaryFiles, ...task.relevance.supportingFiles, ...task.relevance.relevantUnchangedFiles];
  if (new Set(relevanceFiles).size !== relevanceFiles.length) errors.push(`${prefix}: file appears in multiple relevance grades`);
  if (requireReviewed && task.review.status !== "accepted") errors.push(`${prefix}: manifest contains a non-accepted task`);
  if (task.review.status === "accepted" && !task.review.reviewedAt) errors.push(`${prefix}: accepted task lacks reviewedAt`);
  if (task.relevance.symbols.length === 0) warnings.push(`${prefix}: no symbol labels yet`);
}

function validateTemporalOrder(tasks: CorpusTask[], errors: string[]): void {
  const ranks = { train: 0, validation: 1, test: 2 } as const;
  const byRepository = new Map<string, CorpusTask[]>();
  for (const task of tasks) byRepository.set(task.repositoryId, [...(byRepository.get(task.repositoryId) ?? []), task]);
  for (const [repository, repositoryTasks] of byRepository) {
    const sorted = [...repositoryTasks].sort((left, right) => left.pullRequest.mergedAt.localeCompare(right.pullRequest.mergedAt));
    let previousRank = -1;
    for (const task of sorted) {
      const rank = ranks[task.split];
      if (rank < previousRank) errors.push(`${repository}: temporal split order moves backward at ${task.id}`);
      previousRank = Math.max(previousRank, rank);
    }
  }
}
