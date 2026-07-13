import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createNomicEngine, type NomicEngine, type RankingMode, type TaskContextResult } from "@nomic/core";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const SERVER_INSTRUCTIONS = "Nomic is a local, read-only repository context engine. Call nomic_get_task_context before broad repository exploration. Use focused Nomic tools for follow-up context. After edits, call nomic_refresh_changed_files. Nomic never edits source files.";

export interface NomicMcpServer { server: McpServer; root: string; close(): Promise<void>; }
export interface NomicMcpConfiguration { rankingMode?: RankingMode; modelPath?: string; metadataPath?: string; rankingTimeoutMs?: number; }

export async function createNomicMcpServer(repositoryRoot?: string, engine?: NomicEngine, configuration: NomicMcpConfiguration = {}): Promise<NomicMcpServer> {
  engine ??= createNomicEngine({ ranking: { mode: configuration.rankingMode ?? "baseline", modelPath: configuration.modelPath, metadataPath: configuration.metadataPath, timeoutMs: configuration.rankingTimeoutMs, fallback: "baseline" } });
  const root = await resolveRepositoryRoot(repositoryRoot);
  const dirtyPaths = new Set<string>(await discoverGitChanges(root));
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && !filename.startsWith(".git/") && !filename.startsWith(".nomic/")) dirtyPaths.add(filename.split(path.sep).join("/"));
    });
    watcher.on("error", (error) => {
      log("warn", "watcher_unavailable", { code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" });
      watcher?.close();
      watcher = undefined;
    });
  } catch { /* Explicit refresh and Git discovery remain available. */ }

  const server = new McpServer({ name: "nomic", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, engine, root, dirtyPaths);
  return { server, root, async close() { watcher?.close(); await server.close(); } };
}

export async function serveNomicMcp(repositoryRoot?: string, configuration: NomicMcpConfiguration = {}): Promise<void> {
  const instance = await createNomicMcpServer(repositoryRoot, undefined, configuration);
  const transport = new StdioServerTransport();
  const shutdown = () => void instance.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await instance.server.connect(transport);
  log("info", "mcp_started", { repository: hashLabel(instance.root) });
}

export async function probeNomicMcp(command: string, args: string[], repositoryRoot: string): Promise<{ tools: string[]; sampleSucceeded: boolean; sampleError?: string }> {
  const client = new Client({ name: "nomic-doctor", version: "0.1.0" });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const sample = await client.callTool({ name: "nomic_get_task_context", arguments: { task: "find the Nomic engine", repository_root: repositoryRoot, token_budget: 500, max_files: 2 } });
    const sampleError = Array.isArray(sample.content)
      ? sample.content.find((item): item is { type: "text"; text: string } => typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string")?.text
      : undefined;
    return { tools: listed.tools.map((tool) => tool.name), sampleSucceeded: !sample.isError, ...(sample.isError ? { sampleError } : {}) };
  } finally {
    await client.close();
  }
}

function registerTools(server: McpServer, engine: NomicEngine, root: string, dirtyPaths: Set<string>): void {
  server.registerTool("nomic_get_task_context", {
    description: "Use before broad repository exploration for implementation, debugging, refactoring, or codebase questions. Returns token-budgeted code ranges from Nomic's frozen BM25, exact-symbol, and chunk-packing pipeline.",
    inputSchema: z.object({ task: z.string().min(1), repository_root: z.string().optional(), token_budget: z.number().int().min(100).max(100_000).optional(), max_files: z.number().int().min(1).max(50).optional(), include_tests: z.boolean().optional(), session_id: z.string().optional(), debug: z.boolean().optional() })
  }, async (args, extra) => executeTool("nomic_get_task_context", async () => {
    validateToolRoot(root, args.repository_root);
    if (dirtyPaths.size) {
      await engine.refreshFiles({ repositoryRoot: root, paths: [...dirtyPaths], signal: extra.signal });
      dirtyPaths.clear();
    }
    const result = await withTimeout(5_000, extra.signal, (signal) => engine.getTaskContext({ task: args.task, repositoryRoot: root, tokenBudget: args.token_budget, maxFiles: args.max_files, includeTests: args.include_tests, sessionId: args.session_id, debug: args.debug, signal }));
    return contextResponse(result);
  }));

  server.registerTool("nomic_expand_context", {
    description: "Use when initial Nomic context is incomplete. Returns focused additional ranges without repeating prior context.",
    inputSchema: z.object({ session_id: z.string(), focus: z.string().min(1), additional_token_budget: z.number().int().min(100).max(100_000).optional(), exclude_paths: z.array(z.string()).optional(), include_tests: z.boolean().optional(), debug: z.boolean().optional() })
  }, async (args, extra) => executeTool("nomic_expand_context", async () => contextResponse(await withTimeout(5_000, extra.signal, (signal) => engine.expandContext({ sessionId: args.session_id, focus: args.focus, additionalTokenBudget: args.additional_token_budget, excludePaths: args.exclude_paths, includeTests: args.include_tests, debug: args.debug, signal })))));

  server.registerTool("nomic_search_symbols", {
    description: "Find exact or approximate symbols in the active repository.",
    inputSchema: z.object({ query: z.string().min(1), repository_root: z.string().optional(), symbol_types: z.array(z.enum(["function", "class", "interface", "module", "test", "unknown"])).optional(), limit: z.number().int().min(1).max(100).optional() })
  }, async (args, extra) => executeTool("nomic_search_symbols", async () => {
    validateToolRoot(root, args.repository_root);
    const result = await withTimeout(2_000, extra.signal, (signal) => engine.searchSymbols({ repositoryRoot: root, query: args.query, symbolTypes: args.symbol_types, limit: args.limit, signal }));
    return structured(result, `Nomic found ${result.matches.length} symbol${result.matches.length === 1 ? "" : "s"}.`);
  }));

  server.registerTool("nomic_get_symbol", {
    description: "Return one identified symbol with a bounded amount of surrounding code.",
    inputSchema: z.object({ path: z.string(), symbol: z.string(), repository_root: z.string().optional(), surrounding_lines: z.number().int().min(0).max(50).optional() })
  }, async (args, extra) => executeTool("nomic_get_symbol", async () => {
    validateToolRoot(root, args.repository_root);
    const result = await withTimeout(2_000, extra.signal, (signal) => engine.getSymbol({ repositoryRoot: root, path: args.path, symbol: args.symbol, surroundingLines: args.surrounding_lines, signal }));
    return structured(toSnake(result), `${result.range.path} :: ${result.symbol.name} [${result.range.startLine}-${result.range.endLine}]\n\n\`\`\`\n${result.range.content}\n\`\`\``);
  }));

  server.registerTool("nomic_get_file_range", {
    description: "Read a specific bounded code range after Nomic identifies a relevant file. Do not use it for entire large files.",
    inputSchema: z.object({ path: z.string(), start_line: z.number().int().min(1), end_line: z.number().int().min(1), repository_root: z.string().optional() })
  }, async (args, extra) => executeTool("nomic_get_file_range", async () => {
    validateToolRoot(root, args.repository_root);
    const result = await withTimeout(1_000, extra.signal, (signal) => engine.getFileRange({ repositoryRoot: root, path: args.path, startLine: args.start_line, endLine: args.end_line, signal }));
    return structured(toSnake(result), `${result.path} [${result.startLine}-${result.endLine}]\n\n\`\`\`\n${result.content}\n\`\`\``);
  }));

  server.registerTool("nomic_refresh_changed_files", {
    description: "Refresh Nomic after files are created, changed, or deleted. Pass known paths for the fastest update.",
    inputSchema: z.object({ repository_root: z.string().optional(), paths: z.array(z.string()).optional() })
  }, async (args, extra) => executeTool("nomic_refresh_changed_files", async () => {
    validateToolRoot(root, args.repository_root);
    const paths = args.paths ?? (dirtyPaths.size ? [...dirtyPaths] : await discoverGitChanges(root));
    const result = await withTimeout(30_000, extra.signal, (signal) => engine.refreshFiles({ repositoryRoot: root, paths: paths.length ? paths : undefined, signal }));
    paths.forEach((changedPath) => dirtyPaths.delete(changedPath));
    return structured({ changed_paths: paths, metrics: result.metrics }, `Refreshed ${paths.length} changed path${paths.length === 1 ? "" : "s"}.`);
  }));

  server.registerTool("nomic_get_retrieval_metrics", {
    description: "Return detailed retrieval metrics for a Nomic task session.",
    inputSchema: z.object({ session_id: z.string() })
  }, async (args) => executeTool("nomic_get_retrieval_metrics", async () => {
    const result = await engine.getRetrievalMetrics({ sessionId: args.session_id });
    return structured(toSnake(result), `Nomic session ${result.sessionId}: ${result.packedTokens} packed tokens across ${result.calls} call${result.calls === 1 ? "" : "s"}.`);
  }));
}

function contextResponse(result: TaskContextResult) {
  const value = {
    session_id: result.sessionId,
    confidence: result.confidence,
    packed_tokens: result.packedTokens,
    context: result.context.map((range) => ({ path: range.path, symbol: range.symbol, start_line: range.startLine, end_line: range.endLine, reason: range.reason, content: range.content })),
    ...(result.debug ? { debug: toSnake(result.debug) } : {})
  };
  const ranges = value.context.map((range, index) => `${index + 1}. ${range.path}${range.symbol ? ` :: ${range.symbol}` : ""} [${range.start_line}-${range.end_line}]\nReason: ${range.reason}\n\n\`\`\`\n${range.content}\n\`\`\``).join("\n\n");
  return structured(value, `Nomic session ${value.session_id}: selected ${value.context.length} ranges, ${value.packed_tokens} estimated tokens, confidence: ${value.confidence}.\n\n${ranges}`);
}

type ToolResponse = { isError?: boolean; content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> };

async function executeTool(name: string, action: () => Promise<ToolResponse>): Promise<ToolResponse> {
  const started = Date.now();
  try { return await action(); }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const [rawCode] = message.split(":", 1);
    const code = /^[A-Z_]+$/.test(rawCode ?? "") ? rawCode : "INTERNAL_ERROR";
    log("warn", "tool_error", { tool: name, duration_ms: Date.now() - started, code });
    return { isError: true, content: [{ type: "text", text: `${code}: ${message.replace(`${code}:`, "").trim()}` }], structuredContent: { code, message, recoverable: code !== "PATH_OUTSIDE_REPOSITORY" && code !== "UNSUPPORTED_FILE" } };
  }
}

function structured(value: object, text: string): ToolResponse { return { content: [{ type: "text", text }], structuredContent: value as Record<string, unknown> }; }
function toSnake(value: unknown): Record<string, unknown> {
  const convert = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(convert);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current).map(([key, item]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), convert(item)]));
  };
  return convert(value) as Record<string, unknown>;
}

async function resolveRepositoryRoot(explicit?: string): Promise<string> {
  let current = path.resolve(explicit ?? process.env.NOMIC_REPOSITORY_ROOT ?? process.cwd());
  const initial = await stat(current).catch(() => null);
  if (!initial?.isDirectory()) throw new Error(`REPOSITORY_NOT_FOUND: ${current}`);
  if (explicit || process.env.NOMIC_REPOSITORY_ROOT) return realpath(current);
  while (true) {
    if ((await stat(path.join(current, ".git")).catch(() => null))?.isDirectory()) return realpath(current);
    const parent = path.dirname(current);
    if (parent === current) return realpath(path.resolve(process.cwd()));
    current = parent;
  }
}

function validateToolRoot(boundRoot: string, requested?: string): void {
  if (requested && path.resolve(requested) !== boundRoot) throw new Error("REPOSITORY_NOT_TRUSTED: Tool root does not match the server root.");
}

async function discoverGitChanges(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxBuffer: 10 * 1024 * 1024 });
    const records = stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] ?? "";
      const status = record.slice(0, 2);
      paths.push(record.slice(3));
      if (/[RC]/.test(status) && records[index + 1]) paths.push(records[++index] ?? "");
    }
    return [...new Set(paths.filter(Boolean))];
  } catch { return []; }
}

async function withTimeout<T>(milliseconds: number, parent: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent?.aborted) throw new Error("REQUEST_CANCELLED: Request was cancelled.");
  const controller = new AbortController();
  let rejectCancellation: ((error: Error) => void) | undefined;
  const abort = () => {
    controller.abort();
    rejectCancellation?.(new Error("REQUEST_CANCELLED: Request was cancelled."));
  };
  parent?.addEventListener("abort", abort, { once: true });
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("REQUEST_TIMEOUT: Request exceeded its deadline."));
    }, milliseconds);
  });
  try { return await Promise.race([action(controller.signal), deadline, timeout]); }
  finally { clearTimeout(timeoutId!); parent?.removeEventListener("abort", abort); }
}

function log(level: string, event: string, details: Record<string, unknown>): void { process.stderr.write(`${JSON.stringify({ level, event, ...details })}\n`); }
function hashLabel(value: string): string { return path.basename(value); }
