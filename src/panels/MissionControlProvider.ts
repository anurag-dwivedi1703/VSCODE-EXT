import * as vscode from 'vscode';
import * as fs from 'fs';
import { TaskRunner } from '../engine/TaskRunner';

export class MissionControlProvider {
    public static currentPanel: MissionControlProvider | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _taskRunner: TaskRunner;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, taskRunner: TaskRunner) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._taskRunner = taskRunner;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.html = this._getWebviewContent(this._panel.webview);

        this._setWebviewMessageListener(this._panel.webview);

        // Send current workspace info to webview
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this._panel.webview.postMessage({
                command: 'updateWorkspaces',
                workspaces: vscode.workspace.workspaceFolders.map(wf => ({
                    id: wf.uri.fsPath,
                    name: wf.name,
                    status: 'Active'
                }))
            });
        }

        // Listen for updates from TaskRunner and forward to Webview
        this._taskRunner.onTaskUpdate((event) => {
            this._panel.webview.postMessage({
                command: 'taskUpdate',
                taskId: event.taskId,
                task: event.task
            });
        });
    }

    public static createOrShow(extensionUri: vscode.Uri, taskRunner: TaskRunner) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (MissionControlProvider.currentPanel) {
            MissionControlProvider.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'missionControl',
            'Mission Control',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'dist'),
                    vscode.Uri.joinPath(extensionUri, 'webview-ui/dist')
                ]
            }
        );

        MissionControlProvider.currentPanel = new MissionControlProvider(panel, extensionUri, taskRunner);
    }

    public dispose() {
        MissionControlProvider.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getWebviewContent(webview: vscode.Webview) {
        const scriptPathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'assets', 'index.js');
        const stylePathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'assets', 'index.css');

        // Check if files exist
        try {
            fs.accessSync(scriptPathOnDisk.fsPath);
        } catch {
            vscode.window.showErrorMessage('Could not find Webview assets. Did you run "npm run build" in webview-ui?');
            return `
            <!DOCTYPE html>
            <html><body><h2>Error: Webview assets not found.</h2><p>Please run the build script in webview-ui folder.</p></body></html>
        `;
        }

        const scriptUri = webview.asWebviewUri(scriptPathOnDisk);
        const styleUri = webview.asWebviewUri(stylePathOnDisk);

        return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-eval';">
        <link rel="stylesheet" href="${styleUri}">
        <title>Mission Control</title>
      </head>
      <body>
        <div id="root"></div>
        <script type="module" crossorigin src="${scriptUri}"></script>
      </body>
      </html>
    `;
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(
            (message: any) => {
                const command = message.command;
                const text = message.text;

                switch (command) {
                    case 'startTask':
                        this._taskRunner.startTask(text);
                        return;
                    case 'hello':
                        vscode.window.showInformationMessage(text);
                        return;
                    case 'addWorkspace':
                        vscode.commands.executeCommand('vscode.openFolder');
                        return;
                    case 'getWorkspaces':
                        this.sendWorkspaces();
                        return;
                    case 'replyToAgent':
                        this._taskRunner.replyToTask(message.taskId, message.text);
                        return;
                    case 'openFile':
                        const openPath = vscode.Uri.file(message.path);
                        vscode.workspace.openTextDocument(openPath).then(doc => {
                            vscode.window.showTextDocument(doc);
                        });
                        return;
                }
            },
            undefined,
            this._disposables
        );
    }

    private sendWorkspaces() {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this._panel.webview.postMessage({
                command: 'updateWorkspaces',
                workspaces: vscode.workspace.workspaceFolders.map(wf => ({
                    id: wf.uri.fsPath,
                    name: wf.name,
                    status: 'Active'
                }))
            });
        }
    }
}
