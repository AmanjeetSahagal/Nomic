import { performance } from "node:perf_hooks";
import path from "node:path";
import type { RepositoryIndex } from "../types/contracts";

export const CANDIDATE_GENERATION_MODES = [
  "bm25-files",
  "exact-symbol",
  "bm25-plus-exact-symbol",
  "symbol-bm25",
  "bm25-plus-symbol-bm25",
  "bm25-plus-path",
  "rrf-lexical"
] as const;

export type CandidateGenerationMode = typeof CANDIDATE_GENERATION_MODES[number];

export interface GeneratedCandidate {
  path: string;
  score: number;
  sources: Partial<Record<"bm25" | "exactSymbol" | "symbolBm25" | "path", number>>;
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
  averageBodyLength: number;
  averageSymbolLength: number;
}

interface CandidateSources {
  lists: Record<"bm25" | "exactSymbol" | "symbolBm25" | "path", RankedPath[]>;
  timings: Record<"bm25" | "exactSymbol" | "symbolBm25" | "path", number>;
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
  const lists = mode === "bm25-files" ? [["bm25", sources.lists.bm25] as const]
    : mode === "exact-symbol" ? [["exactSymbol", sources.lists.exactSymbol] as const]
      : mode === "bm25-plus-exact-symbol" ? [["bm25", sources.lists.bm25] as const, ["exactSymbol", sources.lists.exactSymbol] as const]
        : mode === "symbol-bm25" ? [["symbolBm25", sources.lists.symbolBm25] as const]
          : mode === "bm25-plus-symbol-bm25" ? [["bm25", sources.lists.bm25] as const, ["symbolBm25", sources.lists.symbolBm25] as const]
            : mode === "bm25-plus-path" ? [["bm25", sources.lists.bm25] as const, ["path", sources.lists.path] as const]
              : [["bm25", sources.lists.bm25] as const, ["exactSymbol", sources.lists.exactSymbol] as const, ["symbolBm25", sources.lists.symbolBm25] as const, ["path", sources.lists.path] as const];
  const fusionStarted = performance.now();
  const candidates = lists.length === 1
    ? lists[0]![1].slice(0, limit).map((entry, rank) => ({ ...entry, sources: { [lists[0]![0]]: rank + 1 } }))
    : reciprocalRankFuse(lists, limit);
  const fusionMs = performance.now() - fusionStarted;
  const sourceLatency = lists.reduce((sum, [source]) => sum + sources.timings[source], 0);
  return { candidates, latencyMs: sourceLatency + fusionMs };
}

function candidateSources(query: string, index: RepositoryIndex): CandidateSources {
  let byQuery = sourceCache.get(index);
  if (!byQuery) { byQuery = new Map(); sourceCache.set(index, byQuery); }
  const cached = byQuery.get(query);
  if (cached) return cached;
  const prepared = prepare(index);
  const timings = { bm25: 0, exactSymbol: 0, symbolBm25: 0, path: 0 };
  const timed = <T>(source: keyof typeof timings, operation: () => T): T => {
    const started = performance.now(); const result = operation(); timings[source] = performance.now() - started; return result;
  };
  const lists = {
    bm25: timed("bm25", () => rankBodyBm25(query, prepared)),
    exactSymbol: timed("exactSymbol", () => rankExactSymbols(query, index)),
    symbolBm25: timed("symbolBm25", () => rankSymbolBm25(query, prepared)),
    path: timed("path", () => rankPaths(query, index))
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
  const prepared = {
    body, symbols,
    averageBodyLength: body.reduce((sum, entry) => sum + entry.terms.length, 0) / Math.max(1, body.length),
    averageSymbolLength: symbols.reduce((sum, entry) => sum + entry.terms.length, 0) / Math.max(1, symbols.length)
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
  lists: ReadonlyArray<readonly ["bm25" | "exactSymbol" | "symbolBm25" | "path", RankedPath[]]>,
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
