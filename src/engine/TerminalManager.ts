import * as vscode from 'vscode';

/**
 * Terminal instance data for a specific task
 */
interface TaskTerminal {
    terminal: vscode.Terminal;
    writeEmitter: vscode.EventEmitter<string>;
    closeEmitter: vscode.EventEmitter<void>;
    taskId: string;
    taskName: string;
    workspaceName: string;
    createdAt: number;
}

/**
 * TerminalManager - Manages multiple terminals for parallel agent execution.
 * 
 * Each task gets its own dedicated terminal to:
 * 1. Prevent output mixing between parallel agents
 * 2. Allow users to easily identify which terminal belongs to which task
 * 3. Enable reviewing command history per task
 * 
 * Terminal Naming: "🤖 [WorkspaceName] TaskName"
 * Access: Via VS Code's terminal dropdown or auto-focus on command execution
 */
export class TerminalManager {
    // Map of taskId -> TaskTerminal for multi-task support
    private taskTerminals: Map<string, TaskTerminal> = new Map();
    
    // Legacy single terminal for backward compatibility
    private legacyWriteEmitter = new vscode.EventEmitter<string>();
    private legacyCloseEmitter = new vscode.EventEmitter<void>();
    private legacyTerminal: vscode.Terminal | undefined;

    constructor() { }

    /**
     * Get or create a terminal for a specific task.
     * Each task gets its own isolated terminal.
     * 
     * @param taskId - Unique task identifier
     * @param taskName - Human-readable task name (truncated for display)
     * @param workspaceName - Workspace name for context
     */
    public getTerminalForTask(taskId: string, taskName: string, workspaceName: string): vscode.Terminal {
        let taskTerminal = this.taskTerminals.get(taskId);
        
        if (!taskTerminal) {
            // Create new terminal for this task
            const writeEmitter = new vscode.EventEmitter<string>();
            const closeEmitter = new vscode.EventEmitter<void>();
            
            // Truncate task name for display (max 30 chars)
            const displayName = taskName.length > 30 
                ? taskName.substring(0, 27) + '...' 
                : taskName;
            
            // Extract just the folder name from workspace path
            const workspaceShort = workspaceName.split(/[\\/]/).pop() || workspaceName;
            
            const terminalName = `🤖 [${workspaceShort}] ${displayName}`;
            
            const pty: vscode.Pseudoterminal = {
                onDidWrite: writeEmitter.event,
                onDidClose: closeEmitter.event,
                open: () => {
                    writeEmitter.fire(`\x1b[1;36m╔════════════════════════════════════════════════════════════╗\x1b[0m\r\n`);
                    writeEmitter.fire(`\x1b[1;36m║\x1b[0m  🤖 VibeArchitect Agent Terminal                            \x1b[1;36m║\x1b[0m\r\n`);
                    writeEmitter.fire(`\x1b[1;36m║\x1b[0m  Task: ${displayName.padEnd(50)} \x1b[1;36m║\x1b[0m\r\n`);
                    writeEmitter.fire(`\x1b[1;36m║\x1b[0m  Workspace: ${workspaceShort.padEnd(45)} \x1b[1;36m║\x1b[0m\r\n`);
                    writeEmitter.fire(`\x1b[1;36m╚════════════════════════════════════════════════════════════╝\x1b[0m\r\n\r\n`);
                },
                close: () => {
                    // Clean up when user closes terminal
                    this.taskTerminals.delete(taskId);
                },
                handleInput: (_data: string) => {
                    // Agent terminals are read-only for now
                }
            };
            
            const terminal = vscode.window.createTerminal({ name: terminalName, pty });
            
            taskTerminal = {
                terminal,
                writeEmitter,
                closeEmitter,
                taskId,
                taskName: displayName,
                workspaceName: workspaceShort,
                createdAt: Date.now()
            };
            
            this.taskTerminals.set(taskId, taskTerminal);
            console.log(`[TerminalManager] Created terminal for task ${taskId}: "${terminalName}"`);
        }
        
        return taskTerminal.terminal;
    }

    /**
     * Show (bring to front) the terminal for a specific task.
     * @param taskId - Task identifier
     * @param preserveFocus - If true, don't steal focus from editor (default: true)
     */
    public showForTask(taskId: string, preserveFocus: boolean = true) {
        const taskTerminal = this.taskTerminals.get(taskId);
        if (taskTerminal) {
            taskTerminal.terminal.show(preserveFocus);
        }
    }

    /**
     * Print output to a task-specific terminal.
     * @param taskId - Task identifier
     * @param data - Text to print
     */
    public printForTask(taskId: string, data: string) {
        const taskTerminal = this.taskTerminals.get(taskId);
        if (taskTerminal) {
            // Normalize line endings for terminal
            const normalized = data.replace(/\n/g, '\r\n');
            taskTerminal.writeEmitter.fire(normalized);
        }
    }

    /**
     * Print a separator/header for a new command in task terminal.
     * Helps users distinguish between different commands.
     */
    public printCommandHeader(taskId: string, command: string) {
        const taskTerminal = this.taskTerminals.get(taskId);
        if (taskTerminal) {
            const timestamp = new Date().toLocaleTimeString();
            taskTerminal.writeEmitter.fire(`\r\n\x1b[90m─────────────────────────────────────────────────────────────\x1b[0m\r\n`);
            taskTerminal.writeEmitter.fire(`\x1b[90m[${timestamp}]\x1b[0m \x1b[1;36m$\x1b[0m ${command}\r\n`);
            taskTerminal.writeEmitter.fire(`\x1b[90m─────────────────────────────────────────────────────────────\x1b[0m\r\n`);
        }
    }

    /**
     * Dispose terminal for a specific task.
     * Called when task completes or is cancelled.
     * 
     * @param taskId - Task identifier
     * @param immediate - If false, keeps terminal open for user review (default: false)
     */
    public disposeForTask(taskId: string, immediate: boolean = false) {
        const taskTerminal = this.taskTerminals.get(taskId);
        if (taskTerminal) {
            if (immediate) {
                taskTerminal.terminal.dispose();
                this.taskTerminals.delete(taskId);
                console.log(`[TerminalManager] Disposed terminal for task ${taskId}`);
            } else {
                // Print completion message but keep terminal open for review
                taskTerminal.writeEmitter.fire(`\r\n\x1b[1;32m╔════════════════════════════════════════════════════════════╗\x1b[0m\r\n`);
                taskTerminal.writeEmitter.fire(`\x1b[1;32m║\x1b[0m  ✅ Task Completed - Terminal kept for review              \x1b[1;32m║\x1b[0m\r\n`);
                taskTerminal.writeEmitter.fire(`\x1b[1;32m║\x1b[0m  Close this terminal manually when done reviewing.        \x1b[1;32m║\x1b[0m\r\n`);
                taskTerminal.writeEmitter.fire(`\x1b[1;32m╚════════════════════════════════════════════════════════════╝\x1b[0m\r\n`);
                // Don't delete from map - user can still view it
            }
        }
    }

    /**
     * Get list of all active task terminals.
     * Useful for UI display showing which agents have terminals.
     */
    public getActiveTerminals(): Array<{ taskId: string; taskName: string; workspaceName: string }> {
        return Array.from(this.taskTerminals.values()).map(t => ({
            taskId: t.taskId,
            taskName: t.taskName,
            workspaceName: t.workspaceName
        }));
    }

    /**
     * Focus a specific task's terminal (brings to front and steals focus).
     * Use when user explicitly wants to view terminal.
     */
    public focusTerminal(taskId: string) {
        const taskTerminal = this.taskTerminals.get(taskId);
        if (taskTerminal) {
            taskTerminal.terminal.show(false); // false = steal focus
        }
    }

    // ==================== LEGACY METHODS (Backward Compatibility) ====================
    // These maintain the old single-terminal API for any code not yet updated
    
    public getTerminal(): vscode.Terminal {
        if (!this.legacyTerminal) {
            const pty: vscode.Pseudoterminal = {
                onDidWrite: this.legacyWriteEmitter.event,
                onDidClose: this.legacyCloseEmitter.event,
                open: () => {
                    this.legacyWriteEmitter.fire('VibeArchitect Agent Terminal (Legacy)\r\n\r\n');
                },
                close: () => {
                    this.legacyTerminal = undefined;
                },
                handleInput: (_data: string) => { }
            };
            this.legacyTerminal = vscode.window.createTerminal({ name: 'VibeArchitect Agent', pty });
        }
        return this.legacyTerminal;
    }

    public show() {
        this.getTerminal().show(true);
    }

    public print(data: string) {
        const normalized = data.replace(/\n/g, '\r\n');
        this.legacyWriteEmitter.fire(normalized);
    }

    public dispose() {
        // Dispose legacy terminal
        if (this.legacyTerminal) {
            this.legacyTerminal.dispose();
            this.legacyTerminal = undefined;
        }
        
        // Dispose all task terminals
        for (const [taskId, taskTerminal] of this.taskTerminals) {
            taskTerminal.terminal.dispose();
        }
        this.taskTerminals.clear();
    }
}
