import { type CompiledPrompt, type SessionMemory, type UserTask } from "../types/contracts";

export class InMemorySessionMemory implements SessionMemory {
  private readonly prompts: CompiledPrompt[] = [];

  async remember(_task: UserTask, compiledPrompt: CompiledPrompt): Promise<void> {
    this.prompts.unshift(compiledPrompt);
  }

  async recent(limit: number): Promise<CompiledPrompt[]> {
    return this.prompts.slice(0, limit);
  }
}
