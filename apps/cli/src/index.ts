#!/usr/bin/env node

import {
  LocalFeedbackStore,
  createNomicEngine,
  type AgentTarget,
  type UserTask
} from "@nomic/core";
import { probeNomicMcp, serveNomicMcp } from "@nomic/mcp-server";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const [command, ...args] = process.argv.slice(2);
const defaultRepositoryRoot = process.env.INIT_CWD ?? process.cwd();

async function main(): Promise<void> {
  const engine = createNomicEngine();

  switch (command) {
    case "serve-mcp": {
      await serveNomicMcp(args[0] ?? defaultRepositoryRoot);
      return;
    }
    case "setup": {
      const client = args[0];
      const scopeIndex = args.indexOf("--scope");
      const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : "project";
      if (client !== "codex" && client !== "claude") {
        printUsage("Setup requires `codex` or `claude`.");
        process.exitCode = 1;
        return;
      }
      await setupClient(client, scope, defaultRepositoryRoot);
      return;
    }
    case "index": {
      const repositoryRoot = args[0] ?? defaultRepositoryRoot;
      const result = await engine.indexRepository({ repositoryRoot });
      const testFileCount = result.files.filter((file) => file.isTest).length;
      const languageBreakdown = summarizeLanguages(result.files);

      console.log(`Indexed ${result.fileCount} files in ${repositoryRoot}`);
      console.log(`Chunks: ${result.chunks.length}`);
      console.log(`Edges: ${result.edges.length}`);
      console.log(`Test files: ${testFileCount}`);
      console.log(`Languages: ${languageBreakdown}`);
      console.log(
        `Index metrics: added=${result.metrics.addedFiles}, changed=${result.metrics.changedFiles}, reused=${result.metrics.reusedFiles}, removed=${result.metrics.removedFiles}, reusedChunks=${result.metrics.reusedChunks}, reusedEdges=${result.metrics.reusedEdges}`
      );
      console.log(`Saved orchestration index to .nomic/index.json${result.backend === "native" ? " and native index to .nomic/index.sqlite" : ""}`);
      return;
    }
    case "ask": {
      const taskText = args.join(" ").trim();
      if (!taskText) {
        printUsage("Missing task text for `ask`.");
        process.exitCode = 1;
        return;
      }

      const task: UserTask = {
        text: taskText,
        target: parseTarget(process.env.NOMIC_AGENT_TARGET),
        repositoryRoot: defaultRepositoryRoot
      };
      const compiled = await engine.compileTask(task);
      const payload = await engine.formatForTarget(compiled, task.target);

      console.log(`Task: ${task.text}`);
      console.log(`Target: ${compiled.target}`);
      console.log(`Prompt ID: ${compiled.promptId}`);
      console.log(`Included files: ${compiled.includedFiles.length}`);
      console.log(`Related tests: ${compiled.relatedTests.length}`);
      console.log(`Estimated tokens: ${compiled.tokenEstimate}`);
      console.log("");
      console.log("Selection");
      for (const reason of compiled.selectionReasons) {
        console.log(`- ${reason.path} [${reason.role}/${reason.stage}] (${reason.score.toFixed(1)})`);
        console.log(`  ${reason.reason}`);
      }
      console.log("");
      console.log("Budget");
      console.log(
        `raw=${compiled.budgetUsage.raw}, summaries=${compiled.budgetUsage.summary}, dependencies=${compiled.budgetUsage.dependency}, tests=${compiled.budgetUsage.tests}, total=${compiled.budgetUsage.total}`
      );
      console.log("");
      console.log("Omissions");
      if (compiled.omittedPaths.length === 0 && compiled.omissionReasons.length === 0) {
        console.log("None");
      } else {
        for (const omission of [...compiled.omittedPaths, ...compiled.omissionReasons]) {
          console.log(`- ${omission}`);
        }
      }
      console.log("");
      console.log("Compiled Prompt Preview");
      console.log(compiled.prompt);
      console.log("");
      console.log(`# Target Payload: ${payload.target}`);
      console.log("");
      console.log("## System");
      console.log(payload.system);
      console.log("");
      console.log("## User");
      console.log(payload.user);
      return;
    }
    case "explain-selection": {
      const taskText = args.join(" ").trim();
      if (!taskText) {
        printUsage("Missing task text for `explain-selection`.");
        process.exitCode = 1;
        return;
      }

      const reasons = await engine.explainSelection({
        text: taskText,
        target: parseTarget(process.env.NOMIC_AGENT_TARGET),
        repositoryRoot: defaultRepositoryRoot
      });

      if (reasons.length === 0) {
        console.log("No files matched the current task.");
        return;
      }

      for (const reason of reasons) {
        console.log(`${reason.path} [${reason.role}/${reason.stage}] (${reason.score.toFixed(1)})`);
        console.log(`  ${reason.reason}`);
      }
      return;
    }
    case "doctor": {
      const diagnostics = await engine.diagnostics(defaultRepositoryRoot);

      console.log("Nomic doctor");
      console.log(`Node: ${process.version}`);
      console.log(`Repository: ${defaultRepositoryRoot}`);
      console.log(`Backend: ${diagnostics.backend}`);
      console.log(`Native addon: ${diagnostics.nativeAddonPath}`);
      console.log("Parser: filesystem parser with optional native BM25 mirror");
      console.log(`Storage: platform Nomic cache${diagnostics.backend === "native" ? " (JSON + SQLite)" : " (JSON)"}`);
      console.log("Session memory: bounded in-process memory (not persisted)");
      console.log(`Index present: ${diagnostics.hasIndex ? "yes" : "no"}`);
      if (diagnostics.hasIndex) {
        console.log(`Index generated at: ${diagnostics.generatedAt}`);
        console.log(`Indexed files: ${diagnostics.fileCount}`);
        console.log(`Indexed chunks: ${diagnostics.chunkCount}`);
        console.log(`Graph edges: ${diagnostics.edgeCount}`);
        console.log(`Reused files on last index: ${diagnostics.reusedFiles}`);
      }
      try {
        const probe = await probeNomicMcp(process.execPath, [path.resolve(process.argv[1]), "serve-mcp", defaultRepositoryRoot], defaultRepositoryRoot);
        console.log(`MCP handshake: passed (${probe.tools.length} tools)`);
        console.log(`MCP sample retrieval: ${probe.sampleSucceeded ? "passed" : `failed (${probe.sampleError ?? "unknown error"})`}`);
        if (!probe.sampleSucceeded || probe.tools.length !== 7) process.exitCode = 1;
      } catch (error: unknown) {
        console.log(`MCP handshake: failed (${error instanceof Error ? error.message : String(error)})`);
        process.exitCode = 1;
      }
      return;
    }
    case "benchmark": {
      const repositoryRoot = args[0] ?? defaultRepositoryRoot;
      const report = await engine.benchmark(repositoryRoot, [
        { text: "refactor authentication login flow", target: "codex", repositoryRoot },
        { text: "fix session reliability regression", target: "codex", repositoryRoot },
        { text: "improve authentication documentation", target: "claude", repositoryRoot }
      ]);

      console.log("Nomic benchmark");
      console.log(`Repository: ${report.repositoryRoot}`);
      console.log(`Index ms: ${report.indexMs.toFixed(1)}`);
      console.log(`Average compile ms: ${report.averageCompileMs.toFixed(1)}`);
      console.log(`Peak token estimate: ${report.peakTokenEstimate}`);
      console.log("Retrieval quality metrics: unavailable for unlabelled ad-hoc tasks");
      console.log(`Query P50/P95 ms: ${report.queryP50Ms.toFixed(1)}/${report.queryP95Ms.toFixed(1)}`);
      for (const compile of report.compileReports) {
        console.log(`- ${compile.target} :: ${compile.task}`);
        console.log(`  totalMs=${compile.totalMs.toFixed(1)} tokens=${compile.tokenEstimate} files=${compile.includedFiles}`);
      }
      return;
    }
    case "feedback": {
      const action = args[0] ?? "status";
      const store = new LocalFeedbackStore();
      if (action === "status") {
        const records = await store.read(defaultRepositoryRoot);
        console.log(`Feedback opt-in: ${store.isEnabled() ? "enabled" : "disabled"}`);
        console.log(`Local feedback records: ${records.length}`);
        return;
      }
      if (action === "export") {
        const destination = args[1] ?? "nomic-feedback-export.json";
        const count = await store.export(defaultRepositoryRoot, destination);
        console.log(`Exported ${count} feedback records to ${destination}`);
        return;
      }
      if (action === "clear") {
        await store.clear(defaultRepositoryRoot);
        console.log("Cleared local Nomic feedback records.");
        return;
      }
      printUsage(`Unknown feedback action: ${action}`);
      process.exitCode = 1;
      return;
    }
    default: {
      printUsage();
    }
  }
}

function parseTarget(value: string | undefined): AgentTarget {
  return value === "claude" ? "claude" : "codex";
}

function printUsage(error?: string): void {
  if (error) {
    console.error(error);
    console.error("");
  }

  console.log("Usage:");
  console.log("  nomic index [repository-root]");
  console.log("  nomic serve-mcp [repository-root]");
  console.log("  nomic setup codex [--scope project|user]");
  console.log("  nomic setup claude [--scope local|project|user]");
  console.log('  nomic ask "your task"');
  console.log('  nomic explain-selection "your task"');
  console.log("  nomic doctor");
  console.log("  nomic benchmark [repository-root]");
  console.log("  nomic feedback [status|export [path]|clear]");
}

async function setupClient(client: "codex" | "claude", scope: string, repositoryRoot: string): Promise<void> {
  const executable = path.resolve(process.argv[1]);
  if (client === "codex" && scope === "project") {
    const configPath = path.join(repositoryRoot, ".codex", "config.toml");
    const existing = await readFile(configPath, "utf8").catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    if (/^\[mcp_servers\.nomic\]$/m.test(existing)) throw new Error(`Codex Nomic configuration already exists in ${configPath}; refusing to overwrite it.`);
    const block = `[mcp_servers.nomic]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(executable)}, "serve-mcp", ${JSON.stringify(repositoryRoot)}]\ncwd = ${JSON.stringify(repositoryRoot)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 30\ndefault_tools_approval_mode = "approve"\n`;
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}\n${block}`, "utf8");
    console.log(`Configured project-scoped Codex MCP in ${configPath}`);
  } else {
    const command = client;
    const clientArgs = client === "codex"
      ? ["mcp", "add", "nomic", "--", process.execPath, executable, "serve-mcp", repositoryRoot]
      : ["mcp", "add", "nomic", "--scope", scope, "--", process.execPath, executable, "serve-mcp", repositoryRoot];
    try {
      await execFileAsync(command, clientArgs);
      console.log(`Configured ${client} MCP at ${scope} scope.`);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        console.log(`${client} is not installed. Manual configuration:`);
        console.log(JSON.stringify({ mcpServers: { nomic: { command: process.execPath, args: [executable, "serve-mcp", repositoryRoot] } } }, null, 2));
        return;
      }
      throw error;
    }
  }
  const probe = await probeNomicMcp(process.execPath, [executable, "serve-mcp", repositoryRoot], repositoryRoot);
  if (probe.tools.length !== 7 || !probe.sampleSucceeded) throw new Error("MCP setup verification failed.");
  console.log("Verified MCP handshake, seven tools, and sample retrieval.");
}

function summarizeLanguages(files: Array<{ language: string }>): string {
  const counts = new Map<string, number>();

  for (const file of files) {
    counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([language, count]) => `${language}:${count}`)
    .join(", ");
}

void main().catch((error: unknown) => {
  console.error("Nomic CLI failed.");
  console.error(error);
  process.exitCode = 1;
});
