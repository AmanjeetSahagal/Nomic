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
    const repositoryRoot = task.repositoryRoot ?? process.cwd();
    const index =
      (await this.dependencies.storage.readIndex(repositoryRoot)) ??
      (await this.indexRepository({ repositoryRoot }));

    const sessionContext = await this.dependencies.memory.recent(3, repositoryRoot);
    const memoryPinnedPaths = unique(sessionContext.flatMap((record) => record.selectedFiles).slice(0, 4));
    const retrievalTask = mergeTaskOverrides(task, memoryPinnedPaths);
    const retrieval = applyTaskOverrides(await this.retriever.retrieve(retrievalTask, index), index, retrievalTask.overrides);
    const compression = await this.compressor.compress(retrieval.candidates, index);
    const compiled = this.compiler.compile(task, {
      index,
      retrieval,
      compression,
      sessionContext
    });

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
      reusedFiles: index.metrics.reusedFiles
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
