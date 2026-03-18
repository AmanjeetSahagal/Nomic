import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  type FileRecord,
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
    const nextRelativePaths = new Set(filePaths.map((filePath) => path.relative(repositoryRoot, filePath)));
    const metrics = {
      addedFiles: 0,
      changedFiles: 0,
      removedFiles: 0,
      reusedFiles: 0
    };

    const files = await Promise.all(
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
          return previousFile;
        }

        if (previousFile) {
          metrics.changedFiles += 1;
        } else {
          metrics.addedFiles += 1;
        }

        return buildFileRecord(repositoryRoot, filePath, fileStats.mtimeMs, fileStats.size);
      })
    );

    for (const previousPath of previousFiles.keys()) {
      if (!nextRelativePaths.has(previousPath)) {
        metrics.removedFiles += 1;
      }
    }

    return {
      repositoryRoot,
      fileCount: files.length,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
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

async function buildFileRecord(
  repositoryRoot: string,
  filePath: string,
  modifiedAtMs?: number,
  size?: number
): Promise<FileRecord> {
  const fileContents = await readFile(filePath, "utf8");
  const fileStats = modifiedAtMs === undefined || size === undefined ? await stat(filePath) : null;
  const relativePath = path.relative(repositoryRoot, filePath);

  return {
    path: relativePath,
    language: detectLanguage(relativePath),
    size: size ?? fileStats?.size ?? 0,
    modifiedAtMs: modifiedAtMs ?? fileStats?.mtimeMs ?? 0,
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
  const symbols: IndexedSymbol[] = [
    {
      name: path.basename(filePath),
      kind: isTestFile(filePath) ? "test" : "module",
      path: filePath
    }
  ];

  const patterns: Array<{ kind: IndexedSymbol["kind"]; regex: RegExp }> = [
    { kind: "class", regex: /\bclass\s+([A-Za-z_$][\w$]*)/g },
    { kind: "interface", regex: /\binterface\s+([A-Za-z_$][\w$]*)/g },
    { kind: "function", regex: /\bfunction\s+([A-Za-z_$][\w$]*)/g },
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
        name,
        kind,
        path: filePath
      });
      seen.add(key);
    }
  }

  return symbols;
}
