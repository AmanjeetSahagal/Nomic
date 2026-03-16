import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type RepositoryIndex, type StorageBackend } from "../types/contracts";

export class MemoryStorageBackend implements StorageBackend {
  private readonly indexes = new Map<string, RepositoryIndex>();

  async readIndex(repositoryRoot: string): Promise<RepositoryIndex | null> {
    return this.indexes.get(repositoryRoot) ?? null;
  }

  async writeIndex(index: RepositoryIndex): Promise<void> {
    this.indexes.set(index.repositoryRoot, index);
  }
}

export class FileStorageBackend implements StorageBackend {
  async readIndex(repositoryRoot: string): Promise<RepositoryIndex | null> {
    try {
      const filePath = getIndexFilePath(repositoryRoot);
      const contents = await readFile(filePath, "utf8");
      return JSON.parse(contents) as RepositoryIndex;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  async writeIndex(index: RepositoryIndex): Promise<void> {
    const directoryPath = path.dirname(getIndexFilePath(index.repositoryRoot));
    await mkdir(directoryPath, { recursive: true });
    await writeFile(getIndexFilePath(index.repositoryRoot), JSON.stringify(index, null, 2), "utf8");
  }
}

function getIndexFilePath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".nomic", "index.json");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
