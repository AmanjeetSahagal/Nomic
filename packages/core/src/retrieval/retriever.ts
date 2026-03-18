import {
  type ChunkRecord,
  type ContextCandidate,
  type EmbeddingProvider,
  type IndexEdge,
  type RepositoryIndex,
  type RetrievalAnalysis,
  type RetrievalResult,
  type TaskOverrides,
  type UserTask
} from "../types/contracts";

const RERANK_WEIGHTS = {
  structuralScore: 1.4,
  semanticScore: 1.1,
  dependencyDistance: -1.1,
  recencyScore: 0.4,
  fileImportanceScore: 0.5,
  tokenCost: -0.08
} as const;

export class HybridRetriever {
  constructor(private readonly embeddings: EmbeddingProvider = new LocalEmbeddingProvider()) {}

  async retrieve(task: UserTask, index: RepositoryIndex): Promise<RetrievalResult> {
    const analysis = analyzeTask(task.text);
    const structuralCandidates = retrieveStructuralCandidates(analysis, index);
    const semanticCandidates = await this.embeddings.search(task, index);
    const candidates = rerankCandidates(structuralCandidates, semanticCandidates, index);

    return {
      analysis,
      candidates,
      relatedTests: candidates.filter((candidate) => candidate.role === "test").map((candidate) => candidate.path),
      structuralCandidates,
      semanticCandidates,
      truncationReasons: candidates.length >= 12 ? ["Ranked candidate set truncated to the top 12 files."] : [],
      rerankWeights: { ...RERANK_WEIGHTS }
    };
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local-semantic-provider";

  async search(task: UserTask, index: RepositoryIndex): Promise<ContextCandidate[]> {
    const analysis = analyzeTask(task.text);

    return index.chunks
      .map((chunk) => scoreChunkSemantically(chunk, analysis, index))
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

function retrieveStructuralCandidates(analysis: RetrievalAnalysis, index: RepositoryIndex): ContextCandidate[] {
  const scoredFiles = index.files
    .map((file) => scoreStructuralFile(file, analysis, index))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const selected = new Map<string, ContextCandidate>();
  const adjacency = buildAdjacency(index.edges);
  const seedFiles = scoredFiles.slice(0, 5);

  for (const seed of seedFiles) {
    selected.set(seed.path, {
      ...seed,
      stage: "seed"
    });
  }

  for (const seed of seedFiles) {
    expandFromSeed(seed, selected, adjacency, index);
  }

  return [...selected.values()].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function expandFromSeed(
  seed: ContextCandidate,
  selected: Map<string, ContextCandidate>,
  adjacency: Map<string, IndexEdge[]>,
  index: RepositoryIndex
): void {
  const queue: Array<{ path: string; distance: number; trail: string[] }> = [
    { path: seed.path, distance: 0, trail: [seed.path] }
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.distance >= 2) {
      continue;
    }

    for (const edge of adjacency.get(current.path) ?? []) {
      const targetFile = index.files.find((file) => file.path === edge.to);
      if (!targetFile) {
        continue;
      }

      const nextDistance = current.distance + 1;
      const role = edge.kind === "test" || targetFile.isTest ? "test" : nextDistance === 1 ? "dependency" : "semantic-support";
      const structuralScore = Math.max(1, seed.structuralScore - nextDistance * 2 + edge.weight);
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
        recencyScore: normalizeRecency(targetFile.modifiedAtMs, index),
        fileImportanceScore: computeFileImportance(targetFile.path, targetFile.symbols.length, targetFile.isTest),
        tokenCost: estimateFileTokenCost(targetFile.size),
        chunkIds: index.chunks.filter((chunk) => chunk.filePath === targetFile.path).map((chunk) => chunk.id),
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

function scoreStructuralFile(
  file: RepositoryIndex["files"][number],
  analysis: RetrievalAnalysis,
  index: RepositoryIndex
): ContextCandidate {
  let score = 0;
  const reasons: string[] = [];
  const normalizedPath = file.path.toLowerCase();

  for (const term of analysis.queryTerms) {
    if (normalizedPath.includes(term)) {
      score += 6;
      reasons.push(`Path matches "${term}"`);
    }

    const symbolMatches = file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(term));
    if (symbolMatches.length > 0) {
      score += symbolMatches.length * 5;
      reasons.push(`Symbol matches "${term}"`);
    }
  }

  if (analysis.intent === "docs" && file.language === "markdown") {
    score += 4;
    reasons.push("Documentation matches task intent");
  }

  if (file.isTest) {
    score -= 1;
  }

  const structuralScore = Math.max(0, score);

  return {
    path: file.path,
    reason: reasons.length > 0 ? unique(reasons).join("; ") : "Graph fallback matched file metadata",
    score: structuralScore,
    source: "structural",
    role: file.isTest ? "test" : "primary",
    stage: "seed",
    dependencyDistance: 0,
    structuralScore,
    semanticScore: 0,
    recencyScore: normalizeRecency(file.modifiedAtMs, index),
    fileImportanceScore: computeFileImportance(file.path, file.symbols.length, file.isTest),
    tokenCost: estimateFileTokenCost(file.size),
    chunkIds: index.chunks.filter((chunk) => chunk.filePath === file.path).map((chunk) => chunk.id),
    expansionPath: [file.path]
  };
}

function scoreChunkSemantically(
  chunk: ChunkRecord,
  analysis: RetrievalAnalysis,
  index: RepositoryIndex
): ContextCandidate | null {
  let overlap = 0;

  for (const term of analysis.queryTerms) {
    if (stemsOverlap(chunk.text, term) || chunk.filePath.toLowerCase().includes(term)) {
      overlap += 1;
    }
  }

  if (overlap === 0) {
    return null;
  }

  const file = index.files.find((candidate) => candidate.path === chunk.filePath);
  if (!file) {
    return null;
  }

  const semanticScore = overlap * (chunk.kind === "doc" ? 4 : 5);

  return {
    path: chunk.filePath,
    reason: `Semantic overlap in ${chunk.kind} chunk ${chunk.startLine}-${chunk.endLine}`,
    score: semanticScore,
    source: "semantic",
    role: chunk.kind === "test" ? "test" : chunk.kind === "doc" ? "semantic-support" : "primary",
    stage: "semantic",
    dependencyDistance: chunk.kind === "doc" ? 2 : 1,
    structuralScore: 0,
    semanticScore,
    recencyScore: normalizeRecency(file.modifiedAtMs, index),
    fileImportanceScore: computeFileImportance(file.path, file.symbols.length, file.isTest),
    tokenCost: chunk.tokenEstimate,
    chunkIds: [chunk.id],
    expansionPath: [chunk.filePath]
  };
}

function rerankCandidates(
  structuralCandidates: ContextCandidate[],
  semanticCandidates: ContextCandidate[],
  index: RepositoryIndex
): ContextCandidate[] {
  const merged = new Map<string, ContextCandidate>();

  for (const candidate of [...structuralCandidates, ...semanticCandidates]) {
    const existing = merged.get(candidate.path);
    if (!existing) {
      merged.set(candidate.path, { ...candidate });
      continue;
    }

    existing.reason = appendReason(existing.reason, candidate.reason);
    existing.structuralScore = Math.max(existing.structuralScore, candidate.structuralScore);
    existing.semanticScore = Math.max(existing.semanticScore, candidate.semanticScore);
    existing.score = Math.max(existing.score, candidate.score);
    existing.dependencyDistance = Math.min(existing.dependencyDistance, candidate.dependencyDistance);
    existing.tokenCost = Math.min(existing.tokenCost, candidate.tokenCost);
    existing.chunkIds = unique([...existing.chunkIds, ...candidate.chunkIds]);
    existing.expansionPath = existing.expansionPath.length <= candidate.expansionPath.length ? existing.expansionPath : candidate.expansionPath;

    if (existing.source !== candidate.source) {
      existing.source = existing.structuralScore > 0 ? "structural" : candidate.source;
    }
    if (existing.role === "semantic-support" && candidate.role !== "semantic-support") {
      existing.role = candidate.role;
    }
  }

  const reranked = [...merged.values()].map((candidate) => {
    const file = index.files.find((entry) => entry.path === candidate.path);
    const structuralFloor =
      candidate.structuralScore > 0 ? candidate.structuralScore + Math.max(0, 3 - candidate.dependencyDistance) : 0;
    const score =
      structuralFloor +
      candidate.structuralScore * RERANK_WEIGHTS.structuralScore +
      candidate.semanticScore * RERANK_WEIGHTS.semanticScore +
      candidate.dependencyDistance * RERANK_WEIGHTS.dependencyDistance +
      candidate.recencyScore * RERANK_WEIGHTS.recencyScore +
      candidate.fileImportanceScore * RERANK_WEIGHTS.fileImportanceScore +
      candidate.tokenCost * RERANK_WEIGHTS.tokenCost +
      (file?.language === "markdown" ? -1 : 0);

    return {
      ...candidate,
      score
    };
  });

  return reranked
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 12);
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

  return unique(
    text
      .split(/[^a-z0-9]+/i)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length >= 3 && !stopWords.has(part))
  );
}

function normalizeRecency(modifiedAtMs: number, index: RepositoryIndex): number {
  const latest = Math.max(...index.files.map((file) => file.modifiedAtMs), modifiedAtMs);
  const delta = Math.max(0, latest - modifiedAtMs);
  return delta === 0 ? 5 : Math.max(0, 5 - delta / (1000 * 60 * 60 * 24));
}

function computeFileImportance(pathValue: string, symbolCount: number, isTest: boolean): number {
  let importance = symbolCount;

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

function appendReason(existing: string, next: string): string {
  return existing.includes(next) ? existing : `${existing}; ${next}`;
}

function stemsOverlap(value: string, term: string): boolean {
  return value.toLowerCase().includes(term) || value.toLowerCase().includes(term.replace(/ing$|ed$|s$/g, ""));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
