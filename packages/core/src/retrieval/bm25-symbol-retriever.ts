import { performance } from "node:perf_hooks";
import type {
  ChunkRecord,
  ContextCandidate,
  EmbeddingProvider,
  RepositoryIndex,
  RetrievalOptions,
  RetrievalProvider,
  RetrievalResult,
  UserTask
} from "../types/contracts";

interface PreparedDocument {
  file: RepositoryIndex["files"][number];
  chunks: ChunkRecord[];
  chunkTerms: Array<{ chunk: ChunkRecord; terms: Set<string> }>;
  length: number;
}

interface PreparedIndex {
  documents: PreparedDocument[];
  averageLength: number;
  bodyPostings: Map<string, Array<{ documentIndex: number; frequency: number }>>;
  symbolPostings: Map<string, Set<number>>;
}

const DEFAULT_OPTIONS: Required<RetrievalOptions> = {
  exactPathOverride: false,
  graphExpansion: false,
  semanticExpansion: false,
  maxCandidates: 12,
  chunksPerFile: 2
};

export class Bm25SymbolPackedRetriever implements RetrievalProvider {
  private readonly cache = new WeakMap<RepositoryIndex, PreparedIndex>();
  private readonly options: Required<RetrievalOptions>;

  constructor(options: RetrievalOptions = {}, private readonly embeddings?: EmbeddingProvider) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async retrieve(task: UserTask, index: RepositoryIndex): Promise<RetrievalResult> {
    const totalStarted = performance.now();
    const queryTerms = [...new Set(tokenize(task.text))];
    const identifierTerms = extractIdentifierTerms(task.text);
    const prepareStarted = performance.now();
    let prepared = this.cache.get(index);
    if (!prepared) {
      prepared = prepareIndex(index);
      this.cache.set(index, prepared);
    }
    const prepareMs = performance.now() - prepareStarted;
    const scoringStarted = performance.now();
    const scores = scoreDocuments(queryTerms, identifierTerms, task.text, prepared, this.options.exactPathOverride);
    const ranked = [...scores.entries()]
      .sort((left, right) => right[1] - left[1] || prepared.documents[left[0]].file.path.localeCompare(prepared.documents[right[0]].file.path))
      .slice(0, 50);
    const scoringMs = performance.now() - scoringStarted;
    const packingStarted = performance.now();
    const lexicalCandidates = ranked.map(([documentIndex, score]) => buildCandidate(prepared!.documents[documentIndex], score, queryTerms, this.options.chunksPerFile));
    const packingMs = performance.now() - packingStarted;

    let candidates = lexicalCandidates;
    let graphMs = 0;
    if (this.options.graphExpansion) {
      const started = performance.now();
      candidates = reciprocalRankFuse(candidates, expandGraph(candidates, index, queryTerms, this.options.chunksPerFile));
      graphMs = performance.now() - started;
    }

    let semanticMs = 0;
    let semanticCandidates: ContextCandidate[] = [];
    if (this.options.semanticExpansion && this.embeddings) {
      const started = performance.now();
      semanticCandidates = await this.embeddings.search(task, index);
      candidates = reciprocalRankFuse(candidates, semanticCandidates);
      semanticMs = performance.now() - started;
    }

    candidates = candidates.slice(0, this.options.maxCandidates);
    return {
      analysis: analyzeTask(task.text),
      candidates,
      relatedTests: candidates.filter((candidate) => candidate.role === "test").map((candidate) => candidate.path),
      structuralCandidates: this.options.graphExpansion ? candidates.filter((candidate) => candidate.stage === "graph") : [],
      semanticCandidates,
      truncationReasons: lexicalCandidates.length > candidates.length ? ["Ranked candidate set truncated to configured limit."] : [],
      rerankWeights: { bodyBm25: 1, exactSymbol: 120, quotedIdentifier: 200, exactPathOverride: this.options.exactPathOverride ? 1_000_000 : 0 },
      stageTimingsMs: {
        prepare: prepareMs,
        scoring: scoringMs,
        packing: packingMs,
        graph: graphMs,
        semantic: semanticMs,
        total: performance.now() - totalStarted
      }
    };
  }
}

function prepareIndex(index: RepositoryIndex): PreparedIndex {
  const chunksByFile = new Map<string, ChunkRecord[]>();
  for (const chunk of index.chunks) {
    const chunks = chunksByFile.get(chunk.filePath);
    if (chunks) chunks.push(chunk); else chunksByFile.set(chunk.filePath, [chunk]);
  }
  const bodyPostings = new Map<string, Array<{ documentIndex: number; frequency: number }>>();
  const symbolPostings = new Map<string, Set<number>>();
  const documents = index.files.map((file, documentIndex): PreparedDocument => {
    const chunks = chunksByFile.get(file.path) ?? [];
    const terms = tokenize(chunks.map((chunk) => chunk.text).join(" "));
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, frequency] of counts) {
      const postings = bodyPostings.get(term);
      const value = { documentIndex, frequency };
      if (postings) postings.push(value); else bodyPostings.set(term, [value]);
    }
    for (const term of new Set(file.symbols.flatMap((symbol) => tokenize(symbol.name)))) {
      const postings = symbolPostings.get(term);
      if (postings) postings.add(documentIndex); else symbolPostings.set(term, new Set([documentIndex]));
    }
    return { file, chunks, chunkTerms: chunks.map((chunk) => ({ chunk, terms: new Set(tokenize(chunk.text)) })), length: terms.length };
  });
  return {
    documents,
    averageLength: documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length),
    bodyPostings,
    symbolPostings
  };
}

function scoreDocuments(queryTerms: string[], identifiers: Set<string>, query: string, prepared: PreparedIndex, exactPathOverride: boolean): Map<number, number> {
  const scores = new Map<number, number>();
  for (const term of queryTerms) {
    const postings = prepared.bodyPostings.get(term) ?? [];
    const idf = Math.log(1 + (prepared.documents.length - postings.length + 0.5) / (postings.length + 0.5));
    for (const posting of postings) {
      const document = prepared.documents[posting.documentIndex];
      const score = idf * (posting.frequency * 2.2) / (posting.frequency + 1.2 * (0.25 + 0.75 * document.length / Math.max(1, prepared.averageLength)));
      scores.set(posting.documentIndex, (scores.get(posting.documentIndex) ?? 0) + score);
    }
    const symbolWeight = 120 + (identifiers.has(term) ? 200 : 0);
    for (const documentIndex of prepared.symbolPostings.get(term) ?? []) {
      scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + idf * symbolWeight);
    }
  }
  if (exactPathOverride) {
    const normalizedQuery = query.toLowerCase();
    prepared.documents.forEach((document, documentIndex) => {
      if (normalizedQuery.includes(document.file.path.toLowerCase())) scores.set(documentIndex, (scores.get(documentIndex) ?? 0) + 1_000_000);
    });
  }
  return scores;
}

function buildCandidate(document: PreparedDocument, score: number, queryTerms: string[], chunksPerFile: number): ContextCandidate {
  const selectedChunks = selectPreparedChunks(document.chunkTerms, queryTerms, chunksPerFile);
  return {
    path: document.file.path,
    reason: `BM25 with exact-symbol evidence (${score.toFixed(3)})`,
    score,
    source: "lexical",
    role: document.file.isTest ? "test" : "primary",
    stage: "seed",
    dependencyDistance: 0,
    structuralScore: 0,
    semanticScore: 0,
    lexicalScore: score,
    recencyScore: 0,
    fileImportanceScore: document.file.symbols.length,
    tokenCost: selectedChunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0),
    chunkIds: selectedChunks.map((chunk) => chunk.id),
    expansionPath: [document.file.path],
    startLine: selectedChunks[0]?.startLine,
    endLine: selectedChunks.length === 1 ? selectedChunks[0]?.endLine : undefined
  };
}

function selectChunks(chunks: ChunkRecord[], queryTerms: string[], limit: number): ChunkRecord[] {
  return chunks.map((chunk) => {
    const terms = new Set(tokenize(chunk.text));
    return { chunk, overlap: queryTerms.reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0) };
  }).sort((left, right) => right.overlap - left.overlap || left.chunk.startLine - right.chunk.startLine).slice(0, limit).map((entry) => entry.chunk);
}

function selectPreparedChunks(chunks: Array<{ chunk: ChunkRecord; terms: Set<string> }>, queryTerms: string[], limit: number): ChunkRecord[] {
  return chunks.map(({ chunk, terms }) => ({ chunk, overlap: queryTerms.reduce((score, term) => score + (terms.has(term) ? 1 : 0), 0) }))
    .sort((left, right) => right.overlap - left.overlap || left.chunk.startLine - right.chunk.startLine).slice(0, limit).map((entry) => entry.chunk);
}

function expandGraph(base: ContextCandidate[], index: RepositoryIndex, queryTerms: string[], chunksPerFile: number): ContextCandidate[] {
  const files = new Map(index.files.map((file) => [file.path, file]));
  const chunks = new Map<string, ChunkRecord[]>();
  for (const chunk of index.chunks) { const values = chunks.get(chunk.filePath); if (values) values.push(chunk); else chunks.set(chunk.filePath, [chunk]); }
  const edges = new Map<string, RepositoryIndex["edges"]>();
  for (const edge of index.edges) { const values = edges.get(edge.from); if (values) values.push(edge); else edges.set(edge.from, [edge]); }
  const candidates: ContextCandidate[] = [];
  for (const seed of base.slice(0, 5)) {
    for (const edge of (edges.get(seed.path) ?? []).sort((left, right) => right.weight - left.weight).slice(0, 8)) {
      const file = files.get(edge.to); if (!file) continue;
      const selected = selectChunks(chunks.get(file.path) ?? [], queryTerms, chunksPerFile);
      candidates.push({ ...buildCandidate({ file, chunks: selected, chunkTerms: selected.map((chunk) => ({ chunk, terms: new Set(tokenize(chunk.text)) })), length: selected.reduce((sum, chunk) => sum + tokenize(chunk.text).length, 0) }, edge.weight, queryTerms, chunksPerFile), source: "structural", role: file.isTest ? "test" : "dependency", stage: "graph", dependencyDistance: 1, expansionPath: [seed.path, file.path] });
    }
  }
  return candidates;
}

function reciprocalRankFuse(primary: ContextCandidate[], secondary: ContextCandidate[]): ContextCandidate[] {
  const values = new Map<string, ContextCandidate>();
  const scores = new Map<string, number>();
  const add = (candidate: ContextCandidate, rank: number) => {
    values.set(candidate.path, values.get(candidate.path) ?? candidate);
    scores.set(candidate.path, (scores.get(candidate.path) ?? 0) + 1 / (60 + rank));
  };
  primary.forEach((candidate, index) => add(candidate, index + 1));
  secondary.forEach((candidate, index) => add(candidate, index + 1));
  return [...values.values()].map((candidate) => ({ ...candidate, score: scores.get(candidate.path) ?? 0 })).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function analyzeTask(text: string): RetrievalResult["analysis"] {
  const normalizedTask = text.trim().toLowerCase();
  const queryTerms = [...new Set(tokenize(text).filter((term) => term.length >= 3))];
  const intent = /(fix|bug|regression|error|broken)/.test(normalizedTask) ? "bugfix"
    : /(refactor|rename|cleanup|simplify)/.test(normalizedTask) ? "refactor"
      : /(docs|documentation|readme|guide)/.test(normalizedTask) ? "docs"
        : /(add|build|implement|create|support)/.test(normalizedTask) ? "feature" : "general";
  return { normalizedTask, queryTerms, intent };
}

function tokenize(value: string): string[] { return value.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length >= 2); }
function extractIdentifierTerms(value: string): Set<string> { return new Set([...value.matchAll(/`([^`]+)`/g)].flatMap((match) => tokenize(match[1] ?? ""))); }
