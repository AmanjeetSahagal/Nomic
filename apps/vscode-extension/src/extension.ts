import * as vscode from "vscode";
import {
  createNomicEngine,
  type UserTask
} from "@nomic/core";

export function activate(context: vscode.ExtensionContext): void {
  const engine = createNomicEngine();

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.indexWorkspace", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        void vscode.window.showWarningMessage("Open a workspace before indexing with Nomic.");
        return;
      }

      const result = await engine.indexRepository({
        repositoryRoot: workspaceFolder.uri.fsPath
      });
      void vscode.window.showInformationMessage(`Nomic indexed ${result.fileCount} files.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nomic.compileContext", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        void vscode.window.showWarningMessage("Open a workspace before compiling context with Nomic.");
        return;
      }

      const taskText = await vscode.window.showInputBox({
        prompt: "Describe the coding task to compile context for"
      });

      if (!taskText) {
        return;
      }

      const task: UserTask = {
        text: taskText,
        target: "codex",
        repositoryRoot: workspaceFolder.uri.fsPath
      };
      const compiled = await engine.compileTask(task);

      const document = await vscode.workspace.openTextDocument({
        content: compiled.prompt,
        language: "markdown"
      });
      await vscode.window.showTextDocument(document, {
        preview: false
      });
    })
  );
}

export function deactivate(): void {}
