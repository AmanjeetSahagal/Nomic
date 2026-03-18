export type AgentTarget = "codex" | "claude";

export interface TaskOverrides {
  pinnedPaths: string[];
  excludedPaths: string[];
}

export interface UserTask {
  text: string;
  target: AgentTarget;
  repositoryRoot?: string;
  overrides?: TaskOverrides;
}

export interface TokenBudget {
  maxContextTokens: number;
  rawCodeFraction: number;
  summaryFraction: number;
  dependencyFraction: number;
  testFraction: number;
}

export interface BudgetUsage {
  raw: number;
  summary: number;
  dependency: number;
  tests: number;
  total: number;
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
  modifiedAtMs: number;
  imports: string[];
  isTest: boolean;
  symbols: IndexedSymbol[];
}

export interface IndexingMetrics {
  addedFiles: number;
  changedFiles: number;
  removedFiles: number;
  reusedFiles: number;
}

export interface RepositoryIndex {
  repositoryRoot: string;
  fileCount: number;
  files: FileRecord[];
  generatedAt: string;
  metrics: IndexingMetrics;
}

export interface ContextCandidate {
  path: string;
  reason: string;
  score: number;
  source: "structural" | "semantic" | "manual";
}

export interface FileSummary {
  path: string;
  compression: "raw" | "summary";
  summary: string;
  content?: string;
  estimatedTokens: number;
  preservedInterfaces: string[];
}

export interface CompressionResult {
  items: FileSummary[];
  tokenBudget: TokenBudget;
  budgetUsage: BudgetUsage;
  omittedPaths: string[];
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
  omittedPaths: string[];
  tokenBudget: TokenBudget;
  budgetUsage: BudgetUsage;
  selectionReasons: Array<Pick<ContextCandidate, "path" | "reason" | "score" | "source">>;
  summaries: FileSummary[];
}

export interface AgentPayload {
  target: AgentTarget;
  system: string;
  user: string;
  metadata: {
    includedFiles: string[];
    relatedTests: string[];
    omittedPaths: string[];
    tokenEstimate: number;
  };
}

export interface SessionRecord {
  task: UserTask;
  compiledPrompt: CompiledPrompt;
  createdAt: string;
}

export interface IndexRepositoryRequest {
  repositoryRoot: string;
  existingIndex?: RepositoryIndex | null;
}

export interface CompileTaskDependencies {
  index: RepositoryIndex;
  retrieval: RetrievalResult;
  compression: CompressionResult;
  sessionContext: SessionRecord[];
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
  recent(limit: number, repositoryRoot?: string): Promise<SessionRecord[]>;
}

export interface AgentAdapter {
  target: AgentTarget;
  format(compiledPrompt: CompiledPrompt): Promise<AgentPayload>;
}

export interface EngineDependencies {
  parser?: ParserProvider;
  embeddings?: EmbeddingProvider;
  summarizer?: SummarizationProvider;
  storage: StorageBackend;
  memory: SessionMemory;
  adapters: Record<AgentTarget, AgentAdapter>;
  tokenBudget?: TokenBudget;
  tokenEstimator?: TokenEstimator;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  maxContextTokens: 8000,
  rawCodeFraction: 0.5,
  summaryFraction: 0.25,
  dependencyFraction: 0.15,
  testFraction: 0.1
};
