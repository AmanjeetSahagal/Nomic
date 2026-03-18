import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  type ChunkRecord,
  type FileRecord,
  type IndexEdge,
  type IndexRepositoryRequest,
  type IndexedSymbol,
  type ParserProvider,
  type RepositoryIndex
} from "../types/contracts";

export class RepositoryIndexer {
  constructor(private readonly parser: ParserProvider) {}

  async index(request: IndexRepositoryRequest): Promise<RepositoryIndex> {
    return this.parser.indexRepository(request);
  }
}

export class FilesystemParserProvider implements ParserProvider {
  readonly name = "filesystem-parser";

  async indexRepository(request: IndexRepositoryRequest): Promise<RepositoryIndex> {
    const repositoryRoot = path.resolve(request.repositoryRoot);
    const filePaths = await walkRepository(repositoryRoot);
    const previousFiles = new Map(
      (request.existingIndex?.files ?? []).map((file) => [file.path, file] satisfies [string, FileRecord])
    );
    const previousChunksByFile = groupChunksByFile(request.existingIndex?.chunks ?? []);
    const nextRelativePaths = new Set(filePaths.map((filePath) => path.relative(repositoryRoot, filePath)));
    const metrics = {
      addedFiles: 0,
      changedFiles: 0,
      removedFiles: 0,
      reusedFiles: 0,
      reusedChunks: 0,
      reusedEdges: 0
    };

    const fileEntries = await Promise.all(
      filePaths.map(async (filePath) => {
        const relativePath = path.relative(repositoryRoot, filePath);
        const fileStats = await stat(filePath);
        const previousFile = previousFiles.get(relativePath);

        if (
          previousFile &&
          previousFile.size === fileStats.size &&
          previousFile.modifiedAtMs === fileStats.mtimeMs
        ) {
          metrics.reusedFiles += 1;
          metrics.reusedChunks += previousChunksByFile.get(relativePath)?.length ?? 0;
          return {
            file: previousFile,
            content: await readFile(filePath, "utf8"),
            reused: true
          };
        }

        if (previousFile) {
          metrics.changedFiles += 1;
        } else {
          metrics.addedFiles += 1;
        }

        const content = await readFile(filePath, "utf8");
        return {
          file: buildFileRecord(repositoryRoot, filePath, content, fileStats.mtimeMs, fileStats.size),
          content,
          reused: false
        };
      })
    );

    for (const previousPath of previousFiles.keys()) {
      if (!nextRelativePaths.has(previousPath)) {
        metrics.removedFiles += 1;
      }
    }

    const files = fileEntries.map((entry) => entry.file).sort((left, right) => left.path.localeCompare(right.path));
    const symbols = files.flatMap((file) => file.symbols);
    const symbolMap = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    const chunks = fileEntries.flatMap((entry) => {
      if (entry.reused) {
        return previousChunksByFile.get(entry.file.path) ?? createChunks(entry.file, entry.content);
      }

      return createChunks(entry.file, entry.content);
    });
    const edges = buildEdges(files, fileEntries, symbolMap);
    metrics.reusedEdges = Math.min(request.existingIndex?.edges.length ?? 0, edges.length);

    return {
      repositoryRoot,
      fileCount: files.length,
      files,
      symbols,
      chunks,
      edges,
      generatedAt: new Date().toISOString(),
      metrics
    };
  }
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nomic",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp"
]);

const TEXT_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

async function walkRepository(repositoryRoot: string): Promise<string[]> {
  const pending = [repositoryRoot];
  const files: string[] = [];

  while (pending.length > 0) {
    const currentDirectory = pending.pop();
    if (!currentDirectory) {
      continue;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (shouldIndexFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function shouldIndexFile(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  if (TEXT_FILE_EXTENSIONS.has(extension)) {
    return true;
  }

  return fileName === "Dockerfile" || fileName.endsWith(".env.example");
}

function buildFileRecord(
  repositoryRoot: string,
  filePath: string,
  fileContents: string,
  modifiedAtMs?: number,
  size?: number
): FileRecord {
  const relativePath = path.relative(repositoryRoot, filePath);

  return {
    path: relativePath,
    language: detectLanguage(relativePath),
    size: size ?? 0,
    modifiedAtMs: modifiedAtMs ?? 0,
    imports: extractImports(fileContents),
    isTest: isTestFile(relativePath),
    symbols: extractSymbols(relativePath, fileContents)
  };
}

function detectLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const languageMap: Record<string, string> = {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".go": "go",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "javascriptreact",
    ".md": "markdown",
    ".mjs": "javascript",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "shell",
    ".sql": "sql",
    ".swift": "swift",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".txt": "text",
    ".yaml": "yaml",
    ".yml": "yaml"
  };

  return languageMap[extension] ?? "text";
}

function isTestFile(filePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)\/|(\.|_)(test|spec)\./i.test(filePath);
}

function extractImports(fileContents: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'"]+from\s+)?["']([^"']+)["']/g,
    /export\s+[^'"]+from\s+["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /from\s+["']([^"']+)["']/g
  ];

  for (const pattern of patterns) {
    for (const match of fileContents.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) {
        imports.add(value);
      }
    }
  }

  return [...imports].sort((left, right) => left.localeCompare(right));
}

function extractSymbols(filePath: string, fileContents: string): IndexedSymbol[] {
  const moduleKind = isTestFile(filePath) ? "test" : "module";
  const symbols: IndexedSymbol[] = [
    {
      id: `${filePath}#module`,
      name: path.basename(filePath),
      kind: moduleKind,
      path: filePath,
      exported: true
    }
  ];

  const patterns: Array<{ kind: IndexedSymbol["kind"]; regex: RegExp }> = [
    { kind: "class", regex: /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g },
    { kind: "class", regex: /\bclass\s+([A-Za-z_$][\w$]*)/g },
    { kind: "interface", regex: /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g },
    { kind: "interface", regex: /\binterface\s+([A-Za-z_$][\w$]*)/g },
    { kind: "function", regex: /\bexport\s+function\s+([A-Za-z_$][\w$]*)/g },
    { kind: "function", regex: /\bfunction\s+([A-Za-z_$][\w$]*)/g },
    { kind: "function", regex: /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g },
    { kind: "function", regex: /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g },
    { kind: "function", regex: /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g },
    { kind: "function", regex: /\bdef\s+([A-Za-z_][\w]*)/g }
  ];

  const seen = new Set(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`));

  for (const { kind, regex } of patterns) {
    for (const match of fileContents.matchAll(regex)) {
      const name = match[1]?.trim();
      const key = `${kind}:${name}`;
      if (!name || seen.has(key)) {
        continue;
      }

      symbols.push({
        id: `${filePath}#${kind}:${name}`,
        name,
        kind,
        path: filePath,
        exported: /export\s+/.test(match[0] ?? "")
      });
      seen.add(key);
    }
  }

  return symbols;
}

function createChunks(file: FileRecord, fileContents: string): ChunkRecord[] {
  const lines = fileContents.split(/\r?\n/);
  const kind = file.isTest ? "test" : file.language === "markdown" ? "doc" : "code";
  const chunks: ChunkRecord[] = [];
  const chunkSize = kind === "doc" ? 12 : 24;

  for (let start = 0; start < lines.length; start += chunkSize) {
    const end = Math.min(lines.length, start + chunkSize);
    const text = lines.slice(start, end).join("\n").trim();
    if (!text) {
      continue;
    }

    chunks.push({
      id: `${file.path}#${start + 1}-${end}`,
      filePath: file.path,
      kind,
      startLine: start + 1,
      endLine: end,
      tokenEstimate: estimateTextTokens(text),
      text
    });
  }

  return chunks;
}

function buildEdges(
  files: FileRecord[],
  fileEntries: Array<{ file: FileRecord; content: string }>,
  symbolMap: Map<string, IndexedSymbol>
): IndexEdge[] {
  const edges = new Map<string, IndexEdge>();
  const fileMap = new Map(files.map((file) => [file.path, file]));

  for (const file of files) {
    for (const importValue of file.imports) {
      const target = resolveImportTarget(file.path, importValue, fileMap);
      if (!target) {
        continue;
      }

      setEdge(edges, {
        from: file.path,
        to: target.path,
        kind: "import",
        weight: 5
      });
      setEdge(edges, {
        from: target.path,
        to: file.path,
        kind: "caller",
        weight: 3
      });
      setEdge(edges, {
        from: file.path,
        to: target.path,
        kind: "callee",
        weight: 3
      });
    }
  }

  for (const { file, content } of fileEntries) {
    for (const symbol of symbolMap.values()) {
      if (symbol.path === file.path) {
        continue;
      }

      const pattern = new RegExp(`\\b${escapeForRegExp(symbol.name)}\\b`);
      if (!pattern.test(content)) {
        continue;
      }

      setEdge(edges, {
        from: file.path,
        to: symbol.path,
        kind: "reference",
        weight: 2
      });
    }
  }

  for (const file of files.filter((candidate) => candidate.isTest)) {
    for (const importValue of file.imports) {
      const target = resolveImportTarget(file.path, importValue, fileMap);
      if (!target) {
        continue;
      }

      setEdge(edges, {
        from: file.path,
        to: target.path,
        kind: "test",
        weight: 4
      });
    }
  }

  return [...edges.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to)
  );
}

function groupChunksByFile(chunks: ChunkRecord[]): Map<string, ChunkRecord[]> {
  const grouped = new Map<string, ChunkRecord[]>();

  for (const chunk of chunks) {
    const existing = grouped.get(chunk.filePath);
    if (existing) {
      existing.push(chunk);
      continue;
    }

    grouped.set(chunk.filePath, [chunk]);
  }

  return grouped;
}

function resolveImportTarget(
  sourcePath: string,
  importValue: string,
  fileMap: Map<string, FileRecord>
): FileRecord | null {
  const normalizedImport = normalizeModulePath(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), importValue)));

  for (const candidate of fileMap.values()) {
    const normalizedCandidate = normalizeModulePath(candidate.path);
    if (
      normalizedCandidate === normalizedImport ||
      normalizedCandidate.endsWith(`/${normalizedImport}`) ||
      normalizedImport.endsWith(`/${normalizedCandidate}`)
    ) {
      return candidate;
    }
  }

  return null;
}

function normalizeModulePath(value: string): string {
  return value.replace(/\.(tsx?|jsx?|mjs|py|md|json)$/i, "").replace(/\/index$/i, "");
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function setEdge(edges: Map<string, IndexEdge>, edge: IndexEdge): void {
  edges.set(`${edge.kind}:${edge.from}:${edge.to}`, edge);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
