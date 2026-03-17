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
      console.log(`Test files: ${testFileCount}`);
      console.log(`Languages: ${languageBreakdown}`);
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

      console.log(`Task: ${task.text}`);
      console.log(`Target: ${compiled.target}`);
      console.log(`Included files: ${compiled.includedFiles.length}`);
      console.log(`Related tests: ${compiled.relatedTests.length}`);
      console.log(`Estimated tokens: ${compiled.tokenEstimate}`);
      console.log("");
      console.log(compiled.prompt);
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
        console.log(`${reason.path} (${reason.score})`);
        console.log(`  ${reason.reason}`);
      }
      return;
    }
    case "doctor": {
      console.log("Nomic doctor");
      console.log(`Node: ${process.version}`);
      console.log(`Working directory: ${process.cwd()}`);
      console.log("Parser: filesystem parser");
      console.log("Storage: .nomic/index.json");
      console.log("Session memory: .nomic/session-memory.json");
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
