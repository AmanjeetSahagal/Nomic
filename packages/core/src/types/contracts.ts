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
  id: string;
  name: string;
  kind: "function" | "class" | "interface" | "module" | "test" | "unknown";
  path: string;
  exported: boolean;
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

export interface IndexEdge {
  from: string;
  to: string;
  kind: "import" | "reference" | "caller" | "callee" | "test";
  weight: number;
}

export interface ChunkRecord {
  id: string;
  filePath: string;
  kind: "code" | "doc" | "note" | "test";
  startLine: number;
  endLine: number;
  tokenEstimate: number;
  text: string;
}

export interface IndexingMetrics {
  addedFiles: number;
  changedFiles: number;
  removedFiles: number;
  reusedFiles: number;
  reusedChunks: number;
  reusedEdges: number;
}

export interface RepositoryIndex {
  repositoryRoot: string;
  fileCount: number;
  files: FileRecord[];
  symbols: IndexedSymbol[];
  chunks: ChunkRecord[];
  edges: IndexEdge[];
  generatedAt: string;
  metrics: IndexingMetrics;
}

export interface RetrievalAnalysis {
  normalizedTask: string;
  queryTerms: string[];
  intent: "feature" | "refactor" | "bugfix" | "docs" | "general";
}

export interface ContextCandidate {
  path: string;
  reason: string;
  score: number;
  source: "structural" | "semantic" | "manual";
  role: "primary" | "dependency" | "test" | "semantic-support" | "manual";
  stage: "seed" | "graph" | "semantic" | "override";
  dependencyDistance: number;
  structuralScore: number;
  semanticScore: number;
  recencyScore: number;
  fileImportanceScore: number;
  tokenCost: number;
  chunkIds: string[];
  expansionPath: string[];
}

export interface FileSummary {
  path: string;
  compression: "raw" | "summary";
  summary: string;
  purpose: string;
  publicApi: string[];
  keyInvariants: string[];
  dependencyNotes: string[];
  inclusionReason: string;
  content?: string;
  estimatedTokens: number;
  preservedInterfaces: string[];
}

export interface CompressionResult {
  items: FileSummary[];
  tokenBudget: TokenBudget;
  budgetUsage: BudgetUsage;
  omittedPaths: string[];
  dependencyNotes: string[];
}

export interface RetrievalResult {
  analysis: RetrievalAnalysis;
  candidates: ContextCandidate[];
  relatedTests: string[];
  structuralCandidates: ContextCandidate[];
  semanticCandidates: ContextCandidate[];
  truncationReasons: string[];
  rerankWeights: Record<string, number>;
}

export interface CompiledPromptSection {
  key:
    | "task"
    | "constraints"
    | "retrieval"
    | "raw"
    | "summaries"
    | "dependencies"
    | "tests"
    | "omissions"
    | "budget";
  title: string;
  tokenEstimate: number;
}

export interface CompiledPrompt {
  promptId: string;
  target: AgentTarget;
  prompt: string;
  tokenEstimate: number;
  includedFiles: string[];
  relatedTests: string[];
  omittedPaths: string[];
  omissionReasons: string[];
  tokenBudget: TokenBudget;
  budgetUsage: BudgetUsage;
  selectionReasons: Array<Pick<ContextCandidate, "path" | "reason" | "score" | "source" | "role" | "stage">>;
  summaries: FileSummary[];
  retrievalSummary: string[];
  dependencyNotes: string[];
  sections: CompiledPromptSection[];
}

export interface AgentPayload {
  target: AgentTarget;
  system: string;
  user: string;
  metadata: {
    promptId: string;
    includedFiles: string[];
    relatedTests: string[];
    omittedPaths: string[];
    tokenEstimate: number;
  };
}

export interface SessionRecord {
  task: UserTask;
  compiledPrompt: CompiledPrompt;
  selectedFiles: string[];
  architectureSummary: string[];
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
