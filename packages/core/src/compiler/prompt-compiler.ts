import { createHash } from "node:crypto";
import {
  type CompileTaskDependencies,
  type CompiledPrompt,
  type CompiledPromptSection,
  type TokenEstimator,
  type UserTask
} from "../types/contracts";

export class PromptCompiler {
  constructor(private readonly tokenEstimator: TokenEstimator = new RoughTokenEstimator()) {}

  compile(task: UserTask, dependencies: CompileTaskDependencies): CompiledPrompt {
    const includedFiles = dependencies.compression.items.map((item) => item.path);
    const selectionReasons = dependencies.retrieval.candidates.map((candidate) => ({
      path: candidate.path,
      reason: candidate.reason,
      score: candidate.score,
      source: candidate.source,
      role: candidate.role,
      stage: candidate.stage
    }));
    const rawFiles = dependencies.compression.items.filter((summary) => summary.compression === "raw");
    const summarizedFiles = dependencies.compression.items.filter((summary) => summary.compression === "summary");
    const retrievalSummary = dependencies.retrieval.candidates.map((candidate) => {
      const score = candidate.score.toFixed(1);
      return `${candidate.path} [${candidate.role}/${candidate.stage}] score=${score} reason=${candidate.reason}`;
    });
    const sessionContext = dependencies.sessionContext.map((record) => {
      const files = record.selectedFiles.slice(0, 5).join(", ");
      return `- ${record.task.text} [${files}]`;
    });

    const sections = buildSections({
      task,
      sessionContext,
      retrievalSummary,
      rawFiles,
      summarizedFiles,
      dependencyNotes: dependencies.compression.dependencyNotes,
      relatedTests: dependencies.retrieval.relatedTests,
      omittedPaths: dependencies.compression.omittedPaths,
      budgetLine: `Usage: raw=${dependencies.compression.budgetUsage.raw}, summaries=${dependencies.compression.budgetUsage.summary}, dependencies=${dependencies.compression.budgetUsage.dependency}, tests=${dependencies.compression.budgetUsage.tests}, total=${dependencies.compression.budgetUsage.total}`,
      truncationReasons: dependencies.retrieval.truncationReasons
    });
    const prompt = sections.map((section) => `# ${section.title}\n${section.body}`).join("\n\n");
    const promptId = createPromptId(prompt);

    return {
      promptId,
      compiledAt: new Date().toISOString(),
      target: task.target,
      prompt,
      tokenEstimate: this.tokenEstimator.estimate(prompt),
      includedFiles,
      relatedTests: dependencies.retrieval.relatedTests,
      omittedPaths: dependencies.compression.omittedPaths,
      omissionReasons: dependencies.retrieval.truncationReasons,
      tokenBudget: dependencies.compression.tokenBudget,
      budgetUsage: dependencies.compression.budgetUsage,
      selectionReasons,
      summaries: dependencies.compression.items,
      retrievalSummary,
      dependencyNotes: dependencies.compression.dependencyNotes,
      sections: sections.map(({ key, title, body }) => ({
        key,
        title,
        tokenEstimate: this.tokenEstimator.estimate(body)
      })),
      diagnostics: {
        indexMs: 0,
        retrievalMs: 0,
        compressionMs: 0,
        compileMs: 0,
        totalMs: 0,
        fileCount: dependencies.index.fileCount,
        chunkCount: dependencies.index.chunks.length,
        edgeCount: dependencies.index.edges.length
      }
    };
  }
}

class RoughTokenEstimator implements TokenEstimator {
  estimate(prompt: string): number {
    return Math.ceil(prompt.length / 4);
  }
}

function buildSections(input: {
  task: UserTask;
  sessionContext: string[];
  retrievalSummary: string[];
  rawFiles: CompiledPrompt["summaries"];
  summarizedFiles: CompiledPrompt["summaries"];
  dependencyNotes: string[];
  relatedTests: string[];
  omittedPaths: string[];
  budgetLine: string;
  truncationReasons: string[];
}): Array<Omit<CompiledPromptSection, "tokenEstimate"> & { body: string }> {
  return [
    {
      key: "task",
      title: "Task",
      body: input.task.text
    },
    {
      key: "constraints",
      title: "Operating Constraints",
      body: [
        "Use the compiled context first before relying on unstated repository assumptions.",
        "Call out omitted files if they block a safe change.",
        input.sessionContext.length > 0 ? `Recent session context:\n${input.sessionContext.join("\n")}` : "Recent session context: none"
      ].join("\n")
    },
    {
      key: "retrieval",
      title: "Retrieval Rationale",
      body: input.retrievalSummary.length > 0 ? input.retrievalSummary.join("\n") : "No retrieval rationale available."
    },
    {
      key: "raw",
      title: "Selected Raw Files",
      body:
        input.rawFiles.length > 0
          ? input.rawFiles
              .map(
                (summary) =>
                  `## ${summary.path}\nPurpose: ${summary.purpose}\nReason: ${summary.inclusionReason}\n\`\`\`\n${summary.content ?? ""}\n\`\`\``
              )
              .join("\n\n")
          : "No raw files included."
    },
    {
      key: "summaries",
      title: "Compressed Summaries",
      body:
        input.summarizedFiles.length > 0
          ? input.summarizedFiles
              .map(
                (summary) =>
                  `- ${summary.path}: ${summary.summary} Public API: ${summary.publicApi.join(", ") || "None"}. Key invariants: ${summary.keyInvariants.join(" ")}`
              )
              .join("\n")
          : "No summaries generated."
    },
    {
      key: "dependencies",
      title: "Dependency Notes",
      body: input.dependencyNotes.length > 0 ? input.dependencyNotes.join("\n") : "No dependency notes recorded."
    },
    {
      key: "tests",
      title: "Related Tests",
      body: input.relatedTests.length > 0 ? input.relatedTests.join("\n") : "No related tests selected."
    },
    {
      key: "omissions",
      title: "Explicit Omissions",
      body:
        input.omittedPaths.length > 0 || input.truncationReasons.length > 0
          ? [...input.omittedPaths, ...input.truncationReasons].join("\n")
          : "No omissions recorded."
    },
    {
      key: "budget",
      title: "Token Accounting",
      body: input.budgetLine
    }
  ];
}

function createPromptId(prompt: string): string {
  return createHash("sha1").update(prompt).digest("hex").slice(0, 12);
}
