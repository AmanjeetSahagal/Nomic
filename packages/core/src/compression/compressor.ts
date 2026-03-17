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

    for (const candidate of rankedCandidates) {
      const file = fileByPath.get(candidate.path);
      if (!file) {
        omittedPaths.push(candidate.path);
        continue;
      }

      if (file.isTest) {
        const summaryItem = await createSummaryItem(candidate, file, index, this.summarizer);
        if (fitsBudget(usage.tests, summaryItem.estimatedTokens, budgetCaps.tests)) {
          items.push(summaryItem);
          usage.tests += summaryItem.estimatedTokens;
        } else {
          omittedPaths.push(candidate.path);
        }
        continue;
      }

      if (isDependencyCandidate(candidate)) {
        const dependencyItem = await createSummaryItem(candidate, file, index, this.summarizer);
        if (fitsBudget(usage.dependency, dependencyItem.estimatedTokens, budgetCaps.dependency)) {
          items.push(dependencyItem);
          usage.dependency += dependencyItem.estimatedTokens;
        } else {
          omittedPaths.push(candidate.path);
        }
        continue;
      }

      const rawItem = await createRawItem(file, index.repositoryRoot);
      if (fitsBudget(usage.raw, rawItem.estimatedTokens, budgetCaps.raw)) {
        items.push(rawItem);
        usage.raw += rawItem.estimatedTokens;
        continue;
      }

      const summaryItem = await createSummaryItem(candidate, file, index, this.summarizer);
      if (fitsBudget(usage.summary, summaryItem.estimatedTokens, budgetCaps.summary)) {
        items.push(summaryItem);
        usage.summary += summaryItem.estimatedTokens;
      } else {
        omittedPaths.push(candidate.path);
      }
    }

    usage.total = usage.raw + usage.summary + usage.dependency + usage.tests;

    return {
      items,
      tokenBudget: this.tokenBudget,
      budgetUsage: usage,
      omittedPaths
    };
  }
}

async function readRawFile(repositoryRoot: string, relativePath: string): Promise<string> {
  const filePath = path.join(repositoryRoot, relativePath);
  return readFile(filePath, "utf8");
}

function buildFallbackSummary(
  file: RepositoryIndex["files"][number],
  reason: string
): string {
  const exportedInterfaces = file.symbols
    .filter((symbol) => symbol.kind === "class" || symbol.kind === "function" || symbol.kind === "interface")
    .map((symbol) => symbol.name);

  const interfaceLine =
    exportedInterfaces.length > 0
      ? `Key interfaces: ${exportedInterfaces.join(", ")}.`
      : "No major interfaces detected.";

  const importLine =
    file.imports.length > 0
      ? `Imports: ${file.imports.slice(0, 5).join(", ")}.`
      : "No imports detected.";

  return `Selected because ${reason}. ${interfaceLine} ${importLine}`;
}

function summarizeInterfaces(file: RepositoryIndex["files"][number]): string {
  const interfaces = file.symbols
    .filter((symbol) => symbol.kind === "class" || symbol.kind === "function" || symbol.kind === "interface")
    .map((symbol) => symbol.name);

  if (interfaces.length === 0) {
    return "Raw file included to preserve implementation details.";
  }

  return `Raw file included. Preserved interfaces: ${interfaces.join(", ")}.`;
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

async function createRawItem(
  file: RepositoryIndex["files"][number],
  repositoryRoot: string
): Promise<FileSummary> {
  const content = await readRawFile(repositoryRoot, file.path);
  return {
    path: file.path,
    compression: "raw",
    summary: summarizeInterfaces(file),
    content,
    estimatedTokens: estimateTextTokens(content),
    preservedInterfaces: getPreservedInterfaces(file)
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
        compression: "summary"
      };
    }
  }

  const fallback = buildFallbackSummary(file, candidate.reason);
  return {
    path: candidate.path,
    compression: "summary",
    summary: fallback,
    estimatedTokens: estimateTextTokens(fallback),
    preservedInterfaces: getPreservedInterfaces(file)
  };
}

function getPreservedInterfaces(file: RepositoryIndex["files"][number]): string[] {
  return file.symbols
    .filter((symbol) => symbol.kind === "class" || symbol.kind === "function" || symbol.kind === "interface")
    .map((symbol) => symbol.name);
}

function isDependencyCandidate(candidate: ContextCandidate): boolean {
  return candidate.reason.startsWith("Imported by");
}

function fitsBudget(used: number, estimate: number, cap: number): boolean {
  if (cap <= 0) {
    return false;
  }

  return used + estimate <= cap;
}
