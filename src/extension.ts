import * as vscode from 'vscode';
import { TaskRunner } from './engine/TaskRunner';
import { MissionControlProvider } from './panels/MissionControlProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "antigravity-manager" is now active!');
    vscode.window.showInformationMessage('Antigravity Agent Manager Active! 🚀');

    const taskRunner = new TaskRunner(context);

    // Register command
    const disposable = vscode.commands.registerCommand('antigravity.openMissionControl', () => {
        MissionControlProvider.createOrShow(context.extensionUri, taskRunner);
    });

    context.subscriptions.push(disposable);

    // Auto-open for demo purposes
    vscode.commands.executeCommand('antigravity.openMissionControl');
}

export function deactivate() { }
