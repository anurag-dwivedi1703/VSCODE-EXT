import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TaskRunner } from '../engine/TaskRunner';

interface WorkspaceInfo {
    id: string;
    name: string;
    status: 'Active';
}

export class MissionControlProvider {
    public static currentPanel: MissionControlProvider | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _taskRunner: TaskRunner;
    private _workspaces: WorkspaceInfo[] = [];
    private _context: vscode.ExtensionContext;
    private _isDisposed: boolean = false;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, taskRunner: TaskRunner, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._taskRunner = taskRunner;
        this._context = context;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.html = this._getWebviewContent(this._panel.webview);

        this._setWebviewMessageListener(this._panel.webview);

        // Load workspaces from globalState
        const savedWorkspaces = this._context.globalState.get<WorkspaceInfo[]>('vibearchitect.workspaces');
        let initialWorkspaces: WorkspaceInfo[] = [];

        if (savedWorkspaces && savedWorkspaces.length > 0) {
            initialWorkspaces = savedWorkspaces;
        } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            initialWorkspaces = vscode.workspace.workspaceFolders.map(wf => ({
                id: wf.uri.fsPath,
                name: wf.name,
                status: 'Active'
            }));
        }

        // AUTO-DISCOVERY: Add workspaces from existing tasks if missing
        const tasksForDiscovery = this._taskRunner.getTasks();
        const existingPaths = new Set(initialWorkspaces.map(w => w.id.toLowerCase())); // Normalize for check

        tasksForDiscovery.forEach(task => {
            if (task.worktreePath) {
                const normalizedPath = task.worktreePath.toLowerCase();
                if (!existingPaths.has(normalizedPath)) {
                    initialWorkspaces.push({
                        id: task.worktreePath,
                        name: path.basename(task.worktreePath),
                        status: 'Active'
                    });
                    existingPaths.add(normalizedPath);
                }
            }
        });

        this._workspaces = initialWorkspaces;
        this.saveWorkspaces(); // Persist the inferred ones

        // Send initial list
        this.sendWorkspaces();

        // Listen for updates from TaskRunner and forward to Webview
        const taskUpdateSub = this._taskRunner.onTaskUpdate((event) => {
            this.safePostMessage({
                command: 'taskUpdate',
                taskId: event.taskId,
                task: event.task
            });
        });
        this._disposables.push(taskUpdateSub);

        const reloadBrowserSub = this._taskRunner.onReloadBrowser(() => {
            this.safePostMessage({
                command: 'reloadBrowser'
            });
        });
        this._disposables.push(reloadBrowserSub);

        const navigateBrowserSub = this._taskRunner.onNavigateBrowser((url: string) => {
            this.safePostMessage({
                command: 'navigateBrowser',
                url: url
            });
        });
        this._disposables.push(navigateBrowserSub);

        // Listen for approval requests (Agent Decides mode and constitution review)
        const awaitingApprovalSub = this._taskRunner.onAwaitingApproval((event) => {
            // Map approval types to webview commands
            let command: string;
            switch (event.type) {
                case 'constitution':
                case 'constitution-update':
                case 'constitution-drift':
                    command = 'constitutionReview';
                    break;
                case 'plan':
                    command = 'awaitingApproval';
                    break;
                case 'command':
                    command = 'commandApprovalRequired';
                    break;
                default:
                    command = 'awaitingApproval';
            }

            this.safePostMessage({
                command: command,
                taskId: event.taskId,
                content: event.content,
                riskReason: event.riskReason,
                approvalType: event.type  // Pass the original type for UI context
            });
        });
        this._disposables.push(awaitingApprovalSub);

        const approvalCompleteSub = this._taskRunner.onApprovalComplete((event) => {
            this.safePostMessage({
                command: 'approvalComplete',
                taskId: event.taskId
            });
        });
        this._disposables.push(approvalCompleteSub);

        // Send existing tasks (loaded from disk)
        const existingTasks = this._taskRunner.getTasks();
        existingTasks.forEach(task => {
            this.safePostMessage({
                command: 'taskUpdate',
                taskId: task.id,
                task: task
            });
        });
    }

    public static createOrShow(extensionUri: vscode.Uri, taskRunner: TaskRunner, context: vscode.ExtensionContext) {
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

        MissionControlProvider.currentPanel = new MissionControlProvider(panel, extensionUri, taskRunner, context);
    }

    public dispose() {
        this._isDisposed = true;
        MissionControlProvider.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    /**
     * Safely post a message to the webview, ignoring if disposed
     */
    private safePostMessage(message: any) {
        if (this._isDisposed) {
            console.log('[MissionControl] Ignoring postMessage - panel disposed');
            return;
        }
        try {
            this._panel.webview.postMessage(message);
        } catch (error: any) {
            console.warn('[MissionControl] Error posting message:', error.message);
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

        // CSP: Allow scripts from our extension, styles, and frames from localhost for the browser preview
        const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-eval'; frame-src http://localhost:* http://127.0.0.1:*;`;

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="${csp}">
                <link rel="stylesheet" href="${styleUri}">
                <title>Mission Control</title>
            </head>
            <body>
                <div id="root"></div>
                <script type="module" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }

    private saveWorkspaces() {
        this._context.globalState.update('vibearchitect.workspaces', this._workspaces);
    }

    private sendWorkspaces() {
        this.safePostMessage({
            command: 'updateWorkspaces',
            workspaces: this._workspaces
        });
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(
            (message: any) => {
                const command = message.command;
                const text = message.text;

                switch (command) {
                    case 'startTask':
                        // Pass workspaceId (path), mode, and model to task runner
                        const workspacePath = message.workspaceId;
                        const mode = message.mode;
                        const model = message.model;
                        console.log(`[MissionControl] Starting task in workspace: ${workspacePath} [${mode}] [${model}]`);
                        this._taskRunner.startTask(text, workspacePath, mode, model);
                        return;
                    case 'hello':
                        vscode.window.showInformationMessage(text);
                        return;
                    case 'addWorkspace':
                        // Use Dialog to select folder
                        vscode.window.showOpenDialog({
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            openLabel: 'Add Workspace'
                        }).then(uris => {
                            if (uris && uris.length > 0) {
                                const uri = uris[0];
                                const existing = this._workspaces.find(w => w.id === uri.fsPath);
                                if (!existing) {
                                    this._workspaces.push({
                                        id: uri.fsPath,
                                        name: path.basename(uri.fsPath),
                                        status: 'Active'
                                    });
                                    this.saveWorkspaces();
                                    this.sendWorkspaces();
                                }
                            }
                        });
                        return;
                    case 'getWorkspaces':
                        this.sendWorkspaces();
                        return;
                    case 'getTasks':
                        const tasks = this._taskRunner.getTasks();
                        tasks.forEach(t => {
                            this.safePostMessage({
                                command: 'taskUpdate',
                                output: '',
                                taskId: t.id,
                                task: t
                            });
                        });
                        return;
                    case 'selectContext':
                        vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            canSelectMany: true,
                            openLabel: 'Attach Context'
                        }).then(uris => {
                            if (uris && uris.length > 0) {
                                this.safePostMessage({
                                    command: 'contextSelected',
                                    paths: uris.map(u => u.fsPath)
                                });
                            }
                        });
                        return;
                    case 'replyToAgent':
                        this._taskRunner.replyToTask(message.taskId, message.text, message.attachments || []);
                        return;
                    case 'saveBrowserComment':
                        // Inject the comment into the chat stream as if it were a user message
                        // message: { command, taskId, comment, x, y, url }
                        const commentMsg = `[Browser Comment on ${message.url} at (${message.x}, ${message.y})]: ${message.comment}`;
                        this._taskRunner.replyToTask(message.taskId, commentMsg, []);
                        vscode.window.showInformationMessage('Comment added to agent context');
                        return;
                    case 'requestRevert':
                        // message: { command, taskId, checkpointId }
                        this._taskRunner.revertTask(message.taskId, message.checkpointId);
                        return;
                    case 'changeModel':
                        // message: { command, taskId, model }
                        this._taskRunner.changeModel(message.taskId, message.model);
                        return;
                    case 'openFile': {
                        const openPath = vscode.Uri.file(message.path);
                        if (message.path.endsWith('.md')) {
                            vscode.commands.executeCommand('markdown.showPreview', openPath).then(undefined, err => {
                                vscode.window.showErrorMessage(`Failed to preview markdown: ${err.message}`);
                                // Fallback to text editor
                                vscode.workspace.openTextDocument(openPath).then(doc => vscode.window.showTextDocument(doc));
                            });
                        } else {
                            vscode.workspace.openTextDocument(openPath).then(doc => {
                                vscode.window.showTextDocument(doc);
                            }, err => {
                                vscode.window.showErrorMessage(`Failed to open: ${err.message}`);
                            });
                        }
                        return;
                    }
                    case 'previewFile': {
                        // In-webview preview for artifact cards
                        const taskId = message.taskId;
                        const task = this._taskRunner.getTask(taskId);

                        if (task && task.worktreePath) {
                            // Normalize path
                            let fsPath = message.path;
                            if (!path.isAbsolute(fsPath)) {
                                fsPath = path.join(task.worktreePath, fsPath);
                            }

                            console.log(`[MissionControl] Previewing artifact: ${fsPath}`);

                            try {
                                if (fs.existsSync(fsPath)) {
                                    const content = fs.readFileSync(fsPath, 'utf-8');
                                    this.safePostMessage({
                                        command: 'fileContent',
                                        path: fsPath,
                                        content: content
                                    });
                                } else {
                                    vscode.window.showErrorMessage(`File not found: ${fsPath}`);
                                    console.error(`[MissionControl] Artifact not found at ${fsPath}`);
                                }
                            } catch (err: any) {
                                vscode.window.showErrorMessage(`Error reading file: ${err.message}`);
                            }
                        } else {
                            vscode.window.showErrorMessage(`Cannot open artifact. Task or Worktree path missing.`);
                        }
                        return;
                    }
                    case 'getDiff': {
                        const taskId = message.taskId;
                        const filePath = message.path;

                        const fileEdit = this._taskRunner.getFileEdit(taskId, filePath);
                        if (fileEdit) {
                            this.safePostMessage({
                                command: 'diffContent',
                                path: fileEdit.path,
                                before: fileEdit.beforeContent,
                                after: fileEdit.afterContent
                            });
                        } else {
                            console.error(`[MissionControl] FileEdit not found: ${filePath}`);
                        }
                        return;
                    }
                    // Agent Mode and Approval Handlers
                    case 'setAgentMode':
                        this._taskRunner.setAgentMode(message.mode);
                        return;
                    case 'approveReview':
                        this._taskRunner.approveReview(message.taskId, message.feedback);
                        return;
                    case 'rejectReview':
                        this._taskRunner.rejectReview(message.taskId);
                        return;
                    case 'approveCommand':
                        this._taskRunner.approveCommand(message.taskId);
                        return;
                    case 'declineCommand':
                        this._taskRunner.declineCommand(message.taskId);
                        return;
                    // Constitution Review Handlers
                    case 'approveConstitution':
                        this._taskRunner.approveReview(message.taskId, message.feedback);
                        return;
                    case 'rejectConstitution':
                        this._taskRunner.rejectReview(message.taskId);
                        return;
                    // Stop and Mode handlers
                    case 'stopTask':
                        this._taskRunner.stopTask(message.taskId);
                        return;
                    case 'changeMode':
                        this._taskRunner.changeTaskMode(message.taskId, message.mode);
                        return;
                }
            },
            undefined,
            this._disposables
        );
    }
}
