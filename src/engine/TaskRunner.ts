import * as vscode from 'vscode';
import { GeminiClient, ISession } from '../ai/GeminiClient';
import { ClaudeClient } from '../ai/ClaudeClient';
import { CopilotClaudeClient } from '../ai/CopilotClaudeClient';
import { CopilotGPTClient } from '../ai/CopilotGPTClient';
import { Part } from '@google/generative-ai';
import { WorktreeManager } from './WorktreeManager';
import { AgentTools } from './AgentTools';
import { TerminalManager } from './TerminalManager';
const terminalManager = new TerminalManager(); // Singleton for the extension session? Or per task?
// For now, singleton is simpler to manage one visible terminal window.
import * as path from 'path';
import * as fs from 'fs';
import { ShadowRepository } from '../services/ShadowRepository';
import { RevertManager } from '../services/RevertManager';
import { FileLockManager } from '../services/FileLockManager';
import { detectSecrets, detectPII } from '../ai/SecurityInstructions';
import { SpecManager, SpecPhase } from './SpecManager';
import { ContextHarvester } from '../services/ContextHarvester';
import { getRefinementManager } from './refinement';
import { DiffAggregator } from '../utils/DiffAggregator';
import { TokenManager } from '../utils/TokenManager';
import { MissionFolderManager } from '../utils/MissionFolderManager';
import { getAttachmentProcessor, Attachment } from '../services/AttachmentProcessor';
import { createRuleEnforcer, RuleEnforcer, FileEdit as RuleFileEdit } from '../services/RuleEnforcer';

interface TaskContext {
    shadowRepo: ShadowRepository;
    revertManager: RevertManager;
    specManager?: SpecManager;  // NEW: Spec-kit manager
    gemini?: GeminiClient;
    claude?: ClaudeClient;
    copilotClaude?: CopilotClaudeClient;
    copilotGPT?: CopilotGPTClient;  // GPT-5-mini via Copilot
    diffAggregator?: DiffAggregator;  // Aggregates multiple diffs to same file
    tokenManager?: TokenManager;  // Unified token budget management
    ruleEnforcer?: RuleEnforcer;  // Constitution rule enforcement
}

interface FileEdit {
    path: string;
    beforeContent: string | null;  // null if new file
    afterContent: string;
    timestamp: number;
    checkpointId?: string;
}

interface AgentTask {
    id: string;
    prompt: string;
    displayPrompt?: string;    // Original user prompt for UI display (if different from execution prompt)
    status: 'pending' | 'planning' | 'executing' | 'completed' | 'failed' | 'awaiting-approval';
    progress: number;
    logs: string[];
    worktreePath?: string;
    branchName?: string;
    userMessages: { text: string, attachments: string[] }[];
    artifacts: string[];
    mode?: 'planning' | 'fast' | 'refinement';
    model?: string;
    checkpoints?: { id: string, message: string, timestamp: number }[];
    fileEdits?: FileEdit[];
    // Pending approval state for Agent Decides mode
    awaitingApproval?: {
        type: 'plan' | 'command' | 'constitution' | 'constitution-update' | 'constitution-drift' | 'prd' | 'login-checkpoint';
        content: string;
        riskReason?: string;
    };
    // Chat-specific mission folder support
    chatId?: string;           // Unique chat/session identifier
}

export class TaskRunner {
    private tasks: Map<string, AgentTask> = new Map();
    private sessions: Map<string, ISession> = new Map(); // Keep sessions alive
    private taskContexts: Map<string, TaskContext> = new Map(); // Isolated execution context per task
    private runningTasks: Set<string> = new Set(); // Guard against duplicate task processing
    private worktreeManager: WorktreeManager | undefined;
    private _onTaskUpdate = new vscode.EventEmitter<{ taskId: string, task: AgentTask }>();
    public readonly onTaskUpdate = this._onTaskUpdate.event;

    private _onReloadBrowser = new vscode.EventEmitter<void>();
    public readonly onReloadBrowser = this._onReloadBrowser.event;

    private _onNavigateBrowser = new vscode.EventEmitter<string>();
    public readonly onNavigateBrowser = this._onNavigateBrowser.event;

    // Approval events for Agent Decides mode and constitution review
    private _onAwaitingApproval = new vscode.EventEmitter<{ taskId: string, type: 'plan' | 'command' | 'constitution' | 'constitution-update' | 'constitution-drift' | 'prd' | 'login-checkpoint', content: string, riskReason?: string }>();
    public readonly onAwaitingApproval = this._onAwaitingApproval.event;

    private _onApprovalComplete = new vscode.EventEmitter<{ taskId: string }>();
    public readonly onApprovalComplete = this._onApprovalComplete.event;

    // Questionnaire event for interactive refinement questions
    private _onQuestionnaire = new vscode.EventEmitter<{ 
        taskId: string; 
        sessionId: string;
        questions: any[]; 
        contextSummary?: string;
        rawAnalystResponse?: string;
    }>();
    public readonly onQuestionnaire = this._onQuestionnaire.event;

    // Approval resolvers - allows execution loop to await user approval
    private _approvalResolvers: Map<string, { resolve: (approved: boolean) => void, feedback?: string }> = new Map();

    // Global agent mode (applies to all missions)
    private _globalAgentMode: 'auto' | 'agent-decides' = 'auto';

    public getTasks(): AgentTask[] {
        return Array.from(this.tasks.values());
    }

    // Get/Set global agent mode
    public getAgentMode(): 'auto' | 'agent-decides' {
        return this._globalAgentMode;
    }

    public setAgentMode(mode: 'auto' | 'agent-decides') {
        this._globalAgentMode = mode;
        console.log(`[TaskRunner] Agent mode set to: ${mode}`);
    }

    // Approval control methods for Agent Decides mode
    public approveReview(taskId: string, feedback?: string) {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'awaiting-approval') { return; }

        // Clear awaiting state
        task.awaitingApproval = undefined;
        task.status = 'executing';

        // If feedback provided, inject it as a user message
        if (feedback && feedback.trim()) {
            task.userMessages.push({ text: `[User Feedback on Plan]: ${feedback}`, attachments: [] });
            task.logs.push(`> [User Feedback]: ${feedback}`);
        }

        // Resolve the waiting promise to resume execution loop
        const resolver = this._approvalResolvers.get(taskId);
        if (resolver) {
            resolver.feedback = feedback;
            resolver.resolve(true);
            this._approvalResolvers.delete(taskId);
        }

        this._onApprovalComplete.fire({ taskId });
        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);
    }

    public rejectReview(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) { return; }

        task.awaitingApproval = undefined;
        task.status = 'failed';
        task.logs.push(`> [System]: User cancelled the pending approval.`);

        // Resolve the waiting promise with false to stop execution
        const resolver = this._approvalResolvers.get(taskId);
        if (resolver) {
            resolver.resolve(false);
            this._approvalResolvers.delete(taskId);
        }

        this._onApprovalComplete.fire({ taskId });
        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);
    }

    public approveCommand(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'awaiting-approval') { return; }

        task.awaitingApproval = undefined;
        task.status = 'executing';
        task.logs.push(`> [System]: User approved the high-risk command.`);

        // Resolve the waiting promise to resume with command execution
        const resolver = this._approvalResolvers.get(taskId);
        if (resolver) {
            resolver.resolve(true);
            this._approvalResolvers.delete(taskId);
        }

        this._onApprovalComplete.fire({ taskId });
        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);
    }

    public declineCommand(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) { return; }

        const declinedCommand = task.awaitingApproval?.content || 'unknown command';
        task.awaitingApproval = undefined;
        task.status = 'executing';  // Continue but skip the command
        task.logs.push(`> [System]: User declined the command: ${declinedCommand}`);

        // Resolve promise with false - command will be skipped
        const resolver = this._approvalResolvers.get(taskId);
        if (resolver) {
            resolver.resolve(false);
            this._approvalResolvers.delete(taskId);
        }

        this._onApprovalComplete.fire({ taskId });
        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);
    }

    /**
     * Confirm that user has completed login in browser.
     * Called when user clicks "I've Logged In" button.
     */
    public confirmLoginComplete(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task || task.awaitingApproval?.type !== 'login-checkpoint') { return; }

        task.awaitingApproval = undefined;
        task.status = 'executing';
        task.logs.push(`> [Browser]: ✅ User confirmed login complete. Resuming automation...`);

        // Resolve the waiting promise
        const resolver = this._approvalResolvers.get(taskId);
        if (resolver) {
            resolver.resolve(true);
            this._approvalResolvers.delete(taskId);
        }
        this._onApprovalComplete.fire({ taskId });
        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);
    }

    /**
     * Cancel login checkpoint (user chose to skip/cancel).
     */
    public cancelLoginCheckpoint(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) { return; }

        task.awaitingApproval = undefined;
        task.status = 'executing';
        task.logs.push(`> [Browser]: ❌ Login cancelled by user. Skipping authentication...`);

        const resolver = this._approvalResolvers.get(taskId);
        if (resolver) {
            resolver.resolve(false);
            this._approvalResolvers.delete(taskId);
        }
        this._onApprovalComplete.fire({ taskId });
        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);
    }

    /**
     * Request a login checkpoint - waits for user to confirm they've logged in.
     * This is used by BrowserAutomationService when a login page is detected.
     */
    public async requestLoginCheckpoint(taskId: string, loginUrl: string, ssoProvider?: string): Promise<boolean> {
        const providerText = ssoProvider ? ` (${ssoProvider})` : '';
        const content = `🔐 **Authentication Required${providerText}**

A login page has been detected at:
\`${loginUrl}\`

Please complete the login in the browser window, then click **"I've Logged In"** below to continue.

*The automation is paused and will resume after you confirm.*`;

        return this.waitForApproval(taskId, 'login-checkpoint', content);
    }

    /**
     * Handle questionnaire submission from the interactive UI.
     * Converts structured responses to a message for the refinement session.
     */
    public async handleQuestionnaireSubmit(
        taskId: string,
        sessionId: string,
        responses: Array<{ questionId: string; selectedOptions?: string[]; textResponse?: string }>
    ): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) {
            console.error(`[TaskRunner] handleQuestionnaireSubmit: Task not found: ${taskId}`);
            return;
        }

        console.log(`[TaskRunner] Processing questionnaire submission for task ${taskId}, session ${sessionId}`);

        // Convert structured responses to a formatted message
        const formattedAnswers = responses.map((r, idx) => {
            const parts: string[] = [];
            
            // Add selected options
            if (r.selectedOptions && r.selectedOptions.length > 0) {
                parts.push(r.selectedOptions.join(', '));
            }
            
            // Add text response
            if (r.textResponse && r.textResponse.trim()) {
                if (parts.length > 0) {
                    parts.push(`(Additional: ${r.textResponse.trim()})`);
                } else {
                    parts.push(r.textResponse.trim());
                }
            }
            
            return `${idx + 1}. ${parts.join(' ') || 'No answer provided'}`;
        }).join('\n');

        const message = `My answers to your questions:\n\n${formattedAnswers}`;

        // Log the submission
        task.logs.push(`\n**Your Answers:**\n${formattedAnswers}`);
        this._onTaskUpdate.fire({ taskId, task });

        // Route to refinement manager
        const refinementManager = getRefinementManager();
        const actualSessionId = refinementManager.getSessionForTask(taskId);
        
        if (actualSessionId) {
            try {
                task.logs.push('\n> [Refinement]: Processing your answers...');
                this._onTaskUpdate.fire({ taskId, task });
                
                await refinementManager.handleUserMessage(actualSessionId, message);
            } catch (error: any) {
                console.error('[TaskRunner] Error handling questionnaire submission:', error);
                task.logs.push(`> [Error]: Failed to process answers: ${error.message}`);
                this._onTaskUpdate.fire({ taskId, task });
            }
        } else {
            console.error(`[TaskRunner] No refinement session found for task ${taskId}`);
            task.logs.push(`> [Error]: Refinement session not found. Please try again.`);
            this._onTaskUpdate.fire({ taskId, task });
        }
    }

    public async approvePrd(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) { return; }

        console.log('[TaskRunner] User clicked Approve PRD via UI');
        task.awaitingApproval = undefined; // Clear approval state
        task.logs.push('> [Refinement]: User approved PRD via Review Pane. Transitioning to Planning Mode...');

        // Get the PRD content from the refinement session
        const refinementManager = getRefinementManager();
        const sessionId = refinementManager.getSessionForTask(taskId);
        let prdContent = '';
        if (sessionId) {
            prdContent = refinementManager.getSessionDraft(sessionId) ||
                `User Request: ${task.displayPrompt || task.prompt}`;
        }

        this._onApprovalComplete.fire({ taskId });
        this._onTaskUpdate.fire({ taskId, task }); // Update UI to remove review pane

        await this.transitionFromRefinementToPlanning(taskId, prdContent);
    }

    public async requestPrdChanges(taskId: string, feedback: string) {
        const task = this.tasks.get(taskId);
        if (!task) { return; }

        console.log('[TaskRunner] User requested PRD changes via UI');
        task.awaitingApproval = undefined; // Clear approval state
        task.logs.push(`> [Refinement]: User feedback: "${feedback}"`);
        task.userMessages.push({ text: feedback, attachments: [] });

        this._onApprovalComplete.fire({ taskId });
        this._onTaskUpdate.fire({ taskId, task }); // Update UI to remove review pane

        // Send feedback to refinement session
        const refinementManager = getRefinementManager();
        const sessionId = refinementManager.getSessionForTask(taskId);

        if (sessionId) {
            console.log(`[TaskRunner] Sending feedback to refinement session: ${sessionId}`);
            task.logs.push('> [Refinement]: Processing your feedback...');
            this._onTaskUpdate.fire({ taskId, task });

            try {
                await refinementManager.handleUserMessage(sessionId, feedback);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('[TaskRunner] Refinement feedback failed:', err);
                task.logs.push(`> [Refinement Error]: ${message}`);
                task.status = 'failed';
                this._onTaskUpdate.fire({ taskId, task });
            }
        } else {
            console.error('[TaskRunner] No active refinement session found for task:', taskId);
            task.logs.push('> [Error]: Refinement session not found.');
            task.status = 'failed';
            this._onTaskUpdate.fire({ taskId, task });
        }
        this.saveTask(task);
    }

    constructor(private context: vscode.ExtensionContext) {
        // Initialize WorktreeManager with the first workspace folder
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.worktreeManager = new WorktreeManager(vscode.workspace.workspaceFolders[0].uri.fsPath);
        }

        // Load tasks from disk
        this.loadTasks();

        // Subscribe to refinement completion events
        const refinementManager = getRefinementManager();
        refinementManager.onRefinementComplete(({ taskId, artifact }) => {
            console.log(`[TaskRunner] Refinement complete for task ${taskId}, transitioning to Planning`);
            this.transitionFromRefinementToPlanning(taskId, artifact.rawMarkdown);
        });
    }

    /**
     * Wait for user approval in Agent Decides mode OR for constitution review.
     * Returns true if approved, false if rejected/declined.
     */
    private async waitForApproval(
        taskId: string,
        type: 'plan' | 'command' | 'constitution' | 'constitution-update' | 'constitution-drift' | 'prd' | 'login-checkpoint',
        content: string,
        riskReason?: string
    ): Promise<boolean> {
        const task = this.tasks.get(taskId);
        if (!task) { return false; }

        // Set task to awaiting approval state
        task.status = 'awaiting-approval';
        task.awaitingApproval = { type, content, riskReason };
        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);

        // Create a promise that will be resolved when user approves/rejects
        return new Promise<boolean>((resolve) => {
            this._approvalResolvers.set(taskId, { resolve });

            // Fire the event to notify UI
            this._onAwaitingApproval.fire({ taskId, type, content, riskReason });

            // Create appropriate log message based on type
            let logMessage: string;
            switch (type) {
                case 'constitution':
                    logMessage = 'Constitution ready for review';
                    break;
                case 'constitution-update':
                    logMessage = 'Post-mission constitution update ready for review';
                    break;
                case 'constitution-drift':
                    logMessage = 'Constitution drift detected - update ready for review';
                    break;
                case 'plan':
                    logMessage = 'Implementation plan ready for review';
                    break;
                case 'command':
                    logMessage = 'High-risk command requires approval';
                    break;
                case 'login-checkpoint':
                    logMessage = '🔐 Login Required - Please complete authentication in the browser window';
                    break;
                default:
                    logMessage = 'Approval required';
            }
            task.logs.push(`> [Awaiting Approval]: ${logMessage}`);
            this._onTaskUpdate.fire({ taskId, task });
        });
    }

    /**
     * Check if a command is high-risk and requires approval
     */
    private isHighRiskCommand(command: string): { isRisk: boolean, reason?: string } {
        const cmd = command.toLowerCase().trim();

        // Destructive file operations
        if (cmd.includes('rm -rf') || cmd.includes('rmdir /s') || cmd.includes('del /s') || cmd.includes('rd /s')) {
            return { isRisk: true, reason: 'Recursive file/directory deletion' };
        }

        // Force push to git
        if (cmd.includes('git push') && (cmd.includes('-f') || cmd.includes('--force'))) {
            return { isRisk: true, reason: 'Force push may overwrite remote history' };
        }

        // Git reset hard
        if (cmd.includes('git reset') && cmd.includes('--hard')) {
            return { isRisk: true, reason: 'Hard reset discards uncommitted changes' };
        }

        // System-level commands
        if (cmd.includes('sudo ') || cmd.includes('chmod 777') || cmd.includes('chown')) {
            return { isRisk: true, reason: 'System-level permission changes' };
        }

        // Package manager installs with global flag
        if ((cmd.includes('npm install') || cmd.includes('pip install')) && cmd.includes('-g')) {
            return { isRisk: true, reason: 'Global package installation' };
        }

        // Database drops
        if (cmd.includes('drop database') || cmd.includes('drop table')) {
            return { isRisk: true, reason: 'Database deletion' };
        }

        return { isRisk: false };
    }

    /**
     * Intelligently truncate tool results before sending to AI to prevent token limit issues.
     * Special handling for compile errors: summarizes first errors, shows total count.
     * 
     * @param toolName - Name of the tool that produced the result
     * @param result - The raw tool result
     * @param tokenManager - Optional TokenManager for model-aware truncation
     * @param maxChars - Maximum characters (default 8000, ~2K tokens)
     */
    private truncateToolResult(toolName: string, result: string, tokenManager?: TokenManager, maxChars: number = 8000): string {
        // Use TokenManager if available for smarter truncation
        if (tokenManager) {
            return tokenManager.truncateToolResult(toolName, result, maxChars);
        }
        
        // Fallback to inline implementation
        if (result.length <= maxChars) {
            return result;
        }

        // Special handling for compile/build output - summarize errors
        if (toolName === 'run_command') {
            // TypeScript errors
            if (result.includes('error TS') || result.includes('Error:') || result.includes('error:')) {
                const lines = result.split('\n');
                const errorLines = lines.filter(line =>
                    line.includes('error TS') ||
                    line.includes('Error:') ||
                    line.includes('error:') ||
                    line.includes('warning:')
                );

                if (errorLines.length > 0) {
                    const totalErrors = errorLines.length;
                    const previewCount = Math.min(15, totalErrors);
                    const preview = errorLines.slice(0, previewCount).join('\n');

                    return `[COMPILE OUTPUT TRUNCATED - ${totalErrors} total errors/warnings found]\n\n` +
                        `First ${previewCount} errors:\n${preview}\n\n` +
                        (totalErrors > previewCount
                            ? `[...${totalErrors - previewCount} more errors truncated]\n\n`
                            : '') +
                        `ACTION: Fix the above issues first, then recompile to check for remaining errors.`;
                }
            }

            // npm install / general verbose output
            if (result.includes('npm WARN') || result.includes('added ') || result.includes('packages in')) {
                // Keep just the summary line at the end
                const lines = result.split('\n');
                const summaryLine = lines.find(l => l.includes('packages in') || l.includes('added '));
                const warningLines = lines.filter(l => l.includes('npm WARN')).slice(0, 5);

                return `[NPM OUTPUT TRUNCATED]\n\n` +
                    (warningLines.length > 0 ? `Key warnings:\n${warningLines.join('\n')}\n\n` : '') +
                    (summaryLine ? `Summary: ${summaryLine}` : 'Installation completed.');
            }
        }

        // Default truncation with note
        return result.substring(0, maxChars) +
            `\n\n[OUTPUT TRUNCATED - original was ${result.length} chars]\n` +
            `TIP: If you need more details, run a more specific command or check specific parts of the output.`;
    }

    private get storageDir(): string {
        const storageUri = this.context.globalStorageUri;
        const missionsDir = path.join(storageUri.fsPath, 'missions');
        if (!fs.existsSync(missionsDir)) {
            fs.mkdirSync(missionsDir, { recursive: true });
        }
        return missionsDir;
    }

    private saveTask(task: AgentTask) {
        try {
            const taskPath = path.join(this.storageDir, `${task.id}.json`);
            fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
        } catch (error) {
            console.error(`Failed to save task ${task.id}:`, error);
        }
    }

    /**
     * Clear all files in the missions/current/ folder.
     * Called at mission start to prevent old artifacts from bleeding.
     */
    private clearCurrentArtifacts(): void {
        const currentDir = path.join(this.storageDir, 'current');
        if (fs.existsSync(currentDir)) {
            try {
                for (const file of fs.readdirSync(currentDir)) {
                    fs.unlinkSync(path.join(currentDir, file));
                }
                console.log('[TaskRunner] Cleared current/ artifacts folder');
            } catch (err) {
                console.warn('[TaskRunner] Failed to clear current/ folder:', err);
            }
        }
    }

    /**
     * Clear workspace .vibearchitect artifacts to prevent bleeding.
     * Called on mission complete and when starting a new mission via replyToTask.
     * 
     * CRITICAL: Also clears the 'current' symlink/folder contents to prevent
     * the AI from finding old mission_summary.md files and thinking the mission is done.
     */
    private clearWorkspaceArtifacts(workspacePath: string): void {
        const artifactsDir = path.join(workspacePath, '.vibearchitect');
        // CRITICAL: Include prd.md to prevent old refinement PRDs from bleeding into new missions
        const filesToClear = ['task.md', 'implementation_plan.md', 'mission_summary.md', 'prd.md'];
        
        // Clear files in root .vibearchitect folder
        for (const file of filesToClear) {
            const filePath = path.join(artifactsDir, file);
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                    console.log(`[TaskRunner] Cleared workspace artifact: ${file}`);
                } catch (err) {
                    console.warn(`[TaskRunner] Failed to clear ${file}:`, err);
                }
            }
        }
        
        // CRITICAL: Clear the 'current' symlink/folder to prevent old artifacts bleeding
        const currentPath = path.join(artifactsDir, 'current');
        if (fs.existsSync(currentPath)) {
            try {
                const stats = fs.lstatSync(currentPath);
                if (stats.isSymbolicLink()) {
                    // It's a symlink - clear the contents of the target folder
                    const targetPath = fs.realpathSync(currentPath);
                    for (const file of filesToClear) {
                        const targetFile = path.join(targetPath, file);
                        if (fs.existsSync(targetFile)) {
                            fs.unlinkSync(targetFile);
                            console.log(`[TaskRunner] Cleared current/ artifact: ${file}`);
                        }
                    }
                } else if (stats.isDirectory()) {
                    // It's a junction or regular directory - clear its contents
                    for (const file of filesToClear) {
                        const targetFile = path.join(currentPath, file);
                        if (fs.existsSync(targetFile)) {
                            fs.unlinkSync(targetFile);
                            console.log(`[TaskRunner] Cleared current/ artifact: ${file}`);
                        }
                    }
                }
                
                // Also remove the symlink/junction itself to ensure clean slate
                try {
                    fs.unlinkSync(currentPath);
                    console.log(`[TaskRunner] Removed current symlink/junction`);
                } catch {
                    // On Windows, junctions might need rmdir
                    try {
                        fs.rmdirSync(currentPath);
                        console.log(`[TaskRunner] Removed current junction via rmdir`);
                    } catch (e) {
                        console.warn(`[TaskRunner] Could not remove current: ${e}`);
                    }
                }
            } catch (err) {
                console.warn(`[TaskRunner] Failed to clear current/ folder:`, err);
            }
        }
    }

    /**
     * Archive mission artifacts to chats/<taskId>/ folder.
     * Called on mission complete.
     */
    private archiveMissionArtifacts(task: AgentTask): void {
        if (!task.worktreePath) {
            console.warn('[TaskRunner] archiveMissionArtifacts: No worktreePath');
            return;
        }

        const srcDir = path.join(task.worktreePath, '.vibearchitect');
        const destDir = path.join(this.storageDir, 'chats', task.id);

        try {
            fs.mkdirSync(destDir, { recursive: true });
            // Include prd.md in archive to preserve refinement output
            const files = ['task.md', 'implementation_plan.md', 'mission_summary.md', 'prd.md'];
            let archivedCount = 0;

            for (const file of files) {
                const src = path.join(srcDir, file);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, path.join(destDir, file));
                    archivedCount++;
                }
            }
            
            // Also check the 'current' folder for artifacts
            const currentDir = path.join(srcDir, 'current');
            if (fs.existsSync(currentDir)) {
                try {
                    const stats = fs.lstatSync(currentDir);
                    const targetDir = stats.isSymbolicLink() ? fs.realpathSync(currentDir) : currentDir;
                    for (const file of files) {
                        const src = path.join(targetDir, file);
                        const dest = path.join(destDir, file);
                        if (fs.existsSync(src) && !fs.existsSync(dest)) {
                            fs.copyFileSync(src, dest);
                            archivedCount++;
                        }
                    }
                } catch (e) {
                    console.warn('[TaskRunner] Could not archive from current/', e);
                }
            }

            console.log(`[TaskRunner] Archived ${archivedCount} artifacts to chats/${task.id}/`);
            task.logs.push(`> [System]: Archived ${archivedCount} mission artifacts.`);
        } catch (err) {
            console.error('[TaskRunner] Failed to archive mission artifacts:', err);
        }
    }

    private loadTasks() {
        try {
            const dir = this.storageDir;
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const content = fs.readFileSync(path.join(dir, file), 'utf-8');
                const task = JSON.parse(content) as AgentTask;
                // Detect and fix "zombie" tasks that were executing when the extension terminated
                if (task.status === 'executing' || task.status === 'planning') {
                    task.status = 'failed';
                    task.logs.push("\n> [System]: Task execution interrupted by session termination (e.g. reload).");
                    this.saveTask(task); // Persist the fix
                }

                this.tasks.set(task.id, task);

                // Fire update so UI knows about it (if UI is listening already)
                // Note: UI might not be ready yet in constructor, but MissionControlProvider pulls data on init anyway.
            }
        } catch (error) {
            console.error("Failed to load tasks:", error);
        }
    }

    public async startTask(prompt: string, worktreePath?: string, mode: 'planning' | 'fast' | 'refinement' = 'planning', model: string = 'gemini-3-pro-preview', chatId?: string, displayPrompt?: string): Promise<string> {
        const taskId = `agent-${Date.now()}`;
        const task: AgentTask = {
            id: taskId,
            prompt,
            displayPrompt: displayPrompt || prompt,  // Use displayPrompt for UI, fallback to prompt
            status: 'pending',
            progress: 0,
            logs: [],
            userMessages: [],
            artifacts: [],
            worktreePath: worktreePath, // Store it initially if provided
            mode,
            model,
            chatId
        };
        this.tasks.set(taskId, task);
        this.saveTask(task); // Persist initial state

        // Start processing in background
        this.processTask(taskId);

        return taskId;
    }

    // Change model mid-task - will take effect on next message exchange
    public changeModel(taskId: string, newModel: string) {
        const task = this.tasks.get(taskId);
        if (!task) {
            console.log(`[TaskRunner] changeModel: task ${taskId} not found`);
            return;
        }

        const oldModel = task.model || 'gemini-3-pro-preview';
        task.model = newModel;
        task.logs.push(`**System**: Model changed from ${oldModel} to ${newModel}`);

        // Re-initialize client for the new model in the TASK CONTEXT
        const config = vscode.workspace.getConfiguration('vibearchitect');
        const isClaudeModel = newModel.startsWith('claude');
        const useCopilotForClaude = config.get<boolean>('useCopilotForClaude') || false;

        const context = this.taskContexts.get(taskId);
        if (!context) {
            // Should not happen if task is running, but if it is paused/zombie, we might strictly need it?
            // If context is missing, we can't really update the client instance.
            // But we can clear the old session.
            console.warn(`[TaskRunner] Context missing for task ${taskId} during model change.`);
        } else {
            // Reset clients in context
            context.gemini = undefined;
            context.claude = undefined;
            context.copilotClaude = undefined;

            if (isClaudeModel) {
                if (useCopilotForClaude) {
                    // Copilot Claude
                    task.logs.push(`**System**: Switching to Claude via Copilot...`);
                    // initialized later
                } else {
                    const claudeApiKey = config.get<string>('claudeApiKey') || '';
                    if (!claudeApiKey) {
                        task.logs.push(`**System**: Error - Claude API key not configured`);
                    } else {
                        // We can't really set specific client here easily without async init for Copilot
                        // So we just clear it, and processTask loop will recreate it if needed?
                        // Actually changeModel is sync.
                    }
                }
            }
        }

        // Clear old session so next message creates new one with new model
        this.sessions.delete(taskId);

        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);
    }

    /**
     * Stop a running task (cancel execution)
     */
    public stopTask(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) {
            console.log(`[TaskRunner] stopTask: task ${taskId} not found`);
            return;
        }

        // Only stop if task is actively running
        if (task.status === 'executing' || task.status === 'planning') {
            task.status = 'failed';
            task.logs.push(`**System**: Task stopped by user.`);

            // Clear the session to prevent further AI calls
            this.sessions.delete(taskId);

            this._onTaskUpdate.fire({ taskId, task });
            this.saveTask(task);
            console.log(`[TaskRunner] Task ${taskId} stopped by user`);
        } else {
            console.log(`[TaskRunner] Task ${taskId} is not running (status: ${task.status})`);
        }
    }

    /**
     * Change task mode between 'planning', 'fast', and 'refinement'
     */
    public changeTaskMode(taskId: string, newMode: 'planning' | 'fast' | 'refinement') {
        const task = this.tasks.get(taskId);
        if (!task) {
            console.log(`[TaskRunner] changeTaskMode: task ${taskId} not found`);
            return;
        }

        const oldMode = task.mode || 'planning';
        if (oldMode === newMode) { return; }

        task.mode = newMode;
        task.logs.push(`**System**: Mode changed from ${oldMode} to ${newMode}`);

        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);
        console.log(`[TaskRunner] Task ${taskId} mode changed to ${newMode}`);
    }

    /**
     * Transition from Refinement mode to Planning mode after PRD approval.
     * Saves the PRD to .vibearchitect and updates the task for planning.
     */
    public async transitionFromRefinementToPlanning(taskId: string, prdContent: string): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) {
            console.error(`[TaskRunner] transitionFromRefinementToPlanning: task ${taskId} not found`);
            return;
        }

        console.log(`[TaskRunner] Transitioning task ${taskId} from Refinement to Planning mode`);

        // Change mode to planning
        task.mode = 'planning';
        
        // ========================================
        // CRITICAL: Clear refinement-phase logs to prevent context bleeding
        // The approved PRD is the source of truth - old refinement conversations
        // (including user inputs that weren't accepted by REFINER) should NOT
        // bleed into the planning/execution context.
        // ========================================
        const refinementEndMarker = '=== REFINEMENT PHASE COMPLETE - PRD APPROVED ===';
        
        // Archive refinement logs for debugging but clear from active context
        const refinementLogs = task.logs.filter(log => 
            log.includes('[Refinement]') || 
            log.includes('**Analyst**') || 
            log.includes('**Critic**') ||
            log.includes('**Refiner**') ||
            log.includes('Draft PRD') ||
            log.includes('Refinement Mode')
        );
        
        if (refinementLogs.length > 0) {
            console.log(`[TaskRunner] Archiving ${refinementLogs.length} refinement logs to prevent context bleeding`);
        }
        
        // Keep only essential logs: system messages, errors, and the transition marker
        // Remove user messages from refinement phase to prevent their ignored inputs from bleeding
        const cleanedLogs = task.logs.filter(log => {
            // Keep system and error messages
            if (log.startsWith('**System**') || log.includes('[Error]')) {
                return true;
            }
            // Remove refinement-specific conversation logs
            if (log.includes('[Refinement]') || 
                log.includes('**Analyst**') || 
                log.includes('**Critic**') ||
                log.includes('**Refiner**') ||
                log.includes('Draft PRD') ||
                log.startsWith('**User**:')) {  // CRITICAL: Remove user messages from refinement phase
                return false;
            }
            // Keep other logs
            return true;
        });
        
        // Replace logs with cleaned version + marker
        task.logs = [
            ...cleanedLogs.slice(0, 5), // Keep first few system logs
            `\n${refinementEndMarker}\n`,
            `> [System]: PRD approved. Starting implementation phase.`,
            `> [System]: The PRD below is the ONLY source of truth for requirements.`
        ];
        
        // CRITICAL: Explicitly cleanup the refinement session to ensure no lingering state
        const refinementManager = getRefinementManager();
        const sessionId = refinementManager.getSessionForTask(taskId);
        if (sessionId) {
            console.log(`[TaskRunner] Cleaning up refinement session ${sessionId} after transition`);
            refinementManager.cancelSession(sessionId); // This will clean up session state
        }

        // Save PRD to .vibearchitect folder for persistence and AI access
        let prdRelativePath = '';
        if (task.worktreePath) {
            const chatId = task.chatId || 'default';
            const missionFolderManager = new MissionFolderManager(task.worktreePath);
            const baseDir = missionFolderManager.getBaseDir();
            
            // Get or create the mission folder for this chat
            const missionFolder = missionFolderManager.getMissionFolder(chatId);
            
            // Save PRD to the mission folder
            const prdFilePath = path.join(missionFolder, 'prd.md');
            try {
                fs.writeFileSync(prdFilePath, prdContent, 'utf-8');
                prdRelativePath = path.relative(task.worktreePath, prdFilePath).replace(/\\/g, '/');
                console.log(`[TaskRunner] Saved PRD to ${prdFilePath}`);
                task.logs.push(`> [System]: PRD saved to ${prdRelativePath}`);
                
                // Update the current symlink to point to this mission folder
                missionFolderManager.updateCurrentSymlink(missionFolder);
                task.logs.push(`> [System]: Mission folder set to current: .vibearchitect/current/prd.md`);
                
                // CRITICAL: Also save a copy directly to .vibearchitect/prd.md as backup
                // This ensures the AI can find the PRD even if symlink fails
                const backupPrdPath = path.join(baseDir, 'prd.md');
                fs.writeFileSync(backupPrdPath, prdContent, 'utf-8');
                console.log(`[TaskRunner] Also saved backup PRD to ${backupPrdPath}`);
                
                // Verify PRD files exist after save
                const primaryExists = fs.existsSync(prdFilePath);
                const backupExists = fs.existsSync(backupPrdPath);
                console.log(`[TaskRunner] PRD verification - mission folder: ${primaryExists}, backup: ${backupExists}`);
                if (!primaryExists || !backupExists) {
                    console.error(`[TaskRunner] PRD verification FAILED - files may not have saved correctly!`);
                }
            } catch (error) {
                console.error(`[TaskRunner] Failed to save PRD file: ${error}`);
            }
        }

        // Prepend PRD to prompt for the planning phase
        const originalPrompt = task.displayPrompt || task.prompt;
        const prdReference = prdRelativePath 
            ? `\n\n**IMPORTANT**: The full PRD is saved at \`.vibearchitect/prd.md\` (also at \`${prdRelativePath}\`). You MUST read this file first and implement according to its specifications.`
            : '';
        
        task.prompt = `## Approved Product Requirement Document (PRD)

The following PRD has been approved by the user after requirement refinement. Implement it exactly as specified.${prdReference}

${prdContent}

---

## Original User Request
${originalPrompt}`;

        // Update status and log
        task.status = 'pending';
        task.logs.push('\n**System**: 🎯 PRD Approved! Transitioning to Planning Mode for implementation...');
        task.logs.push('\n---\n');
        
        // CRITICAL: Mark task as coming from refinement to prevent PRD deletion
        (task as any)._fromRefinement = true;

        this._onTaskUpdate.fire({ taskId, task });
        this.saveTask(task);

        // Restart processing in planning mode
        this.processTask(taskId);
    }

    /**
     * Process a task in Refinement Mode using the RefinementManager.
     * This starts a multi-turn clarification loop before transitioning to planning.
     */
    private async processRefinementTask(taskId: string): Promise<void> {
        const task = this.tasks.get(taskId);
        if (!task) { return; }

        const config = vscode.workspace.getConfiguration('vibearchitect');
        const modelId = task.model || 'gemini-3-pro-preview';

        // Determine workspace for skeleton context
        let workspaceRoot = task.worktreePath;
        if (!workspaceRoot) {
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
                throw new Error("No workspace selected for refinement.");
            }
        }
        task.worktreePath = workspaceRoot;

        this.updateStatus(taskId, 'planning', 5, '🧠 Starting Refinement Mode...');
        task.logs.push('\n**System**: 🧠 Entering Refinement Mode - scanning relevant files and clarifying requirements...');
        this._onTaskUpdate.fire({ taskId, task });

        // NOTE: We no longer generate skeleton context here.
        // SmartContextBuilder will automatically scan relevant files based on user's prompt.
        // This provides full content for highly relevant files + skeleton for structure.

        // Initialize AI client based on model selection (use already-imported clients)
        const geminiApiKey = config.get<string>('geminiApiKey') || '';
        const claudeApiKey = config.get<string>('claudeApiKey') || '';
        const useCopilotForClaude = config.get<boolean>('useCopilotForClaude') || false;

        let aiClient: GeminiClient | ClaudeClient | CopilotClaudeClient | CopilotGPTClient;
        const isClaudeModel = modelId.startsWith('claude');
        const isGPTModel = modelId.startsWith('gpt');

        if (isClaudeModel) {
            if (useCopilotForClaude) {
                console.log('[TaskRunner] Initializing CopilotClaudeClient for Refinement Mode...');
                aiClient = new CopilotClaudeClient();
                const initialized = await aiClient.initialize();
                if (!initialized) {
                    task.logs.push('> [Error]: Failed to initialize Copilot Claude. Ensure GitHub Copilot is installed and you have an active subscription.');
                    task.status = 'failed';
                    this._onTaskUpdate.fire({ taskId, task });
                    this.saveTask(task);
                    return;
                }
                console.log('[TaskRunner] CopilotClaudeClient initialized successfully');
            } else {
                aiClient = new ClaudeClient(claudeApiKey, modelId);
            }
        } else if (isGPTModel) {
            console.log('[TaskRunner] Initializing CopilotGPTClient for Refinement Mode...');
            aiClient = new CopilotGPTClient();
            const initialized = await aiClient.initialize();
            if (!initialized) {
                task.logs.push('> [Error]: Failed to initialize Copilot GPT. Ensure GitHub Copilot is installed and you have an active subscription.');
                task.status = 'failed';
                this._onTaskUpdate.fire({ taskId, task });
                this.saveTask(task);
                return;
            }
            console.log('[TaskRunner] CopilotGPTClient initialized successfully');
        } else {
            aiClient = new GeminiClient(geminiApiKey, modelId);
        }

        // Get refinement manager
        const refinementManager = getRefinementManager();

        // Generate a session ID we can use for event filtering
        const sessionId = `refine-${taskId}-${Date.now()}`;

        // CRITICAL: Subscribe to events BEFORE starting the session
        // so we don't miss initial events
        const eventDisposable = refinementManager.onEvent((event) => {
            // Only process events for this task's session
            if (event.sessionId.startsWith(`refine-${taskId}`)) {
                console.log(`[TaskRunner] Refinement event: ${event.type}`, event.payload);

                if (event.type === 'analyst-response') {
                    // Display the FULL analyst response as ONE unified message
                    // This includes analysis, questions, and any draft - all in one bubble
                    const payload = event.payload as { content: string; hasQuestions: boolean; hasDraft: boolean; questionCount: number };
                    task.logs.push(`\n**Analyst Response:**\n${payload.content}`);
                    
                    // Add a subtle prompt based on what was found
                    if (payload.hasQuestions) {
                        task.logs.push(`\n> Please answer the questions above to continue refinement.`);
                    } else if (payload.hasDraft) {
                        task.logs.push(`\n> Review the draft above and provide feedback or approval.`);
                    }
                } else if (event.type === 'question') {
                    // Legacy: Still handle 'question' events from critic stage
                    const questions = event.payload as any[];
                    if (questions && questions.length > 0) {
                        task.logs.push('\n**Clarifying Questions:**');
                        questions.forEach((q: any, i: number) => {
                            task.logs.push(`${i + 1}. ${q.question || q}`);
                        });
                        task.logs.push('\n> Please reply with your answers to continue refinement.');
                    }
                } else if (event.type === 'draft-ready') {
                    // Only show if not already shown as part of analyst-response
                    task.logs.push(`\n**Draft PRD:**\n${event.payload}`);
                } else if (event.type === 'critique-ready') {
                    // Format critique in a user-friendly way
                    const critique = event.payload as { confidenceScore: number; passedValidation: boolean; issues: any[] };
                    const scoreEmoji = critique.confidenceScore >= 70 ? '✅' : critique.confidenceScore >= 50 ? '⚠️' : '❌';
                    
                    let critiqueMessage = `\n**Critic Review:**\n`;
                    critiqueMessage += `${scoreEmoji} **Confidence Score:** ${critique.confidenceScore}%\n`;
                    critiqueMessage += `**Validation:** ${critique.passedValidation ? 'Passed' : 'Needs Improvement'}\n`;
                    
                    if (critique.issues && critique.issues.length > 0) {
                        critiqueMessage += `\n**Issues Found:**\n`;
                        critique.issues.forEach((issue: any, i: number) => {
                            const severityIcon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
                            critiqueMessage += `${i + 1}. ${severityIcon} [${issue.type || 'issue'}] ${issue.description}`;
                            if (issue.suggestion) {
                                critiqueMessage += `\n   💡 *${issue.suggestion}*`;
                            }
                            critiqueMessage += '\n';
                        });
                        critiqueMessage += `\n> Please address the issues above by replying with clarifications.`;
                    } else if (!critique.passedValidation) {
                        critiqueMessage += `\n> The PRD needs more detail. The system will proceed with refinement using available information.`;
                    } else {
                        critiqueMessage += `\n> ✓ PRD looks good! Proceeding to final refinement.`;
                    }
                    
                    task.logs.push(critiqueMessage);
                } else if (event.type === 'artifact-ready') {
                    // Fire PRD review event to show in Context pane
                    const artifact = event.payload as any;
                    const prdContent = artifact?.rawMarkdown ||
                        (typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload, null, 2));

                    task.logs.push(`\n**Final PRD Ready** - Review in the CONTEXT pane and click "Approve" or "Request Changes".`);

                    // Send to webview for review
                    this._onAwaitingApproval.fire({
                        taskId,
                        type: 'prd',
                        content: prdContent
                    });
                } else if (event.type === 'questionnaire') {
                    // Handle structured questionnaire for interactive UI
                    const payload = event.payload as { 
                        questions: any[]; 
                        contextSummary?: string; 
                        rawAnalystResponse?: string 
                    };
                    
                    if (payload.questions && payload.questions.length > 0) {
                        // Add summary to chat indicating questionnaire is available
                        const questionCount = payload.questions.length;
                        task.logs.push(`\n> **📋 ${questionCount} question${questionCount > 1 ? 's' : ''} to answer** - View in Context pane for interactive form.`);
                        
                        // Fire questionnaire event for the webview
                        this._onQuestionnaire.fire({
                            taskId,
                            sessionId: event.sessionId,
                            questions: payload.questions,
                            contextSummary: payload.contextSummary,
                            rawAnalystResponse: payload.rawAnalystResponse
                        });
                    }
                } else if (event.type === 'state-change') {
                    task.logs.push(`> [Refinement]: State → ${event.payload}`);
                } else if (event.type === 'progress') {
                    task.logs.push(`> [Refinement]: ${event.payload}`);
                } else if (event.type === 'error') {
                    task.logs.push(`> [Refinement Error]: ${event.payload}`);
                }

                this._onTaskUpdate.fire({ taskId, task });
                this.saveTask(task);
            }
        });

        task.logs.push(`> [Refinement]: Starting session...`);
        task.logs.push('\n---\n');
        task.logs.push('**Analyst**: Analyzing your request to ask clarifying questions...');
        this._onTaskUpdate.fire({ taskId, task });

        try {
            // Now start the session with SMART context building
            // SmartContextBuilder will:
            // 1. Extract keywords from user's prompt
            // 2. Search for relevant files using VS Code APIs (ONLY in workspaceRoot)
            // 3. Provide full content for highly relevant files, skeleton for structure
            // 4. Stay within token budget
            // CRITICAL: Pass workspaceRoot to ensure we ONLY search the selected workspace
            const actualSessionId = await refinementManager.startSessionWithSmartContext(
                taskId,
                task.prompt,
                aiClient,
                workspaceRoot,  // CRITICAL: Only search within this workspace
                task.model  // Pass model ID for token budget calculation
            );

            task.logs.push(`> [Refinement]: Session ${actualSessionId} started with smart context for ${workspaceRoot}`);
            this._onTaskUpdate.fire({ taskId, task });
            this.saveTask(task);

            // The session is now running - user replies will come through replyToTask
            // When approved, onRefinementComplete will fire and call transitionFromRefinementToPlanning
            task.status = 'awaiting-approval';
            task.awaitingApproval = {
                type: 'plan',
                content: 'Refinement session in progress. Reply to provide clarifications or type "approve" to approve the PRD.'
            };
            this._onTaskUpdate.fire({ taskId, task });
            this.saveTask(task);

        } catch (error: any) {
            console.error('[TaskRunner] Refinement session failed:', error);
            task.logs.push(`> [Error]: Refinement failed - ${error.message}`);
            task.status = 'failed';
            this._onTaskUpdate.fire({ taskId, task });
            this.saveTask(task);
            eventDisposable.dispose();
        }
    }

    private async processTask(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) { return; }

        // ========================================
        // RACE CONDITION GUARD: Prevent duplicate task processing
        // ========================================
        if (this.runningTasks.has(taskId)) {
            console.warn(`[TaskRunner] Task ${taskId} is already being processed, skipping duplicate call`);
            return;
        }
        this.runningTasks.add(taskId);

        // ========================================
        // REFINEMENT MODE: Route to RefinementManager
        // ========================================
        if (task.mode === 'refinement') {
            try {
                await this.processRefinementTask(taskId);
                return; // Refinement handles its own flow
            } catch (error: any) {
                task.status = 'failed';
                task.logs.push(`> [Error]: Refinement failed - ${error.message}`);
                this._onTaskUpdate.fire({ taskId, task });
                this.saveTask(task);
                return;
            } finally {
                this.runningTasks.delete(taskId);
            }
        }

        try {

            // REFRESH SETTINGS: Always get latest API keys
            const config = vscode.workspace.getConfiguration('vibearchitect');
            const geminiApiKey = config.get<string>('geminiApiKey') || '';
            const claudeApiKey = config.get<string>('claudeApiKey') || '';

            // Select AI client based on model
            const modelId = task.model || 'gemini-3-pro-preview';
            const isClaudeModel = modelId.startsWith('claude');
            const useCopilotForClaude = config.get<boolean>('useCopilotForClaude') || false;

            // Client initialization moved down to use TaskContext

            this.updateStatus(taskId, 'planning', 5, `Initializing ${isClaudeModel ? 'Claude' : 'Gemini'} Agent...`);

            // Step 1: Determine Workspace
            // Priority: Explicitly provided path > Active VS Code Workspace > Error
            let workspaceRoot = task.worktreePath;

            if (!workspaceRoot) {
                if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                } else {
                    throw new Error("No workspace selected and no VS Code workspace open.");
                }
            }

            task.worktreePath = workspaceRoot; // Ensure it is set

            // Clean up stale artifacts from previous missions to prevent session bleeding
            // CRITICAL: Skip cleanup if this task is transitioning from refinement mode
            // because we just saved the PRD and don't want to delete it!
            const fromRefinement = (task as any)._fromRefinement;
            if (fromRefinement) {
                console.log(`[TaskRunner] Skipping artifact cleanup - task came from refinement mode, PRD must be preserved`);
                delete (task as any)._fromRefinement; // Clear the flag
            } else {
                this.clearWorkspaceArtifacts(workspaceRoot);
                this.clearCurrentArtifacts();
            }

            this.updateStatus(taskId, 'executing', 10, `Accessing Workspace: ${workspaceRoot}`);
            task.logs.push(`\n**Working Directory**: \`${workspaceRoot}\``);

            // INITIALIZE SHADOW REPO (Isolated per task for parallel execution safety)
            const shadowRepo = new ShadowRepository(this.context, workspaceRoot, taskId);
            await shadowRepo.initialize();
            const revertManager = new RevertManager(shadowRepo);

            // Initialize Context with DiffAggregator for batched diff operations
            const diffAggregator = new DiffAggregator(
                workspaceRoot,
                taskId,
                // Callback to track file edits for UI
                (filePath, beforeContent, afterContent) => {
                    if (!task.fileEdits) {
                        task.fileEdits = [];
                    }
                    task.fileEdits.push({
                        path: filePath,
                        beforeContent,
                        afterContent,
                        timestamp: Date.now(),
                        checkpointId: task.checkpoints?.[task.checkpoints.length - 1]?.id
                    });
                    if (!task.artifacts.includes(filePath)) {
                        task.artifacts.push(filePath);
                        task.logs.push(`[Artifact Modified]: ${filePath}`);
                    }
                }
            );

            // Initialize TokenManager with model-aware limits
            // Will be updated with actual VS Code LM API limits when AI client is initialized
            const tokenManager = TokenManager.fromModelId(task.model || 'default');
            
            // Initialize RuleEnforcer for constitution rule validation
            const ruleEnforcer = createRuleEnforcer();
            
            const taskContext: TaskContext = {
                shadowRepo,
                revertManager,
                diffAggregator,
                tokenManager,
                ruleEnforcer
            };
            this.taskContexts.set(taskId, taskContext);

            task.checkpoints = []; // Reset checkpoints for new run

            // Initial Snapshot
            const initialHash = await shadowRepo.snapshot("Task Started");
            task.checkpoints.push({ id: initialHash, message: "Task Started", timestamp: Date.now() });

            // We set a branch name just for reference or if we add git features later, 
            // but we don't switch branches automatically anymore to be safe? 
            // The user wanted "Directly work in the workspaces".
            // So we assume the user is on the branch they want.
            // Use workspace folder name as branch identifier
            task.branchName = path.basename(workspaceRoot);

            // ========================================
            // SPEC-KIT: Constitution Lifecycle
            // ========================================
            const isTrivial = this.isTrivialRequest(task.prompt);

            if (!isTrivial) {
                const specManager = new SpecManager();
                await specManager.initialize(workspaceRoot);
                taskContext.specManager = specManager;

                // Check if workspace is empty (no meaningful files)
                if (specManager.isWorkspaceEmpty()) {
                    task.logs.push(`> [Constitution]: Workspace is empty, skipping constitution`);
                } else if (!specManager.hasConstitution()) {
                    // Generate constitution for first-time workspace
                    task.logs.push(`> [Constitution]: No constitution found, generating...`);
                    this.updateStatus(taskId, 'planning', 8, 'Generating workspace constitution...');
                    specManager.setPhase(SpecPhase.CONSTITUTION_GENERATION);

                    const harvester = new ContextHarvester();
                    const contextData = await harvester.scanWorkspace(workspaceRoot);

                    console.log(`[TaskRunner] Constitution: Context data length: ${contextData.length}`);
                    console.log(`[TaskRunner] Constitution: Context preview: ${contextData.substring(0, 500)}...`);

                    // We need an AI client to generate the constitution
                    // IMPORTANT: Always use top-tier models for constitution - it's the "brain" document
                    let constitutionAI: GeminiClient | ClaudeClient | CopilotClaudeClient | CopilotGPTClient;
                    if (modelId.startsWith('gpt')) {
                        // User selected GPT-5-mini via Copilot
                        console.log(`[TaskRunner] Constitution: Using Copilot GPT for generation`);
                        const gptClient = new CopilotGPTClient();
                        const initialized = await gptClient.initialize();
                        if (!initialized) { throw new Error('Failed to initialize Copilot GPT for constitution'); }
                        constitutionAI = gptClient;
                    } else if (isClaudeModel && useCopilotForClaude) {
                        // User selected Claude via Copilot
                        console.log(`[TaskRunner] Constitution: Using Copilot Claude for generation`);
                        const copilotClient = new CopilotClaudeClient();
                        const initialized = await copilotClient.initialize();
                        if (!initialized) { throw new Error('Failed to initialize Copilot Claude for constitution'); }
                        constitutionAI = copilotClient;
                    } else if (isClaudeModel && claudeApiKey) {
                        // User selected Claude with API key - use Claude Opus 4
                        const CLAUDE_CONSTITUTION_MODEL = 'claude-opus-4-20250514';
                        console.log(`[TaskRunner] Constitution: Using ${CLAUDE_CONSTITUTION_MODEL} for generation`);
                        constitutionAI = new ClaudeClient(claudeApiKey, CLAUDE_CONSTITUTION_MODEL);
                    } else if (geminiApiKey) {
                        // Use Gemini 3 Pro for constitution
                        const GEMINI_CONSTITUTION_MODEL = 'gemini-3-pro-preview';
                        console.log(`[TaskRunner] Constitution: Using ${GEMINI_CONSTITUTION_MODEL} for generation`);
                        constitutionAI = new GeminiClient(geminiApiKey, GEMINI_CONSTITUTION_MODEL);
                    } else {
                        throw new Error('No API key available for constitution generation. Configure Claude API key, enable Copilot Claude/GPT, or add Gemini API key.');
                    }

                    // Generate constitution using AI with proper error handling
                    let finalConstitution = '';
                    try {
                        const constitutionPrompt = specManager.getConstitutionGenerationPrompt();
                        console.log('[TaskRunner] Constitution: Starting AI generation...');

                        const constitutionSession = constitutionAI.startSession(constitutionPrompt, 'high');
                        const result = await constitutionSession.sendMessage(`Here is the workspace context:\n\n${contextData}`);

                        // Handle response - may differ between Gemini and Claude
                        const responseObj = await result.response;
                        console.log('[TaskRunner] Constitution: Got response object:', typeof responseObj);

                        const constitutionContent = responseObj.text();
                        console.log(`[TaskRunner] Constitution: AI response text length: ${constitutionContent?.length || 0}`);

                        if (constitutionContent && constitutionContent.trim().length > 0) {
                            finalConstitution = constitutionContent;
                            console.log(`[TaskRunner] Constitution: Using AI-generated content (${finalConstitution.length} chars)`);
                        } else {
                            console.warn('[TaskRunner] Constitution: AI returned empty/whitespace');
                        }
                    } catch (aiError: any) {
                        console.error('[TaskRunner] Constitution: AI generation failed:', aiError.message);
                        task.logs.push(`> [Constitution]: AI generation error: ${aiError.message}`);
                    }

                    // Fallback if AI returns empty or fails
                    if (!finalConstitution || finalConstitution.trim().length === 0) {
                        console.log('[TaskRunner] Constitution: Using fallback with context data');
                        finalConstitution = `# Workspace Constitution

Generated automatically for: ${path.basename(workspaceRoot)}

This constitution defines the rules and patterns for this workspace.

${contextData}

---
*Constitution auto-generated from workspace scan*`;
                        task.logs.push(`> [Constitution]: Using auto-generated constitution from workspace scan`);
                    }

                    // Save constitution
                    console.log(`[TaskRunner] Constitution: Saving (${finalConstitution.length} chars)...`);
                    await specManager.saveConstitution(finalConstitution);
                    task.logs.push(`> [Constitution]: Generated and saved to ${specManager.getConstitutionPath()}`);

                    // Pause for user review (constitution review always happens)
                    specManager.setPhase(SpecPhase.CONSTITUTION_REVIEW);
                    const approved = await this.waitForApproval(taskId, 'constitution', finalConstitution);
                    if (!approved) {
                        throw new Error('Constitution rejected by user - mission cancelled');
                    }
                    task.logs.push(`> [Constitution]: Approved by user`);
                } else {
                    // Existing constitution - check for drift
                    task.logs.push(`> [Constitution]: Found existing constitution`);
                    specManager.setPhase(SpecPhase.DRIFT_DETECTION);
                    this.updateStatus(taskId, 'planning', 8, 'Checking for constitution drift...');

                    const harvester = new ContextHarvester();
                    const currentContext = await harvester.scanWorkspace(workspaceRoot);

                    // Create a temporary AI client for drift detection
                    let driftAI: GeminiClient | ClaudeClient | CopilotClaudeClient | CopilotGPTClient;
                    if (modelId.startsWith('gpt')) {
                        // GPT-5-mini via Copilot
                        const gptClient = new CopilotGPTClient();
                        const initialized = await gptClient.initialize();
                        if (!initialized) { throw new Error('Failed to initialize Copilot GPT for drift detection'); }
                        driftAI = gptClient;
                    } else if (isClaudeModel && useCopilotForClaude) {
                        const copilotClient = new CopilotClaudeClient();
                        const initialized = await copilotClient.initialize();
                        if (!initialized) { throw new Error('Failed to initialize Copilot Claude for drift detection'); }
                        driftAI = copilotClient;
                    } else if (isClaudeModel && claudeApiKey) {
                        driftAI = new ClaudeClient(claudeApiKey, modelId);
                    } else if (geminiApiKey) {
                        driftAI = new GeminiClient(geminiApiKey, modelId);
                    } else {
                        throw new Error('No API key available for drift detection. Configure Claude API key, enable Copilot Claude, or add Gemini API key.');
                    }

                    // Check for drift
                    const driftPrompt = specManager.getDriftDetectionPrompt(currentContext);
                    const driftSession = driftAI.startSession(driftPrompt, 'low');
                    const driftResult = await driftSession.sendMessage('Analyze the drift');
                    const driftResponse = (await driftResult.response).text();

                    const driftCheck = specManager.parseDriftResponse(driftResponse);

                    if (driftCheck.hasDrift) {
                        task.logs.push(`> [Constitution]: Drift detected - ${driftCheck.driftSummary}`);

                        // Prompt user for constitution update
                        const approved = await this.waitForApproval(
                            taskId,
                            'constitution-drift',
                            `**Drift Summary**: ${driftCheck.driftSummary}\n\n---\n\n${driftCheck.suggestedUpdates}`
                        );
                        if (approved) {
                            await specManager.saveConstitution(driftCheck.suggestedUpdates);
                            task.logs.push(`> [Constitution]: Updated based on detected drift`);
                        } else {
                            task.logs.push(`> [Constitution]: Drift update declined, continuing with existing constitution`);
                        }
                    } else {
                        task.logs.push(`> [Constitution]: No drift detected, proceeding with existing constitution`);
                    }
                }

                specManager.setPhase(SpecPhase.SPECIFICATION);
                
                // Set up RuleEnforcer with structured constitution
                if (taskContext.ruleEnforcer && specManager.hasConstitution()) {
                    const structuredConst = specManager.parseConstitutionToStructured();
                    if (structuredConst) {
                        taskContext.ruleEnforcer.setConstitution(structuredConst);
                        task.logs.push(`> [Constitution]: Rule enforcer loaded with ${
                            structuredConst.agentConstraints.must.length + 
                            structuredConst.agentConstraints.mustNot.length +
                            structuredConst.forbiddenPatterns.length
                        } rules`);
                    }
                }
            } else {
                task.logs.push(`> [Constitution]: Trivial request - skipping constitution check`);
            }
            // ========================================
            // END SPEC-KIT
            // ========================================

            // Step 2: Initialize Tools for this Workspace
            // Create AgentTools with everything needed
            // Note: We need a Gemini Client for the 'search_web' tool. 
            // We use the one from context if available, or create a temporary one?
            // Actually, we haven't assigned clients to context yet.

            // Let's instantiate the correct client FIRST.
            const isGPTModel = modelId.startsWith('gpt');

            if (isGPTModel) {
                // GPT-5-mini via Copilot
                task.logs.push(`> [System]: Using GPT-5-mini via GitHub Copilot subscription`);
                const gptClient = new CopilotGPTClient();
                const initialized = await gptClient.initialize();
                if (!initialized) { throw new Error('Failed to init Copilot GPT'); }
                taskContext.copilotGPT = gptClient;
            } else if (isClaudeModel) {
                if (useCopilotForClaude) {
                    task.logs.push(`> [System]: Using Claude via GitHub Copilot subscription`);
                    const copilotClient = new CopilotClaudeClient();
                    const initialized = await copilotClient.initialize();
                    if (!initialized) { throw new Error('Failed to init Copilot Claude'); }
                    taskContext.copilotClaude = copilotClient;
                } else {
                    if (!claudeApiKey) { throw new Error('Claude API Key missing'); }
                    taskContext.claude = new ClaudeClient(claudeApiKey, modelId);
                }
            } else {
                if (!geminiApiKey) { throw new Error('Gemini API Key missing'); }
                taskContext.gemini = new GeminiClient(geminiApiKey, modelId);
            }

            // We default search tool to use Gemini if available, or fail if not?
            // If using Claude, we might not have Gemini client for search.
            // But we can create a separate Gemini client just for search if key exists?
            let searchClient: GeminiClient | undefined = taskContext.gemini;
            if (!searchClient && geminiApiKey) {
                searchClient = new GeminiClient(geminiApiKey); // dedicated for search
            }

            // Derive task display name for terminal
            const taskDisplayName = task.displayPrompt?.substring(0, 40) || 
                                    task.prompt.substring(0, 40) || 
                                    `Task-${taskId.substring(0, 8)}`;
            
            const tools = new AgentTools(
                workspaceRoot,
                terminalManager,
                searchClient,
                taskContext.claude,
                taskContext.copilotClaude,
                () => { this._onReloadBrowser.fire(); },
                (url: string) => { this._onNavigateBrowser.fire(url); },
                FileLockManager.getInstance(), // Inject Lock Manager
                taskId, // Inject Task ID for locking
                // Login checkpoint callback - shows "I've Logged In" button in UI
                (checkpointTaskId: string, loginUrl: string, ssoProvider?: string) => 
                    this.requestLoginCheckpoint(checkpointTaskId, loginUrl, ssoProvider),
                taskDisplayName // Task name for terminal display
            );

            // Step 3: Start Gemini Session
            this.updateStatus(taskId, 'planning', 20, 'Consulting Gemini...');

            let systemPrompt = `You are an expert software engineer connected to a real file system.
            You are working DIRECTLY in the user's workspace.
            
            Your Mission: ${task.prompt}
            
            === BASIC TOOLS ===
            - read_file(path): Read file content.
            - write_file(path, content): Write file content (auto-creates dirs). Use for NEW files only.
            - apply_diff(path, diff): Apply SEARCH/REPLACE diff to modify existing files. PREFERRED for edits.
            - list_files(path): List directory.
            - run_command(command): Execute shell command (git, npm, etc).
            - search_web(query): Search the web for documentation, solutions, or new concepts.
            
            === TOKEN EFFICIENCY (CRITICAL) ===
            When MODIFYING existing files, ALWAYS use apply_diff instead of write_file.
            
            apply_diff Format:
            <<<<<<< SEARCH
            exact code to find (must match perfectly)
            =======
            replacement code
            >>>>>>> REPLACE
            
            Example - to change a function name:
            apply_diff("src/utils.ts", "<<<<<<< SEARCH
            function oldName() {
            =======
            function newName() {
            >>>>>>> REPLACE")
            
            === APPLY_DIFF BEST PRACTICES ===
            1. SEARCH block must match file content EXACTLY (including whitespace and indentation)
            2. Include 2-3 lines of unique context to ensure correct match location
            3. BATCH ALL CHANGES to the same file in ONE apply_diff call:
               <<<<<<< SEARCH
               first change
               =======
               first replacement
               >>>>>>> REPLACE
               
               <<<<<<< SEARCH
               second change
               =======
               second replacement
               >>>>>>> REPLACE
            4. For large files (>300 lines), add line hints: <<<<<<< SEARCH @@ 120-135 @@
            5. Use write_file ONLY for creating NEW files
            6. ALWAYS read_file BEFORE apply_diff to see exact current content
            7. If apply_diff fails, read the file again - content may have changed
            
            === SIMPLE PREVIEW (just for quick display to user) ===
            - reload_browser(): Reload the embedded preview pane. Use ONLY to show the user what you built.
            - navigate_browser(url): Navigate the embedded preview to a URL. Does NOT verify anything.
            
            === AUTOMATED UI TESTING (MANDATORY for verification) ===
            Use these tools to VERIFY your work. They provide AI-powered analysis and self-healing:
            - browser_launch(true): Launch Chrome with video recording. ALWAYS use recordVideo=true.
            - browser_navigate(url): Navigate and wait for page load.
            - browser_screenshot(name?): Take a screenshot.
            - browser_click(selector): Click an element.
            - browser_type(selector, text): Type into an input.
            - browser_wait_for(selector): Wait for an element.
            - browser_get_dom(): Get page HTML.
            - browser_verify_ui(category, description): CRITICAL - This uses AI Vision to verify the UI matches expectations.
            - browser_close(): Close browser and save the video recording.

            === CRITICAL RULES ===
            
            1. **VERIFICATION IS MANDATORY**: After creating any web UI, you MUST verify it:
               a) Start server: run_command("python -m http.server 8080") or similar
               b) Launch automated browser: browser_launch(true)  <-- ALWAYS with recording
               c) Navigate: browser_navigate("http://localhost:8080")
               d) AI Verify: browser_verify_ui("page-name", "description of expected UI")
               e) If FAIL: Read the issues, fix the code, and call browser_verify_ui AGAIN
               f) If PASS: browser_close() to save the video
               g) (Optional) Show to user: navigate_browser("http://localhost:8080")
               
            2. **SELF-HEALING LOOP**: 
               - browser_verify_ui() returns PASS or FAIL with specific issues
               - If FAIL: Fix each issue listed, then verify again
               - Repeat until PASS (max 3 attempts)
               
            3. **DO NOT SKIP AUTOMATED TESTING**:
               - reload_browser() is NOT verification - it just shows the preview
               - ONLY browser_verify_ui() provides actual verification with AI analysis
               - Never say "verified" unless you called browser_verify_ui and got PASS
               
            4. **VIDEO RECORDING**: Always use browser_launch(true) so the session is recorded.
            
            5. **COMMUNICATE**: Explain what you did and what the verification found.
            
            6. **PYTHON RULES**:
               - NEVER install globally.
               - Create a venv: 'python -m venv venv'.
               - Install packages: 'venv/Scripts/pip install ...' (Windows) or 'venv/bin/pip ...' (Mac/Linux).
               - Run scripts: 'venv/Scripts/python app.py' (Windows) or 'venv/bin/python app.py' (Mac/Linux).
               
            7. **REASONING**: Before calling ANY tool, explain your plan in 1-2 sentences.
            `;




            // Use the unified workflow from buildModeWorkflow()
            const modeWorkflow = this.buildModeWorkflow(task.mode || 'planning', false);
            systemPrompt += `\n${modeWorkflow}\n`;

            // Inject constitution into system prompt if available
            if (taskContext.specManager && taskContext.specManager.hasConstitution()) {
                const constitution = taskContext.specManager.getConstitution();
                systemPrompt += `
            
            === PROJECT CONSTITUTION ===
            The following constitution defines the rules and patterns you MUST follow for this workspace.
            Violating these rules will result in poor code quality and user rejection.
            
            ${constitution}
            
            === END CONSTITUTION ===
            
            IMPORTANT: Always respect the constitution when making decisions about:
            - Technology choices
            - File organization
            - Coding patterns
            - Testing approaches
            `;
                task.logs.push(`> [Constitution]: Injected into agent context`);
            }

            // Start session with selected model
            let chat: ISession;

            if (isGPTModel && taskContext.copilotGPT) {
                chat = taskContext.copilotGPT.startSession(systemPrompt, task.mode === 'planning' ? 'high' : 'low');
            } else if (isClaudeModel && useCopilotForClaude && taskContext.copilotClaude) {
                chat = taskContext.copilotClaude.startSession(systemPrompt, task.mode === 'planning' ? 'high' : 'low');
            } else if (isClaudeModel && taskContext.claude) {
                chat = taskContext.claude.startSession(systemPrompt, task.mode === 'planning' ? 'high' : 'low');
            } else if (taskContext.gemini) {
                chat = taskContext.gemini.startSession(systemPrompt, 'high');
            } else {
                throw new Error("No AI Client initialized");
            }
            this.sessions.set(taskId, chat);

            // Step 4: Start Execution Loop
            await this.runExecutionLoop(taskId, chat, tools);

            // Note: Post-mission constitution review is now handled inside runExecutionLoop
            // so it works for both processTask and replyToTask

        } catch (error: any) {
            this.updateStatus(taskId, 'failed', 0, `Error: ${error.message} `);
            vscode.window.showErrorMessage(`Agent Failed: ${error.message} `);
        } finally {
            // Always remove from running tasks when done (success or failure)
            this.runningTasks.delete(taskId);
        }
    }

    private async runExecutionLoop(taskId: string, chat: ISession, tools: AgentTools) {
        const task = this.tasks.get(taskId);
        if (!task) { return; }

        let currentPrompt: string | any[] = "Start the mission.";
        // Reset or continue turns? We'll utilize a small loop for each 'batch' of reasoning
        // If resuming, we want to pick up.

        // If resuming, currentPrompt should be "Proceed." or the user message.
        if (task.status === 'completed') {
            currentPrompt = "Proceed.";
            task.status = 'executing';
            this.updateStatus(taskId, 'executing', task.progress, "Resuming mission...");
        }

        try {
            // Maximum turns for complex tasks in large workspaces
            // Each turn = thinking + tool calls + response
            // Complex features may need: file reading (20), writing (30), commands (10), debugging (30), verification (10)
            // 200 turns provides headroom while preventing runaway tasks
            const maxTurns = 200;
            for (let i = 0; i < maxTurns; i++) {
                // If the user interrupted or we are just continuing
                this.updateStatus(taskId, 'executing', task.progress, `Turn ${i + 1}: Thinking...`);

                // Check for user messages (High Priority)
                const isToolResponse = Array.isArray(currentPrompt) && currentPrompt.some((p: any) => p.functionResponse);

                // Check for user messages (High Priority) - ONLY if not currently sending a tool response
                if (!isToolResponse && task.userMessages.length > 0) {
                    const userMsgObj = task.userMessages.shift();
                    const userText = userMsgObj?.text || '';
                    const attachments = userMsgObj?.attachments || [];

                    task.logs.push(`> [System]: Processing user reply...`);

                    // Build Multi-modal Prompt
                    const promptParts: Part[] = [];
                    promptParts.push({ text: `\n[USER REPLY]: ${userText} ` });

                    if (attachments.length > 0) {
                        task.logs.push(`> [Context]: processing ${attachments.length} attachments...`);

                        for (const filePath of attachments) {
                            try {
                                if (fs.existsSync(filePath)) {
                                    const ext = path.extname(filePath).toLowerCase();
                                    const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);

                                    if (isImage) {
                                        const fileData = fs.readFileSync(filePath);
                                        const base64Data = fileData.toString('base64');
                                        // Simple mime mapping
                                        let mimeType = 'image/png';
                                        if (ext === '.jpg' || ext === '.jpeg') { mimeType = 'image/jpeg'; }
                                        if (ext === '.webp') { mimeType = 'image/webp'; }

                                        promptParts.push({
                                            inlineData: {
                                                mimeType: mimeType,
                                                data: base64Data
                                            }
                                        });
                                        task.logs.push(`> [Attachment]: Added image ${path.basename(filePath)} `);
                                    } else {
                                        // Text file
                                        const textContent = fs.readFileSync(filePath, 'utf-8');
                                        promptParts.push({
                                            text: `\n\n-- - FILE ATTACHMENT: ${path.basename(filePath)} ---\n${textContent} \n-- - END ATTACHMENT-- - `
                                        });
                                        task.logs.push(`> [Attachment]: Added text file ${path.basename(filePath)} `);
                                    }
                                }
                            } catch (e) {
                                task.logs.push(`> [Error]: Failed to read attachment ${filePath} `);
                            }
                        }
                    }

                    // Append to current prompt
                    if (Array.isArray(currentPrompt)) {
                        (currentPrompt as Part[]).push(...promptParts);
                    } else if (typeof currentPrompt === 'string') {
                        // If current prompt was string, upgrade it to parts
                        currentPrompt = [{ text: currentPrompt }, ...promptParts];
                    }
                }

                // Check if session was invalidated (e.g., by model switch)
                // If so, recreate the session with the new model
                let activeChat = this.sessions.get(taskId);
                console.log(`[TaskRunner] Session check - exists: ${!!activeChat}, task.model: ${task.model}`);
                if (!activeChat) {
                    // Session was deleted (model switch) - recreate with new model
                    task.logs.push(`> [System]: Model changed mid-task, creating new session with ${task.model}...`);
                    const config = vscode.workspace.getConfiguration('vibearchitect');
                    const modelId = task.model || 'gemini-3-pro-preview';
                    console.log(`[TaskRunner] Recreating session with modelId: ${modelId}`);
                    const isClaudeModel = modelId.startsWith('claude');
                    const useCopilotForClaude = config.get<boolean>('useCopilotForClaude') || false;

                    // Rebuild system prompt (simplified version for continuation)
                    const continuationPrompt = `You are continuing a task. Previous context is included. ${task.prompt}`;

                    if (isClaudeModel && useCopilotForClaude) {
                        const copilotClient = new CopilotClaudeClient();
                        await copilotClient.initialize();
                        if (this.taskContexts.has(taskId)) {
                            this.taskContexts.get(taskId)!.copilotClaude = copilotClient;
                        }
                        activeChat = copilotClient.startSession(continuationPrompt, task.mode === 'planning' ? 'high' : 'low');
                    } else if (isClaudeModel) {
                        const claudeApiKey = config.get<string>('claudeApiKey') || '';
                        if (!claudeApiKey) { throw new Error('Claude API key not configured'); }
                        const claudeClient = new ClaudeClient(claudeApiKey, modelId);
                        if (this.taskContexts.has(taskId)) {
                            this.taskContexts.get(taskId)!.claude = claudeClient;
                        }
                        activeChat = claudeClient.startSession(continuationPrompt, task.mode === 'planning' ? 'high' : 'low');
                    } else {
                        const geminiApiKey = config.get<string>('geminiApiKey') || '';
                        if (!geminiApiKey) { throw new Error('Gemini API key not configured'); }
                        const geminiClient = new GeminiClient(geminiApiKey, modelId);
                        if (this.taskContexts.has(taskId)) {
                            this.taskContexts.get(taskId)!.gemini = geminiClient;
                        }
                        activeChat = geminiClient.startSession(continuationPrompt, 'high');
                    }
                    this.sessions.set(taskId, activeChat);
                    chat = activeChat;
                }

                const result = await chat.sendMessage(currentPrompt);
                const response = await result.response;
                const text = response.text();

                if (text) {
                    // Use model-aware prefix for log parsing (Gemini or Claude)
                    const modelPrefix = (task.model || '').startsWith('claude') ? '**Claude**' : '**Gemini**';
                    task.logs.push(`${modelPrefix}: ${text} `);

                    // Add debug logging for summary extraction
                    if (text.toLowerCase().includes("mission summary")) {
                        console.log(`[TaskRunner] Potential summary detected in response: ${text.substring(0, 50)}...`);
                    }

                    // NOTE: Do NOT break here on "MISSION COMPLETE" - tool calls must be processed first!
                    // The proper completion check happens after tool processing at the end of this iteration.
                }

                // Handle Tool Calls
                const functionCalls = response.functionCalls();
                if (functionCalls && functionCalls.length > 0) {
                    const toolParts: any[] = [];

                    for (const call of functionCalls) {
                        const fnName = call.name;
                        const args = call.args;
                        task.logs.push(`> [Tool Call]: ${fnName} (${JSON.stringify(args)})`);

                        let toolResult = '';
                        try {
                            // CHECKPOINT BEFORE ACTION
                            const taskContext = this.taskContexts.get(taskId);
                            if (taskContext && taskContext.shadowRepo) {
                                // Only checkpoint for state-changing tools
                                if (['write_file', 'apply_diff', 'run_command'].includes(fnName)) {
                                    const snapMsg = `Pre - Tool: ${fnName} (${JSON.stringify(args)})`;
                                    if (taskContext.shadowRepo) {
                                        const snapHash = await taskContext.shadowRepo.snapshot(snapMsg);
                                        if (task.checkpoints) {
                                            task.checkpoints.push({ id: snapHash, message: snapMsg, timestamp: Date.now() });
                                            // Update UI immediately about checkpoint
                                            this._onTaskUpdate.fire({ taskId, task });
                                        }
                                    }
                                }
                            }

                            switch (fnName) {
                                case 'read_file': {
                                    const filePath = args.path as string;
                                    let content = await tools.readFile(filePath);
                                    
                                    // Token-aware truncation using unified TokenManager
                                    // Gets model-specific limits from VS Code LM API or fallbacks
                                    const taskContext = this.taskContexts.get(taskId);
                                    const tokenMgr = taskContext?.tokenManager;
                                    
                                    // Calculate max chars based on mode and available tokens
                                    // For planning/fast, allow up to 25% of available tokens for a single file
                                    const mode = task.mode === 'fast' ? 'fast' : 'planning';
                                    const availableTokens = tokenMgr?.getAvailableTokens(mode) ?? 30000;
                                    const maxFileTokens = Math.floor(availableTokens * 0.25);
                                    const MAX_FILE_CHARS = Math.max(20000, maxFileTokens * 4); // Min 20K chars
                                    
                                    if (!content.startsWith('Error') && content.length > MAX_FILE_CHARS) {
                                        // Use intelligent truncation that preserves important parts
                                        const originalLength = content.length;
                                        content = tokenMgr?.truncateFile(content, MAX_FILE_CHARS, filePath) 
                                            ?? content.slice(0, MAX_FILE_CHARS);
                                        const truncatedLength = content.length;
                                        
                                        task.logs.push(`[TokenManager] Truncated ${filePath}: ${Math.round(originalLength/1000)}KB → ${Math.round(truncatedLength/1000)}KB`);
                                        content += `\n\n[FILE TRUNCATED: Original ${Math.round(originalLength/1000)}KB. Use apply_diff for edits - do NOT use write_file on truncated content.]`;
                                    }
                                    
                                    toolResult = content;
                                    break;
                                }
                                case 'write_file': {
                                    // DIFF TRACKING: Capture before content
                                    let beforeContent: string | null = null;
                                    const filePath = args.path as string;
                                    const afterContent = args.content as string;
                                    const editTimestamp = Date.now();

                                    try {
                                        // Try to read existing file content before writing
                                        const existingContent = await tools.readFile(filePath);
                                        // Check if it's an error message (file doesn't exist)
                                        if (!existingContent.startsWith('Error reading file')) {
                                            beforeContent = existingContent;
                                        }
                                    } catch {
                                        // File doesn't exist, beforeContent stays null
                                    }

                                    // ==================== SECURITY PRE-CHECK ====================
                                    // Check for secrets and PII BEFORE writing
                                    const isEnvFile = filePath.endsWith('.env') || filePath.includes('.env.');
                                    const isTextFile = /\.(js|ts|jsx|tsx|py|rb|java|go|rs|php|cs|cpp|c|h|txt|json|yaml|yml|xml|md|csv|sql|html|htm|css|scss|less)$/i.test(filePath) || !filePath.includes('.');
                                    
                                    // SKIP security checks for .vibearchitect folder - these are internal planning docs
                                    const isVibearchitectFile = filePath.includes('.vibearchitect') || 
                                                                filePath.includes('.vibearchitect/') ||
                                                                filePath.includes('.vibearchitect\\');

                                    const detectedSecrets = isVibearchitectFile ? [] : detectSecrets(afterContent);
                                    const detectedPII = isVibearchitectFile ? [] : detectPII(afterContent);
                                    const highSeverityPII = detectedPII.filter(p => p.severity === 'high');

                                    const hasSecurityIssues = (detectedSecrets.length > 0 && !isEnvFile) || (highSeverityPII.length > 0 && isTextFile);

                                    if (hasSecurityIssues) {
                                        // Build warning message for approval
                                        let warningContent = `🔒 **SECURITY ALERT** for file: ${filePath}\n\n`;

                                        if (detectedSecrets.length > 0 && !isEnvFile) {
                                            warningContent += `**Potential Secrets Detected:**\n`;
                                            for (const secret of detectedSecrets.slice(0, 5)) {
                                                warningContent += `  • ${secret.type} at line ${secret.line}: ${secret.suggestion}\n`;
                                            }
                                            warningContent += `\n`;
                                        }

                                        if (highSeverityPII.length > 0 && isTextFile) {
                                            warningContent += `**PII Detected:**\n`;
                                            for (const pii of highSeverityPII.slice(0, 5)) {
                                                warningContent += `  • ${pii.type} at line ${pii.line} - Use ${pii.maskExample} for testing\n`;
                                            }
                                            warningContent += `\n`;
                                        }

                                        warningContent += `\n**Do you want to proceed with creating this file?**`;

                                        // Log the alert and trigger approval
                                        task.logs.push(`\n${warningContent}`);
                                        this._onTaskUpdate.fire({ taskId, task });

                                        // Wait for user approval
                                        const approved = await this.waitForApproval(taskId, 'command', warningContent, 'File contains sensitive data');

                                        if (!approved) {
                                            toolResult = `⛔ File creation aborted by user due to security concerns: ${filePath}`;
                                            task.logs.push(`> [Security]: User rejected file with sensitive data. File was NOT created.`);
                                            this._onTaskUpdate.fire({ taskId, task });
                                            break;
                                        }

                                        task.logs.push(`> [Security]: User approved file creation despite warnings.`);
                                    }

                                    // ==================== PROCEED WITH WRITE ====================
                                    toolResult = await tools.writeFile(filePath, afterContent);

                                    // Store file edit for diff viewing
                                    if (!task.fileEdits) {
                                        task.fileEdits = [];
                                    }
                                    task.fileEdits.push({
                                        path: filePath,
                                        beforeContent,
                                        afterContent,
                                        timestamp: editTimestamp,
                                        checkpointId: task.checkpoints?.[task.checkpoints.length - 1]?.id
                                    });

                                    // AUTO-RELOAD LOGIC:
                                    // If we wrote a frontend file, trigger the browser reload automatically.
                                    const p = filePath.toLowerCase();
                                    if (p.endsWith('.html') || p.endsWith('.css') || p.endsWith('.js') || p.endsWith('.jsx') || p.endsWith('.tsx')) {
                                        this._onReloadBrowser.fire();
                                        toolResult += "\n> [System]: Browser preview auto-reloaded.";
                                    }

                                    // Artifact Tracking
                                    if (args.path && !task.artifacts.includes(args.path)) {
                                        task.artifacts.push(args.path);
                                        task.logs.push(`[Artifact Created]: ${args.path} `);
                                    }

                                    // AGENT DECIDES MODE: Pause for review after creating implementation_plan.md
                                    if (this._globalAgentMode === 'agent-decides') {
                                        const baseName = filePath.split(/[\\/]/).pop()?.toLowerCase();
                                        if (baseName === 'implementation_plan.md') {
                                            task.logs.push(`> [Agent Decides]: Implementation plan created. Pausing for user review...`);
                                            const approved = await this.waitForApproval(taskId, 'plan', afterContent);
                                            if (!approved) {
                                                toolResult += '\n> [System]: User rejected the plan. Mission cancelled.';
                                                // Update task status back to executing before throwing
                                                task.status = 'failed';
                                                this._onTaskUpdate.fire({ taskId, task });
                                                throw new Error('User rejected implementation plan');
                                            }
                                            toolResult += '\n> [System]: User approved the implementation plan. Continuing...';
                                        }
                                    }
                                    break;
                                }
                                case 'apply_diff': {
                                    // Token-efficient differential editing with AGGREGATION
                                    // Multiple diffs to the same file are batched for:
                                    // - Single undo step
                                    // - No offset drift
                                    // - Better performance
                                    const diffPath = args.path as string;
                                    const diffContent = args.diff as string;

                                    // Get model source for logging
                                    const modelSource = (task.model || '').startsWith('claude') ? 'CopilotClaude' :
                                        (task.model || '').startsWith('gpt') ? 'CopilotGPT' : 'Gemini';

                                    // Get or create diff aggregator from task context
                                    const taskContext = this.taskContexts.get(taskId);
                                    const aggregator = taskContext?.diffAggregator;

                                    if (aggregator) {
                                        // Queue the diff for batched application
                                        const flushResult = await aggregator.queueDiff(diffPath, diffContent, modelSource);
                                        
                                        // If a different file was flushed, report that result first
                                        if (flushResult) {
                                            toolResult = flushResult.message;
                                            task.logs.push(`[DiffAggregator] Auto-flushed ${flushResult.filePath}: ${flushResult.appliedBlocks}/${flushResult.totalBlocks} blocks`);
                                        }

                                        // Report queuing status
                                        const pending = aggregator.getPendingCount();
                                        if (pending.totalBlocks > 0) {
                                            toolResult = toolResult 
                                                ? `${toolResult}\n\n✅ Queued diff for ${diffPath} (${pending.totalBlocks} blocks pending, will batch apply)`
                                                : `✅ Queued diff for ${diffPath} (${pending.totalBlocks} blocks pending, will batch apply)`;
                                        }
                                    } else {
                                        // Fallback: Direct application if no aggregator
                                        toolResult = await tools.applyDiff(diffPath, diffContent, modelSource);
                                        
                                        // Track file edit if successful
                                        if (toolResult.includes('Successfully applied diff') || toolResult.includes('✅')) {
                                            if (!task.artifacts.includes(diffPath)) {
                                                task.artifacts.push(diffPath);
                                                task.logs.push(`[Artifact Modified]: ${diffPath}`);
                                            }
                                        }
                                    }
                                    break;
                                }
                                case 'list_files':
                                    toolResult = await tools.listFiles(args.path as string);
                                    break;

                                case 'run_command': {
                                    const cmd = (args.command as string || '').trim();
                                    // Extract timeout from args, default to 15s, cap at 10min
                                    const waitTimeoutMs = Math.min((args.waitTimeoutMs as number) || 15000, 600000);

                                    // AGENT DECIDES MODE: Check for high-risk commands
                                    if (this._globalAgentMode === 'agent-decides') {
                                        const riskCheck = this.isHighRiskCommand(cmd);
                                        if (riskCheck.isRisk) {
                                            task.logs.push(`> [Agent Decides]: High-risk command detected. Requesting approval...`);
                                            const approved = await this.waitForApproval(taskId, 'command', cmd, riskCheck.reason);
                                            if (!approved) {
                                                toolResult = `> [System]: Command skipped by user: ${cmd}`;
                                                break;
                                            }
                                        }
                                    }

                                    // Aggressive check: if command mentions 'reload_browser', just do it.
                                    if (cmd.toLowerCase().includes('reload_browser')) {
                                        this._onReloadBrowser.fire();
                                        toolResult = "Browser reload triggered (via auto-correction).";
                                    } else {
                                        toolResult = await tools.runCommand(cmd, waitTimeoutMs);
                                    }
                                    break;
                                }
                                case 'reload_browser':
                                    this._onReloadBrowser.fire();
                                    toolResult = "Browser reload triggered.";
                                    break;
                                case 'navigate_browser': {
                                    const navUrl = args.url as string || 'http://localhost:3000';
                                    this._onNavigateBrowser.fire(navUrl);
                                    toolResult = `Browser navigated to ${navUrl}.`;
                                    break;
                                }
                                case 'search_web':
                                    toolResult = await tools.searchWeb(args.query as string);
                                    break;
                                // ==================== BROWSER AUTOMATION TOOLS ====================
                                case 'browser_launch':
                                    toolResult = await tools.browserLaunch(args.recordVideo as boolean || false);
                                    break;
                                case 'browser_navigate':
                                    toolResult = await tools.browserNavigate(args.url as string);
                                    break;
                                case 'browser_screenshot':
                                    toolResult = await tools.browserScreenshot(args.name as string);
                                    // Track screenshot as artifact
                                    if (toolResult.includes('Screenshot saved:')) {
                                        const screenshotPath = toolResult.split('Screenshot saved:')[1]?.trim();
                                        if (screenshotPath && !task.artifacts.includes(screenshotPath)) {
                                            task.artifacts.push(screenshotPath);
                                        }
                                    }
                                    break;
                                case 'browser_click':
                                    toolResult = await tools.browserClick(args.selector as string);
                                    break;
                                case 'browser_type':
                                    toolResult = await tools.browserType(args.selector as string, args.text as string);
                                    break;
                                case 'browser_wait_for':
                                    toolResult = await tools.browserWaitFor(args.selector as string, args.timeout as number);
                                    break;
                                case 'browser_get_dom':
                                    toolResult = await tools.browserGetDOM();
                                    break;
                                case 'browser_verify_ui':
                                    toolResult = await tools.browserVerifyUI(
                                        args.category as string,
                                        args.description as string,
                                        args.mission_objective as string || task.prompt // Use mission prompt as fallback
                                    );
                                    // Check if verification detected issues for self-healing
                                    if (toolResult.includes('❌ FAIL') || toolResult.includes('ACTION REQUIRED')) {
                                        task.logs.push(`> [UI Verification]: Issues detected - agent should attempt self-healing.`);
                                    } else if (toolResult.includes('✅ PASS')) {
                                        task.logs.push(`> [UI Verification]: UI verification passed!`);
                                    }
                                    break;
                                case 'browser_close':
                                    toolResult = await tools.browserClose();
                                    // Track recording as artifact if it was recorded
                                    if (toolResult.includes('Recording saved:')) {
                                        const recordingPath = toolResult.match(/Recording saved: ([^\s]+)/)?.[1];
                                        if (recordingPath && !task.artifacts.includes(recordingPath)) {
                                            task.artifacts.push(recordingPath);
                                        }
                                    }
                                    break;
                                default:
                                    toolResult = `Error: Unknown tool ${fnName} `;
                            }
                        } catch (err: any) {
                            toolResult = `Error executing ${fnName}: ${err.message} `;
                        }

                        const preview = toolResult.length > 500 ? toolResult.substring(0, 500) + '... (truncated)' : toolResult;
                        task.logs.push(`> [Result]: ${preview} `);

                        // CRITICAL: Truncate tool result BEFORE sending to AI to prevent token limit issues
                        // This is especially important for compile errors which can be 50,000+ chars
                        // Use TokenManager for model-aware truncation limits
                        const taskCtx = this.taskContexts.get(taskId);
                        const truncatedForAI = this.truncateToolResult(fnName, toolResult, taskCtx?.tokenManager);

                        toolParts.push({
                            functionResponse: {
                                name: fnName,
                                response: { content: truncatedForAI }
                            }
                        });
                    }

                    // ============================================
                    // FLUSH AGGREGATED DIFFS AT END OF TURN
                    // After processing all tool calls, apply any queued diffs
                    // This ensures batched application with single undo step
                    // ============================================
                    const flushContext = this.taskContexts.get(taskId);
                    if (flushContext?.diffAggregator?.hasPendingDiffs()) {
                        const pending = flushContext.diffAggregator.getPendingCount();
                        task.logs.push(`[DiffAggregator] Flushing ${pending.files} file(s) with ${pending.totalBlocks} pending blocks...`);
                        
                        const flushResults = await flushContext.diffAggregator.flushAll();
                        
                        for (const result of flushResults.results) {
                            task.logs.push(`[DiffAggregator] ${result.filePath}: ${result.message}`);
                            
                            // Add flush result to tool parts so model knows what happened
                            toolParts.push({
                                functionResponse: {
                                    name: 'apply_diff_batch',
                                    response: { 
                                        content: `Batched diff result for ${result.filePath}:\n${result.message}`,
                                        success: result.success,
                                        appliedBlocks: result.appliedBlocks,
                                        totalBlocks: result.totalBlocks,
                                        aggregatedDiffs: result.aggregatedDiffs
                                    }
                                }
                            });
                        }

                        if (flushResults.totalBlocksFailed > 0) {
                            task.logs.push(`[DiffAggregator] ⚠️ ${flushResults.totalBlocksFailed} blocks failed to apply`);
                        }
                    }

                    // ============================================
                    // CONSTITUTION RULE ENFORCEMENT
                    // Validate file edits against constitution rules
                    // ============================================
                    const enforceContext = this.taskContexts.get(taskId);
                    if (enforceContext?.ruleEnforcer && task.fileEdits && task.fileEdits.length > 0) {
                        // Get recent edits from this turn (last N edits based on recent timestamps)
                        const recentEdits = task.fileEdits.slice(-10); // Check last 10 edits
                        
                        // Convert to RuleEnforcer format
                        const editsToCheck: RuleFileEdit[] = recentEdits.map(edit => ({
                            path: edit.path,
                            type: edit.beforeContent === null ? 'create' : 'modify',
                            content: edit.afterContent,
                            previousContent: edit.beforeContent || undefined
                        }));
                        
                        const violations = await enforceContext.ruleEnforcer.validateFileEdits(editsToCheck);
                        
                        if (violations.length > 0) {
                            const logMsg = enforceContext.ruleEnforcer.generateLogMessage(violations);
                            task.logs.push(logMsg);
                            
                            // Inject violations into next prompt so agent can fix them
                            const violationPrompt = enforceContext.ruleEnforcer.formatViolationsForAgent(violations);
                            if (violationPrompt) {
                                toolParts.push({
                                    functionResponse: {
                                        name: 'constitution_check',
                                        response: { content: violationPrompt }
                                    }
                                });
                            }
                        }
                    }

                    currentPrompt = toolParts;
                    continue;

                } else {
                    if (!text.includes("MISSION COMPLETE")) {
                        // If the model provides a text response without tools, it's likely asking for input or explaining something.
                        // However, if we have pending user messages, we should continue processing them immediately.
                        if (task.userMessages.length > 0) {
                            currentPrompt = "Proceed.";
                            continue;
                        }

                        // Otherwise, we STOP the loop and wait for the user to reply.
                        currentPrompt = "Proceed."; // Default for next time, but we break now.
                        break;
                    } else {
                        // "MISSION COMPLETE" detected
                        break;
                    }
                }
            }

            // RE-ATTEMPT with minimal change to just the END of the function

            // ... (previous replacement block logic was mostly fine but let's be precise)

            const lastLog = task.logs[task.logs.length - 1] || "";
            const isMissionComplete = lastLog.includes("MISSION COMPLETE");
            // If the loop finished naturally (not break), we executed maxTurns.
            // But we can't easily know if it broke or finished without a flag.

            // However, if it IS "MISSION COMPLETE", we are good.
            if (isMissionComplete) {
                this.updateStatus(taskId, 'completed', 100, 'Mission Complete');
                task.logs.push(`\n > [!IMPORTANT]\n > ** Direct Execution **: Changes have been applied directly to \`${task.worktreePath}\`.\n> Please review your git status.`);

                // Extract Mission Summary for UI Card
                // FILE-BASED SUMMARY EXTRACTION
                // The agent is now instructed to create 'mission_summary.md'
                let summaryText = '';

                if (task.worktreePath) {
                    const summaryPath = path.join(task.worktreePath, '.vibearchitect', 'mission_summary.md');
                    if (fs.existsSync(summaryPath)) {
                        try {
                            summaryText = fs.readFileSync(summaryPath, 'utf-8');
                            console.log(`[TaskRunner] Found mission_summary.md: ${summaryText.substring(0, 50)}...`);
                        } catch (err) {
                            console.error(`[TaskRunner] Failed to read mission_summary.md:`, err);
                        }
                    } else {
                        console.log(`[TaskRunner] mission_summary.md not found in worktree.`);
                    }
                }

                // Fallback: Scan logs if file missing or verification failed
                if (!summaryText) {
                    console.log(`[TaskRunner] Falling back to log scan.`);
                    // Fallback: Scan logs if file missing
                    const outputRegex = /(?:\*\*|#|\s)*MISSION SUMMARY(?:\*\*|#|:|\s)*([\s\S]*?)(?:(?:\*\*|#|\s)*MISSION COMPLETE|$)/i;
                    for (let j = task.logs.length - 1; j >= Math.max(0, task.logs.length - 10); j--) {
                        // Strip both Gemini and Claude prefixes
                        const log = task.logs[j]
                            .replace(/\*\*Gemini\*\*:/g, '')
                            .replace(/\*\* Gemini \*\*:/g, '')
                            .replace(/\*\*Claude\*\*:/g, '')
                            .replace(/\*\* Claude \*\*:/g, '');
                        const match = log.match(outputRegex);
                        if (match && match[1] && match[1].trim().length > 10) {
                            summaryText = match[1].trim();
                            break;
                        }
                    }
                }

                if (summaryText) {
                    console.log(`[TaskRunner] Emitting Mission Summary Log.`);
                    // Convert literal \n escape sequences to actual newlines for proper markdown
                    summaryText = summaryText
                        .replace(/\\n/g, '\n')  // literal \n to newline
                        .replace(/\\t/g, '\t')  // literal \t to tab
                        .replace(/\n{3,}/g, '\n\n');  // collapse multiple newlines
                    task.logs.push(`[MISSION_COMPLETE_SUMMARY]: ${summaryText}`);
                    // CRITICAL: Notify UI of the new log entry
                    this._onTaskUpdate.fire({ taskId, task });
                    this.saveTask(task);
                }

                // ========================================
                // ARCHIVE MISSION ARTIFACTS
                // ========================================
                this.archiveMissionArtifacts(task);
                if (task.worktreePath) {
                    this.clearWorkspaceArtifacts(task.worktreePath);
                }
                this.clearCurrentArtifacts();

                // ========================================
                // POST-MISSION CONSTITUTION REVIEW (in runExecutionLoop)
                // ========================================
                const taskContext = this.taskContexts.get(taskId);
                if (taskContext?.specManager?.hasConstitution()) {
                    try {
                        task.logs.push(`> [Constitution]: Checking if updates are needed...`);
                        this.updateStatus(taskId, 'completed', 98, 'Reviewing constitution...');

                        const changedFiles = (task.fileEdits || []).map(edit => edit.path);

                        if (changedFiles.length > 0) {
                            // Read settings dynamically
                            const config = vscode.workspace.getConfiguration('vibearchitect');
                            const modelId = task.model || 'gemini-3-pro-preview';
                            const isClaudeModel = modelId.startsWith('claude');
                            const useCopilotForClaude = config.get<boolean>('useCopilotForClaude') || false;
                            const claudeApiKey = config.get<string>('claudeApiKey') || '';
                            const geminiApiKey = config.get<string>('geminiApiKey') || '';

                            // Create AI client for review - prioritize Copilot Claude if that's what we're using
                            let reviewAI: GeminiClient | ClaudeClient | CopilotClaudeClient;
                            if (isClaudeModel && useCopilotForClaude) {
                                const copilotClient = new CopilotClaudeClient();
                                const initialized = await copilotClient.initialize();
                                if (!initialized) {
                                    throw new Error('Failed to initialize Copilot Claude for constitution review');
                                }
                                reviewAI = copilotClient;
                            } else if (isClaudeModel && claudeApiKey) {
                                reviewAI = new ClaudeClient(claudeApiKey, modelId);
                            } else if (geminiApiKey) {
                                reviewAI = new GeminiClient(geminiApiKey, modelId);
                            } else {
                                throw new Error('No API key for constitution review');
                            }

                            const reviewPrompt = taskContext.specManager.getPostMissionReviewPrompt(changedFiles);
                            const reviewSession = reviewAI.startSession(reviewPrompt, 'low');
                            const reviewResult = await reviewSession.sendMessage('Analyze if constitution needs updates');
                            const reviewResponse = (await reviewResult.response).text();

                            const updateCheck = taskContext.specManager.parseUpdateCheckResponse(reviewResponse);

                            if (updateCheck.needsUpdate) {
                                taskContext.specManager.setPhase(SpecPhase.POST_MISSION_REVIEW);
                                task.logs.push(`> [Constitution]: Updates detected, requesting review...`);

                                const approved = await this.waitForApproval(
                                    taskId,
                                    'constitution-update',
                                    updateCheck.suggestedChanges
                                );
                                if (approved) {
                                    await taskContext.specManager.saveConstitution(updateCheck.suggestedChanges);
                                    task.logs.push(`> [Constitution]: Updated after mission completion`);
                                } else {
                                    task.logs.push(`> [Constitution]: Post-mission update declined`);
                                }
                            } else {
                                task.logs.push(`> [Constitution]: No updates needed`);
                            }
                        }
                    } catch (reviewError: any) {
                        task.logs.push(`> [Constitution]: Review error - ${reviewError.message}`);
                        console.error('[TaskRunner] Post-mission constitution review failed:', reviewError);
                    }
                    // Reset status to 'completed' after post-mission review (whether approved, declined, or errored)
                    task.status = 'completed';
                    this._onTaskUpdate.fire({ taskId, task });
                    this.saveTask(task);
                }
                // ========================================
                // END POST-MISSION CONSTITUTION REVIEW
                // ========================================

            } else {

                // Did we stop because of user input?
                // If the last thing was "Proceed", likely user input or just a break?
                // Actually, I set currentPrompt="Proceed." in line 450.

                // If currentPrompt is "Proceed." and NOT complete...
                // Actually, I set currentPrompt="Proceed." in line 450.

                if (currentPrompt === "Proceed.") {
                    // Paused for user interaction (implicit or explicit)
                    this.updateStatus(taskId, 'completed', task.progress, 'Waiting for user input...');
                } else {
                    // TIMEOUT (Loop finished without setting currentPrompt="Proceed." and without Mission Complete)
                    this.updateStatus(taskId, 'failed', 100, 'Task paused (Max turns reached). Ask agent to continue.');
                    task.logs.push(`\n> [System]: **Maximum turns reached.** The agent has paused to prevent infinite loops. You can reply "Continue" to resume.`);
                }
            }


        } catch (error: any) {
            this.updateStatus(taskId, 'failed', 0, `Error: ${error.message}`);
        }
    }

    private updateStatus(taskId: string, status: AgentTask['status'], progress: number, log: string) {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = status;
            task.progress = progress;
            if (!task.logs.includes(log)) {
                task.logs.push(log);
            }
            this._onTaskUpdate.fire({ taskId, task });
            this.saveTask(task); // Persist update
            console.log(`[${taskId}] ${status}: ${log}`);
            
            // Terminal lifecycle: Mark terminal as completed when task finishes
            // Keeps terminal open for user review (not immediate dispose)
            if (status === 'completed' || status === 'failed') {
                terminalManager.disposeForTask(taskId, false); // false = keep open for review
            }
        }
    }

    public async replyToTask(taskId: string, message: string, attachments: (string | Attachment)[] = []) {
        const task = this.tasks.get(taskId);
        if (task) {
            // Convert string paths to Attachment objects for consistent handling
            const normalizedAttachments: Attachment[] = attachments.map(a => {
                if (typeof a === 'string') {
                    return { name: a.split(/[\\/]/).pop() || a, type: 'file' as const, path: a };
                }
                return a;
            });
            
            task.userMessages.push({ text: message, attachments: normalizedAttachments.map(a => a.path || a.name) });

            // Log with context notice
            const contextMsg = normalizedAttachments.length > 0 ? ` (with ${normalizedAttachments.length} attachments)` : '';
            this.updateStatus(taskId, task.status, task.progress, `**User**: ${message}${contextMsg}`);
            
            // Process attachments (images via vision, documents via text extraction)
            let enrichedMessage = message;
            const imageAttachments = normalizedAttachments.filter(a => a.type === 'image' || 
                (a.path && /\.(png|jpg|jpeg|gif|webp)$/i.test(a.path)));
            const docAttachments = normalizedAttachments.filter(a => a.type === 'document' ||
                (a.path && /\.(pdf|txt|md|doc|docx)$/i.test(a.path)));
            
            if (imageAttachments.length > 0 || docAttachments.length > 0) {
                try {
                    const processor = getAttachmentProcessor();
                    const processed = await processor.processAttachments(normalizedAttachments);
                    const contextString = processor.generateContextString(processed);
                    if (contextString) {
                        enrichedMessage = message + contextString;
                        task.logs.push(`> [System]: Processed ${processed.length} attachments for context enrichment`);
                    }
                } catch (error: any) {
                    console.error('[TaskRunner] Attachment processing failed:', error);
                    task.logs.push(`> [System]: Attachment processing failed: ${error.message}`);
                }
            }

            // ========== REFINEMENT MODE REPLY HANDLING ==========
            // If task is awaiting-approval AND was started in refinement mode, route to RefinementManager
            if (task.status === 'awaiting-approval' && task.mode === 'refinement') {
                console.log(`[TaskRunner] Routing reply to RefinementManager for task ${taskId}`);
                const refinementManager = getRefinementManager();

                // Check if 'approve' to finalize and transition to planning
                const isApproval = message.toLowerCase().trim() === 'approve' ||
                    message.toLowerCase().includes('approve the prd') ||
                    message.toLowerCase().includes('looks good');

                if (isApproval) {
                    console.log('[TaskRunner] User approved refinement - transitioning to planning');
                    task.logs.push('> [Refinement]: User approved PRD. Transitioning to Planning Mode...');

                    // Get the PRD content from the refinement session
                    const sessionId = refinementManager.getSessionForTask(taskId);
                    let prdContent = '';
                    if (sessionId) {
                        prdContent = refinementManager.getSessionDraft(sessionId) ||
                            `User Request: ${task.displayPrompt || task.prompt}`;
                    }

                    await this.transitionFromRefinementToPlanning(taskId, prdContent);
                } else {
                    // Send user's clarification to the refinement session
                    try {
                        // Use proper public method to get session ID for this task
                        const sessionId = refinementManager.getSessionForTask(taskId);

                        if (sessionId) {
                            console.log(`[TaskRunner] Sending reply to refinement session: ${sessionId}`);
                            task.logs.push('> [Refinement]: Processing your answers...');
                            this._onTaskUpdate.fire({ taskId, task });

                            await refinementManager.handleUserMessage(sessionId, enrichedMessage);
                        } else {
                            console.error('[TaskRunner] No active refinement session found for task:', taskId);
                            task.logs.push('> [Error]: Refinement session not found. Please start a new task.');
                            task.status = 'failed';
                        }
                    } catch (error: any) {
                        console.error('[TaskRunner] Error handling refinement reply:', error);
                        task.logs.push(`> [Error]: ${error.message}`);
                    }
                }

                this._onTaskUpdate.fire({ taskId, task });
                this.saveTask(task);
                return;
            }

            // If completed, resume!
            if (task.status === 'completed' || task.status === 'failed') {
                let session = this.sessions.get(taskId);
                const worktreePath = task.worktreePath;

                if (!session && worktreePath) {
                    // Session lost (restart/reload), attempt to "restart" it
                    task.logs.push(`> [System]: Session restored with ${task.model || 'gemini-3-pro-preview'}. Starting new conversation context.`);

                    // REFRESH SETTINGS: Always get latest API keys
                    const config = vscode.workspace.getConfiguration('vibearchitect');
                    const modelId = task.model || 'gemini-3-pro-preview';
                    const isClaudeModel = modelId.startsWith('claude');

                    // Build previous context from task history
                    const previousContext = this.buildContextFromTask(task);

                    // Detect if this is a trivial request (skip planning for questions, math, etc.)
                    const isTrivial = this.isTrivialRequest(message);

                    // Detect if this is a substantial code change request (should use planning mode)
                    const msgLower = message.toLowerCase();
                    const hasChangeCommand = msgLower.includes('change') || msgLower.includes('modify') ||
                        msgLower.includes('update') || msgLower.includes('add') || msgLower.includes('fix') ||
                        msgLower.includes('implement') || msgLower.includes('refactor');
                    const hasCreateCommand = msgLower.includes('create') || msgLower.includes('make') ||
                        msgLower.includes('build') || msgLower.includes('write');
                    const specifiesNewFile = /create\s+\w+\.\w+|make\s+\w+\.\w+|build\s+\w+|write\s+\w+\.\w+/i.test(message);
                    const refersToOldWork = msgLower.includes('continue') || msgLower.includes('the file') ||
                        msgLower.includes('that file') || msgLower.includes('fix it') ||
                        msgLower.includes('next phase') || msgLower.includes('phase 2') ||
                        msgLower.includes('phase 3') || msgLower.includes('phase 4') ||
                        msgLower.includes('proceed') || msgLower.includes('resume');

                    // Substantial work = code changes/creates (not just viewing or asking questions)
                    const isSubstantialWork = hasChangeCommand || hasCreateCommand;

                    // NEW MISSION if: user is giving a CREATE/CHANGE command with specific intent AND not just saying "continue"
                    const isNewMission = (hasCreateCommand && specifiesNewFile && !refersToOldWork) ||
                        (message.length > 50 && !refersToOldWork && !msgLower.includes('the code'));

                    // CRITICAL: If this is a new mission, clear old artifacts to prevent bleeding
                    // BUT: Don't clear if task has active PRD from refinement (check prompt for PRD marker)
                    const hasPrdFromRefinement = task.prompt.includes('## Approved Product Requirement Document (PRD)');
                    if (isNewMission && !hasPrdFromRefinement) {
                        task.logs.push(`> [System]: New mission detected - clearing old artifacts to prevent context bleeding.`);
                        this.clearWorkspaceArtifacts(worktreePath);
                        this.clearCurrentArtifacts();
                    } else if (isNewMission && hasPrdFromRefinement) {
                        task.logs.push(`> [System]: New mission detected but PRD from refinement is active - preserving artifacts.`);
                    }

                    // CRITICAL: For substantial work, ALWAYS use planning mode regardless of original task.mode
                    // This ensures code changes get proper task.md / implementation_plan.md / validation
                    const effectiveMode = (isSubstantialWork && !isTrivial) ? 'planning' : (task.mode || 'planning');
                    const modeWorkflow = this.buildModeWorkflow(effectiveMode, isTrivial);

                    // Check if the previous task was completed
                    const wasCompleted = task.status === 'completed';
                    
                    const contextSection = isNewMission
                        ? `⚠️ CRITICAL: IGNORE all previous task context. The user is starting a BRAND NEW mission. Do exactly what they ask in their new request. Do NOT reference or continue any previous work.`
                        : `IMPORTANT - PREVIOUS CONTEXT (what was done before):\n${previousContext}`;

                    // Add strong anti-echo instruction for completed missions
                    const antiEchoInstruction = wasCompleted 
                        ? `
⚠️ CRITICAL - DO NOT REPEAT PREVIOUS OUTPUT:
- The previous mission was ALREADY completed
- Do NOT output "MISSION COMPLETE" again
- Do NOT repeat verification results or summaries
- Do NOT say "the mission is already complete" or similar
- Focus ONLY on what the user is asking NOW
- If they ask about the previous work, describe it briefly WITHOUT repeating the full summary
`
                        : '';

                    const systemPrompt = `You are ${isTrivial ? 'responding to a simple question' : (isNewMission ? 'starting a COMPLETELY NEW mission - forget all previous context' : 'continuing work on an existing mission')}.
                    
                    ${antiEchoInstruction}
                    
                    USER'S ${isNewMission ? 'NEW MISSION (IGNORE ALL PREVIOUS WORK)' : 'REQUEST'}: ${enrichedMessage}
                    
                    ${contextSection}
                    
                    ${modeWorkflow}
                    
                    CRITICAL: ${isNewMission ? 'This is a NEW mission - do not try to continue the old task.' : 'If the user refers to "the file" or "this file", they mean the files listed above in PREVIOUS CONTEXT.'}
                    Use your tools to explore the current state of the code if needed.
                    
                    Available Tools:
                    - read_file(path): Read file content.
                    - apply_diff(path, diff): Apply SEARCH/REPLACE diff to modify existing files. PREFERRED for edits!
                    - write_file(path, content): Write file content. Use for NEW files only.
                    - list_files(path): List directory.
                    - run_command(command): Execute shell command (git, npm, etc).
                    - reload_browser(): Reload the browser preview to verify changes. (Tool, NOT a shell command)
                    - navigate_browser(url): Navigate the browser preview to a specific URL (e.g., 'http://localhost:8080').
                    - search_web(query): Search the web for documentation, solutions, or new concepts.
                    
                    TOKEN EFFICIENCY (IMPORTANT):
                    When MODIFYING existing files, use apply_diff instead of write_file:
                    apply_diff("file.ts", "old code
                    =======
                    new code
                    >>>>>>> REPLACE")

                    UI VERIFICATION RULE:
                    If you make ANY changes to the Frontend (HTML/CSS/JS), you MUST execute 'reload_browser()' right after.
                    
                    SERVER MANAGEMENT RULE:
                    Always check if the server is running if the user mentions "start", "app", or "server".
                    PREFERRED: If 'restart.js' exists, run it: 'run_command("node restart.js")'. It handles killing old processes and starting new ones safely.
                    If no script, use 'run_command("npm start &")'.
                    `;


                    const useCopilotForClaude = config.get<boolean>('useCopilotForClaude') || false;

                    // Ensure Context exists because we need to store the client there
                    let taskContext = this.taskContexts.get(taskId);
                    if (!taskContext) {
                        // Create and initialize context (ShadowRepo needed for tools and revert)
                        // Pass taskId for per-task isolation (parallel execution safe)
                        const shadowRepo = new ShadowRepository(this.context, worktreePath, taskId);
                        await shadowRepo.initialize(); // Essential for checkpoints to work!
                        const revertManager = new RevertManager(shadowRepo);
                        
                        // Create DiffAggregator for batched diff operations
                        const diffAggregator = new DiffAggregator(
                            worktreePath,
                            taskId,
                            (filePath, beforeContent, afterContent) => {
                                if (!task.fileEdits) { task.fileEdits = []; }
                                task.fileEdits.push({
                                    path: filePath,
                                    beforeContent,
                                    afterContent,
                                    timestamp: Date.now()
                                });
                                if (!task.artifacts.includes(filePath)) {
                                    task.artifacts.push(filePath);
                                }
                            }
                        );
                        
                        const ruleEnforcer = createRuleEnforcer();
                        taskContext = { shadowRepo, revertManager, diffAggregator, ruleEnforcer };
                        this.taskContexts.set(taskId, taskContext);
                    }


                    if (isClaudeModel && useCopilotForClaude) {
                        task.logs.push('> [System]: Resuming with Claude via Copilot...');
                        const copilotClient = new CopilotClaudeClient();
                        const initialized = await copilotClient.initialize();
                        if (!initialized) {
                            task.logs.push('> [Error]: Failed to initialize Claude via Copilot');
                            return;
                        }
                        taskContext.copilotClaude = copilotClient;
                        session = copilotClient.startSession(systemPrompt, task.mode === 'planning' ? 'high' : 'low');
                    } else if (modelId.startsWith('gpt')) {
                        // GPT-5-mini via Copilot
                        task.logs.push('> [System]: Resuming with GPT-5-mini via Copilot...');
                        const gptClient = new CopilotGPTClient();
                        const initialized = await gptClient.initialize();
                        if (!initialized) {
                            task.logs.push('> [Error]: Failed to initialize GPT via Copilot');
                            return;
                        }
                        taskContext.copilotGPT = gptClient;
                        session = gptClient.startSession(systemPrompt, task.mode === 'planning' ? 'high' : 'low');
                    } else if (isClaudeModel) {
                        const claudeApiKey = config.get<string>('claudeApiKey') || '';
                        if (!claudeApiKey) {
                            task.logs.push('> [Error]: Claude API key not configured');
                            return;
                        }
                        const claudeClient = new ClaudeClient(claudeApiKey, modelId);
                        taskContext.claude = claudeClient;
                        session = claudeClient.startSession(systemPrompt, task.mode === 'planning' ? 'high' : 'low');
                    } else {
                        const geminiApiKey = config.get<string>('geminiApiKey') || '';
                        if (!geminiApiKey) {
                            task.logs.push('> [Error]: Gemini API key not configured');
                            return;
                        }
                        const geminiClient = new GeminiClient(geminiApiKey, modelId);
                        taskContext.gemini = geminiClient;
                        session = geminiClient.startSession(systemPrompt, 'high');
                    }
                    this.sessions.set(taskId, session);
                }

                if (session && worktreePath) {
                    // Ensure we have a search client
                    let searchClient = this.taskContexts.get(taskId)?.gemini;
                    if (!searchClient) {
                        // Attempt to create a fallback search client
                        const config = vscode.workspace.getConfiguration('vibearchitect');
                        const geminiApiKey = config.get<string>('geminiApiKey') || '';
                        if (geminiApiKey) { searchClient = new GeminiClient(geminiApiKey); }
                    }

                    // Derive task display name for terminal
                    const taskDisplayName = task.displayPrompt?.substring(0, 40) || 
                                            task.prompt.substring(0, 40) || 
                                            `Task-${taskId.substring(0, 8)}`;
                    
                    const tools = new AgentTools(
                        worktreePath,
                        terminalManager,
                        searchClient,
                        this.taskContexts.get(taskId)?.claude,
                        this.taskContexts.get(taskId)?.copilotClaude,
                        () => { this._onReloadBrowser.fire(); },
                        (url: string) => { this._onNavigateBrowser.fire(url); },
                        FileLockManager.getInstance(),
                        taskId,
                        // Login checkpoint callback - shows "I've Logged In" button in UI
                        (checkpointTaskId: string, loginUrl: string, ssoProvider?: string) => 
                            this.requestLoginCheckpoint(checkpointTaskId, loginUrl, ssoProvider),
                        taskDisplayName // Task name for terminal display
                    );
                    this.runExecutionLoop(taskId, session, tools);
                } else {
                    task.logs.push("Error: Cannot resume session. Worktree path missing.");
                    this._onTaskUpdate.fire({ taskId, task });
                }
            }
        }
    }

    // We need to handle the TYPE change of userMessages.
    // Let's look at the file content again to see `AgentTask` interface.

    public getTask(taskId: string): AgentTask | undefined {
        return this.tasks.get(taskId);
    }

    public async revertTask(taskId: string, checkpointId: string) {
        const task = this.tasks.get(taskId);
        if (!task) {
            console.error(`[TaskRunner] Revert failed: Task ${taskId} not found.`);
            return;
        }

        // Lazy init TaskContext if missing
        let taskContext = this.taskContexts.get(taskId);
        if (!taskContext) {
            if (task.worktreePath) {
                console.log(`[TaskRunner] Re-initializing Context for ${task.worktreePath}`);
                // Pass taskId for per-task isolation (parallel execution safe)
                const shadowRepo = new ShadowRepository(this.context, task.worktreePath, taskId);
                await shadowRepo.initialize(); // Must initialize for revert to work!
                const revertManager = new RevertManager(shadowRepo);
                
                // Create DiffAggregator for batched diff operations
                const diffAggregator = new DiffAggregator(
                    task.worktreePath,
                    taskId,
                    (filePath, beforeContent, afterContent) => {
                        if (!task.fileEdits) { task.fileEdits = []; }
                        task.fileEdits.push({
                            path: filePath,
                            beforeContent,
                            afterContent,
                            timestamp: Date.now()
                        });
                        if (!task.artifacts.includes(filePath)) {
                            task.artifacts.push(filePath);
                        }
                    }
                );
                
                const ruleEnforcer = createRuleEnforcer();
                taskContext = { shadowRepo, revertManager, diffAggregator, ruleEnforcer };
                this.taskContexts.set(taskId, taskContext);

            } else {
                console.error(`[TaskRunner] Revert failed: No worktree path for task ${taskId}`);
                return;
            }
        }

        task.logs.push(`\n> [System]: Reverting to checkpoint ${checkpointId.substring(0, 7)}...`);
        this._onTaskUpdate.fire({ taskId, task });

        try {
            const success = await taskContext.revertManager.revertToCheckpoint(checkpointId);

            if (success) {
                task.logs.push(`> [System]: Revert successful.`);

                // Truncate future checkpoints
                if (task.checkpoints) {
                    const idx = task.checkpoints.findIndex(c => c.id === checkpointId);
                    if (idx !== -1) {
                        task.checkpoints = task.checkpoints.slice(0, idx + 1);
                    }
                }
            } else {
                task.logs.push(`> [System]: Revert cancelled or failed.`);
            }
        } catch (err: any) {
            console.error(`[TaskRunner] Revert exception:`, err);
            task.logs.push(`> [System]: Error during revert: ${err.message}`);
        }

        this._onTaskUpdate.fire({ taskId, task });
    }

    public getFileEdit(taskId: string, filePath: string): FileEdit | undefined {
        const task = this.tasks.get(taskId);
        if (!task || !task.fileEdits) {
            return undefined;
        }
        // Find all edits for this path this path and return the most recent one
        const editsForPath = task.fileEdits.filter(e => e.path === filePath || e.path.endsWith(filePath) || filePath.endsWith(e.path));
        if (editsForPath.length === 0) {
            return undefined;
        }
        // Return the last (most recent) edit
        return editsForPath[editsForPath.length - 1];
    }

    /**
     * Build context string from previous task history for session restoration.
     * This helps the agent understand what was done before when resuming a session.
     * 
     * ENHANCED: Now includes AI responses, tool calls, and tool results for full context restoration.
     * This is critical for Copilot Claude models which start with fresh message history on resume.
     */
    private buildContextFromTask(task: AgentTask): string {
        const contextLines: string[] = [];
        
        // ========================================
        // CRITICAL: Filter out refinement-phase logs to prevent context bleeding
        // Only include logs AFTER the refinement end marker (if present)
        // ========================================
        const refinementEndMarker = '=== REFINEMENT PHASE COMPLETE - PRD APPROVED ===';
        const markerIndex = task.logs.findIndex(log => log.includes(refinementEndMarker));
        
        // If marker exists, only use logs after it for context building
        const relevantLogs = markerIndex >= 0 
            ? task.logs.slice(markerIndex + 1) 
            : task.logs;
        
        // Use a filtered copy of logs for the rest of this function
        const logsToProcess = relevantLogs.filter(log => {
            // Always skip refinement-specific logs that might have survived
            if (log.includes('[Refinement]') || 
                log.includes('**Analyst**') || 
                log.includes('**Critic**') ||
                log.includes('**Refiner**') ||
                log.includes('Refinement Mode')) {
                return false;
            }
            return true;
        });

        // Add artifacts (files created/modified)
        if (task.artifacts && task.artifacts.length > 0) {
            contextLines.push('## Files Created/Modified in This Mission:');
            for (const artifact of task.artifacts) {
                contextLines.push(`  - ${artifact}`);
            }
        }

        // Extract key write_file calls from logs
        const writeFileCalls: string[] = [];
        for (const log of logsToProcess) {
            if (log.includes('[Tool Call]:') && log.includes('write_file')) {
                // Extract path from write_file call
                const pathMatch = log.match(/["']path["']\s*:\s*["']([^"']+)["']/);
                if (pathMatch && !writeFileCalls.includes(pathMatch[1])) {
                    writeFileCalls.push(pathMatch[1]);
                }
            }
        }

        if (writeFileCalls.length > 0 && task.artifacts?.length === 0) {
            // Only add if not already covered by artifacts
            contextLines.push('## Files Written:');
            for (const filePath of writeFileCalls) {
                contextLines.push(`  - ${filePath}`);
            }
        }

        // ========================================
        // ENHANCED: Extract AI responses and tool execution history
        // This is critical for Copilot Claude context restoration
        // ========================================
        const conversationHistory: string[] = [];
        let lastToolCall = '';

        for (const log of logsToProcess) {
            // CRITICAL: Skip any logs containing mission complete or summary content
            // This prevents the AI from echoing back previous mission completions
            const logLower = log.toLowerCase();
            if (logLower.includes('mission complete') || 
                logLower.includes('mission summary') ||
                logLower.includes('verification results') ||
                logLower.includes('all features have been tested') ||
                logLower.includes('the mission is already complete') ||
                logLower.includes('the mission was already completed')) {
                continue; // Skip this log entry entirely
            }

            // Extract AI (Claude/Gemini) responses
            if (log.startsWith('**Claude**:') || log.startsWith('** Claude **:')) {
                const aiResponse = log.replace(/\*\*\s*Claude\s*\*\*:/g, '').trim();
                
                // CRITICAL: Skip mission completion responses
                if (aiResponse.toLowerCase().includes('mission complete') ||
                    aiResponse.toLowerCase().includes('verification results') ||
                    aiResponse.toLowerCase().includes('all tests passed')) {
                    continue;
                }
                
                // Truncate long responses to avoid token bloat
                const truncated = aiResponse.length > 500
                    ? aiResponse.substring(0, 500) + '... [truncated]'
                    : aiResponse;
                if (truncated.length > 10) { // Skip empty or tiny responses
                    conversationHistory.push(`[AI Response]: ${truncated}`);
                }
            } else if (log.startsWith('**Gemini**:') || log.startsWith('** Gemini **:')) {
                const aiResponse = log.replace(/\*\*\s*Gemini\s*\*\*:/g, '').trim();
                
                // CRITICAL: Skip mission completion responses
                if (aiResponse.toLowerCase().includes('mission complete') ||
                    aiResponse.toLowerCase().includes('verification results') ||
                    aiResponse.toLowerCase().includes('all tests passed')) {
                    continue;
                }
                
                const truncated = aiResponse.length > 500
                    ? aiResponse.substring(0, 500) + '... [truncated]'
                    : aiResponse;
                if (truncated.length > 10) {
                    conversationHistory.push(`[AI Response]: ${truncated}`);
                }
            }
            // Extract user messages - but SKIP refinement phase messages
            else if (log.startsWith('**User**:')) {
                const userMsg = log.replace('**User**:', '').trim();
                
                // CRITICAL: Skip user messages that appear to be from refinement phase
                // These can contain requirements/pointers that were NOT accepted into the PRD
                // and would confuse the agent with conflicting context
                const isRefinementPhaseMsg = 
                    userMsg.toLowerCase().includes('refinement') ||
                    userMsg.toLowerCase().includes('prd') ||
                    userMsg.toLowerCase().includes('requirement') ||
                    userMsg.toLowerCase().includes('clarif') ||
                    userMsg.toLowerCase().includes('approve') ||
                    userMsg.length > 500; // Long messages during refinement are usually requirement discussions
                    
                if (!isRefinementPhaseMsg) {
                    conversationHistory.push(`[User]: ${userMsg}`);
                }
            }
            // Extract tool calls (important for understanding what was attempted)
            else if (log.includes('[Tool Call]:')) {
                // Extract tool name and key args
                const toolMatch = log.match(/\[Tool Call\]:\s*(\w+)\s*\(/);
                if (toolMatch) {
                    lastToolCall = toolMatch[1];
                    // For file operations, extract the path
                    const pathMatch = log.match(/["']path["']\s*:\s*["']([^"']+)["']/);
                    if (pathMatch) {
                        conversationHistory.push(`[Tool: ${lastToolCall}] path: ${pathMatch[1]}`);
                    } else {
                        conversationHistory.push(`[Tool: ${lastToolCall}]`);
                    }
                }
            }
            // Extract tool results (important for understanding what succeeded/failed)
            else if (log.includes('[Result]:')) {
                const resultContent = log.replace(/>\s*\[Result\]:\s*/, '').trim();
                // Truncate long results
                const truncatedResult = resultContent.length > 200
                    ? resultContent.substring(0, 200) + '...'
                    : resultContent;
                // Only include meaningful results
                if (truncatedResult.length > 5 && !truncatedResult.includes('[object Object]')) {
                    conversationHistory.push(`[Result]: ${truncatedResult}`);
                }
            }
            // Capture errors (critical for understanding where it failed)
            else if (log.toLowerCase().includes('error') && log.includes(':')) {
                conversationHistory.push(`[Error]: ${log.substring(0, 300)}`);
            }
        }

        // Add conversation history with truncation to last N exchanges
        if (conversationHistory.length > 0) {
            contextLines.push('\n## Previous Conversation & Tool Execution History:');
            contextLines.push('(This is a summary of what happened before the session was interrupted)\n');

            // Keep last 30 entries to balance context vs token usage
            const recentHistory = conversationHistory.slice(-30);
            for (const entry of recentHistory) {
                contextLines.push(entry);
            }
        }

        // Add the original prompt reminder
        // CRITICAL: If this task has a PRD, emphasize it as the source of truth
        if (task.prompt.includes('## Approved Product Requirement Document (PRD)')) {
            contextLines.push(`\n## IMPORTANT: This mission has an APPROVED PRD`);
            contextLines.push(`The PRD in the task prompt is the ONLY source of truth for requirements.`);
            contextLines.push(`Do NOT use any other requirements or pointers from conversation history.`);
            contextLines.push(`If user's request conflicts with PRD, ask for clarification.`);
        }
        contextLines.push(`\n## Original Mission Prompt: "${task.prompt.substring(0, 500)}${task.prompt.length > 500 ? '...' : ''}"`);

        // Add current status
        if (task.status === 'failed') {
            contextLines.push(`\n## Status: FAILED - The mission encountered an error. Please analyze the history above and continue from where it stopped.`);
        } else if (task.status === 'completed') {
            contextLines.push(`\n## Status: COMPLETED - But user is asking for follow-up work.`);
        }

        return contextLines.join('\n');
    }

    /**
     * Detect if a user request is trivial (doesn't require planning).
     * Trivial requests include: basic questions, web searches, math, knowledge questions.
     * 
     * NOTE: Project exploration requests like "explain this project" are NOT trivial
     * because they may require reading code and the constitution should guide the agent.
     */
    private isTrivialRequest(message: string): boolean {
        const lowerMsg = message.toLowerCase().trim();

        // Short messages are often trivial
        if (lowerMsg.length < 30) {
            // Check for question patterns - but NOT if they involve reading code/project
            const questionPatterns = [
                /^what (is|are|was|were|did|does|do)\s+(the result|your status|a|an|the difference)/,
                /^how (do|does|did|can|could|would) (you|i|we) (calculate|compute)/,
                /^who (is|are|was|were) \w+\?$/,
                /^when (is|are|was|were|did)\s+\w+\s+(born|founded|created|started)/,
            ];
            if (questionPatterns.some(p => p.test(lowerMsg))) {
                return true;
            }
        }

        // Trivial keywords - but be more specific to avoid false positives
        const trivialKeywords = [
            'what did you do',
            'what have you done',
            'what was done',
            'search for',
            'search the web',
            'look up on the web',
            'calculate this',
            'compute this',
            'what is the result',
            'summarize what you did',
            'status update',
            'progress update',
        ];

        if (trivialKeywords.some(kw => lowerMsg.includes(kw))) {
            return true;
        }

        // Pure math expressions (no code needed)
        if (/^\d+[\s+\-*/()^\d.]+$/.test(lowerMsg.replace(/\s/g, ''))) {
            return true;
        }

        // Log for debugging
        console.log(`[TaskRunner] isTrivialRequest("${lowerMsg.substring(0, 50)}...") = false`);
        return false;
    }

    /**
     * Build mode-specific workflow instructions for the AI agent.
     * Used by both processTask() and replyToTask() for consistency.
     */
    private buildModeWorkflow(mode: 'planning' | 'fast' | 'refinement', isTrivial: boolean): string {
        // Trivial requests skip planning regardless of mode
        if (isTrivial) {
            return `
WORKFLOW (TRIVIAL REQUEST):
- This is a simple question/search/calculation. Answer directly without creating files.
- Do NOT create '.vibearchitect/task.md' or '.vibearchitect/implementation_plan.md' for this request.
- Use tools only if needed (e.g., search_web for research questions).
            `.trim();
        }

        if (mode === 'refinement') {
            // Refinement mode: defer to RefinementManager for multi-turn clarification
            return `
WORKFLOW (REFINEMENT MODE):
⚠️ REFINEMENT MODE ACTIVE - This request will go through requirements clarification.

The Refinement Mode uses a multi-agent loop to clarify requirements before coding:
1. ANALYST: Ask targeted questions to understand requirements
2. CRITIC: Review the draft PRD for completeness
3. REFINER: Produce a detailed specification

During this mode:
- You will ask clarifying questions about the user's requirements
- Focus on Entity Extraction, Attribute Verification, and Relationship Mapping
- Once requirements are clear, produce a PRD (Product Requirement Document)
- After PRD approval, transition to PLANNING mode for implementation

Do NOT write code in refinement mode. Focus only on requirements clarification.
            `.trim();
        }

        if (mode === 'fast') {
            return `
CORE WORKFLOW (FAST MODE):
1. ACT: Execute the request immediately.
2. NO PLANNING DOCS: Do NOT create '.vibearchitect/task.md' or '.vibearchitect/implementation_plan.md' unless explicitly asked.
3. EXPLORE (optional): Only if needed to locate files.

4. ⚠️ TEST & VERIFY (MANDATORY - CANNOT SKIP):
   
   **Environment Setup (if needed)**:
   - Check for .env requirements - ASK USER if env vars are needed but not set
   - Python: Use existing venv or create one, install requirements.txt
   - Node.js: Ensure node_modules exists, run npm install if needed
   
   **Run and Verify**:
   - Run the code or start the server using PROJECT'S actual start command
   - **Web Apps**: 
     a) Call 'reload_browser()' to refresh the preview
     b) Call 'browser_verify_ui("page-name", "description of expected UI")' for AI-powered verification
     c) If FAIL: Fix the issues and call browser_verify_ui AGAIN (SELF-HEALING)
     d) REPEAT until PASS or ask user for help after 3 attempts
   - Never say "verified" unless browser_verify_ui returned PASS
   
   ❌ **TESTING IS MANDATORY EVEN IN FAST MODE**

5. FINISH (ONLY WHEN 100% DONE AND TESTED):
   - Answer with "MISSION COMPLETE" at the end.

⚠️ CRITICAL - IGNORE MISSION SUMMARIES:
   - NEVER read 'mission_summary.md' - it means a PREVIOUS mission is done!
   - If you find mission_summary.md, IGNORE it and do your own work

⚠️ CRITICAL OUTPUT RULES:
   - Do NOT say "MISSION COMPLETE" or write summaries until ALL work is finished AND TESTED
   - Each response should focus on the current task only
            `.trim();
        }

        // PLANNING MODE (default for substantial requests)
        return `
CORE WORKFLOW (PLANNING MODE):
1. **CHECK FOR PRD** (Refinement Mode Output):
   - First, check if a PRD file exists. Try these locations IN ORDER:
     1. '.vibearchitect/prd.md' (primary backup location)
     2. '.vibearchitect/current/prd.md' (symlink location)
   - Use read_file to check each location until you find the PRD.
   - If a PRD exists, READ IT FIRST - this is the APPROVED specification from refinement mode.
   - You MUST implement the PRD requirements exactly as specified.
   - Your task.md and implementation_plan.md MUST implement the PRD requirements.
   - If no PRD exists in any location, proceed to EXPLORE.

1b. **CHECK FOR EXISTING PLAN** (Phased Implementation):
   - Check if '.vibearchitect/task.md' or '.vibearchitect/implementation_plan.md' exists.
   - If they exist: This is a PHASED IMPLEMENTATION in progress - READ and CONTINUE!
   - Look for "Phase X" markers and checkboxes to determine current progress.
   - Do NOT create new plans - continue the existing one.

⚠️ CRITICAL - IGNORE MISSION SUMMARIES ONLY:
   - NEVER read 'mission_summary.md' - it means a PREVIOUS mission is done, not yours!
   - If you find mission_summary.md, IGNORE it completely
   - However, DO use existing task.md and implementation_plan.md if present (phased work)

2. EXPLORE: Use list_files / read_file to understand the codebase.

3. PLAN (Mandatory):
   - Create '.vibearchitect/task.md' - a Markdown checklist of implementation steps.
   - If PRD exists: Derive steps DIRECTLY from the PRD's functional requirements and acceptance criteria.
   - Create '.vibearchitect/implementation_plan.md' - your technical approach.
   - If PRD exists: Your plan MUST reference and align with the PRD specifications.
   - ⚠️ MUST include a "Testing & Verification" section in implementation_plan.md

4. ACT: Use write_file / run_command to implement the plan.

5. UPDATE: After completing a step, OVERWRITE '.vibearchitect/task.md' to mark items done (e.g., "- [x] Step 1").

6. ⚠️ TEST & VERIFY (MANDATORY - CANNOT SKIP):
   
   📋 **STEP 6a: ENVIRONMENT SETUP (MUST DO FIRST)**
   - **Check for environment requirements**:
     a) Look for .env.example, .env.template, or README mentioning environment variables
     b) If environment variables are needed but .env doesn't exist:
        → ASK USER: "I found that this project needs environment variables: [list them]. Please create a .env file or tell me the values to use."
        → WAIT for user response before proceeding
     c) Check for requirements.txt (Python) or package.json (Node)
   
   - **Python Projects - venv setup (MANDATORY)**:
     a) Check if 'venv' or '.venv' folder exists
     b) If NOT exists: Create it with 'python -m venv venv'
     c) Install dependencies: 
        - Windows: 'venv\\Scripts\\pip install -r requirements.txt'
        - Unix: './venv/bin/pip install -r requirements.txt'
     d) ALWAYS run the app using venv python:
        - Windows: 'venv\\Scripts\\python app.py'
        - Unix: './venv/bin/python app.py'
   
   - **Node.js Projects - dependency setup (MANDATORY)**:
     a) Check if 'node_modules' exists
     b) If NOT exists: Run 'npm install'
     c) Use the project's actual start script from package.json

   📋 **STEP 6b: START THE APPLICATION**
   - **USE EXISTING INFRASTRUCTURE** - Do NOT create minimal test setups!
   - Look for EXISTING server scripts: package.json scripts, run.py, app.py, manage.py, etc.
   - If server already running: Call 'reload_browser()' to refresh
   - If server not running: Use the PROJECT'S actual start command
   - Check config files for the correct port
   
   📋 **STEP 6c: VERIFY WITH BROWSER (MANDATORY FOR WEB APPS)**
   - Call 'browser_verify_ui("page-name", "description of expected UI elements")'
   - This provides AI-powered visual verification
   - NEVER say "verified" unless browser_verify_ui returned PASS
   
   📋 **STEP 6d: SELF-HEALING LOOP (MANDATORY)**
   - If browser_verify_ui returns FAIL or finds issues:
     a) READ the specific issues reported
     b) FIX the code based on the issues
     c) Reload the browser
     d) Call browser_verify_ui AGAIN
     e) REPEAT until PASS or user intervention needed
   - This self-healing loop is CRITICAL - do not skip it!
   - If stuck after 3 attempts: ASK USER for guidance
   
   📋 **STEP 6e: VERIFY PRD CRITERIA (if PRD exists)**
   - Go through EACH acceptance criterion from the PRD
   - Test EACH one systematically
   - Document which criteria PASS and which FAIL
   - Fix any failures before proceeding

   ❌ **YOU CANNOT SAY "MISSION COMPLETE" WITHOUT COMPLETING STEP 6**
   ❌ **SKIPPING TESTING IS NOT ALLOWED - IT IS A REQUIRED STEP**

7. FINISH (ONLY WHEN 100% DONE AND TESTED):
   - Create ".vibearchitect/mission_summary.md".
   - Write a detailed summary including:
     a) Changes made
     b) TESTING RESULTS with browser_verify_ui outcomes
     c) If PRD was used: Checklist of which PRD requirements were verified
     d) Any issues found and fixed during self-healing
   - Answer with "MISSION COMPLETE" only after creating this file.

⚠️ CRITICAL OUTPUT RULES:
   - NEVER say "MISSION COMPLETE" until ALL tasks are finished AND TESTED
   - NEVER skip Step 6 (Testing) - it is MANDATORY
   - NEVER output "Mission Summary" or wrap-up text mid-work
   - Each response should describe current work, NOT summarize the whole mission
   - Summary and "MISSION COMPLETE" appear ONLY ONCE at the very end
        `.trim();
    }
}
