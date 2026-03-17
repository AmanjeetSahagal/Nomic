import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CompiledPrompt,
  type SessionMemory,
  type SessionRecord,
  type UserTask
} from "../types/contracts";

export class InMemorySessionMemory implements SessionMemory {
  private readonly records: SessionRecord[] = [];

  async remember(_task: UserTask, compiledPrompt: CompiledPrompt): Promise<void> {
    this.records.unshift({
      task: _task,
      compiledPrompt,
      createdAt: new Date().toISOString()
    });
  }

  async recent(limit: number, repositoryRoot?: string): Promise<SessionRecord[]> {
    const filtered = repositoryRoot
      ? this.records.filter((record) => record.task.repositoryRoot === repositoryRoot)
      : this.records;
    return filtered.slice(0, limit);
  }
}

export class FileSessionMemory implements SessionMemory {
  async remember(task: UserTask, compiledPrompt: CompiledPrompt): Promise<void> {
    const repositoryRoot = task.repositoryRoot ?? process.cwd();
    const existing = await this.recent(20, repositoryRoot);
    const records: SessionRecord[] = [
      {
        task,
        compiledPrompt,
        createdAt: new Date().toISOString()
      },
      ...existing
    ].slice(0, 20);

    await writeSessionRecords(repositoryRoot, records);
  }

  async recent(limit: number, repositoryRoot?: string): Promise<SessionRecord[]> {
    const root = repositoryRoot ?? process.cwd();

    try {
      const contents = await readFile(getSessionFilePath(root), "utf8");
      const records = JSON.parse(contents) as SessionRecord[];
      return records.slice(0, limit);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }
  }
}

async function writeSessionRecords(repositoryRoot: string, records: SessionRecord[]): Promise<void> {
  const sessionPath = getSessionFilePath(repositoryRoot);
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, JSON.stringify(records, null, 2), "utf8");
}

function getSessionFilePath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".nomic", "session-memory.json");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
