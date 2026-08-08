import { performance } from "node:perf_hooks";
import path from "node:path";
import ts from "typescript";
import type { IndexedSymbol } from "../types/contracts";

export type ExactGraphEdgeKind =
  | "import"
  | "call"
  | "reference"
  | "extends"
  | "implements"
  | "test-to-implementation";

export interface GraphSourceFile {
  path: string;
  content: string;
  isTest: boolean;
  symbols: IndexedSymbol[];
}

export type GraphSourceFileMetadata = Omit<GraphSourceFile, "content">;

export interface ExactGraphEdge {
  from: string;
  to: string;
  kind: ExactGraphEdgeKind;
  confidence: "exact";
  evidence: {
    sourcePath: string;
    line: number;
    symbol?: string;
    module?: string;
    resolution: "module" | "import-binding" | "source-reference";
  };
}

export interface TraversedGraphEdge extends ExactGraphEdge {
  traversalFrom: string;
  traversalTo: string;
  direction: "forward" | "reverse";
}

export interface GraphReachabilityPath {
  seedPath: string;
  seedRank: number;
  targetPath: string;
  hops: number;
  edges: TraversedGraphEdge[];
}

export interface GraphTraversalResult {
  paths: Map<string, GraphReachabilityPath>;
  candidatePaths: string[];
  latencyMs: number;
  truncated: boolean;
}

export interface GraphTraversalOptions {
  maxHops: 1 | 2;
  maxNeighborsPerNode: number;
  maxCandidates: number;
}

export interface PreparedExactCodeGraph {
  adjacency: Map<string, TraversedGraphEdge[]>;
}

const EDGE_PRIORITY: Record<ExactGraphEdgeKind, number> = {
  "test-to-implementation": 0,
  call: 1,
  extends: 2,
  implements: 3,
  import: 4,
  reference: 5
};

export function buildExactCodeGraph(files: GraphSourceFile[]): ExactGraphEdge[] {
  const builder = createGraphBuilder(files);
  for (const file of files) builder.extract(file);
  return builder.finish();
}

export async function buildExactCodeGraphStreaming(
  files: GraphSourceFileMetadata[],
  loadContent: (file: GraphSourceFileMetadata) => Promise<string>
): Promise<{ edges: ExactGraphEdge[]; failedFiles: Array<{ path: string; error: string }> }> {
  const builder = createGraphBuilder(files);
  const failedFiles: Array<{ path: string; error: string }> = [];
  for (const file of files) {
    try {
      builder.extract({ ...file, content: await loadContent(file) });
    } catch (error) {
      failedFiles.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { edges: builder.finish(), failedFiles };
}

function createGraphBuilder(files: GraphSourceFileMetadata[]): {
  extract(file: GraphSourceFile): void;
  finish(): ExactGraphEdge[];
} {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const normalizedPaths = new Map<string, string[]>();
  for (const file of files) {
    const normalized = normalizeModulePath(file.path);
    normalizedPaths.set(normalized, [...(normalizedPaths.get(normalized) ?? []), file.path]);
  }
  const edges = new Map<string, ExactGraphEdge>();
  const add = (edge: ExactGraphEdge): void => {
    if (edge.from === edge.to || !filesByPath.has(edge.from) || !filesByPath.has(edge.to)) return;
    const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
    const existing = edges.get(key);
    if (!existing || compareEvidence(edge, existing) < 0) edges.set(key, edge);
  };
  const context: ExtractionContext = { filesByPath, normalizedPaths, add };
  return {
    extract(file): void {
      if (/\.(?:tsx?|jsx?|mjs|cjs)$/i.test(file.path)) extractTypeScriptEdges(file, context);
      else if (/\.pyi?$/i.test(file.path)) extractPythonEdges(file, context);
      else extractImportFallbacks(file, context);
    },
    finish(): ExactGraphEdge[] {
      const sourceEdges = [...edges.values()];
      for (const edge of sourceEdges) {
        const source = filesByPath.get(edge.from);
        const target = filesByPath.get(edge.to);
        if (!source?.isTest || target?.isTest || !["import", "call", "reference"].includes(edge.kind)) continue;
        add({ ...edge, kind: "test-to-implementation" });
      }
      return [...edges.values()].sort(compareEdges);
    }
  };
}

export function traverseExactCodeGraph(
  edges: ExactGraphEdge[],
  seeds: Array<{ path: string; rank: number }>,
  options: GraphTraversalOptions
): GraphTraversalResult {
  return traversePreparedExactCodeGraph(prepareExactCodeGraph(edges), seeds, options);
}

export function prepareExactCodeGraph(edges: ExactGraphEdge[]): PreparedExactCodeGraph {
  const adjacency = new Map<string, TraversedGraphEdge[]>();
  for (const edge of edges) {
    const forward: TraversedGraphEdge = {
      ...edge,
      traversalFrom: edge.from,
      traversalTo: edge.to,
      direction: "forward"
    };
    const reverse: TraversedGraphEdge = {
      ...edge,
      traversalFrom: edge.to,
      traversalTo: edge.from,
      direction: "reverse"
    };
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), forward]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), reverse]);
  }
  for (const neighbors of adjacency.values()) neighbors.sort(compareTraversedEdges);
  return { adjacency };
}

export function traversePreparedExactCodeGraph(
  graph: PreparedExactCodeGraph,
  seeds: Array<{ path: string; rank: number }>,
  options: GraphTraversalOptions
): GraphTraversalResult {
  const started = performance.now();
  const orderedSeeds = [...seeds]
    .sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
    .slice(0, 10);
  const paths = new Map<string, GraphReachabilityPath>();
  const queue: GraphReachabilityPath[] = [];
  for (const seed of orderedSeeds) {
    if (paths.has(seed.path) || paths.size >= options.maxCandidates) continue;
    const value = { seedPath: seed.path, seedRank: seed.rank, targetPath: seed.path, hops: 0, edges: [] };
    paths.set(seed.path, value);
    queue.push(value);
  }

  let truncated = false;
  for (let position = 0; position < queue.length; position += 1) {
    const current = queue[position]!;
    if (current.hops >= options.maxHops) continue;
    const allNeighbors = graph.adjacency.get(current.targetPath) ?? [];
    const neighbors = allNeighbors.slice(0, options.maxNeighborsPerNode);
    if (allNeighbors.length > neighbors.length) truncated = true;
    for (const edge of neighbors) {
      if (paths.has(edge.traversalTo)) continue;
      if (paths.size >= options.maxCandidates) {
        truncated = true;
        break;
      }
      const value: GraphReachabilityPath = {
        seedPath: current.seedPath,
        seedRank: current.seedRank,
        targetPath: edge.traversalTo,
        hops: current.hops + 1,
        edges: [...current.edges, edge]
      };
      paths.set(value.targetPath, value);
      queue.push(value);
    }
  }
  return {
    paths,
    candidatePaths: [...paths.keys()],
    latencyMs: performance.now() - started,
    truncated
  };
}

interface ExtractionContext {
  filesByPath: Map<string, GraphSourceFileMetadata>;
  normalizedPaths: Map<string, string[]>;
  add(edge: ExactGraphEdge): void;
}

interface Binding {
  target: string;
  module: string;
  line: number;
}

function extractTypeScriptEdges(file: GraphSourceFile, context: ExtractionContext): void {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind(file.path));
  const bindings = new Map<string, Binding>();
  const addModule = (module: string, line: number): string | null => {
    const target = resolveModule(file.path, module, context);
    if (target) context.add(edge(file.path, target, "import", line, "module", { module }));
    return target;
  };

  for (const reference of source.referencedFiles) {
    const target = resolveModule(file.path, reference.fileName, context);
    if (target) context.add(edge(file.path, target, "reference", lineOf(source, reference.pos), "source-reference", { module: reference.fileName }));
  }
  for (const reference of source.libReferenceDirectives) {
    const target = resolveLibReference(reference.fileName, context);
    if (target) context.add(edge(file.path, target, "reference", lineOf(source, reference.pos), "source-reference", { module: reference.fileName }));
  }
  for (const reference of source.typeReferenceDirectives) {
    const target = resolveModule(file.path, reference.fileName, context);
    if (target) context.add(edge(file.path, target, "reference", lineOf(source, reference.pos), "source-reference", { module: reference.fileName }));
  }

  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const line = lineOf(source, node.getStart(source));
      const target = addModule(module, line);
      if (target && node.importClause) {
        if (node.importClause.name) bindings.set(node.importClause.name.text, { target, module, line });
        const named = node.importClause.namedBindings;
        if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { target, module, line });
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) bindings.set(element.name.text, { target, module, line });
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addModule(node.moduleSpecifier.text, lineOf(source, node.getStart(source)));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      const module = node.moduleReference.expression.text;
      const line = lineOf(source, node.getStart(source));
      const target = addModule(module, line);
      if (target) bindings.set(node.name.text, { target, module, line });
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(source);

  const visit = (node: ts.Node): void => {
    if (ts.isHeritageClause(node)) {
      const kind: ExactGraphEdgeKind = node.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      for (const type of node.types) {
        const symbol = terminalIdentifier(type.expression);
        const resolved = symbol ? resolveSymbol(file.path, symbol, bindings, context) : null;
        if (resolved) context.add(edge(file.path, resolved.target, kind, lineOf(source, type.getStart(source)), resolved.resolution, { symbol, module: resolved.module }));
      }
    }
    if (ts.isCallExpression(node)) {
      const symbol = terminalIdentifier(node.expression);
      const root = rootIdentifier(node.expression);
      const resolved = resolveSymbol(file.path, root && bindings.has(root) ? root : symbol, bindings, context);
      if (resolved) context.add(edge(file.path, resolved.target, "call", lineOf(source, node.getStart(source)), resolved.resolution, { symbol: symbol ?? root, module: resolved.module }));
    }
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      const resolved = resolveSymbol(file.path, node.text, bindings, context);
      if (resolved) context.add(edge(file.path, resolved.target, "reference", lineOf(source, node.getStart(source)), resolved.resolution, { symbol: node.text, module: resolved.module }));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function extractPythonEdges(file: GraphSourceFile, context: ExtractionContext): void {
  const bindings = new Map<string, Binding>();
  const lines = file.content.split(/\r?\n/);
  for (const [index, contents] of lines.entries()) {
    const line = index + 1;
    const from = contents.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
    if (from) {
      const module = from[1]!;
      const target = resolvePythonModule(file.path, module, context);
      if (target) {
        context.add(edge(file.path, target, "import", line, "module", { module }));
        for (const value of from[2]!.split(",")) {
          const match = value.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/);
          if (match) bindings.set(match[2] ?? match[1]!, { target, module, line });
        }
      }
    }
    const imported = contents.match(/^\s*import\s+([.\w]+)(?:\s+as\s+([A-Za-z_]\w*))?/);
    if (imported) {
      const module = imported[1]!;
      const target = resolvePythonModule(file.path, module, context);
      if (target) {
        context.add(edge(file.path, target, "import", line, "module", { module }));
        bindings.set(imported[2] ?? module.split(".")[0]!, { target, module, line });
      }
    }
  }
  for (const [index, contents] of lines.entries()) {
    const line = index + 1;
    for (const match of contents.matchAll(/\bclass\s+[A-Za-z_]\w*\s*\(([^)]+)\)/g)) {
      for (const raw of match[1]!.split(",")) {
        const symbol = raw.trim().split(".").pop();
        const resolved = resolveSymbol(file.path, symbol, bindings, context);
        if (resolved) context.add(edge(file.path, resolved.target, "extends", line, resolved.resolution, { symbol, module: resolved.module }));
      }
    }
    for (const match of contents.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) {
      const expression = match[1]!;
      const root = expression.split(".")[0]!;
      const symbol = expression.split(".").pop()!;
      const resolved = resolveSymbol(file.path, bindings.has(root) ? root : symbol, bindings, context);
      if (resolved) context.add(edge(file.path, resolved.target, "call", line, resolved.resolution, { symbol, module: resolved.module }));
    }
    for (const match of contents.matchAll(/\b[A-Za-z_]\w*\b/g)) {
      const symbol = match[0];
      const resolved = resolveSymbol(file.path, symbol, bindings, context);
      if (resolved) context.add(edge(file.path, resolved.target, "reference", line, resolved.resolution, { symbol, module: resolved.module }));
    }
  }
}

function extractImportFallbacks(file: GraphSourceFile, context: ExtractionContext): void {
  const patterns = [/\bimport\s+(?:[^'\"]+from\s+)?["']([^"']+)["']/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    for (const match of file.content.matchAll(pattern)) {
      const module = match[1]!;
      const target = resolveModule(file.path, module, context);
      if (target) context.add(edge(file.path, target, "import", lineFromOffset(file.content, match.index), "module", { module }));
    }
  }
}

function edge(
  from: string,
  to: string,
  kind: ExactGraphEdgeKind,
  line: number,
  resolution: ExactGraphEdge["evidence"]["resolution"],
  values: { symbol?: string; module?: string }
): ExactGraphEdge {
  return {
    from,
    to,
    kind,
    confidence: "exact",
    evidence: { sourcePath: from, line, resolution, ...values }
  };
}

function resolveSymbol(
  sourcePath: string,
  symbol: string | undefined,
  bindings: Map<string, Binding>,
  context: ExtractionContext
): { target: string; resolution: "import-binding"; module: string } | null {
  if (!symbol) return null;
  const binding = bindings.get(symbol);
  if (binding && binding.target !== sourcePath) return { target: binding.target, resolution: "import-binding", module: binding.module };
  return null;
}

function resolveModule(sourcePath: string, module: string, context: ExtractionContext): string | null {
  const values = new Set<string>();
  const normalizedModule = normalizeModulePath(module.replace(/\\/g, "/"));
  if (module.startsWith(".")) {
    const joined = normalizeModulePath(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), module)));
    addNormalizedMatches(joined, context, values);
  } else {
    addNormalizedMatches(normalizedModule, context, values);
    for (const [candidate, paths] of context.normalizedPaths) {
      if (candidate.endsWith(`/${normalizedModule}`)) for (const value of paths) values.add(value);
    }
  }
  return values.size === 1 ? [...values][0]! : null;
}

function resolvePythonModule(sourcePath: string, module: string, context: ExtractionContext): string | null {
  const leading = module.match(/^\.+/)?.[0].length ?? 0;
  const tail = module.slice(leading).replace(/\./g, "/");
  const base = leading
    ? path.posix.resolve("/", path.posix.dirname(sourcePath), ...new Array(Math.max(0, leading - 1)).fill(".."), tail).slice(1)
    : tail;
  return resolveModule(sourcePath, leading ? `./${path.posix.relative(path.posix.dirname(sourcePath), base)}` : base, context);
}

function resolveLibReference(reference: string, context: ExtractionContext): string | null {
  const expected = `lib.${reference.toLowerCase()}.d.ts`;
  const matches = [...context.filesByPath.keys()].filter((candidate) => path.posix.basename(candidate).toLowerCase() === expected);
  return matches.length === 1 ? matches[0]! : null;
}

function addNormalizedMatches(value: string, context: ExtractionContext, output: Set<string>): void {
  for (const candidate of [value, `${value}/index`]) {
    for (const match of context.normalizedPaths.get(candidate) ?? []) output.add(match);
  }
}

function normalizeModulePath(value: string): string {
  return value.replace(/^\.\//, "").replace(/\.(?:tsx?|jsx?|mjs|cjs|pyi?)$/i, "").replace(/\/index$/i, "");
}

function terminalIdentifier(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

function rootIdentifier(node: ts.Expression): string | undefined {
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isImportClause(parent) && parent.name === node) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isTypeAliasDeclaration(parent)) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  return true;
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(Math.max(0, position)).line + 1;
}

function lineFromOffset(contents: string, offset: number | undefined): number {
  return contents.slice(0, offset ?? 0).split(/\r?\n/).length;
}

function compareEvidence(left: ExactGraphEdge, right: ExactGraphEdge): number {
  return left.evidence.line - right.evidence.line || JSON.stringify(left.evidence).localeCompare(JSON.stringify(right.evidence));
}

function compareEdges(left: ExactGraphEdge, right: ExactGraphEdge): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || EDGE_PRIORITY[left.kind] - EDGE_PRIORITY[right.kind] || compareEvidence(left, right);
}

function compareTraversedEdges(left: TraversedGraphEdge, right: TraversedGraphEdge): number {
  return EDGE_PRIORITY[left.kind] - EDGE_PRIORITY[right.kind]
    || left.traversalTo.localeCompare(right.traversalTo)
    || left.direction.localeCompare(right.direction)
    || compareEdges(left, right);
}
