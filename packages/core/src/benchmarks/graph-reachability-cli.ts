#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { FilesystemParserProvider } from "../indexing/indexer";
import { generateCandidates } from "./candidate-generation";
import type { CorpusManifest, CorpusTask } from "./corpus-contracts";
import { materializeRepository } from "./corpus-runner";
import {
  buildExactCodeGraphStreaming,
  prepareExactCodeGraph,
  traversePreparedExactCodeGraph,
  type GraphReachabilityPath,
  type GraphSourceFileMetadata
} from "./graph-reachability";

interface TaskAuditRow {
  taskId: string;
  repository: string;
  positives: string[];
  lexicalSeeds: Array<{ rank: number; path: string }>;
  baseline: {
    recallAt50: boolean;
    recallAt200: boolean;
    sourceOracleAt200: boolean | null;
    firstPositiveRank: number | null;
    latencyMs: number;
  };
  graph: {
    files: number;
    edges: number;
    failedFiles: Array<{ path: string; error: string }>;
    buildMs: number;
    adjacencyMs: number;
  };
  zeroHop: ReachabilitySummary;
  oneHop: ReachabilitySummary;
  twoHop: ReachabilitySummary;
}

interface ReachabilitySummary {
  positiveReachable: boolean;
  recoveredPositivePaths: GraphReachabilityPath[];
  candidateCount: number;
  latencyMs: number;
  truncated: boolean;
}

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  const input = required(args, "input");
  const outputDirectory = required(args, "output");
  const cacheDirectory = args.get("cache") ?? path.resolve("benchmarks/cache");
  const maxFileSizeBytes = positiveNumber(args, "max-file-size-bytes", 5_000_000);
  const maxNeighborsPerNode = positiveNumber(args, "max-neighbors-per-node", 12);
  const maxGraphCandidates = positiveNumber(args, "max-graph-candidates", 200);
  const acceptableP95Ms = positiveNumber(args, "acceptable-p95-ms", 25);
  const sourceOracleResults = args.get("source-oracle-results");
  const sourceOraclePresence = sourceOracleResults ? await readSourceOraclePresence(sourceOracleResults) : new Map<string, boolean>();
  const manifest = JSON.parse(await readFile(input, "utf8")) as CorpusManifest;
  const selectedIds = new Set(csv(args.get("task-ids") ?? ""));
  const tasks = selectedIds.size ? manifest.tasks.filter((task) => selectedIds.has(task.id)) : manifest.tasks;
  const missing = [...selectedIds].filter((taskId) => !manifest.tasks.some((task) => task.id === taskId));
  if (missing.length) throw new Error(`Task IDs absent from corpus: ${missing.join(", ")}`);
  if (tasks.some((task) => task.review.status !== "accepted")) throw new Error("Reachability audit requires frozen reviewed labels");
  const repositories = new Map(manifest.repositories.map((repository) => [repository.id, repository]));
  const reuseRows = args.get("reuse-rows");
  const rows: TaskAuditRow[] = reuseRows
    ? (await readJsonLines<TaskAuditRow>(reuseRows)).filter((row) => tasks.some((task) => task.id === row.taskId))
    : [];
  if (reuseRows) {
    const missingRows = tasks.filter((task) => !rows.some((row) => row.taskId === task.id));
    if (missingRows.length) throw new Error(`Reused graph rows are missing tasks: ${missingRows.map((task) => task.id).join(", ")}`);
    for (const row of rows) row.baseline.sourceOracleAt200 = sourceOraclePresence.get(row.taskId) ?? null;
  }

  for (const [position, task] of (reuseRows ? [] : tasks).entries()) {
    const repository = repositories.get(task.repositoryId);
    if (!repository) throw new Error(`${task.id}: repository metadata missing`);
    const root = await materializeRepository(repository, task.baseCommit, cacheDirectory);
    const index = await new FilesystemParserProvider().indexRepository({
      repositoryRoot: root,
      excludedPaths: repository.excludedPaths,
      maxFileSizeBytes
    });
    const positives = positivePaths(task);
    const lexical = generateCandidates(task.query, index, "rrf-lexical", 10);
    const seeds = lexical.candidates.map((candidate, rank) => ({ path: candidate.path, rank: rank + 1 }));
    const baseline = generateCandidates(task.query, index, "rrf-reserved-balanced", 200);
    const baselineFirstPositive = baseline.candidates.findIndex((candidate) => positives.has(candidate.path));

    const metadata: GraphSourceFileMetadata[] = index.files.map((file) => ({
      path: file.path,
      isTest: file.isTest,
      symbols: file.symbols
    }));
    const buildStarted = performance.now();
    const built = await buildExactCodeGraphStreaming(metadata, (file) => readFile(path.join(root, file.path), "utf8"));
    const buildMs = performance.now() - buildStarted;
    const adjacencyStarted = performance.now();
    const graph = prepareExactCodeGraph(built.edges);
    const adjacencyMs = performance.now() - adjacencyStarted;
    const oneHop = traversePreparedExactCodeGraph(graph, seeds, {
      maxHops: 1,
      maxNeighborsPerNode,
      maxCandidates: maxGraphCandidates
    });
    const twoHop = traversePreparedExactCodeGraph(graph, seeds, {
      maxHops: 2,
      maxNeighborsPerNode,
      maxCandidates: maxGraphCandidates
    });
    const zeroHopPaths = new Map(seeds.map((seed) => [seed.path, {
      seedPath: seed.path,
      seedRank: seed.rank,
      targetPath: seed.path,
      hops: 0,
      edges: []
    } satisfies GraphReachabilityPath]));

    rows.push({
      taskId: task.id,
      repository: task.repositoryId,
      positives: [...positives].sort(),
      lexicalSeeds: seeds.map((seed) => ({ rank: seed.rank, path: seed.path })),
      baseline: {
        recallAt50: baseline.candidates.slice(0, 50).some((candidate) => positives.has(candidate.path)),
        recallAt200: baselineFirstPositive >= 0,
        sourceOracleAt200: sourceOraclePresence.get(task.id) ?? null,
        firstPositiveRank: baselineFirstPositive >= 0 ? baselineFirstPositive + 1 : null,
        latencyMs: baseline.latencyMs
      },
      graph: {
        files: metadata.length,
        edges: built.edges.length,
        failedFiles: built.failedFiles,
        buildMs,
        adjacencyMs
      },
      zeroHop: summarizeReachability(zeroHopPaths, positives, lexical.latencyMs, false),
      oneHop: summarizeReachability(oneHop.paths, positives, oneHop.latencyMs, oneHop.truncated),
      twoHop: summarizeReachability(twoHop.paths, positives, twoHop.latencyMs, twoHop.truncated)
    });
    process.stderr.write(`${position + 1}/${tasks.length} ${task.id} edges=${built.edges.length}\n`);
  }

  const report = createReport(rows, {
    input,
    maxFileSizeBytes,
    lexicalSeedMode: "rrf-lexical",
    lexicalSeedCount: 10,
    maxNeighborsPerNode,
    maxGraphCandidates,
    acceptableP95Ms,
    sourceOracleResults: sourceOracleResults ?? null,
    reusedGraphRows: reuseRows ?? null
  });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "graph-reachability-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(path.join(outputDirectory, "per-task-graph-reachability.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  process.stdout.write(JSON.stringify({ tasks: rows.length, decision: report.decisionGate, outputDirectory }) + "\n");
}

function createReport(rows: TaskAuditRow[], configuration: Record<string, unknown>) {
  const baseline50 = fraction(rows, (row) => row.baseline.recallAt50);
  const baseline200 = fraction(rows, (row) => row.baseline.recallAt200);
  const oracleEvidenceComplete = rows.every((row) => row.baseline.sourceOracleAt200 !== null);
  const sourceOracle200 = oracleEvidenceComplete ? fraction(rows, (row) => row.baseline.sourceOracleAt200 === true) : null;
  const baselineMisses200 = rows.filter((row) => !row.baseline.recallAt200);
  const sourceOracleMisses200 = rows.filter((row) => row.baseline.sourceOracleAt200 === false);
  const oneHopUnique = baselineMisses200.filter((row) => row.oneHop.positiveReachable).map((row) => row.taskId);
  const twoHopUnique = baselineMisses200.filter((row) => row.twoHop.positiveReachable).map((row) => row.taskId);
  const oneHopOracleUnique = sourceOracleMisses200.filter((row) => row.oneHop.positiveReachable).map((row) => row.taskId);
  const twoHopOracleUnique = sourceOracleMisses200.filter((row) => row.twoHop.positiveReachable).map((row) => row.taskId);
  const oneHopP95 = percentile(rows.map((row) => row.oneHop.latencyMs), .95);
  const twoHopP95 = percentile(rows.map((row) => row.twoHop.latencyMs), .95);
  const graphP95 = Math.max(oneHopP95, twoHopP95);
  const recoversUnreachable = twoHopOracleUnique.length > 0;
  const latencyAcceptable = graphP95 <= Number(configuration.acceptableP95Ms);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "offline-audit-only",
    productionRankingChanged: false,
    learnedRankingFeaturesChanged: false,
    configuration,
    baseline: {
      candidateGenerator: "rrf-reserved-balanced",
      tasks: rows.length,
      recallAt50: baseline50,
      recallAt200: baseline200,
      sourceOracleRecallAt200: sourceOracle200,
      sourceOracleEvidenceComplete: oracleEvidenceComplete,
      p95WarmLatencyMs: percentile(rows.map((row) => row.baseline.latencyMs), .95)
    },
    reachability: {
      zeroHopLexicalTop10: aggregateReachability(rows, "zeroHop"),
      exactOneHop: {
        ...aggregateReachability(rows, "oneHop"),
        uniqueBaseline200MissesRecovered: oneHopUnique,
        uniqueSourceOracle200MissesRecovered: oneHopOracleUnique
      },
      exactBoundedTwoHop: {
        ...aggregateReachability(rows, "twoHop"),
        uniqueBaseline200MissesRecovered: twoHopUnique,
        uniqueSourceOracle200MissesRecovered: twoHopOracleUnique
      }
    },
    graphConstruction: {
      p95BuildMs: percentile(rows.map((row) => row.graph.buildMs), .95),
      p95AdjacencyMs: percentile(rows.map((row) => row.graph.adjacencyMs), .95),
      meanEdges: mean(rows.map((row) => row.graph.edges)),
      totalFailedFileOccurrences: rows.reduce((sum, row) => sum + row.graph.failedFiles.length, 0),
      uniqueFailedFilePaths: [...new Set(rows.flatMap((row) => row.graph.failedFiles.map((file) => file.path)))].sort()
    },
    focusTasks: rows.filter((row) => [
      "microsoft-TypeScript-issue-55843-pr-62873",
      "microsoft-vscode-issue-283902-pr-284127"
    ].includes(row.taskId)),
    decisionGate: {
      status: !oracleEvidenceComplete ? "insufficient-oracle-evidence" : recoversUnreachable && latencyAcceptable ? "continue-graph-investment" : "stop-graph-investment",
      oracleEvidenceComplete,
      recoversPreviouslyUnreachablePositive: recoversUnreachable,
      warmTraversalP95Ms: graphP95,
      acceptableP95Ms: configuration.acceptableP95Ms,
      latencyAcceptable,
      conclusion: !oracleEvidenceComplete
        ? "The decision gate requires complete existing-source oracle evidence."
        : recoversUnreachable && latencyAcceptable
        ? "At least one existing-source-oracle Recall@200 miss is reachable through the bounded exact graph at acceptable warm latency."
        : recoversUnreachable
          ? "The graph uniquely recovers a baseline Recall@200 miss, but traversal latency exceeds the preregistered threshold."
          : "No existing-source-oracle Recall@200 miss is uniquely recovered; return effort to fusion and lexical/symbol retrieval."
    }
  };
}

function aggregateReachability(rows: TaskAuditRow[], key: "zeroHop" | "oneHop" | "twoHop") {
  return {
    tasks: rows.length,
    recall: fraction(rows, (row) => row[key].positiveReachable),
    meanCandidateCount: mean(rows.map((row) => row[key].candidateCount)),
    p95WarmLatencyMs: percentile(rows.map((row) => row[key].latencyMs), .95),
    truncatedTasks: rows.filter((row) => row[key].truncated).length
  };
}

function summarizeReachability(
  paths: Map<string, GraphReachabilityPath>,
  positives: Set<string>,
  latencyMs: number,
  truncated: boolean
): ReachabilitySummary {
  const recoveredPositivePaths = [...positives]
    .map((positive) => paths.get(positive))
    .filter((value): value is GraphReachabilityPath => Boolean(value))
    .sort((left, right) => left.hops - right.hops || left.seedRank - right.seedRank || left.targetPath.localeCompare(right.targetPath));
  return {
    positiveReachable: recoveredPositivePaths.length > 0,
    recoveredPositivePaths,
    candidateCount: paths.size,
    latencyMs,
    truncated
  };
}

function positivePaths(task: CorpusTask): Set<string> {
  return new Set([...task.relevance.primaryFiles, ...task.relevance.supportingFiles, ...task.relevance.relevantUnchangedFiles]);
}

async function readSourceOraclePresence(input: string): Promise<Map<string, boolean>> {
  const sourceModes = new Set([
    "bm25-files", "title-bm25", "symbol-bm25", "chunk-bm25", "exact-symbol",
    "exact-identifier", "path-lookup", "test-expansion", "structural-expansion"
  ]);
  const rows = await readJsonLines<{ taskId: string; mode: string; cutoff: number; anyPositivePresent: boolean }>(input);
  const presence = new Map<string, boolean>();
  const seenModes = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.cutoff !== 200 || !sourceModes.has(row.mode)) continue;
    presence.set(row.taskId, (presence.get(row.taskId) ?? false) || row.anyPositivePresent);
    const modes = seenModes.get(row.taskId) ?? new Set<string>();
    modes.add(row.mode);
    seenModes.set(row.taskId, modes);
  }
  for (const [taskId, modes] of seenModes) {
    if (modes.size !== sourceModes.size) throw new Error(`${taskId}: source-oracle results contain ${modes.size}/${sourceModes.size} required modes`);
  }
  return presence;
}

async function readJsonLines<T>(input: string): Promise<T[]> {
  return (await readFile(input, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function fraction<T>(values: T[], predicate: (value: T) => boolean): number {
  return values.length ? values.filter(predicate).length / values.length : 0;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))]!;
}

function parseArgs(values: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Expected --key value, received ${key ?? "end"}`);
    output.set(key.slice(2), value);
    index += 1;
  }
  return output;
}

function positiveNumber(values: Map<string, string>, key: string, fallback: number): number {
  const value = Number(values.get(key) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be a positive number`);
  return value;
}

function csv(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function required(values: Map<string, string>, key: string): string { const value = values.get(key); if (!value) throw new Error(`Missing --${key}`); return value; }

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
