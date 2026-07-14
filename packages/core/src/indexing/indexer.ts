import { open, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import ts from "typescript";
import {
  type ChunkRecord,
  type FileRecord,
  type IndexEdge,
  type IndexRepositoryRequest,
  type IndexedSymbol,
  type IndexingMetrics,
  type ParserProvider,
  type RepositoryIndex
} from "../types/contracts";

interface ParsedFileDetails {
  imports: string[];
  symbols: IndexedSymbol[];
  references: string[];
  calls: string[];
  importedBindings: Array<{ localName: string; source: string }>;
}

export class RepositoryIndexer {
  constructor(private readonly parser: ParserProvider) {}

  async index(request: IndexRepositoryRequest): Promise<RepositoryIndex> {
    return this.parser.indexRepository(request);
  }
}

export class FilesystemParserProvider implements ParserProvider {
  readonly name = "filesystem-parser";

  async indexRepository(request: IndexRepositoryRequest): Promise<RepositoryIndex> {
    const startedAt = performance.now();
    const repositoryRoot = path.resolve(request.repositoryRoot);
    if (request.changedPaths && request.existingIndex) {
      return updateChangedPaths(repositoryRoot, request.existingIndex, request.changedPaths, request, startedAt);
    }
    request.onProgress?.({ phase: "scan", completed: 0 });
    const filePaths = await walkRepository(repositoryRoot, request);
    const scanMs = performance.now() - startedAt;
    const previousFiles = new Map(
      (request.existingIndex?.files ?? []).map((file) => [file.path, file] satisfies [string, FileRecord])
    );
    const previousChunksByFile = groupChunksByFile(request.existingIndex?.chunks ?? []);
    const nextRelativePaths = new Set(filePaths.map((filePath) => path.relative(repositoryRoot, filePath)));
    const metrics: IndexingMetrics = {
      addedFiles: 0,
      changedFiles: 0,
      removedFiles: 0,
      reusedFiles: 0,
      reusedChunks: 0,
      reusedEdges: 0
    };

    const parseStartedAt = performance.now();
    const fileEntries = await Promise.all(
      filePaths.map(async (filePath) => {
        if (request.signal?.aborted) {
          throw new Error("Repository indexing cancelled.");
        }
        const relativePath = path.relative(repositoryRoot, filePath);
        const fileStats = await stat(filePath);
        const previousFile = previousFiles.get(relativePath);
        const content = await readFile(filePath, "utf8");
        const contentHash = createHash("sha256").update(content).digest("hex");

        if (
          previousFile &&
          ((previousFile.contentHash && previousFile.contentHash === contentHash) ||
            (!previousFile.contentHash && previousFile.size === fileStats.size && previousFile.modifiedAtMs === fileStats.mtimeMs))
        ) {
          metrics.reusedFiles += 1;
          metrics.reusedChunks += previousChunksByFile.get(relativePath)?.length ?? 0;
          return {
            file: { ...previousFile, size: fileStats.size, modifiedAtMs: fileStats.mtimeMs, contentHash },
            content,
            parsed: parseFile(relativePath, content),
            reused: true
          };
        }

        if (previousFile) {
          metrics.changedFiles += 1;
        } else {
          metrics.addedFiles += 1;
        }

        const parsed = parseFile(relativePath, content);
        return {
          file: { ...buildFileRecord(relativePath, parsed, fileStats.mtimeMs, fileStats.size), contentHash },
          content,
          parsed,
          reused: false
        };
      })
    );
    const parseMs = performance.now() - parseStartedAt;
    metrics.parsedFiles = fileEntries.filter((entry) => !entry.reused).length;
    metrics.failedFiles = 0;
    metrics.schemaVersion = 1;
    request.onProgress?.({ phase: "parse", completed: fileEntries.length, total: filePaths.length });

    for (const previousPath of previousFiles.keys()) {
      if (!nextRelativePaths.has(previousPath)) {
        metrics.removedFiles += 1;
      }
    }

    const featureStartedAt = performance.now();
    const files = fileEntries.map((entry) => entry.file).sort((left, right) => left.path.localeCompare(right.path));
    const symbols = files.flatMap((file) => file.symbols);
    const symbolMap = new Map(
      symbols
        .filter((symbol) => symbol.kind !== "module" && symbol.kind !== "test")
        .map((symbol) => [symbol.name, symbol] satisfies [string, IndexedSymbol])
    );
    const fileMap = new Map(files.map((file) => [file.path, file] satisfies [string, FileRecord]));
    const chunks = fileEntries.flatMap((entry) => {
      if (entry.reused) {
        return previousChunksByFile.get(entry.file.path) ?? createChunks(entry.file, entry.content);
      }

      return createChunks(entry.file, entry.content);
    });
    const edges = buildEdges(files, fileEntries, fileMap, symbolMap);
    metrics.reusedEdges = Math.min(request.existingIndex?.edges.length ?? 0, edges.length);
    metrics.wallTimeMs = performance.now() - startedAt;
    metrics.stageTimingsMs = { scan: scanMs, parse: parseMs, featureExtraction: performance.now() - featureStartedAt };
    request.onProgress?.({ phase: "persist", completed: files.length, total: files.length });

    return {
      backend: "typescript",
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

async function updateChangedPaths(
  repositoryRoot: string,
  existingIndex: RepositoryIndex,
  requestedPaths: string[],
  request: IndexRepositoryRequest,
  startedAt: number
): Promise<RepositoryIndex> {
  const normalizedPaths = [...new Set(requestedPaths.map((candidate) => {
    const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(repositoryRoot, candidate);
    const prefix = repositoryRoot.endsWith(path.sep) ? repositoryRoot : `${repositoryRoot}${path.sep}`;
    if (!absolute.startsWith(prefix)) throw new Error(`Changed path escapes repository root: ${candidate}`);
    return path.relative(repositoryRoot, absolute).split(path.sep).join("/");
  }))];
  const affected = new Set(normalizedPaths);
  const existingFiles = new Map(existingIndex.files.map((file) => [file.path, file]));
  const parsedEntries: Array<{ file: FileRecord; content: string; parsed: ParsedFileDetails }> = [];
  let addedFiles = 0;
  let changedFiles = 0;
  let removedFiles = 0;

  for (const relativePath of normalizedPaths) {
    if (request.signal?.aborted) throw new Error("Repository indexing cancelled.");
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (isSecretLikePath(relativePath)) {
      if (existingFiles.delete(relativePath)) removedFiles += 1;
      continue;
    }
    try {
      const fileStats = await stat(absolutePath);
      if (!fileStats.isFile() || fileStats.size > (request.maxFileSizeBytes ?? 1_000_000) || !shouldIndexFile(relativePath, request.extensions ? new Set(request.extensions) : TEXT_FILE_EXTENSIONS)) {
        if (existingFiles.delete(relativePath)) removedFiles += 1;
        continue;
      }
      const content = await readFile(absolutePath, "utf8");
      if (content.includes("\0")) {
        if (existingFiles.delete(relativePath)) removedFiles += 1;
        continue;
      }
      const parsed = parseFile(relativePath, content);
      const contentHash = createHash("sha256").update(content).digest("hex");
      const previous = existingFiles.get(relativePath);
      if (previous?.contentHash === contentHash) continue;
      if (previous) changedFiles += 1; else addedFiles += 1;
      const file = { ...buildFileRecord(relativePath, parsed, fileStats.mtimeMs, fileStats.size), contentHash };
      existingFiles.set(relativePath, file);
      parsedEntries.push({ file, content, parsed });
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        if (existingFiles.delete(relativePath)) removedFiles += 1;
        continue;
      }
      throw error;
    }
  }

  const files = [...existingFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
  const symbols = files.flatMap((file) => file.symbols);
  const chunks = [
    ...existingIndex.chunks.filter((chunk) => !affected.has(chunk.filePath)),
    ...parsedEntries.flatMap((entry) => createChunks(entry.file, entry.content))
  ].sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine);
  const fileMap = new Map(files.map((file) => [file.path, file]));
  const symbolMap = new Map(symbols.filter((symbol) => symbol.kind !== "module" && symbol.kind !== "test").map((symbol) => [symbol.name, symbol]));
  const edges = [
    ...existingIndex.edges.filter((edge) => !affected.has(edge.from) && !affected.has(edge.to)),
    ...buildEdges(files, parsedEntries, fileMap, symbolMap)
  ].filter((edge, index, values) => values.findIndex((candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.kind === edge.kind) === index)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const metrics: IndexingMetrics = {
    addedFiles,
    changedFiles,
    removedFiles,
    reusedFiles: Math.max(0, files.length - parsedEntries.length),
    reusedChunks: existingIndex.chunks.filter((chunk) => !affected.has(chunk.filePath)).length,
    reusedEdges: existingIndex.edges.filter((edge) => !affected.has(edge.from) && !affected.has(edge.to)).length,
    parsedFiles: parsedEntries.length,
    failedFiles: 0,
    schemaVersion: 1,
    wallTimeMs: performance.now() - startedAt
  };
  request.onProgress?.({ phase: "persist", completed: normalizedPaths.length, total: normalizedPaths.length });
  return { ...existingIndex, repositoryRoot, fileCount: files.length, files, symbols, chunks, edges, generatedAt: new Date().toISOString(), metrics };
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".aws",
  ".azure",
  ".gcloud",
  ".next",
  ".nomic",
  ".ssh",
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

async function walkRepository(repositoryRoot: string, request: IndexRepositoryRequest): Promise<string[]> {
  const pending = [repositoryRoot];
  const files: string[] = [];
  const ignoreRules = request.respectGitignore === false ? [] : await loadIgnoreRules(repositoryRoot);
  const maximumFileSize = request.maxFileSizeBytes ?? 1024 * 1024;
  const extensions = request.extensions ? new Set(request.extensions.map((extension) => extension.toLowerCase())) : TEXT_FILE_EXTENSIONS;

  while (pending.length > 0) {
    const currentDirectory = pending.pop();
    if (!currentDirectory) {
      continue;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(repositoryRoot, fullPath).split(path.sep).join("/");
      if (isSecretLikePath(relativePath)) {
        continue;
      }
      if (matchesExcludedPath(relativePath, request.excludedPaths ?? [])) {
        continue;
      }
      if (matchesIgnoreRules(relativePath, entry.isDirectory(), ignoreRules)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileStats = await stat(fullPath);
      if (fileStats.size <= maximumFileSize && shouldIndexFile(entry.name, extensions) && await isProbablyTextFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function matchesExcludedPath(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/^\//, "");
    if (normalized.endsWith("/") && relativePath.startsWith(normalized)) return true;
    const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}(?:$|/)`).test(relativePath);
  });
}

async function isProbablyTextFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function shouldIndexFile(fileName: string, extensions: Set<string> = TEXT_FILE_EXTENSIONS): boolean {
  const extension = path.extname(fileName).toLowerCase();
  if (extensions.has(extension)) {
    return true;
  }

  return fileName === "Dockerfile" || fileName.endsWith(".env.example");
}

function isSecretLikePath(relativePath: string): boolean {
  const parts = relativePath.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return name === ".env" || name.startsWith(".env.") || /\.(pem|key|p12|pfx)$/.test(name) || parts.some((part) => [".ssh", ".aws", ".azure", ".gcloud"].includes(part)) || /(credential|credentials|secrets?)\.(json|ya?ml|toml|ini)$/.test(name);
}

interface IgnoreRule { negated: boolean; directoryOnly: boolean; matcher: RegExp }

async function loadIgnoreRules(repositoryRoot: string): Promise<IgnoreRule[]> {
  try {
    const contents = await readFile(path.join(repositoryRoot, ".gitignore"), "utf8");
    return contents.split(/\r?\n/).flatMap((line): IgnoreRule[] => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const negated = trimmed.startsWith("!");
      const raw = (negated ? trimmed.slice(1) : trimmed).replace(/^\//, "");
      const directoryOnly = raw.endsWith("/");
      const pattern = raw.replace(/\/$/, "");
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*").replace(/\?/g, "[^/]");
      const prefix = pattern.includes("/") ? "^" : "(^|.*/)";
      return [{ negated, directoryOnly, matcher: new RegExp(`${prefix}${escaped}($|/)`) }];
    });
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function matchesIgnoreRules(relativePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if ((!rule.directoryOnly || isDirectory || relativePath.includes("/")) && rule.matcher.test(relativePath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function buildFileRecord(relativePath: string, parsed: ParsedFileDetails, modifiedAtMs?: number, size?: number): FileRecord {
  return {
    path: relativePath,
    language: detectLanguage(relativePath),
    size: size ?? 0,
    modifiedAtMs: modifiedAtMs ?? 0,
    imports: parsed.imports,
    isTest: isTestFile(relativePath),
    symbols: parsed.symbols
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

function parseFile(filePath: string, fileContents: string): ParsedFileDetails {
  if (isTypeScriptLike(filePath)) {
    try {
      return parseTypeScriptFile(filePath, fileContents);
    } catch {
      return parseFileWithRegex(filePath, fileContents);
    }
  }

  return parseFileWithRegex(filePath, fileContents);
}

function parseFileWithRegex(filePath: string, fileContents: string): ParsedFileDetails {
  const imports = extractImports(fileContents);
  return {
    imports,
    symbols: extractRegexSymbols(filePath, fileContents),
    references: extractReferenceNames(fileContents),
    calls: extractCallNames(fileContents),
    importedBindings: []
  };
}

function parseTypeScriptFile(filePath: string, fileContents: string): ParsedFileDetails {
  const sourceFile = ts.createSourceFile(filePath, fileContents, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
  const imports = new Set<string>();
  const references = new Set<string>();
  const calls = new Set<string>();
  const importedBindings: Array<{ localName: string; source: string }> = [];
  const symbols: IndexedSymbol[] = [
    {
      id: `${filePath}#module`,
      name: path.basename(filePath),
      qualifiedName: path.basename(filePath),
      kind: isTestFile(filePath) ? "test" : "module",
      path: filePath,
      exported: true
    }
  ];
  const seen = new Set(symbols.map((symbol) => symbol.id));

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const source = node.moduleSpecifier.text;
      imports.add(source);
      if (node.importClause) {
        if (node.importClause.name) {
          importedBindings.push({ localName: node.importClause.name.text, source });
        }
        const namedBindings = node.importClause.namedBindings;
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            importedBindings.push({ localName: element.name.text, source });
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    }

    if (ts.isClassDeclaration(node) && node.name) {
      pushSymbol(symbols, seen, filePath, "class", node.name.text, hasExportModifier(node), sourceRange(sourceFile, node));
    } else if (ts.isInterfaceDeclaration(node)) {
      pushSymbol(symbols, seen, filePath, "interface", node.name.text, hasExportModifier(node), sourceRange(sourceFile, node));
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      pushSymbol(symbols, seen, filePath, "function", node.name.text, hasExportModifier(node), sourceRange(sourceFile, node));
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && isFunctionLikeInitializer(declaration.initializer)) {
          pushSymbol(symbols, seen, filePath, "function", declaration.name.text, exported, sourceRange(sourceFile, declaration));
        }
      }
    }

    if (ts.isIdentifier(node) && !shouldIgnoreIdentifier(node)) {
      references.add(node.text);
    }

    if (ts.isCallExpression(node)) {
      const callName = getCalledIdentifier(node.expression);
      if (callName) {
        calls.add(callName);
        references.add(callName);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    imports: [...imports].sort((left, right) => left.localeCompare(right)),
    symbols,
    references: [...references].sort((left, right) => left.localeCompare(right)),
    calls: [...calls].sort((left, right) => left.localeCompare(right)),
    importedBindings
  };
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
  fileEntries: Array<{ file: FileRecord; content: string; parsed: ParsedFileDetails }>,
  fileMap: Map<string, FileRecord>,
  symbolMap: Map<string, IndexedSymbol>
): IndexEdge[] {
  const edges = new Map<string, IndexEdge>();

  for (const entry of fileEntries) {
    for (const importValue of entry.parsed.imports) {
      const target = resolveImportTarget(entry.file.path, importValue, fileMap);
      if (!target) {
        continue;
      }

      setEdge(edges, { from: entry.file.path, to: target.path, kind: "import", weight: 5 });
      setEdge(edges, { from: target.path, to: entry.file.path, kind: "caller", weight: 3 });
      setEdge(edges, { from: entry.file.path, to: target.path, kind: "callee", weight: 3 });
      if (entry.file.isTest) {
        setEdge(edges, { from: entry.file.path, to: target.path, kind: "test", weight: 4 });
      }
    }

    for (const reference of entry.parsed.references) {
      const targetSymbol = symbolMap.get(reference);
      if (!targetSymbol || targetSymbol.path === entry.file.path) {
        continue;
      }

      setEdge(edges, { from: entry.file.path, to: targetSymbol.path, kind: "reference", weight: 2 });
    }

    for (const callName of entry.parsed.calls) {
      const importedBinding = entry.parsed.importedBindings.find((binding) => binding.localName === callName);
      const target = importedBinding
        ? resolveImportTarget(entry.file.path, importedBinding.source, fileMap)
        : symbolMap.get(callName)
          ? fileMap.get(symbolMap.get(callName)?.path ?? "")
          : null;
      if (!target || target.path === entry.file.path) {
        continue;
      }

      setEdge(edges, { from: entry.file.path, to: target.path, kind: "caller", weight: 4 });
      setEdge(edges, { from: entry.file.path, to: target.path, kind: "callee", weight: 4 });
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

function resolveImportTarget(sourcePath: string, importValue: string, fileMap: Map<string, FileRecord>): FileRecord | null {
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

function extractRegexSymbols(filePath: string, fileContents: string): IndexedSymbol[] {
  const moduleKind = isTestFile(filePath) ? "test" : "module";
  const symbols: IndexedSymbol[] = [
    {
      id: `${filePath}#module`,
      name: path.basename(filePath),
      qualifiedName: path.basename(filePath),
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

  const seen = new Set(symbols.map((symbol) => symbol.id));
  for (const { kind, regex } of patterns) {
    for (const match of fileContents.matchAll(regex)) {
      const name = match[1]?.trim();
      if (!name) {
        continue;
      }
      const startLine = fileContents.slice(0, match.index ?? 0).split(/\r?\n/).length;
      pushSymbol(symbols, seen, filePath, kind, name, /export\s+/.test(match[0] ?? ""), { startLine, endLine: startLine });
    }
  }

  return symbols;
}

function extractReferenceNames(fileContents: string): string[] {
  return unique([...fileContents.matchAll(/\b[A-Za-z_$][\w$]*\b/g)].map((match) => match[0])).sort((left, right) =>
    left.localeCompare(right)
  );
}

function extractCallNames(fileContents: string): string[] {
  return unique([...fileContents.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1])).sort((left, right) =>
    left.localeCompare(right)
  );
}

function pushSymbol(
  symbols: IndexedSymbol[],
  seen: Set<string>,
  filePath: string,
  kind: IndexedSymbol["kind"],
  name: string,
  exported: boolean,
  range?: { startLine: number; endLine: number }
): void {
  const id = `${filePath}#${kind}:${name}`;
  if (seen.has(id)) {
    return;
  }

  symbols.push({
    id,
    name,
    qualifiedName: name,
    kind,
    path: filePath,
    exported,
    ...range
  });
  seen.add(id);
}

function sourceRange(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  return {
    startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  };
}

function isTypeScriptLike(filePath: string): boolean {
  return /\.(tsx?|jsx?|mjs)$/i.test(filePath);
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function isFunctionLikeInitializer(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function shouldIgnoreIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isImportDeclaration(parent)) {
    return true;
  }
  if (ts.isExportSpecifier(parent)) {
    return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return true;
  }
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && parent.name === node) {
    return true;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return true;
  }
  return false;
}

function getCalledIdentifier(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
