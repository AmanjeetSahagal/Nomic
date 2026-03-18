#!/usr/bin/env node

import {
  ClaudeAdapter,
  CodexAdapter,
  FileSessionMemory,
  FileStorageBackend,
  FilesystemParserProvider,
  createNomicEngine,
  type AgentTarget,
  type UserTask
} from "@nomic/core";

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  const engine = createNomicEngine({
    adapters: {
      claude: new ClaudeAdapter(),
      codex: new CodexAdapter()
    },
    memory: new FileSessionMemory(),
    parser: new FilesystemParserProvider(),
    storage: new FileStorageBackend()
  });

  switch (command) {
    case "index": {
      const repositoryRoot = args[0] ?? process.cwd();
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
      console.log("Saved index to .nomic/index.json");
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
        target: parseTarget(process.env.NOMIC_AGENT_TARGET)
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
        target: parseTarget(process.env.NOMIC_AGENT_TARGET)
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
      const diagnostics = await engine.diagnostics(process.cwd());

      console.log("Nomic doctor");
      console.log(`Node: ${process.version}`);
      console.log(`Working directory: ${process.cwd()}`);
      console.log("Parser: filesystem parser");
      console.log("Storage: .nomic/index.json");
      console.log("Session memory: .nomic/session-memory.json");
      console.log(`Index present: ${diagnostics.hasIndex ? "yes" : "no"}`);
      if (diagnostics.hasIndex) {
        console.log(`Index generated at: ${diagnostics.generatedAt}`);
        console.log(`Indexed files: ${diagnostics.fileCount}`);
        console.log(`Indexed chunks: ${diagnostics.chunkCount}`);
        console.log(`Graph edges: ${diagnostics.edgeCount}`);
        console.log(`Reused files on last index: ${diagnostics.reusedFiles}`);
      }
      return;
    }
    case "benchmark": {
      const repositoryRoot = args[0] ?? process.cwd();
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
      for (const compile of report.compileReports) {
        console.log(`- ${compile.target} :: ${compile.task}`);
        console.log(`  totalMs=${compile.totalMs.toFixed(1)} tokens=${compile.tokenEstimate} files=${compile.includedFiles}`);
      }
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
  console.log('  nomic ask "your task"');
  console.log('  nomic explain-selection "your task"');
  console.log("  nomic doctor");
  console.log("  nomic benchmark [repository-root]");
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
