import { performance } from "node:perf_hooks";
import { ClaudeAdapter, CodexAdapter } from "./adapters/agent-adapters";
import { PromptCompiler } from "./compiler/prompt-compiler";
import { ContextCompressor } from "./compression/compressor";
import { FilesystemParserProvider, RepositoryIndexer } from "./indexing/indexer";
import { FileSessionMemory } from "./memory/session-memory";
import { NativeIndexClient, NativeLexicalProvider, NativeMirrorParserProvider } from "./native/native-client";
import { applyTaskOverrides, HybridRetriever } from "./retrieval/retriever";
import { FileStorageBackend } from "./storage/index-store";
import {
  type AgentTarget,
  type AgentPayload,
  type BenchmarkReport,
  type BenchmarkTask,
  type CompiledPrompt,
  type EngineDependencies,
  type IndexRepositoryRequest,
  type RepositoryIndex,
  type UserTask
} from "./types/contracts";

export class NomicEngine {
  private readonly indexer: RepositoryIndexer;
  private readonly retriever: HybridRetriever;
  private readonly compressor: ContextCompressor;
  private readonly compiler: PromptCompiler;

  constructor(private readonly dependencies: EngineDependencies) {
    this.indexer = new RepositoryIndexer(dependencies.parser ?? new FilesystemParserProvider());
    this.retriever = new HybridRetriever(dependencies.embeddings, dependencies.ranker);
    this.compressor = new ContextCompressor(dependencies.summarizer, dependencies.tokenBudget);
    this.compiler = new PromptCompiler(dependencies.tokenEstimator);
  }

  async indexRepository(request: IndexRepositoryRequest): Promise<RepositoryIndex> {
    const existingIndex = request.existingIndex !== undefined
      ? request.existingIndex
      : await this.dependencies.storage.readIndex(request.repositoryRoot);
    const index = await this.indexer.index({
      ...request,
      existingIndex
    });
    await this.dependencies.storage.writeIndex(index);
    return index;
  }

  async compileTask(task: UserTask): Promise<CompiledPrompt> {
    const startedAt = performance.now();
    const repositoryRoot = task.repositoryRoot ?? process.cwd();
    const indexStartedAt = performance.now();
    const storedIndex = await this.dependencies.storage.readIndex(repositoryRoot);
    const index = isIndexCompatible(storedIndex)
      ? storedIndex
      : await this.indexRepository({ repositoryRoot, existingIndex: null });
    const indexMs = performance.now() - indexStartedAt;

    const sessionContext = await this.dependencies.memory.recent(3, repositoryRoot);
    const memoryPinnedPaths = unique(sessionContext.flatMap((record) => record.selectedFiles).slice(0, 4));
    const retrievalTask = mergeTaskOverrides(task, memoryPinnedPaths);
    const retrievalStartedAt = performance.now();
    const retrieval = applyTaskOverrides(await this.retriever.retrieve(retrievalTask, index), index, retrievalTask.overrides);
    const retrievalMs = performance.now() - retrievalStartedAt;
    const compressionStartedAt = performance.now();
    const compression = await this.compressor.compress(retrieval.candidates, index);
    const compressionMs = performance.now() - compressionStartedAt;
    const compileStartedAt = performance.now();
    const compiled = this.compiler.compile(task, {
      index,
      retrieval,
      compression,
      sessionContext
    });
    const compileMs = performance.now() - compileStartedAt;
    compiled.diagnostics = {
      indexMs,
      retrievalMs,
      compressionMs,
      compileMs,
      totalMs: performance.now() - startedAt,
      fileCount: index.fileCount,
      chunkCount: index.chunks.length,
      edgeCount: index.edges.length
    };

    await this.dependencies.memory.remember(task, compiled);
    return compiled;
  }

  async explainSelection(task: UserTask): Promise<CompiledPrompt["selectionReasons"]> {
    const repositoryRoot = task.repositoryRoot ?? process.cwd();
    const storedIndex = await this.dependencies.storage.readIndex(repositoryRoot);
    const index = isIndexCompatible(storedIndex)
      ? storedIndex
      : await this.indexRepository({ repositoryRoot, existingIndex: null });
    const sessionContext = await this.dependencies.memory.recent(3, repositoryRoot);
    const memoryPinnedPaths = unique(sessionContext.flatMap((record) => record.selectedFiles).slice(0, 4));
    const retrievalTask = mergeTaskOverrides(task, memoryPinnedPaths);
    const retrieval = applyTaskOverrides(await this.retriever.retrieve(retrievalTask, index), index, retrievalTask.overrides);

    return retrieval.candidates.map((candidate) => ({
      path: candidate.path,
      reason: candidate.reason,
      score: candidate.score,
      source: candidate.source,
      role: candidate.role,
      stage: candidate.stage
    }));
  }

  async diagnostics(repositoryRoot = process.cwd()): Promise<{
    hasIndex: boolean;
    generatedAt?: string;
    fileCount?: number;
    chunkCount?: number;
    edgeCount?: number;
    reusedFiles?: number;
    chunkReuseRatio?: number;
    backend: "typescript" | "native";
    nativeAddonPath?: string;
  }> {
    const nativeDiagnostics = NativeIndexClient.diagnostics();
    const backend = process.env.NOMIC_INDEX_BACKEND === "native" ? "native" : "typescript";
    const index = await this.dependencies.storage.readIndex(repositoryRoot);
    if (!index) {
      return { hasIndex: false, backend, nativeAddonPath: nativeDiagnostics.addonPath };
    }

    return {
      hasIndex: true,
      generatedAt: index.generatedAt,
      fileCount: index.fileCount,
      chunkCount: index.chunks.length,
      edgeCount: index.edges.length,
      reusedFiles: index.metrics.reusedFiles,
      chunkReuseRatio: index.chunks.length === 0 ? 0 : index.metrics.reusedChunks / index.chunks.length,
      backend,
      nativeAddonPath: nativeDiagnostics.addonPath
    };
  }

  async benchmark(repositoryRoot: string, tasks: BenchmarkTask[]): Promise<BenchmarkReport> {
    const indexStartedAt = performance.now();
    await this.indexRepository({ repositoryRoot });
    const indexMs = performance.now() - indexStartedAt;
    const compileReports: BenchmarkReport["compileReports"] = [];

    for (const task of tasks) {
      const compiled = await this.compileTask({
        ...task,
        repositoryRoot
      });
      const relevantFiles = task.relevantFiles ?? [];
      const retrievedFiles = compiled.selectionReasons.map((reason) => reason.path);
      compileReports.push({
        task: task.text,
        target: task.target,
        totalMs: compiled.diagnostics.totalMs,
        tokenEstimate: compiled.tokenEstimate,
        includedFiles: compiled.includedFiles.length,
        relevantFiles,
        retrievedFiles,
        ...computeRetrievalMetrics(retrievedFiles, relevantFiles)
      });
    }

    const averageCompileMs =
      compileReports.reduce((total, report) => total + report.totalMs, 0) / Math.max(1, compileReports.length);
    const peakTokenEstimate = Math.max(0, ...compileReports.map((report) => report.tokenEstimate));
    const labelledReports = compileReports.filter((report) => report.relevantFiles.length > 0);
    const latencies = compileReports.map((report) => report.totalMs);

    return {
      repositoryRoot,
      indexMs,
      compileReports,
      averageCompileMs,
      peakTokenEstimate,
      recallAt5: average(labelledReports.map((report) => report.recallAt5)),
      recallAt10: average(labelledReports.map((report) => report.recallAt10)),
      mrr: average(labelledReports.map((report) => report.reciprocalRank)),
      ndcgAt10: average(labelledReports.map((report) => report.ndcgAt10)),
      contextPrecision: average(labelledReports.map((report) => report.contextPrecision)),
      queryP50Ms: percentile(latencies, 0.5),
      queryP95Ms: percentile(latencies, 0.95)
    };
  }

  async formatForTarget(compiledPrompt: CompiledPrompt, target: AgentTarget): Promise<AgentPayload> {
    const adapter = this.dependencies.adapters[target];
    return adapter.format(compiledPrompt);
  }
}

export function createNomicEngine(overrides: Partial<EngineDependencies> = {}): NomicEngine {
  const nativeBackend = !overrides.parser && !overrides.embeddings && process.env.NOMIC_INDEX_BACKEND === "native";
  const nativeClient = nativeBackend ? NativeIndexClient.load() : undefined;
  const parser = overrides.parser ?? (nativeClient
    ? new NativeMirrorParserProvider(nativeClient, new FilesystemParserProvider())
    : undefined);
  const embeddings = overrides.embeddings ?? (nativeClient ? new NativeLexicalProvider(nativeClient) : undefined);
  return new NomicEngine({
    storage: overrides.storage ?? new FileStorageBackend(),
    memory: overrides.memory ?? new FileSessionMemory(),
    adapters:
      overrides.adapters ??
      ({
        claude: new ClaudeAdapter(),
        codex: new CodexAdapter()
      } satisfies EngineDependencies["adapters"]),
    parser,
    embeddings,
    summarizer: overrides.summarizer,
    tokenBudget: overrides.tokenBudget,
    tokenEstimator: overrides.tokenEstimator
  });
}

function mergeTaskOverrides(task: UserTask, memoryPinnedPaths: string[]): UserTask {
  const existingPinned = task.overrides?.pinnedPaths ?? [];
  const excludedPaths = task.overrides?.excludedPaths ?? [];

  return {
    ...task,
    overrides: {
      pinnedPaths: unique([...existingPinned, ...memoryPinnedPaths]).filter((candidate) => !excludedPaths.includes(candidate)),
      excludedPaths
    }
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isIndexCompatible(index: RepositoryIndex | null): index is RepositoryIndex {
  if (!index) {
    return false;
  }
  const configuredBackend = process.env.NOMIC_INDEX_BACKEND === "native" ? "native" : "typescript";
  return configuredBackend === "typescript"
    ? index.backend === undefined || index.backend === "typescript"
    : index.backend === "native";
}

function computeRetrievalMetrics(retrieved: string[], relevant: string[]): {
  recallAt5: number;
  recallAt10: number;
  reciprocalRank: number;
  ndcgAt10: number;
  contextPrecision: number;
} {
  const relevantSet = new Set(relevant);
  if (relevantSet.size === 0) {
    return { recallAt5: 0, recallAt10: 0, reciprocalRank: 0, ndcgAt10: 0, contextPrecision: 0 };
  }
  const hitsAt = (limit: number): number =>
    new Set(retrieved.slice(0, limit).filter((path) => relevantSet.has(path))).size;
  const firstRelevant = retrieved.findIndex((path) => relevantSet.has(path));
  const dcg = retrieved.slice(0, 10).reduce(
    (total, path, index) => total + (relevantSet.has(path) ? 1 / Math.log2(index + 2) : 0),
    0
  );
  const idealDcg = Array.from({ length: Math.min(10, relevantSet.size) }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((total, value) => total + value, 0);

  return {
    recallAt5: hitsAt(5) / relevantSet.size,
    recallAt10: hitsAt(10) / relevantSet.size,
    reciprocalRank: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
    ndcgAt10: idealDcg === 0 ? 0 : dcg / idealDcg,
    contextPrecision: retrieved.length === 0 ? 0 : hitsAt(retrieved.length) / retrieved.length
  };
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}
