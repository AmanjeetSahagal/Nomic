import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

  it("indexes source files, symbols, imports, and tests", async () => {
    const repositoryRoot = await createTempRepository();

    await writeFile(
      path.join(repositoryRoot, "src", "auth.ts"),
      [
        'import { hashPassword } from "./crypto";',
        "",
        "export class AuthService {}",
        "export function loginUser() {}"
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
      'import { loginUser } from "../src/auth";',
      "utf8"
    );
    await writeFile(path.join(repositoryRoot, "node_modules", "ignored.ts"), "export const ignored = true;", "utf8");

    const parser = new FilesystemParserProvider();
    const index = await parser.indexRepository({ repositoryRoot });

    expect(index.fileCount).toBe(3);
    expect(index.files.map((file) => file.path)).toEqual(["src/auth.ts", "src/crypto.ts", "tests/auth.test.ts"]);

    const authFile = index.files.find((file) => file.path === "src/auth.ts");
    expect(authFile).toMatchObject({
      language: "typescript",
      isTest: false,
      imports: ["./crypto"]
    });
    expect(authFile?.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["auth.ts", "AuthService", "loginUser"])
    );

    const testFile = index.files.find((file) => file.path === "tests/auth.test.ts");
    expect(testFile?.isTest).toBe(true);
  });
});

async function createTempRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nomic-indexer-"));
  tempDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  return root;
}
