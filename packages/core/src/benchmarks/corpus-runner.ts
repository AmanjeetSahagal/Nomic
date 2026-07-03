import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { FilesystemParserProvider } from "../indexing/indexer";
import { HybridRetriever } from "../retrieval/retriever";
import type { ContextCandidate, RepositoryIndex } from "../types/contracts";
import type { CorpusManifest, CorpusRepository, CorpusTask } from "./corpus-contracts";

const exec = promisify(execFile);
export type CorpusRetrievalMode = "bm25" | "heuristic";

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
  firstRelevantRank: number | null; selectedTokens: number; queryMedianMs: number; indexMs: number;
}

interface Bm25Document {
  file: RepositoryIndex["files"][number]; terms: string[]; counts: Map<string, number>;
  pathTerms: string[]; symbolTerms: string[][]; chunks: RepositoryIndex["chunks"];
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
  const retrieve = mode === "bm25"
    ? async () => retrieveBm25(task.query, index, 50)
    : async () => (await heuristicRetriever.retrieve({ text: task.query, target: "codex", repositoryRoot: index.repositoryRoot }, index)).candidates;
  await retrieve();
  const latencies: number[] = [];
  let candidates: ContextCandidate[] = [];
  for (let iteration = 0; iteration < repetitions; iteration += 1) {
    const started = performance.now(); candidates = await retrieve(); latencies.push(performance.now() - started);
  }
  const top = candidates.slice(0, 10);
  const rankedPaths = top.map((candidate) => candidate.path);
  const metrics = gradedMetrics(rankedPaths, task);
  return {
    taskId: task.id, repositoryId: task.repositoryId, taskType: task.taskType, mode, split: task.split, rankedPaths,
    primaryFiles: task.relevance.primaryFiles, ...metrics,
    selectedTokens: top.reduce((sum, candidate) => sum + candidate.tokenCost, 0),
    queryMedianMs: median(latencies), indexMs
  };
}

export function retrieveBm25(query: string, index: RepositoryIndex, limit: number): ContextCandidate[] {
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
      return { file, terms, counts, pathTerms: tokenize(file.path), symbolTerms: file.symbols.map((symbol) => tokenize(symbol.name)), chunks };
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
    for (const documentIndex of prepared.pathPostings.get(term) ?? []) scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + idf * 5);
    const symbolWeight = 120 + (identifierTerms.has(term) ? 200 : 0);
    for (const documentIndex of prepared.symbolPostings.get(term) ?? []) scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + idf * symbolWeight);
  }
  return [...scores.entries()].sort((left, right) => right[1] - left[1] || prepared.documents[left[0]].file.path.localeCompare(prepared.documents[right[0]].file.path)).slice(0, limit).map(([documentIndex, score]): ContextCandidate => {
    const { file, chunks } = prepared.documents[documentIndex];
    const selectedChunks = selectBm25Chunks(chunks, queryTerms, 2);
    return { path: file.path, reason: `BM25 score ${score.toFixed(3)}`, score, source: "lexical", role: file.isTest ? "test" : "primary", stage: "seed", dependencyDistance: 0, structuralScore: 0, semanticScore: 0, lexicalScore: score, recencyScore: 0, fileImportanceScore: file.symbols.length, tokenCost: selectedChunks.length ? selectedChunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0) : Math.ceil(file.size / 4), chunkIds: selectedChunks.map((chunk) => chunk.id), expansionPath: [file.path] };
  });
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

async function materializeRepository(repository: CorpusRepository, commit: string, cacheDirectory: string): Promise<string> {
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
  const metadata = { schemaVersion: 1, corpus: manifest.name, generatedAt: new Date().toISOString(), gitCommit: await currentCommit(), machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem(), node: process.version }, repetitions: options.repetitions ?? 5, modes: options.modes };
  await writeFile(path.join(options.outputDirectory, "run-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "per-task-results.jsonl"), results.map((result) => JSON.stringify(result)).join("\n") + "\n");
  await writeFile(path.join(options.outputDirectory, "aggregate-results.json"), JSON.stringify(aggregates, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "head-to-head.json"), JSON.stringify(headToHead, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "failure-summary.json"), JSON.stringify(failureBreakdown, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "quality-breakdown.json"), JSON.stringify(qualityBreakdown, null, 2) + "\n");
  await writeFile(path.join(options.outputDirectory, "failures.jsonl"), failures.map((failure) => JSON.stringify(failure)).join("\n") + (failures.length ? "\n" : ""));
  const rows = aggregates.map((item) => `| ${item.mode} | ${item.tasks} | ${item.recallAt5.toFixed(3)} | ${item.recallAt10.toFixed(3)} | ${item.mrr.toFixed(3)} | ${item.ndcgAt10.toFixed(3)} | ${item.medianTokens.toFixed(0)} | ${item.p95Tokens.toFixed(0)} | ${item.medianMs.toFixed(1)} | ${item.p95Ms.toFixed(1)} |`).join("\n");
  const comparisonRows: Array<[string, number, number]> = [
    ["Heuristic improves first relevant rank", headToHead.improves, headToHead.improvesFraction],
    ["Same rank", headToHead.ties, headToHead.tiesFraction],
    ["Heuristic worsens first relevant rank", headToHead.worsens, headToHead.worsensFraction]
  ];
  const comparisonTable = comparisonRows.map(([label, count, fraction]) => `| ${label} | ${count} | ${(fraction * 100).toFixed(1)}% |`).join("\n");
  const failureRows = failureBreakdown.length > 0
    ? failureBreakdown.map((item) => `| ${item.repositoryId} | ${item.taskType} | ${item.count} |`).join("\n")
    : "| none | none | 0 |";
  const qualityRows = qualityBreakdown.map((item) => `| ${item.mode} | ${item.repositoryId} | ${item.taskType} | ${item.tasks} | ${item.missesAt5} | ${item.missesAt10} | ${item.mrr.toFixed(3)} |`).join("\n");
  await writeFile(path.join(options.outputDirectory, "comparison.md"), `# Corpus comparison\n\n| Mode | Tasks | Recall@5 | Recall@10 | MRR | NDCG@10 | Median tokens | P95 tokens | Median ms | P95 ms |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n## First relevant rank\n\n| Comparison | Count | Percentage |\n|---|---:|---:|\n${comparisonTable}\n\nPaired tasks: ${headToHead.pairedTasks}. Mean heuristic token savings: ${(headToHead.meanTokenSavingsFraction * 100).toFixed(1)}%.\n\n## Retrieval misses\n\n| Mode | Repository | Task type | Tasks | No primary hit @5 | No primary hit @10 | MRR |\n|---|---|---|---:|---:|---:|---:|\n${qualityRows}\n\n## Execution failures\n\n| Repository | Task type | Count |\n|---|---|---:|\n${failureRows}\n`);
}

function aggregate(mode: CorpusRetrievalMode, rows: CorpusTaskResult[]) { const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length); return { mode, tasks: rows.length, recallAt5: avg(rows.map((r) => r.recallAt5)), recallAt10: avg(rows.map((r) => r.recallAt10)), mrr: avg(rows.map((r) => r.reciprocalRank)), ndcgAt10: avg(rows.map((r) => r.ndcgAt10)), contextPrecision: avg(rows.map((r) => r.contextPrecision)), meanTokens: avg(rows.map((r) => r.selectedTokens)), medianTokens: median(rows.map((r) => r.selectedTokens)), p95Tokens: percentile(rows.map((r) => r.selectedTokens), .95), medianMs: median(rows.map((r) => r.queryMedianMs)), p95Ms: percentile(rows.map((r) => r.queryMedianMs), .95) }; }
export function compareModes(rows: CorpusTaskResult[]) {
  const byTask = new Map<string, Partial<Record<CorpusRetrievalMode, CorpusTaskResult>>>();
  for (const row of rows) byTask.set(row.taskId, { ...byTask.get(row.taskId), [row.mode]: row });
  let improves = 0; let ties = 0; let worsens = 0; const tokenSavings: number[] = [];
  for (const pair of byTask.values()) {
    if (!pair.bm25 || !pair.heuristic) continue;
    const bm25Rank = pair.bm25.firstRelevantRank ?? Number.POSITIVE_INFINITY;
    const heuristicRank = pair.heuristic.firstRelevantRank ?? Number.POSITIVE_INFINITY;
    if (heuristicRank < bm25Rank) improves += 1; else if (heuristicRank > bm25Rank) worsens += 1; else ties += 1;
    if (pair.bm25.selectedTokens > 0) tokenSavings.push((pair.bm25.selectedTokens - pair.heuristic.selectedTokens) / pair.bm25.selectedTokens);
  }
  const pairedTasks = improves + ties + worsens;
  return { pairedTasks, improves, ties, worsens, improvesFraction: pairedTasks ? improves / pairedTasks : 0, tiesFraction: pairedTasks ? ties / pairedTasks : 0, worsensFraction: pairedTasks ? worsens / pairedTasks : 0, meanTokenSavingsFraction: tokenSavings.reduce((sum, value) => sum + value, 0) / Math.max(1, tokenSavings.length) };
}
function summarizeFailures(failures: unknown[]) { const counts = new Map<string, { repositoryId: string; taskType: string; count: number }>(); for (const value of failures) { if (!value || typeof value !== "object") continue; const failure = value as { repositoryId?: string; taskType?: string }; const repositoryId = failure.repositoryId ?? "unknown"; const taskType = failure.taskType ?? "unknown"; const key = `${repositoryId}\0${taskType}`; const entry = counts.get(key); if (entry) entry.count += 1; else counts.set(key, { repositoryId, taskType, count: 1 }); } return [...counts.values()].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.taskType.localeCompare(right.taskType)); }
function summarizeQuality(rows: CorpusTaskResult[]) { const groups = new Map<string, CorpusTaskResult[]>(); for (const row of rows) { const key = `${row.mode}\0${row.repositoryId}\0${row.taskType}`; const values = groups.get(key); if (values) values.push(row); else groups.set(key, [row]); } return [...groups.values()].map((values) => ({ mode: values[0].mode, repositoryId: values[0].repositoryId, taskType: values[0].taskType, tasks: values.length, missesAt5: values.filter((row) => row.recallAt5 === 0).length, missesAt10: values.filter((row) => row.recallAt10 === 0).length, mrr: values.reduce((sum, row) => sum + row.reciprocalRank, 0) / values.length })).sort((left, right) => left.mode.localeCompare(right.mode) || left.repositoryId.localeCompare(right.repositoryId) || left.taskType.localeCompare(right.taskType)); }
function tokenize(value: string) { return value.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length >= 2); }
function extractIdentifierTerms(value: string): Set<string> { return new Set([...value.matchAll(/`([^`]+)`/g)].flatMap((match) => tokenize(match[1] ?? ""))); }
function addPosting<T>(postings: Map<string, T[]>, term: string, value: T) { const values = postings.get(term); if (values) values.push(value); else postings.set(term, [value]); }
function addSetPosting(postings: Map<string, Set<number>>, term: string, value: number) { const values = postings.get(term); if (values) values.add(value); else postings.set(term, new Set([value])); }
function selectBm25Chunks(chunks: RepositoryIndex["chunks"], queryTerms: string[], limit: number) { return chunks.map((chunk) => { const terms = new Set(tokenize(chunk.text)); return { chunk, overlap: queryTerms.reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0) }; }).sort((left, right) => right.overlap - left.overlap || left.chunk.startLine - right.chunk.startLine).slice(0, limit).map((entry) => entry.chunk); }
function median(values: number[]) { return percentile(values, .5); }
function percentile(values: number[], q: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0; }
async function currentCommit() { try { return (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(); } catch { return "unknown"; } }
