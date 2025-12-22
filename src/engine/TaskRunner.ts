import * as vscode from 'vscode';
import { GeminiClient, ISession } from '../ai/GeminiClient';
import { ClaudeClient } from '../ai/ClaudeClient';
import { CopilotClaudeClient } from '../ai/CopilotClaudeClient';
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

interface TaskContext {
    shadowRepo: ShadowRepository;
    revertManager: RevertManager;
    gemini?: GeminiClient;
    claude?: ClaudeClient;
    copilotClaude?: CopilotClaudeClient;
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
    status: 'pending' | 'planning' | 'executing' | 'completed' | 'failed';
    progress: number;
    logs: string[];
    worktreePath?: string;
    branchName?: string;
    userMessages: { text: string, attachments: string[] }[];
    artifacts: string[];
    mode?: 'planning' | 'fast';
    model?: string;
    checkpoints?: { id: string, message: string, timestamp: number }[];
    fileEdits?: FileEdit[];
}

export class TaskRunner {
    private tasks: Map<string, AgentTask> = new Map();
    private sessions: Map<string, ISession> = new Map(); // Keep sessions alive
    private taskContexts: Map<string, TaskContext> = new Map(); // Isolated execution context per task
    private worktreeManager: WorktreeManager | undefined;
    private _onTaskUpdate = new vscode.EventEmitter<{ taskId: string, task: AgentTask }>();
    public readonly onTaskUpdate = this._onTaskUpdate.event;

    private _onReloadBrowser = new vscode.EventEmitter<void>();
    public readonly onReloadBrowser = this._onReloadBrowser.event;

    private _onNavigateBrowser = new vscode.EventEmitter<string>();
    public readonly onNavigateBrowser = this._onNavigateBrowser.event;

    public getTasks(): AgentTask[] {
        return Array.from(this.tasks.values());
    }

    constructor(private context: vscode.ExtensionContext) {
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

    public async startTask(prompt: string, worktreePath?: string, mode: 'planning' | 'fast' = 'planning', model: string = 'gemini-3-pro-preview'): Promise<string> {
        const taskId = `agent-${Date.now()}`;
        const task: AgentTask = {
            id: taskId,
            prompt,
            status: 'pending',
            progress: 0,
            logs: [],
            userMessages: [],
            artifacts: [],
            worktreePath: worktreePath, // Store it initially if provided
            mode,
            model
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

        let context = this.taskContexts.get(taskId);
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

    private async processTask(taskId: string) {
        const task = this.tasks.get(taskId);
        if (!task) return;

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
            const staleSummaryPath = path.join(workspaceRoot, 'mission_summary.md');
            if (fs.existsSync(staleSummaryPath)) {
                try {
                    fs.unlinkSync(staleSummaryPath);
                    console.log('[TaskRunner] Cleaned up stale mission_summary.md');
                } catch (err) {
                    console.warn('[TaskRunner] Could not clean up mission_summary.md:', err);
                }
            }

            this.updateStatus(taskId, 'executing', 10, `Accessing Workspace: ${workspaceRoot}`);
            task.logs.push(`\n**Working Directory**: \`${workspaceRoot}\``);

            // INITIALIZE SHADOW REPO (Isolated per task)
            const shadowRepo = new ShadowRepository(this.context, workspaceRoot);
            await shadowRepo.initialize();
            const revertManager = new RevertManager(shadowRepo);

            // Initialize Context
            const taskContext: TaskContext = {
                shadowRepo,
                revertManager
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

            // Step 2: Initialize Tools for this Workspace
            // Create AgentTools with everything needed
            // Note: We need a Gemini Client for the 'search_web' tool. 
            // We use the one from context if available, or create a temporary one?
            // Actually, we haven't assigned clients to context yet.

            // Let's instantiate the correct client FIRST.
            if (isClaudeModel) {
                if (useCopilotForClaude) {
                    task.logs.push(`> [System]: Using Claude via GitHub Copilot subscription`);
                    const copilotClient = new CopilotClaudeClient();
                    const initialized = await copilotClient.initialize();
                    if (!initialized) throw new Error('Failed to init Copilot Claude');
                    taskContext.copilotClaude = copilotClient;
                } else {
                    if (!claudeApiKey) throw new Error('Claude API Key missing');
                    taskContext.claude = new ClaudeClient(claudeApiKey, modelId);
                }
            } else {
                if (!geminiApiKey) throw new Error('Gemini API Key missing');
                taskContext.gemini = new GeminiClient(geminiApiKey, modelId);
            }

            // We default search tool to use Gemini if available, or fail if not?
            // If using Claude, we might not have Gemini client for search.
            // But we can create a separate Gemini client just for search if key exists?
            let searchClient: GeminiClient | undefined = taskContext.gemini;
            if (!searchClient && geminiApiKey) {
                searchClient = new GeminiClient(geminiApiKey); // dedicated for search
            }

            const tools = new AgentTools(
                workspaceRoot,
                terminalManager,
                searchClient,
                () => { this._onReloadBrowser.fire(); },
                (url: string) => { this._onNavigateBrowser.fire(url); },
                FileLockManager.getInstance(), // Inject Lock Manager
                taskId // Inject Task ID for locking
            );

            // Step 3: Start Gemini Session
            this.updateStatus(taskId, 'planning', 20, 'Consulting Gemini...');

            let systemPrompt = `You are an expert software engineer connected to a real file system.
            You are working DIRECTLY in the user's workspace.
            
            Your Mission: ${task.prompt}
            
            Available Tools:
            - read_file(path): Read file content.
            - write_file(path, content): Write file content (auto-creates dirs).
            - list_files(path): List directory.
            - run_command(command): Execute shell command (git, npm, etc).
            - reload_browser(): Reload the browser preview to verify changes. (Tool, NOT a shell command)
            - navigate_browser(url): Navigate the browser preview to a specific URL (e.g., 'http://localhost:8080').
            - search_web(query): Search the web for documentation, solutions, or new concepts.
            
            Browser Automation Tools (for automated testing):
            - browser_launch(recordVideo?): Launch Chrome for automated testing. Set recordVideo=true to record session.
            - browser_navigate(url): Navigate the automated browser to a URL and wait for page load.
            - browser_screenshot(name?): Take a screenshot of the current page.
            - browser_click(selector): Click on an element using CSS selector.
            - browser_type(selector, text): Type text into an input field.
            - browser_wait_for(selector, timeout?): Wait for an element to appear.
            - browser_get_dom(): Get the current page's HTML content for analysis.
            - browser_verify_ui(category, description): Take screenshot and verify UI against expectations.
            - browser_close(): Close the browser and stop recording.

            CRITICAL RULES:
            1. **VERIFY EVERYTHING**: Never assume code works. Run it.
               - If it's a script, run it.
               - If it's a web app, start the server and use 'reload_browser()' to show it to the user.
               - **AUTOMATED TESTING**: For UI verification, use browser_launch(true) to record, then browser_verify_ui() to check.
               - **IMPORTANT**: If a server is already running on a port (e.g. 3000), you must KILL it first or use a different port.
            2. **SELF-HEALING**: If browser_verify_ui() finds issues, analyze the screenshot and fix the code, then verify again.
            3. **COMMUNICATE**: Do not just say "Done". Explain what you did.
            4. **CLEAN UP**: Stop any background processes you started if they are verified (unless it's a server meant to stay running).
            5. **PYTHON RULES**:
               - NEVER install globally.
               - Create a venv: 'python -m venv venv'.
               - Install packages using the venv executable: 'venv/Scripts/pip install ...' (Windows) or 'venv/bin/pip ...' (Mac/Linux).
               - Run scripts using the venv executable: 'venv/Scripts/python app.py' (Windows) or 'venv/bin/python app.py' (Mac/Linux).
            6. **REASONING**: Before calling ANY tool, you MUST explain your plan in 1-2 sentences. This will be displayed to the user as your "Thought".
            `;


            if (task.mode === 'planning') {
                systemPrompt += `
            CORE WORKFLOW(PLANNING MODE):
            1. EXPLORE: Use list_files / read_file to understand the codebase.
            2. PLAN(Mandatory):
            - Create a file named 'task.md'.This must be a Markdown checklist of steps(e.g., "- [ ] Step 1").
                - Create a file named 'implementation_plan.md'.This must detail your technical approach.
            3. ACT: Use write_file / run_command to implement the plan.
            4. UPDATE: After completing a step, OVERWRITE 'task.md' to mark the item as done (e.g., "- [x] Step 1").
            5. VERIFY(MANDATORY):
            - Run tests or verification scripts.
                - ** Web Apps **: You MUST start the server(e.g. 'npm run dev') and call 'reload_browser()' to refresh the internal preview.
                - ** Check Ports **: Ensure you are viewing the correct port.If the preview shows old content, the old server might still be running.Kill it.
                - Confirm the output is correct.
                - If verification fails, FIX IT before marking as complete.
            6. FINISH:
            - You MUST create a file named "mission_summary.md" in the root.
            - Write a detailed summary of changes and verification instructions in it.
            - Answer with "MISSION COMPLETE" only after creating this file.
            `;
            } else {
                // FAST MODE
                systemPrompt += `
            CORE WORKFLOW(FAST MODE):
            1. ACT: Execute the request immediately.
            2. NO PLANNING DOCS: Do NOT create 'task.md' or 'implementation_plan.md' unless explicitly asked.
            3. EXPLORE(optional): Only if needed to locate files.
            4. VERIFY(MANDATORY):
            - Run the code or start the server.
                - ** Web Apps **: Call 'reload_browser()' to refresh the preview.
            5. FINISH:
                - Answer with "MISSION COMPLETE" at the end.
            `;
            }

            // Start session with selected model
            let chat: ISession;
            if (isClaudeModel && useCopilotForClaude && taskContext.copilotClaude) {
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

        } catch (error: any) {
            this.updateStatus(taskId, 'failed', 0, `Error: ${error.message} `);
            vscode.window.showErrorMessage(`Agent Failed: ${error.message} `);
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
            const maxTurns = 30;
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
                                        if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                                        if (ext === '.webp') mimeType = 'image/webp';

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
                        if (!claudeApiKey) throw new Error('Claude API key not configured');
                        const claudeClient = new ClaudeClient(claudeApiKey, modelId);
                        if (this.taskContexts.has(taskId)) {
                            this.taskContexts.get(taskId)!.claude = claudeClient;
                        }
                        activeChat = claudeClient.startSession(continuationPrompt, task.mode === 'planning' ? 'high' : 'low');
                    } else {
                        const geminiApiKey = config.get<string>('geminiApiKey') || '';
                        if (!geminiApiKey) throw new Error('Gemini API key not configured');
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
                        task.logs.push(`> [Tool Call]: ${fnName} (${JSON.stringify(args)})`);

                        let toolResult = '';
                        try {
                            // CHECKPOINT BEFORE ACTION
                            const taskContext = this.taskContexts.get(taskId);
                            if (taskContext && taskContext.shadowRepo) {
                                // Only checkpoint for state-changing tools
                                if (['write_file', 'run_command'].includes(fnName)) {
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
                                case 'read_file':
                                    toolResult = await tools.readFile(args.path as string);
                                    break;
                                case 'write_file':
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
                                    break;
                                case 'list_files':
                                    toolResult = await tools.listFiles(args.path as string);
                                    break;
                                case 'run_command':
                                    const cmd = (args.command as string || '').trim();
                                    // Aggressive check: if command mentions 'reload_browser', just do it.
                                    if (cmd.toLowerCase().includes('reload_browser')) {
                                        this._onReloadBrowser.fire();
                                        toolResult = "Browser reload triggered (via auto-correction).";
                                    } else {
                                        toolResult = await tools.runCommand(cmd);
                                    }
                                    break;
                                case 'reload_browser':
                                    this._onReloadBrowser.fire();
                                    toolResult = "Browser reload triggered.";
                                    break;
                                case 'navigate_browser':
                                    const navUrl = args.url as string || 'http://localhost:3000';
                                    this._onNavigateBrowser.fire(navUrl);
                                    toolResult = `Browser navigated to ${navUrl}.`;
                                    break;
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
                                    toolResult = await tools.browserVerifyUI(args.category as string, args.description as string);
                                    // Check if verification detected issues for self-healing
                                    if (toolResult.includes('Issues detected:') || toolResult.includes('Match: NO')) {
                                        task.logs.push(`> [UI Verification]: Visual issues detected. Agent may attempt self-healing.`);
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
                    const summaryPath = path.join(task.worktreePath, 'mission_summary.md');
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
                        const log = task.logs[j].replace(/\*\*Gemini\*\*:/g, '').replace(/\*\* Gemini \*\*:/g, '');
                        const match = log.match(outputRegex);
                        if (match && match[1] && match[1].trim().length > 10) {
                            summaryText = match[1].trim();
                            break;
                        }
                    }
                }

                if (summaryText) {
                    console.log(`[TaskRunner] Emitting Mission Summary Log.`);
                    task.logs.push(`[MISSION_COMPLETE_SUMMARY]: ${summaryText}`);
                    // CRITICAL: Notify UI of the new log entry
                    this._onTaskUpdate.fire({ taskId, task });
                    this.saveTask(task);
                }
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
        }
    }

    public async replyToTask(taskId: string, message: string, attachments: string[] = []) {
        const task = this.tasks.get(taskId);
        if (task) {
            task.userMessages.push({ text: message, attachments });

            // Log with context notice
            const contextMsg = attachments.length > 0 ? ` (with ${attachments.length} attachments)` : '';
            this.updateStatus(taskId, task.status, task.progress, `**User**: ${message}${contextMsg}`);

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

                    const systemPrompt = `You are resuming a previous mission.
                    Your Mission: ${task.prompt}
                    
                    IMPORTANT - PREVIOUS CONTEXT (what was done before):
                    ${previousContext}
                    
                    The user has provided feedback or new instructions.
                    CRITICAL: If the user refers to "the file" or "this file", they mean the files listed above in PREVIOUS CONTEXT.
                    Use your tools to explore the current state of the code if needed.
                    
                    Available Tools:
                    - read_file(path): Read file content.
                    - write_file(path, content): Write file content (auto-creates dirs).
                    - list_files(path): List directory.
                    - run_command(command): Execute shell command (git, npm, etc).
                    - reload_browser(): Reload the browser preview to verify changes. (Tool, NOT a shell command)
                    - navigate_browser(url): Navigate the browser preview to a specific URL (e.g., 'http://localhost:8080').
                    - search_web(query): Search the web for documentation, solutions, or new concepts.

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
                        // Create basic context (ShadowRepo needed for tools)
                        const shadowRepo = new ShadowRepository(this.context, worktreePath);
                        // We assume it was initialized before if task exists
                        const revertManager = new RevertManager(shadowRepo);
                        taskContext = { shadowRepo, revertManager };
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
                        if (geminiApiKey) searchClient = new GeminiClient(geminiApiKey);
                    }

                    const tools = new AgentTools(
                        worktreePath,
                        terminalManager,
                        searchClient,
                        () => { this._onReloadBrowser.fire(); },
                        (url: string) => { this._onNavigateBrowser.fire(url); },
                        FileLockManager.getInstance(),
                        taskId
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
                const shadowRepo = new ShadowRepository(this.context, task.worktreePath);
                // We assume it was already init'd before
                const revertManager = new RevertManager(shadowRepo);
                taskContext = { shadowRepo, revertManager };
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
     */
    private buildContextFromTask(task: AgentTask): string {
        const contextLines: string[] = [];

        // Add artifacts (files created/modified)
        if (task.artifacts && task.artifacts.length > 0) {
            contextLines.push('Files created/modified in this mission:');
            for (const artifact of task.artifacts) {
                contextLines.push(`  - ${artifact}`);
            }
        }

        // Extract key write_file calls from logs
        const writeFileCalls: string[] = [];
        for (const log of task.logs) {
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
            contextLines.push('Files written:');
            for (const filePath of writeFileCalls) {
                contextLines.push(`  - ${filePath}`);
            }
        }

        // Add user messages for conversation context
        const userMessages: string[] = [];
        for (const log of task.logs) {
            if (log.startsWith('**User**:')) {
                userMessages.push(log.replace('**User**:', 'User said:'));
            }
        }
        if (userMessages.length > 0) {
            contextLines.push('\nPrevious conversation:');
            // Only include last 5 user messages to avoid token bloat
            for (const msg of userMessages.slice(-5)) {
                contextLines.push(`  ${msg}`);
            }
        }

        // Add the original prompt reminder
        contextLines.push(`\nOriginal task was: "${task.prompt}"`);

        return contextLines.join('\n');
    }
}
