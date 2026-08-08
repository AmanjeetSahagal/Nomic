#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CorpusCollectionDraft, CorpusManifest, CorpusSymbolLabel, CorpusTask } from "./corpus-contracts";
import { validateCorpus } from "./corpus-validator";

interface PacketFile { pathAtBase: string | null; pathAfterFix: string | null; role: string }
interface Packet {
  taskId: string;
  originalBaseCommit: string;
  originalPatchCommit: string;
  verifiedBaseCommit: string;
  verifiedPatchCommit: string;
  issueFixLinkVerified: boolean;
  querySufficient: boolean;
  changedFiles: PacketFile[];
  renamedPaths: Array<{ from: string; to: string }>;
  generatedFileExclusions: string[];
  proposal: {
    primaryFiles: string[];
    supportingFiles: string[];
    testFiles: string[];
    positiveSymbols: CorpusSymbolLabel[];
    notes: string[];
  };
}
interface PacketFileRoot { tasks: Packet[] }
interface Decisions {
  schemaVersion: 1;
  reviewer: string;
  reviewedAt: string;
  method: string;
  rejected: Record<string, string>;
  primaryOverrides: Record<string, string[]>;
  acceptedReviewNotes: Record<string, string>;
}
interface RegistryRecord {
  taskId: string;
  status: "reviewed" | "rejected";
  reviewer: string;
  primary_files: string[];
  supporting_files: string[];
  test_files: string[];
  positive_symbols: CorpusSymbolLabel[];
  renamed_paths: Array<{ from: string; to: string }>;
  generated_file_exclusions: string[];
  base_commit_verified: boolean;
  patch_commit_verified: boolean;
  issue_fix_link_verified: boolean;
  query_evidence_verified: boolean;
  labels_frozen: boolean;
  notes: string;
}

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  const base = JSON.parse(await readFile(required(args, "manifest"), "utf8")) as CorpusManifest;
  const taskSources = new Map(base.tasks.map((task) => [task.id, task]));
  for (const input of csv(required(args, "drafts"))) {
    const draft = JSON.parse(await readFile(input, "utf8")) as CorpusCollectionDraft;
    for (const task of draft.tasks) taskSources.set(task.id, task);
  }
  const packets = new Map<string, Packet>();
  for (const input of csv(required(args, "packets"))) {
    const root = JSON.parse(await readFile(input, "utf8")) as PacketFileRoot;
    for (const packet of root.tasks) {
      if (packets.has(packet.taskId)) throw new Error(`Duplicate adjudication packet: ${packet.taskId}`);
      packets.set(packet.taskId, packet);
    }
  }
  const decisions = JSON.parse(await readFile(required(args, "decisions"), "utf8")) as Decisions;
  const registry: RegistryRecord[] = [];
  const reviewedTasks: CorpusTask[] = [];

  for (const packet of packets.values()) {
    const rejection = decisions.rejected[packet.taskId];
    const hardRejectNotes = packet.proposal.notes.filter((note) => note.startsWith("reject:"));
    if (rejection) {
      registry.push(registryRecord(packet, decisions, "rejected", [], [], rejection));
      continue;
    }
    const source = taskSources.get(packet.taskId);
    if (!source) throw new Error(`${packet.taskId}: source task not found`);
    if (hardRejectNotes.length) throw new Error(`${packet.taskId}: unresolved rejection evidence: ${hardRejectNotes.join("; ")}`);
    if ((!packet.issueFixLinkVerified || !packet.querySufficient) && !decisions.acceptedReviewNotes[packet.taskId]) {
      throw new Error(`${packet.taskId}: provenance/query exception lacks an explicit review note`);
    }
    const primary = decisions.primaryOverrides[packet.taskId] ?? packet.proposal.primaryFiles;
    const productionAtBase = packet.changedFiles.filter((file) => file.role === "production" && file.pathAtBase).map((file) => file.pathAtBase!);
    for (const file of primary) if (!productionAtBase.includes(file)) throw new Error(`${packet.taskId}: primary override is not changed production at base: ${file}`);
    const supporting = productionAtBase.filter((file) => !primary.includes(file));
    const testsAtBase = packet.changedFiles.filter((file) => file.role === "test" && file.pathAtBase).map((file) => file.pathAtBase!);
    const positiveFiles = new Set([...primary, ...supporting, ...testsAtBase]);
    const symbols = packet.proposal.positiveSymbols.filter((symbol) => positiveFiles.has(symbol.path)).map((symbol) => ({
      ...symbol,
      grade: primary.includes(symbol.path) ? 3 as const : testsAtBase.includes(symbol.path) ? 1 as const : 2 as const
    }));
    const touched = [...new Set(packet.changedFiles.flatMap((file) => [file.pathAtBase, file.pathAfterFix]).filter((file): file is string => Boolean(file)))];
    const reviewNote = decisions.acceptedReviewNotes[packet.taskId] ?? "Accepted after focused issue, commit-boundary, file-role, and base-symbol evidence review.";
    reviewedTasks.push({
      ...source,
      baseCommit: packet.verifiedBaseCommit,
      patchCommit: packet.verifiedPatchCommit,
      relevance: { primaryFiles: primary, supportingFiles: [...supporting, ...testsAtBase], relevantUnchangedFiles: [], symbols },
      patchTouchedFiles: touched,
      review: { status: "accepted", reviewedAt: decisions.reviewedAt, notes: reviewNote }
    });
    registry.push(registryRecord(packet, decisions, "reviewed", primary, supporting, reviewNote, symbols));
  }

  const frozen: CorpusManifest = { ...base, name: "ranking-corpus-100-reviewed-v1", tasks: reviewedTasks };
  const validation = validateCorpus(frozen);
  const distribution = Object.fromEntries([...new Set(frozen.tasks.map((task) => task.repositoryId))].map((repository) => [repository, frozen.tasks.filter((task) => task.repositoryId === repository).length]));
  if (frozen.tasks.length !== 100 || distribution["django/django"] !== 40 || distribution["microsoft/TypeScript"] !== 40 || distribution["microsoft/vscode"] !== 20) {
    throw new Error(`Frozen corpus distribution mismatch: ${JSON.stringify({ tasks: frozen.tasks.length, distribution })}`);
  }
  if (validation.errors.length) throw new Error(`Frozen corpus validation failed:\n${validation.errors.join("\n")}`);
  const manifestOutput = required(args, "output");
  const registryOutput = required(args, "registry-output");
  await mkdir(path.dirname(manifestOutput), { recursive: true });
  await mkdir(path.dirname(registryOutput), { recursive: true });
  await writeFile(manifestOutput, JSON.stringify(frozen, null, 2) + "\n", "utf8");
  await writeFile(registryOutput, JSON.stringify({
    schemaVersion: 1,
    name: "ranking-corpus-100-reviewed-v1",
    labelsFrozen: true,
    reviewer: decisions.reviewer,
    reviewedAt: decisions.reviewedAt,
    method: decisions.method,
    counts: { reviewed: registry.filter((record) => record.status === "reviewed").length, rejected: Object.keys(decisions.rejected).length },
    distribution,
    rejectedCandidates: decisions.rejected,
    tasks: registry
  }, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ manifestOutput, registryOutput, distribution, validation: validation.counts, warnings: validation.warnings.length }) + "\n");
}

function registryRecord(packet: Packet, decisions: Decisions, status: "reviewed" | "rejected", primary: string[], supporting: string[], notes: string, symbols = packet.proposal.positiveSymbols): RegistryRecord {
  return {
    taskId: packet.taskId,
    status,
    reviewer: decisions.reviewer,
    primary_files: primary,
    supporting_files: supporting,
    test_files: packet.proposal.testFiles,
    positive_symbols: status === "reviewed" ? symbols : [],
    renamed_paths: packet.renamedPaths,
    generated_file_exclusions: packet.generatedFileExclusions,
    base_commit_verified: packet.verifiedBaseCommit.length === 40,
    patch_commit_verified: packet.verifiedPatchCommit.length === 40,
    issue_fix_link_verified: packet.issueFixLinkVerified,
    query_evidence_verified: status === "reviewed" ? packet.querySufficient || Boolean(decisions.acceptedReviewNotes[packet.taskId]) : packet.querySufficient,
    labels_frozen: status === "reviewed",
    notes
  };
}

function csv(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function parseArgs(values: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]; const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Expected --key value, received ${key ?? "end"}`);
    output.set(key.slice(2), value); index += 1;
  }
  return output;
}
function required(values: Map<string, string>, key: string): string { const value = values.get(key); if (!value) throw new Error(`Missing --${key}`); return value; }

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
