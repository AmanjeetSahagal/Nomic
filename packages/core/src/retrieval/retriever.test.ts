import { describe, expect, it } from "vitest";
import { applyTaskOverrides, HybridRetriever, LocalEmbeddingProvider } from "./retriever";
import type { RepositoryIndex } from "../types/contracts";

describe("HybridRetriever", () => {
  it("selects matching source files, graph dependencies, and related tests", async () => {
    const retriever = new HybridRetriever();
    const index = createRepositoryIndex("/repo");

    const result = await retriever.retrieve(
      {
        text: "refactor authentication login flow",
        target: "codex",
        repositoryRoot: "/repo"
      },
      index
    );

    expect(result.analysis.intent).toBe("refactor");
    expect(result.analysis.queryTerms).toEqual(expect.arrayContaining(["refactor", "authentication", "login"]));
    expect(result.candidates.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining(["src/auth.ts", "src/crypto.ts", "tests/auth.test.ts"])
    );
    expect(result.relatedTests).toContain("tests/auth.test.ts");
    expect(result.candidates.find((candidate) => candidate.path === "src/crypto.ts")?.role).toBe("dependency");
    expect(result.candidates.find((candidate) => candidate.path === "src/crypto.ts")?.reason).toContain(
      "imported by"
    );
    expect(result.structuralCandidates.find((candidate) => candidate.path === "src/auth.ts")?.stage).toBe("seed");
  });

  it("retrieves semantic-only documentation hits through chunk search", async () => {
    const retriever = new HybridRetriever(new LocalEmbeddingProvider());
    const index = createRepositoryIndex("/repo", {
      files: [
        {
          path: "docs/session-reliability.md",
          language: "markdown",
          size: 100,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [
            { id: "docs/session-reliability.md#module", name: "session-reliability.md", kind: "module", path: "docs/session-reliability.md", exported: true }
          ]
        },
        {
          path: "src/auth.ts",
          language: "typescript",
          size: 80,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [
            { id: "src/auth.ts#class:AuthService", name: "AuthService", kind: "class", path: "src/auth.ts", exported: true }
          ]
        }
      ],
      chunks: [
        {
          id: "docs/session-reliability.md#1-4",
          filePath: "docs/session-reliability.md",
          kind: "doc",
          startLine: 1,
          endLine: 4,
          tokenEstimate: 8,
          text: "Session reliability guide and failure handling notes."
        }
      ],
      edges: []
    });

    const result = await retriever.retrieve(
      {
        text: "improve session reliability documentation",
        target: "codex",
        repositoryRoot: "/repo"
      },
      index
    );

    const docCandidate = result.candidates.find((candidate) => candidate.path === "docs/session-reliability.md");
    expect(docCandidate).toMatchObject({
      path: "docs/session-reliability.md",
      role: "primary"
    });
    expect(docCandidate?.reason).toContain("Semantic overlap");
  });

  it("applies pinned and excluded overrides deterministically", async () => {
    const index = createRepositoryIndex("/repo", {
      files: [
        {
          path: "src/auth.ts",
          language: "typescript",
          size: 100,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [{ id: "src/auth.ts#class:AuthService", name: "AuthService", kind: "class", path: "src/auth.ts", exported: true }]
        },
        {
          path: "src/payments.ts",
          language: "typescript",
          size: 80,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [{ id: "src/payments.ts#module", name: "payments.ts", kind: "module", path: "src/payments.ts", exported: true }]
        },
        {
          path: "tests/auth.test.ts",
          language: "typescript",
          size: 30,
          modifiedAtMs: 1,
          imports: [],
          isTest: true,
          symbols: [{ id: "tests/auth.test.ts#module", name: "auth.test.ts", kind: "test", path: "tests/auth.test.ts", exported: true }]
        }
      ]
    });

    const retrieval = applyTaskOverrides(
      {
        analysis: {
          normalizedTask: "auth",
          queryTerms: ["auth"],
          intent: "general"
        },
        candidates: [
          {
            path: "src/auth.ts",
            reason: "Path matches auth",
            score: 10,
            source: "structural",
            role: "primary",
            stage: "seed",
            dependencyDistance: 0,
            structuralScore: 10,
            semanticScore: 0,
            recencyScore: 1,
            fileImportanceScore: 3,
            tokenCost: 25,
            chunkIds: [],
            expansionPath: ["src/auth.ts"]
          },
          {
            path: "tests/auth.test.ts",
            reason: "Related test for src/auth.ts",
            score: 8,
            source: "structural",
            role: "test",
            stage: "graph",
            dependencyDistance: 1,
            structuralScore: 8,
            semanticScore: 0,
            recencyScore: 1,
            fileImportanceScore: 1,
            tokenCost: 8,
            chunkIds: [],
            expansionPath: ["src/auth.ts", "tests/auth.test.ts"]
          }
        ],
        relatedTests: ["tests/auth.test.ts"],
        structuralCandidates: [],
        semanticCandidates: [],
        truncationReasons: [],
        rerankWeights: {}
      },
      index,
      {
        pinnedPaths: ["src/payments.ts"],
        excludedPaths: ["tests/auth.test.ts"]
      }
    );

    expect(retrieval.candidates.map((candidate) => candidate.path)).toEqual(["src/payments.ts", "src/auth.ts"]);
    expect(retrieval.candidates[0]).toMatchObject({
      path: "src/payments.ts",
      source: "manual",
      role: "manual"
    });
    expect(retrieval.relatedTests).toEqual([]);
  });
});

function createRepositoryIndex(repositoryRoot: string, overrides: Partial<RepositoryIndex> = {}): RepositoryIndex {
  const files = overrides.files ?? [
    {
      path: "src/auth.ts",
      language: "typescript",
      size: 100,
      modifiedAtMs: 1,
      imports: ["./crypto"],
      isTest: false,
      symbols: [
        { id: "src/auth.ts#module", name: "auth.ts", kind: "module", path: "src/auth.ts", exported: true },
        { id: "src/auth.ts#class:AuthService", name: "AuthService", kind: "class", path: "src/auth.ts", exported: true },
        { id: "src/auth.ts#function:loginUser", name: "loginUser", kind: "function", path: "src/auth.ts", exported: true }
      ]
    },
    {
      path: "src/crypto.ts",
      language: "typescript",
      size: 50,
      modifiedAtMs: 1,
      imports: [],
      isTest: false,
      symbols: [
        { id: "src/crypto.ts#module", name: "crypto.ts", kind: "module", path: "src/crypto.ts", exported: true },
        { id: "src/crypto.ts#function:hashPassword", name: "hashPassword", kind: "function", path: "src/crypto.ts", exported: true }
      ]
    },
    {
      path: "tests/auth.test.ts",
      language: "typescript",
      size: 40,
      modifiedAtMs: 1,
      imports: ["../src/auth"],
      isTest: true,
      symbols: [{ id: "tests/auth.test.ts#module", name: "auth.test.ts", kind: "test", path: "tests/auth.test.ts", exported: true }]
    },
    {
      path: "docs/auth-architecture.md",
      language: "markdown",
      size: 120,
      modifiedAtMs: 1,
      imports: [],
      isTest: false,
      symbols: [{ id: "docs/auth-architecture.md#module", name: "auth-architecture.md", kind: "module", path: "docs/auth-architecture.md", exported: true }]
    }
  ];

  return {
    repositoryRoot,
    fileCount: files.length,
    generatedAt: new Date().toISOString(),
    metrics: {
      addedFiles: files.length,
      changedFiles: 0,
      removedFiles: 0,
      reusedFiles: 0,
      reusedChunks: 0,
      reusedEdges: 0
    },
    files,
    symbols: overrides.symbols ?? files.flatMap((file) => file.symbols),
    chunks:
      overrides.chunks ??
      [
        {
          id: "src/auth.ts#1-8",
          filePath: "src/auth.ts",
          kind: "code",
          startLine: 1,
          endLine: 8,
          tokenEstimate: 20,
          text: "AuthService loginUser authentication flow hashPassword"
        },
        {
          id: "src/crypto.ts#1-4",
          filePath: "src/crypto.ts",
          kind: "code",
          startLine: 1,
          endLine: 4,
          tokenEstimate: 12,
          text: "hashPassword crypto dependency"
        },
        {
          id: "tests/auth.test.ts#1-4",
          filePath: "tests/auth.test.ts",
          kind: "test",
          startLine: 1,
          endLine: 4,
          tokenEstimate: 10,
          text: "auth login test coverage"
        }
      ],
    edges:
      overrides.edges ??
      [
        { from: "src/auth.ts", to: "src/crypto.ts", kind: "import", weight: 5 },
        { from: "tests/auth.test.ts", to: "src/auth.ts", kind: "test", weight: 4 }
      ]
  };
}
