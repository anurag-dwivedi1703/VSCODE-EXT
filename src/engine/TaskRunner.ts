import * as vscode from 'vscode';
import { GeminiClient, ISession } from '../ai/GeminiClient';
import { Part } from '@google/generative-ai';
import { WorktreeManager } from './WorktreeManager';
import { AgentTools } from './AgentTools';
import { TerminalManager } from './TerminalManager';
const terminalManager = new TerminalManager(); // Singleton for the extension session? Or per task?
// For now, singleton is simpler to manage one visible terminal window.
import * as path from 'path';
import * as fs from 'fs';

interface AgentTask {
    id: string;
    prompt: string;
    status: 'pending' | 'planning' | 'executing' | 'completed' | 'failed';
    progress: number;
    logs: string[];
    worktreePath?: string;
    branchName?: string;
    userMessages: { text: string, attachments: string[] }[];
    artifacts: string[];
}

export class TaskRunner {
    private tasks: Map<string, AgentTask> = new Map();
    private sessions: Map<string, ISession> = new Map(); // Keep sessions alive
    private gemini: GeminiClient;
    private worktreeManager: WorktreeManager | undefined;
    private _onTaskUpdate = new vscode.EventEmitter<{ taskId: string, task: AgentTask }>();
    public readonly onTaskUpdate = this._onTaskUpdate.event;

    public getTasks(): AgentTask[] {
        return Array.from(this.tasks.values());
    }

    constructor(private context: vscode.ExtensionContext) {
        // Retrieve API Key from settings
        const config = vscode.workspace.getConfiguration('antigravity');
        const apiKey = config.get<string>('geminiApiKey') || '';
        this.gemini = new GeminiClient(apiKey);

        // Initialize WorktreeManager with the first workspace folder
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.worktreeManager = new WorktreeManager(vscode.workspace.workspaceFolders[0].uri.fsPath);
        }

        // Load tasks from disk
        this.loadTasks();
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

    private loadTasks() {
        try {
            const dir = this.storageDir;
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const content = fs.readFileSync(path.join(dir, file), 'utf-8');
                const task = JSON.parse(content) as AgentTask;
                this.tasks.set(task.id, task);

                // Fire update so UI knows about it (if UI is listening already)
                // Note: UI might not be ready yet in constructor, but MissionControlProvider pulls data on init anyway.
            }
        } catch (error) {
            console.error("Failed to load tasks:", error);
        }
    }

    public async startTask(prompt: string, worktreePath?: string): Promise<string> {
        const taskId = `agent-${Date.now()}`;
        const task: AgentTask = {
            id: taskId,
            prompt,
            status: 'pending',
            progress: 0,
            logs: [],
            userMessages: [],
            artifacts: [],
            worktreePath: worktreePath // Store it initially if provided
        };
        this.tasks.set(taskId, task);
        this.saveTask(task); // Persist initial state

        // Start processing in background
        this.processTask(taskId);

        return taskId;
    }

    private async processTask(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) return;

        try {
            this.updateStatus(taskId, 'planning', 5, 'Initializing Agent...');

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

            this.updateStatus(taskId, 'executing', 10, `Accessing Workspace: ${workspaceRoot}`);
            task.logs.push(`\n**Working Directory**: \`${workspaceRoot}\``);

            // We set a branch name just for reference or if we add git features later, 
            // but we don't switch branches automatically anymore to be safe? 
            // The user wanted "Directly work in the workspaces".
            // So we assume the user is on the branch they want.
            task.branchName = 'current-branch';

            // Step 2: Initialize Tools for this Workspace
            const tools = new AgentTools(workspaceRoot, terminalManager);

            // Step 3: Start Gemini Session
            this.updateStatus(taskId, 'planning', 20, 'Consulting Gemini...');
            const systemPrompt = `You are an expert software engineer connected to a real file system.
            You are working DIRECTLY in the user's workspace.
            
            Your Mission: ${task.prompt}
            
            Available Tools:
            - read_file(path): Read file content.
            - write_file(path, content): Write file content (auto-creates dirs).
            - list_files(path): List directory.
            - run_command(command): Execute shell command (git, npm, etc).
            
            CORE WORKFLOW (Follow strictly):
            1. EXPLORE: Use list_files/read_file to understand the codebase.
            2. PLAN (Mandatory for complex tasks):
               - Create a file named 'task.md'. This must be a Markdown checklist of steps (e.g., "- [ ] Step 1").
               - Create a file named 'implementation_plan.md'. This must detail your technical approach.
            3. ACT: Use write_file/run_command to implement the plan.
            4. UPDATE: After completing a step, OVERWRITE 'task.md' to mark the item as done (e.g., "- [x] Step 1").
            5. VERIFY: Run tests or checks.
            6. FINISH: Answer with "MISSION COMPLETE" when done.
            `;

            const chat = this.gemini.startSession(systemPrompt, 'high');
            this.sessions.set(taskId, chat);

            // Step 4: Start Execution Loop
            await this.runExecutionLoop(taskId, chat, tools);

        } catch (error: any) {
            this.updateStatus(taskId, 'failed', 0, `Error: ${error.message}`);
            vscode.window.showErrorMessage(`Agent Failed: ${error.message}`);
        }
    }

    private async runExecutionLoop(taskId: string, chat: ISession, tools: AgentTools) {
        const task = this.tasks.get(taskId);
        if (!task) return;

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
            const maxTurns = 15;
            for (let i = 0; i < maxTurns; i++) {
                // If the user interrupted or we are just continuing
                this.updateStatus(taskId, 'executing', task.progress, `Turn ${i + 1}: Thinking...`);

                // Check for user messages (High Priority)
                // Check for user messages (High Priority)
                if (task.userMessages.length > 0) {
                    const userMsgObj = task.userMessages.shift();
                    const userText = userMsgObj?.text || '';
                    const attachments = userMsgObj?.attachments || [];

                    task.logs.push(`\n**User**: ${userText}`);

                    // Build Multi-modal Prompt
                    const promptParts: Part[] = [];
                    promptParts.push({ text: `\n[USER REPLY]: ${userText}` });

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
                                        if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                                        if (ext === '.webp') mimeType = 'image/webp';

                                        promptParts.push({
                                            inlineData: {
                                                mimeType: mimeType,
                                                data: base64Data
                                            }
                                        });
                                        task.logs.push(`> [Attachment]: Added image ${path.basename(filePath)}`);
                                    } else {
                                        // Text file
                                        const textContent = fs.readFileSync(filePath, 'utf-8');
                                        promptParts.push({
                                            text: `\n\n--- FILE ATTACHMENT: ${path.basename(filePath)} ---\n${textContent}\n--- END ATTACHMENT ---`
                                        });
                                        task.logs.push(`> [Attachment]: Added text file ${path.basename(filePath)}`);
                                    }
                                }
                            } catch (e) {
                                task.logs.push(`> [Error]: Failed to read attachment ${filePath}`);
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

                const result = await chat.sendMessage(currentPrompt);
                const response = await result.response;
                const text = response.text();

                if (text) {
                    task.logs.push(`**Gemini**: ${text}`);
                    if (text.includes("MISSION COMPLETE")) {
                        // We do NOT return immediately, we break the loop to handle completion logic
                        // But if there are still user messages, we might want to continue?
                        // Simple logic: if mission complete, we stop unless the user says otherwise LATER.
                        break;
                    }
                }

                // Handle Tool Calls
                const functionCalls = response.functionCalls();
                if (functionCalls && functionCalls.length > 0) {
                    const toolParts: any[] = [];

                    for (const call of functionCalls) {
                        const fnName = call.name;
                        const args = call.args;
                        task.logs.push(`> [Tool Call]: ${fnName}(${JSON.stringify(args)})`);

                        let toolResult = '';
                        try {
                            switch (fnName) {
                                case 'read_file':
                                    toolResult = await tools.readFile(args.path as string);
                                    break;
                                case 'write_file':
                                    toolResult = await tools.writeFile(args.path as string, args.content as string);
                                    // Artifact Tracking
                                    if (args.path && !task.artifacts.includes(args.path)) {
                                        task.artifacts.push(args.path);
                                        task.logs.push(`[Artifact Created]: ${args.path}`);
                                    }
                                    break;
                                case 'list_files':
                                    toolResult = await tools.listFiles(args.path as string);
                                    break;
                                case 'run_command':
                                    toolResult = await tools.runCommand(args.command as string);
                                    break;
                                default:
                                    toolResult = `Error: Unknown tool ${fnName}`;
                            }
                        } catch (err: any) {
                            toolResult = `Error executing ${fnName}: ${err.message}`;
                        }

                        const preview = toolResult.length > 500 ? toolResult.substring(0, 500) + '... (truncated)' : toolResult;
                        task.logs.push(`> [Result]: ${preview}`);

                        toolParts.push({
                            functionResponse: {
                                name: fnName,
                                response: { content: toolResult }
                            }
                        });
                    }

                    currentPrompt = toolParts;
                    continue;

                } else {
                    if (!text.includes("MISSION COMPLETE")) {
                        // If the model provides a text response without tools, it's likely asking for input or explaining something.
                        // We should STOP the loop and wait for the user to reply.
                        currentPrompt = "Proceed."; // Default for next time, but we break now.
                        break;
                    } else {
                        break;
                    }
                }
            }

            this.updateStatus(taskId, 'completed', 100, 'Mission Complete');

            // Helpful message for the user - merge no longer needed, changes are live
            task.logs.push(`\n> [!IMPORTANT]\n> **Direct Execution**: Changes have been applied directly to \`${task.worktreePath}\`.\n> Please review your git status.`);

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
        }
    }

    public async replyToTask(taskId: string, message: string, attachments: string[] = []) {
        const task = this.tasks.get(taskId);
        if (task) {
            task.userMessages.push({ text: message, attachments });

            // Log with context notice
            const contextMsg = attachments.length > 0 ? ` (with ${attachments.length} attachments)` : '';
            this.updateStatus(taskId, task.status, task.progress, `User queued reply${contextMsg}: "${message}"`);

            // If completed, resume!
            if (task.status === 'completed') {
                const session = this.sessions.get(taskId);
                const worktreePath = task.worktreePath;
                if (session && worktreePath) {
                    const tools = new AgentTools(worktreePath, terminalManager);
                    this.runExecutionLoop(taskId, session, tools);
                } else {
                    task.logs.push("Error: Cannot resume session. Session expired or lost.");
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
}
