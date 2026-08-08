#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FilesystemParserProvider } from "../indexing/indexer";
import { extractRankingFeatureBatch, RANKING_FEATURE_NAMES, RANKING_FEATURE_VERSION } from "../ranking/ranker";
import type { ContextCandidate, RepositoryIndex } from "../types/contracts";
import { CANDIDATE_GENERATION_MODES, generateCandidates, type CandidateGenerationMode, type GeneratedCandidate } from "./candidate-generation";
import type { CorpusCollectionDraft, CorpusManifest, CorpusRepository, CorpusTask } from "./corpus-contracts";
import { materializeRepository } from "./corpus-runner";

const args = parseArgs(process.argv.slice(2));
const input = required(args, "input");
const output = required(args, "output");
const cacheDirectory = args.get("cache") ?? path.resolve("benchmarks/cache");
const limit = args.has("limit") ? positiveInteger(required(args, "limit"), "limit") : undefined;
const candidateLimit = positiveInteger(args.get("candidate-limit") ?? "50", "candidate-limit");
const maxFileSizeBytes = positiveInteger(args.get("max-file-size-bytes") ?? "1000000", "max-file-size-bytes");
const candidateMode = (args.get("candidate-mode") ?? "bm25-files") as CandidateGenerationMode;
const resume = args.get("resume") === "true";
if (!CANDIDATE_GENERATION_MODES.includes(candidateMode)) throw new Error(`Unsupported --candidate-mode: ${candidateMode}`);

interface RankingDatasetRow {
  taskId: string;
  repository: string;
  baseCommit: string;
  patchCommit: string;
  createdAt: string;
  query: string;
  candidateId: string;
  candidatePath: string;
  candidateSymbol?: string;
  label: 0 | 1 | 2 | 3;
  labelSource: "patch-primary" | "patch-supporting" | "patch-test" | "manual" | "retrieved-negative";
  negativeType?: "high-bm25" | "same-package" | "similar-symbol" | "random";
  candidateGenerationMode: CandidateGenerationMode;
  candidateSourceRanks: GeneratedCandidate["sources"];
  features: ReturnType<typeof extractRankingFeatureBatch>[number];
}

async function main(): Promise<void> {
  const value = JSON.parse(await readFile(input, "utf8")) as CorpusManifest | CorpusCollectionDraft;
  const repositories = "repository" in value ? [value.repository] : value.repositories;
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
  const selected = (limit ? value.tasks.slice(0, limit) : value.tasks);
  const rows: RankingDatasetRow[] = resume ? await readRowsIfPresent(output) : [];
  const groupSizes: Array<{ taskId: string; size: number }> = resume ? await readJsonIfPresent(`${output}.groups.json`) : [];
  const completed = new Set(groupSizes.map((group) => group.taskId));
  if (rows.length !== groupSizes.reduce((sum, group) => sum + group.size, 0)) throw new Error("Resume checkpoint rows do not match group sizes");

  for (const [position, task] of selected.entries()) {
    if (completed.has(task.id)) {
      process.stderr.write(`${position + 1}/${selected.length} ${task.id}: resumed\n`);
      continue;
    }
    const repository = repositoryById.get(task.repositoryId);
    if (!repository) throw new Error(`${task.id}: repository ${task.repositoryId} is not configured`);
    const root = await materializeRepository(repository, task.baseCommit, cacheDirectory);
    const index = await new FilesystemParserProvider().indexRepository({ repositoryRoot: root, excludedPaths: repository.excludedPaths, maxFileSizeBytes });
    const generated = generateCandidates(task.query, index, candidateMode, candidateLimit).candidates;
    const candidates = generated.map((candidate, candidatePosition) => toContextCandidate(candidate, candidatePosition, task.query, index));
    const features = extractRankingFeatureBatch({ text: task.query, target: "codex", repositoryRoot: root }, candidates, index);
    const taskRows = candidates.map((candidate, candidatePosition) => buildRow(task, candidate, generated[candidatePosition]!, candidatePosition, features[candidatePosition]!, index, repository));
    if (taskRows.length !== candidateLimit) throw new Error(`${task.id}: expected ${candidateLimit} candidates, received ${taskRows.length}`);
    rows.push(...taskRows);
    groupSizes.push({ taskId: task.id, size: taskRows.length });
    await writeCheckpoint(output, rows, groupSizes);
    process.stderr.write(`${position + 1}/${selected.length} ${task.id}: ${taskRows.length} candidates\n`);
  }

  await mkdir(path.dirname(output), { recursive: true });
  const datasetContents = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  const groupsContents = JSON.stringify(groupSizes, null, 2) + "\n";
  await writeFile(output, datasetContents, "utf8");
  await writeFile(`${output}.groups.json`, groupsContents, "utf8");
  await writeFile(`${output}.manifest.json`, JSON.stringify({
    schemaVersion: 1,
    corpus: "name" in value ? value.name : path.basename(input),
    candidateGenerationMode: candidateMode,
    candidateLimit,
    maxFileSizeBytes,
    featureSchemaVersion: RANKING_FEATURE_VERSION,
    featureCount: RANKING_FEATURE_NAMES.length,
    tasks: selected.length,
    rows: rows.length,
    datasetSha256: createHash("sha256").update(datasetContents).digest("hex"),
    groupsSha256: createHash("sha256").update(groupsContents).digest("hex")
  }, null, 2) + "\n", "utf8");
  process.stdout.write(`${JSON.stringify({ tasks: selected.length, rows: rows.length, output })}\n`);
}

function buildRow(
  task: CorpusTask,
  candidate: ContextCandidate,
  generated: GeneratedCandidate,
  position: number,
  features: ReturnType<typeof extractRankingFeatureBatch>[number],
  index: Awaited<ReturnType<FilesystemParserProvider["indexRepository"]>>,
  _repository: CorpusRepository
): RankingDatasetRow {
  const file = index.files.find((entry) => entry.path === candidate.path);
  const primary = task.relevance.primaryFiles.includes(candidate.path);
  const supporting = task.relevance.supportingFiles.includes(candidate.path);
  const unchanged = task.relevance.relevantUnchangedFiles.includes(candidate.path);
  const label: 0 | 1 | 2 | 3 = primary ? 3 : supporting ? (file?.isTest ? 1 : 2) : unchanged ? 1 : 0;
  const labelSource: RankingDatasetRow["labelSource"] = primary ? "patch-primary"
    : supporting ? (file?.isTest ? "patch-test" : "patch-supporting")
      : unchanged ? "manual" : "retrieved-negative";
  const matchingSymbol = file?.symbols
    .map((symbol) => ({ symbol, score: symbolScore(task.query, symbol.name) }))
    .sort((left, right) => right.score - left.score || left.symbol.name.localeCompare(right.symbol.name))[0];
  return {
    taskId: task.id,
    repository: task.repositoryId,
    baseCommit: task.baseCommit,
    patchCommit: task.patchCommit,
    createdAt: task.issue.createdAt,
    query: task.query,
    candidateId: matchingSymbol?.score ? `${candidate.path}#${matchingSymbol.symbol.id}` : candidate.path,
    candidatePath: candidate.path,
    ...(matchingSymbol?.score ? { candidateSymbol: matchingSymbol.symbol.qualifiedName ?? matchingSymbol.symbol.name } : {}),
    label,
    labelSource,
    ...(label === 0 ? { negativeType: negativeType(task, candidate, position, file?.symbols.map((symbol) => symbol.name) ?? []) } : {}),
    candidateGenerationMode: candidateMode,
    candidateSourceRanks: generated.sources,
    features
  };
}

function toContextCandidate(candidate: GeneratedCandidate, position: number, query: string, index: RepositoryIndex): ContextCandidate {
  const file = index.files.find((entry) => entry.path === candidate.path);
  if (!file) throw new Error(`Candidate file is absent from index: ${candidate.path}`);
  const queryTerms = new Set(tokenize(query));
  const chunks = index.chunks.filter((chunk) => chunk.filePath === candidate.path)
    .map((chunk) => ({ chunk, overlap: tokenize(chunk.text).filter((term) => queryTerms.has(term)).length }))
    .sort((left, right) => right.overlap - left.overlap || left.chunk.startLine - right.chunk.startLine)
    .slice(0, 2).map((entry) => entry.chunk);
  const rankScore = 1 / (position + 1);
  return {
    path: candidate.path,
    reason: `Frozen ${candidateMode} candidate; source ranks ${JSON.stringify(candidate.sources)}`,
    score: rankScore,
    source: "lexical",
    role: file.isTest ? "test" : "primary",
    stage: "seed",
    dependencyDistance: 0,
    structuralScore: candidate.sources.structuralExpansion ? 1 / candidate.sources.structuralExpansion : 0,
    semanticScore: 0,
    lexicalScore: rankScore,
    recencyScore: 0,
    fileImportanceScore: file.symbols.length,
    tokenCost: chunks.length ? chunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0) : Math.ceil(file.size / 4),
    chunkIds: chunks.map((chunk) => chunk.id),
    expansionPath: [candidate.path]
  };
}

function negativeType(task: CorpusTask, candidate: ContextCandidate, position: number, symbols: string[]): RankingDatasetRow["negativeType"] {
  if (position < 10) return "high-bm25";
  const positiveDirectories = task.relevance.primaryFiles.map((file) => path.posix.dirname(file));
  if (positiveDirectories.includes(path.posix.dirname(candidate.path))) return "same-package";
  if (symbols.some((symbol) => symbolScore(task.query, symbol) > 0)) return "similar-symbol";
  return "random";
}

function symbolScore(query: string, symbol: string): number {
  const normalized = query.toLowerCase();
  const name = symbol.toLowerCase();
  if (normalized.includes(name)) return 3;
  const terms = name.split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  return terms.filter((term) => normalized.includes(term)).length;
}

function tokenize(value: string): string[] { return value.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length >= 2); }

async function writeCheckpoint(outputPath: string, rows: RankingDatasetRow[], groups: Array<{ taskId: string; size: number }>): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  await writeFile(`${outputPath}.groups.json`, JSON.stringify(groups, null, 2) + "\n", "utf8");
}

async function readRowsIfPresent(inputPath: string): Promise<RankingDatasetRow[]> {
  try { return (await readFile(inputPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RankingDatasetRow); }
  catch (error: unknown) { if (isMissingFile(error)) return []; throw error; }
}

async function readJsonIfPresent<T>(inputPath: string): Promise<T> {
  try { return JSON.parse(await readFile(inputPath, "utf8")) as T; }
  catch (error: unknown) { if (isMissingFile(error)) return [] as T; throw error; }
}

function isMissingFile(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

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

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
