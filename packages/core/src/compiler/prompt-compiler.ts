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
    const rawFiles = dependencies.compression.items.filter((summary) => summary.compression === "raw");
    const summarizedFiles = dependencies.compression.items.filter((summary) => summary.compression === "summary");
    const sessionContext = dependencies.sessionContext.map((record) => {
      const task = record.task.text;
      const files = record.compiledPrompt.includedFiles.slice(0, 5).join(", ");
      return `- ${task} [${files}]`;
    });

    const prompt = [
      "# Task",
      task.text,
      "",
      "# Session Memory",
      sessionContext.length > 0
        ? sessionContext.join("\n")
        : "No recent session context available.",
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
      "# Token Budget",
      `Max context tokens: ${dependencies.compression.tokenBudget.maxContextTokens}`,
      `Usage: raw=${dependencies.compression.budgetUsage.raw}, summaries=${dependencies.compression.budgetUsage.summary}, dependencies=${dependencies.compression.budgetUsage.dependency}, tests=${dependencies.compression.budgetUsage.tests}, total=${dependencies.compression.budgetUsage.total}`,
      "",
      "# Selection Reasons",
      selectionReasons.length > 0
        ? selectionReasons.map((item) => `- ${item.path} (${item.score}): ${item.reason}`).join("\n")
        : "No selection reasons available.",
      "",
      "# Raw Context",
      rawFiles.length > 0
        ? rawFiles
            .map(
              (summary) =>
                `## ${summary.path}\n${summary.summary}\n\`\`\`\n${summary.content ?? ""}\n\`\`\``
            )
            .join("\n\n")
        : "No raw files included.",
      "",
      "# Summaries",
      summarizedFiles.length > 0
        ? summarizedFiles
            .map((summary) => `- ${summary.path} (${summary.estimatedTokens} tokens): ${summary.summary}`)
            .join("\n")
        : "No summaries generated yet.",
      "",
      "# Omitted Files",
      dependencies.compression.omittedPaths.length > 0
        ? dependencies.compression.omittedPaths.join("\n")
        : "No files omitted by the current budget."
    ].join("\n");

    return {
      target: task.target,
      prompt,
      tokenEstimate: this.tokenEstimator.estimate(prompt),
      includedFiles,
      relatedTests: dependencies.retrieval.relatedTests,
      omittedPaths: dependencies.compression.omittedPaths,
      tokenBudget: dependencies.compression.tokenBudget,
      budgetUsage: dependencies.compression.budgetUsage,
      selectionReasons,
      summaries: dependencies.compression.items
    };
  }
}

class RoughTokenEstimator implements TokenEstimator {
  estimate(prompt: string): number {
    return Math.ceil(prompt.length / 4);
  }
}
