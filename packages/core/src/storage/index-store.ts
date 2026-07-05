import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
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
  constructor(private readonly cacheRoot = getDefaultCacheRoot()) {}

  async readIndex(repositoryRoot: string): Promise<RepositoryIndex | null> {
    try {
      const filePath = this.getIndexFilePath(repositoryRoot);
      const contents = await readFile(filePath, "utf8");
      return JSON.parse(contents) as RepositoryIndex;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return this.readLegacyIndex(repositoryRoot);
      }

      throw error;
    }
  }

  async writeIndex(index: RepositoryIndex): Promise<void> {
    const directoryPath = path.dirname(this.getIndexFilePath(index.repositoryRoot));
    await mkdir(directoryPath, { recursive: true });
    const destination = this.getIndexFilePath(index.repositoryRoot);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(index), "utf8");
    await rename(temporary, destination);
  }

  getRepositoryCacheDirectory(repositoryRoot: string): string {
    return getNomicRepositoryCacheDirectory(repositoryRoot, this.cacheRoot);
  }

  private getIndexFilePath(repositoryRoot: string): string {
    return path.join(this.getRepositoryCacheDirectory(repositoryRoot), "index.json");
  }

  private async readLegacyIndex(repositoryRoot: string): Promise<RepositoryIndex | null> {
    try {
      const contents = await readFile(path.join(repositoryRoot, ".nomic", "index.json"), "utf8");
      const index = JSON.parse(contents) as RepositoryIndex;
      await this.writeIndex(index);
      return index;
    } catch (error: unknown) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }
}

function getDefaultCacheRoot(): string {
  if (process.env.NOMIC_CACHE_DIR) return path.resolve(process.env.NOMIC_CACHE_DIR);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "Nomic");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "Nomic");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "nomic");
}

export function getNomicRepositoryCacheDirectory(repositoryRoot: string, cacheRoot = getDefaultCacheRoot()): string {
  let canonicalRoot = path.resolve(repositoryRoot);
  try { canonicalRoot = realpathSync.native(canonicalRoot); } catch { /* The indexer will report a missing root. */ }
  const id = createHash("sha256").update(canonicalRoot).digest("hex");
  return path.join(cacheRoot, "repositories", id);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
