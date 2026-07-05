import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNomicEngine } from "./engine";
import { InMemorySessionMemory } from "./memory/session-memory";
import { MemoryStorageBackend } from "./storage/index-store";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("NomicEngine context service", () => {
  it("falls back to TypeScript when the native addon is unavailable", async () => {
    const previousBackend = process.env.NOMIC_INDEX_BACKEND;
    const previousAddon = process.env.NOMIC_NATIVE_ADDON_PATH;
    process.env.NOMIC_INDEX_BACKEND = "native";
    process.env.NOMIC_NATIVE_ADDON_PATH = path.join(os.tmpdir(), "missing-nomic-addon.node");
    try {
      const engine = createNomicEngine({ storage: new MemoryStorageBackend(), memory: new InMemorySessionMemory() });
      expect((await engine.diagnostics()).backend).toBe("typescript");
    } finally {
      if (previousBackend === undefined) delete process.env.NOMIC_INDEX_BACKEND; else process.env.NOMIC_INDEX_BACKEND = previousBackend;
      if (previousAddon === undefined) delete process.env.NOMIC_NATIVE_ADDON_PATH; else process.env.NOMIC_NATIVE_ADDON_PATH = previousAddon;
    }
  });

  it("keeps MCP context ranking aligned with the frozen retriever and suppresses duplicate expansion", async () => {
    const root = await fixture();
    const engine = createNomicEngine({ storage: new MemoryStorageBackend(), memory: new InMemorySessionMemory() });
    const task = "fix loginUser session handling";
    const reasons = await engine.explainSelection({ text: task, target: "codex", repositoryRoot: root });
    const context = await engine.getTaskContext({ task, repositoryRoot: root, tokenBudget: 10_000, maxFiles: 10 });
    const contextPaths = [...new Set(context.context.map((range) => range.path))];
    expect(contextPaths).toEqual(reasons.slice(0, contextPaths.length).map((reason) => reason.path));
    const expanded = await engine.expandContext({ sessionId: context.sessionId, focus: "loginUser" });
    expect(expanded.context.every((range) => !context.context.some((existing) => existing.id === range.id))).toBe(true);
    const metrics = await engine.getRetrievalMetrics({ sessionId: context.sessionId });
    expect(metrics.calls).toBe(2);
  });

  it("prevents symlink escapes", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "nomic-outside-"));
    directories.push(outside);
    await writeFile(path.join(outside, "secret.ts"), "export const secret = true;", "utf8");
    await symlink(path.join(outside, "secret.ts"), path.join(root, "src", "escape.ts"));
    const engine = createNomicEngine({ storage: new MemoryStorageBackend(), memory: new InMemorySessionMemory() });
    await expect(engine.getFileRange({ repositoryRoot: root, path: "src/escape.ts", startLine: 1, endLine: 2 })).rejects.toThrow("PATH_OUTSIDE_REPOSITORY");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nomic-engine-context-"));
  directories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "auth.ts"), "export function loginUser() { return createSession(); }\nfunction createSession() { return true; }\n", "utf8");
  await writeFile(path.join(root, "src", "session.ts"), "export function refreshSession() { return true; }\n", "utf8");
  return root;
}
