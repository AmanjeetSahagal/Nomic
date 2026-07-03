import { describe, expect, it } from "vitest";
import { compareModes, gradedMetrics, retrieveBm25, type CorpusTaskResult } from "./corpus-runner";
import type { CorpusTask } from "./corpus-contracts";
import type { RepositoryIndex } from "../types/contracts";

describe("corpus runner", () => {
  it("ranks lexical implementation matches with BM25", () => {
    const index: RepositoryIndex = { repositoryRoot: "/repo", fileCount: 2, files: [
      { path: "src/auth.ts", language: "typescript", size: 80, modifiedAtMs: 0, imports: [], isTest: false, symbols: [{ id: "a", name: "AuthService", kind: "class", path: "src/auth.ts", exported: true }] },
      { path: "src/misc.ts", language: "typescript", size: 20, modifiedAtMs: 0, imports: [], isTest: false, symbols: [] }
    ], symbols: [], chunks: [{ id: "a", filePath: "src/auth.ts", kind: "code", startLine: 1, endLine: 1, tokenEstimate: 4, text: "authentication login session" }], edges: [], generatedAt: "", metrics: { addedFiles: 2, changedFiles: 0, removedFiles: 0, reusedFiles: 0, reusedChunks: 0, reusedEdges: 0 } };
    expect(retrieveBm25("fix authentication login", index, 10)[0]?.path).toBe("src/auth.ts");
  });

  it("boosts exact symbol fields above prose-only matches", () => {
    const index: RepositoryIndex = { repositoryRoot: "/repo", fileCount: 2, files: [
      { path: "src/fields.py", language: "python", size: 100_000, modifiedAtMs: 0, imports: [], isTest: false, symbols: [{ id: "decimal", name: "DecimalField", kind: "class", path: "src/fields.py", exported: true }] },
      { path: "docs/database.md", language: "markdown", size: 100, modifiedAtMs: 0, imports: [], isTest: false, symbols: [] }
    ], symbols: [], chunks: [
      { id: "source", filePath: "src/fields.py", kind: "code", startLine: 1, endLine: 2, tokenEstimate: 4, text: "class DecimalField" },
      { id: "docs", filePath: "docs/database.md", kind: "doc", startLine: 1, endLine: 2, tokenEstimate: 8, text: "database numeric precision database numeric precision" }
    ], edges: [], generatedAt: "", metrics: { addedFiles: 2, changedFiles: 0, removedFiles: 0, reusedFiles: 0, reusedChunks: 0, reusedEdges: 0 } };
    expect(retrieveBm25("DecimalField database numeric precision", index, 10)[0]?.path).toBe("src/fields.py");
  });

  it("computes primary recall and graded NDCG", () => {
    const task = { relevance: { primaryFiles: ["a"], supportingFiles: ["b"], relevantUnchangedFiles: ["c"], symbols: [] } } as unknown as CorpusTask;
    const metrics = gradedMetrics(["b", "a", "x"], task);
    expect(metrics.recallAt5).toBe(1);
    expect(metrics.reciprocalRank).toBe(.5);
    expect(metrics.ndcgAt10).toBeGreaterThan(.7);
    expect(metrics.firstRelevantRank).toBe(1);
  });

  it("summarizes paired rank movement and token savings", () => {
    const base: Omit<CorpusTaskResult, "taskId" | "mode" | "firstRelevantRank" | "selectedTokens"> = {
      repositoryId: "owner/repo", taskType: "bug-localization", split: "test", rankedPaths: [], primaryFiles: ["a"],
      recallAt5: 1, recallAt10: 1, reciprocalRank: 1, ndcgAt10: 1, contextPrecision: 1,
      firstRelevantCandidateRank: 1, firstPrimaryCandidateRank: 1, candidatePoolPaths: ["a"], relevantCandidatePresent: true, primaryCandidatePresent: true,
      packedFileCount: 1, relevantSymbolIncluded: true, coldQueryMs: 1, queryMedianMs: 1,
      stageMedianMs: {}, sourceCounts: { seed: 1 }, indexMs: 1, indexStageTimingsMs: {}
    };
    const rows: CorpusTaskResult[] = [
      { ...base, taskId: "improves", mode: "bm25", firstRelevantRank: 3, selectedTokens: 100 },
      { ...base, taskId: "improves", mode: "heuristic", firstRelevantRank: 1, selectedTokens: 50 },
      { ...base, taskId: "ties", mode: "bm25", firstRelevantRank: null, selectedTokens: 100 },
      { ...base, taskId: "ties", mode: "heuristic", firstRelevantRank: null, selectedTokens: 100 }
    ];
    expect(compareModes(rows)).toMatchObject({ pairedTasks: 2, improves: 1, ties: 1, worsens: 0, bothFailedTop10: 1, meanTokenSavingsFraction: .25 });
  });
});
