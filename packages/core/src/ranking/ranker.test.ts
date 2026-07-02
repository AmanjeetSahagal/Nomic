import { describe, expect, it } from "vitest";
import { HeuristicCandidateRanker, ResilientCandidateRanker } from "./ranker";
import type { CandidateRanker, ContextCandidate, RepositoryIndex } from "../types/contracts";

const index: RepositoryIndex = {
  repositoryRoot: "/repo",
  fileCount: 2,
  files: [
    { path: "src/auth.ts", language: "typescript", size: 100, modifiedAtMs: 2, imports: [], isTest: false,
      symbols: [{ id: "auth", name: "AuthService", kind: "class", path: "src/auth.ts", exported: true }] },
    { path: "src/misc.ts", language: "typescript", size: 100, modifiedAtMs: 1, imports: [], isTest: false, symbols: [] }
  ],
  symbols: [], chunks: [], edges: [], generatedAt: new Date(0).toISOString(),
  metrics: { addedFiles: 2, changedFiles: 0, removedFiles: 0, reusedFiles: 0, reusedChunks: 0, reusedEdges: 0 }
};

function candidate(path: string): ContextCandidate {
  return {
    path, reason: "fixture", score: 1, source: "structural", role: "primary", stage: "seed",
    dependencyDistance: 0, structuralScore: 1, semanticScore: 0, recencyScore: 1,
    fileImportanceScore: 1, tokenCost: 25, chunkIds: [], expansionPath: [path]
  };
}

describe("candidate ranking", () => {
  it("emits versioned features and rewards query overlap", async () => {
    const ranked = await new HeuristicCandidateRanker().rank(
      { text: "change AuthService authentication", target: "codex" },
      [candidate("src/misc.ts"), candidate("src/auth.ts")], index
    );
    expect(ranked[0]?.path).toBe("src/auth.ts");
    expect(ranked[0]?.featureVersion).toBe("nomic-ranking-v1");
    expect(ranked[0]?.rankerScore).toBeTypeOf("number");
  });

  it("falls back when the primary ranker fails", async () => {
    const failing: CandidateRanker = {
      name: "failing", featureVersion: "nomic-ranking-v1", modelVersion: "broken",
      rank: async () => { throw new Error("invalid model"); }
    };
    const ranked = await new ResilientCandidateRanker(failing).rank(
      { text: "AuthService", target: "codex" }, [candidate("src/auth.ts")], index
    );
    expect(ranked[0]?.modelVersion).toBe("heuristic-v1");
  });
});
