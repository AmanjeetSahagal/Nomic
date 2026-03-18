import { performance } from "node:perf_hooks";
import { ClaudeAdapter, CodexAdapter } from "./adapters/agent-adapters";
import { PromptCompiler } from "./compiler/prompt-compiler";
import { ContextCompressor } from "./compression/compressor";
import { FilesystemParserProvider, RepositoryIndexer } from "./indexing/indexer";
import { FileSessionMemory } from "./memory/session-memory";
import { applyTaskOverrides, HybridRetriever } from "./retrieval/retriever";
import { FileStorageBackend } from "./storage/index-store";
import {
  type AgentTarget,
  type AgentPayload,
  type BenchmarkReport,
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
    this.retriever = new HybridRetriever(dependencies.embeddings);
    this.compressor = new ContextCompressor(dependencies.summarizer, dependencies.tokenBudget);
    this.compiler = new PromptCompiler(dependencies.tokenEstimator);
  }

  async indexRepository(request: IndexRepositoryRequest): Promise<RepositoryIndex> {
    const existingIndex =
      request.existingIndex ??
      (await this.dependencies.storage.readIndex(request.repositoryRoot));
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
    const index =
      (await this.dependencies.storage.readIndex(repositoryRoot)) ??
      (await this.indexRepository({ repositoryRoot }));
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
    const index =
      (await this.dependencies.storage.readIndex(repositoryRoot)) ??
      (await this.indexRepository({ repositoryRoot }));
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
  }> {
    const index = await this.dependencies.storage.readIndex(repositoryRoot);
    if (!index) {
      return { hasIndex: false };
    }

    return {
      hasIndex: true,
      generatedAt: index.generatedAt,
      fileCount: index.fileCount,
      chunkCount: index.chunks.length,
      edgeCount: index.edges.length,
      reusedFiles: index.metrics.reusedFiles,
      chunkReuseRatio: index.chunks.length === 0 ? 0 : index.metrics.reusedChunks / index.chunks.length
    };
  }

  async benchmark(repositoryRoot: string, tasks: UserTask[]): Promise<BenchmarkReport> {
    const indexStartedAt = performance.now();
    await this.indexRepository({ repositoryRoot });
    const indexMs = performance.now() - indexStartedAt;
    const compileReports: BenchmarkReport["compileReports"] = [];

    for (const task of tasks) {
      const compiled = await this.compileTask({
        ...task,
        repositoryRoot
      });
      compileReports.push({
        task: task.text,
        target: task.target,
        totalMs: compiled.diagnostics.totalMs,
        tokenEstimate: compiled.tokenEstimate,
        includedFiles: compiled.includedFiles.length
      });
    }

    const averageCompileMs =
      compileReports.reduce((total, report) => total + report.totalMs, 0) / Math.max(1, compileReports.length);
    const peakTokenEstimate = Math.max(0, ...compileReports.map((report) => report.tokenEstimate));

    return {
      repositoryRoot,
      indexMs,
      compileReports,
      averageCompileMs,
      peakTokenEstimate
    };
  }

  async formatForTarget(compiledPrompt: CompiledPrompt, target: AgentTarget): Promise<AgentPayload> {
    const adapter = this.dependencies.adapters[target];
    return adapter.format(compiledPrompt);
  }
}

export function createNomicEngine(overrides: Partial<EngineDependencies> = {}): NomicEngine {
  return new NomicEngine({
    storage: overrides.storage ?? new FileStorageBackend(),
    memory: overrides.memory ?? new FileSessionMemory(),
    adapters:
      overrides.adapters ??
      ({
        claude: new ClaudeAdapter(),
        codex: new CodexAdapter()
      } satisfies EngineDependencies["adapters"]),
    parser: overrides.parser,
    embeddings: overrides.embeddings,
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
