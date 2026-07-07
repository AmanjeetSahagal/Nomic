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

Nomic is a local-first repository context server for AI coding agents.

Instead of sending an entire repository to tools like Codex or Claude, Nomic indexes the codebase, retrieves the most relevant files and supporting artifacts for a task, compresses lower-priority context, and compiles a deterministic prompt for handoff.

## Release Status

Current release: `mcp-first-v1`

Verified:

- Native C++ core and SQLite persistence
- Node-API addon build and runtime loading
- CTest, TypeScript tests, typecheck, and builds
- Clean-checkout installation
- Live Codex MCP workflow
- `nomic doctor`

Pending:

- Live Claude Code MCP verification. Claude setup and fallback configuration are supported, but the live client was not installed in the verified release environment.

## What It Does Today

- Indexes repositories into files, symbols, chunks, and graph edges.
- Extracts imports, references, callers/callees, and test relationships for TypeScript and JavaScript files through the TypeScript compiler API.
- Runs the benchmark-frozen default retrieval path:
  BM25, exact-symbol boosting, and query-relevant chunk packing.
- Compresses context with token budgeting:
  high-priority implementation files stay raw when possible, while dependencies and supporting files are summarized.
- Compiles a stable prompt artifact with:
  task, constraints, retrieval rationale, raw files, summaries, dependency notes, tests, omissions, and token accounting.
- Formats the compiled prompt for Codex or Claude through a thin adapter layer.
- Stores session memory and exposes diagnostics, benchmark output, and selection transparency.

## Product Surfaces

### MCP Server

MCP is the primary integration. It is local, read-only, and exposes seven focused tools to Codex and Claude Code over stdio.

This release is distributed as source. Prebuilt native binaries and an npm package are planned for a later release. The verified release environment is macOS arm64 with Node.js 22.19.0. Other platforms may work through the native backend or TypeScript fallback, but Windows, Linux, Intel macOS, and older Node.js versions have not yet completed release verification.

First build Nomic once:

```bash
git clone https://github.com/AmanjeetSahagal/Nomic.git
cd Nomic
npm ci
npm run build
node apps/cli/dist/index.js doctor
```

Then register Nomic from the repository you want Codex or Claude Code to index. Project-scoped setup writes configuration into that target repository, not into the Nomic source checkout:

```bash
cd /absolute/path/to/target-repository
node /absolute/path/to/Nomic/apps/cli/dist/index.js setup codex --scope project
node /absolute/path/to/Nomic/apps/cli/dist/index.js doctor
```

For Claude Code:

```bash
cd /absolute/path/to/target-repository
node /absolute/path/to/Nomic/apps/cli/dist/index.js setup claude --scope project
```

SSH clone is also supported for contributors who have GitHub SSH keys configured:

```bash
git clone git@github.com:AmanjeetSahagal/Nomic.git
```

Optional `AGENTS.md` or `CLAUDE.md` guidance (Nomic never edits these files automatically):

```markdown
Before broad repository exploration, call `nomic_get_task_context` with the complete task.
Use Nomic's focused expansion, symbol, and range tools for follow-up context.
After editing files, call `nomic_refresh_changed_files`.
Nomic is read-only; use normal agent tools for edits, commands, and tests.
```

The server returns compact, token-budgeted code ranges. Graph expansion, semantic retrieval, path overrides, and the legacy heuristic are experimental and disabled by default.

For non-interactive Codex runs, set `default_tools_approval_mode = "approve"` in the project-scoped Nomic MCP table. Nomic's seven tools are read-only; without this setting a headless Codex run may cancel the tool call because it cannot display an approval prompt.

The MCP adapter pins `@modelcontextprotocol/sdk` 1.29.0 because the official SDK currently recommends the v1 line for production while v2 remains prerelease. It intentionally imports `server/mcp.js` and `server/stdio.js` subpaths rather than the package root; Dependabot tracks compatible fixes.

### VS Code Extension

The VS Code extension remains an optional inspection and approval workflow.

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
- `nomic serve-mcp [repository-root]`
- `nomic setup codex [--scope project|user]`
- `nomic setup claude [--scope local|project|user]`
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
- `native`
  C++20 scanner, BM25 retrieval engine, SQLite index, and asynchronous Node-API addon
- `ml`
  versioned ranking features and reproducible logistic/LightGBM-to-ONNX training pipeline

See [the architecture document](docs/architecture.md) for the migration boundary and native storage schema.

### Core Pipeline

1. Repository indexing
   scans files, extracts symbols and relationships, and creates retrievable chunks
2. BM25 retrieval
   ranks lexically relevant files
3. Exact-symbol boosting
   promotes files containing identifiers named in the task
4. Query-relevant packing
   selects bounded code ranges under the token budget
5. Prompt compilation
   emits one deterministic prompt artifact that downstream adapters can format for the target agent

## Local-First Storage

New indexes are stored outside repositories under the platform cache directory, keyed by a hash of the canonical repository path:

- macOS: `~/Library/Caches/Nomic/`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/nomic/`
- Windows: `%LOCALAPPDATA%\Nomic\`

Legacy `.nomic/index.json` files are imported for compatibility. MCP task sessions remain in bounded memory and do not persist raw task text or source content.

Legacy artifacts may include:

- `index.json`
  repository index with files, symbols, chunks, and graph edges
- `session-memory.json`
  recent compiled prompts and selected-file memory

No hosted service or external database is required.

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

Build and review the public issue-to-patch corpus:

```bash
GITHUB_TOKEN=... npm run corpus:collect -- --repo django/django --limit 10 --scan 100
npm run corpus:review -- --draft benchmarks/corpus/v1/drafts/django-django.json --list
npm run corpus:validate
```

Corpus drafts are intentionally ignored until their pre-fix query text and graded relevance labels have been reviewed. See [the corpus methodology](benchmarks/corpus/v1/README.md).

Build and test the native core when CMake and a C++20 toolchain are installed:

```bash
npm run native:configure
npm run native:build
npm run native:test
```

Set `NOMIC_INDEX_BACKEND=native` after building the addon, or provide its location with `NOMIC_NATIVE_ADDON_PATH`. TypeScript remains the default until native parser and graph parity gates pass.

## Current Status

The current implementation includes:

- parser-backed indexing for TS/JS repositories
- BM25 + exact-symbol retrieval with query-relevant packing
- local stdio MCP server with seven read-only tools
- token-budgeted compression and deterministic prompt compilation
- Codex and Claude adapters
- session memory and engine diagnostics
- VS Code preview and approval workflows
- CLI review workflows
- automated tests for indexing, retrieval, compression, storage, memory, and adapters
- versioned retrieval metrics, ranking features, and deterministic model fallback
- an opt-in local feedback store with status, export, and deletion commands
- a functional native C++ BM25/SQLite preview with asynchronous Node-API bindings
- debounced VS Code file watching for incremental reindexing

The native preview does not yet include Tree-sitter AST extraction, graph persistence, row-level incremental SQLite updates, prebuilt addon distribution, or a trained production ONNX artifact. Those remain gated on the reviewed public benchmark corpus rather than being represented as complete.

Recent benchmark output on the built-in fixture:

- indexing: about `15.6ms`
- average compile time: about `1.6ms`
- Recall@10: `1.0`
- NDCG@10: about `0.82`
- peak token estimate: `1366`

These numbers come from the current local benchmark fixture and are intended as a sanity check, not a production benchmark claim.

## Vision

Nomic treats prompts like build artifacts:
analyzed, ranked, compressed, reviewed, and tailored before they reach the coding agent.
- `packages/mcp-server`
  thin official-SDK adapter exposing the shared engine through seven stdio tools
