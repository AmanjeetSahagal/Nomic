import {
  type ContextCandidate,
  type EmbeddingProvider,
  type FileRecord,
  type RepositoryIndex,
  type RetrievalResult,
  type UserTask
} from "../types/contracts";

export class HybridRetriever {
  constructor(private readonly embeddings?: EmbeddingProvider) {}

  async retrieve(task: UserTask, index: RepositoryIndex): Promise<RetrievalResult> {
    const queryTerms = extractQueryTerms(task.text);
    const structuralCandidates = retrieveStructuralCandidates(queryTerms, index);
    const semanticCandidates = this.embeddings
      ? await this.embeddings.search(task, index)
      : [];

    const candidates = mergeCandidates(structuralCandidates, semanticCandidates).sort(
      (left, right) => right.score - left.score || left.path.localeCompare(right.path)
    );

    return {
      candidates,
      relatedTests: candidates.filter((candidate) => isTestFilePath(candidate.path)).map((candidate) => candidate.path),
      queryTerms
    };
  }
}

function retrieveStructuralCandidates(queryTerms: string[], index: RepositoryIndex): ContextCandidate[] {
  const scoredFiles = index.files
    .map((file) => scoreFile(file, queryTerms))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));

  const selected = new Map<string, ContextCandidate>();
  const seedFiles = scoredFiles.slice(0, 8);

  for (const entry of seedFiles) {
    selected.set(entry.file.path, {
      path: entry.file.path,
      reason: entry.reasons.join("; "),
      score: entry.score,
      source: "structural"
    });
  }

  for (const entry of seedFiles.slice(0, 5)) {
    for (const dependency of resolveImportedFiles(entry.file, index)) {
      if (selected.has(dependency.path)) {
        continue;
      }

      selected.set(dependency.path, {
        path: dependency.path,
        reason: `Imported by ${entry.file.path}`,
        score: Math.max(1, entry.score - 3),
        source: "structural"
      });
    }

    for (const relatedTest of findRelatedTests(entry.file, index)) {
      const existing = selected.get(relatedTest.path);
      if (existing) {
        continue;
      }

      selected.set(relatedTest.path, {
        path: relatedTest.path,
        reason: `Related test for ${entry.file.path}`,
        score: Math.max(1, entry.score - 2),
        source: "structural"
      });
    }
  }

  return [...selected.values()];
}

function scoreFile(file: FileRecord, queryTerms: string[]): { file: FileRecord; reasons: string[]; score: number } {
  let score = 0;
  const reasons: string[] = [];
  const normalizedPath = file.path.toLowerCase();
  const normalizedImports = file.imports.map((value) => value.toLowerCase());

  for (const term of queryTerms) {
    if (normalizedPath.includes(term)) {
      score += 6;
      reasons.push(`Path matches "${term}"`);
    }

    const symbolMatches = file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(term));
    if (symbolMatches.length > 0) {
      score += symbolMatches.length * 5;
      reasons.push(`Symbol matches "${term}"`);
    }

    const importMatches = normalizedImports.filter((value) => value.includes(term));
    if (importMatches.length > 0) {
      score += importMatches.length * 2;
      reasons.push(`Import matches "${term}"`);
    }
  }

  if (file.isTest) {
    score -= 1;
  }

  return {
    file,
    reasons: unique(reasons),
    score
  };
}

function resolveImportedFiles(file: FileRecord, index: RepositoryIndex): FileRecord[] {
  const matches = new Map<string, FileRecord>();

  for (const importValue of file.imports) {
    const normalizedImport = normalizeModulePath(importValue);
    for (const candidate of index.files) {
      if (candidate.path === file.path || candidate.isTest) {
        continue;
      }

      const normalizedCandidate = normalizeModulePath(candidate.path);
      if (
        normalizedCandidate === normalizedImport ||
        normalizedCandidate.endsWith(`/${normalizedImport}`) ||
        normalizedImport.endsWith(`/${normalizedCandidate}`)
      ) {
        matches.set(candidate.path, candidate);
      }
    }
  }

  return [...matches.values()];
}

function findRelatedTests(file: FileRecord, index: RepositoryIndex): FileRecord[] {
  const baseName = normalizeModulePath(file.path).split("/").pop();
  if (!baseName) {
    return [];
  }

  return index.files.filter((candidate) => {
    if (!candidate.isTest || candidate.path === file.path) {
      return false;
    }

    const normalized = normalizeModulePath(candidate.path);
    return normalized.includes(baseName);
  });
}

function mergeCandidates(
  structuralCandidates: ContextCandidate[],
  semanticCandidates: ContextCandidate[]
): ContextCandidate[] {
  const merged = new Map<string, ContextCandidate>();

  for (const candidate of [...structuralCandidates, ...semanticCandidates]) {
    const existing = merged.get(candidate.path);
    if (!existing || candidate.score > existing.score) {
      merged.set(candidate.path, candidate);
      continue;
    }

    if (candidate.reason && !existing.reason.includes(candidate.reason)) {
      existing.reason = `${existing.reason}; ${candidate.reason}`;
    }
  }

  return [...merged.values()];
}

function extractQueryTerms(text: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "for",
    "in",
    "of",
    "on",
    "the",
    "to",
    "with"
  ]);

  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));

  return unique(tokens).slice(0, 12);
}

function normalizeModulePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\.(c|cc|cpp|cs|go|java|js|jsx|mjs|py|rb|rs|swift|ts|tsx)$/i, "")
    .replace(/\/index$/i, "")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function isTestFilePath(filePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)\/|(\.|_)(test|spec)\./i.test(filePath);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
