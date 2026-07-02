# Nomic architecture

```mermaid
flowchart TD
  UI["VS Code extension / CLI"] --> Engine["TypeScript orchestration engine"]
  Engine --> Backend{"NOMIC_INDEX_BACKEND"}
  Backend -->|typescript| TS["TypeScript parser + graph"]
  Backend -->|native| Addon["Async Node-API addon"]
  Addon --> CPP["C++20 scanner + BM25"]
  CPP --> DB[".nomic/index.sqlite (WAL)"]
  TS --> Candidates["Candidate features"]
  CPP --> Candidates
  Candidates --> Ranker["Versioned ranker with heuristic fallback"]
  Ranker --> Packer["Relevance-per-token symbol/chunk packing"]
  Packer --> Prompt["Deterministic prompt artifact"]
  Prompt --> Agent["Codex / Claude"]
  Agent --> Feedback["Explicit opt-in, source-free feedback"]
```

The TypeScript parser remains the compatibility source for prompt compilation while the native backend matures. In native mode it mirrors repository indexing into SQLite and supplies BM25 candidates. The boundary is intentionally replaceable so Tree-sitter symbols and graph records can move native without changing the CLI, extension, or prompt contracts.

## Native database v1

- `metadata`: schema and feature compatibility metadata
- `files`: stable file ID, normalized path, content hash, and token count
- `terms`: document frequency
- `postings`: per-file term frequency

The database is rebuildable. Session memory, overrides, and opt-in feedback stay in their existing independent files.
