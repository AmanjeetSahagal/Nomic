import { type AgentAdapter, type AgentPayload, type CompiledPrompt } from "../types/contracts";

export class CodexAdapter implements AgentAdapter {
  readonly target = "codex" as const;

  async format(compiledPrompt: CompiledPrompt): Promise<AgentPayload> {
    return {
      target: this.target,
      system: [
        "You are Codex working inside a repository-aware workflow.",
        "Use the provided compiled context first, preserve behavior unless the task requires change, and call out omitted files when blocked."
      ].join(" "),
      user: [
        "# Compiled Task",
        compiledPrompt.prompt,
        "",
        "# Operating Notes",
        `Prompt ID: ${compiledPrompt.promptId}`,
        "Prefer editing the listed files directly.",
        "If context is omitted by budget, say so before making a risky change."
      ].join("\n"),
      metadata: buildMetadata(compiledPrompt)
    };
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly target = "claude" as const;

  async format(compiledPrompt: CompiledPrompt): Promise<AgentPayload> {
    return {
      target: this.target,
      system: [
        "You are Claude operating on a compiled engineering brief.",
        "Use the supplied repository context, explain your reasoning briefly, and avoid relying on files outside the provided scope."
      ].join(" "),
      user: [
        "Repository task brief:",
        compiledPrompt.prompt,
        "",
        "Response expectations:",
        `- Prompt ID: ${compiledPrompt.promptId}`,
        "- Explain the plan briefly before major edits.",
        "- Note assumptions when context was omitted by budget."
      ].join("\n"),
      metadata: buildMetadata(compiledPrompt)
    };
  }
}

function buildMetadata(compiledPrompt: CompiledPrompt): AgentPayload["metadata"] {
  return {
    promptId: compiledPrompt.promptId,
    includedFiles: compiledPrompt.includedFiles,
    relatedTests: compiledPrompt.relatedTests,
    omittedPaths: compiledPrompt.omittedPaths,
    tokenEstimate: compiledPrompt.tokenEstimate
  };
}
