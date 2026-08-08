import { performance } from "node:perf_hooks";
import path from "node:path";
import type { RepositoryIndex } from "../types/contracts";

export const CANDIDATE_GENERATION_MODES = [
  "bm25-files",
  "title-bm25",
  "exact-symbol",
  "exact-identifier",
  "bm25-plus-exact-symbol",
  "symbol-bm25",
  "chunk-bm25",
  "bm25-plus-symbol-bm25",
  "path-lookup",
  "bm25-plus-path",
  "test-expansion",
  "structural-expansion",
  "rrf-lexical",
  "rrf-high-recall",
  "rrf-reserved-balanced"
] as const;

export type CandidateGenerationMode = typeof CANDIDATE_GENERATION_MODES[number];

export interface GeneratedCandidate {
  path: string;
  score: number;
  sources: Partial<Record<SourceName, number>>;
}

export interface CandidateGenerationResult {
  candidates: GeneratedCandidate[];
  latencyMs: number;
}

interface RankedPath { path: string; score: number }

interface PreparedDocument { path: string; terms: string[]; counts: Map<string, number> }
interface PreparedCandidateIndex {
  body: PreparedDocument[];
  symbols: PreparedDocument[];
  chunks: PreparedDocument[];
  identifierDocuments: PreparedDocument[];
  chunkPostings: Map<string, number[]>;
  identifierPostings: Map<string, number[]>;
  averageBodyLength: number;
  averageSymbolLength: number;
  averageChunkLength: number;
}

type SourceName = "bm25" | "titleBm25" | "exactSymbol" | "exactIdentifier" | "symbolBm25" | "chunkBm25" | "path" | "testExpansion" | "structuralExpansion";

interface CandidateSources {
  lists: Record<SourceName, RankedPath[]>;
  timings: Record<SourceName, number>;
}

const preparedCache = new WeakMap<RepositoryIndex, PreparedCandidateIndex>();
const sourceCache = new WeakMap<RepositoryIndex, Map<string, CandidateSources>>();

/** Experimental candidate generation only. This does not alter the production retriever. */
export function generateCandidates(
  query: string,
  index: RepositoryIndex,
  mode: CandidateGenerationMode,
  limit = 200
): CandidateGenerationResult {
  const sources = candidateSources(query, index);
  const lexicalLists = [["bm25", sources.lists.bm25], ["exactSymbol", sources.lists.exactSymbol], ["symbolBm25", sources.lists.symbolBm25], ["path", sources.lists.path]] as const;
  const highRecallLists = [
    ["bm25", sources.lists.bm25], ["titleBm25", sources.lists.titleBm25],
    ["exactSymbol", sources.lists.exactSymbol], ["exactIdentifier", sources.lists.exactIdentifier],
    ["symbolBm25", sources.lists.symbolBm25], ["chunkBm25", sources.lists.chunkBm25],
    ["path", sources.lists.path], ["testExpansion", sources.lists.testExpansion],
    ["structuralExpansion", sources.lists.structuralExpansion]
  ] as const;
  const lists = mode === "bm25-files" ? [["bm25", sources.lists.bm25] as const]
    : mode === "title-bm25" ? [["titleBm25", sources.lists.titleBm25] as const]
      : mode === "exact-symbol" ? [["exactSymbol", sources.lists.exactSymbol] as const]
        : mode === "exact-identifier" ? [["exactIdentifier", sources.lists.exactIdentifier] as const]
      : mode === "bm25-plus-exact-symbol" ? [["bm25", sources.lists.bm25] as const, ["exactSymbol", sources.lists.exactSymbol] as const]
        : mode === "symbol-bm25" ? [["symbolBm25", sources.lists.symbolBm25] as const]
          : mode === "chunk-bm25" ? [["chunkBm25", sources.lists.chunkBm25] as const]
          : mode === "bm25-plus-symbol-bm25" ? [["bm25", sources.lists.bm25] as const, ["symbolBm25", sources.lists.symbolBm25] as const]
            : mode === "path-lookup" ? [["path", sources.lists.path] as const]
              : mode === "bm25-plus-path" ? [["bm25", sources.lists.bm25] as const, ["path", sources.lists.path] as const]
              : mode === "test-expansion" ? [["testExpansion", sources.lists.testExpansion] as const]
                : mode === "structural-expansion" ? [["structuralExpansion", sources.lists.structuralExpansion] as const]
                  : mode === "rrf-lexical"
                    ? lexicalLists : highRecallLists;
  const fusionStarted = performance.now();
  const fused = lists.length === 1
    ? lists[0]![1].slice(0, limit).map((entry, rank) => ({ ...entry, sources: { [lists[0]![0]]: rank + 1 } }))
    : reciprocalRankFuse(lists, limit);
  const candidates = mode === "rrf-reserved-balanced"
    ? reserveCandidates(fused, [
      ["exactIdentifier", sources.lists.exactIdentifier, 5], ["titleBm25", sources.lists.titleBm25, 5],
      ["symbolBm25", sources.lists.symbolBm25, 3], ["bm25", sources.lists.bm25, 2]
    ], 35, limit)
    : fused;
  const fusionMs = performance.now() - fusionStarted;
  const sourceLatency = lists.reduce((sum, [source]) => sum + sources.timings[source], 0);
  return { candidates, latencyMs: sourceLatency + fusionMs };
}

function reserveCandidates(
  fused: GeneratedCandidate[],
  reservations: ReadonlyArray<readonly [SourceName, RankedPath[], number]>,
  fusedSlots: number,
  limit: number
): GeneratedCandidate[] {
  const selected = fused.slice(0, Math.min(fusedSlots, limit));
  const seen = new Set(selected.map((candidate) => candidate.path));
  for (const [source, entries, quota] of reservations) {
    let added = 0;
    for (const [position, entry] of entries.entries()) {
      if (selected.length >= limit || added >= quota) break;
      if (seen.has(entry.path)) continue;
      selected.push({ ...entry, sources: { [source]: position + 1 } });
      seen.add(entry.path); added += 1;
    }
  }
  for (const candidate of fused) {
    if (selected.length >= limit) break;
    if (seen.has(candidate.path)) continue;
    selected.push(candidate); seen.add(candidate.path);
  }
  return selected;
}

function candidateSources(query: string, index: RepositoryIndex): CandidateSources {
  let byQuery = sourceCache.get(index);
  if (!byQuery) { byQuery = new Map(); sourceCache.set(index, byQuery); }
  const cached = byQuery.get(query);
  if (cached) return cached;
  const prepared = prepare(index);
  const timings: Record<SourceName, number> = {
    bm25: 0, titleBm25: 0, exactSymbol: 0, exactIdentifier: 0, symbolBm25: 0,
    chunkBm25: 0, path: 0, testExpansion: 0, structuralExpansion: 0
  };
  const timed = <T>(source: keyof typeof timings, operation: () => T): T => {
    const started = performance.now(); const result = operation(); timings[source] = performance.now() - started; return result;
  };
  const bm25List = timed("bm25", () => rankBodyBm25(query, prepared));
  const lists = {
    bm25: bm25List,
    titleBm25: timed("titleBm25", () => rankBodyBm25(queryTitle(query), prepared)),
    exactSymbol: timed("exactSymbol", () => rankExactSymbols(query, index)),
    exactIdentifier: timed("exactIdentifier", () => rankExactIdentifiers(query, prepared)),
    symbolBm25: timed("symbolBm25", () => rankSymbolBm25(query, prepared)),
    chunkBm25: timed("chunkBm25", () => rankChunkBm25(query, prepared)),
    path: timed("path", () => rankPaths(query, index)),
    testExpansion: timed("testExpansion", () => rankTestExpansion(index, bm25List)),
    structuralExpansion: timed("structuralExpansion", () => rankStructuralExpansion(index, bm25List))
  };
  const sources = { lists, timings };
  byQuery.set(query, sources);
  return sources;
}

function prepare(index: RepositoryIndex): PreparedCandidateIndex {
  const cached = preparedCache.get(index);
  if (cached) return cached;
  const chunksByFile = new Map<string, string[]>();
  for (const chunk of index.chunks) {
    const values = chunksByFile.get(chunk.filePath);
    if (values) values.push(chunk.text); else chunksByFile.set(chunk.filePath, [chunk.text]);
  }
  const body = index.files.map((file) => document(file.path, tokenize((chunksByFile.get(file.path) ?? []).join(" "))));
  const symbols = index.files.map((file) => document(file.path, file.symbols.flatMap((symbol) => tokenizeIdentifier(symbol.qualifiedName ?? symbol.name))));
  const chunks = index.chunks.map((chunk) => document(chunk.filePath, tokenize(chunk.text)));
  const identifierDocuments = [...chunks, ...symbols];
  const prepared = {
    body, symbols, chunks, identifierDocuments,
    chunkPostings: buildPostings(chunks),
    identifierPostings: buildPostings(identifierDocuments),
    averageBodyLength: body.reduce((sum, entry) => sum + entry.terms.length, 0) / Math.max(1, body.length),
    averageSymbolLength: symbols.reduce((sum, entry) => sum + entry.terms.length, 0) / Math.max(1, symbols.length),
    averageChunkLength: chunks.reduce((sum, entry) => sum + entry.terms.length, 0) / Math.max(1, chunks.length)
  };
  preparedCache.set(index, prepared);
  return prepared;
}

function document(candidatePath: string, terms: string[]): PreparedDocument {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return { path: candidatePath, terms, counts };
}

function rankBodyBm25(query: string, prepared: PreparedCandidateIndex): RankedPath[] {
  const queryTerms = [...new Set(tokenize(query))];
  return bm25(queryTerms, prepared.body, prepared.averageBodyLength);
}

function rankExactSymbols(query: string, index: RepositoryIndex): RankedPath[] {
  const normalizedQuery = query.toLowerCase();
  const scores = new Map<string, number>();
  for (const file of index.files) {
    for (const symbol of file.symbols) {
      const normalizedName = symbol.name.toLowerCase();
      const qualified = symbol.qualifiedName?.toLowerCase();
      if (qualified && qualified.length >= 6 && containsDelimited(normalizedQuery, qualified)) {
        scores.set(file.path, (scores.get(file.path) ?? 0) + 3);
      } else if (isDistinctiveSymbol(symbol.name) && containsDelimited(normalizedQuery, normalizedName)) {
        scores.set(file.path, (scores.get(file.path) ?? 0) + 2);
      }
    }
  }
  return sorted(scores);
}

function rankSymbolBm25(query: string, prepared: PreparedCandidateIndex): RankedPath[] {
  const queryTerms = [...new Set(tokenizeIdentifier(query))];
  return bm25(queryTerms, prepared.symbols, prepared.averageSymbolLength);
}

function rankChunkBm25(query: string, prepared: PreparedCandidateIndex): RankedPath[] {
  return bm25MaxPerPath([...new Set(tokenize(query))], prepared.chunks, prepared.averageChunkLength, prepared.chunkPostings);
}

function rankExactIdentifiers(query: string, prepared: PreparedCandidateIndex): RankedPath[] {
  const identifiers = extractIdentifiers(query);
  const documentScores = new Map<number, number>();
  for (const identifier of identifiers) {
    const parts = [...new Set(tokenizeIdentifier(identifier))];
    if (!parts.length) continue;
    const postings = parts.map((term) => prepared.identifierPostings.get(term) ?? []);
    if (postings.some((values) => !values.length)) continue;
    const smallest = postings.reduce((left, right) => left.length <= right.length ? left : right);
    for (const documentIndex of smallest) {
      if (!postings.every((values) => values.includes(documentIndex))) continue;
      documentScores.set(documentIndex, (documentScores.get(documentIndex) ?? 0) + (identifier.length >= 8 ? 3 : 1));
    }
  }
  const scores = new Map<string, number>();
  for (const [documentIndex, score] of documentScores) {
    const candidatePath = prepared.identifierDocuments[documentIndex]!.path;
    scores.set(candidatePath, Math.max(scores.get(candidatePath) ?? 0, score));
  }
  return sorted(scores);
}

function rankTestExpansion(index: RepositoryIndex, bodyRanking: RankedPath[]): RankedPath[] {
  const seeds = bodyRanking.slice(0, 20);
  const files = new Map(index.files.map((file) => [file.path, file]));
  const scores = new Map<string, number>();
  for (const [position, seed] of seeds.entries()) {
    const seedFile = files.get(seed.path);
    if (!seedFile?.isTest) continue;
    const stem = normalizedTestStem(seed.path);
    for (const file of index.files) {
      if (file.isTest || normalizedTestStem(file.path) !== stem) continue;
      scores.set(file.path, Math.max(scores.get(file.path) ?? 0, 1 / (position + 1)));
    }
    for (const edge of index.edges.filter((edge) => edge.from === seed.path && (edge.kind === "import" || edge.kind === "test"))) {
      scores.set(edge.to, Math.max(scores.get(edge.to) ?? 0, edge.weight / (position + 1)));
    }
  }
  return sorted(scores).slice(0, 30);
}

function rankStructuralExpansion(index: RepositoryIndex, bodyRanking: RankedPath[]): RankedPath[] {
  const seeds = bodyRanking.slice(0, 20);
  const scores = new Map<string, number>();
  for (const [position, seed] of seeds.entries()) {
    const neighbors = index.edges.filter((edge) => edge.from === seed.path || edge.to === seed.path)
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 3);
    for (const edge of neighbors) {
      const neighbor = edge.from === seed.path ? edge.to : edge.from;
      if (neighbor === seed.path) continue;
      scores.set(neighbor, Math.max(scores.get(neighbor) ?? 0, edge.weight / (position + 1)));
    }
  }
  return sorted(scores).slice(0, 30);
}

function bm25(queryTerms: string[], documents: PreparedDocument[], averageLength: number): RankedPath[] {
  const scores = new Map<string, number>();
  for (const term of queryTerms) {
    const matches = documents.filter((document) => document.counts.has(term));
    const idf = Math.log(1 + (documents.length - matches.length + .5) / (matches.length + .5));
    for (const document of matches) {
      const frequency = document.counts.get(term)!;
      const score = idf * (frequency * 2.2) / (frequency + 1.2 * (.25 + .75 * document.terms.length / Math.max(1, averageLength)));
      scores.set(document.path, (scores.get(document.path) ?? 0) + score);
    }
  }
  return sorted(scores);
}

function bm25MaxPerPath(queryTerms: string[], documents: PreparedDocument[], averageLength: number, postings: Map<string, number[]>): RankedPath[] {
  const documentScores = new Array<number>(documents.length).fill(0);
  for (const term of queryTerms) {
    const matchingIndexes = postings.get(term) ?? [];
    const idf = Math.log(1 + (documents.length - matchingIndexes.length + .5) / (matchingIndexes.length + .5));
    for (const index of matchingIndexes) {
      const document = documents[index]!;
      const frequency = document.counts.get(term)!;
      documentScores[index] += idf * (frequency * 2.2) / (frequency + 1.2 * (.25 + .75 * document.terms.length / Math.max(1, averageLength)));
    }
  }
  const scores = new Map<string, number>();
  documents.forEach((document, index) => scores.set(document.path, Math.max(scores.get(document.path) ?? 0, documentScores[index] ?? 0)));
  for (const [candidatePath, score] of scores) if (!score) scores.delete(candidatePath);
  return sorted(scores);
}

function buildPostings(documents: PreparedDocument[]): Map<string, number[]> {
  const postings = new Map<string, number[]>();
  documents.forEach((document, index) => {
    for (const term of document.counts.keys()) {
      const values = postings.get(term);
      if (values) values.push(index); else postings.set(term, [index]);
    }
  });
  return postings;
}

function rankPaths(query: string, index: RepositoryIndex): RankedPath[] {
  const normalizedQuery = query.toLowerCase();
  const scores = new Map<string, number>();
  for (const file of index.files) {
    const filename = path.posix.basename(file.path).toLowerCase();
    const basename = path.posix.basename(file.path, path.posix.extname(file.path)).toLowerCase();
    const score = normalizedQuery.includes(file.path.toLowerCase()) ? 100
      : containsDelimited(normalizedQuery, filename) ? 50
        : basename.length >= 5 && containsDelimited(normalizedQuery, basename) ? 20 : 0;
    if (score) scores.set(file.path, score);
  }
  return sorted(scores);
}

function reciprocalRankFuse(
  lists: ReadonlyArray<readonly [SourceName, RankedPath[]]>,
  limit: number
): GeneratedCandidate[] {
  const values = new Map<string, GeneratedCandidate>();
  for (const [source, entries] of lists) {
    entries.forEach((entry, position) => {
      const rank = position + 1;
      const current = values.get(entry.path) ?? { path: entry.path, score: 0, sources: {} };
      current.score += 1 / (60 + rank);
      current.sources[source] = rank;
      values.set(entry.path, current);
    });
  }
  return [...values.values()].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, limit);
}

function queryTitle(query: string): string {
  return query.split(/\r?\n/, 1)[0] ?? query;
}

function extractIdentifiers(query: string): string[] {
  const values = new Set<string>();
  const patterns = [/`([^`]+)`/g, /\b[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)+\b/g, /\b[A-Za-z_$][\w$]*\s*\(/g, /\b(?:TS\d{3,5}|[A-Za-z_$]*[A-Z][A-Za-z0-9_$]*)\b/g];
  for (const pattern of patterns) for (const match of query.matchAll(pattern)) {
    const raw = (match[1] ?? match[0] ?? "").replace(/\s*\($/, "");
    for (const part of raw.split(/[.#]/)) if (isDistinctiveSymbol(part)) values.add(part);
  }
  return [...values];
}

function normalizedTestStem(candidatePath: string): string {
  return path.posix.basename(candidatePath, path.posix.extname(candidatePath)).replace(/(?:[._-](?:test|tests|spec))$/i, "").toLowerCase();
}

function sorted(scores: Map<string, number>): RankedPath[] {
  return [...scores].map(([candidatePath, score]) => ({ path: candidatePath, score }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length >= 2);
}

function tokenizeIdentifier(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 2);
}

function isDistinctiveSymbol(value: string): boolean {
  return value.length >= 4 && (/[A-Z_]/.test(value) || value.length >= 6);
}

function containsDelimited(haystack: string, needle: string): boolean {
  let position = haystack.indexOf(needle);
  while (position >= 0) {
    const before = position === 0 ? "" : haystack[position - 1]!;
    const afterPosition = position + needle.length;
    const after = afterPosition >= haystack.length ? "" : haystack[afterPosition]!;
    if (!/[a-z0-9_$]/.test(before) && !/[a-z0-9_$]/.test(after)) return true;
    position = haystack.indexOf(needle, position + 1);
  }
  return false;
}
