import { ClaudeAdapter, CodexAdapter } from "./adapters/agent-adapters";
import { PromptCompiler } from "./compiler/prompt-compiler";
import { ContextCompressor } from "./compression/compressor";
import { FilesystemParserProvider, RepositoryIndexer } from "./indexing/indexer";
import { InMemorySessionMemory } from "./memory/session-memory";
import { HybridRetriever } from "./retrieval/retriever";
import { FileStorageBackend } from "./storage/index-store";
import {
  type AgentTarget,
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
    this.compressor = new ContextCompressor(dependencies.summarizer);
    this.compiler = new PromptCompiler(dependencies.tokenEstimator);
  }

  async indexRepository(request: IndexRepositoryRequest): Promise<RepositoryIndex> {
    const index = await this.indexer.index(request);
    await this.dependencies.storage.writeIndex(index);
    return index;
  }

  async compileTask(task: UserTask): Promise<CompiledPrompt> {
    const repositoryRoot = task.repositoryRoot ?? process.cwd();
    const index =
      (await this.dependencies.storage.readIndex(repositoryRoot)) ??
      (await this.indexRepository({ repositoryRoot }));

    const retrieval = await this.retriever.retrieve(task, index);
    const summaries = await this.compressor.compress(retrieval.candidates, index);
    const compiled = this.compiler.compile(task, {
      index,
      retrieval,
      summaries
    });

    await this.dependencies.memory.remember(task, compiled);
    return compiled;
  }

  async explainSelection(task: UserTask): Promise<CompiledPrompt["selectionReasons"]> {
    const repositoryRoot = task.repositoryRoot ?? process.cwd();
    const index =
      (await this.dependencies.storage.readIndex(repositoryRoot)) ??
      (await this.indexRepository({ repositoryRoot }));

    const retrieval = await this.retriever.retrieve(task, index);
    return retrieval.candidates.map((candidate) => ({
      path: candidate.path,
      reason: candidate.reason,
      score: candidate.score,
      source: candidate.source
    }));
  }

  async formatForTarget(compiledPrompt: CompiledPrompt, target: AgentTarget): Promise<string> {
    const adapter = this.dependencies.adapters[target];
    return adapter.format(compiledPrompt);
  }
}

export function createNomicEngine(overrides: Partial<EngineDependencies> = {}): NomicEngine {
  return new NomicEngine({
    storage: overrides.storage ?? new FileStorageBackend(),
    memory: overrides.memory ?? new InMemorySessionMemory(),
    adapters:
      overrides.adapters ??
      ({
        claude: new ClaudeAdapter(),
        codex: new CodexAdapter()
      } satisfies EngineDependencies["adapters"]),
    parser: overrides.parser,
    embeddings: overrides.embeddings,
    summarizer: overrides.summarizer,
    tokenEstimator: overrides.tokenEstimator
  });
}
