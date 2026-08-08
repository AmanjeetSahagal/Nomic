import { describe, expect, it } from "vitest";
import type { RepositoryIndex } from "../types/contracts";
import { generateCandidates } from "./candidate-generation";

const index: RepositoryIndex = {
  repositoryRoot: "/repo", fileCount: 3,
  files: [
    { path: "src/checker.ts", language: "typescript", size: 100_000, modifiedAtMs: 0, imports: [], isTest: false, symbols: [{ id: "resolve", name: "resolveStructuredTypeMembers", kind: "function", path: "src/checker.ts", exported: false }] },
    { path: "tests/structured.ts", language: "typescript", size: 100, modifiedAtMs: 0, imports: [], isTest: true, symbols: [] },
    { path: "src/parser.ts", language: "typescript", size: 100, modifiedAtMs: 0, imports: [], isTest: false, symbols: [] }
  ],
  symbols: [],
  chunks: [
    { id: "checker", filePath: "src/checker.ts", kind: "code", startLine: 1, endLine: 2, tokenEstimate: 3, text: "internal generic implementation" },
    { id: "test", filePath: "tests/structured.ts", kind: "code", startLine: 1, endLine: 2, tokenEstimate: 10, text: "structured type members regression structured type members" },
    { id: "parser", filePath: "src/parser.ts", kind: "code", startLine: 1, endLine: 2, tokenEstimate: 2, text: "parse syntax" }
  ],
  edges: [], generatedAt: "", metrics: { addedFiles: 3, changedFiles: 0, removedFiles: 0, reusedFiles: 0, reusedChunks: 0, reusedEdges: 0 }
};

describe("experimental candidate generation", () => {
  it("injects an exact symbol file that body BM25 misses", () => {
    const query = "Fix resolveStructuredTypeMembers when structured members are stale";
    expect(generateCandidates(query, index, "bm25-files", 2).candidates.map((item) => item.path)).not.toContain("src/checker.ts");
    const fused = generateCandidates(query, index, "bm25-plus-exact-symbol", 3).candidates;
    expect(fused.map((item) => item.path)).toContain("src/checker.ts");
    expect(fused.find((item) => item.path === "src/checker.ts")?.sources.exactSymbol).toBe(1);
  });

  it("does not treat generic prose words as exact symbols", () => {
    const generic: RepositoryIndex = { ...index, files: [{ ...index.files[0]!, symbols: [{ id: "get", name: "get", kind: "function", path: "src/checker.ts", exported: false }] }] };
    expect(generateCandidates("get the latest value", generic, "exact-symbol", 10).candidates).toEqual([]);
  });

  it("maps symbol-level BM25 matches back to files", () => {
    const paths = generateCandidates("structured type members", index, "symbol-bm25", 3).candidates.map((item) => item.path);
    expect(paths[0]).toBe("src/checker.ts");
  });

  it("injects validated filename matches", () => {
    const paths = generateCandidates("The failure is in checker.ts", index, "bm25-plus-path", 3).candidates.map((item) => item.path);
    expect(paths).toContain("src/checker.ts");
  });

  it("maps a strong matching chunk back to its large containing file", () => {
    const paths = generateCandidates("resolve structured type members", index, "chunk-bm25", 3).candidates.map((item) => item.path);
    expect(paths).toContain("tests/structured.ts");
  });

  it("uses the issue title as an independent low-noise query", () => {
    const paths = generateCandidates("Parse syntax failure\n\nnoisy structured members reproduction", index, "title-bm25", 3).candidates.map((item) => item.path);
    expect(paths[0]).toBe("src/parser.ts");
  });

  it("injects files containing identifiers extracted from code-like query text", () => {
    const paths = generateCandidates("Regression in `resolveStructuredTypeMembers()`", index, "exact-identifier", 3).candidates.map((item) => item.path);
    expect(paths).toContain("src/checker.ts");
  });

  it("keeps shallow expansion bounded to direct graph neighbors", () => {
    const withEdges: RepositoryIndex = {
      ...index,
      edges: [{ from: "tests/structured.ts", to: "src/checker.ts", kind: "test", weight: 4 }]
    };
    const paths = generateCandidates("structured type members regression", withEdges, "structural-expansion", 30).candidates.map((item) => item.path);
    expect(paths).toContain("src/checker.ts");
  });

  it("deduplicates reserved-source candidates against the fused core", () => {
    const candidates = generateCandidates("resolveStructuredTypeMembers checker.ts", index, "rrf-reserved-balanced", 3).candidates;
    expect(new Set(candidates.map((candidate) => candidate.path)).size).toBe(candidates.length);
    expect(candidates.map((candidate) => candidate.path)).toContain("src/checker.ts");
  });
});
