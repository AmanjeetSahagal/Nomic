import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ClaudeAdapter, CodexAdapter } from "./adapters/agent-adapters";
import { PromptCompiler } from "./compiler/prompt-compiler";
import { ContextCompressor } from "./compression/compressor";
import { FilesystemParserProvider, RepositoryIndexer } from "./indexing/indexer";
import { InMemorySessionMemory } from "./memory/session-memory";
import { NativeIndexClient, NativeLexicalProvider, NativeMirrorParserProvider } from "./native/native-client";
import { applyTaskOverrides, HybridRetriever } from "./retrieval/retriever";
import { Bm25SymbolPackedRetriever } from "./retrieval/bm25-symbol-retriever";
import { FileStorageBackend } from "./storage/index-store";
import {
  type AgentTarget,
  type AgentPayload,
  type BenchmarkReport,
  type BenchmarkTask,
  type CompiledPrompt,
  type EngineDependencies,
  type EnsureIndexedInput,
  type ExpandContextInput,
  type FileRangeInput,
  type FileRangeResult,
  type GetSymbolInput,
  type IndexRepositoryRequest,
  type IndexStatus,
  type MetricsInput,
  type RefreshFilesInput,
  type RefreshResult,
  type RepositoryIndex,
  type RetrievalMetrics,
  type RetrievalProvider,
  type SymbolResult,
  type SymbolSearchInput,
  type SymbolSearchResult,
  type TaskContextInput,
  type TaskContextResult,
  type UserTask
} from "./types/contracts";

interface ContextSessionState {
  id: string;
  repositoryRoot: string;
  task: string;
  createdAt: number;
  lastUsedAt: number;
  rangeIds: Set<string>;
  metrics: RetrievalMetrics;
}

export class NomicEngine {
  private readonly indexer: RepositoryIndexer;
  private readonly retriever: RetrievalProvider;
  private readonly compressor: ContextCompressor;
  private readonly compiler: PromptCompiler;
  private readonly contextSessions = new Map<string, ContextSessionState>();
  private readonly contextPreparedIndexes = new WeakSet<RepositoryIndex>();

  constructor(private readonly dependencies: EngineDependencies) {
    this.indexer = new RepositoryIndexer(dependencies.parser ?? new FilesystemParserProvider());
    this.retriever = dependencies.retriever ?? (process.env.NOMIC_RETRIEVAL_BACKEND === "heuristic"
      ? new HybridRetriever(dependencies.embeddings, dependencies.ranker)
      : new Bm25SymbolPackedRetriever(
        dependencies.retrievalOptions ?? {
          exactPathOverride: process.env.NOMIC_ENABLE_PATH_OVERRIDE === "1",
          graphExpansion: process.env.NOMIC_ENABLE_GRAPH_EXPANSION === "1",
          semanticExpansion: process.env.NOMIC_ENABLE_SEMANTIC_EXPANSION === "1"
        },
        dependencies.embeddings
      ));
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

  async ensureIndexed(input: EnsureIndexedInput): Promise<IndexStatus> {
    throwIfAborted(input.signal);
    const stored = await this.dependencies.storage.readIndex(input.repositoryRoot);
    if (isIndexCompatible(stored)) return { status: "ready", index: stored };
    return { status: "rebuilt", index: await this.indexRepository({ repositoryRoot: input.repositoryRoot, existingIndex: null, signal: input.signal }) };
  }

  async refreshFiles(input: RefreshFilesInput): Promise<RefreshResult> {
    throwIfAborted(input.signal);
    const normalizedRequestedPaths = input.paths?.map((candidate) => normalizeRelativePath(path.isAbsolute(candidate) ? path.relative(input.repositoryRoot, candidate) : candidate));
    const index = await this.indexRepository({
      repositoryRoot: input.repositoryRoot,
      changedPaths: normalizedRequestedPaths,
      signal: input.signal
    });
    const changedPaths = normalizedRequestedPaths ?? [
      ...index.files.filter((file) => !file.contentHash).map((file) => file.path)
    ];
    if (changedPaths.length > 0) this.invalidateSessions(input.repositoryRoot, changedPaths);
    return { index, changedPaths, metrics: index.metrics };
  }

  async getTaskContext(input: TaskContextInput): Promise<TaskContextResult> {
    const startedAt = performance.now();
    throwIfAborted(input.signal);
    const { index } = await this.ensureIndexed(input);
    const cacheHit = this.contextPreparedIndexes.has(index);
    const retrieval = await this.retriever.retrieve({ text: input.task, target: "codex", repositoryRoot: input.repositoryRoot }, index);
    this.contextPreparedIndexes.add(index);
    throwIfAborted(input.signal);
    const candidates = retrieval.candidates
      .filter((candidate) => input.includeTests !== false || candidate.role !== "test")
      .slice(0, Math.max(1, Math.min(50, input.maxFiles ?? 10)));
    const packed = packCandidateRanges(index, candidates, Math.max(100, input.tokenBudget ?? 6000));
    const taskLower = input.task.toLowerCase();
    const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
    const exactSymbolMatches = index.symbols.filter((symbol) => candidatePaths.has(symbol.path) && taskLower.includes(symbol.name.toLowerCase())).length;
    const fallbackUsed = process.env.NOMIC_INDEX_BACKEND === "native" && !NativeIndexClient.diagnostics().available;
    const confidenceSignals = computeConfidenceSignals(candidates, index, input.task);
    const confidence = confidenceSignals.exactSymbolMatch || confidenceSignals.topMargin >= 0.35
      ? "high" : candidates.length > 0 && confidenceSignals.implementationCandidates > 0 ? "medium" : "low";
    const session = this.getOrCreateSession(input.sessionId, input.repositoryRoot, input.task, confidence);
    let duplicates = 0;
    const context = packed.ranges.filter((range) => {
      if (session.rangeIds.has(range.id)) { duplicates += 1; return false; }
      session.rangeIds.add(range.id);
      return true;
    });
    const elapsed = performance.now() - startedAt;
    session.lastUsedAt = Date.now();
    session.metrics.calls += 1;
    session.metrics.packedTokens += packed.tokens;
    session.metrics.duplicateRangesAvoided += duplicates;
    session.metrics.cumulativeRetrievalLatencyMs += elapsed;
    session.metrics.uniqueFiles = new Set([...session.rangeIds].map((id) => id.split(":", 1)[0])).size;
    session.metrics.confidence = confidence;
    session.metrics.fallbackUsed ||= fallbackUsed;
    this.evictSessions();
    return {
      sessionId: session.id,
      confidence,
      packedTokens: packed.tokens,
      context,
      ...(input.debug ? { debug: {
        candidateCount: retrieval.candidates.length,
        retrievalLatencyMs: elapsed,
        exactSymbolMatches,
        cacheHits: cacheHit ? 1 : 0,
        fallbackUsed,
        confidenceSignals
      } } : {})
    };
  }

  async expandContext(input: ExpandContextInput): Promise<TaskContextResult> {
    const session = this.contextSessions.get(input.sessionId);
    if (!session || Date.now() - session.lastUsedAt > 30 * 60_000) throw new Error("STALE_SESSION: The context session is missing or expired.");
    const result = await this.getTaskContext({
      task: `${session.task}\nFocus: ${input.focus}`,
      repositoryRoot: session.repositoryRoot,
      tokenBudget: input.additionalTokenBudget ?? 3000,
      maxFiles: 20,
      includeTests: input.includeTests,
      sessionId: session.id,
      debug: input.debug,
      signal: input.signal
    });
    const excluded = new Set(input.excludePaths ?? []);
    const context = result.context.filter((range) => !excluded.has(range.path));
    for (const range of result.context) if (excluded.has(range.path)) session.rangeIds.delete(range.id);
    const packedTokens = context.reduce((total, range) => total + Math.ceil(range.content.length / 4), 0);
    session.metrics.packedTokens = Math.max(0, session.metrics.packedTokens - (result.packedTokens - packedTokens));
    return { ...result, packedTokens, context };
  }

  async searchSymbols(input: SymbolSearchInput): Promise<SymbolSearchResult> {
    throwIfAborted(input.signal);
    const { index } = await this.ensureIndexed(input);
    const query = input.query.toLowerCase();
    const allowed = input.symbolTypes ? new Set(input.symbolTypes) : undefined;
    const matches = index.symbols.flatMap((symbol) => {
      if (allowed && !allowed.has(symbol.kind)) return [];
      const name = symbol.name.toLowerCase();
      const qualified = symbol.qualifiedName?.toLowerCase() ?? "";
      const score = name === query ? 3 : name.startsWith(query) ? 2 : name.includes(query) || qualified.includes(query) ? 1 : 0;
      return score ? [{ ...symbol, score }] : [];
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, Math.max(1, Math.min(100, input.limit ?? 20)));
    return { matches };
  }

  async getSymbol(input: GetSymbolInput): Promise<SymbolResult> {
    const { index } = await this.ensureIndexed(input);
    const normalizedPath = normalizeRelativePath(input.path);
    const symbol = index.symbols.find((candidate) => candidate.path === normalizedPath && (candidate.name === input.symbol || candidate.qualifiedName === input.symbol));
    if (!symbol?.startLine || !symbol.endLine) throw new Error(`SYMBOL_NOT_FOUND: ${input.symbol}`);
    const surrounding = Math.max(0, Math.min(50, input.surroundingLines ?? 10));
    const fileRange = await this.getFileRange({ ...input, path: normalizedPath, startLine: Math.max(1, symbol.startLine - surrounding), endLine: symbol.endLine + surrounding });
    return { symbol, range: { id: `${normalizedPath}:${fileRange.startLine}-${fileRange.endLine}`, path: normalizedPath, symbol: symbol.qualifiedName ?? symbol.name, startLine: fileRange.startLine, endLine: fileRange.endLine, relevanceScore: 1, reason: `Exact symbol ${symbol.name}`, content: fileRange.content } };
  }

  async getFileRange(input: FileRangeInput): Promise<FileRangeResult> {
    throwIfAborted(input.signal);
    if (input.startLine < 1 || input.endLine < input.startLine) throw new Error("INVALID_LINE_RANGE: Line range is invalid.");
    const requestedEnd = Math.min(input.endLine, input.startLine + 499);
    const { relativePath, content } = await secureReadTextFile(input.repositoryRoot, input.path);
    const lines = content.split(/\r?\n/);
    const endLine = Math.min(requestedEnd, lines.length);
    return { path: relativePath, startLine: input.startLine, endLine, content: lines.slice(input.startLine - 1, endLine).join("\n"), truncated: requestedEnd < input.endLine || endLine < input.endLine };
  }

  async getRetrievalMetrics(input: MetricsInput): Promise<RetrievalMetrics> {
    const session = this.contextSessions.get(input.sessionId);
    if (!session) throw new Error("STALE_SESSION: The context session is missing or expired.");
    return { ...session.metrics };
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
    retrievalBackend: "bm25-symbol-packed" | "heuristic-experimental";
  }> {
    const nativeDiagnostics = NativeIndexClient.diagnostics();
    const backend = process.env.NOMIC_INDEX_BACKEND === "native" && nativeDiagnostics.available ? "native" : "typescript";
    const index = await this.dependencies.storage.readIndex(repositoryRoot);
    if (!index) {
      return { hasIndex: false, backend, nativeAddonPath: nativeDiagnostics.addonPath, retrievalBackend: process.env.NOMIC_RETRIEVAL_BACKEND === "heuristic" ? "heuristic-experimental" : "bm25-symbol-packed" };
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
      nativeAddonPath: nativeDiagnostics.addonPath,
      retrievalBackend: process.env.NOMIC_RETRIEVAL_BACKEND === "heuristic" ? "heuristic-experimental" : "bm25-symbol-packed"
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

  private getOrCreateSession(id: string | undefined, repositoryRoot: string, task: string, confidence: TaskContextResult["confidence"]): ContextSessionState {
    const existing = id ? this.contextSessions.get(id) : undefined;
    if (existing && existing.repositoryRoot === repositoryRoot) return existing;
    const sessionId = randomUUID();
    const session: ContextSessionState = {
      id: sessionId,
      repositoryRoot,
      task,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      rangeIds: new Set(),
      metrics: { sessionId, calls: 0, uniqueFiles: 0, packedTokens: 0, duplicateRangesAvoided: 0, cumulativeRetrievalLatencyMs: 0, confidence, fallbackUsed: false }
    };
    this.contextSessions.set(sessionId, session);
    return session;
  }

  private invalidateSessions(repositoryRoot: string, changedPaths: string[]): void {
    const changed = new Set(changedPaths.map(normalizeRelativePath));
    for (const [id, session] of this.contextSessions) {
      if (session.repositoryRoot === repositoryRoot && [...session.rangeIds].some((rangeId) => changed.has(rangeId.slice(0, rangeId.lastIndexOf(":"))))) {
        this.contextSessions.delete(id);
      }
    }
  }

  private evictSessions(): void {
    const expiry = Date.now() - 30 * 60_000;
    for (const [id, session] of this.contextSessions) if (session.lastUsedAt < expiry) this.contextSessions.delete(id);
    if (this.contextSessions.size <= 100) return;
    const oldest = [...this.contextSessions.values()].sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const session of oldest.slice(0, this.contextSessions.size - 100)) this.contextSessions.delete(session.id);
  }
}

export function createNomicEngine(overrides: Partial<EngineDependencies> = {}): NomicEngine {
  const nativeBackend = !overrides.parser && !overrides.embeddings && process.env.NOMIC_INDEX_BACKEND === "native";
  let nativeClient: NativeIndexClient | undefined;
  if (nativeBackend) {
    try {
      nativeClient = NativeIndexClient.load();
    } catch (error: unknown) {
      if (process.env.NOMIC_STRICT_NATIVE === "1") throw error;
      process.stderr.write(`${JSON.stringify({ level: "warn", event: "native_fallback", message: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  const parser = overrides.parser ?? (nativeClient
    ? new NativeMirrorParserProvider(nativeClient, new FilesystemParserProvider())
    : undefined);
  const embeddings = overrides.embeddings ?? (nativeClient ? new NativeLexicalProvider(nativeClient) : undefined);
  return new NomicEngine({
    storage: overrides.storage ?? new FileStorageBackend(),
    memory: overrides.memory ?? new InMemorySessionMemory(),
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
    tokenEstimator: overrides.tokenEstimator,
    ranker: overrides.ranker,
    retriever: overrides.retriever,
    retrievalOptions: overrides.retrievalOptions
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
  const configuredBackend = process.env.NOMIC_INDEX_BACKEND === "native" && NativeIndexClient.diagnostics().available ? "native" : "typescript";
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

function packCandidateRanges(index: RepositoryIndex, candidates: import("./types/contracts").ContextCandidate[], tokenBudget: number): { ranges: import("./types/contracts").ContextRange[]; tokens: number } {
  const chunks = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
  const files = new Map(index.files.map((file) => [file.path, file]));
  const ranges: import("./types/contracts").ContextRange[] = [];
  let tokens = 0;
  for (const candidate of candidates) {
    for (const id of candidate.chunkIds) {
      const chunk = chunks.get(id);
      if (!chunk || tokens + chunk.tokenEstimate > tokenBudget) continue;
      const symbol = files.get(candidate.path)?.symbols.find((entry) => entry.startLine !== undefined && entry.endLine !== undefined && entry.startLine <= chunk.startLine && entry.endLine >= chunk.endLine);
      ranges.push({ id: `${candidate.path}:${chunk.startLine}-${chunk.endLine}`, path: candidate.path, symbol: symbol?.qualifiedName ?? symbol?.name, startLine: chunk.startLine, endLine: chunk.endLine, relevanceScore: candidate.score, reason: candidate.reason, content: chunk.text });
      tokens += chunk.tokenEstimate;
    }
  }
  return { ranges, tokens };
}

function computeConfidenceSignals(candidates: import("./types/contracts").ContextCandidate[], index: RepositoryIndex, task: string): { exactSymbolMatch: boolean; topMargin: number; implementationCandidates: number } {
  const taskLower = task.toLowerCase();
  const exactSymbolMatch = index.symbols.some((symbol) => taskLower.includes(symbol.name.toLowerCase()) && candidates.some((candidate) => candidate.path === symbol.path));
  const top = candidates[0]?.score ?? 0;
  const second = candidates[1]?.score ?? 0;
  return { exactSymbolMatch, topMargin: top <= 0 ? 0 : (top - second) / top, implementationCandidates: candidates.filter((candidate) => candidate.role === "primary").length };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("REQUEST_CANCELLED: Request was cancelled.");
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

async function secureReadTextFile(repositoryRoot: string, requestedPath: string): Promise<{ relativePath: string; content: string }> {
  const root = await realpath(repositoryRoot);
  if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes("..")) throw new Error("PATH_OUTSIDE_REPOSITORY: Invalid relative path.");
  const relativePath = normalizeRelativePath(requestedPath);
  if (isSecretPath(relativePath) || isInternallyBlockedPath(relativePath) || await isGitIgnored(root, relativePath)) throw new Error("UNSUPPORTED_FILE: The file is ignored or blocked.");
  const absolute = await realpath(path.join(root, relativePath));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error("PATH_OUTSIDE_REPOSITORY: Path escapes repository root.");
  const fileStats = await stat(absolute);
  if (!fileStats.isFile() || fileStats.size > 1_000_000) throw new Error("UNSUPPORTED_FILE: File is not a supported regular text file.");
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) throw new Error("UNSUPPORTED_FILE: Binary files are blocked.");
  return { relativePath, content: buffer.toString("utf8") };
}

function isInternallyBlockedPath(relativePath: string): boolean {
  return relativePath.toLowerCase().split("/").some((part) => [".git", ".nomic", "node_modules"].includes(part));
}

async function isGitIgnored(repositoryRoot: string, relativePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repositoryRoot, "check-ignore", "-q", "--", relativePath], (error) => {
      if (!error) return resolve(true);
      resolve(false);
    });
  });
}

function isSecretPath(relativePath: string): boolean {
  const parts = relativePath.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return name === ".env" || name.startsWith(".env.") || /(^|\.)((pem|key|p12|pfx))$/.test(name) || parts.some((part) => [".ssh", ".aws", ".azure", ".gcloud"].includes(part)) || /(credential|credentials|secrets?)\.(json|ya?ml|toml|ini)$/.test(name);
}
