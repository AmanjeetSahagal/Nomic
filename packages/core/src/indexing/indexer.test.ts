import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemParserProvider } from "./indexer";

const tempDirectories: string[] = [];

describe("FilesystemParserProvider", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map(async (directory) => {
        await import("node:fs/promises").then(({ rm }) => rm(directory, { force: true, recursive: true }));
      })
    );
  });

  it("indexes source files, graph edges, chunks, and tests", async () => {
    const repositoryRoot = await createTempRepository();

    await writeFile(
      path.join(repositoryRoot, "src", "auth.ts"),
      [
        'import { hashPassword } from "./crypto";',
        "",
        "export class AuthService {}",
        "export function loginUser() {",
        "  return hashPassword('x');",
        "}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(repositoryRoot, "src", "crypto.ts"),
      "export const hashPassword = async (value: string) => value;",
      "utf8"
    );
    await writeFile(
      path.join(repositoryRoot, "tests", "auth.test.ts"),
      'import { loginUser } from "../src/auth";\nloginUser();',
      "utf8"
    );
    await writeFile(path.join(repositoryRoot, "docs", "auth.md"), "# Auth guide\nlogin flow", "utf8");
    await writeFile(path.join(repositoryRoot, "node_modules", "ignored.ts"), "export const ignored = true;", "utf8");

    const parser = new FilesystemParserProvider();
    const index = await parser.indexRepository({ repositoryRoot });

    expect(index.fileCount).toBe(4);
    expect(index.files.map((file) => file.path)).toEqual([
      "docs/auth.md",
      "src/auth.ts",
      "src/crypto.ts",
      "tests/auth.test.ts"
    ]);

    const authFile = index.files.find((file) => file.path === "src/auth.ts");
    expect(authFile).toMatchObject({
      language: "typescript",
      isTest: false,
      imports: ["./crypto"]
    });
    expect(authFile?.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["auth.ts", "AuthService", "loginUser"])
    );
    expect(index.chunks.some((chunk) => chunk.filePath === "src/auth.ts")).toBe(true);
    expect(index.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "src/auth.ts", to: "src/crypto.ts", kind: "import" }),
        expect.objectContaining({ from: "tests/auth.test.ts", to: "src/auth.ts", kind: "test" })
      ])
    );
    expect(index.metrics).toEqual({
      addedFiles: 4,
      changedFiles: 0,
      removedFiles: 0,
      reusedFiles: 0,
      reusedChunks: 0,
      reusedEdges: 0
    });
  });

  it("reuses unchanged files and reports incremental metrics", async () => {
    const repositoryRoot = await createTempRepository();

    const authPath = path.join(repositoryRoot, "src", "auth.ts");
    const cryptoPath = path.join(repositoryRoot, "src", "crypto.ts");
    const testPath = path.join(repositoryRoot, "tests", "auth.test.ts");

    await writeFile(authPath, "export function loginUser() { return true; }", "utf8");
    await writeFile(cryptoPath, "export function hashPassword() { return 'x'; }", "utf8");
    await writeFile(testPath, "describe('auth', () => {})", "utf8");

    const parser = new FilesystemParserProvider();
    const firstIndex = await parser.indexRepository({ repositoryRoot });
    const originalCryptoRecord = firstIndex.files.find((file) => file.path === "src/crypto.ts");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(authPath, "export function loginUser() { return false; }", "utf8");

    const secondIndex = await parser.indexRepository({
      repositoryRoot,
      existingIndex: firstIndex
    });

    const nextCryptoRecord = secondIndex.files.find((file) => file.path === "src/crypto.ts");
    const nextAuthRecord = secondIndex.files.find((file) => file.path === "src/auth.ts");

    expect(secondIndex.metrics.changedFiles).toBe(1);
    expect(secondIndex.metrics.reusedFiles).toBe(2);
    expect(secondIndex.metrics.reusedChunks).toBeGreaterThan(0);
    expect(nextCryptoRecord).toEqual(originalCryptoRecord);
    expect(nextAuthRecord?.symbols.map((symbol) => symbol.name)).toContain("loginUser");
  });
});

async function createTempRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nomic-indexer-"));
  tempDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  return root;
}
