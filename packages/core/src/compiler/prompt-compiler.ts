import {
  type CompileTaskDependencies,
  type CompiledPrompt,
  type TokenEstimator,
  type UserTask
} from "../types/contracts";

export class PromptCompiler {
  constructor(private readonly tokenEstimator: TokenEstimator = new RoughTokenEstimator()) {}

  compile(task: UserTask, dependencies: CompileTaskDependencies): CompiledPrompt {
    const includedFiles = dependencies.retrieval.candidates.map((candidate) => candidate.path);
    const selectionReasons = dependencies.retrieval.candidates.map((candidate) => ({
      path: candidate.path,
      reason: candidate.reason,
      score: candidate.score,
      source: candidate.source
    }));

    const prompt = [
      "# Task",
      task.text,
      "",
      "# Query Terms",
      dependencies.retrieval.queryTerms.length > 0
        ? dependencies.retrieval.queryTerms.join(", ")
        : "No query terms extracted.",
      "",
      "# Included Files",
      includedFiles.length > 0 ? includedFiles.join("\n") : "No files selected yet.",
      "",
      "# Related Tests",
      dependencies.retrieval.relatedTests.length > 0
        ? dependencies.retrieval.relatedTests.join("\n")
        : "No related tests selected yet.",
      "",
      "# Selection Reasons",
      selectionReasons.length > 0
        ? selectionReasons.map((item) => `- ${item.path} (${item.score}): ${item.reason}`).join("\n")
        : "No selection reasons available.",
      "",
      "# Summaries",
      dependencies.summaries.length > 0
        ? dependencies.summaries
            .map((summary) => `- ${summary.path}: ${summary.summary}`)
            .join("\n")
        : "No summaries generated yet."
    ].join("\n");

    return {
      target: task.target,
      prompt,
      tokenEstimate: this.tokenEstimator.estimate(prompt),
      includedFiles,
      relatedTests: dependencies.retrieval.relatedTests,
      selectionReasons,
      summaries: dependencies.summaries
    };
  }
}

class RoughTokenEstimator implements TokenEstimator {
  estimate(prompt: string): number {
    return Math.ceil(prompt.length / 4);
  }
}
