#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseSourceFile } from "../indexing/indexer";
import type { IndexedSymbol } from "../types/contracts";
import type { CorpusCollectionDraft, CorpusManifest, CorpusRepository, CorpusTask } from "./corpus-contracts";

const exec = promisify(execFile);
const args = parseArgs(process.argv.slice(2));

type FileRole = "production" | "test" | "generated" | "support" | "removed" | "added";

interface ChangedFileEvidence {
  pathAtBase: string | null;
  pathAfterFix: string | null;
  status: string;
  role: FileRole;
  additions: number;
  deletions: number;
  symbols: Array<Pick<IndexedSymbol, "name" | "qualifiedName" | "kind" | "startLine" | "endLine">>;
}

interface AdjudicationPacket {
  taskId: string;
  repositoryId: string;
  issue: CorpusTask["issue"];
  pullRequest: CorpusTask["pullRequest"];
  query: string;
  originalBaseCommit: string;
  originalPatchCommit: string;
  verifiedBaseCommit: string;
  verifiedPatchCommit: string;
  baseResolution: { strategy: string; commitsIncluded: number; patchSubjects: string[] };
  issueFixLinkVerified: boolean;
  querySufficient: boolean;
  changedFiles: ChangedFileEvidence[];
  renamedPaths: Array<{ from: string; to: string }>;
  generatedFileExclusions: string[];
  proposal: {
    status: "pending";
    primaryFiles: string[];
    supportingFiles: string[];
    testFiles: string[];
    positiveSymbols: Array<{ name: string; path: string; grade: 1 | 2 | 3; startLine?: number; endLine?: number }>;
    notes: string[];
  };
}

async function main(): Promise<void> {
  const inputs = required(args, "inputs").split(",").map((value) => value.trim()).filter(Boolean);
  const output = required(args, "output");
  const cacheDirectory = args.get("cache") ?? path.resolve("benchmarks/cache");
  const selectedIds = args.has("task-ids-from")
    ? await readTaskIds(required(args, "task-ids-from"))
    : args.has("task-ids")
      ? required(args, "task-ids").split(",").map((value) => value.trim()).filter(Boolean)
      : undefined;
  const { repositories, tasks } = await loadInputs(inputs);
  const selected = selectedIds ? selectedIds.map((id) => tasks.get(id)).filter((task): task is CorpusTask => Boolean(task)) : [...tasks.values()];
  if (selectedIds) {
    const missing = selectedIds.filter((id) => !tasks.has(id));
    if (missing.length && !args.has("allow-missing-selected")) throw new Error(`Selected tasks absent from inputs: ${missing.join(", ")}`);
  }
  const packets: AdjudicationPacket[] = [];
  for (const [position, task] of selected.entries()) {
    if (task.review.status === "accepted" && !args.has("include-reviewed")) continue;
    const repository = repositories.get(task.repositoryId);
    if (!repository) throw new Error(`${task.id}: missing repository metadata`);
    packets.push(await buildPacket(task, repository, path.join(cacheDirectory, repository.id.replace("/", "--"))));
    process.stderr.write(`${position + 1}/${selected.length} ${task.id}\n`);
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "review-required",
    tasks: packets,
    summary: summarize(packets)
  }, null, 2) + "\n", "utf8");
  process.stdout.write(`${JSON.stringify({ tasks: packets.length, output, summary: summarize(packets) })}\n`);
}

async function buildPacket(task: CorpusTask, repository: CorpusRepository, repositoryRoot: string): Promise<AdjudicationPacket> {
  const boundary = await resolveBoundary(task, repositoryRoot);
  const changedFiles = await changedFileEvidence(repositoryRoot, boundary.base, boundary.head, repository);
  const production = changedFiles.filter((file) => file.role === "production" && file.pathAtBase);
  const ranked = production.map((file) => ({ file, score: primaryScore(task.query, file) }))
    .sort((left, right) => right.score - left.score || (right.file.additions + right.file.deletions) - (left.file.additions + left.file.deletions) || left.file.pathAtBase!.localeCompare(right.file.pathAtBase!));
  const primary = ranked[0]?.file.pathAtBase;
  const supporting = changedFiles.filter((file) => file.role === "production" && file.pathAtBase && file.pathAtBase !== primary).map((file) => file.pathAtBase!);
  const tests = changedFiles.filter((file) => isTest(file.pathAtBase ?? file.pathAfterFix ?? ""))
    .map((file) => file.pathAtBase ?? file.pathAfterFix).filter((file): file is string => Boolean(file));
  const positiveSymbols = changedFiles.filter((file) => ["production", "test"].includes(file.role)).flatMap((file) => file.symbols.slice(0, 4).map((symbol) => ({
    name: symbol.qualifiedName ?? symbol.name,
    path: file.pathAtBase!,
    grade: file.pathAtBase === primary ? 3 as const : file.role === "test" ? 1 as const : 2 as const,
    ...(symbol.startLine ? { startLine: symbol.startLine } : {}),
    ...(symbol.endLine ? { endLine: symbol.endLine } : {})
  }))).filter((symbol, index, values) => values.findIndex((value) => value.name === symbol.name && value.path === symbol.path) === index);
  const notes: string[] = [];
  if (production.length === 0) notes.push("reject: no changed production file exists in the verified pre-fix tree");
  if (production.length > 15) notes.push(`reject: ${production.length} production files exceed the 15-file policy limit`);
  if (tests.length === 0) notes.push("reject: no regression test or validation file changed");
  if (!issueLinkVerified(task)) notes.push("reject: issue/fix linkage is contradictory or unverified");
  if (/\bdrop support for Python\b|\bremove support for (?:Python|Node\.js|macOS|Windows|Linux)\b/i.test(task.query)) notes.push("reject: release or compatibility-maintenance task");
  if (task.query.trim().length < 80) notes.push("review query sufficiency: less than 80 characters of issue evidence");
  if (production.length > 5) notes.push(`review scope: ${production.length} production files changed`);
  if (!primary) notes.push("review primary file: no proposal");
  if (ranked.length > 1 && ranked[0]!.score - ranked[1]!.score < 1) notes.push("review primary file: top proposals are tied");
  return {
    taskId: task.id, repositoryId: task.repositoryId, issue: task.issue, pullRequest: task.pullRequest, query: task.query,
    originalBaseCommit: task.baseCommit, originalPatchCommit: task.patchCommit,
    verifiedBaseCommit: boundary.base, verifiedPatchCommit: boundary.head,
    baseResolution: { strategy: boundary.strategy, commitsIncluded: boundary.subjects.length, patchSubjects: boundary.subjects },
    issueFixLinkVerified: issueLinkVerified(task),
    querySufficient: task.query.trim().length >= 80,
    changedFiles,
    renamedPaths: changedFiles.filter((file) => file.status.startsWith("R") && file.pathAtBase && file.pathAfterFix).map((file) => ({ from: file.pathAtBase!, to: file.pathAfterFix! })),
    generatedFileExclusions: changedFiles.filter((file) => file.role === "generated").map((file) => file.pathAfterFix ?? file.pathAtBase!).filter(Boolean),
    proposal: { status: "pending", primaryFiles: primary ? [primary] : [], supportingFiles: supporting, testFiles: tests, positiveSymbols, notes }
  };
}

async function resolveBoundary(task: CorpusTask, repositoryRoot: string): Promise<{ base: string; head: string; strategy: string; subjects: string[] }> {
  const commit = await git(repositoryRoot, ["cat-file", "-p", task.patchCommit]);
  const parents = commit.split(/\r?\n/).filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  if (!parents.length) throw new Error(`${task.id}: patch commit has no parent`);
  if (task.repositoryId === "django/django") {
    const issueMarker = new RegExp(`(?:#|ticket[ /#]*)${task.issue.number}\\b`, "i");
    let head = task.patchCommit;
    for (let count = 0; count < 10; count += 1) {
      const subject = (await git(repositoryRoot, ["show", "-s", "--format=%s", head])).trim();
      if (issueMarker.test(subject)) break;
      head = (await git(repositoryRoot, ["rev-parse", `${head}^1`])).trim();
    }
    let cursor = head;
    const subjects: string[] = [];
    for (let count = 0; count < 10; count += 1) {
      const subject = (await git(repositoryRoot, ["show", "-s", "--format=%s", cursor])).trim();
      if (!issueMarker.test(subject)) break;
      subjects.push(subject);
      cursor = (await git(repositoryRoot, ["rev-parse", `${cursor}^1`])).trim();
    }
    if (subjects.length) return { base: cursor, head, strategy: head === task.patchCommit ? "contiguous-ticket-commits" : "nearest-ticket-commit", subjects };
  }
  if (parents.length === 1) {
    return { base: parents[0]!, head: task.patchCommit, strategy: "sole-parent", subjects: [(await git(repositoryRoot, ["show", "-s", "--format=%s", task.patchCommit])).trim()] };
  }
  const target = new Set(task.patchTouchedFiles);
  const scored = await Promise.all(parents.map(async (parent, index) => {
    const statuses = parseNameStatus(await git(repositoryRoot, ["diff", "--name-status", "-M", parent, task.patchCommit]));
    const paths = new Set(statuses.flatMap((status) => [status.before, status.after].filter((value): value is string => Boolean(value))));
    const hits = [...target].filter((candidate) => paths.has(candidate)).length;
    const extras = [...paths].filter((candidate) => !target.has(candidate)).length;
    return { parent, index, hits, extras, score: hits * 1000 - extras };
  }));
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return { base: scored[0]!.parent, head: task.patchCommit, strategy: `merge-parent-${scored[0]!.index + 1}-matching-pr-diff`, subjects: [(await git(repositoryRoot, ["show", "-s", "--format=%s", task.patchCommit])).trim()] };
}

async function changedFileEvidence(repositoryRoot: string, base: string, patch: string, repository: CorpusRepository): Promise<ChangedFileEvidence[]> {
  const statuses = parseNameStatus(await git(repositoryRoot, ["diff", "--name-status", "-M", base, patch]));
  const stats = parseNumstat(await git(repositoryRoot, ["diff", "--numstat", "-M", base, patch]));
  const output: ChangedFileEvidence[] = [];
  for (const status of statuses) {
    const pathAtBase = status.code === "A" ? null : status.before;
    const pathAfterFix = status.code === "D" ? null : status.after;
    const role = classifyFile(pathAtBase ?? pathAfterFix!, status.code, repository);
    const stat = stats.get(`${status.before}\0${status.after}`) ?? { additions: 0, deletions: 0 };
    const symbols = pathAtBase ? await changedSymbols(repositoryRoot, base, patch, pathAtBase) : [];
    output.push({ pathAtBase, pathAfterFix, status: status.raw, role, ...stat, symbols });
  }
  return output;
}

async function changedSymbols(repositoryRoot: string, base: string, patch: string, filePath: string): Promise<ChangedFileEvidence["symbols"]> {
  let content: string;
  try { content = await git(repositoryRoot, ["show", `${base}:${filePath}`]); } catch { return []; }
  const parsedSymbols = parseSourceFile(filePath, content).symbols;
  const positioned = parsedSymbols.filter((symbol) => symbol.startLine).sort((left, right) => left.startLine! - right.startLine!);
  const lineCount = content.split(/\r?\n/).length;
  const symbols = parsedSymbols.map((symbol) => {
    if (!symbol.startLine || (symbol.endLine ?? symbol.startLine) > symbol.startLine) return symbol;
    const next = positioned.find((candidate) => candidate.startLine! > symbol.startLine!);
    return { ...symbol, endLine: next ? next.startLine! - 1 : lineCount };
  });
  if (!symbols.length) return [];
  let diff: string;
  try { diff = await git(repositoryRoot, ["diff", "--unified=0", base, patch, "--", filePath]); } catch { return []; }
  const ranges = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map((match) => ({ start: Number(match[1]), length: Math.max(1, Number(match[2] ?? 1)) }));
  const changed = symbols.filter((symbol) => ranges.some((range) => (symbol.startLine ?? 0) <= range.start + range.length - 1 && (symbol.endLine ?? symbol.startLine ?? 0) >= range.start));
  const nearest = symbols.filter((symbol) => ranges.some((range) => Math.abs((symbol.startLine ?? 0) - range.start) <= 3));
  const selected = changed.length ? changed : nearest.length ? nearest : symbols.filter((symbol) => symbol.kind === "module").slice(0, 1);
  return selected
    .sort((left, right) => (left.startLine ?? 0) - (right.startLine ?? 0))
    .map(({ name, qualifiedName, kind, startLine, endLine }) => ({ name, qualifiedName, kind, startLine, endLine }));
}

function primaryScore(query: string, file: ChangedFileEvidence): number {
  const normalized = query.toLowerCase();
  const filePath = file.pathAtBase ?? "";
  const basename = path.posix.basename(filePath, path.posix.extname(filePath)).toLowerCase();
  const symbolMatches = file.symbols.filter((symbol) => normalized.includes(symbol.name.toLowerCase())).length;
  const pathTerms = tokenize(filePath).filter((term) => term.length >= 4);
  const pathMatches = pathTerms.filter((term) => normalized.includes(term)).length;
  return (normalized.includes(basename) ? 20 : 0) + symbolMatches * 15 + pathMatches * 2 + Math.log2(1 + file.additions + file.deletions);
}

function classifyFile(filePath: string, status: string, repository: CorpusRepository): FileRole {
  if (status === "D") return "removed";
  if (isGenerated(filePath, repository)) return "generated";
  if (isTest(filePath)) return "test";
  if (status === "A") return "added";
  if (isProduction(filePath, repository)) return "production";
  return "support";
}

function isProduction(filePath: string, repository: CorpusRepository): boolean {
  const extension = path.posix.extname(filePath).toLowerCase();
  const source = [".ts", ".tsx", ".js", ".jsx", ".py", ".d.ts"].some((suffix) => filePath.endsWith(suffix)) || [".json", ".css", ".sh"].includes(extension);
  return source && (!repository.scopePaths?.length || repository.scopePaths.some((prefix) => filePath.startsWith(prefix)));
}
function isTest(filePath: string): boolean { return /(^|\/)(test|tests|testing|js_tests)(\/|$)|(?:\.|_)(?:test|spec)\.[^.]+$/i.test(filePath); }
function isGenerated(filePath: string, repository: CorpusRepository): boolean {
  return /(^|\/)(baselines|reference|generated|vendor|dist|build|node_modules)(\/|$)|\.snap$/i.test(filePath) || repository.excludedPaths.some((pattern) => globMatch(filePath, pattern));
}
function globMatch(value: string, pattern: string): boolean { const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"); return new RegExp(`^${escaped}`).test(value); }
function issueLinkVerified(task: CorpusTask): boolean {
  const body = task.query.split(/\n\n/).slice(1).join("\n\n").trim();
  const linkageOnlyBody = /^(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+(?:https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/|#)(\d+)[.!]?$/i.exec(body);
  const contradictoryFixReferences = linkageOnlyBody ? [Number(linkageOnlyBody[1])] : [];
  const contradictory = contradictoryFixReferences.filter((issueNumber) => issueNumber !== task.issue.number);
  return task.issue.number > 0 && task.pullRequest.number > 0 && task.issue.createdAt < task.pullRequest.mergedAt
    && task.provenance.queryUsesPreFixEvidenceOnly && contradictory.length === 0;
}
function tokenize(value: string): string[] { return value.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean); }

function parseNameStatus(value: string): Array<{ code: string; raw: string; before: string; after: string }> {
  return value.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split("\t"); const raw = parts[0]!; const code = raw[0]!;
    return code === "R" || code === "C" ? { code, raw, before: parts[1]!, after: parts[2]! } : { code, raw, before: parts[1]!, after: parts[1]! };
  });
}
function parseNumstat(value: string): Map<string, { additions: number; deletions: number }> {
  const output = new Map<string, { additions: number; deletions: number }>();
  for (const line of value.trim().split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t"); const additions = Number(parts[0]) || 0; const deletions = Number(parts[1]) || 0;
    if (parts.length === 3) output.set(`${parts[2]}\0${parts[2]}`, { additions, deletions });
    else if (parts.length >= 4) output.set(`${parts[2]}\0${parts[3]}`, { additions, deletions });
  }
  return output;
}

function summarize(packets: AdjudicationPacket[]) {
  return {
    tasks: packets.length,
    correctedBaseCommits: packets.filter((packet) => packet.originalBaseCommit !== packet.verifiedBaseCommit).length,
    correctedPatchCommits: packets.filter((packet) => packet.originalPatchCommit !== packet.verifiedPatchCommit).length,
    insufficientQueries: packets.filter((packet) => !packet.querySufficient).length,
    tasksWithoutPrimaryProposal: packets.filter((packet) => packet.proposal.primaryFiles.length === 0).length,
    renamedPaths: packets.reduce((sum, packet) => sum + packet.renamedPaths.length, 0),
    generatedFileExclusions: packets.reduce((sum, packet) => sum + packet.generatedFileExclusions.length, 0),
    manualReviewFlags: packets.reduce((sum, packet) => sum + packet.proposal.notes.length, 0)
  };
}

async function loadInputs(inputs: string[]) {
  const repositories = new Map<string, CorpusRepository>(); const tasks = new Map<string, CorpusTask>();
  for (const input of inputs) {
    const value = JSON.parse(await readFile(input, "utf8")) as CorpusManifest | CorpusCollectionDraft;
    for (const repository of "repository" in value ? [value.repository] : value.repositories) repositories.set(repository.id, repository);
    for (const task of value.tasks) tasks.set(task.id, task);
  }
  return { repositories, tasks };
}
async function readTaskIds(input: string): Promise<string[]> {
  const value = JSON.parse(await readFile(input, "utf8")) as { tasks?: Array<{ taskId: string; status?: string }> };
  if (value.tasks) return value.tasks.filter((task) => task.status !== "reviewed").map((task) => task.taskId);
  throw new Error(`Task selection must contain a tasks array: ${input}`);
}
async function git(repositoryRoot: string, values: string[]): Promise<string> { return (await exec("git", ["-C", repositoryRoot, ...values], { maxBuffer: 50_000_000 })).stdout; }
function parseArgs(values: string[]): Map<string, string> { const output = new Map<string, string>(); for (let index = 0; index < values.length; index += 1) { const key = values[index]; const next = values[index + 1]; if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`); if (!next || next.startsWith("--")) output.set(key.slice(2), "true"); else { output.set(key.slice(2), next); index += 1; } } return output; }
function required(values: Map<string, string>, key: string): string { const value = values.get(key); if (!value || value === "true") throw new Error(`Missing --${key}`); return value; }

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
