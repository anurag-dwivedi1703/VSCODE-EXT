import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { TerminalManager } from './TerminalManager';
import { GeminiClient } from '../ai/GeminiClient';
import { FileLockManager } from '../services/FileLockManager';

export class AgentTools {
    constructor(
        private readonly worktreeRoot: string,
        private readonly terminalManager?: TerminalManager,
        private readonly geminiClient?: GeminiClient,
        private readonly onReloadBrowserCallback?: () => void,
        private readonly onNavigateBrowserCallback?: (url: string) => void,
        private readonly fileLockManager?: FileLockManager,
        private readonly taskId?: string
    ) { }

    private getUri(relativePath: string): vscode.Uri {
        const fullPath = path.resolve(this.worktreeRoot, relativePath);
        if (!fullPath.startsWith(path.resolve(this.worktreeRoot))) {
            throw new Error(`Access Denied: Path '${relativePath}' traverses outside the workspace root.`);
        }
        return vscode.Uri.file(fullPath);
    }

    async readFile(relativePath: string): Promise<string> {
        try {
            const fileUri = this.getUri(relativePath);
            const uint8Array = await vscode.workspace.fs.readFile(fileUri);
            return new TextDecoder().decode(uint8Array);
        } catch (error: any) {
            return `Error reading file ${relativePath}: ${error.message}`;
        }
    }

    async writeFile(relativePath: string, content: string): Promise<string> {
        try {
            const fileUri = this.getUri(relativePath);
            const absolutePath = fileUri.fsPath;

            // Enforce Locking
            if (this.fileLockManager && this.taskId) {
                if (!this.fileLockManager.acquireLock(absolutePath, this.taskId)) {
                    return `Error: File ${relativePath} is currently locked by another agent. Please wait.`;
                }
            }

            try {
                const uint8Array = new TextEncoder().encode(content);
                const parentDir = vscode.Uri.file(path.dirname(path.join(this.worktreeRoot, relativePath)));
                await vscode.workspace.fs.createDirectory(parentDir);

                await vscode.workspace.fs.writeFile(fileUri, uint8Array);
                return `Successfully wrote to ${relativePath}`;
            } finally {
                // Always release lock
                if (this.fileLockManager && this.taskId) {
                    this.fileLockManager.releaseLock(absolutePath, this.taskId);
                }
            }
        } catch (error: any) {
            return `Error writing file ${relativePath}: ${error.message}`;
        }
    }

    async listFiles(relativePath: string): Promise<string> {
        try {
            const dirUri = this.getUri(relativePath);
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
            const formatted = entries.map(([name, type]) => {
                const typeName = type === vscode.FileType.Directory ? 'DIR' : 'FILE';
                return `${typeName}\t${name}`;
            }).join('\n');
            return formatted || '(Empty Directory)';
        } catch (error: any) {
            return `Error listing directory ${relativePath}: ${error.message}`;
        }
    }

    async searchWeb(query: string): Promise<string> {
        if (!this.geminiClient) {
            return "Error: Web Search (GeminiClient) not available in this context.";
        }
        return await this.geminiClient.research(query);
    }

    async reload_browser(): Promise<string> {
        // We need a way to signal the UI to reload. 
        // This tool instance doesn't have direct access to the TaskRunner's event emitter.
        // However, we can use vscode.commands to broadcast a signal? 
        // Or better, we can inject a callback or the event emitter into AgentTools.

        // LIMITATION: For this iteration, we will implement it by triggering a workspace command 
        // that the MissionControlProvider listens to, OR we simply return a message saying 
        // "Browser Reloaded (Visual Verification Required by User)".

        // Wait! The TaskRunner passes `this.onReloadBrowser` event... no, it doesn't pass it to AgentTools.
        // Let's check how AgentTools is instantiated. 

        // Ideally, AgentTools should emit an event. 
        // For now, let's just return a placeholder and we fix the wiring in TaskRunner.

        // EDIT: I will add a callback to the constructor for `onReloadBrowser`.
        if (this.onReloadBrowserCallback) {
            this.onReloadBrowserCallback();
            return "Browser Preview Reloaded. Please check the visual output.";
        }
        return "Browser Reload Triggered (Simulated).";
    }

    async navigate_browser(url: string): Promise<string> {
        if (this.onNavigateBrowserCallback) {
            this.onNavigateBrowserCallback(url);
            return `Browser navigated to ${url}. Please check the visual output.`;
        }
        return `Browser navigation to ${url} triggered (Simulated).`;
    }

    async runCommand(command: string): Promise<string> {
        return new Promise((resolve) => {
            // Basic safety check
            if (command.includes('rm -rf /') || command.includes('format c:')) {
                resolve('Error: Command blocked for safety reasons.');
                return;
            }

            // Show Terminal
            if (this.terminalManager) {
                this.terminalManager.show();
                this.terminalManager.print(`\x1b[36m> ${command}\x1b[0m\n`); // Cyan prompt
            }

            // Detect background execution request
            const isBackground = command.trim().endsWith('&');

            // Spawn Process
            const child = cp.spawn(command, {
                cwd: this.worktreeRoot,
                shell: true
            });

            // 1. TIMEOUT LOGIC
            // If not background, force resolve after 15 seconds to prevent hanging (e.g., interactive 'date' command)
            if (!isBackground) {
                setTimeout(() => {
                    if (!resolved) {
                        child.kill(); // Kill the stuck process
                        combinedOutput += "\n[System]: Command timed out after 15s. It may have been waiting for input.";
                        safeResolve(combinedOutput);
                    }
                }, 15000);
            }

            // 2. PREVENT INTERACTIVE HANGS
            // Immediately end stdin so commands waiting for input (like 'date') fail or exit instead of hanging
            child.stdin.end();

            let combinedOutput = '';
            let resolved = false;

            const safeResolve = (msg: string) => {
                if (!resolved) {
                    resolved = true;
                    resolve(msg);
                }
            };

            child.stdout.on('data', (data) => {
                const text = data.toString();
                combinedOutput += text;
                if (this.terminalManager) this.terminalManager.print(text);
            });

            child.stderr.on('data', (data) => {
                const text = data.toString();
                combinedOutput += text;
                if (this.terminalManager) this.terminalManager.print(`\x1b[31m${text}\x1b[0m`); // Red for error
            });

            child.on('close', (code) => {
                if (!resolved) {
                    if (code !== 0) {
                        combinedOutput += `\n(Process exited with code ${code})`;
                    }
                    safeResolve(combinedOutput || '(No Output)');
                }
            });

            child.on('error', (err) => {
                const errorMsg = `Error spawning process: ${err.message}`;
                combinedOutput += errorMsg;
                if (this.terminalManager) this.terminalManager.print(`\x1b[31m${errorMsg}\x1b[0m\n`);
                safeResolve(combinedOutput);
            });

            // If background, resolve early to prevent blocking
            if (isBackground) {
                setTimeout(() => {
                    child.unref();
                    safeResolve(`(Background Process Started) Output so far:\n${combinedOutput}`);
                }, 2000); // Wait 2s to catch immediate startup errors
            }
        });
    }

    private splitCommand(command: string): string[] {
        // Very basic splitter, shell: true handles the heavy lifting usually
        // But for spawn(cmd, args), usually we pass command string with shell:true
        // Logic above uses shell:true so 'command' as string is fine.
        return [command];
    }
}
