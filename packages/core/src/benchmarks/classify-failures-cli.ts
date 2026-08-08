#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const allowedReasons = [
  "vocabulary mismatch", "symbol mentioned but file missed", "relevant file too large or generic",
  "test file outranks implementation", "path or rename mismatch", "parser or indexing omission",
  "generated-file labeling issue", "cross-file architectural dependency", "incorrect benchmark label",
  "candidate cutoff too low", "fusion dilution across candidate sources"
] as const;

interface ResultRow { taskId: string; repository: string; mode: string; cutoff: number; anyPositivePresent: boolean }
interface ReviewedTaxonomy {
  schemaVersion: 1;
  corpus: string;
  candidateGenerator: string;
  cutoff: number;
  reviewer: string;
  reviewedAt: string;
  summary: Record<string, number>;
  tasks: Array<{ taskId: string; mainReason: typeof allowedReasons[number]; evidence: string }>;
}

async function main(): Promise<void> {
  const resultsDirectory = required(args, "results");
  const reviewed = JSON.parse(await readFile(required(args, "taxonomy"), "utf8")) as ReviewedTaxonomy;
  const rows = (await readFile(path.join(resultsDirectory, "per-task-candidate-results.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ResultRow);
  const misses = rows.filter((row) => row.mode === reviewed.candidateGenerator && row.cutoff === reviewed.cutoff && !row.anyPositivePresent);
  const missIds = new Set(misses.map((row) => row.taskId));
  const classifiedIds = new Set(reviewed.tasks.map((task) => task.taskId));
  const missing = [...missIds].filter((id) => !classifiedIds.has(id));
  const stale = [...classifiedIds].filter((id) => !missIds.has(id));
  const invalid = reviewed.tasks.filter((task) => !allowedReasons.includes(task.mainReason));
  const calculatedSummary = reviewed.tasks.reduce<Record<string, number>>((summary, task) => {
    summary[task.mainReason] = (summary[task.mainReason] ?? 0) + 1; return summary;
  }, { misses: reviewed.tasks.length });
  const summaryMismatch = Object.entries(calculatedSummary).filter(([reason, count]) => reviewed.summary[reason] !== count);
  if (missing.length || stale.length || invalid.length || reviewed.tasks.length !== classifiedIds.size || summaryMismatch.length) {
    throw new Error(`Failure taxonomy mismatch: ${JSON.stringify({ missing, stale, invalid: invalid.map((task) => task.taskId), duplicateCount: reviewed.tasks.length - classifiedIds.size, summaryMismatch })}`);
  }
  const repositoryByTask = new Map(misses.map((row) => [row.taskId, row.repository]));
  await writeFile(path.join(resultsDirectory, "failure-taxonomy.json"), JSON.stringify({
    schemaVersion: 1,
    corpus: reviewed.corpus,
    candidateGenerator: reviewed.candidateGenerator,
    cutoff: reviewed.cutoff,
    reviewer: reviewed.reviewer,
    reviewedAt: reviewed.reviewedAt,
    taxonomyStatus: "reviewed",
    reasons: allowedReasons,
    summary: reviewed.summary,
    tasks: reviewed.tasks.map((task) => ({ ...task, repository: repositoryByTask.get(task.taskId), labelStatus: "reviewed", taxonomyStatus: "reviewed" }))
  }, null, 2) + "\n", "utf8");
  const gatePath = path.join(resultsDirectory, "training-gate.json");
  const gate = JSON.parse(await readFile(gatePath, "utf8")) as { status: string; conditions: Record<string, boolean>; conclusion: string };
  gate.conditions.allMissesClassified = true;
  gate.status = Object.values(gate.conditions).every(Boolean) ? "open" : "closed";
  gate.conclusion = gate.status === "open"
    ? "All data-quality and candidate-recall conditions pass."
    : "Labels and miss taxonomy are frozen, but training remains closed because one or more candidate-recall conditions are below the engineering threshold.";
  await writeFile(gatePath, JSON.stringify(gate, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ misses: misses.length, classified: reviewed.tasks.length, gate: gate.status }) + "\n");
}

function parseArgs(values: string[]): Map<string, string> { const output = new Map<string, string>(); for (let index = 0; index < values.length; index += 1) { const key = values[index]; const value = values[index + 1]; if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Expected --key value, received ${key ?? "end"}`); output.set(key.slice(2), value); index += 1; } return output; }
function required(values: Map<string, string>, key: string): string { const value = values.get(key); if (!value) throw new Error(`Missing --${key}`); return value; }

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
