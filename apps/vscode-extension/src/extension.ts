import * as vscode from "vscode";
import {
  createNomicEngine,
  type AgentPayload,
  type AgentTarget,
  type CompiledPrompt,
  type UserTask
} from "@nomic/core";

const VIEW_ID = "nomic.preview";
const CONTAINER_ID = "nomic";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new NomicPreviewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.indexWorkspace", async () => {
      await revealNomicView();
      await provider.indexWorkspace();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.compileContext", async () => {
      await revealNomicView();
      await provider.promptAndCompile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.refreshPreview", async () => {
      await revealNomicView();
      await provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.copyPayload", async () => {
      await revealNomicView();
      await provider.copyPayload();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.openPayload", async () => {
      await revealNomicView();
      await provider.openPayloadDocument();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.openCompiledPrompt", async () => {
      await revealNomicView();
      await provider.openCompiledPromptDocument();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.sendToAgent", async () => {
      await revealNomicView();
      await provider.sendToAgent();
    })
  );
}

export function deactivate(): void {}

class NomicPreviewProvider implements vscode.WebviewViewProvider {
  private readonly engine = createNomicEngine();
  private view?: vscode.WebviewView;
  private target: AgentTarget = "codex";
  private taskText = "";
  private status = "Ready";
  private compiled?: CompiledPrompt;
  private payload?: AgentPayload;
  private workspaceRoot?: string;
  private pinnedPaths = new Set<string>();
  private excludedPaths = new Set<string>();
  private loadedWorkspaceRoot?: string;
  private pendingApprovalPromptId?: string;
  private handoffHistory: HandoffRecord[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case "compile":
          this.taskText = message.taskText.trim();
          this.target = message.target;
          await this.compileCurrentTask();
          return;
        case "index":
          await this.indexWorkspace();
          return;
        case "open-file":
          await this.openWorkspaceFile(message.path);
          return;
        case "toggle-pin":
          this.togglePin(message.path);
          await this.compileCurrentTask();
          return;
        case "toggle-exclude":
          this.toggleExclude(message.path);
          await this.compileCurrentTask();
          return;
        case "include-path":
          this.excludedPaths.delete(message.path);
          this.pinnedPaths.add(message.path);
          await this.persistOverrideState();
          await this.compileCurrentTask();
          return;
        case "switch-target":
          this.target = message.target;
          if (this.compiled) {
            this.payload = await this.engine.formatForTarget(this.compiled, this.target);
          }
          this.render();
          return;
        case "copy-payload":
          await this.copyPayload();
          return;
        case "open-payload":
          await this.openPayloadDocument();
          return;
        case "open-compiled-prompt":
          await this.openCompiledPromptDocument();
          return;
        case "send-to-agent":
          await this.sendToAgent();
          return;
        default:
          return;
      }
    });

    this.render();
  }

  async promptAndCompile(): Promise<void> {
    const taskText = await vscode.window.showInputBox({
      prompt: "Describe the coding task to compile context for",
      value: this.taskText
    });

    if (!taskText) {
      return;
    }

    this.taskText = taskText;
    await this.compileCurrentTask();
  }

  async indexWorkspace(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    await this.ensureOverrideStateLoaded(workspaceRoot);

    this.status = "Indexing workspace";
    this.render();

    const result = await this.engine.indexRepository({
      repositoryRoot: workspaceRoot
    });

    this.status = `Indexed ${result.fileCount} files`;
    this.workspaceRoot = workspaceRoot;
    this.render();
  }

  async refresh(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (workspaceRoot) {
      await this.ensureOverrideStateLoaded(workspaceRoot);
    }

    if (this.taskText) {
      await this.compileCurrentTask();
      return;
    }

    this.render();
  }

  async copyPayload(): Promise<void> {
    if (!this.payload) {
      void vscode.window.showWarningMessage("Compile context before copying a payload.");
      return;
    }

    await vscode.env.clipboard.writeText(formatPayloadText(this.payload));
    this.status = `Copied ${this.payload.target} payload`;
    this.render();
    void vscode.window.showInformationMessage(`Copied ${this.payload.target} payload to clipboard.`);
  }

  async openPayloadDocument(): Promise<void> {
    if (!this.payload) {
      void vscode.window.showWarningMessage("Compile context before opening a payload.");
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      content: formatPayloadText(this.payload),
      language: "markdown"
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async openCompiledPromptDocument(): Promise<void> {
    if (!this.compiled) {
      void vscode.window.showWarningMessage("Compile context before opening the compiled prompt.");
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      content: this.compiled.prompt,
      language: "markdown"
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async sendToAgent(): Promise<void> {
    if (!this.payload) {
      void vscode.window.showWarningMessage("Compile context before approving a handoff.");
      return;
    }

    await vscode.env.clipboard.writeText(formatPayloadText(this.payload));
    if (this.workspaceRoot) {
      const record: HandoffRecord = {
        promptId: this.payload.metadata.promptId,
        target: this.payload.target,
        createdAt: new Date().toISOString()
      };
      this.handoffHistory = [record, ...this.handoffHistory.filter((entry) => entry.promptId !== record.promptId)].slice(0, 5);
      await this.context.workspaceState.update(getHandoffStateKey(this.workspaceRoot), this.handoffHistory);
      this.pendingApprovalPromptId = undefined;
    }
    this.status = `Approved ${this.payload.target} handoff ${this.payload.metadata.promptId}`;
    this.render();
    void vscode.window.showInformationMessage(
      `Approved ${this.payload.target} handoff. Payload ${this.payload.metadata.promptId} copied to clipboard.`
    );
  }

  private async compileCurrentTask(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    await this.ensureOverrideStateLoaded(workspaceRoot);

    if (!this.taskText.trim()) {
      void vscode.window.showWarningMessage("Enter a task before compiling context.");
      return;
    }

    this.status = "Compiling context";
    this.workspaceRoot = workspaceRoot;
    this.render();

    const task: UserTask = {
      text: this.taskText,
      target: this.target,
      repositoryRoot: workspaceRoot,
      overrides: {
        pinnedPaths: [...this.pinnedPaths],
        excludedPaths: [...this.excludedPaths]
      }
    };

    this.compiled = await this.engine.compileTask(task);
    this.payload = await this.engine.formatForTarget(this.compiled, this.target);
    this.pendingApprovalPromptId = this.compiled.promptId;
    this.status = `Compiled for ${this.target}`;
    this.render();
  }

  private getWorkspaceRoot(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.status = "Open a workspace to use Nomic";
      this.render();
      void vscode.window.showWarningMessage("Open a workspace before using Nomic.");
      return undefined;
    }

    return workspaceFolder.uri.fsPath;
  }

  private async openWorkspaceFile(relativePath: string): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    const uri = vscode.Uri.joinPath(vscode.Uri.file(this.workspaceRoot), relativePath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false
    });
  }

  private togglePin(path: string): void {
    if (this.pinnedPaths.has(path)) {
      this.pinnedPaths.delete(path);
      void this.persistOverrideState();
      return;
    }

    this.pinnedPaths.add(path);
    this.excludedPaths.delete(path);
    void this.persistOverrideState();
  }

  private toggleExclude(path: string): void {
    if (this.excludedPaths.has(path)) {
      this.excludedPaths.delete(path);
      void this.persistOverrideState();
      return;
    }

    this.excludedPaths.add(path);
    this.pinnedPaths.delete(path);
    void this.persistOverrideState();
  }

  private async ensureOverrideStateLoaded(workspaceRoot: string): Promise<void> {
    if (this.loadedWorkspaceRoot === workspaceRoot) {
      return;
    }

    const saved = this.context.workspaceState.get<TaskOverrideState>(getOverrideStateKey(workspaceRoot));
    this.pinnedPaths = new Set(saved?.pinnedPaths ?? []);
    this.excludedPaths = new Set(saved?.excludedPaths ?? []);
    this.handoffHistory = this.context.workspaceState.get<HandoffRecord[]>(getHandoffStateKey(workspaceRoot)) ?? [];
    this.loadedWorkspaceRoot = workspaceRoot;
  }

  private async persistOverrideState(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    await this.context.workspaceState.update(getOverrideStateKey(this.workspaceRoot), {
      pinnedPaths: [...this.pinnedPaths],
      excludedPaths: [...this.excludedPaths]
    } satisfies TaskOverrideState);
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = getWebviewHtml(this.view.webview, {
      iconUri: this.view.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", "vscode_grey_logo.png")
      ).toString(),
      taskText: this.taskText,
      target: this.target,
      status: this.status,
      compiled: this.compiled,
      payload: this.payload,
      workspaceRoot: this.workspaceRoot,
      pinnedPaths: [...this.pinnedPaths],
      excludedPaths: [...this.excludedPaths],
      pendingApprovalPromptId: this.pendingApprovalPromptId,
      handoffHistory: this.handoffHistory
    });
  }
}

type WebviewMessage =
  | {
      type: "compile";
      taskText: string;
      target: AgentTarget;
    }
  | {
      type: "index";
    }
  | {
      type: "open-file";
      path: string;
    }
  | {
      type: "toggle-pin";
      path: string;
    }
  | {
      type: "toggle-exclude";
      path: string;
    }
  | {
      type: "include-path";
      path: string;
    }
  | {
      type: "switch-target";
      target: AgentTarget;
    }
  | {
      type: "copy-payload";
    }
  | {
      type: "open-payload";
    }
  | {
      type: "open-compiled-prompt";
    }
  | {
      type: "send-to-agent";
    };

interface TaskOverrideState {
  pinnedPaths: string[];
  excludedPaths: string[];
}

interface HandoffRecord {
  promptId: string;
  target: AgentTarget;
  createdAt: string;
}

function getWebviewHtml(
  webview: vscode.Webview,
  state: {
    iconUri: string;
    taskText: string;
    target: AgentTarget;
    status: string;
    compiled?: CompiledPrompt;
    payload?: AgentPayload;
    workspaceRoot?: string;
    pinnedPaths: string[];
    excludedPaths: string[];
    pendingApprovalPromptId?: string;
    handoffHistory: HandoffRecord[];
  }
): string {
  const nonce = getNonce();
  const rawCount = state.compiled?.summaries.filter((item) => item.compression === "raw").length ?? 0;
  const summaryCount = state.compiled?.summaries.filter((item) => item.compression === "summary").length ?? 0;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nomic</title>
    <style>
      :root {
        --panel: color-mix(in srgb, var(--vscode-editor-background) 92%, #143a52 8%);
        --panel-strong: color-mix(in srgb, var(--vscode-sideBar-background) 82%, #0a2231 18%);
        --border: color-mix(in srgb, var(--vscode-editor-foreground) 14%, transparent);
        --accent: var(--vscode-textLink-foreground);
        --accent-soft: color-mix(in srgb, var(--accent) 20%, transparent);
        --muted: var(--vscode-descriptionForeground);
        --text: var(--vscode-foreground);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--text);
        background:
          radial-gradient(circle at top right, rgba(95, 175, 255, 0.14), transparent 34%),
          linear-gradient(180deg, var(--vscode-sideBar-background), color-mix(in srgb, var(--vscode-sideBar-background) 90%, #091319 10%));
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        overflow-x: hidden;
      }
      .shell {
        padding: 16px;
        display: grid;
        gap: 14px;
      }
      .hero, .card {
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent), var(--panel);
        border-radius: 16px;
        padding: 14px;
      }
      .hero {
        background:
          linear-gradient(135deg, rgba(95, 175, 255, 0.18), rgba(26, 81, 112, 0.06)),
          var(--panel-strong);
        padding: 18px;
      }
      .brand {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        min-width: 0;
      }
      .brand-mark {
        width: 56px;
        height: 56px;
        padding: 6px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow:
          inset 0 0 0 1px rgba(0, 0, 0, 0.06),
          0 6px 18px rgba(0, 0, 0, 0.12);
        object-fit: contain;
        display: block;
        flex: 0 0 auto;
      }
      .brand-copy {
        min-width: 0;
        display: grid;
        gap: 6px;
      }
      .kicker {
        font-size: 10px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: var(--muted);
        line-height: 1.5;
      }
      h1, h2 {
        margin: 6px 0 0;
        font-family: "Georgia", serif;
        font-weight: 600;
      }
      h1 {
        margin: 0;
        font-size: 20px;
        line-height: 1.05;
        letter-spacing: -0.02em;
        max-width: 8ch;
      }
      h2 { font-size: 15px; }
      .hero-meta {
        margin-top: 16px;
        display: grid;
        gap: 10px;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--text);
        font-size: 12px;
      }
      .status::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 16px var(--accent);
      }
      .workspace {
        margin-top: 10px;
        font-size: 12px;
        color: var(--muted);
        word-break: break-all;
      }
      .controls {
        display: grid;
        gap: 10px;
      }
      textarea, select {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: color-mix(in srgb, var(--vscode-input-background) 88%, black 12%);
        color: var(--text);
        padding: 10px 12px;
        font: inherit;
      }
      textarea {
        min-height: 92px;
        resize: vertical;
      }
      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
      }
      button {
        border: 0;
        border-radius: 12px;
        padding: 10px 12px;
        font: inherit;
        cursor: pointer;
        transition: transform 120ms ease, opacity 120ms ease;
      }
      button:hover { transform: translateY(-1px); }
      .primary {
        background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, white 45%));
        color: var(--vscode-button-foreground);
      }
      .ghost {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
      }
      .actions {
        display: grid;
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .actions.secondary {
        grid-template-columns: 1fr;
      }
      .metrics {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .metric {
        padding: 10px;
        border-radius: 12px;
        background: color-mix(in srgb, var(--panel) 86%, white 4%);
        border: 1px solid var(--border);
      }
      .metric strong {
        display: block;
        font-size: 20px;
        margin-top: 4px;
      }
      .list {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }
      .item {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 10px;
        background: color-mix(in srgb, var(--panel) 84%, white 3%);
      }
      .item button {
        margin-top: 8px;
        width: 100%;
      }
      .item-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 8px;
      }
      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }
      .pill {
        padding: 5px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--panel) 88%, white 4%);
        font-size: 11px;
      }
      .mono {
        font-family: "SFMono-Regular", "Consolas", monospace;
        font-size: 12px;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "SFMono-Regular", "Consolas", monospace;
        font-size: 12px;
        margin: 0;
      }
      .empty {
        color: var(--muted);
        font-size: 12px;
      }
      @media (min-width: 420px) {
        .actions {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .actions.secondary {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 360px) {
        .brand {
          gap: 10px;
        }
        .brand-mark {
          width: 48px;
          height: 48px;
        }
        h1 { font-size: 18px; }
        .row {
          grid-template-columns: 1fr;
        }
        .metrics {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="brand">
          <img class="brand-mark" src="${state.iconUri}" alt="Nomic logo" />
          <div class="brand-copy">
            <div class="kicker">Context Orchestration</div>
            <h1>Nomic Preview</h1>
          </div>
        </div>
        <div class="hero-meta">
          <div class="status">${escapeHtml(state.status)}</div>
          <div class="workspace">${escapeHtml(state.workspaceRoot ?? "No workspace loaded")}</div>
        </div>
      </section>

      <section class="card">
        <div class="kicker">Task</div>
        <div class="controls">
          <textarea id="taskText" placeholder="Refactor authentication middleware and keep test coverage intact">${escapeHtml(state.taskText)}</textarea>
          <div class="row">
            <select id="target">
              <option value="codex" ${state.target === "codex" ? "selected" : ""}>Codex</option>
              <option value="claude" ${state.target === "claude" ? "selected" : ""}>Claude</option>
            </select>
            <button class="primary" id="compileButton">Compile</button>
          </div>
          <div class="actions">
            <button class="ghost" id="indexButton">Index Workspace</button>
            <button class="ghost" id="targetButton">Switch Target View</button>
            <button class="ghost" id="copyButton">Copy Payload</button>
          </div>
          <div class="actions secondary">
            <button class="ghost" id="openPayloadButton">Open Payload</button>
            <button class="ghost" id="openPromptButton">Open Prompt</button>
            <button class="primary" id="sendButton">Approve Handoff</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="kicker">Metrics</div>
        <div class="metrics">
          <div class="metric">Included Files<strong>${state.compiled?.includedFiles.length ?? 0}</strong></div>
          <div class="metric">Token Estimate<strong>${state.compiled?.tokenEstimate ?? 0}</strong></div>
          <div class="metric">Raw Blocks<strong>${rawCount}</strong></div>
          <div class="metric">Summaries<strong>${summaryCount}</strong></div>
          <div class="metric">Prompt ID<strong>${escapeHtml(state.compiled?.promptId ?? "n/a")}</strong></div>
          <div class="metric">Related Tests<strong>${state.compiled?.relatedTests.length ?? 0}</strong></div>
        </div>
      </section>

      <section class="card">
        <div class="kicker">Retrieval</div>
        ${
          state.compiled?.retrievalSummary.length
            ? `<pre>${escapeHtml(state.compiled.retrievalSummary.join("\n"))}</pre>`
            : '<div class="empty">Compile a task to inspect retrieval rationale.</div>'
        }
      </section>

      <section class="card">
        <div class="kicker">Handoff</div>
        ${
          state.compiled
            ? `<pre>${escapeHtml(
                `pendingApproval=${state.pendingApprovalPromptId === state.compiled.promptId ? "yes" : "no"}\npromptId=${state.compiled.promptId}\ncompiledAt=${state.compiled.compiledAt}\nindexMs=${state.compiled.diagnostics.indexMs.toFixed(1)}\nretrievalMs=${state.compiled.diagnostics.retrievalMs.toFixed(1)}\ncompressionMs=${state.compiled.diagnostics.compressionMs.toFixed(1)}\ncompileMs=${state.compiled.diagnostics.compileMs.toFixed(1)}\ntotalMs=${state.compiled.diagnostics.totalMs.toFixed(1)}`
              )}</pre>`
            : '<div class="empty">Compile a task to prepare a handoff.</div>'
        }
        <h2>Recent Approvals</h2>
        <div class="list">
          ${
            state.handoffHistory.length
              ? state.handoffHistory
                  .map(
                    (entry) => `<div class="item"><div class="mono">${escapeHtml(entry.promptId)} :: ${escapeHtml(entry.target)}</div><div>${escapeHtml(entry.createdAt)}</div></div>`
                  )
                  .join("")
              : '<div class="empty">No handoffs approved yet.</div>'
          }
        </div>
      </section>

      <section class="card">
        <div class="kicker">Files</div>
        <div class="pill-row">
          ${
            state.pinnedPaths.length
              ? state.pinnedPaths.map((path) => `<span class="pill">Pinned: ${escapeHtml(path)}</span>`).join("")
              : '<span class="pill">Pinned: none</span>'
          }
          ${
            state.excludedPaths.length
              ? state.excludedPaths.map((path) => `<span class="pill">Excluded: ${escapeHtml(path)}</span>`).join("")
              : '<span class="pill">Excluded: none</span>'
          }
        </div>
        <h2>Included</h2>
        <div class="list">
          ${
            state.compiled?.includedFiles.length
              ? state.compiled.includedFiles
                  .map(
                    (file) => `<div class="item">
                      <div class="mono">${escapeHtml(file)}</div>
                      <div class="item-actions">
                        <button class="ghost open-file" data-path="${escapeAttribute(file)}">Open</button>
                        <button class="ghost toggle-pin" data-path="${escapeAttribute(file)}">${state.pinnedPaths.includes(file) ? "Unpin" : "Pin"}</button>
                      </div>
                      <button class="ghost toggle-exclude" data-path="${escapeAttribute(file)}">${state.excludedPaths.includes(file) ? "Undo Exclude" : "Exclude"}</button>
                    </div>`
                  )
                  .join("")
              : '<div class="empty">No files compiled yet.</div>'
          }
        </div>
        <h2>Omitted</h2>
        <div class="list">
          ${
            state.compiled?.omittedPaths.length
              ? state.compiled.omittedPaths
                  .map((file) => `<div class="item">
                    <div class="mono">${escapeHtml(file)}</div>
                    <div class="item-actions">
                      <button class="ghost include-path" data-path="${escapeAttribute(file)}">Include</button>
                      <button class="ghost toggle-pin" data-path="${escapeAttribute(file)}">${state.pinnedPaths.includes(file) ? "Unpin" : "Pin"}</button>
                    </div>
                  </div>`)
                  .join("")
              : '<div class="empty">No omitted files.</div>'
          }
        </div>
      </section>

      <section class="card">
        <div class="kicker">Budget</div>
        ${
          state.compiled
            ? `<pre>${escapeHtml(
                `raw=${state.compiled.budgetUsage.raw}\nsummaries=${state.compiled.budgetUsage.summary}\ndependencies=${state.compiled.budgetUsage.dependency}\ntests=${state.compiled.budgetUsage.tests}\ntotal=${state.compiled.budgetUsage.total}`
              )}</pre>`
            : '<div class="empty">Compile a task to inspect budget usage.</div>'
        }
      </section>

      <section class="card">
        <div class="kicker">Agent Payload</div>
        <h2>System</h2>
        ${
          state.payload
            ? `<pre>${escapeHtml(state.payload.system)}</pre>`
            : '<div class="empty">No payload available yet.</div>'
        }
        <h2>User</h2>
        ${
          state.payload
            ? `<pre>${escapeHtml(state.payload.user)}</pre>`
            : '<div class="empty">Compile a task to preview the target payload.</div>'
        }
      </section>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const taskText = document.getElementById("taskText");
      const target = document.getElementById("target");
      const compileButton = document.getElementById("compileButton");
      const indexButton = document.getElementById("indexButton");
      const targetButton = document.getElementById("targetButton");
      const copyButton = document.getElementById("copyButton");
      const openPayloadButton = document.getElementById("openPayloadButton");
      const openPromptButton = document.getElementById("openPromptButton");
      const sendButton = document.getElementById("sendButton");

      compileButton.addEventListener("click", () => {
        vscode.postMessage({
          type: "compile",
          taskText: taskText.value,
          target: target.value
        });
      });

      indexButton.addEventListener("click", () => {
        vscode.postMessage({ type: "index" });
      });

      targetButton.addEventListener("click", () => {
        vscode.postMessage({
          type: "switch-target",
          target: target.value
        });
      });

      copyButton.addEventListener("click", () => {
        vscode.postMessage({ type: "copy-payload" });
      });

      openPayloadButton.addEventListener("click", () => {
        vscode.postMessage({ type: "open-payload" });
      });

      openPromptButton.addEventListener("click", () => {
        vscode.postMessage({ type: "open-compiled-prompt" });
      });

      sendButton.addEventListener("click", () => {
        vscode.postMessage({ type: "send-to-agent" });
      });

      document.querySelectorAll(".open-file").forEach((button) => {
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "open-file",
            path: button.dataset.path
          });
        });
      });

      document.querySelectorAll(".toggle-pin").forEach((button) => {
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "toggle-pin",
            path: button.dataset.path
          });
        });
      });

      document.querySelectorAll(".toggle-exclude").forEach((button) => {
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "toggle-exclude",
            path: button.dataset.path
          });
        });
      });

      document.querySelectorAll(".include-path").forEach((button) => {
        button.addEventListener("click", () => {
          vscode.postMessage({
            type: "include-path",
            path: button.dataset.path
          });
        });
      });
    </script>
  </body>
</html>`;
}

async function revealNomicView(): Promise<void> {
  await vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_ID}`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function formatPayloadText(payload: AgentPayload): string {
  return [
    "# Target",
    payload.target,
    "",
    "# Prompt ID",
    payload.metadata.promptId,
    "",
    "# System",
    payload.system,
    "",
    "# User",
    payload.user,
    "",
    "# Metadata",
    `Included files: ${payload.metadata.includedFiles.join(", ") || "None"}`,
    `Related tests: ${payload.metadata.relatedTests.join(", ") || "None"}`,
    `Omitted files: ${payload.metadata.omittedPaths.join(", ") || "None"}`,
    `Token estimate: ${payload.metadata.tokenEstimate}`
  ].join("\n");
}

function getOverrideStateKey(workspaceRoot: string): string {
  return `nomic.overrideState:${workspaceRoot}`;
}

function getHandoffStateKey(workspaceRoot: string): string {
  return `nomic.handoffState:${workspaceRoot}`;
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 16; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}
