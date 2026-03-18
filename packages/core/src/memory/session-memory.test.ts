import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionMemory, InMemorySessionMemory } from "./session-memory";
import type { CompiledPrompt, UserTask } from "../types/contracts";

const tempDirectories: string[] = [];

describe("SessionMemory", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map(async (directory) => {
        await import("node:fs/promises").then(({ rm }) => rm(directory, { force: true, recursive: true }));
      })
    );
  });

  it("stores recent in-memory session records by repository", async () => {
    const memory = new InMemorySessionMemory();
    const task = createTask("/repo-a", "refactor auth");

    await memory.remember(task, createPrompt("src/auth.ts"));
    await memory.remember(createTask("/repo-b", "fix payments"), createPrompt("src/payments.ts"));

    const records = await memory.recent(5, "/repo-a");

    expect(records).toHaveLength(1);
    expect(records[0]?.task.text).toBe("refactor auth");
    expect(records[0]?.selectedFiles).toEqual(["src/auth.ts"]);
  });

  it("persists session records to disk", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "nomic-session-"));
    tempDirectories.push(repositoryRoot);
    const memory = new FileSessionMemory();

    await memory.remember(createTask(repositoryRoot, "refactor auth"), createPrompt("src/auth.ts"));
    await memory.remember(createTask(repositoryRoot, "improve auth tests"), createPrompt("tests/auth.test.ts"));

    const records = await memory.recent(5, repositoryRoot);

    expect(records).toHaveLength(2);
    expect(records[0]?.task.text).toBe("improve auth tests");
    expect(records[1]?.compiledPrompt.includedFiles).toContain("src/auth.ts");
    expect(records[0]?.architectureSummary).toEqual(["Preserve auth module boundaries"]);
  });
});

function createTask(repositoryRoot: string, text: string): UserTask {
  return {
    text,
    target: "codex",
    repositoryRoot
  };
}

function createPrompt(filePath: string): CompiledPrompt {
  return {
    promptId: `prompt-${filePath}`,
    target: "codex",
    prompt: `Prompt for ${filePath}`,
    tokenEstimate: 10,
    includedFiles: [filePath],
    relatedTests: [],
    omittedPaths: [],
    omissionReasons: [],
    tokenBudget: {
      maxContextTokens: 8000,
      rawCodeFraction: 0.5,
      summaryFraction: 0.25,
      dependencyFraction: 0.15,
      testFraction: 0.1
    },
    budgetUsage: {
      raw: 5,
      summary: 5,
      dependency: 0,
      tests: 0,
      total: 10
    },
    selectionReasons: [],
    summaries: [],
    retrievalSummary: [],
    dependencyNotes: ["Preserve auth module boundaries"],
    sections: []
  };
}
