import * as vscode from 'vscode';

export class TerminalManager {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();
    private terminal: vscode.Terminal | undefined;

    constructor() { }

    public getTerminal(): vscode.Terminal {
        if (!this.terminal) {
            const pty: vscode.Pseudoterminal = {
                onDidWrite: this.writeEmitter.event,
                onDidClose: this.closeEmitter.event,
                open: () => {
                    this.writeEmitter.fire('VibeArchitect Agent Terminal Initialized\r\n\r\n');
                },
                close: () => {
                    this.terminal = undefined;
                },
                handleInput: (data: string) => {
                    // For now, we don't handle user input into the agent's shell
                    // But we could echo it if we wanted to simulate a real shell
                }
            };
            this.terminal = vscode.window.createTerminal({ name: 'VibeArchitect Agent', pty });
        }
        return this.terminal;
    }

    public show() {
        this.getTerminal().show(true); // true = preserve focus
    }

    public print(data: string) {
        // Normalize line endings for terminal
        const normalized = data.replace(/\n/g, '\r\n');
        this.writeEmitter.fire(normalized);
    }

    public dispose() {
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = undefined;
        }
    }
}
