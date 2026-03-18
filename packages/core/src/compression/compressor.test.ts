import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextCompressor } from "./compressor";
import type { ContextCandidate, RepositoryIndex, TokenBudget } from "../types/contracts";

const tempDirectories: string[] = [];

describe("ContextCompressor", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map(async (directory) => {
        await import("node:fs/promises").then(({ rm }) => rm(directory, { force: true, recursive: true }));
      })
    );
  });

  it("keeps top implementation files raw and summarizes dependencies", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "nomic-compressor-"));
    tempDirectories.push(repositoryRoot);
    await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
    await mkdir(path.join(repositoryRoot, "tests"), { recursive: true });

    await writeFile(path.join(repositoryRoot, "src", "auth.ts"), "export function loginUser() { return true; }", "utf8");
    await writeFile(path.join(repositoryRoot, "src", "crypto.ts"), "export function hashPassword() { return 'x'; }", "utf8");
    await writeFile(path.join(repositoryRoot, "src", "session.ts"), "export class SessionManager {}", "utf8");
    await writeFile(path.join(repositoryRoot, "tests", "auth.test.ts"), "describe('auth', () => {})", "utf8");

    const index: RepositoryIndex = {
      repositoryRoot,
      fileCount: 4,
      generatedAt: new Date().toISOString(),
      metrics: {
        addedFiles: 4,
        changedFiles: 0,
        removedFiles: 0,
        reusedFiles: 0,
        reusedChunks: 0,
        reusedEdges: 0
      },
      files: [
        {
          path: "src/auth.ts",
          language: "typescript",
          size: 40,
          modifiedAtMs: 1,
          imports: ["./crypto"],
          isTest: false,
          symbols: [
            { id: "src/auth.ts#module", name: "auth.ts", kind: "module", path: "src/auth.ts", exported: true },
            { id: "src/auth.ts#function:loginUser", name: "loginUser", kind: "function", path: "src/auth.ts", exported: true }
          ]
        },
        {
          path: "src/crypto.ts",
          language: "typescript",
          size: 30,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [
            { id: "src/crypto.ts#module", name: "crypto.ts", kind: "module", path: "src/crypto.ts", exported: true },
            { id: "src/crypto.ts#function:hashPassword", name: "hashPassword", kind: "function", path: "src/crypto.ts", exported: true }
          ]
        },
        {
          path: "src/session.ts",
          language: "typescript",
          size: 20,
          modifiedAtMs: 1,
          imports: [],
          isTest: false,
          symbols: [
            { id: "src/session.ts#module", name: "session.ts", kind: "module", path: "src/session.ts", exported: true },
            { id: "src/session.ts#class:SessionManager", name: "SessionManager", kind: "class", path: "src/session.ts", exported: true }
          ]
        },
        {
          path: "tests/auth.test.ts",
          language: "typescript",
          size: 20,
          modifiedAtMs: 1,
          imports: [],
          isTest: true,
          symbols: [{ id: "tests/auth.test.ts#module", name: "auth.test.ts", kind: "test", path: "tests/auth.test.ts", exported: true }]
        }
      ],
      symbols: [],
      chunks: [],
      edges: []
    };

    const candidates: ContextCandidate[] = [
      {
        path: "src/auth.ts",
        reason: "Primary auth implementation",
        score: 20,
        source: "structural",
        role: "primary",
        stage: "seed",
        dependencyDistance: 0,
        structuralScore: 20,
        semanticScore: 0,
        recencyScore: 1,
        fileImportanceScore: 5,
        tokenCost: 10,
        chunkIds: [],
        expansionPath: ["src/auth.ts"]
      },
      {
        path: "src/crypto.ts",
        reason: "Dependency for auth hashing",
        score: 12,
        source: "structural",
        role: "dependency",
        stage: "graph",
        dependencyDistance: 1,
        structuralScore: 12,
        semanticScore: 0,
        recencyScore: 1,
        fileImportanceScore: 4,
        tokenCost: 8,
        chunkIds: [],
        expansionPath: ["src/auth.ts", "src/crypto.ts"]
      },
      {
        path: "src/session.ts",
        reason: "Secondary implementation context",
        score: 15,
        source: "structural",
        role: "primary",
        stage: "seed",
        dependencyDistance: 0,
        structuralScore: 15,
        semanticScore: 0,
        recencyScore: 1,
        fileImportanceScore: 4,
        tokenCost: 8,
        chunkIds: [],
        expansionPath: ["src/session.ts"]
      },
      {
        path: "tests/auth.test.ts",
        reason: "Related auth test",
        score: 10,
        source: "structural",
        role: "test",
        stage: "graph",
        dependencyDistance: 1,
        structuralScore: 10,
        semanticScore: 0,
        recencyScore: 1,
        fileImportanceScore: 2,
        tokenCost: 5,
        chunkIds: [],
        expansionPath: ["src/auth.ts", "tests/auth.test.ts"]
      }
    ];

    const tokenBudget: TokenBudget = {
      maxContextTokens: 80,
      rawCodeFraction: 0.5,
      summaryFraction: 0.2,
      dependencyFraction: 0.2,
      testFraction: 0.1
    };

    const compression = await new ContextCompressor(undefined, tokenBudget).compress(candidates, index);
    const summaries = compression.items;

    expect(summaries.filter((item) => item.compression === "raw").map((item) => item.path)).toEqual([
      "src/auth.ts",
      "src/session.ts"
    ]);
    expect(summaries.find((item) => item.path === "src/auth.ts")?.content).toContain("loginUser");
    expect(compression.omittedPaths).toContain("src/crypto.ts");
    expect(compression.dependencyNotes.length).toBeGreaterThan(0);
    expect(compression.budgetUsage.total).toBeGreaterThan(0);
  });
});
