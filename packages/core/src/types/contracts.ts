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
  qualifiedName?: string;
  kind: "function" | "class" | "interface" | "module" | "test" | "unknown";
  path: string;
  exported: boolean;
  startLine?: number;
  endLine?: number;
}

export interface FileRecord {
  path: string;
  language: string;
  size: number;
  modifiedAtMs: number;
  imports: string[];
  isTest: boolean;
  symbols: IndexedSymbol[];
  contentHash?: string;
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
  parsedFiles?: number;
  failedFiles?: number;
  invalidatedSymbols?: number;
  wallTimeMs?: number;
  indexBytes?: number;
  schemaVersion?: number;
  stageTimingsMs?: Record<string, number>;
}

export interface RepositoryIndex {
  backend?: "typescript" | "native";
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
  source: "structural" | "semantic" | "lexical" | "manual";
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
  symbolId?: string;
  startLine?: number;
  endLine?: number;
  lexicalScore?: number;
  graphFeatures?: Record<string, number>;
  rankerScore?: number;
  featureVersion?: string;
  modelVersion?: string;
}

export interface RankingFeatures {
  bm25Score: number; normalizedBm25Score: number; bm25Rank: number; topScoreMargin: number;
  exactSymbolMatch: number; prefixSymbolMatch: number; symbolTokenOverlap: number; matchingSymbolCount: number; symbolTypeId: number;
  filenameOverlap: number; pathTokenOverlap: number; directoryDepth: number; fileExtensionId: number;
  isImplementationFile: number; isTestFile: number; isDocumentationFile: number; isGeneratedFile: number;
  queryTermCoverage: number; rareTermMatchCount: number; identifierOverlap: number; commentOverlap: number;
  chunkTokenCount: number; symbolLineCount: number; codeToCommentRatio: number;
  repositoryLanguageId: number; repositoryFileCountBucket: number; inboundDependencyCount: number; dependencyDistance: number;
}

export type RankingMode = "baseline" | "logistic" | "lightgbm" | "neural";
export interface RankingConfiguration { mode: RankingMode; modelPath?: string; metadataPath?: string; timeoutMs?: number; fallback?: "baseline"; }

export interface CandidateRanker {
  readonly name: string;
  readonly featureVersion: string;
  readonly modelVersion?: string;
  readonly lastFallbackReason?: string;
  rank(task: UserTask, candidates: ContextCandidate[], index: RepositoryIndex): Promise<ContextCandidate[]>;
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
  stageTimingsMs?: Record<string, number>;
  rankingFallbackReason?: string;
}

export interface RetrievalProvider {
  retrieve(task: UserTask, index: RepositoryIndex): Promise<RetrievalResult>;
}

export interface RetrievalOptions {
  exactPathOverride?: boolean;
  graphExpansion?: boolean;
  semanticExpansion?: boolean;
  maxCandidates?: number;
  chunksPerFile?: number;
  ranker?: CandidateRanker;
}

export interface CompiledPromptDiagnostics {
  indexMs: number;
  retrievalMs: number;
  compressionMs: number;
  compileMs: number;
  totalMs: number;
  fileCount: number;
  chunkCount: number;
  edgeCount: number;
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
  compiledAt: string;
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
  diagnostics: CompiledPromptDiagnostics;
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

export interface BenchmarkTaskReport {
  task: string;
  target: AgentTarget;
  totalMs: number;
  tokenEstimate: number;
  includedFiles: number;
  relevantFiles: string[];
  retrievedFiles: string[];
  recallAt5: number;
  recallAt10: number;
  reciprocalRank: number;
  ndcgAt10: number;
  contextPrecision: number;
}

export interface BenchmarkTask extends UserTask {
  id?: string;
  relevantFiles?: string[];
  relevantSymbols?: string[];
  repositoryCommit?: string;
  patchCommit?: string;
  split?: "train" | "validation" | "test";
}

export interface BenchmarkReport {
  repositoryRoot: string;
  indexMs: number;
  compileReports: BenchmarkTaskReport[];
  averageCompileMs: number;
  peakTokenEstimate: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  contextPrecision: number;
  queryP50Ms: number;
  queryP95Ms: number;
}

export interface RetrievalFeedback {
  schemaVersion: 1;
  taskHash: string;
  repositoryRoot: string;
  candidatePaths: string[];
  selectedPaths: string[];
  acceptedPatchPaths: string[];
  featureVersion?: string;
  modelVersion?: string;
  createdAt: string;
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
  maxFileSizeBytes?: number;
  extensions?: string[];
  respectGitignore?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: IndexProgress) => void;
  changedPaths?: string[];
}

export type ContextConfidence = "high" | "medium" | "low";

export interface ContextRange {
  id: string;
  path: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  relevanceScore: number;
  reason: string;
  content: string;
}

export interface EnsureIndexedInput { repositoryRoot: string; signal?: AbortSignal; }
export interface IndexStatus { status: "ready" | "updated" | "rebuilt"; index: RepositoryIndex; }
export interface RefreshFilesInput { repositoryRoot: string; paths?: string[]; signal?: AbortSignal; }
export interface RefreshResult { index: RepositoryIndex; changedPaths: string[]; metrics: IndexingMetrics; }
export interface TaskContextInput {
  task: string;
  repositoryRoot: string;
  tokenBudget?: number;
  maxFiles?: number;
  includeTests?: boolean;
  sessionId?: string;
  debug?: boolean;
  signal?: AbortSignal;
}
export interface TaskContextResult {
  sessionId: string;
  confidence: ContextConfidence;
  packedTokens: number;
  context: ContextRange[];
  debug?: {
    candidateCount: number;
    retrievalLatencyMs: number;
    exactSymbolMatches: number;
    cacheHits: number;
    fallbackUsed: boolean;
    fallbackReason?: string;
    confidenceSignals: Record<string, number | boolean>;
  };
}
export interface ExpandContextInput {
  sessionId: string;
  focus: string;
  additionalTokenBudget?: number;
  excludePaths?: string[];
  includeTests?: boolean;
  debug?: boolean;
  signal?: AbortSignal;
}
export interface SymbolSearchInput { repositoryRoot: string; query: string; symbolTypes?: IndexedSymbol["kind"][]; limit?: number; signal?: AbortSignal; }
export interface SymbolSearchResult { matches: Array<IndexedSymbol & { score: number }>; }
export interface GetSymbolInput { repositoryRoot: string; path: string; symbol: string; surroundingLines?: number; signal?: AbortSignal; }
export interface SymbolResult { symbol: IndexedSymbol; range: ContextRange; }
export interface FileRangeInput { repositoryRoot: string; path: string; startLine: number; endLine: number; signal?: AbortSignal; }
export interface FileRangeResult { path: string; startLine: number; endLine: number; content: string; truncated: boolean; }
export interface MetricsInput { sessionId: string; }
export interface RetrievalMetrics {
  sessionId: string;
  calls: number;
  uniqueFiles: number;
  packedTokens: number;
  duplicateRangesAvoided: number;
  cumulativeRetrievalLatencyMs: number;
  confidence: ContextConfidence;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export interface IndexProgress {
  phase: "scan" | "parse" | "persist";
  completed: number;
  total?: number;
  path?: string;
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
  ranker?: CandidateRanker;
  retriever?: RetrievalProvider;
  retrievalOptions?: RetrievalOptions;
  ranking?: RankingConfiguration;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  maxContextTokens: 8000,
  rawCodeFraction: 0.5,
  summaryFraction: 0.25,
  dependencyFraction: 0.15,
  testFraction: 0.1
};
