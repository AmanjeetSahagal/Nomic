import { describe, expect, it } from "vitest";
import type { IndexedSymbol } from "../types/contracts";
import {
  buildExactCodeGraph,
  traverseExactCodeGraph,
  type GraphSourceFile
} from "./graph-reachability";

function symbol(path: string, name: string, kind: IndexedSymbol["kind"]): IndexedSymbol {
  return { id: `${path}#${name}`, path, name, kind, exported: true };
}

const files: GraphSourceFile[] = [
  {
    path: "src/base.ts",
    isTest: false,
    content: "export class Base {}\nexport interface Runnable { run(): void }\nexport function execute() {}",
    symbols: [symbol("src/base.ts", "Base", "class"), symbol("src/base.ts", "Runnable", "interface"), symbol("src/base.ts", "execute", "function")]
  },
  {
    path: "src/impl.ts",
    isTest: false,
    content: "import { Base, Runnable, execute } from './base';\nexport class Impl extends Base implements Runnable { run() { execute(); } }",
    symbols: [symbol("src/impl.ts", "Impl", "class")]
  },
  {
    path: "tests/impl.test.ts",
    isTest: true,
    content: "import { Impl } from '../src/impl';\nnew Impl().run();",
    symbols: []
  },
  {
    path: "lib/lib.es2020.d.ts",
    isTest: false,
    content: "/// <reference lib=\"es2020.string\" />",
    symbols: []
  },
  {
    path: "lib/lib.es2020.string.d.ts",
    isTest: false,
    content: "interface String { matchAll(value: string): unknown; }",
    symbols: [symbol("lib/lib.es2020.string.d.ts", "String", "interface")]
  }
];

describe("offline exact graph reachability", () => {
  it("extracts source-derived imports, calls, references, heritage, and test links", () => {
    const edges = buildExactCodeGraph(files);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "src/impl.ts", to: "src/base.ts", kind: "import", confidence: "exact" }),
      expect.objectContaining({ from: "src/impl.ts", to: "src/base.ts", kind: "call", confidence: "exact" }),
      expect.objectContaining({ from: "src/impl.ts", to: "src/base.ts", kind: "reference", confidence: "exact" }),
      expect.objectContaining({ from: "src/impl.ts", to: "src/base.ts", kind: "extends", confidence: "exact" }),
      expect.objectContaining({ from: "src/impl.ts", to: "src/base.ts", kind: "implements", confidence: "exact" }),
      expect.objectContaining({ from: "tests/impl.test.ts", to: "src/impl.ts", kind: "test-to-implementation", confidence: "exact" }),
      expect.objectContaining({ from: "lib/lib.es2020.d.ts", to: "lib/lib.es2020.string.d.ts", kind: "reference", confidence: "exact" })
    ]));
    expect(edges.every((edge) => edge.evidence.line >= 1 && edge.evidence.sourcePath === edge.from)).toBe(true);
  });

  it("records the exact shortest path recovered at one and two hops", () => {
    const edges = buildExactCodeGraph(files);
    const seeds = [{ path: "tests/impl.test.ts", rank: 1 }];
    const oneHop = traverseExactCodeGraph(edges, seeds, { maxHops: 1, maxNeighborsPerNode: 12, maxCandidates: 200 });
    expect(oneHop.paths.get("src/impl.ts")).toMatchObject({ seedPath: "tests/impl.test.ts", seedRank: 1, hops: 1 });
    expect(oneHop.paths.has("src/base.ts")).toBe(false);
    const twoHop = traverseExactCodeGraph(edges, seeds, { maxHops: 2, maxNeighborsPerNode: 12, maxCandidates: 200 });
    const recovered = twoHop.paths.get("src/base.ts");
    expect(recovered).toMatchObject({ seedPath: "tests/impl.test.ts", seedRank: 1, targetPath: "src/base.ts", hops: 2 });
    expect(recovered?.edges.map((edge) => [edge.traversalFrom, edge.traversalTo])).toEqual([
      ["tests/impl.test.ts", "src/impl.ts"],
      ["src/impl.ts", "src/base.ts"]
    ]);
    expect(recovered?.edges.every((edge) => edge.confidence === "exact")).toBe(true);
  });

  it("enforces candidate and neighbor bounds deterministically", () => {
    const edges = buildExactCodeGraph(files);
    const result = traverseExactCodeGraph(edges, [{ path: "src/impl.ts", rank: 1 }], {
      maxHops: 2,
      maxNeighborsPerNode: 1,
      maxCandidates: 2
    });
    expect(result.candidatePaths).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(traverseExactCodeGraph(edges, [{ path: "src/impl.ts", rank: 1 }], {
      maxHops: 2,
      maxNeighborsPerNode: 1,
      maxCandidates: 2
    }).candidatePaths).toEqual(result.candidatePaths);
  });
});
