import {
  type CandidateRanker,
  type ContextCandidate,
  type RankingFeatures,
  type RepositoryIndex,
  type UserTask
} from "../types/contracts";

export const RANKING_FEATURE_VERSION = "nomic-ranking-v1";

export class HeuristicCandidateRanker implements CandidateRanker {
  readonly name = "heuristic-fallback";
  readonly featureVersion = RANKING_FEATURE_VERSION;
  readonly modelVersion = "heuristic-v1";

  async rank(
    task: UserTask,
    candidates: ContextCandidate[],
    index: RepositoryIndex
  ): Promise<ContextCandidate[]> {
    return candidates
      .map((candidate) => {
        const features = extractRankingFeatures(task, candidate, index);
        const rankerScore = candidate.score + scoreFeatureBoost(features);
        return {
          ...candidate,
          lexicalScore: features.lexicalScore,
          graphFeatures: {
            dependencyDistance: features.dependencyDistance,
            inboundDependencies: features.inboundDependencies
          },
          rankerScore,
          featureVersion: this.featureVersion,
          modelVersion: this.modelVersion,
          score: rankerScore
        };
      })
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  }
}

export class ResilientCandidateRanker implements CandidateRanker {
  readonly name: string;
  readonly featureVersion: string;
  readonly modelVersion?: string;

  constructor(
    private readonly primary: CandidateRanker,
    private readonly fallback: CandidateRanker = new HeuristicCandidateRanker(),
    private readonly timeoutMs = 100
  ) {
    this.name = `${primary.name}-with-fallback`;
    this.featureVersion = primary.featureVersion;
    this.modelVersion = primary.modelVersion;
  }

  async rank(task: UserTask, candidates: ContextCandidate[], index: RepositoryIndex): Promise<ContextCandidate[]> {
    if (this.primary.featureVersion !== this.fallback.featureVersion) {
      return this.fallback.rank(task, candidates, index);
    }

    try {
      return await withTimeout(this.primary.rank(task, candidates, index), this.timeoutMs);
    } catch {
      return this.fallback.rank(task, candidates, index);
    }
  }
}

export function extractRankingFeatures(
  task: UserTask,
  candidate: ContextCandidate,
  index: RepositoryIndex
): RankingFeatures {
  const terms = tokenize(task.text);
  const pathTerms = tokenize(candidate.path);
  const file = index.files.find((entry) => entry.path === candidate.path);
  const symbolTerms = new Set((file?.symbols ?? []).flatMap((symbol) => tokenize(symbol.name)));
  const inboundDependencies = index.edges.filter((edge) => edge.to === candidate.path).length;

  return {
    lexicalScore: candidate.lexicalScore ?? candidate.structuralScore,
    semanticScore: candidate.semanticScore,
    symbolOverlap: overlap(terms, symbolTerms),
    pathOverlap: overlap(terms, new Set(pathTerms)),
    dependencyDistance: candidate.dependencyDistance,
    inboundDependencies,
    fileImportance: candidate.fileImportanceScore,
    recency: candidate.recencyScore,
    tokenCost: candidate.tokenCost,
    isTest: file?.isTest ? 1 : 0
  };
}

function scoreFeatureBoost(features: RankingFeatures): number {
  return (
    features.symbolOverlap * 5 +
    features.pathOverlap * 4 -
    Math.log1p(features.inboundDependencies) * 0.6 +
    features.isTest * 0.25
  );
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 2);
}

function overlap(queryTerms: string[], candidateTerms: Set<string>): number {
  if (queryTerms.length === 0) {
    return 0;
  }
  return queryTerms.filter((term) => candidateTerms.has(term)).length / queryTerms.length;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Ranker exceeded ${timeoutMs}ms timeout.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
