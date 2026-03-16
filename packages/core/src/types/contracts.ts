export type AgentTarget = "codex" | "claude";

export interface UserTask {
  text: string;
  target: AgentTarget;
  repositoryRoot?: string;
}

export interface TokenBudget {
  maxContextTokens: number;
  rawCodeFraction: number;
  summaryFraction: number;
  dependencyFraction: number;
  testFraction: number;
}

export interface IndexedSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "module" | "test" | "unknown";
  path: string;
}

export interface FileRecord {
  path: string;
  language: string;
  size: number;
  imports: string[];
  isTest: boolean;
  symbols: IndexedSymbol[];
}

export interface RepositoryIndex {
  repositoryRoot: string;
  fileCount: number;
  files: FileRecord[];
  generatedAt: string;
}

export interface ContextCandidate {
  path: string;
  reason: string;
  score: number;
  source: "structural" | "semantic" | "manual";
}

export interface FileSummary {
  path: string;
  summary: string;
  preservedInterfaces: string[];
}

export interface RetrievalResult {
  candidates: ContextCandidate[];
  relatedTests: string[];
  queryTerms: string[];
}

export interface CompiledPrompt {
  target: AgentTarget;
  prompt: string;
  tokenEstimate: number;
  includedFiles: string[];
  relatedTests: string[];
  selectionReasons: Array<Pick<ContextCandidate, "path" | "reason" | "score" | "source">>;
  summaries: FileSummary[];
}

export interface IndexRepositoryRequest {
  repositoryRoot: string;
}

export interface CompileTaskDependencies {
  index: RepositoryIndex;
  retrieval: RetrievalResult;
  summaries: FileSummary[];
}

export interface ParserProvider {
  name: string;
  indexRepository(request: IndexRepositoryRequest): Promise<RepositoryIndex>;
}

export interface EmbeddingProvider {
  name: string;
  search(task: UserTask, index: RepositoryIndex): Promise<ContextCandidate[]>;
}

export interface SummarizationProvider {
  name: string;
  summarize(candidates: ContextCandidate[], index: RepositoryIndex): Promise<FileSummary[]>;
}

export interface TokenEstimator {
  estimate(prompt: string): number;
}

export interface StorageBackend {
  readIndex(repositoryRoot: string): Promise<RepositoryIndex | null>;
  writeIndex(index: RepositoryIndex): Promise<void>;
}

export interface SessionMemory {
  remember(task: UserTask, compiledPrompt: CompiledPrompt): Promise<void>;
  recent(limit: number): Promise<CompiledPrompt[]>;
}

export interface AgentAdapter {
  target: AgentTarget;
  format(compiledPrompt: CompiledPrompt): Promise<string>;
}

export interface EngineDependencies {
  parser?: ParserProvider;
  embeddings?: EmbeddingProvider;
  summarizer?: SummarizationProvider;
  storage: StorageBackend;
  memory: SessionMemory;
  adapters: Record<AgentTarget, AgentAdapter>;
  tokenEstimator?: TokenEstimator;
}
