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

  it("keeps top source files raw and summarizes the rest", async () => {
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
      files: [
        {
          path: "src/auth.ts",
          language: "typescript",
          size: 40,
          imports: ["./crypto"],
          isTest: false,
          symbols: [
            { name: "auth.ts", kind: "module", path: "src/auth.ts" },
            { name: "loginUser", kind: "function", path: "src/auth.ts" }
          ]
        },
        {
          path: "src/crypto.ts",
          language: "typescript",
          size: 30,
          imports: [],
          isTest: false,
          symbols: [
            { name: "crypto.ts", kind: "module", path: "src/crypto.ts" },
            { name: "hashPassword", kind: "function", path: "src/crypto.ts" }
          ]
        },
        {
          path: "src/session.ts",
          language: "typescript",
          size: 20,
          imports: [],
          isTest: false,
          symbols: [
            { name: "session.ts", kind: "module", path: "src/session.ts" },
            { name: "SessionManager", kind: "class", path: "src/session.ts" }
          ]
        },
        {
          path: "tests/auth.test.ts",
          language: "typescript",
          size: 20,
          imports: [],
          isTest: true,
          symbols: [{ name: "auth.test.ts", kind: "test", path: "tests/auth.test.ts" }]
        }
      ]
    };

    const candidates: ContextCandidate[] = [
      { path: "src/auth.ts", reason: "Path matches auth", score: 10, source: "structural" },
      { path: "src/crypto.ts", reason: "Imported by src/auth.ts", score: 7, source: "structural" },
      { path: "src/session.ts", reason: "Path matches session", score: 6, source: "structural" },
      { path: "tests/auth.test.ts", reason: "Related test for src/auth.ts", score: 5, source: "structural" }
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
    expect(summaries.find((item) => item.path === "src/session.ts")?.content).toContain("SessionManager");
    expect(compression.omittedPaths).toContain("tests/auth.test.ts");
    expect(compression.budgetUsage.total).toBeGreaterThan(0);
  });
});
