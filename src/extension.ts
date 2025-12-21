import * as vscode from 'vscode';
import { TaskRunner } from './engine/TaskRunner';
import { MissionControlProvider } from './panels/MissionControlProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vibearchitect" is now active!');
    vscode.window.showInformationMessage('VibeArchitect Agent Manager Active! 🚀');

    const taskRunner = new TaskRunner(context);

    // Register command
    const disposable = vscode.commands.registerCommand('vibearchitect.openMissionControl', () => {
        MissionControlProvider.createOrShow(context.extensionUri, taskRunner, context);
    });

    context.subscriptions.push(disposable);

    // Auto-open for demo purposes
    vscode.commands.executeCommand('vibearchitect.openMissionControl');
}

export function deactivate() { }
