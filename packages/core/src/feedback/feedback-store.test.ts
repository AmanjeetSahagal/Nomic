import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFeedbackStore } from "./feedback-store";

describe("LocalFeedbackStore", () => {
  it("does not write without explicit opt-in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nomic-feedback-"));
    const store = new LocalFeedbackStore(false);
    expect(await store.record({ schemaVersion: 1, taskHash: "x", repositoryRoot: root, candidatePaths: [], selectedPaths: [], acceptedPatchPaths: [], createdAt: new Date(0).toISOString() })).toBe(false);
    expect(await store.read(root)).toEqual([]);
  });

  it("records and exports source-free feedback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nomic-feedback-"));
    const store = new LocalFeedbackStore(true);
    await store.record({ schemaVersion: 1, taskHash: "hash", repositoryRoot: root, candidatePaths: ["src/a.ts"], selectedPaths: ["src/a.ts"], acceptedPatchPaths: ["src/a.ts"], createdAt: new Date(0).toISOString() });
    const destination = path.join(root, "feedback.json");
    expect(await store.export(root, destination)).toBe(1);
    expect(await readFile(destination, "utf8")).not.toContain("sourceText");
  });
});
