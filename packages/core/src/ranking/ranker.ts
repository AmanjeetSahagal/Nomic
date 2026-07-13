import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CandidateRanker,
  type ContextCandidate,
  type RankingFeatures,
  type RankingMode,
  type RepositoryIndex,
  type UserTask
} from "../types/contracts";

export const RANKING_FEATURE_VERSION = "ranking-features-v1";
export const RANKING_FEATURE_NAMES = [
  "bm25Score", "normalizedBm25Score", "bm25Rank", "topScoreMargin",
  "exactSymbolMatch", "prefixSymbolMatch", "symbolTokenOverlap", "matchingSymbolCount", "symbolTypeId",
  "filenameOverlap", "pathTokenOverlap", "directoryDepth", "fileExtensionId",
  "isImplementationFile", "isTestFile", "isDocumentationFile", "isGeneratedFile",
  "queryTermCoverage", "rareTermMatchCount", "identifierOverlap", "commentOverlap",
  "chunkTokenCount", "symbolLineCount", "codeToCommentRatio",
  "repositoryLanguageId", "repositoryFileCountBucket",
  "inboundDependencyCount", "dependencyDistance"
] as const satisfies readonly (keyof RankingFeatures)[];

export interface RankingModelMetadata {
  model_version: string;
  model_type: "logistic" | "lightgbm" | "pairwise-mlp";
  feature_schema_version: string;
  feature_count: number;
  model_sha256: string;
  normalization: { mean: number[]; scale: number[] };
  safety?: { mode: "direct" | "symbol-bonus" | "rank-floor"; symbolBonus?: number; rankFloor?: number };
  [key: string]: unknown;
}

export interface LearnedRankerOptions {
  mode: Exclude<RankingMode, "baseline">;
  modelPath: string;
  metadataPath?: string;
  timeoutMs?: number;
  fallback?: "baseline";
}

export class HeuristicCandidateRanker implements CandidateRanker {
  readonly name = "heuristic-fallback";
  readonly featureVersion = RANKING_FEATURE_VERSION;
  readonly modelVersion = "heuristic-v1";

  async rank(task: UserTask, candidates: ContextCandidate[], index: RepositoryIndex): Promise<ContextCandidate[]> {
    const features = extractRankingFeatureBatch(task, candidates, index);
    return candidates.map((candidate, position) => {
      const row = features[position]!;
      const score = candidate.score + row.exactSymbolMatch * 5 + row.pathTokenOverlap * 4;
      return { ...candidate, rankerScore: score, featureVersion: this.featureVersion, modelVersion: this.modelVersion, score };
    }).sort(stableCandidateOrder);
  }
}

/** Experimental ONNX ranker. It is never constructed by the default pipeline. */
export class OnnxCandidateRanker implements CandidateRanker {
  readonly name: string;
  readonly featureVersion = RANKING_FEATURE_VERSION;
  readonly modelVersion?: string;
  private metadata?: RankingModelMetadata;
  private session?: { run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number>; dims: readonly number[] }>> };

  constructor(private readonly options: LearnedRankerOptions) {
    this.name = `${options.mode}-onnx`;
  }

  async rank(task: UserTask, candidates: ContextCandidate[], index: RepositoryIndex): Promise<ContextCandidate[]> {
    if (candidates.length === 0) throw new Error("empty-candidate-set");
    await this.load();
    const metadata = this.metadata!;
    const featureRows = extractRankingFeatureBatch(task, candidates, index);
    const exactSymbolPaths = new Set(candidates.filter((_candidate, index) => featureRows[index]?.exactSymbolMatch === 1).map((candidate) => candidate.path));
    const batch = featureRows.map((row) => normalizeFeatureVector(featureVector(row), metadata));
    const runtime = await loadOnnxRuntime();
    const tensor = new runtime.Tensor("float32", Float32Array.from(batch.flat()), [batch.length, RANKING_FEATURE_NAMES.length]);
    const outputs = await this.session!.run({ features: tensor });
    const output = outputs.scores ?? outputs.score ?? Object.values(outputs)[0];
    const scores = output ? Array.from(output.data) : [];
    if (scores.length !== candidates.length || scores.some((score) => !Number.isFinite(score))) throw new Error("invalid-model-output");
    let ranked: ContextCandidate[] = candidates.map((candidate, position) => ({
      ...candidate,
      score: scores[position]!, rankerScore: scores[position], featureVersion: this.featureVersion,
      modelVersion: metadata.model_version, reason: `${candidate.reason}; experimental ${this.options.mode} rerank`
    })).sort(stableCandidateOrder);
    ranked = applySymbolSafety(ranked, exactSymbolPaths, metadata.safety);
    return ranked;
  }

  private async load(): Promise<void> {
    if (this.session) return;
    const metadataPath = this.options.metadataPath ?? `${this.options.modelPath}.metadata.json`;
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as RankingModelMetadata;
    validateModelMetadata(metadata, this.options.mode);
    const model = await readFile(this.options.modelPath);
    if (createHash("sha256").update(model).digest("hex") !== metadata.model_sha256) throw new Error("model-checksum-mismatch");
    const runtime = await loadOnnxRuntime();
    this.session = await runtime.InferenceSession.create(this.options.modelPath);
    this.metadata = metadata;
  }
}

export class ResilientCandidateRanker implements CandidateRanker {
  readonly name: string;
  readonly featureVersion: string;
  readonly modelVersion?: string;
  lastFallbackReason?: string;

  constructor(private readonly primary: CandidateRanker, private readonly fallback?: CandidateRanker, private readonly timeoutMs = 20) {
    this.name = `${primary.name}-with-fallback`;
    this.featureVersion = primary.featureVersion;
    this.modelVersion = primary.modelVersion;
  }

  async rank(task: UserTask, candidates: ContextCandidate[], index: RepositoryIndex): Promise<ContextCandidate[]> {
    try {
      if (this.primary.featureVersion !== RANKING_FEATURE_VERSION) throw new Error("feature-schema-incompatible");
      const ranked = await withTimeout(this.primary.rank(task, candidates, index), this.timeoutMs);
      this.lastFallbackReason = undefined;
      return ranked;
    } catch (error: unknown) {
      this.lastFallbackReason = error instanceof Error ? error.message : String(error);
      // No fallback ranker means preserve the input byte-for-byte: the frozen baseline.
      return this.fallback ? this.fallback.rank(task, candidates, index) : candidates;
    }
  }
}

export function createExperimentalRanker(options: LearnedRankerOptions): ResilientCandidateRanker {
  return new ResilientCandidateRanker(new OnnxCandidateRanker(options), undefined, options.timeoutMs ?? 20);
}

export function extractRankingFeatureBatch(task: UserTask, candidates: ContextCandidate[], index: RepositoryIndex): RankingFeatures[] {
  const queryTerms = tokenize(task.text);
  const identifiers = new Set(extractIdentifiers(task.text));
  const topScore = Math.max(0, ...candidates.map((candidate) => candidate.lexicalScore ?? candidate.score));
  const secondScore = [...candidates.map((candidate) => candidate.lexicalScore ?? candidate.score)].sort((a, b) => b - a)[1] ?? 0;
  const inbound = new Map<string, number>();
  for (const edge of index.edges) inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  return candidates.map((candidate, position) => extractRankingFeatures(task, candidate, index, {
    rank: position + 1, topScore, topScoreMargin: topScore - secondScore, queryTerms, identifiers, inbound
  }));
}

export function extractRankingFeatures(
  task: UserTask,
  candidate: ContextCandidate,
  index: RepositoryIndex,
  context?: { rank: number; topScore: number; topScoreMargin: number; queryTerms: string[]; identifiers: Set<string>; inbound: Map<string, number> }
): RankingFeatures {
  const queryTerms = context?.queryTerms ?? tokenize(task.text);
  const identifiers = context?.identifiers ?? new Set(extractIdentifiers(task.text));
  const file = index.files.find((entry) => entry.path === candidate.path);
  const chunks = index.chunks.filter((chunk) => candidate.chunkIds.includes(chunk.id));
  const symbols = file?.symbols ?? [];
  const symbolTokens = symbols.flatMap((symbol) => tokenize(symbol.name));
  const exact = symbols.filter((symbol) => includesIdentifier(task.text, symbol.name));
  const prefix = symbols.filter((symbol) => queryTerms.some((term) => symbol.name.toLowerCase().startsWith(term))).length;
  const pathTokens = tokenize(candidate.path);
  const filename = path.posix.basename(candidate.path, path.posix.extname(candidate.path));
  const extension = path.posix.extname(candidate.path).toLowerCase();
  const content = chunks.map((chunk) => chunk.text).join("\n");
  const commentLines = content.split(/\r?\n/).filter((line) => /^\s*(\/\/|#|\/\*|\*)/.test(line));
  const codeLines = Math.max(0, content.split(/\r?\n/).length - commentLines.length);
  const language = file?.language ?? (extension.slice(1) || "unknown");
  const bm25Score = candidate.lexicalScore ?? candidate.score;
  return {
    bm25Score,
    normalizedBm25Score: bm25Score / Math.max(1e-9, context?.topScore ?? bm25Score),
    bm25Rank: context?.rank ?? 1,
    topScoreMargin: context?.topScoreMargin ?? 0,
    exactSymbolMatch: exact.length ? 1 : 0,
    prefixSymbolMatch: prefix ? 1 : 0,
    symbolTokenOverlap: overlap(queryTerms, symbolTokens),
    matchingSymbolCount: exact.length,
    symbolTypeId: stableCategory(exact[0]?.kind ?? symbols[0]?.kind ?? "unknown", 17),
    filenameOverlap: overlap(queryTerms, tokenize(filename)),
    pathTokenOverlap: overlap(queryTerms, pathTokens),
    directoryDepth: Math.max(0, candidate.path.split("/").length - 1),
    fileExtensionId: stableCategory(extension || "none", 127),
    isImplementationFile: file?.isTest || isDocumentation(extension) ? 0 : 1,
    isTestFile: file?.isTest ? 1 : 0,
    isDocumentationFile: isDocumentation(extension) ? 1 : 0,
    isGeneratedFile: /(generated|vendor|dist|build|\.min\.)/i.test(candidate.path) ? 1 : 0,
    queryTermCoverage: overlap(queryTerms, tokenize(content)),
    rareTermMatchCount: new Set(queryTerms.filter((term) => term.length >= 8 && content.toLowerCase().includes(term))).size,
    identifierOverlap: overlap([...identifiers], [...symbolTokens, ...pathTokens]),
    commentOverlap: overlap(queryTerms, tokenize(commentLines.join(" "))),
    chunkTokenCount: candidate.tokenCost,
    symbolLineCount: exact.reduce((sum, symbol) => sum + Math.max(0, (symbol.endLine ?? 0) - (symbol.startLine ?? 0) + 1), 0),
    codeToCommentRatio: codeLines / Math.max(1, commentLines.length),
    repositoryLanguageId: stableCategory(language, 127),
    repositoryFileCountBucket: Math.min(10, Math.floor(Math.log2(Math.max(1, index.fileCount)))),
    inboundDependencyCount: context?.inbound.get(candidate.path) ?? index.edges.filter((edge) => edge.to === candidate.path).length,
    dependencyDistance: candidate.dependencyDistance
  };
}

export function featureVector(features: RankingFeatures): number[] { return RANKING_FEATURE_NAMES.map((name) => features[name]); }

export function validateModelMetadata(metadata: RankingModelMetadata, expectedMode?: Exclude<RankingMode, "baseline">): void {
  if (metadata.feature_schema_version !== RANKING_FEATURE_VERSION) throw new Error("feature-schema-incompatible");
  if (metadata.feature_count !== RANKING_FEATURE_NAMES.length) throw new Error("feature-count-incompatible");
  if (!metadata.model_version || !metadata.model_sha256) throw new Error("model-metadata-incomplete");
  const expectedType = expectedMode === "neural" ? "pairwise-mlp" : expectedMode;
  if (expectedType && metadata.model_type !== expectedType) throw new Error("model-type-incompatible");
  if (metadata.normalization.mean.length !== RANKING_FEATURE_NAMES.length || metadata.normalization.scale.length !== RANKING_FEATURE_NAMES.length) throw new Error("normalization-incompatible");
}

function normalizeFeatureVector(values: number[], metadata: RankingModelMetadata): number[] {
  return values.map((value, index) => (value - metadata.normalization.mean[index]!) / Math.max(1e-12, metadata.normalization.scale[index]!));
}

function applySymbolSafety(candidates: ContextCandidate[], exactByPath: Set<string>, safety: RankingModelMetadata["safety"]): ContextCandidate[] {
  if (!safety || safety.mode === "direct") return candidates;
  if (safety.mode === "symbol-bonus") return candidates.map((candidate) => ({ ...candidate, score: candidate.score + (exactByPath.has(candidate.path) ? safety.symbolBonus ?? 0 : 0) })).sort(stableCandidateOrder);
  const matches = candidates.filter((candidate) => exactByPath.has(candidate.path));
  const others = candidates.filter((candidate) => !exactByPath.has(candidate.path));
  const floor = Math.max(1, safety.rankFloor ?? 5);
  return [...others.slice(0, Math.max(0, floor - matches.length)), ...matches, ...others.slice(Math.max(0, floor - matches.length))];
}

async function loadOnnxRuntime(): Promise<{ Tensor: new(type: string, data: Float32Array, dims: number[]) => unknown; InferenceSession: { create(modelPath: string): Promise<OnnxCandidateRanker["session"]> } }> {
  const packageName = "onnxruntime-node";
  try { return await import(packageName) as never; }
  catch { throw new Error("onnx-runtime-unavailable"); }
}

function extractIdentifiers(value: string): string[] { return tokenize(value).filter((term) => /[_A-Z]/.test(term) || term.length >= 4); }
function includesIdentifier(query: string, symbol: string): boolean { return tokenize(query).includes(symbol.toLowerCase()) || query.toLowerCase().includes(symbol.toLowerCase()); }
function tokenize(value: string): string[] { return value.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length >= 2); }
function overlap(left: string[], right: string[]): number { const values = new Set(right); const unique = [...new Set(left)]; return unique.length ? unique.filter((term) => values.has(term)).length / unique.length : 0; }
function stableCategory(value: string, modulo: number): number { let hash = 2166136261; for (const character of value.toLowerCase()) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619); return (hash >>> 0) % modulo; }
function isDocumentation(extension: string): boolean { return [".md", ".mdx", ".rst", ".txt", ".adoc"].includes(extension); }
function stableCandidateOrder(left: ContextCandidate, right: ContextCandidate): number { return right.score - left.score || left.path.localeCompare(right.path); }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("ranker-timeout")), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
