<table>
  <tr>
    <td width="84" valign="middle">
      <img src="apps/vscode-extension/media/white_transparent_logo.png" alt="Nomic logo" width="72" height="72" style="border-radius:50%; object-fit:cover; object-position:center;" />
    </td>
    <td valign="middle">
      <h1 style="margin:0;">Nomic</h1>
    </td>
  </tr>
</table>

Nomic is a local-first context orchestration layer for AI coding agents.

Instead of sending an entire repository to tools like Codex or Claude, Nomic indexes the codebase, retrieves the most relevant files and supporting artifacts for a task, compresses lower-priority context, and compiles a deterministic prompt for handoff.

## What It Does Today

- Indexes repositories into files, symbols, chunks, and graph edges.
- Extracts imports, references, callers/callees, and test relationships for TypeScript and JavaScript files through the TypeScript compiler API.
- Runs hybrid retrieval:
  structural graph expansion plus chunk-level semantic ranking and reranking.
- Compresses context with token budgeting:
  high-priority implementation files stay raw when possible, while dependencies and supporting files are summarized.
- Compiles a stable prompt artifact with:
  task, constraints, retrieval rationale, raw files, summaries, dependency notes, tests, omissions, and token accounting.
- Formats the compiled prompt for Codex or Claude through a thin adapter layer.
- Stores session memory and exposes diagnostics, benchmark output, and selection transparency.

## Product Surfaces

### VS Code Extension

The VS Code extension is the primary developer workflow today.

It currently supports:

- workspace indexing
- task compilation from the sidebar
- included/excluded file review
- manual include, pin, and exclude overrides
- payload preview for Codex and Claude
- prompt opening and payload copying
- approval-based handoff with recent approval history
- compile and handoff timing diagnostics in the sidebar

#### Basic Extension Workflow

In the normal case, a developer uses the extension like this:

1. Open a repository in VS Code.
2. Open the Nomic sidebar.
3. Click `Index Workspace`.
4. Enter a task such as `refactor authentication login flow`.
5. Choose `Codex` or `Claude`.
6. Click `Compile`.
7. Review the selected files, omitted files, retrieval rationale, token usage, and compiled payload.
8. Optionally pin or exclude files and recompile.
9. Click `Approve Handoff` when the context looks correct.

This makes Nomic a review-and-approval layer between the codebase and the coding agent.

### CLI

The CLI currently supports:

- `nomic index [repository-root]`
- `nomic ask "your task"`
- `nomic explain-selection "your task"`
- `nomic doctor`
- `nomic benchmark [repository-root]`

`nomic ask` is a review-first flow. It shows selected files, selection rationale, token usage, omissions, the compiled prompt preview, and the final target payload.

## Architecture

Nomic is organized around one shared core engine used by both user surfaces:

- `packages/core`
  indexing, retrieval, compression, prompt compilation, session memory, diagnostics, benchmarking, and agent adapters
- `apps/vscode-extension`
  sidebar workflow for context preview, approval, and handoff
- `apps/cli`
  terminal workflows for indexing, review, explanation, diagnostics, and benchmarking

### Core Pipeline

1. Repository indexing
   scans files, extracts symbols and relationships, creates retrievable chunks, and persists an incremental index under `.nomic`
2. Structural retrieval
   scores likely entry files and expands through graph edges such as imports, references, callers/callees, and tests
3. Semantic retrieval
   ranks code and doc chunks with a local vector-style embedding scorer and lifts the best chunks into file candidates
4. Reranking
   combines structural score, semantic score, dependency distance, recency, importance, and token cost
5. Compression
   preserves raw code for the highest-priority context and summarizes lower-priority files into structured summaries
6. Prompt compilation
   emits one deterministic prompt artifact that downstream adapters can format for the target agent

## Local-First Storage

Nomic stores local artifacts inside `.nomic` in the target repository:

- `index.json`
  repository index with files, symbols, chunks, and graph edges
- `session-memory.json`
  recent compiled prompts and selected-file memory

No external database is required for the current implementation.

## Development

### Install

```bash
npm install
```

### Common Commands

```bash
npm test
npm run build
npm run typecheck
npm run benchmark
```

Run the CLI locally:

```bash
npm run cli -- ask "refactor authentication login flow"
```

Run the core benchmark fixture:

```bash
npm run benchmark
```

## Current Status

The current implementation includes:

- parser-backed indexing for TS/JS repositories
- hybrid structural + semantic retrieval
- token-budgeted compression and deterministic prompt compilation
- Codex and Claude adapters
- session memory and engine diagnostics
- VS Code preview and approval workflows
- CLI review workflows
- automated tests for indexing, retrieval, compression, storage, memory, and adapters

Recent benchmark output on the built-in fixture:

- indexing: about `15.8ms`
- average compile time: about `1.9ms`
- peak token estimate: `747`

These numbers come from the current local benchmark fixture and are intended as a sanity check, not a production benchmark claim.

## Vision

Nomic treats prompts like build artifacts:
analyzed, ranked, compressed, reviewed, and tailored before they reach the coding agent.
