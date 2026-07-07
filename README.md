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

It indexes a codebase, retrieves the files and symbols most relevant to a task, packs only the useful code ranges under a token budget, and serves that context to tools such as Codex through MCP.

The current release is MCP-first: the CLI and VS Code extension remain available, but the primary integration path is a local stdio MCP server.

## Release status

Current release: `mcp-first-v1`

Verified:

- Native C++ core and SQLite persistence
- Node-API addon build and runtime loading
- CTest, TypeScript tests, typecheck, and builds
- Clean-checkout source installation
- Live Codex MCP workflow
- `nomic doctor`

Pending:

- Live Claude Code MCP verification. Claude setup and fallback configuration are supported, but the live client was not installed in the verified release environment.
- Windows, Linux, Intel macOS, and older Node.js release verification.
- npm package distribution and prebuilt native binaries.

See [the MCP-first v1 verification record](docs/releases/mcp-first-v1.md).

## What works today

A developer can currently:

- clone and build Nomic from source;
- register Nomic with Codex as a project-scoped MCP server;
- launch the seven-tool local MCP server;
- retrieve BM25-ranked, exact-symbol-boosted, packed repository context;
- refresh changed files after edits;
- use the native C++/SQLite backend where available or the TypeScript fallback otherwise;
- inspect diagnostics and retrieval metrics locally.

Nomic is read-only from the MCP side. It returns context; the coding agent still performs edits, shell commands, tests, and commits through its normal tools.

## Platform and distribution scope

This release is distributed as source.

Verified release environment:

- macOS arm64
- Node.js 22.19.0
- npm 10.9.3
- TypeScript 5.9.3
- Codex CLI 0.142.5
- CMake 4.3.4
- Apple Clang 21.0.0
- SQLite 3.51.0
- `@modelcontextprotocol/sdk` 1.29.0

Other platforms may work through the native backend or TypeScript fallback, but Windows, Linux, Intel macOS, and older Node.js versions have not yet completed release verification.

Users need Git, Node.js, npm, and normal native build tooling for the C++ addon path. If the native addon is unavailable, Nomic can fall back to the TypeScript backend unless strict-native mode is configured.

Prebuilt native binaries and an npm package are planned for a later release.

## Quick start with Codex

First build Nomic once:

```bash
git clone https://github.com/AmanjeetSahagal/Nomic.git
cd Nomic
npm ci
npm run build
node apps/cli/dist/index.js doctor
```

Then register Nomic from the repository you want Codex to work on. This command should be run inside the target project, not inside the Nomic source checkout:

```bash
cd /path/to/your-project
node /absolute/path/to/Nomic/apps/cli/dist/index.js setup codex --scope project
codex
```

Project-scoped setup writes `.codex/config.toml` in the target repository and points Codex at:

```bash
node /absolute/path/to/Nomic/apps/cli/dist/index.js serve-mcp /path/to/your-project
```

For non-interactive Codex runs, Nomic configures `default_tools_approval_mode = "approve"` for its read-only MCP tools. Without that setting, a headless Codex run may cancel a tool call because it cannot show an approval prompt.

## Claude Code setup

Claude Code configuration is supported, but live Claude verification is still pending.

After building Nomic, run project-scoped setup from the target repository:

```bash
cd /path/to/your-project
node /absolute/path/to/Nomic/apps/cli/dist/index.js setup claude --scope project
```

If Claude Code is not installed, Nomic prints a manual MCP configuration instead of modifying anything silently.

## Contributor clone option

HTTPS clone is the default for users because it does not require GitHub SSH keys:

```bash
git clone https://github.com/AmanjeetSahagal/Nomic.git
```

SSH clone also works for contributors who have GitHub SSH configured:

```bash
git clone git@github.com:AmanjeetSahagal/Nomic.git
```

## MCP tools

Nomic exposes exactly seven MCP tools in `mcp-first-v1`:

1. `nomic_get_task_context`
   retrieves and packs the initial task context.
2. `nomic_expand_context`
   expands a previous context session with new, non-overlapping ranges.
3. `nomic_search_symbols`
   searches indexed symbols by exact, prefix, or lexical match.
4. `nomic_get_symbol`
   returns a bounded range around one symbol.
5. `nomic_get_file_range`
   returns a validated, bounded text range from a repository file.
6. `nomic_refresh_changed_files`
   refreshes explicit or discovered changed paths.
7. `nomic_get_retrieval_metrics`
   returns metrics for a context session.

There is intentionally no MCP `nomic_index_repository` tool. Explicit full indexing remains a CLI operation:

```bash
node /absolute/path/to/Nomic/apps/cli/dist/index.js index /path/to/your-project
```

## Default retrieval pipeline

The benchmark-frozen default pipeline is:

```text
BM25 → exact-symbol boosting → query-relevant chunk packing
```

The default path does not run:

- graph expansion;
- semantic retrieval;
- broad structural expansion;
- path overrides;
- the legacy full heuristic.

Those remain experimental or explicitly configurable behavior. The current evidence supports packing and exact symbol matching as the reliable default.

The headline result from the ablation work is that query-relevant packing preserved file ranking while reducing median selected context from 120,277 tokens to 5,550 tokens, about a 95.4% reduction.

Benchmark artifacts:

- [final 18-task pipeline report](benchmarks/reports/corpus-final-pipeline-18/README.md)
- [18-task ablation report](benchmarks/reports/corpus-ablation-18/README.md)
- [corpus methodology](benchmarks/corpus/v1/README.md)

## Local-first storage

Runtime index state is stored outside repositories by default:

- macOS: `~/Library/Caches/Nomic/`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/nomic/`
- Windows: `%LOCALAPPDATA%\Nomic\`

Repository cache directories are keyed by a hash of the canonical repository path.

Legacy `.nomic/index.json` and `.nomic/index.sqlite` files are read for compatibility and can be imported into the external cache. Nomic does not modify committed `.gitignore` files. If explicit legacy in-repository storage is selected, `.nomic/` is added only to `.git/info/exclude`.

MCP task sessions are kept in bounded process memory by default. Raw task text, source content, and full query text are not persisted by default.

## Security model

Each MCP server process is bound to one canonical repository root.

File operations:

- resolve real paths and enforce root containment;
- reject traversal, outside-root absolute paths, and symlink escapes;
- read only regular text files;
- honor ignore rules where applicable;
- enforce file-size and range limits;
- block `.env*`, private keys, credential files, SSH files, and common cloud credential directories;
- avoid logging source text, raw queries, or full repository paths.

Native failures fall back to the TypeScript backend unless strict-native mode is configured.

## Optional agent instructions

Nomic does not automatically edit `AGENTS.md` or `CLAUDE.md`.

If you want to document the workflow for an agent, add something like:

```markdown
Before broad repository exploration, call `nomic_get_task_context` with the complete task.
Use Nomic's focused expansion, symbol, and range tools for follow-up context.
After editing files, call `nomic_refresh_changed_files`.
Nomic is read-only; use normal agent tools for edits, commands, and tests.
```

## CLI commands

After building from source, invoke the CLI through `node apps/cli/dist/index.js` or through the package scripts.

Main commands:

```bash
node apps/cli/dist/index.js index [repository-root]
node apps/cli/dist/index.js serve-mcp [repository-root]
node apps/cli/dist/index.js setup codex [--scope project|user]
node apps/cli/dist/index.js setup claude [--scope local|project|user]
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js ask "your task"
node apps/cli/dist/index.js explain-selection "your task"
node apps/cli/dist/index.js benchmark [repository-root]
node apps/cli/dist/index.js feedback [status|export [path]|clear]
```

`nomic doctor` performs a real stdio MCP handshake, lists the seven tools, and runs a sample retrieval in addition to checking Node, cache permissions, root detection, index health, and fallback behavior.

## VS Code extension

The VS Code extension remains an optional review-and-approval workflow.

It supports:

- workspace indexing;
- task compilation from the sidebar;
- included/excluded file review;
- manual include, pin, and exclude overrides;
- payload preview for Codex and Claude;
- prompt opening and payload copying;
- approval-based handoff;
- compile and handoff timing diagnostics;
- debounced file watching for incremental refresh.

The MCP server is the primary integration path for `mcp-first-v1`.

## Architecture

Nomic is organized around one shared core engine:

- `packages/core`
  indexing, retrieval, compression, prompt compilation, diagnostics, storage, feedback, and benchmark logic.
- `packages/mcp-server`
  official MCP SDK stdio adapter exposing the shared engine through seven read-only tools.
- `apps/cli`
  source-built CLI for indexing, MCP serving, setup, diagnostics, benchmarks, and review flows.
- `apps/vscode-extension`
  optional sidebar workflow for context preview, review, approval, and handoff.
- `native`
  C++20 scanner, BM25 retrieval engine, SQLite index, and Node-API addon.
- `ml`
  ranking feature definitions and reproducible logistic/LightGBM-to-ONNX training pipeline scaffolding.

See [the architecture document](docs/architecture.md) for the migration boundary and native storage schema.

## Development

Install dependencies:

```bash
npm ci
```

Run the main verification suite:

```bash
npm run check
```

Run individual checks:

```bash
npm test
npm run typecheck
npm run build
```

Build and test the native core when CMake and a C++20 toolchain are installed:

```bash
npm run native:configure
npm run native:build
npm run native:test
```

Build the Node-API addon manually when needed:

```bash
cmake -S native -B native/build-addon \
  -DNOMIC_BUILD_TESTS=OFF \
  -DNOMIC_BUILD_NODE_ADDON=ON \
  -DNODE_INCLUDE_DIR=/absolute/path/to/node/include/node
cmake --build native/build-addon --config Release
```

Use the native backend explicitly:

```bash
NOMIC_INDEX_BACKEND=native \
NOMIC_NATIVE_ADDON_PATH=/absolute/path/to/nomic_native.node \
node apps/cli/dist/index.js doctor
```

Run corpus validation and benchmark tooling:

```bash
npm run corpus:validate
npm run corpus:benchmark -- --mode bm25_body,bm25_packed,bm25_symbol_packed
```

Collect new public corpus candidates when `GITHUB_TOKEN` is available:

```bash
GITHUB_TOKEN=... npm run corpus:collect -- --repo django/django --limit 10 --scan 100
```

Corpus drafts are intentionally ignored until their pre-fix query text and graded relevance labels have been reviewed.

## Current limitations

- Source installation only.
- No published npm package yet.
- No prebuilt native binaries yet.
- Live release verification is macOS arm64 only.
- Claude Code setup exists, but live Claude MCP verification is pending.
- Tree-sitter AST extraction, stable native graph persistence, row-level incremental SQLite updates, and a production ONNX ranker remain future work.

## Vision

Nomic treats repository context like a build artifact: indexed, ranked, packed, reviewed, and served locally before it reaches the coding agent.
