import { type AgentAdapter, type CompiledPrompt } from "../types/contracts";

export class CodexAdapter implements AgentAdapter {
  readonly target = "codex" as const;

  async format(compiledPrompt: CompiledPrompt): Promise<string> {
    return compiledPrompt.prompt;
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly target = "claude" as const;

  async format(compiledPrompt: CompiledPrompt): Promise<string> {
    return compiledPrompt.prompt;
  }
}
