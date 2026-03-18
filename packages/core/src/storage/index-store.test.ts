import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStorageBackend } from "./index-store";
import type { RepositoryIndex } from "../types/contracts";

const tempDirectories: string[] = [];

describe("FileStorageBackend", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map(async (directory) => {
        await import("node:fs/promises").then(({ rm }) => rm(directory, { force: true, recursive: true }));
      })
    );
  });

  it("writes and reads indexes from .nomic/index.json", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "nomic-store-"));
    tempDirectories.push(repositoryRoot);
    await mkdir(repositoryRoot, { recursive: true });

    const backend = new FileStorageBackend();
    const index: RepositoryIndex = {
      repositoryRoot,
      fileCount: 1,
      generatedAt: new Date().toISOString(),
      metrics: {
        addedFiles: 1,
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
          symbols: [{ name: "auth.ts", kind: "module", path: "src/auth.ts" }]
        }
      ]
    };

    await backend.writeIndex(index);

    const raw = await readFile(path.join(repositoryRoot, ".nomic", "index.json"), "utf8");
    const restored = await backend.readIndex(repositoryRoot);

    expect(JSON.parse(raw)).toEqual(index);
    expect(restored).toEqual(index);
  });
});
