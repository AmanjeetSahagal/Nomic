import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import type { CandidateRanker, EmbeddingProvider, RepositoryIndex } from "../types/contracts";
import { ResilientCandidateRanker } from "../ranking/ranker";
import { Bm25SymbolPackedRetriever } from "./bm25-symbol-retriever";

describe("Bm25SymbolPackedRetriever", () => {
  it("uses exact symbols and packing without default graph or semantic expansion", async () => {
    const index = createIndex();
    const embeddings: EmbeddingProvider = { name: "spy", search: vi.fn(async () => []) };
    const retriever = new Bm25SymbolPackedRetriever({}, embeddings);
    const started = performance.now();
    const result = await retriever.retrieve({ text: "fix `DecimalField` numeric precision", target: "codex", repositoryRoot: "/repo" }, index);

    expect(result.candidates[0]?.path).toBe("src/fields.py");
    expect(result.candidates[0]?.chunkIds).toEqual(["field"]);
    expect(result.candidates.every((candidate) => candidate.stage === "seed")).toBe(true);
    expect(result.structuralCandidates).toEqual([]);
    expect(result.semanticCandidates).toEqual([]);
    expect(embeddings.search).not.toHaveBeenCalled();
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("only applies an exact path override when explicitly enabled", async () => {
    const index = createIndex();
    const task = { text: "inspect src/empty-target.py", target: "codex" as const, repositoryRoot: "/repo" };
    const defaultResult = await new Bm25SymbolPackedRetriever().retrieve(task, index);
    const overrideResult = await new Bm25SymbolPackedRetriever({ exactPathOverride: true }).retrieve(task, index);

    expect(defaultResult.candidates[0]?.path).not.toBe("src/empty-target.py");
    expect(overrideResult.candidates[0]?.path).toBe("src/empty-target.py");
  });

  it("keeps experimental expansion behind explicit flags", async () => {
    const index = createIndex();
    const embeddings: EmbeddingProvider = { name: "semantic", search: vi.fn(async () => []) };
    const result = await new Bm25SymbolPackedRetriever({ graphExpansion: true, semanticExpansion: true }, embeddings)
      .retrieve({ text: "DecimalField precision", target: "codex", repositoryRoot: "/repo" }, index);

    expect(embeddings.search).toHaveBeenCalledOnce();
    expect(result.stageTimingsMs?.graph).toBeGreaterThanOrEqual(0);
    expect(result.stageTimingsMs?.semantic).toBeGreaterThanOrEqual(0);
  });

  it("returns the frozen baseline order when an experimental ranker fails", async () => {
    const index = createIndex();
    const task = { text: "DecimalField precision", target: "codex" as const, repositoryRoot: "/repo" };
    const baseline = await new Bm25SymbolPackedRetriever().retrieve(task, index);
    const failing: CandidateRanker = { name: "broken", featureVersion: "ranking-features-v1", rank: async () => { throw new Error("bad model"); } };
    const experimental = await new Bm25SymbolPackedRetriever({ ranker: new ResilientCandidateRanker(failing) }).retrieve(task, index);
    expect(experimental.candidates).toEqual(baseline.candidates);
    expect(experimental.rankingFallbackReason).toBe("bad model");
  });
});

function createIndex(): RepositoryIndex {
  const files: RepositoryIndex["files"] = [
    { path: "src/fields.py", language: "python", size: 100_000, modifiedAtMs: 1, imports: [], isTest: false, symbols: [{ id: "decimal", name: "DecimalField", kind: "class", path: "src/fields.py", exported: true }] },
    { path: "docs/database.md", language: "markdown", size: 100, modifiedAtMs: 1, imports: [], isTest: false, symbols: [] },
    { path: "src/empty-target.py", language: "python", size: 10, modifiedAtMs: 1, imports: [], isTest: false, symbols: [] }
  ];
  return {
    repositoryRoot: "/repo", fileCount: files.length, files, symbols: files.flatMap((file) => file.symbols),
    chunks: [
      { id: "field", filePath: "src/fields.py", kind: "code", startLine: 100, endLine: 120, tokenEstimate: 30, text: "class DecimalField numeric precision" },
      { id: "docs", filePath: "docs/database.md", kind: "doc", startLine: 1, endLine: 4, tokenEstimate: 20, text: "numeric database precision guide" },
      { id: "empty", filePath: "src/empty-target.py", kind: "code", startLine: 1, endLine: 1, tokenEstimate: 1, text: "pass" }
    ],
    edges: [{ from: "src/fields.py", to: "docs/database.md", kind: "reference", weight: 2 }],
    generatedAt: "", metrics: { addedFiles: files.length, changedFiles: 0, removedFiles: 0, reusedFiles: 0, reusedChunks: 0, reusedEdges: 0 }
  };
}
