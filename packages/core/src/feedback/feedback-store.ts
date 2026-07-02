import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RetrievalFeedback } from "../types/contracts";

export class LocalFeedbackStore {
  constructor(private readonly enabled = process.env.NOMIC_FEEDBACK_OPT_IN === "1") {}

  isEnabled(): boolean {
    return this.enabled;
  }

  async record(feedback: RetrievalFeedback): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }
    const records = await this.read(feedback.repositoryRoot);
    records.push(feedback);
    const filePath = feedbackPath(feedback.repositoryRoot);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    return true;
  }

  async read(repositoryRoot: string): Promise<RetrievalFeedback[]> {
    try {
      const content = await readFile(feedbackPath(repositoryRoot), "utf8");
      return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RetrievalFeedback);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  async export(repositoryRoot: string, destination: string): Promise<number> {
    const records = await this.read(repositoryRoot);
    await writeFile(destination, JSON.stringify(records, null, 2), "utf8");
    return records.length;
  }

  async clear(repositoryRoot: string): Promise<void> {
    await rm(feedbackPath(repositoryRoot), { force: true });
  }
}

function feedbackPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".nomic", "feedback-v1.jsonl");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
