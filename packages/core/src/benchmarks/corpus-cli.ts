import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CorpusCollectionDraft, CorpusManifest, CorpusTask } from "./corpus-contracts";
import { collectGitHubCorpus } from "./github-corpus-collector";
import { validateCorpus } from "./corpus-validator";
import { runCorpusBenchmark, type CorpusRetrievalMode } from "./corpus-runner";

const [command, ...rawArgs] = process.argv.slice(2);
const root = process.env.INIT_CWD ?? process.cwd();
const corpusDirectory = path.join(root, "benchmarks", "corpus", "v1");
const manifestPath = path.join(corpusDirectory, "manifest.json");

async function main(): Promise<void> {
  const args = parseArgs(rawArgs);
  if (command === "collect") return collect(args);
  if (command === "validate") return validate(args);
  if (command === "review") return review(args);
  if (command === "stats") return stats();
  if (command === "benchmark") return benchmark(args);
  usage();
  process.exitCode = 1;
}

async function collect(args: Map<string, string>): Promise<void> {
  const repositoryId = required(args, "repo");
  const manifest = await readJson<CorpusManifest>(manifestPath);
  const repository = manifest.repositories.find((entry) => entry.id.toLowerCase() === repositoryId.toLowerCase());
  if (!repository) throw new Error(`Repository ${repositoryId} is not registered in ${manifestPath}`);
  const retainLimit = positiveInteger(args.get("limit") ?? "10", "limit");
  const scanLimit = positiveInteger(args.get("scan") ?? String(Math.max(100, retainLimit * 10)), "scan");
  const draft = await collectGitHubCorpus({
    repository,
    retainLimit,
    scanLimit,
    through: args.get("through"),
    token: process.env.GITHUB_TOKEN
  });
  const output = args.get("output") ?? path.join(corpusDirectory, "drafts", `${repository.id.replace("/", "-")}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeJson(output, draft);
  console.log(`Collected ${draft.tasks.length} reviewable tasks; rejected ${draft.rejected.length} candidates.`);
  console.log(`Draft: ${output}`);
}

async function validate(args: Map<string, string>): Promise<void> {
  const input = args.get("input") ?? manifestPath;
  const value = await readJson<CorpusManifest | CorpusCollectionDraft>(input);
  const corpus = isDraft(value)
    ? { schemaVersion: 1 as const, name: `draft-${value.repository.id}`, repositories: [value.repository], tasks: value.tasks }
    : value;
  const result = validateCorpus(corpus, !isDraft(value) && !args.has("allow-drafts"));
  console.log(JSON.stringify(result.counts, null, 2));
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  for (const error of result.errors) console.error(`error: ${error}`);
  if (result.errors.length > 0) process.exitCode = 1;
}

async function review(args: Map<string, string>): Promise<void> {
  const draftPath = required(args, "draft");
  const draft = await readJson<CorpusCollectionDraft>(draftPath);
  if (args.has("list") || (!args.has("accept") && !args.has("reject"))) {
    for (const task of draft.tasks) {
      console.log(`${task.id} [${task.review.status}] ${task.issue.title}`);
      console.log(`  ${task.issue.url}`);
      console.log(`  primary: ${task.relevance.primaryFiles.join(", ")}`);
      console.log(`  supporting: ${task.relevance.supportingFiles.join(", ") || "none"}`);
    }
    return;
  }
  const accepted = selection(args.get("accept"), draft.tasks);
  const rejected = selection(args.get("reject"), draft.tasks);
  const overlap = [...accepted].filter((id) => rejected.has(id));
  if (overlap.length > 0) throw new Error(`Tasks selected for both acceptance and rejection: ${overlap.join(", ")}`);
  const reviewedAt = new Date().toISOString();
  const notes = args.get("notes");
  for (const task of draft.tasks) {
    if (accepted.has(task.id)) task.review = { status: "accepted", reviewedAt, ...(notes ? { notes } : {}) };
    if (rejected.has(task.id)) task.review = { status: "rejected", reviewedAt, ...(notes ? { notes } : {}) };
  }
  await writeJson(draftPath, draft);
  const manifest = await readJson<CorpusManifest>(manifestPath);
  const acceptedTasks = draft.tasks.filter((task) => task.review.status === "accepted");
  const acceptedIds = new Set(acceptedTasks.map((task) => task.id));
  manifest.tasks = [...manifest.tasks.filter((task) => !acceptedIds.has(task.id)), ...acceptedTasks]
    .sort((left, right) => left.id.localeCompare(right.id));
  const result = validateCorpus(manifest, true);
  if (result.errors.length > 0) throw new Error(`Review would create invalid manifest:\n${result.errors.join("\n")}`);
  await writeJson(manifestPath, manifest);
  console.log(`Manifest now contains ${manifest.tasks.length} accepted tasks.`);
}

async function stats(): Promise<void> {
  const manifest = await readJson<CorpusManifest>(manifestPath);
  const byRepository = Object.fromEntries(manifest.repositories.map((repository) => [
    repository.id,
    manifest.tasks.filter((task) => task.repositoryId === repository.id).length
  ]));
  console.log(JSON.stringify({ repositories: manifest.repositories.length, tasks: manifest.tasks.length, byRepository }, null, 2));
}

async function benchmark(args: Map<string, string>): Promise<void> {
  const modeValue = args.get("mode") ?? "all";
  const availableModes: CorpusRetrievalMode[] = ["bm25", "bm25_body", "bm25_packed", "bm25_path", "bm25_symbol", "bm25_symbol_packed", "bm25_path_symbol", "bm25_graph", "bm25_semantic", "heuristic"];
  const modes: CorpusRetrievalMode[] = modeValue === "all"
    ? ["bm25", "heuristic"]
    : modeValue === "ablations"
      ? availableModes
      : modeValue.split(",") as CorpusRetrievalMode[];
  if (modes.some((mode) => !availableModes.includes(mode))) throw new Error(`--mode must be all, ablations, or one of: ${availableModes.join(", ")}`);
  const outputDirectory = args.get("output") ?? path.join(root, "benchmarks", "results", new Date().toISOString().replace(/[:.]/g, "-"));
  const result = await runCorpusBenchmark({ manifestPath, cacheDirectory: path.join(root, "benchmarks", "cache"), outputDirectory, modes, repositoryId: args.get("repository"), limit: args.has("limit") ? positiveInteger(required(args, "limit"), "limit") : undefined, repetitions: args.has("repetitions") ? positiveInteger(required(args, "repetitions"), "repetitions") : 5 });
  console.log(`Completed ${result.results.length} task-mode runs with ${result.failures.length} failures.`);
  console.log(`Results: ${outputDirectory}`);
}

function selection(value: string | undefined, tasks: CorpusTask[]): Set<string> {
  if (!value) return new Set();
  if (value === "all") return new Set(tasks.map((task) => task.id));
  const selected = new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  const known = new Set(tasks.map((task) => task.id));
  for (const id of selected) if (!known.has(id)) throw new Error(`Unknown task ID: ${id}`);
  return selected;
}

function parseArgs(values: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value?.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) args.set(key, "true");
    else { args.set(key, next); index += 1; }
  }
  return args;
}

function required(args: Map<string, string>, key: string): string {
  const value = args.get(key);
  if (!value || value === "true") throw new Error(`Missing --${key}`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function isDraft(value: CorpusManifest | CorpusCollectionDraft): value is CorpusCollectionDraft {
  return "repository" in value && "rejected" in value;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function usage(): void {
  console.log("Usage:");
  console.log("  corpus collect --repo django/django --limit 10 [--scan 100] [--through 2025-12-31]");
  console.log("  corpus review --draft path [--list | --accept id[,id] | --reject id[,id]]");
  console.log("  corpus validate [--input path] [--allow-drafts]");
  console.log("  corpus stats");
  console.log("  corpus benchmark [--mode all|ablations|bm25|heuristic|...] [--repository owner/repo] [--limit N]");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
