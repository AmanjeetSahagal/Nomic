import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ContextCandidate,
  EmbeddingProvider,
  IndexRepositoryRequest,
  ParserProvider,
  RepositoryIndex,
  UserTask
} from "../types/contracts";

export interface NativeIndexStats {
  discoveredFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  indexedTerms: number;
  indexBytes: number;
  schemaVersion: number;
}

export interface NativeSearchCandidate {
  fileId: string;
  path: string;
  lexicalScore: number;
}

export interface NativeFileChange {
  path: string;
  kind: "created" | "changed" | "deleted";
}

export interface NativeDependency {
  symbolId: string;
  path: string;
  kind: string;
  distance: number;
}

interface NativeAddon {
  openRepository(repositoryRoot: string): Promise<NativeIndexStats>;
  updateFiles(changes: NativeFileChange[]): Promise<NativeIndexStats>;
  search(query: string, limit: number): Promise<NativeSearchCandidate[]>;
  getDependencies(symbolId: string, depth: number): Promise<NativeDependency[]>;
  closeRepository(): Promise<void>;
}

export class NativeIndexClient {
  private openedRepositoryRoot?: string;

  private constructor(private readonly addon: NativeAddon, readonly addonPath: string) {}

  static load(addonPath = resolveAddonPath()): NativeIndexClient {
    if (!existsSync(addonPath)) {
      throw new Error(`Nomic native addon not found at ${addonPath}. Run npm run native:build or use NOMIC_INDEX_BACKEND=typescript.`);
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require(addonPath) as NativeAddon;
    return new NativeIndexClient(addon, addonPath);
  }

  static diagnostics(addonPath = resolveAddonPath()): { available: boolean; addonPath: string } {
    return { available: existsSync(addonPath), addonPath };
  }

  async openRepository(repositoryRoot: string): Promise<NativeIndexStats> {
    const stats = await this.addon.openRepository(repositoryRoot);
    this.openedRepositoryRoot = path.resolve(repositoryRoot);
    return stats;
  }

  async ensureRepository(repositoryRoot: string): Promise<void> {
    if (this.openedRepositoryRoot !== path.resolve(repositoryRoot)) {
      await this.openRepository(repositoryRoot);
    }
  }

  search(query: string, limit = 50): Promise<NativeSearchCandidate[]> {
    return this.addon.search(query, limit);
  }

  updateFiles(changes: NativeFileChange[]): Promise<NativeIndexStats> {
    return this.addon.updateFiles(changes);
  }

  getDependencies(symbolId: string, depth = 1): Promise<NativeDependency[]> {
    return this.addon.getDependencies(symbolId, depth);
  }

  async closeRepository(): Promise<void> {
    await this.addon.closeRepository();
    this.openedRepositoryRoot = undefined;
  }
}

export class NativeMirrorParserProvider implements ParserProvider {
  readonly name = "native-mirror-parser";

  constructor(
    private readonly client: NativeIndexClient,
    private readonly fallback: ParserProvider
  ) {}

  async indexRepository(request: IndexRepositoryRequest): Promise<RepositoryIndex> {
    await this.client.openRepository(request.repositoryRoot);
    const index = await this.fallback.indexRepository(request);
    return { ...index, backend: "native" };
  }
}

export class NativeLexicalProvider implements EmbeddingProvider {
  readonly name = "native-bm25-provider";

  constructor(private readonly client: NativeIndexClient) {}

  async search(task: UserTask, index: RepositoryIndex): Promise<ContextCandidate[]> {
    await this.client.ensureRepository(index.repositoryRoot);
    const results = await this.client.search(task.text, 50);
    return results.flatMap((result): ContextCandidate[] => {
      const file = index.files.find((candidate) => candidate.path === result.path);
      if (!file) {
        return [];
      }
      return [{
        path: result.path,
        reason: `Native BM25 lexical match (${result.lexicalScore.toFixed(3)})`,
        score: result.lexicalScore,
        source: "lexical",
        role: file.isTest ? "test" : "primary",
        stage: "semantic",
        dependencyDistance: 0,
        structuralScore: 0,
        semanticScore: 0,
        lexicalScore: result.lexicalScore,
        recencyScore: 0,
        fileImportanceScore: Math.max(1, file.symbols.length),
        tokenCost: Math.ceil(file.size / 4),
        chunkIds: index.chunks.filter((chunk) => chunk.filePath === result.path).map((chunk) => chunk.id),
        expansionPath: [result.path]
      }];
    });
  }
}

function resolveAddonPath(): string {
  return process.env.NOMIC_NATIVE_ADDON_PATH ?? path.resolve(__dirname, "../../../../native/build/nomic_native.node");
}
