import * as vscode from 'vscode';
import { GeminiClient, ISession } from '../ai/GeminiClient';
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
    userMessages: string[];
    artifacts: string[];
}

export class TaskRunner {
    private tasks: Map<string, AgentTask> = new Map();
    private sessions: Map<string, ISession> = new Map(); // Keep sessions alive
    private gemini: GeminiClient;
    private worktreeManager: WorktreeManager | undefined;
    private _onTaskUpdate = new vscode.EventEmitter<{ taskId: string, task: AgentTask }>();
    public readonly onTaskUpdate = this._onTaskUpdate.event;

    constructor(private context: vscode.ExtensionContext) {
        // Retrieve API Key from settings
        const config = vscode.workspace.getConfiguration('antigravity');
        const apiKey = config.get<string>('geminiApiKey') || '';
        this.gemini = new GeminiClient(apiKey);

        // Initialize WorktreeManager with the first workspace folder
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.worktreeManager = new WorktreeManager(vscode.workspace.workspaceFolders[0].uri.fsPath);
        }
    }

    public async startTask(prompt: string): Promise<string> {
        const taskId = `agent-${Date.now()}`;
        const task: AgentTask = {
            id: taskId,
            prompt,
            status: 'pending',
            progress: 0,
            logs: [],
            userMessages: [],
            artifacts: []
        };
        this.tasks.set(taskId, task);

        // Start processing in background
        this.processTask(taskId);

        return taskId;
    }

    private async processTask(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) return;

        try {
            this.updateStatus(taskId, 'planning', 5, 'Initializing Agent...');

            // Step 1: Use Active Workspace directly
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                throw new Error("No workspace open.");
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            task.worktreePath = workspaceRoot; // We reuse this property to mean "Current Working Directory"

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
                if (task.userMessages.length > 0) {
                    const userMsg = task.userMessages.shift();
                    task.logs.push(`\n**User**: ${userMsg}`);

                    if (typeof currentPrompt === 'string') {
                        currentPrompt += `\n\n[USER REPLY]: ${userMsg}`;
                    } else {
                        (currentPrompt as any[]).push({ text: `\n[USER REPLY]: ${userMsg}` });
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
            console.log(`[${taskId}] ${status}: ${log}`);
        }
    }

    public replyToTask(taskId: string, message: string) {
        const task = this.tasks.get(taskId);
        if (task) {
            task.userMessages.push(message);
            this.updateStatus(taskId, task.status, task.progress, `User queued reply: "${message}"`);

            // If completed, resume!
            if (task.status === 'completed') {
                const session = this.sessions.get(taskId);
                const worktreePath = task.worktreePath; // Should exist if completed successfully
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

    public getTask(taskId: string): AgentTask | undefined {
        return this.tasks.get(taskId);
    }
}
