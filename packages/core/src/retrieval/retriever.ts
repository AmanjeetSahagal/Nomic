import {
  type ChunkRecord,
  type CandidateRanker,
  type ContextCandidate,
  type EmbeddingProvider,
  type IndexEdge,
  type RepositoryIndex,
  type RetrievalAnalysis,
  type RetrievalResult,
  type TaskOverrides,
  type UserTask
} from "../types/contracts";
import { performance } from "node:perf_hooks";
import { HeuristicCandidateRanker } from "../ranking/ranker";

const RERANK_WEIGHTS = {
  structuralScore: 1.4,
  semanticScore: 1.1,
  dependencyDistance: -1.1,
  recencyScore: 0.4,
  fileImportanceScore: 0.5,
  tokenCost: -0.8
} as const;
const MAX_GRAPH_NEIGHBORS = 24;
const MAX_GRAPH_CANDIDATES_PER_SEED = 16;

interface RetrievalLookup {
  filesByPath: Map<string, RepositoryIndex["files"][number]>;
  chunksByFile: Map<string, ChunkRecord[]>;
  adjacency: Map<string, IndexEdge[]>;
  pathFilesByTerm: Map<string, Set<string>>;
  symbolFilesByTerm: Map<string, Map<string, { symbol: RepositoryIndex["symbols"][number]; exact: boolean }>>;
  latestModifiedAtMs: number;
}

interface CachedChunkRepresentation {
  embedding: Map<string, number>;
  terms: Set<string>;
  pathTerms: Set<string>;
}

interface CachedSemanticIndex {
  representations: Map<string, CachedChunkRepresentation>;
  postings: Map<string, Set<string>>;
  chunksById: Map<string, ChunkRecord>;
}

export class HybridRetriever {
  private readonly lookupCache = new WeakMap<RepositoryIndex, RetrievalLookup>();

  constructor(
    private readonly embeddings: EmbeddingProvider = new LocalEmbeddingProvider(),
    private readonly ranker: CandidateRanker = new HeuristicCandidateRanker()
  ) {}

  async retrieve(task: UserTask, index: RepositoryIndex): Promise<RetrievalResult> {
    const totalStarted = performance.now();
    const analysisStarted = performance.now();
    const analysis = analyzeTask(task.text);
    const analysisMs = performance.now() - analysisStarted;
    const lookupStarted = performance.now();
    let lookup = this.lookupCache.get(index);
    if (!lookup) {
      lookup = buildRetrievalLookup(index);
      this.lookupCache.set(index, lookup);
    }
    const lookupMs = performance.now() - lookupStarted;
    const structuralStarted = performance.now();
    const structuralCandidates = retrieveStructuralCandidates(analysis, index, lookup);
    const structuralMs = performance.now() - structuralStarted;
    const semanticStarted = performance.now();
    const semanticCandidates = await this.embeddings.search(task, index);
    const semanticMs = performance.now() - semanticStarted;
    const mergeStarted = performance.now();
    const mergedCandidates = rerankCandidates(structuralCandidates, semanticCandidates, lookup);
    const candidateMergeMs = performance.now() - mergeStarted;
    const rankingStarted = performance.now();
    const candidates = (await this.ranker.rank(task, mergedCandidates, index)).slice(0, 12);
    const rankingMs = performance.now() - rankingStarted;

    return {
      analysis,
      candidates,
      relatedTests: candidates.filter((candidate) => candidate.role === "test").map((candidate) => candidate.path),
      structuralCandidates,
      semanticCandidates,
      truncationReasons: candidates.length >= 12 ? ["Ranked candidate set truncated to the top 12 files."] : [],
      rerankWeights: { ...RERANK_WEIGHTS },
      stageTimingsMs: {
        analysis: analysisMs,
        lookup: lookupMs,
        structural: structuralMs,
        semantic: semanticMs,
        candidateMerge: candidateMergeMs,
        ranking: rankingMs,
        total: performance.now() - totalStarted
      }
    };
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local-vector-provider";
  private readonly embeddingCache = new WeakMap<RepositoryIndex, CachedSemanticIndex>();

  async search(task: UserTask, index: RepositoryIndex): Promise<ContextCandidate[]> {
    const analysis = analyzeTask(task.text);
    const filesByPath = new Map(index.files.map((file) => [file.path, file]));
    const queryEmbedding = buildEmbedding(analysis.queryTerms.join(" "), []);
    let cachedIndex = this.embeddingCache.get(index);
    if (!cachedIndex) {
      const representations = new Map<string, CachedChunkRepresentation>();
      const postings = new Map<string, Set<string>>();
      const chunksById = new Map<string, ChunkRecord>();
      for (const chunk of index.chunks) {
        const representation = {
          embedding: buildEmbedding(chunk.text, []),
          terms: new Set(tokenizeForEmbedding(chunk.text, [])),
          pathTerms: new Set(tokenizeForEmbedding(chunk.filePath, []))
        };
        representations.set(chunk.id, representation);
        chunksById.set(chunk.id, chunk);
        for (const term of new Set([...representation.terms, ...representation.pathTerms])) {
          const ids = postings.get(term);
          if (ids) ids.add(chunk.id); else postings.set(term, new Set([chunk.id]));
        }
      }
      cachedIndex = { representations, postings, chunksById };
      this.embeddingCache.set(index, cachedIndex);
    }
    const candidateChunkIds = new Set<string>();
    const candidateTerms = unique([...queryEmbedding.keys(), ...analysis.queryTerms])
      .filter((term) => term.length >= 3 && cachedIndex?.postings.has(term))
      .sort((left, right) => (cachedIndex?.postings.get(left)?.size ?? 0) - (cachedIndex?.postings.get(right)?.size ?? 0))
      .slice(0, 24);
    for (const term of candidateTerms) {
      for (const chunkId of cachedIndex.postings.get(term) ?? []) candidateChunkIds.add(chunkId);
    }
    const chunkScores = [...candidateChunkIds]
      .map((chunkId) => cachedIndex?.chunksById.get(chunkId))
      .filter((chunk): chunk is ChunkRecord => chunk !== undefined)
      .map((chunk) => scoreChunkEmbedding(chunk, queryEmbedding, analysis, cachedIndex?.representations.get(chunk.id)))
      .filter((entry): entry is { chunk: ChunkRecord; score: number } => entry !== null)
      .sort((left, right) => right.score - left.score || left.chunk.filePath.localeCompare(right.chunk.filePath))
      .slice(0, 16);

    const bestByFile = new Map<
      string,
      { filePath: string; score: number; chunks: ChunkRecord[]; maxChunk: ChunkRecord }
    >();

    for (const { chunk, score } of chunkScores) {
      const existing = bestByFile.get(chunk.filePath);
      if (!existing) {
        bestByFile.set(chunk.filePath, {
          filePath: chunk.filePath,
          score,
          chunks: [chunk],
          maxChunk: chunk
        });
        continue;
      }

      existing.score = Math.max(existing.score, score);
      if (existing.chunks.length < 3) {
        existing.chunks.push(chunk);
      }
      if (score >= existing.score) {
        existing.maxChunk = chunk;
      }
    }

    return [...bestByFile.values()]
      .map((entry) => buildSemanticCandidate(entry, filesByPath, index))
      .filter((candidate): candidate is ContextCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, 8);
  }
}

export function applyTaskOverrides(
  retrieval: RetrievalResult,
  index: RepositoryIndex,
  overrides?: TaskOverrides
): RetrievalResult {
  if (!overrides) {
    return retrieval;
  }

  const excludedPaths = new Set(overrides.excludedPaths);
  const pinnedPaths = overrides.pinnedPaths.filter((candidate) => !excludedPaths.has(candidate));
  const candidates = retrieval.candidates
    .filter((candidate) => !excludedPaths.has(candidate.path))
    .map((candidate) => ({ ...candidate }));
  const candidateMap = new Map(candidates.map((candidate) => [candidate.path, candidate]));

  for (const pinnedPath of pinnedPaths) {
    if (candidateMap.has(pinnedPath)) {
      const existing = candidateMap.get(pinnedPath);
      if (existing) {
        existing.reason = appendReason(existing.reason, "Pinned by user");
        existing.score = Math.max(existing.score, 1000);
        existing.source = "manual";
        existing.role = "manual";
        existing.stage = "override";
      }
      continue;
    }

    const file = index.files.find((entry) => entry.path === pinnedPath);
    if (!file) {
      continue;
    }

    const manualCandidate: ContextCandidate = {
      path: pinnedPath,
      reason: "Pinned by user",
      score: 1000,
      source: "manual",
      role: "manual",
      stage: "override",
      dependencyDistance: 0,
      structuralScore: 1000,
      semanticScore: 0,
      recencyScore: normalizeRecency(file.modifiedAtMs, index),
      fileImportanceScore: computeFileImportance(file.path, file.symbols.length, file.isTest),
      tokenCost: estimateFileTokenCost(file.size),
      chunkIds: index.chunks.filter((chunk) => chunk.filePath === pinnedPath).map((chunk) => chunk.id),
      expansionPath: [pinnedPath]
    };
    candidates.push(manualCandidate);
    candidateMap.set(pinnedPath, manualCandidate);
  }

  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  return {
    ...retrieval,
    candidates,
    relatedTests: candidates.filter((candidate) => candidate.role === "test").map((candidate) => candidate.path)
  };
}

function analyzeTask(text: string): RetrievalAnalysis {
  const normalizedTask = text.trim().toLowerCase();
  const queryTerms = extractQueryTerms(normalizedTask);
  let intent: RetrievalAnalysis["intent"] = "general";

  if (/(fix|bug|regression|error|broken)/.test(normalizedTask)) {
    intent = "bugfix";
  } else if (/(refactor|rename|cleanup|simplify)/.test(normalizedTask)) {
    intent = "refactor";
  } else if (/(docs|documentation|readme|guide)/.test(normalizedTask)) {
    intent = "docs";
  } else if (/(add|build|implement|create|support)/.test(normalizedTask)) {
    intent = "feature";
  }

  return {
    normalizedTask,
    queryTerms,
    intent
  };
}

function retrieveStructuralCandidates(
  analysis: RetrievalAnalysis,
  index: RepositoryIndex,
  lookup: RetrievalLookup
): ContextCandidate[] {
  const matches = new Map<string, { score: number; reasons: string[]; matchedSymbol?: RepositoryIndex["symbols"][number] }>();
  const getMatch = (filePath: string) => {
    const existing = matches.get(filePath);
    if (existing) return existing;
    const created: { score: number; reasons: string[]; matchedSymbol?: RepositoryIndex["symbols"][number] } = { score: 0, reasons: [] };
    matches.set(filePath, created);
    return created;
  };
  for (const term of analysis.queryTerms) {
    for (const filePath of lookup.pathFilesByTerm.get(term) ?? []) {
      const match = getMatch(filePath); match.score += 6; match.reasons.push(`Path matches "${term}"`);
    }
    for (const [filePath, symbolMatch] of lookup.symbolFilesByTerm.get(term) ?? []) {
      const match = getMatch(filePath);
      match.score += symbolMatch.exact ? 40 : 5;
      match.reasons.push(`Symbol matches "${term}"`);
      if (!match.matchedSymbol || symbolMatch.exact) match.matchedSymbol = symbolMatch.symbol;
    }
  }
  if (analysis.intent === "docs") {
    for (const file of index.files) {
      if (file.language !== "markdown") continue;
      const match = getMatch(file.path); match.score += 4; match.reasons.push("Documentation matches task intent");
    }
  }
  const seedFiles = [...matches.entries()]
    .map(([filePath, match]) => ({ file: lookup.filesByPath.get(filePath), match }))
    .filter((entry): entry is { file: RepositoryIndex["files"][number]; match: typeof entry.match } => entry.file !== undefined)
    .map((entry) => ({ ...entry, score: Math.max(0, entry.match.score - (entry.file.isTest ? 1 : 0)) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
    .slice(0, 5)
    .map((entry) => buildStructuralCandidate(entry.file, entry.match, lookup, analysis));

  const selected = new Map<string, ContextCandidate>();
  const adjacency = lookup.adjacency;

  for (const seed of seedFiles) {
    selected.set(seed.path, {
      ...seed,
      stage: "seed"
    });
  }

  for (const seed of seedFiles) {
    expandFromSeed(seed, selected, adjacency, lookup, analysis);
  }

  return [...selected.values()].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function expandFromSeed(
  seed: ContextCandidate,
  selected: Map<string, ContextCandidate>,
  adjacency: Map<string, IndexEdge[]>,
  lookup: RetrievalLookup,
  analysis: RetrievalAnalysis
): void {
  const queue: Array<{ path: string; distance: number; trail: string[] }> = [
    { path: seed.path, distance: 0, trail: [seed.path] }
  ];
  const visitedDistance = new Map<string, number>([[seed.path, 0]]);
  let expandedCandidates = 0;

  while (queue.length > 0 && expandedCandidates < MAX_GRAPH_CANDIDATES_PER_SEED) {
    const current = queue.shift();
    if (!current || current.distance >= 2) {
      continue;
    }

    const neighbors = adjacency.get(current.path) ?? [];
    for (const edge of neighbors) {
      if (expandedCandidates >= MAX_GRAPH_CANDIDATES_PER_SEED) break;
      const targetFile = lookup.filesByPath.get(edge.to);
      if (!targetFile || isLowValueGeneratedPath(targetFile.path)) {
        continue;
      }

      const nextDistance = current.distance + 1;
      const previousDistance = visitedDistance.get(targetFile.path);
      if (previousDistance !== undefined && previousDistance <= nextDistance) continue;
      visitedDistance.set(targetFile.path, nextDistance);
      expandedCandidates += 1;
      const role =
        edge.kind === "test" || targetFile.isTest ? "test" : nextDistance === 1 ? "dependency" : "semantic-support";
      const structuralScore = Math.max(1, seed.structuralScore - nextDistance * 3 + edge.weight * 0.25);
      const selectedChunks = selectRelevantChunks(lookup.chunksByFile.get(targetFile.path) ?? [], analysis.queryTerms, 2);
      const candidate: ContextCandidate = {
        path: targetFile.path,
        reason: buildEdgeReason(seed.path, edge.kind, current.path, targetFile.path),
        score: structuralScore,
        source: "structural",
        role,
        stage: "graph",
        dependencyDistance: nextDistance,
        structuralScore,
        semanticScore: 0,
        recencyScore: normalizeRecency(targetFile.modifiedAtMs, lookup.latestModifiedAtMs),
        fileImportanceScore: computeFileImportance(targetFile.path, targetFile.symbols.length, targetFile.isTest),
        tokenCost: selectedChunks.length > 0
          ? selectedChunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0)
          : estimateFileTokenCost(targetFile.size),
        chunkIds: selectedChunks.map((chunk) => chunk.id),
        expansionPath: [...current.trail, targetFile.path]
      };

      const existing = selected.get(targetFile.path);
      if (!existing || existing.score < candidate.score) {
        selected.set(targetFile.path, candidate);
      } else if (!existing.reason.includes(candidate.reason)) {
        existing.reason = appendReason(existing.reason, candidate.reason);
      }

      if (nextDistance < 2) {
        queue.push({
          path: targetFile.path,
          distance: nextDistance,
          trail: [...current.trail, targetFile.path]
        });
      }
    }
  }
}

function buildStructuralCandidate(
  file: RepositoryIndex["files"][number],
  match: { score: number; reasons: string[]; matchedSymbol?: RepositoryIndex["symbols"][number] },
  lookup: RetrievalLookup,
  analysis: RetrievalAnalysis
): ContextCandidate {
  const structuralScore = Math.max(0, match.score - (file.isTest ? 1 : 0));
  const fileChunks = lookup.chunksByFile.get(file.path) ?? [];
  const selectedChunks = match.matchedSymbol
    ? selectSymbolChunks(fileChunks, match.matchedSymbol)
    : selectRelevantChunks(fileChunks, analysis.queryTerms, 2);

  return {
    path: file.path,
    reason: match.reasons.length > 0 ? unique(match.reasons).join("; ") : "Graph fallback matched file metadata",
    score: structuralScore,
    source: "structural",
    role: file.isTest ? "test" : "primary",
    stage: "seed",
    dependencyDistance: 0,
    structuralScore,
    semanticScore: 0,
    recencyScore: normalizeRecency(file.modifiedAtMs, lookup.latestModifiedAtMs),
    fileImportanceScore: computeFileImportance(file.path, file.symbols.length, file.isTest),
    tokenCost: selectedChunks.length > 0
      ? selectedChunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0)
      : estimateFileTokenCost(file.size),
    chunkIds: selectedChunks.map((chunk) => chunk.id),
    expansionPath: [file.path],
    symbolId: match.matchedSymbol?.id,
    startLine: match.matchedSymbol?.startLine,
    endLine: match.matchedSymbol?.endLine
  };
}

function rerankCandidates(
  structuralCandidates: ContextCandidate[],
  semanticCandidates: ContextCandidate[],
  lookup: RetrievalLookup
): ContextCandidate[] {
  const merged = new Map<string, ContextCandidate>();

  for (const candidate of [...structuralCandidates, ...semanticCandidates]) {
    const existing = merged.get(candidate.path);
    if (!existing) {
      merged.set(candidate.path, { ...candidate });
      continue;
    }

    const previousScore = existing.score;
    existing.reason = appendReason(existing.reason, candidate.reason);
    existing.structuralScore = Math.max(existing.structuralScore, candidate.structuralScore);
    existing.semanticScore = Math.max(existing.semanticScore, candidate.semanticScore);
    existing.score = Math.max(previousScore, candidate.score);
    existing.dependencyDistance = Math.min(existing.dependencyDistance, candidate.dependencyDistance);
    existing.tokenCost = Math.min(existing.tokenCost, candidate.tokenCost);
    existing.chunkIds = unique([...existing.chunkIds, ...candidate.chunkIds]);
    existing.expansionPath =
      existing.expansionPath.length <= candidate.expansionPath.length ? existing.expansionPath : candidate.expansionPath;

    if (existing.source !== candidate.source) {
      existing.source = existing.structuralScore > 0 ? "structural" : candidate.source;
    }
    if (existing.role === "semantic-support" && candidate.role !== "semantic-support") {
      existing.role = candidate.role;
    }
  }

  return [...merged.values()]
    .map((candidate) => {
      const file = lookup.filesByPath.get(candidate.path);
      const structuralFloor =
        candidate.structuralScore > 0 ? candidate.structuralScore + Math.max(0, 3 - candidate.dependencyDistance) : 0;
      const score =
        structuralFloor +
        candidate.structuralScore * RERANK_WEIGHTS.structuralScore +
        candidate.semanticScore * RERANK_WEIGHTS.semanticScore +
        candidate.dependencyDistance * RERANK_WEIGHTS.dependencyDistance +
        candidate.recencyScore * RERANK_WEIGHTS.recencyScore +
        candidate.fileImportanceScore * RERANK_WEIGHTS.fileImportanceScore +
        Math.log1p(candidate.tokenCost) * RERANK_WEIGHTS.tokenCost +
        (file?.language === "markdown" ? -1 : 0);

      return {
        ...candidate,
        score
      };
    })
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 12);
}

function buildSemanticCandidate(
  entry: { filePath: string; score: number; chunks: ChunkRecord[]; maxChunk: ChunkRecord },
  filesByPath: Map<string, RepositoryIndex["files"][number]>,
  index: RepositoryIndex
): ContextCandidate | null {
  const file = filesByPath.get(entry.filePath);
  if (!file) {
    return null;
  }

  const semanticScore = entry.score * (entry.maxChunk.kind === "doc" ? 0.92 : 1);
  return {
    path: file.path,
    reason: `Semantic vector match from chunks ${entry.chunks.map((chunk) => `${chunk.startLine}-${chunk.endLine}`).join(", ")}`,
    score: semanticScore,
    source: "semantic",
    role: entry.maxChunk.kind === "test" ? "test" : entry.maxChunk.kind === "doc" ? "semantic-support" : "primary",
    stage: "semantic",
    dependencyDistance: entry.maxChunk.kind === "doc" ? 2 : 1,
    structuralScore: 0,
    semanticScore,
    recencyScore: normalizeRecency(file.modifiedAtMs, index),
    fileImportanceScore: computeFileImportance(file.path, file.symbols.length, file.isTest),
    tokenCost: Math.min(...entry.chunks.map((chunk) => chunk.tokenEstimate)),
    startLine: entry.maxChunk.startLine,
    endLine: entry.maxChunk.endLine,
    chunkIds: entry.chunks.map((chunk) => chunk.id),
    expansionPath: [file.path]
  };
}

function scoreChunkEmbedding(
  chunk: ChunkRecord,
  queryEmbedding: Map<string, number>,
  analysis: RetrievalAnalysis,
  cached?: CachedChunkRepresentation
): { chunk: ChunkRecord; score: number } | null {
  const chunkEmbedding = cached?.embedding ?? buildEmbedding(chunk.text, []);
  const cosine = cosineSimilarity(queryEmbedding, chunkEmbedding);
  const lexicalBoost = analysis.queryTerms.reduce(
    (total, term) => total + ((cached
      ? cached.terms.has(term) || cached.pathTerms.has(term)
      : chunk.text.toLowerCase().includes(term) || chunk.filePath.toLowerCase().includes(term)) ? 0.1 : 0),
    0
  );
  const score = cosine + lexicalBoost;

  if (score <= 0.18) {
    return null;
  }

  return {
    chunk,
    score
  };
}

function buildEmbedding(text: string, queryTerms: string[]): Map<string, number> {
  const tokens = tokenizeForEmbedding(text, queryTerms);
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const vector = new Map<string, number>();
  const total = tokens.length || 1;
  for (const [token, count] of counts) {
    vector.set(token, count / total);
  }

  return vector;
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const value of left.values()) {
    leftNorm += value * value;
  }
  for (const value of right.values()) {
    rightNorm += value * value;
  }
  for (const [token, value] of left) {
    dot += value * (right.get(token) ?? 0);
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function tokenizeForEmbedding(text: string, queryTerms: string[]): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

  const trigrams = queryTerms.flatMap((term) => {
    const normalized = term.toLowerCase();
    if (normalized.length < 4) {
      return [normalized];
    }

    const grams: string[] = [];
    for (let index = 0; index <= normalized.length - 3; index += 1) {
      grams.push(normalized.slice(index, index + 3));
    }
    return grams;
  });

  return [...tokens, ...trigrams];
}

function buildAdjacency(edges: IndexEdge[]): Map<string, IndexEdge[]> {
  const adjacency = new Map<string, IndexEdge[]>();

  for (const edge of edges) {
    const existing = adjacency.get(edge.from);
    if (existing) {
      existing.push(edge);
      continue;
    }

    adjacency.set(edge.from, [edge]);
  }

  for (const [filePath, neighbors] of adjacency) {
    adjacency.set(
      filePath,
      neighbors
        .sort((left, right) => right.weight - left.weight || left.to.localeCompare(right.to))
        .slice(0, MAX_GRAPH_NEIGHBORS)
    );
  }

  return adjacency;
}

function buildEdgeReason(seedPath: string, kind: IndexEdge["kind"], fromPath: string, targetPath: string): string {
  if (kind === "import") {
    return `${targetPath} imported by ${fromPath} from seed ${seedPath}`;
  }
  if (kind === "test") {
    return `${targetPath} is a related test for ${fromPath}`;
  }
  if (kind === "reference") {
    return `${targetPath} referenced by ${fromPath} from seed ${seedPath}`;
  }
  if (kind === "caller") {
    return `${targetPath} calls or is called from ${fromPath}`;
  }
  return `${targetPath} reached through ${kind} edge from ${fromPath}`;
}

function extractQueryTerms(text: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "into",
    "from",
    "your",
    "task",
    "flow",
    "file"
  ]);

  const terms = text
      .split(/[^a-z0-9]+/i)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length >= 3 && !stopWords.has(part));
  return unique(terms.flatMap((term) => [term, ...queryAliases(term)]));
}

function queryAliases(term: string): string[] {
  if (term.startsWith("authenticat") || term === "authorization") return ["auth"];
  if (term.startsWith("document")) return ["docs", "doc"];
  if (term === "tests" || term === "testing") return ["test", "spec"];
  if (term === "configuration") return ["config"];
  return [];
}

function normalizeRecency(modifiedAtMs: number, indexOrLatest: RepositoryIndex | number): number {
  const latest = typeof indexOrLatest === "number"
    ? indexOrLatest
    : Math.max(...indexOrLatest.files.map((file) => file.modifiedAtMs), modifiedAtMs);
  const delta = Math.max(0, Math.max(latest, modifiedAtMs) - modifiedAtMs);
  return delta === 0 ? 5 : Math.max(0, 5 - delta / (1000 * 60 * 60 * 24));
}

function computeFileImportance(pathValue: string, symbolCount: number, isTest: boolean): number {
  let importance = Math.log1p(symbolCount);

  if (/src\//.test(pathValue)) {
    importance += 3;
  }
  if (/docs\//.test(pathValue)) {
    importance += 1;
  }
  if (isTest) {
    importance -= 1;
  }

  return Math.max(1, importance);
}

function estimateFileTokenCost(size: number): number {
  return Math.ceil(size / 4);
}

function buildRetrievalLookup(index: RepositoryIndex): RetrievalLookup {
  const chunksByFile = new Map<string, ChunkRecord[]>();
  const pathFilesByTerm = new Map<string, Set<string>>();
  const symbolFilesByTerm = new Map<string, Map<string, { symbol: RepositoryIndex["symbols"][number]; exact: boolean }>>();
  for (const chunk of index.chunks) {
    const chunks = chunksByFile.get(chunk.filePath);
    if (chunks) chunks.push(chunk);
    else chunksByFile.set(chunk.filePath, [chunk]);
  }
  for (const file of index.files) {
    for (const term of tokenizeCodeIdentifier(file.path)) addPathTerm(pathFilesByTerm, term, file.path);
    for (const symbol of file.symbols) {
      const normalizedName = symbol.name.toLowerCase();
      for (const term of tokenizeCodeIdentifier(symbol.name)) {
        const files = symbolFilesByTerm.get(term) ?? new Map();
        const existing = files.get(file.path);
        const exact = term === normalizedName;
        if (!existing || (exact && !existing.exact)) files.set(file.path, { symbol, exact });
        symbolFilesByTerm.set(term, files);
      }
    }
  }
  return {
    filesByPath: new Map(index.files.map((file) => [file.path, file])),
    chunksByFile,
    adjacency: buildAdjacency(index.edges),
    pathFilesByTerm,
    symbolFilesByTerm,
    latestModifiedAtMs: index.files.reduce((latest, file) => Math.max(latest, file.modifiedAtMs), 0)
  };
}

function tokenizeCodeIdentifier(value: string): string[] {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const full = value.toLowerCase();
  return unique([full, ...normalized.split(/[^a-z0-9_]+/).filter((term) => term.length >= 2)]);
}

function addPathTerm(postings: Map<string, Set<string>>, term: string, filePath: string): void {
  const paths = postings.get(term);
  if (paths) paths.add(filePath); else postings.set(term, new Set([filePath]));
}

function isLowValueGeneratedPath(filePath: string): boolean {
  return /(?:^|\/)(?:vendor|vendors|third_party|node_modules)(?:\/|$)/i.test(filePath)
    || /\.min\.(?:js|css)$/i.test(filePath);
}

function selectSymbolChunks(
  chunks: ChunkRecord[],
  symbol: RepositoryIndex["symbols"][number] | undefined
): ChunkRecord[] {
  if (!symbol?.startLine || !symbol.endLine) return chunks;
  const overlapping = chunks.filter((chunk) => chunk.startLine <= symbol.endLine! && chunk.endLine >= symbol.startLine!);
  return overlapping.length > 0 ? overlapping : chunks;
}

function selectRelevantChunks(chunks: ChunkRecord[], queryTerms: string[], limit: number): ChunkRecord[] {
  return chunks
    .map((chunk) => {
      const normalizedText = chunk.text.toLowerCase();
      const normalizedPath = chunk.filePath.toLowerCase();
      const overlap = queryTerms.reduce(
        (score, term) => score + (normalizedText.includes(term) ? 2 : 0) + (normalizedPath.includes(term) ? 1 : 0),
        0
      );
      return { chunk, overlap };
    })
    .sort((left, right) => right.overlap - left.overlap || left.chunk.startLine - right.chunk.startLine)
    .slice(0, limit)
    .map((entry) => entry.chunk);
}

function appendReason(existing: string, next: string): string {
  return existing.includes(next) ? existing : `${existing}; ${next}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
