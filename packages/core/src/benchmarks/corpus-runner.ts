import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { FilesystemParserProvider } from "../indexing/indexer";
import { HybridRetriever, LocalEmbeddingProvider } from "../retrieval/retriever";
import type { ContextCandidate, RepositoryIndex } from "../types/contracts";
import type { CorpusManifest, CorpusRepository, CorpusTask } from "./corpus-contracts";

const exec = promisify(execFile);
export type CorpusRetrievalMode =
  | "bm25"
  | "bm25_body"
  | "bm25_packed"
  | "bm25_path"
  | "bm25_symbol"
  | "bm25_symbol_packed"
  | "bm25_path_symbol"
  | "bm25_graph"
  | "bm25_semantic"
  | "heuristic";

export interface CorpusRunOptions {
  manifestPath: string;
  cacheDirectory: string;
  outputDirectory: string;
  modes: CorpusRetrievalMode[];
  repositoryId?: string;
  limit?: number;
  repetitions?: number;
}

export interface CorpusTaskResult {
  taskId: string; repositoryId: string; taskType: CorpusTask["taskType"]; mode: CorpusRetrievalMode; split: string;
  rankedPaths: string[]; primaryFiles: string[]; recallAt5: number; recallAt10: number;
  reciprocalRank: number; ndcgAt10: number; contextPrecision: number;
  firstRelevantRank: number | null; firstRelevantCandidateRank: number | null;
  firstPrimaryCandidateRank: number | null; candidatePoolPaths: string[];
  relevantCandidatePresent: boolean; primaryCandidatePresent: boolean;
  selectedTokens: number; packedFileCount: number; relevantSymbolIncluded: boolean;
  coldQueryMs: number; queryMedianMs: number; stageMedianMs: Record<string, number>; indexMs: number;
  indexStageTimingsMs: Record<string, number>;
  sourceCounts: Record<string, number>;
}

interface Bm25Options { pathBoost: boolean; symbolBoost: boolean; packChunks: boolean }
interface RetrievalExecution { candidates: ContextCandidate[]; stageTimingsMs: Record<string, number> }

interface Bm25Document {
  file: RepositoryIndex["files"][number]; terms: string[]; counts: Map<string, number>;
  pathTerms: string[]; symbolTerms: string[][]; chunks: RepositoryIndex["chunks"];
  chunkTerms: Array<{ chunk: RepositoryIndex["chunks"][number]; terms: Set<string> }>;
}

interface Bm25PreparedIndex {
  documents: Bm25Document[];
  averageLength: number;
  bodyPostings: Map<string, Array<{ documentIndex: number; frequency: number }>>;
  pathPostings: Map<string, Set<number>>;
  symbolPostings: Map<string, Set<number>>;
}

const bm25DocumentCache = new WeakMap<RepositoryIndex, Bm25PreparedIndex>();

export async function runCorpusBenchmark(options: CorpusRunOptions): Promise<{ results: CorpusTaskResult[]; failures: unknown[] }> {
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as CorpusManifest;
  let tasks = manifest.tasks.filter((task) => task.review.status === "accepted");
  if (options.repositoryId) tasks = tasks.filter((task) => task.repositoryId === options.repositoryId);
  if (options.limit) tasks = tasks.slice(0, options.limit);
  const repositories = new Map(manifest.repositories.map((repository) => [repository.id, repository]));
  const results: CorpusTaskResult[] = [];
  const failures: Array<{ taskId: string; repositoryId: string; taskType: CorpusTask["taskType"]; message: string }> = [];
  await mkdir(options.cacheDirectory, { recursive: true });

  for (const task of tasks) {
    const repository = repositories.get(task.repositoryId);
    if (!repository) { failures.push({ taskId: task.id, repositoryId: task.repositoryId, taskType: task.taskType, message: "repository not registered" }); continue; }
    try {
      const repositoryRoot = await materializeRepository(repository, task.baseCommit, options.cacheDirectory);
      const indexStarted = performance.now();
      const index = await new FilesystemParserProvider().indexRepository({ repositoryRoot });
      const indexMs = performance.now() - indexStarted;
      for (const mode of options.modes) results.push(await runTask(task, index, mode, options.repetitions ?? 5, indexMs));
    } catch (error: unknown) {
      failures.push({ taskId: task.id, repositoryId: task.repositoryId, taskType: task.taskType, message: error instanceof Error ? error.message : String(error) });
    }
  }
  await writeCorpusArtifacts(options, manifest, results, failures);
  return { results, failures };
}

export async function runTask(task: CorpusTask, index: RepositoryIndex, mode: CorpusRetrievalMode, repetitions: number, indexMs: number): Promise<CorpusTaskResult> {
  const heuristicRetriever = new HybridRetriever();
  const semanticProvider = new LocalEmbeddingProvider();
  let graphLookup: Map<string, RepositoryIndex["edges"]> | undefined;
  const retrieve = mode === "heuristic"
    ? async (): Promise<RetrievalExecution> => {
      const result = await heuristicRetriever.retrieve({ text: task.query, target: "codex", repositoryRoot: index.repositoryRoot }, index);
      return { candidates: result.candidates, stageTimingsMs: result.stageTimingsMs ?? {} };
    }
    : mode === "bm25_graph"
      ? async (): Promise<RetrievalExecution> => {
        const base = retrieveBm25WithDiagnostics(task.query, index, 50, bm25Options(mode));
        const started = performance.now();
        graphLookup ??= buildCorpusGraphLookup(index);
        const graphCandidates = expandBm25Graph(base.candidates, index, graphLookup, task.query);
        const candidates = fuseRankedCandidates(base.candidates, graphCandidates, 50);
        return { candidates, stageTimingsMs: { ...base.stageTimingsMs, graph: performance.now() - started } };
      }
      : mode === "bm25_semantic"
        ? async (): Promise<RetrievalExecution> => {
          const base = retrieveBm25WithDiagnostics(task.query, index, 50, bm25Options(mode));
          const started = performance.now();
          const semantic = await semanticProvider.search({ text: task.query, target: "codex", repositoryRoot: index.repositoryRoot }, index);
          const candidates = fuseRankedCandidates(base.candidates, semantic, 50);
          return { candidates, stageTimingsMs: { ...base.stageTimingsMs, semantic: performance.now() - started } };
        }
        : async (): Promise<RetrievalExecution> => retrieveBm25WithDiagnostics(task.query, index, 50, bm25Options(mode));
  const coldStarted = performance.now();
  await retrieve();
  const coldQueryMs = performance.now() - coldStarted;
  const latencies: number[] = [];
  const stageTimings = new Map<string, number[]>();
  let candidates: ContextCandidate[] = [];
  for (let iteration = 0; iteration < repetitions; iteration += 1) {
    const started = performance.now(); const execution = await retrieve(); latencies.push(performance.now() - started);
    candidates = execution.candidates;
    for (const [stage, duration] of Object.entries(execution.stageTimingsMs)) {
      const values = stageTimings.get(stage); if (values) values.push(duration); else stageTimings.set(stage, [duration]);
    }
  }
  const top = candidates.slice(0, 10);
  const rankedPaths = top.map((candidate) => candidate.path);
  const metrics = gradedMetrics(rankedPaths, task);
  const relevantPaths = new Set([...task.relevance.primaryFiles, ...task.relevance.supportingFiles, ...task.relevance.relevantUnchangedFiles]);
  const firstRelevantCandidate = candidates.findIndex((candidate) => relevantPaths.has(candidate.path));
  const primaryPaths = new Set(task.relevance.primaryFiles);
  const firstPrimaryCandidate = candidates.findIndex((candidate) => primaryPaths.has(candidate.path));
  const sourceCounts: Record<string, number> = {};
  for (const candidate of candidates) sourceCounts[candidate.stage] = (sourceCounts[candidate.stage] ?? 0) + 1;
  return {
    taskId: task.id, repositoryId: task.repositoryId, taskType: task.taskType, mode, split: task.split, rankedPaths,
    primaryFiles: task.relevance.primaryFiles, ...metrics,
    firstRelevantCandidateRank: firstRelevantCandidate < 0 ? null : firstRelevantCandidate + 1,
    firstPrimaryCandidateRank: firstPrimaryCandidate < 0 ? null : firstPrimaryCandidate + 1,
    candidatePoolPaths: candidates.map((candidate) => candidate.path),
    relevantCandidatePresent: firstRelevantCandidate >= 0,
    primaryCandidatePresent: firstPrimaryCandidate >= 0,
    selectedTokens: top.reduce((sum, candidate) => sum + candidate.tokenCost, 0),
    packedFileCount: top.filter((candidate) => candidate.chunkIds.length > 0).length,
    relevantSymbolIncluded: includesRelevantSymbol(task, top, index),
    coldQueryMs,
    queryMedianMs: median(latencies),
    stageMedianMs: Object.fromEntries([...stageTimings].map(([stage, values]) => [stage, median(values)])),
    sourceCounts,
    indexMs,
    indexStageTimingsMs: index.metrics.stageTimingsMs ?? {}
  };
}

export function retrieveBm25(query: string, index: RepositoryIndex, limit: number): ContextCandidate[] {
  return retrieveBm25WithDiagnostics(query, index, limit, bm25Options("bm25")).candidates;
}

function retrieveBm25WithDiagnostics(query: string, index: RepositoryIndex, limit: number, options: Bm25Options): RetrievalExecution {
  const totalStarted = performance.now();
  const prepareStarted = performance.now();
  let prepared = bm25DocumentCache.get(index);
  if (!prepared) {
    const chunksByFile = new Map<string, RepositoryIndex["chunks"]>();
    for (const chunk of index.chunks) {
      const chunks = chunksByFile.get(chunk.filePath);
      if (chunks) chunks.push(chunk); else chunksByFile.set(chunk.filePath, [chunk]);
    }
    const documents = index.files.map((file): Bm25Document => {
      const chunks = chunksByFile.get(file.path) ?? [];
      const terms = tokenize(chunks.map((chunk) => chunk.text).join(" "));
      const counts = new Map<string, number>(); for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      return { file, terms, counts, pathTerms: tokenize(file.path), symbolTerms: file.symbols.map((symbol) => tokenize(symbol.name)), chunks, chunkTerms: chunks.map((chunk) => ({ chunk, terms: new Set(tokenize(chunk.text)) })) };
    });
    const bodyPostings = new Map<string, Array<{ documentIndex: number; frequency: number }>>();
    const pathPostings = new Map<string, Set<number>>();
    const symbolPostings = new Map<string, Set<number>>();
    documents.forEach((document, documentIndex) => {
      for (const [term, frequency] of document.counts) addPosting(bodyPostings, term, { documentIndex, frequency });
      for (const term of new Set(document.pathTerms)) addSetPosting(pathPostings, term, documentIndex);
      for (const term of new Set(document.symbolTerms.flat())) addSetPosting(symbolPostings, term, documentIndex);
    });
    prepared = {
      documents,
      averageLength: documents.reduce((sum, document) => sum + document.terms.length, 0) / Math.max(1, documents.length),
      bodyPostings,
      pathPostings,
      symbolPostings
    };
    bm25DocumentCache.set(index, prepared);
  }
  const prepareMs = performance.now() - prepareStarted;
  const scoringStarted = performance.now();
  const queryTerms = [...new Set(tokenize(query))];
  const identifierTerms = extractIdentifierTerms(query);
  const scores = new Map<number, number>();
  for (const term of queryTerms) {
    const bodyMatches = prepared.bodyPostings.get(term) ?? [];
    const frequency = bodyMatches.length;
    const idf = Math.log(1 + (prepared.documents.length - frequency + 0.5) / (frequency + 0.5));
    for (const posting of bodyMatches) {
      const document = prepared.documents[posting.documentIndex];
      const bm25 = idf * (posting.frequency * 2.2) / (posting.frequency + 1.2 * (0.25 + 0.75 * document.terms.length / Math.max(1, prepared.averageLength)));
      scores.set(posting.documentIndex, (scores.get(posting.documentIndex) ?? 0) + bm25);
    }
    if (options.pathBoost) for (const documentIndex of prepared.pathPostings.get(term) ?? []) scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + idf * 5);
    const symbolWeight = 120 + (identifierTerms.has(term) ? 200 : 0);
    if (options.symbolBoost) for (const documentIndex of prepared.symbolPostings.get(term) ?? []) scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + idf * symbolWeight);
  }
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1] || prepared.documents[left[0]].file.path.localeCompare(prepared.documents[right[0]].file.path)).slice(0, limit);
  const scoringMs = performance.now() - scoringStarted;
  const packingStarted = performance.now();
  const candidates = ranked.map(([documentIndex, score]): ContextCandidate => {
    const { file, chunks, chunkTerms } = prepared.documents[documentIndex];
    const selectedChunks = options.packChunks ? selectPreparedBm25Chunks(chunkTerms, queryTerms, 2) : chunks;
    return { path: file.path, reason: `BM25 score ${score.toFixed(3)}`, score, source: "lexical", role: file.isTest ? "test" : "primary", stage: "seed", dependencyDistance: 0, structuralScore: 0, semanticScore: 0, lexicalScore: score, recencyScore: 0, fileImportanceScore: file.symbols.length, tokenCost: selectedChunks.length ? selectedChunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0) : Math.ceil(file.size / 4), chunkIds: selectedChunks.map((chunk) => chunk.id), expansionPath: [file.path] };
  });
  const packingMs = performance.now() - packingStarted;
  return { candidates, stageTimingsMs: { prepare: prepareMs, scoring: scoringMs, packing: packingMs, total: performance.now() - totalStarted } };
}

export function gradedMetrics(rankedPaths: string[], task: CorpusTask) {
  const grades = new Map<string, number>();
  for (const file of task.relevance.relevantUnchangedFiles) grades.set(file, 1);
  for (const file of task.relevance.supportingFiles) grades.set(file, 2);
  for (const file of task.relevance.primaryFiles) grades.set(file, 3);
  const primary = new Set(task.relevance.primaryFiles); const hits = (n: number) => new Set(rankedPaths.slice(0, n).filter((file) => primary.has(file))).size;
  const first = rankedPaths.findIndex((file) => primary.has(file));
  const firstRelevant = rankedPaths.findIndex((file) => grades.has(file));
  const dcg = rankedPaths.slice(0, 10).reduce((sum, file, i) => sum + ((2 ** (grades.get(file) ?? 0)) - 1) / Math.log2(i + 2), 0);
  const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, 10).reduce((sum, grade, i) => sum + ((2 ** grade) - 1) / Math.log2(i + 2), 0);
  return { recallAt5: hits(5) / primary.size, recallAt10: hits(10) / primary.size, reciprocalRank: first < 0 ? 0 : 1 / (first + 1), ndcgAt10: ideal ? dcg / ideal : 0, contextPrecision: rankedPaths.length ? rankedPaths.filter((file) => grades.has(file)).length / rankedPaths.length : 0, firstRelevantRank: firstRelevant < 0 ? null : firstRelevant + 1 };
}

export async function materializeRepository(repository: CorpusRepository, commit: string, cacheDirectory: string): Promise<string> {
  const destination = path.join(cacheDirectory, repository.id.replace("/", "--"));
  try { await stat(path.join(destination, ".git")); } catch { await exec("git", ["clone", "--filter=blob:none", "--no-checkout", repository.url, destination], { maxBuffer: 10_000_000 }); }
  let hasCommit = true;
  try { await exec("git", ["-C", destination, "cat-file", "-e", `${commit}^{commit}`]); } catch { hasCommit = false; }
  if (!hasCommit) await exec("git", ["-C", destination, "fetch", "--depth=1", "origin", commit], { maxBuffer: 10_000_000 });
  await exec("git", ["-C", destination, "checkout", "--force", commit], { maxBuffer: 10_000_000 });
  await rm(path.join(destination, ".nomic"), { recursive: true, force: true }); return destination;
}

export async function writeCorpusArtifacts(options: CorpusRunOptions, manifest: CorpusManifest, results: CorpusTaskResult[], failures: unknown[]): Promise<void> {
  await mkdir(options.outputDirectory, { recursive: true }); const aggregates = options.modes.map((mode) => aggregate(mode, results.filter((result) => result.mode === mode)));
  const headToHead = compareModes(results);
  const failureBreakdown = summarizeFailures(failures);
  const qualityBreakdown = summarizeQuality(results);
  const failureAnalysis = analyzeTaskOutcomes(manifest, results);
  const stageSummary = summarizeStages(results);
  const metadata = { schemaVersion: 1, corpus: manifest.name, generatedAt: new Date().toISOString(), gitCommit: await currentCommit(), machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem(), node: process.version }, repetitions: options.repetitions ?? 5, modes: options.modes };
  await writeFile(path.join(options.outputDirectory, "run-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "per-task-results.jsonl"), results.map((result) => JSON.stringify(result)).join("\n") + "\n");
  await writeFile(path.join(options.outputDirectory, "aggregate-results.json"), JSON.stringify(aggregates, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "head-to-head.json"), JSON.stringify(headToHead, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "failure-summary.json"), JSON.stringify(failureBreakdown, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "quality-breakdown.json"), JSON.stringify(qualityBreakdown, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "failure-analysis.json"), JSON.stringify(failureAnalysis, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "stage-summary.json"), JSON.stringify(stageSummary, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "failures.jsonl"), failures.map((failure) => JSON.stringify(failure)).join("\n") + (failures.length ? "\n" : ""));
  const rows = aggregates.map((item) => `| ${item.mode} | ${item.tasks} | ${item.recallAt5.toFixed(3)} | ${item.recallAt10.toFixed(3)} | ${item.mrr.toFixed(3)} | ${item.ndcgAt10.toFixed(3)} | ${item.medianTokens.toFixed(0)} | ${item.p95Tokens.toFixed(0)} | ${item.medianMs.toFixed(1)} | ${item.p95Ms.toFixed(1)} |`).join("\n");
  const comparisonRows: Array<[string, number, number]> = [
    ["Heuristic improves first relevant rank", headToHead.improves, headToHead.improvesFraction],
    ["Same rank", headToHead.ties, headToHead.tiesFraction],
    ["Heuristic worsens first relevant rank", headToHead.worsens, headToHead.worsensFraction]
  ];
  const comparisonTable = comparisonRows.map(([label, count, fraction]) => `| ${label} | ${count} | ${(fraction * 100).toFixed(1)}% |`).join("\n");
  const includesBm25HeuristicPair = results.some((result) => result.mode === "bm25") && results.some((result) => result.mode === "heuristic");
  const headToHeadSection = includesBm25HeuristicPair
    ? `\n## First relevant rank\n\n| Comparison | Count | Percentage |\n|---|---:|---:|\n${comparisonTable}\n\nSuccessful same-rank ties: ${headToHead.successfulSameRank}. Both failed in top 10: ${headToHead.bothFailedTop10}. Correct file absent from both candidate pools: ${headToHead.bothAbsentCandidatePools}.\n\nPaired tasks: ${headToHead.pairedTasks}. Mean heuristic token savings: ${(headToHead.meanTokenSavingsFraction * 100).toFixed(1)}%.\n`
    : "";
  const failureRows = failureBreakdown.length > 0
    ? failureBreakdown.map((item) => `| ${item.repositoryId} | ${item.taskType} | ${item.count} |`).join("\n")
    : "| none | none | 0 |";
  const qualityRows = qualityBreakdown.map((item) => `| ${item.mode} | ${item.repositoryId} | ${item.taskType} | ${item.tasks} | ${item.missesAt5} | ${item.missesAt10} | ${item.mrr.toFixed(3)} |`).join("\n");
  await writeFile(path.join(options.outputDirectory, "comparison.md"), `# Corpus comparison\n\n| Mode | Tasks | Recall@5 | Recall@10 | MRR | NDCG@10 | Median tokens | P95 tokens | Median ms | P95 ms |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n${headToHeadSection}\n## Retrieval misses\n\n| Mode | Repository | Task type | Tasks | No primary hit @5 | No primary hit @10 | MRR |\n|---|---|---|---:|---:|---:|---:|\n${qualityRows}\n\n## Execution failures\n\n| Repository | Task type | Count |\n|---|---|---:|\n${failureRows}\n`);
}

function aggregate(mode: CorpusRetrievalMode, rows: CorpusTaskResult[]) { const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length); return { mode, tasks: rows.length, recallAt5: avg(rows.map((r) => r.recallAt5)), recallAt10: avg(rows.map((r) => r.recallAt10)), mrr: avg(rows.map((r) => r.reciprocalRank)), ndcgAt10: avg(rows.map((r) => r.ndcgAt10)), contextPrecision: avg(rows.map((r) => r.contextPrecision)), meanTokens: avg(rows.map((r) => r.selectedTokens)), medianTokens: median(rows.map((r) => r.selectedTokens)), p95Tokens: percentile(rows.map((r) => r.selectedTokens), .95), medianColdMs: median(rows.map((r) => r.coldQueryMs)), p95ColdMs: percentile(rows.map((r) => r.coldQueryMs), .95), medianMs: median(rows.map((r) => r.queryMedianMs)), p95Ms: percentile(rows.map((r) => r.queryMedianMs), .95) }; }
export function compareModes(rows: CorpusTaskResult[]) {
  const byTask = new Map<string, Partial<Record<CorpusRetrievalMode, CorpusTaskResult>>>();
  for (const row of rows) byTask.set(row.taskId, { ...byTask.get(row.taskId), [row.mode]: row });
  let improves = 0; let ties = 0; let worsens = 0; let successfulSameRank = 0; let bothFailedTop10 = 0; let bothAbsentCandidatePools = 0; const tokenSavings: number[] = [];
  for (const pair of byTask.values()) {
    if (!pair.bm25 || !pair.heuristic) continue;
    const bm25Rank = pair.bm25.firstRelevantRank ?? Number.POSITIVE_INFINITY;
    const heuristicRank = pair.heuristic.firstRelevantRank ?? Number.POSITIVE_INFINITY;
    if (heuristicRank < bm25Rank) improves += 1;
    else if (heuristicRank > bm25Rank) worsens += 1;
    else {
      ties += 1;
      if (Number.isFinite(bm25Rank)) successfulSameRank += 1;
      else {
        bothFailedTop10 += 1;
        if (!pair.bm25.primaryCandidatePresent && !pair.heuristic.primaryCandidatePresent) bothAbsentCandidatePools += 1;
      }
    }
    if (pair.bm25.selectedTokens > 0) tokenSavings.push((pair.bm25.selectedTokens - pair.heuristic.selectedTokens) / pair.bm25.selectedTokens);
  }
  const pairedTasks = improves + ties + worsens;
  return { pairedTasks, improves, ties, worsens, successfulSameRank, bothFailedTop10, bothAbsentCandidatePools, improvesFraction: pairedTasks ? improves / pairedTasks : 0, tiesFraction: pairedTasks ? ties / pairedTasks : 0, worsensFraction: pairedTasks ? worsens / pairedTasks : 0, meanTokenSavingsFraction: tokenSavings.reduce((sum, value) => sum + value, 0) / Math.max(1, tokenSavings.length) };
}
function summarizeFailures(failures: unknown[]) { const counts = new Map<string, { repositoryId: string; taskType: string; count: number }>(); for (const value of failures) { if (!value || typeof value !== "object") continue; const failure = value as { repositoryId?: string; taskType?: string }; const repositoryId = failure.repositoryId ?? "unknown"; const taskType = failure.taskType ?? "unknown"; const key = `${repositoryId}\0${taskType}`; const entry = counts.get(key); if (entry) entry.count += 1; else counts.set(key, { repositoryId, taskType, count: 1 }); } return [...counts.values()].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.taskType.localeCompare(right.taskType)); }
function summarizeQuality(rows: CorpusTaskResult[]) { const groups = new Map<string, CorpusTaskResult[]>(); for (const row of rows) { const key = `${row.mode}\0${row.repositoryId}\0${row.taskType}`; const values = groups.get(key); if (values) values.push(row); else groups.set(key, [row]); } return [...groups.values()].map((values) => ({ mode: values[0].mode, repositoryId: values[0].repositoryId, taskType: values[0].taskType, tasks: values.length, missesAt5: values.filter((row) => row.recallAt5 === 0).length, missesAt10: values.filter((row) => row.recallAt10 === 0).length, mrr: values.reduce((sum, row) => sum + row.reciprocalRank, 0) / values.length })).sort((left, right) => left.mode.localeCompare(right.mode) || left.repositoryId.localeCompare(right.repositoryId) || left.taskType.localeCompare(right.taskType)); }
function analyzeTaskOutcomes(manifest: CorpusManifest, rows: CorpusTaskResult[]) { const tasks = new Map(manifest.tasks.map((task) => [task.id, task])); return rows.map((row) => { const task = tasks.get(row.taskId); if (!task) return { taskId: row.taskId, mode: row.mode, failureCategory: "data-label-failure" }; const query = task.query.toLowerCase(); const exactPathInQuery = task.relevance.primaryFiles.some((filePath) => query.includes(filePath.toLowerCase()) || query.includes(path.posix.basename(filePath).toLowerCase())); const exactSymbolInQuery = task.relevance.symbols.some((symbol) => query.includes(symbol.name.toLowerCase())); const failureCategory = row.recallAt10 > 0 ? (task.relevance.symbols.length > 0 && !row.relevantSymbolIncluded ? "context-packing-failure" : "success") : !row.primaryCandidatePresent ? "candidate-generation-failure" : "reranking-failure"; return { taskId: row.taskId, repositoryId: row.repositoryId, taskType: row.taskType, mode: row.mode, firstRelevantRank: row.firstRelevantRank, firstPrimaryCandidateRank: row.firstPrimaryCandidateRank, primaryCandidatePresent: row.primaryCandidatePresent, exactPathInQuery, exactSymbolInQuery, graphExpandedCandidates: row.sourceCounts.graph ?? 0, semanticCandidates: row.sourceCounts.semantic ?? 0, selectedTokens: row.selectedTokens, packedFileCount: row.packedFileCount, relevantSymbolIncluded: row.relevantSymbolIncluded, coldQueryMs: row.coldQueryMs, warmQueryMedianMs: row.queryMedianMs, stageMedianMs: row.stageMedianMs, failureCategory }; }); }
function summarizeStages(rows: CorpusTaskResult[]) { const values = new Map<string, number[]>(); for (const row of rows) { for (const [stage, duration] of Object.entries(row.stageMedianMs)) { const key = `${row.mode}\0${stage}`; const entries = values.get(key); if (entries) entries.push(duration); else values.set(key, [duration]); } } return [...values.entries()].map(([key, durations]) => { const [mode, stage] = key.split("\0"); return { mode, stage, medianMs: median(durations), p95Ms: percentile(durations, .95) }; }).sort((left, right) => left.mode.localeCompare(right.mode) || left.stage.localeCompare(right.stage)); }
function tokenize(value: string) { return value.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length >= 2); }
function bm25Options(mode: CorpusRetrievalMode): Bm25Options {
  if (mode === "bm25") return { pathBoost: true, symbolBoost: true, packChunks: true };
  if (mode === "bm25_path") return { pathBoost: true, symbolBoost: false, packChunks: false };
  if (mode === "bm25_symbol") return { pathBoost: false, symbolBoost: true, packChunks: false };
  if (mode === "bm25_path_symbol") return { pathBoost: true, symbolBoost: true, packChunks: false };
  if (mode === "bm25_symbol_packed") return { pathBoost: false, symbolBoost: true, packChunks: true };
  if (mode === "bm25_packed" || mode === "bm25_graph" || mode === "bm25_semantic") return { pathBoost: false, symbolBoost: false, packChunks: true };
  return { pathBoost: false, symbolBoost: false, packChunks: false };
}
function includesRelevantSymbol(task: CorpusTask, candidates: ContextCandidate[], index: RepositoryIndex): boolean {
  if (task.relevance.symbols.length === 0) return false;
  const chunks = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
  for (const label of task.relevance.symbols) {
    for (const candidate of candidates) {
      if (candidate.path !== label.path) continue;
      if (candidate.symbolId?.toLowerCase().includes(label.name.toLowerCase())) return true;
      for (const chunkId of candidate.chunkIds) {
        const chunk = chunks.get(chunkId); if (!chunk) continue;
        if (label.startLine && label.endLine && chunk.startLine <= label.endLine && chunk.endLine >= label.startLine) return true;
        if (chunk.text.toLowerCase().includes(label.name.toLowerCase())) return true;
      }
    }
  }
  return false;
}
function buildCorpusGraphLookup(index: RepositoryIndex): Map<string, RepositoryIndex["edges"]> {
  const adjacency = new Map<string, RepositoryIndex["edges"]>();
  for (const edge of index.edges) {
    const edges = adjacency.get(edge.from); if (edges) edges.push(edge); else adjacency.set(edge.from, [edge]);
  }
  for (const [filePath, edges] of adjacency) adjacency.set(filePath, edges.sort((left, right) => right.weight - left.weight || left.to.localeCompare(right.to)).slice(0, 16));
  return adjacency;
}
function expandBm25Graph(base: ContextCandidate[], index: RepositoryIndex, adjacency: Map<string, RepositoryIndex["edges"]>, query: string): ContextCandidate[] {
  const files = new Map(index.files.map((file) => [file.path, file]));
  const chunks = new Map<string, RepositoryIndex["chunks"]>();
  for (const chunk of index.chunks) { const values = chunks.get(chunk.filePath); if (values) values.push(chunk); else chunks.set(chunk.filePath, [chunk]); }
  const queryTerms = [...new Set(tokenize(query))]; const expanded = new Map<string, ContextCandidate>();
  for (const seed of base.slice(0, 5)) {
    for (const edge of adjacency.get(seed.path) ?? []) {
      if (expanded.size >= 32 || expanded.has(edge.to) || base.some((candidate) => candidate.path === edge.to)) continue;
      const file = files.get(edge.to); if (!file) continue;
      const selectedChunks = selectBm25Chunks(chunks.get(file.path) ?? [], queryTerms, 2);
      expanded.set(file.path, { path: file.path, reason: `${edge.kind} graph neighbor of ${seed.path}`, score: edge.weight, source: "structural", role: file.isTest ? "test" : "dependency", stage: "graph", dependencyDistance: 1, structuralScore: edge.weight, semanticScore: 0, lexicalScore: 0, recencyScore: 0, fileImportanceScore: file.symbols.length, tokenCost: selectedChunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0), chunkIds: selectedChunks.map((chunk) => chunk.id), expansionPath: [seed.path, file.path] });
    }
  }
  return [...expanded.values()];
}
function fuseRankedCandidates(primary: ContextCandidate[], secondary: ContextCandidate[], limit: number): ContextCandidate[] {
  const fused = new Map<string, ContextCandidate & { score: number }>();
  const add = (candidate: ContextCandidate, rank: number) => {
    const contribution = 1 / (60 + rank);
    const existing = fused.get(candidate.path);
    if (existing) { existing.score += contribution; existing.chunkIds = [...new Set([...existing.chunkIds, ...candidate.chunkIds])]; return; }
    fused.set(candidate.path, { ...candidate, score: contribution });
  };
  primary.forEach((candidate, index) => add(candidate, index + 1));
  secondary.forEach((candidate, index) => add(candidate, index + 1));
  return [...fused.values()].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, limit);
}
function extractIdentifierTerms(value: string): Set<string> { return new Set([...value.matchAll(/`([^`]+)`/g)].flatMap((match) => tokenize(match[1] ?? ""))); }
function addPosting<T>(postings: Map<string, T[]>, term: string, value: T) { const values = postings.get(term); if (values) values.push(value); else postings.set(term, [value]); }
function addSetPosting(postings: Map<string, Set<number>>, term: string, value: number) { const values = postings.get(term); if (values) values.add(value); else postings.set(term, new Set([value])); }
function selectBm25Chunks(chunks: RepositoryIndex["chunks"], queryTerms: string[], limit: number) { return chunks.map((chunk) => { const terms = new Set(tokenize(chunk.text)); return { chunk, overlap: queryTerms.reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0) }; }).sort((left, right) => right.overlap - left.overlap || left.chunk.startLine - right.chunk.startLine).slice(0, limit).map((entry) => entry.chunk); }
function selectPreparedBm25Chunks(chunks: Array<{ chunk: RepositoryIndex["chunks"][number]; terms: Set<string> }>, queryTerms: string[], limit: number) { return chunks.map(({ chunk, terms }) => ({ chunk, overlap: queryTerms.reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0) })).sort((left, right) => right.overlap - left.overlap || left.chunk.startLine - right.chunk.startLine).slice(0, limit).map((entry) => entry.chunk); }
function median(values: number[]) { return percentile(values, .5); }
function percentile(values: number[], q: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0; }
async function currentCommit() { try { return (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(); } catch { return "unknown"; } }
