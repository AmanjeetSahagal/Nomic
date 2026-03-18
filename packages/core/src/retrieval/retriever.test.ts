import { describe, expect, it } from "vitest";
import { applyTaskOverrides, HybridRetriever, LocalEmbeddingProvider } from "./retriever";
import type { RepositoryIndex } from "../types/contracts";

describe("HybridRetriever", () => {
  it("selects matching source files, imported dependencies, and related tests", async () => {
    const retriever = new HybridRetriever();
    const index: RepositoryIndex = {
      repositoryRoot: "/repo",
      fileCount: 4,
      generatedAt: new Date().toISOString(),
      metrics: {
        addedFiles: 4,
        changedFiles: 0,
        removedFiles: 0,
        reusedFiles: 0
      },
      files: [
        {
          path: "src/auth.ts",
          language: "typescript",
          size: 100,
          modifiedAtMs: 1,
          imports: ["./crypto"],
          isTest: false,
          symbols: [
            { name: "auth.ts", kind: "module", path: "src/auth.ts" },
            { name: "AuthService", kind: "class", path: "src/auth.ts" },
            { name: "loginUser", kind: "function", path: "src/auth.ts" }
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
            { name: "crypto.ts", kind: "module", path: "src/crypto.ts" },
            { name: "hashPassword", kind: "function", path: "src/crypto.ts" }
          ]
        },
        {
          path: "tests/auth.test.ts",
          language: "typescript",
          size: 40,
          modifiedAtMs: 1,
          imports: ["../src/auth"],
          isTest: true,
          symbols: [{ name: "auth.test.ts", kind: "test", path: "tests/auth.test.ts" }]
        },
        {
          path: "src/payments.ts",
          language: "typescript",
          size: 80,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [{ name: "payments.ts", kind: "module", path: "src/payments.ts" }]
        },
        {
          path: "docs/auth-architecture.md",
          language: "markdown",
          size: 120,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [{ name: "auth-architecture.md", kind: "module", path: "docs/auth-architecture.md" }]
        }
      ]
    };

    const result = await retriever.retrieve(
      {
        text: "refactor authentication login flow",
        target: "codex",
        repositoryRoot: "/repo"
      },
      index
    );

    expect(result.queryTerms).toEqual(expect.arrayContaining(["refactor", "authentication", "login", "flow"]));
    expect(result.candidates.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining(["src/auth.ts", "src/crypto.ts", "tests/auth.test.ts"])
    );
    expect(result.relatedTests).toContain("tests/auth.test.ts");
    expect(result.candidates.find((candidate) => candidate.path === "src/crypto.ts")?.reason).toContain(
      "Imported by src/auth.ts"
    );
    expect(result.candidates.find((candidate) => candidate.path === "src/auth.ts")?.reason).toContain(
      "Semantic overlap"
    );
  });

  it("retrieves semantic-only documentation hits through the embedding provider", async () => {
    const retriever = new HybridRetriever(new LocalEmbeddingProvider());
    const index: RepositoryIndex = {
      repositoryRoot: "/repo",
      fileCount: 2,
      generatedAt: new Date().toISOString(),
      metrics: {
        addedFiles: 2,
        changedFiles: 0,
        removedFiles: 0,
        reusedFiles: 0
      },
      files: [
        {
          path: "docs/session-reliability.md",
          language: "markdown",
          size: 100,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [{ name: "session-reliability.md", kind: "module", path: "docs/session-reliability.md" }]
        },
        {
          path: "src/auth.ts",
          language: "typescript",
          size: 80,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [{ name: "AuthService", kind: "class", path: "src/auth.ts" }]
        }
      ]
    };

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
      source: "structural"
    });
    expect(docCandidate?.reason).toContain("Semantic overlap");
  });

  it("applies pinned and excluded overrides deterministically", async () => {
    const index: RepositoryIndex = {
      repositoryRoot: "/repo",
      fileCount: 3,
      generatedAt: new Date().toISOString(),
      metrics: {
        addedFiles: 3,
        changedFiles: 0,
        removedFiles: 0,
        reusedFiles: 0
      },
      files: [
        {
          path: "src/auth.ts",
          language: "typescript",
          size: 100,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [{ name: "AuthService", kind: "class", path: "src/auth.ts" }]
        },
        {
          path: "src/payments.ts",
          language: "typescript",
          size: 80,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [{ name: "payments.ts", kind: "module", path: "src/payments.ts" }]
        },
        {
          path: "tests/auth.test.ts",
          language: "typescript",
          size: 30,
          modifiedAtMs: 1,
          imports: [],
          isTest: true,
          symbols: [{ name: "auth.test.ts", kind: "test", path: "tests/auth.test.ts" }]
        }
      ]
    };

    const retrieval = applyTaskOverrides(
      {
        candidates: [
          { path: "src/auth.ts", reason: "Path matches auth", score: 10, source: "structural" },
          { path: "tests/auth.test.ts", reason: "Related test for src/auth.ts", score: 8, source: "structural" }
        ],
        relatedTests: ["tests/auth.test.ts"],
        queryTerms: ["auth"]
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
      source: "manual"
    });
    expect(retrieval.relatedTests).toEqual([]);
  });
});
