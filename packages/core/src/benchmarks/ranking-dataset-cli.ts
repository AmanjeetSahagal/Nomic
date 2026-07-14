#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FilesystemParserProvider } from "../indexing/indexer";
import { extractRankingFeatureBatch } from "../ranking/ranker";
import type { ContextCandidate } from "../types/contracts";
import type { CorpusCollectionDraft, CorpusManifest, CorpusRepository, CorpusTask } from "./corpus-contracts";
import { materializeRepository, retrieveBm25 } from "./corpus-runner";

const args = parseArgs(process.argv.slice(2));
const input = required(args, "input");
const output = required(args, "output");
const cacheDirectory = args.get("cache") ?? path.resolve("benchmarks/cache");
const limit = args.has("limit") ? positiveInteger(required(args, "limit"), "limit") : undefined;

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
  features: ReturnType<typeof extractRankingFeatureBatch>[number];
}

async function main(): Promise<void> {
  const value = JSON.parse(await readFile(input, "utf8")) as CorpusManifest | CorpusCollectionDraft;
  const repositories = "repository" in value ? [value.repository] : value.repositories;
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
  const selected = (limit ? value.tasks.slice(0, limit) : value.tasks);
  const rows: RankingDatasetRow[] = [];
  const groupSizes: Array<{ taskId: string; size: number }> = [];

  for (const [position, task] of selected.entries()) {
    const repository = repositoryById.get(task.repositoryId);
    if (!repository) throw new Error(`${task.id}: repository ${task.repositoryId} is not configured`);
    const root = await materializeRepository(repository, task.baseCommit, cacheDirectory);
    const index = await new FilesystemParserProvider().indexRepository({ repositoryRoot: root, excludedPaths: repository.excludedPaths });
    const candidates = retrieveBm25(task.query, index, 50);
    const features = extractRankingFeatureBatch({ text: task.query, target: "codex", repositoryRoot: root }, candidates, index);
    const taskRows = candidates.map((candidate, candidatePosition) => buildRow(task, candidate, candidatePosition, features[candidatePosition]!, index, repository));
    rows.push(...taskRows);
    groupSizes.push({ taskId: task.id, size: taskRows.length });
    process.stderr.write(`${position + 1}/${selected.length} ${task.id}: ${taskRows.length} candidates\n`);
  }

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  await writeFile(`${output}.groups.json`, JSON.stringify(groupSizes, null, 2) + "\n", "utf8");
  process.stdout.write(`${JSON.stringify({ tasks: selected.length, rows: rows.length, output })}\n`);
}

function buildRow(
  task: CorpusTask,
  candidate: ContextCandidate,
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
    features
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
