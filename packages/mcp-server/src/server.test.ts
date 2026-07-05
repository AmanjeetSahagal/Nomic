import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNomicEngine, FileStorageBackend, MemoryStorageBackend } from "@nomic/core";
import { createNomicMcpServer } from "./index";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Nomic MCP server", () => {
  it("imports the pinned SDK server subpaths", () => {
    expect(McpServer).toBeTypeOf("function");
    expect(StdioServerTransport).toBeTypeOf("function");
  });

  it("lists exactly seven tools and returns compact task context", async () => {
    const root = await fixture();
    const instance = await createNomicMcpServer(root, createNomicEngine({ storage: new MemoryStorageBackend() }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "nomic_get_task_context", "nomic_expand_context", "nomic_search_symbols", "nomic_get_symbol",
        "nomic_get_file_range", "nomic_refresh_changed_files", "nomic_get_retrieval_metrics"
      ]);
      const response = await client.callTool({ name: "nomic_get_task_context", arguments: { task: "fix loginUser", token_budget: 600 } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ confidence: expect.any(String), packed_tokens: expect.any(Number), session_id: expect.any(String) });
      expect(response.structuredContent).not.toHaveProperty("debug");
      expect(Array.isArray(response.content)).toBe(true);
      expect((response.content as Array<{ type: string; text?: string }>)[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^Nomic session [0-9a-f-]+:/) });
      const malformed = await client.callTool({ name: "nomic_get_task_context", arguments: { task: "", token_budget: -1 } });
      expect(malformed.isError).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await expect(client.callTool({ name: "nomic_search_symbols", arguments: { query: "login" } }, undefined, { signal: controller.signal })).rejects.toThrow();
    } finally {
      await client.close();
      await instance.close();
    }
  });

  it("rejects traversal and secret-file reads", async () => {
    const root = await fixture();
    const instance = await createNomicMcpServer(root, createNomicEngine({ storage: new FileStorageBackend(path.join(root, "cache")) }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const traversal = await client.callTool({ name: "nomic_get_file_range", arguments: { path: "../outside.txt", start_line: 1, end_line: 2 } });
      expect(traversal.isError).toBe(true);
      const secret = await client.callTool({ name: "nomic_get_file_range", arguments: { path: ".env", start_line: 1, end_line: 2 } });
      expect(secret.isError).toBe(true);
      const gitMetadata = await client.callTool({ name: "nomic_get_file_range", arguments: { path: ".git/config", start_line: 1, end_line: 2 } });
      expect(gitMetadata.isError).toBe(true);
    } finally {
      await client.close();
      await instance.close();
    }
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nomic-mcp-"));
  directories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, "src", "auth.ts"), "export function loginUser(name: string) { return name.length > 0; }\n", "utf8");
  await writeFile(path.join(root, ".env"), "TOKEN=secret\n", "utf8");
  return root;
}
