import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNomicEngine } from "../engine";
import type { UserTask } from "../types/contracts";

async function main(): Promise<void> {
  const repositoryRoot = await createFixtureRepository();
  const engine = createNomicEngine();
  const tasks: UserTask[] = [
    { text: "refactor authentication login flow", target: "codex", repositoryRoot },
    { text: "fix session reliability regression", target: "codex", repositoryRoot },
    { text: "improve authentication documentation", target: "claude", repositoryRoot }
  ];
  const report = await engine.benchmark(repositoryRoot, tasks);

  console.log("Nomic benchmark");
  console.log(`Repository: ${report.repositoryRoot}`);
  console.log(`Index ms: ${report.indexMs.toFixed(1)}`);
  console.log(`Average compile ms: ${report.averageCompileMs.toFixed(1)}`);
  console.log(`Peak token estimate: ${report.peakTokenEstimate}`);
  for (const compile of report.compileReports) {
    console.log(`- ${compile.target} :: ${compile.task}`);
    console.log(`  totalMs=${compile.totalMs.toFixed(1)} tokens=${compile.tokenEstimate} files=${compile.includedFiles}`);
  }
}

async function createFixtureRepository(): Promise<string> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "nomic-benchmark-"));
  await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "tests"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "docs"), { recursive: true });

  await writeFile(
    path.join(repositoryRoot, "src", "auth.ts"),
    [
      'import { hashPassword } from "./crypto";',
      'import { createSession } from "./session";',
      "export class AuthService {",
      "  async loginUser(username: string, password: string) {",
      "    const hashed = await hashPassword(password);",
      "    return createSession(username + hashed);",
      "  }",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "src", "crypto.ts"),
    "export async function hashPassword(value: string) { return `hash:${value}`; }",
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "src", "session.ts"),
    "export function createSession(userId: string) { return { id: userId, createdAt: Date.now() }; }",
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "tests", "auth.test.ts"),
    'import { AuthService } from "../src/auth";\nnew AuthService().loginUser("a","b");',
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "docs", "auth.md"),
    "# Auth architecture\n\nThe login flow depends on hashing and session creation.",
    "utf8"
  );

  return repositoryRoot;
}

void main().catch((error: unknown) => {
  console.error("Nomic benchmark failed.");
  console.error(error);
  process.exitCode = 1;
});
