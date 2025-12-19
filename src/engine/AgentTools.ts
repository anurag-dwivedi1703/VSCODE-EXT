import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { TerminalManager } from './TerminalManager';
import { GeminiClient } from '../ai/GeminiClient';

export class AgentTools {
    constructor(
        private readonly worktreeRoot: string,
        private readonly terminalManager?: TerminalManager,
        private readonly geminiClient?: GeminiClient
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
            const uint8Array = new TextEncoder().encode(content);
            const parentDir = vscode.Uri.file(path.dirname(path.join(this.worktreeRoot, relativePath)));
            await vscode.workspace.fs.createDirectory(parentDir);

            await vscode.workspace.fs.writeFile(fileUri, uint8Array);
            return `Successfully wrote to ${relativePath}`;
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
