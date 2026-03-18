import { describe, expect, it } from "vitest";
import { ClaudeAdapter, CodexAdapter } from "./agent-adapters";
import type { CompiledPrompt } from "../types/contracts";

describe("Agent adapters", () => {
  it("formats Codex payloads with Codex-specific system and user sections", async () => {
    const adapter = new CodexAdapter();
    const payload = await adapter.format(createCompiledPrompt());

    expect(payload.target).toBe("codex");
    expect(payload.system).toContain("Codex");
    expect(payload.user).toContain("# Compiled Task");
    expect(payload.metadata.includedFiles).toContain("src/auth.ts");
  });

  it("formats Claude payloads with Claude-specific instructions", async () => {
    const adapter = new ClaudeAdapter();
    const payload = await adapter.format(createCompiledPrompt());

    expect(payload.target).toBe("claude");
    expect(payload.system).toContain("Claude");
    expect(payload.user).toContain("Repository task brief:");
    expect(payload.metadata.omittedPaths).toContain("docs/legacy-auth.md");
  });
});

function createCompiledPrompt(): CompiledPrompt {
  return {
    target: "codex",
    prompt: "Refactor auth flow.",
    tokenEstimate: 120,
    includedFiles: ["src/auth.ts", "src/session.ts"],
    relatedTests: ["tests/auth.test.ts"],
    omittedPaths: ["docs/legacy-auth.md"],
    tokenBudget: {
      maxContextTokens: 8000,
      rawCodeFraction: 0.5,
      summaryFraction: 0.25,
      dependencyFraction: 0.15,
      testFraction: 0.1
    },
    budgetUsage: {
      raw: 50,
      summary: 30,
      dependency: 20,
      tests: 20,
      total: 120
    },
    selectionReasons: [],
    summaries: []
  };
}
