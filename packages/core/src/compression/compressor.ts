import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_TOKEN_BUDGET,
  type CompressionResult,
  type ContextCandidate,
  type FileSummary,
  type RepositoryIndex,
  type SummarizationProvider,
  type TokenBudget
} from "../types/contracts";

export class ContextCompressor {
  constructor(
    private readonly summarizer?: SummarizationProvider,
    private readonly tokenBudget: TokenBudget = DEFAULT_TOKEN_BUDGET
  ) {}

  async compress(candidates: ContextCandidate[], index: RepositoryIndex): Promise<CompressionResult> {
    const rankedCandidates = [...candidates].sort(
      (left, right) => right.score - left.score || left.path.localeCompare(right.path)
    );
    const fileByPath = new Map(index.files.map((file) => [file.path, file]));
    const budgetCaps = {
      raw: Math.floor(this.tokenBudget.maxContextTokens * this.tokenBudget.rawCodeFraction),
      summary: Math.floor(this.tokenBudget.maxContextTokens * this.tokenBudget.summaryFraction),
      dependency: Math.floor(this.tokenBudget.maxContextTokens * this.tokenBudget.dependencyFraction),
      tests: Math.floor(this.tokenBudget.maxContextTokens * this.tokenBudget.testFraction)
    };
    const usage = {
      raw: 0,
      summary: 0,
      dependency: 0,
      tests: 0,
      total: 0
    };
    const items: FileSummary[] = [];
    const omittedPaths: string[] = [];
    const dependencyNotes: string[] = [];

    for (const candidate of rankedCandidates) {
      const file = fileByPath.get(candidate.path);
      if (!file) {
        omittedPaths.push(candidate.path);
        continue;
      }

      const bucket = selectBudgetBucket(candidate);
      const rawPreferred = shouldKeepRaw(candidate);

      if (rawPreferred) {
        const rawItem = await createRawItem(file, index.repositoryRoot, candidate);
        if (fitsBudget(usage.raw, rawItem.estimatedTokens, budgetCaps.raw)) {
          items.push(rawItem);
          usage.raw += rawItem.estimatedTokens;
          dependencyNotes.push(...rawItem.dependencyNotes);
          continue;
        }
      }

      const summaryItem = await createSummaryItem(candidate, file, index, this.summarizer);
      if (fitsBudget(usage[bucket], summaryItem.estimatedTokens, budgetCaps[bucket])) {
        items.push(summaryItem);
        usage[bucket] += summaryItem.estimatedTokens;
        dependencyNotes.push(...summaryItem.dependencyNotes);
      } else {
        omittedPaths.push(candidate.path);
      }
    }

    usage.total = usage.raw + usage.summary + usage.dependency + usage.tests;

    return {
      items,
      tokenBudget: this.tokenBudget,
      budgetUsage: usage,
      omittedPaths,
      dependencyNotes: unique(dependencyNotes)
    };
  }
}

async function readRawFile(repositoryRoot: string, relativePath: string): Promise<string> {
  const filePath = path.join(repositoryRoot, relativePath);
  return readFile(filePath, "utf8");
}

function buildFallbackSummary(file: RepositoryIndex["files"][number], candidate: ContextCandidate): FileSummary {
  const publicApi = getPreservedInterfaces(file);
  const dependencyNotes = file.imports.length > 0 ? [`Imports ${file.imports.slice(0, 5).join(", ")}`] : [];
  const keyInvariants =
    publicApi.length > 0
      ? [`Preserve exposed interfaces: ${publicApi.join(", ")}`]
      : ["Preserve observed behavior while editing this file."];
  const purpose =
    file.language === "markdown"
      ? "Supporting documentation relevant to the task."
      : candidate.role === "dependency"
        ? "Dependency needed to understand or modify the primary target."
        : candidate.role === "test"
          ? "Test coverage related to the primary target."
          : "Primary implementation context for the task.";
  const inclusionReason = candidate.reason;
  const summary = [
    `Purpose: ${purpose}`,
    `Reason: ${inclusionReason}`,
    `Public API: ${publicApi.length > 0 ? publicApi.join(", ") : "None detected"}`,
    `Key invariants: ${keyInvariants.join(" ")}`,
    `Dependencies: ${dependencyNotes.length > 0 ? dependencyNotes.join("; ") : "None detected"}`
  ].join(" ");

  return {
    path: candidate.path,
    compression: "summary",
    summary,
    purpose,
    publicApi,
    keyInvariants,
    dependencyNotes,
    inclusionReason,
    estimatedTokens: estimateTextTokens(summary),
    preservedInterfaces: publicApi
  };
}

function summarizeRawFile(file: RepositoryIndex["files"][number], candidate: ContextCandidate): Pick<
  FileSummary,
  "summary" | "purpose" | "publicApi" | "keyInvariants" | "dependencyNotes" | "inclusionReason" | "preservedInterfaces"
> {
  const preservedInterfaces = getPreservedInterfaces(file);
  const dependencyNotes = file.imports.length > 0 ? [`Imports ${file.imports.slice(0, 5).join(", ")}`] : [];
  const purpose = candidate.role === "primary" || candidate.role === "manual"
    ? "Raw implementation preserved because it is a high-priority editing surface."
    : "Raw source preserved because its implementation details are likely material.";
  const keyInvariants =
    preservedInterfaces.length > 0
      ? [`Do not break ${preservedInterfaces.join(", ")}`]
      : ["Preserve implementation behavior."];

  return {
    summary: `${purpose} Reason: ${candidate.reason}`,
    purpose,
    publicApi: preservedInterfaces,
    keyInvariants,
    dependencyNotes,
    inclusionReason: candidate.reason,
    preservedInterfaces
  };
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

async function createRawItem(
  file: RepositoryIndex["files"][number],
  repositoryRoot: string,
  candidate: ContextCandidate
): Promise<FileSummary> {
  const content = await readRawFile(repositoryRoot, file.path);
  const details = summarizeRawFile(file, candidate);

  return {
    path: file.path,
    compression: "raw",
    content,
    estimatedTokens: estimateTextTokens(content),
    ...details
  };
}

async function createSummaryItem(
  candidate: ContextCandidate,
  file: RepositoryIndex["files"][number],
  index: RepositoryIndex,
  summarizer?: SummarizationProvider
): Promise<FileSummary> {
  if (summarizer) {
    const [summary] = await summarizer.summarize([candidate], index);
    if (summary) {
      return {
        ...summary,
        compression: "summary",
        purpose: summary.purpose,
        publicApi: summary.publicApi,
        keyInvariants: summary.keyInvariants,
        dependencyNotes: summary.dependencyNotes,
        inclusionReason: summary.inclusionReason
      };
    }
  }

  return buildFallbackSummary(file, candidate);
}

function getPreservedInterfaces(file: RepositoryIndex["files"][number]): string[] {
  return file.symbols
    .filter((symbol) => symbol.kind === "class" || symbol.kind === "function" || symbol.kind === "interface")
    .map((symbol) => symbol.name);
}

function shouldKeepRaw(candidate: ContextCandidate): boolean {
  return candidate.role === "primary" || candidate.role === "manual" || candidate.score >= 14;
}

function selectBudgetBucket(candidate: ContextCandidate): "summary" | "dependency" | "tests" {
  if (candidate.role === "test") {
    return "tests";
  }
  if (candidate.role === "dependency" || candidate.role === "semantic-support") {
    return "dependency";
  }

  return "summary";
}

function fitsBudget(used: number, estimate: number, cap: number): boolean {
  if (cap <= 0) {
    return false;
  }

  return used + estimate <= cap;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
