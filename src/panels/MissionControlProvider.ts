import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TaskRunner } from '../engine/TaskRunner';
import {
    TaskRunnerPhaseIntegration,
    createTaskRunnerPhaseIntegration,
    PhaseExecutionInfo
} from '../services/TaskRunnerPhaseIntegration';
import { getAttachmentProcessor, Attachment, ProcessedAttachment } from '../services/AttachmentProcessor';

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

    // Phase execution integration
    private _phaseIntegration: TaskRunnerPhaseIntegration;
    private _phasedExecutionEnabled: boolean = true;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, taskRunner: TaskRunner, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._taskRunner = taskRunner;
        this._context = context;

        // Initialize phase integration
        this._phaseIntegration = createTaskRunnerPhaseIntegration({
            enabled: this._phasedExecutionEnabled,
            tokenBudgetPerPhase: 30000,
            phasedExecutionThreshold: 40,
            requireApprovalBetweenPhases: true
        });

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
                case 'prd':
                    command = 'prdReview';
                    break;
                case 'login-checkpoint':
                    command = 'loginCheckpoint';
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

        // Phase execution event subscriptions
        this._setupPhaseIntegrationEvents();

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

        // Dispose phase integration
        this._phaseIntegration.dispose();

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    /**
     * Setup phase integration event listeners
     */
    private _setupPhaseIntegrationEvents() {
        // Forward phase updates to webview
        const phaseUpdateSub = this._phaseIntegration.onPhaseUpdate(({ taskId, info }) => {
            this.safePostMessage({
                command: 'phaseUpdate',
                taskId,
                phaseInfo: info
            });
        });
        this._disposables.push(phaseUpdateSub);

        // Forward phase approval requests to webview
        const approvalNeededSub = this._phaseIntegration.onApprovalNeeded(({ taskId, request }) => {
            this.safePostMessage({
                command: 'phaseApprovalNeeded',
                taskId,
                approvalData: {
                    phaseId: request.phase.id,
                    phaseName: request.phase.name,
                    phaseIndex: request.phaseIndex,
                    totalPhases: request.totalPhases,
                    summary: request.executionSummary,
                    filesCreated: request.filesCreated,
                    filesModified: request.filesModified,
                    verificationResults: request.verificationResults,
                    tokenUsage: request.tokenUsage,
                    estimatedTokens: request.phase.estimatedTokens
                }
            });
        });
        this._disposables.push(approvalNeededSub);

        // Forward phase completion events
        const phaseCompleteSub = this._phaseIntegration.onPhaseComplete(({ taskId, phaseId, result }) => {
            this.safePostMessage({
                command: 'phaseComplete',
                taskId,
                phaseId,
                result
            });
        });
        this._disposables.push(phaseCompleteSub);

        // Forward all phases complete event
        const allCompletesSub = this._phaseIntegration.onAllPhasesComplete(({ taskId, totalTokens }) => {
            this.safePostMessage({
                command: 'allPhasesComplete',
                taskId,
                totalTokens
            });
            console.log(`[MissionControl] All phases complete for task ${taskId}, total tokens: ${totalTokens}`);
        });
        this._disposables.push(allCompletesSub);
    }

    /**
     * Analyze requirement and prepare phased execution if needed
     */
    private async _prepareTaskWithPhaseAnalysis(
        taskId: string,
        prompt: string,
        workspacePath: string,
        chatId: string
    ): Promise<{ modifiedPrompt: string; isPhased: boolean }> {
        try {
            // Get mission folder path
            const missionFolder = path.join(workspacePath, '.vibearchitect', chatId);

            // Analyze and prepare
            const analysis = await this._phaseIntegration.analyzeAndPrepare(
                taskId,
                prompt,
                missionFolder
            );

            console.log(`[MissionControl] Complexity analysis: ${analysis.score.level} (${analysis.score.score}/100)`);
            console.log(`[MissionControl] Execution mode: ${analysis.mode}`);

            if (analysis.mode === 'phased' && analysis.phases) {
                console.log(`[MissionControl] Splitting into ${analysis.phases.totalPhases} phases`);

                // Notify webview of phased execution
                this.safePostMessage({
                    command: 'phasedExecutionStarted',
                    taskId,
                    totalPhases: analysis.phases.totalPhases,
                    strategy: analysis.phases.strategyUsed
                });
            }

            // Prepend phase context to prompt if available
            const phaseContext = analysis.promptContext;
            const modifiedPrompt = phaseContext
                ? `${phaseContext}\n\n---\n\n## USER REQUEST\n\n${prompt}`
                : prompt;

            return {
                modifiedPrompt,
                isPhased: analysis.mode === 'phased'
            };
        } catch (error) {
            console.error('[MissionControl] Phase analysis failed, proceeding without phases:', error);
            return {
                modifiedPrompt: prompt,
                isPhased: false
            };
        }
    }

    /**
     * Get current phase info for a task
     */
    public getPhaseInfo(taskId: string): PhaseExecutionInfo | null {
        return this._phaseIntegration.getPhaseInfo(taskId);
    }

    /**
     * Toggle phased execution on/off
     */
    public setPhasedExecutionEnabled(enabled: boolean) {
        this._phasedExecutionEnabled = enabled;
        this._phaseIntegration.updateConfig({ enabled });
        console.log(`[MissionControl] Phased execution ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Start a task with phase analysis
     * Analyzes the requirement complexity and sets up phased execution if needed
     */
    private async _startTaskWithPhaseAnalysis(
        text: string,
        workspacePath: string,
        mode: 'planning' | 'fast' | 'refinement',
        model: string,
        chatId: string
    ): Promise<void> {
        try {
            // Generate a temporary task ID for phase analysis
            const tempTaskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            // Prepare with phase analysis
            const { modifiedPrompt, isPhased } = await this._prepareTaskWithPhaseAnalysis(
                tempTaskId,
                text,
                workspacePath,
                chatId
            );

            if (isPhased) {
                console.log(`[MissionControl] Starting phased execution for task`);
            }

            // Start the task with potentially modified prompt
            // Pass original 'text' as displayPrompt so UI shows user's original request
            // while 'modifiedPrompt' (with phase context) is used for AI execution
            this._taskRunner.startTask(modifiedPrompt, workspacePath, mode, model, chatId, text);
        } catch (error) {
            console.error('[MissionControl] Failed to start task with phase analysis:', error);
            // Fallback to regular start
            this._taskRunner.startTask(text, workspacePath, mode, model, chatId, text);
        }
    }

    /**
     * Start a task with attachment processing
     * Processes images (via vision) and documents (via text extraction) to enrich the prompt
     */
    private async _startTaskWithAttachments(
        text: string,
        workspacePath: string,
        mode: 'planning' | 'fast' | 'refinement',
        model: string,
        chatId: string,
        attachments: Attachment[]
    ): Promise<void> {
        let enrichedPrompt = text;

        // Process attachments if any
        if (attachments && attachments.length > 0) {
            try {
                console.log(`[MissionControl] Processing ${attachments.length} attachments...`);
                
                const processor = getAttachmentProcessor();
                const processed = await processor.processAttachments(attachments);
                const contextString = processor.generateContextString(processed);

                if (contextString) {
                    enrichedPrompt = text + contextString;
                    console.log(`[MissionControl] Enriched prompt with ${processed.length} attachment analyses`);
                }
            } catch (error: any) {
                console.error('[MissionControl] Attachment processing failed:', error);
                // Continue with original prompt
            }
        }

        // Use phase-aware task start if enabled
        if (this._phasedExecutionEnabled) {
            await this._startTaskWithPhaseAnalysis(enrichedPrompt, workspacePath, mode, model, chatId);
        } else {
            this._taskRunner.startTask(enrichedPrompt, workspacePath, mode, model, chatId, text);
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
                    case 'startTask': {
                        // Pass workspaceId (path), mode, model, and chatId to task runner
                        const workspacePath = message.workspaceId;
                        const mode = message.mode;
                        const model = message.model;
                        const chatId = message.chatId;  // Chat-specific ID for mission folder isolation
                        const attachments = message.attachments as Attachment[] || [];
                        
                        console.log(`[MissionControl] Starting task in workspace: ${workspacePath} [${mode}] [${model}] [chatId: ${chatId || 'auto'}] [attachments: ${attachments.length}]`);

                        // Process attachments if any (images via vision, documents via text extraction)
                        this._startTaskWithAttachments(text, workspacePath, mode, model, chatId, attachments);
                        return;
                    }
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
                    case 'getTasks': {
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
                    }
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
                    case 'selectComposerContext':
                        // Select files for Start Mission composer (supports images and documents)
                        vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            canSelectMany: true,
                            openLabel: 'Attach Files',
                            filters: {
                                'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'],
                                'Documents': ['pdf', 'txt', 'md', 'doc', 'docx'],
                                'All Files': ['*']
                            }
                        }).then(async uris => {
                            if (uris && uris.length > 0) {
                                const files = await Promise.all(uris.map(async uri => {
                                    const filePath = uri.fsPath;
                                    const fileName = path.basename(filePath);
                                    const ext = path.extname(filePath).toLowerCase();
                                    
                                    // Determine file type
                                    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
                                    const mimeTypes: Record<string, string> = {
                                        '.png': 'image/png',
                                        '.jpg': 'image/jpeg',
                                        '.jpeg': 'image/jpeg',
                                        '.gif': 'image/gif',
                                        '.webp': 'image/webp',
                                        '.pdf': 'application/pdf',
                                        '.txt': 'text/plain',
                                        '.md': 'text/markdown',
                                        '.doc': 'application/msword',
                                        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                                    };
                                    
                                    const fileType = mimeTypes[ext] || 'application/octet-stream';
                                    
                                    // For images, read and convert to base64 data URL
                                    let content: string | undefined;
                                    if (isImage) {
                                        try {
                                            const data = fs.readFileSync(filePath);
                                            content = `data:${fileType};base64,${data.toString('base64')}`;
                                        } catch (e) {
                                            console.error(`Failed to read image: ${filePath}`, e);
                                        }
                                    }
                                    
                                    return {
                                        path: filePath,
                                        name: fileName,
                                        type: fileType,
                                        content
                                    };
                                }));
                                
                                this.safePostMessage({
                                    command: 'composerContextSelected',
                                    files
                                });
                            }
                        });
                        return;
                    case 'replyToAgent':
                        this._taskRunner.replyToTask(message.taskId, message.text, message.attachments || []);
                        return;
                    case 'saveBrowserComment': {
                        // Inject the comment into the chat stream as if it were a user message
                        // message: { command, taskId, comment, x, y, url }
                        const commentMsg = `[Browser Comment on ${message.url} at (${message.x}, ${message.y})]: ${message.comment}`;
                        this._taskRunner.replyToTask(message.taskId, commentMsg, []);
                        vscode.window.showInformationMessage('Comment added to agent context');
                        return;
                    }
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

                        if (task) {
                            // Normalize path
                            let fsPath = message.path;
                            if (!path.isAbsolute(fsPath) && task.worktreePath) {
                                fsPath = path.join(task.worktreePath, fsPath);
                            }

                            console.log(`[MissionControl] Previewing artifact: ${fsPath}`);

                            try {
                                // Check original location first
                                if (fs.existsSync(fsPath)) {
                                    const content = fs.readFileSync(fsPath, 'utf-8');
                                    this.safePostMessage({
                                        command: 'fileContent',
                                        path: fsPath,
                                        content: content
                                    });
                                } else {
                                    // Fallback: Check archived location for known artifact files
                                    const fileName = path.basename(fsPath);
                                    const artifactFiles = ['task.md', 'implementation_plan.md', 'mission_summary.md'];

                                    if (artifactFiles.includes(fileName)) {
                                        const archivedPath = path.join(
                                            this._context.globalStorageUri.fsPath,
                                            'missions', 'chats', taskId, fileName
                                        );

                                        if (fs.existsSync(archivedPath)) {
                                            console.log(`[MissionControl] Found archived artifact: ${archivedPath}`);
                                            const content = fs.readFileSync(archivedPath, 'utf-8');
                                            this.safePostMessage({
                                                command: 'fileContent',
                                                path: archivedPath,
                                                content: content
                                            });
                                        } else {
                                            vscode.window.showErrorMessage(`File not found: ${fsPath}`);
                                            console.error(`[MissionControl] Artifact not found at ${fsPath} or ${archivedPath}`);
                                        }
                                    } else {
                                        vscode.window.showErrorMessage(`File not found: ${fsPath}`);
                                        console.error(`[MissionControl] File not found at ${fsPath}`);
                                    }
                                }
                            } catch (err: any) {
                                vscode.window.showErrorMessage(`Error reading file: ${err.message}`);
                            }
                        } else {
                            vscode.window.showErrorMessage(`Cannot open artifact. Task not found.`);
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
                    // Login Checkpoint Handlers
                    case 'confirmLogin':
                        this._taskRunner.confirmLoginComplete(message.taskId);
                        return;
                    case 'cancelLogin':
                        this._taskRunner.cancelLoginCheckpoint(message.taskId);
                        return;
                    // Constitution Review Handlers
                    case 'approveConstitution':
                        this._taskRunner.approveReview(message.taskId, message.feedback);
                        return;
                    case 'rejectConstitution':
                        this._taskRunner.rejectReview(message.taskId);
                        return;
                    // PRD Review Handlers (Refinement Mode)
                    case 'prdApproved':
                        this._taskRunner.approvePrd(message.taskId);
                        return;
                    case 'prdFeedback':
                        this._taskRunner.requestPrdChanges(message.taskId, message.feedback);
                        return;
                    // Stop and Mode handlers
                    case 'stopTask':
                        this._taskRunner.stopTask(message.taskId);
                        return;
                    case 'changeMode':
                        this._taskRunner.changeTaskMode(message.taskId, message.mode);
                        return;

                    // Phase Execution Handlers
                    case 'phaseApprove':
                        // User approved the current phase
                        this._phaseIntegration.provideApproval(message.taskId, true, message.feedback);
                        return;
                    case 'phaseReject':
                        // User rejected/aborted the mission
                        this._phaseIntegration.provideApproval(message.taskId, false, message.reason);
                        return;
                    case 'phaseSkip':
                        // User wants to skip current phase
                        this._phaseIntegration.skipPhase(message.taskId, message.reason || 'User requested skip');
                        return;
                    case 'togglePhasedExecution':
                        // Toggle phased execution on/off
                        this.setPhasedExecutionEnabled(message.enabled);
                        return;
                    case 'getPhaseInfo': {
                        // Request current phase info
                        const phaseInfo = this._phaseIntegration.getPhaseInfo(message.taskId);
                        if (phaseInfo) {
                            this.safePostMessage({
                                command: 'phaseUpdate',
                                taskId: message.taskId,
                                phaseInfo
                            });
                        }
                        return;
                    }

                    // ========== Browser Automation Handlers ==========
                    case 'detectBrowsers':
                        this._handleDetectBrowsers();
                        return;
                    case 'downloadChromium':
                        this._handleDownloadChromium();
                        return;
                    case 'selectBrowser':
                        this._handleSelectBrowser(message.executablePath);
                        return;
                    case 'checkBrowserDependencies':
                        this._handleCheckDependencies();
                        return;
                    case 'installBrowserDependencies':
                        this._handleInstallDependencies();
                        return;
                    case 'loadSessions':
                        this._handleLoadSessions();
                        return;
                    case 'checkSessionHealth':
                        this._handleCheckSessionHealth(message.sessionId);
                        return;
                    case 'deleteSession':
                        this._handleDeleteSession(message.sessionId);
                        return;
                    case 'clearAllSessions':
                        this._handleClearAllSessions();
                        return;
                    case 'clearExpiredSessions':
                        this._handleClearExpiredSessions();
                        return;
                    case 'useSession':
                        this._handleUseSession(message.sessionId);
                        return;
                }
            },
            undefined,
            this._disposables
        );
    }

    // ========== Browser Automation Helper Methods ==========

    private async _handleDetectBrowsers(): Promise<void> {
        try {
            const { getBrowserManager } = await import('../services/BrowserManager');
            const browserManager = getBrowserManager();
            const browsers = await browserManager.detectBrowsers();
            this.safePostMessage({
                type: 'browsersDetected',
                browsers
            });
        } catch (error: any) {
            this.safePostMessage({
                type: 'browserDownloadError',
                error: error.message
            });
        }
    }

    private async _handleDownloadChromium(): Promise<void> {
        try {
            const { getBrowserManager } = await import('../services/BrowserManager');
            const browserManager = getBrowserManager();
            
            this.safePostMessage({ type: 'browserDownloadStarted' });
            
            const browser = await browserManager.downloadChromium();
            
            if (browser) {
                this.safePostMessage({
                    type: 'browserDownloadComplete',
                    browser
                });
            } else {
                this.safePostMessage({
                    type: 'browserDownloadError',
                    error: 'Download failed or was cancelled'
                });
            }
        } catch (error: any) {
            this.safePostMessage({
                type: 'browserDownloadError',
                error: error.message
            });
        }
    }

    private async _handleSelectBrowser(executablePath: string): Promise<void> {
        try {
            const { getBrowserManager } = await import('../services/BrowserManager');
            const browserManager = getBrowserManager();
            browserManager.setCustomBrowserPath(executablePath);
            
            this.safePostMessage({
                type: 'browserSelected',
                browser: { executablePath }
            });
            
            vscode.window.showInformationMessage(`Browser configured: ${executablePath}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to set browser: ${error.message}`);
        }
    }

    private async _handleLoadSessions(): Promise<void> {
        try {
            const { getSessionStorageManager } = await import('../services/SessionStorageManager');
            const sessionManager = getSessionStorageManager();
            const sessions = sessionManager.getAllSessions();
            this.safePostMessage({
                type: 'sessionsLoaded',
                sessions
            });
        } catch (error: any) {
            console.error('[MissionControl] Failed to load sessions:', error);
            this.safePostMessage({
                type: 'sessionsLoaded',
                sessions: []
            });
        }
    }

    private async _handleCheckSessionHealth(sessionId: string): Promise<void> {
        try {
            const { getSessionStorageManager } = await import('../services/SessionStorageManager');
            const sessionManager = getSessionStorageManager();
            const health = await sessionManager.analyzeSessionHealth(sessionId);
            this.safePostMessage({
                type: 'sessionHealthResult',
                health
            });
        } catch (error: any) {
            this.safePostMessage({
                type: 'sessionHealthResult',
                health: {
                    isValid: false,
                    expiredCookies: 0,
                    validCookies: 0,
                    recommendations: [`Error checking health: ${error.message}`]
                }
            });
        }
    }

    private async _handleDeleteSession(sessionId: string): Promise<void> {
        try {
            const { getSessionStorageManager } = await import('../services/SessionStorageManager');
            const sessionManager = getSessionStorageManager();
            sessionManager.deleteSession(sessionId);
            this.safePostMessage({
                type: 'sessionDeleted',
                sessionId
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to delete session: ${error.message}`);
        }
    }

    private async _handleClearAllSessions(): Promise<void> {
        try {
            const { getSessionStorageManager } = await import('../services/SessionStorageManager');
            const sessionManager = getSessionStorageManager();
            const sessions = sessionManager.getAllSessions();
            for (const session of sessions) {
                sessionManager.deleteSession(session.id);
            }
            this.safePostMessage({ type: 'allSessionsCleared' });
            vscode.window.showInformationMessage('All sessions cleared');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to clear sessions: ${error.message}`);
        }
    }

    private async _handleClearExpiredSessions(): Promise<void> {
        try {
            const { getSessionStorageManager } = await import('../services/SessionStorageManager');
            const sessionManager = getSessionStorageManager();
            const count = sessionManager.clearExpiredSessions();
            vscode.window.showInformationMessage(`Cleared ${count} expired session(s)`);
            // Reload sessions
            this._handleLoadSessions();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to clear expired sessions: ${error.message}`);
        }
    }

    private async _handleUseSession(sessionId: string): Promise<void> {
        // This would be used to signal that a session should be loaded
        // The actual loading happens in BrowserAutomationService
        vscode.window.showInformationMessage(`Session ${sessionId} selected. It will be used for the next browser automation.`);
    }

    private async _handleCheckDependencies(): Promise<void> {
        try {
            const { getBrowserDependencyInstaller } = await import('../services/BrowserDependencyInstaller');
            const installer = getBrowserDependencyInstaller();
            const dependencies = await installer.checkDependencies();
            this.safePostMessage({
                type: 'dependenciesChecked',
                dependencies
            });
        } catch (error: any) {
            console.error('[MissionControl] Failed to check dependencies:', error);
            this.safePostMessage({
                type: 'dependenciesChecked',
                dependencies: []
            });
        }
    }

    private async _handleInstallDependencies(): Promise<void> {
        try {
            this.safePostMessage({ type: 'dependenciesInstalling' });
            
            const { getBrowserDependencyInstaller } = await import('../services/BrowserDependencyInstaller');
            const installer = getBrowserDependencyInstaller();
            installer.setExtensionPath(this._context.extensionPath);
            
            const result = await installer.installDependencies();
            
            // Re-check dependencies after install
            const dependencies = await installer.checkDependencies();
            
            this.safePostMessage({
                type: 'dependenciesInstalled',
                success: result.success,
                dependencies
            });
        } catch (error: any) {
            console.error('[MissionControl] Failed to install dependencies:', error);
            vscode.window.showErrorMessage(`Failed to install dependencies: ${error.message}`);
            this.safePostMessage({
                type: 'dependenciesInstalled',
                success: false,
                dependencies: []
            });
        }
    }
}
