# MCP-first v1 verification record

Release date: 2026-07-05

## Verified behavior

- TypeScript tests: 39 passing across core, MCP protocol, security, parity, storage, and incremental refresh.
- Workspace typecheck and build: passing.
- MCP stdio handshake: passing with exactly seven discoverable tools.
- MCP sample retrieval: passing with TypeScript and native backends.
- Frozen corpus smoke: three retrieval modes, three task-mode runs, zero failures.
- Native core: CMake configure/build and CTest passing.
- Node-API addon: macOS arm64 build and runtime load passing.
- SQLite: native index creation and retrieval passing through `nomic doctor`.
- Codex: live `nomic_get_task_context` call completed; Codex parsed confidence and source paths. Non-interactive runs require `default_tools_approval_mode = "approve"`.
- Claude Code: configuration and missing-client fallback verified; live client verification remains pending because Claude Code was not installed.
- Clean-checkout verification: a detached worktree at release commit `672e447` completed a fresh `npm ci`, all checks, MCP handshake, and sample retrieval with a clean Git status under Node.js 22.14.0.

## Tested environment

| Component | Version |
|---|---|
| Operating system | macOS 26.5.1 (25F80), arm64 |
| Node.js | 22.19.0 |
| npm | 10.9.3 |
| Codex CLI | 0.142.5 |
| Claude Code | Not installed; live verification pending |
| CMake | 4.3.4 |
| C++ compiler | Apple Clang 21.0.0 |
| SQLite | 3.51.0 |
| MCP TypeScript SDK | 1.29.0, pinned |

## Commands

```bash
npm run check
npm run native:configure
npm run native:build
npm run native:test

cmake -S native -B native/build-addon \
  -DNOMIC_BUILD_TESTS=OFF \
  -DNOMIC_BUILD_NODE_ADDON=ON \
  -DNODE_INCLUDE_DIR=/absolute/path/to/node/include/node
cmake --build native/build-addon --config Release

NOMIC_INDEX_BACKEND=native \
NOMIC_NATIVE_ADDON_PATH=/absolute/path/to/nomic_native.node \
nomic doctor
```

The complete 18-task corpus rerun was attempted but stopped after an extended run without intermediate output. The existing frozen artifacts remain unchanged; a one-task, three-mode smoke completed successfully. A complete corpus rerun should be executed in release CI or on the declared benchmark machine.
