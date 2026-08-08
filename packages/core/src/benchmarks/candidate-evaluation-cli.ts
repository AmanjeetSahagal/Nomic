#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FilesystemParserProvider } from "../indexing/indexer";
import { CANDIDATE_GENERATION_MODES, generateCandidates, type CandidateGenerationMode } from "./candidate-generation";
import type { CorpusCollectionDraft, CorpusManifest, CorpusRepository, CorpusTask } from "./corpus-contracts";
import { materializeRepository } from "./corpus-runner";

const CUTOFFS = [10, 20, 50, 100, 200] as const;
const FAILURE_REASONS = [
  "vocabulary mismatch", "symbol mentioned but file missed", "relevant file too large or generic",
  "test file outranks implementation", "path or rename mismatch", "parser or indexing omission",
  "generated-file labeling issue", "cross-file architectural dependency", "incorrect benchmark label",
  "candidate cutoff too low", "fusion dilution across candidate sources"
] as const;

interface EvaluationRow {
  taskId: string;
  repository: string;
  labelStatus: "reviewed" | "draft";
  mode: CandidateGenerationMode;
  cutoff: number;
  candidateCount: number;
  anyPositivePresent: boolean;
  primaryPresent: boolean;
  productionPositivePresent: boolean;
  symbolFilePresent: boolean | null;
  firstPositiveRank: number | null;
  bestPositiveRank: number | null;
  bestPositiveSources: Record<string, number> | null;
  boundaryCandidates?: Array<{ rank: number; path: string; score: number; sources: Record<string, number> }>;
  latencyMs: number;
}

interface LoadedCorpus { repositories: Map<string, CorpusRepository>; tasks: Map<string, CorpusTask> }
interface TaskSelection { ids: string[]; frozenPositiveByTask: Map<string, boolean> }

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  const inputs = required(args, "inputs").split(",").map((value) => value.trim()).filter(Boolean);
  const outputDirectory = required(args, "output");
  const cacheDirectory = args.get("cache") ?? path.resolve("benchmarks/cache");
  const maxFileSizeBytes = Number(args.get("max-file-size-bytes") ?? 1_000_000);
  if (!Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes <= 0) throw new Error("--max-file-size-bytes must be a positive number");
  const loaded = await loadInputs(inputs);
  const selection = args.has("task-ids-from")
    ? await readTaskSelection(required(args, "task-ids-from").split(","))
    : args.has("task-ids")
      ? { ids: csv(required(args, "task-ids")), frozenPositiveByTask: new Map<string, boolean>() }
      : { ids: [...loaded.tasks.keys()], frozenPositiveByTask: new Map<string, boolean>() };
  const requestedIds = selection.ids;
  const tasks = requestedIds.map((id) => loaded.tasks.get(id)).filter((task): task is CorpusTask => Boolean(task));
  const missing = requestedIds.filter((id) => !loaded.tasks.has(id));
  if (missing.length) throw new Error(`Task IDs absent from inputs: ${missing.join(", ")}`);
  const reuseResults = args.get("reuse-results") === "true";
  const replacementIds = new Set(csv(args.get("replace-task-ids") ?? ""));
  const rows: EvaluationRow[] = reuseResults
    ? (await readExistingRows(path.join(outputDirectory, "per-task-candidate-results.jsonl"))).filter((row) => !replacementIds.has(row.taskId))
    : [];
  const adjudications = args.has("adjudication")
    ? await readAdjudications(required(args, "adjudication"), new Set(tasks.map((task) => task.id)))
    : tasks.map(adjudicationRecord);
  const tasksToEvaluate = reuseResults ? tasks.filter((task) => replacementIds.has(task.id)) : tasks;

  for (const [position, task] of tasksToEvaluate.entries()) {
    const repository = loaded.repositories.get(task.repositoryId);
    if (!repository) throw new Error(`${task.id}: repository metadata not found`);
    const root = await materializeRepository(repository, task.baseCommit, cacheDirectory);
    const index = await new FilesystemParserProvider().indexRepository({ repositoryRoot: root, excludedPaths: repository.excludedPaths, maxFileSizeBytes });
    const files = new Map(index.files.map((file) => [file.path, file]));
    const allPositive = new Set([...task.relevance.primaryFiles, ...task.relevance.supportingFiles, ...task.relevance.relevantUnchangedFiles]);
    const primary = new Set(task.relevance.primaryFiles);
    const productionPositive = new Set([...allPositive].filter((file) => !files.get(file)?.isTest));
    const symbolPaths = new Set(task.relevance.symbols.map((symbol) => symbol.path));
    for (const mode of CANDIDATE_GENERATION_MODES) {
      const result = generateCandidates(task.query, index, mode, 200);
      const bestPositive = result.candidates.findIndex((candidate) => allPositive.has(candidate.path));
      for (const cutoff of CUTOFFS) {
        const paths = result.candidates.slice(0, cutoff).map((candidate) => candidate.path);
        const firstPositive = paths.findIndex((candidatePath) => allPositive.has(candidatePath));
        rows.push({
          taskId: task.id, repository: task.repositoryId,
          labelStatus: task.review.status === "accepted" ? "reviewed" : "draft",
          mode, cutoff, candidateCount: paths.length,
          anyPositivePresent: firstPositive >= 0,
          primaryPresent: paths.some((candidatePath) => primary.has(candidatePath)),
          productionPositivePresent: paths.some((candidatePath) => productionPositive.has(candidatePath)),
          symbolFilePresent: symbolPaths.size ? paths.some((candidatePath) => symbolPaths.has(candidatePath)) : null,
          firstPositiveRank: firstPositive >= 0 ? firstPositive + 1 : null,
          bestPositiveRank: bestPositive >= 0 ? bestPositive + 1 : null,
          bestPositiveSources: bestPositive >= 0 ? result.candidates[bestPositive]!.sources : null,
          ...(cutoff === 50 && firstPositive < 0 ? {
            boundaryCandidates: result.candidates.slice(45, 50).map((candidate, index) => ({
              rank: index + 46, path: candidate.path, score: candidate.score, sources: candidate.sources
            }))
          } : {}),
          latencyMs: result.latencyMs
        });
      }
    }
    process.stderr.write(`${position + 1}/${tasksToEvaluate.length} ${task.id}\n`);
  }

  const aggregates = aggregate(rows);
  const reviewed = tasks.filter((task) => task.review.status === "accepted").length;
  const baseline50 = rows.filter((row) => row.mode === "bm25-files" && row.cutoff === 50);
  const fused50 = rows.filter((row) => row.mode === "rrf-lexical" && row.cutoff === 50);
  const allSource50 = rows.filter((row) => row.mode === "rrf-high-recall" && row.cutoff === 50);
  const allSource200 = rows.filter((row) => row.mode === "rrf-high-recall" && row.cutoff === 200);
  const evaluatedMode: CandidateGenerationMode = "rrf-reserved-balanced";
  const evaluated50 = rows.filter((row) => row.mode === evaluatedMode && row.cutoff === 50);
  const evaluated200 = rows.filter((row) => row.mode === evaluatedMode && row.cutoff === 200);
  const frozenBaseline = frozenBaselineSummary(tasks, selection.frozenPositiveByTask, rows);
  const taxonomy = tasks.flatMap((task) => {
    const miss = evaluated50.find((row) => row.taskId === task.id)?.anyPositivePresent === false;
    return miss ? [{
      taskId: task.id, repository: task.repositoryId,
      labelStatus: task.review.status === "accepted" ? "reviewed" : "draft",
      taxonomyStatus: task.review.status === "accepted" ? "pending-review" : "blocked-on-adjudication",
      mainReason: null, allowedReasons: FAILURE_REASONS, notes: ""
    }] : [];
  });
  const gateConditions = {
    allTasksReviewed: reviewed === tasks.length,
    labelLeakageChecksPass: tasks.every((task) => task.provenance.queryUsesPreFixEvidenceOnly && new Date(task.issue.createdAt) < new Date(task.pullRequest.mergedAt)),
    candidateRecallAt50Acceptable: recall(evaluated50) >= .9,
    candidateRecallAt200Acceptable: recall(evaluated200) >= .95,
    allMissesClassified: false,
    repositoryCoverageMeaningful: repositoryCoverageMeaningful(evaluated50)
  };
  const trainingGate = {
    status: Object.values(gateConditions).every(Boolean) ? "open" : "closed",
    labelsFrozen: reviewed === tasks.length,
    reviewedTasks: reviewed,
    totalTasks: tasks.length,
    evaluatedBm25PlusExactSymbolRecallAt50: frozenBaseline.overallRecallAt50,
    bm25FileRecallAt50: recall(baseline50),
    rrfLexicalRecallAt50: recall(fused50),
    rrfHighRecallAt50: recall(allSource50),
    rrfHighRecallAt200: recall(allSource200),
    rrfReservedBalancedAt50: recall(evaluated50),
    rrfReservedBalancedAt200: recall(evaluated200),
    evaluatedCandidateGenerator: evaluatedMode,
    engineeringTarget: { recallAt50: .9, recallAt200: .95 },
    conditions: gateConditions,
    conclusion: gateConditions.allTasksReviewed
      ? "Labels are frozen, but training remains closed until candidate Recall@50 and Recall@200 meet their engineering thresholds and every miss is classified."
      : "Do not train until every condition passes. Draft-label measurements are diagnostic only."
  };
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), tasks: tasks.length,
    reviewedTasks: reviewed, draftTasks: tasks.length - reviewed,
    cutoffs: CUTOFFS, modes: CANDIDATE_GENERATION_MODES,
    metricDefinitions: {
      anyPositivePresent: "At least one graded file is in the candidate pool.",
      primaryPresent: "At least one grade-3 primary file is in the candidate pool.",
      productionPositivePresent: "At least one non-test graded file is in the candidate pool.",
      symbolFilePresent: "A file carrying a labeled positive symbol is in the candidate pool; null when symbols are not adjudicated."
    },
    latencyDefinition: "Warm candidate scoring plus fusion; repository indexing and one-time candidate-index preparation are excluded.",
    indexingPolicy: { maxFileSizeBytes },
    warning: tasks.length === reviewed ? null : "Contains draft labels. Results are provisional and cannot authorize training or ML claims.",
    evaluatedBm25PlusExactSymbolPool: frozenBaseline,
    oracleContribution: oracleContribution(rows),
    aggregates
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeJson(path.join(outputDirectory, "candidate-generation-report.json"), report);
  await writeFile(path.join(outputDirectory, "per-task-candidate-results.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeJson(path.join(outputDirectory, "failure-taxonomy.json"), { schemaVersion: 1, reasons: FAILURE_REASONS, tasks: taxonomy });
  await writeJson(path.join(outputDirectory, "adjudication.json"), { schemaVersion: 1, labelsFrozen: reviewed === tasks.length, tasks: adjudications });
  await writeJson(path.join(outputDirectory, "training-gate.json"), trainingGate);
  process.stdout.write(`${JSON.stringify({ tasks: tasks.length, rows: rows.length, reviewed, outputDirectory })}\n`);
}

function adjudicationRecord(task: CorpusTask) {
  const reviewed = task.review.status === "accepted";
  const tests = task.relevance.supportingFiles.filter((file) => /(^|\/)(test|tests|testing|__tests__)(\/|$)|\.(test|spec)\./i.test(file));
  return {
    taskId: task.id,
    status: reviewed ? "reviewed" : "pending",
    reviewer: reviewed ? "legacy review; identity not recorded" : null,
    primary_files: task.relevance.primaryFiles,
    supporting_files: task.relevance.supportingFiles.filter((file) => !tests.includes(file)),
    test_files: tests,
    positive_symbols: task.relevance.symbols,
    renamed_paths: [],
    generated_file_exclusions: [],
    base_commit_verified: reviewed,
    issue_fix_link_verified: reviewed,
    labels_frozen: reviewed,
    notes: task.review.notes ?? ""
  };
}

function aggregate(rows: EvaluationRow[]) {
  const groups = new Map<string, EvaluationRow[]>();
  for (const row of rows) {
    for (const repository of [row.repository, "all"]) {
      for (const labelStatus of [row.labelStatus, "all"] as const) {
        const key = `${row.mode}\0${row.cutoff}\0${repository}\0${labelStatus}`;
        const values = groups.get(key); if (values) values.push(row); else groups.set(key, [row]);
      }
    }
  }
  return [...groups.entries()].map(([key, values]) => {
    const [mode, cutoff, repository, labelStatus] = key.split("\0");
    const symbols = values.filter((row) => row.symbolFilePresent !== null);
    return {
      mode, cutoff: Number(cutoff), repository, labelStatus, tasks: values.length,
      fileRecall: recall(values),
      primaryFileRecall: fraction(values, (row) => row.primaryPresent),
      productionFileRecall: fraction(values, (row) => row.productionPositivePresent),
      symbolFileRecall: symbols.length ? fraction(symbols, (row) => row.symbolFilePresent === true) : null,
      meanCandidateCount: values.reduce((sum, row) => sum + row.candidateCount, 0) / values.length,
      meanLatencyMs: values.reduce((sum, row) => sum + row.latencyMs, 0) / values.length
    };
  }).sort((left, right) => String(left.mode).localeCompare(String(right.mode)) || Number(left.cutoff) - Number(right.cutoff) || String(left.repository).localeCompare(String(right.repository)) || String(left.labelStatus).localeCompare(String(right.labelStatus)));
}

function recall(rows: EvaluationRow[]): number { return fraction(rows, (row) => row.anyPositivePresent); }
function fraction(rows: EvaluationRow[], predicate: (row: EvaluationRow) => boolean): number { return rows.length ? rows.filter(predicate).length / rows.length : 0; }
function repositoryCoverageMeaningful(rows: EvaluationRow[]): boolean {
  const repositories = new Map<string, EvaluationRow[]>();
  for (const row of rows) repositories.set(row.repository, [...(repositories.get(row.repository) ?? []), row]);
  return [...repositories.values()].every((values) => values.filter((row) => row.anyPositivePresent).length >= 10);
}

function oracleContribution(rows: EvaluationRow[]) {
  const sourceModes: CandidateGenerationMode[] = [
    "bm25-files", "title-bm25", "symbol-bm25", "chunk-bm25", "exact-symbol",
    "exact-identifier", "path-lookup", "test-expansion", "structural-expansion"
  ];
  return [50, 200].map((cutoff) => {
    const byMode = new Map(sourceModes.map((mode) => [mode, rows.filter((row) => row.mode === mode && row.cutoff === cutoff)]));
    const byTask = new Map<string, Map<CandidateGenerationMode, boolean>>();
    for (const mode of sourceModes) for (const row of byMode.get(mode) ?? []) {
      const values = byTask.get(row.taskId) ?? new Map<CandidateGenerationMode, boolean>();
      values.set(mode, row.anyPositivePresent); byTask.set(row.taskId, values);
    }
    const body = new Map((byMode.get("bm25-files") ?? []).map((row) => [row.taskId, row.anyPositivePresent]));
    const generators = sourceModes.map((mode) => {
      const modeRows = byMode.get(mode) ?? [];
      const solved = new Set(modeRows.filter((row) => row.anyPositivePresent).map((row) => row.taskId));
      return {
        generator: mode,
        recallAlone: recall(modeRows),
        newPositivesBeyondBodyBm25: [...solved].filter((taskId) => !body.get(taskId)).length,
        uniqueMissesSolved: [...solved].filter((taskId) => sourceModes.every((other) => other === mode || !byTask.get(taskId)?.get(other))).length
      };
    });
    const tasks = [...byTask.keys()];
    const tasksWithPositive = tasks.filter((taskId) => sourceModes.some((mode) => byTask.get(taskId)?.get(mode))).length;
    return { cutoff, tasks: tasks.length, fullSourceUnionRecall: tasks.length ? tasksWithPositive / tasks.length : 0, generators };
  });
}

async function loadInputs(inputs: string[]): Promise<LoadedCorpus> {
  const repositories = new Map<string, CorpusRepository>();
  const tasks = new Map<string, CorpusTask>();
  for (const input of inputs) {
    const value = JSON.parse(await readFile(input, "utf8")) as CorpusManifest | CorpusCollectionDraft;
    const inputRepositories = "repository" in value ? [value.repository] : value.repositories;
    for (const repository of inputRepositories) repositories.set(repository.id, repository);
    for (const task of value.tasks) tasks.set(task.id, task);
  }
  return { repositories, tasks };
}

async function readTaskSelection(inputs: string[]): Promise<TaskSelection> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const frozenPositiveByTask = new Map<string, boolean>();
  for (const input of inputs) {
    const contents = await readFile(input, "utf8");
    for (const line of contents.split(/\r?\n/).filter(Boolean)) {
      const row = JSON.parse(line) as { taskId?: string; label?: number };
      const id = row.taskId;
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      if (id) frozenPositiveByTask.set(id, (frozenPositiveByTask.get(id) ?? false) || (row.label ?? 0) > 0);
    }
  }
  return { ids, frozenPositiveByTask };
}

async function readExistingRows(input: string): Promise<EvaluationRow[]> {
  const contents = await readFile(input, "utf8");
  return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as EvaluationRow);
}

async function readAdjudications(input: string, taskIds: Set<string>): Promise<unknown[]> {
  const value = JSON.parse(await readFile(input, "utf8")) as { tasks?: Array<{ taskId?: string; status?: string }> };
  if (!value.tasks) throw new Error(`Adjudication registry has no tasks array: ${input}`);
  const records = value.tasks.filter((record) => record.status === "reviewed" && record.taskId && taskIds.has(record.taskId));
  const missing = [...taskIds].filter((taskId) => !records.some((record) => record.taskId === taskId));
  if (missing.length) throw new Error(`Adjudication registry is missing reviewed tasks: ${missing.join(", ")}`);
  return records;
}

function frozenBaselineSummary(tasks: CorpusTask[], presence: Map<string, boolean>, rows: EvaluationRow[]) {
  const evaluatedPresence = new Map(rows.filter((row) => row.mode === "bm25-plus-exact-symbol" && row.cutoff === 50).map((row) => [row.taskId, row.anyPositivePresent]));
  const positive = presence.size ? presence : evaluatedPresence;
  const repositories: Record<string, { tasks: number; tasksWithPositive: number; recallAt50: number }> = {};
  for (const task of tasks) {
    const value = repositories[task.repositoryId] ?? { tasks: 0, tasksWithPositive: 0, recallAt50: 0 };
    value.tasks += 1;
    if (positive.get(task.id)) value.tasksWithPositive += 1;
    value.recallAt50 = value.tasksWithPositive / value.tasks;
    repositories[task.repositoryId] = value;
  }
  const tasksWithPositive = tasks.filter((task) => positive.get(task.id)).length;
  return {
    policy: "BM25 plus exact-symbol evidence at top 50 under this run's indexing policy",
    tasks: tasks.length,
    tasksWithPositive,
    overallRecallAt50: tasks.length ? tasksWithPositive / tasks.length : 0,
    repositories
  };
}

function parseArgs(values: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]; const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Expected --key value, received ${key ?? "end"}`);
    output.set(key.slice(2), value); index += 1;
  }
  return output;
}
function csv(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function required(values: Map<string, string>, key: string): string { const value = values.get(key); if (!value) throw new Error(`Missing --${key}`); return value; }
async function writeJson(filePath: string, value: unknown): Promise<void> { await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8"); }

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
