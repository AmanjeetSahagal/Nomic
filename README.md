# Nomic

Nomic is a context orchestration engine for AI coding agents.

Instead of sending entire repositories into tools like Codex or Claude, Nomic analyzes the codebase, selects the most relevant files and dependencies, compresses the surrounding context, and compiles a task-specific prompt for the target agent.

Nomic is designed for large repositories, multi-file refactors, feature work, and debugging sessions where raw prompt size and irrelevant context reduce agent quality.

## What Nomic Does

- Indexes repositories into a structured view of files, symbols, imports, and relationships.
- Retrieves relevant code, dependencies, tests, and supporting artifacts for a task.
- Compresses large context into structured summaries while preserving interfaces and key logic.
- Compiles optimized prompts for coding agents.
- Exposes transparent context selection so developers can inspect what is included and excluded.

## Product Surfaces

- CLI workflows for indexing repositories and compiling prompts from the terminal.
- VS Code extension workflows for previewing context, reviewing token usage, and sending compiled prompts to supported agents.

## Architecture

Nomic is organized around a shared core engine with separate user-facing surfaces:

- `packages/core`: indexing, retrieval, compression, prompt compilation, memory, and adapter contracts.
- `apps/cli`: command-line interface.
- `apps/vscode-extension`: VS Code extension.

## Vision

Nomic treats prompts like build artifacts: analyzed, optimized, and tailored to the task before they reach the coding agent.
