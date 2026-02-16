import * as vscode from 'vscode';
import { TaskRunner } from './engine/TaskRunner';
import { MissionControlProvider } from './panels/MissionControlProvider';
import { registerDependencyCommands } from './services/BrowserDependencyInstaller';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vibearchitect" is now active!');
    vscode.window.showInformationMessage('VibeArchitect Agent Manager Active! 🚀');

    const taskRunner = new TaskRunner(context);

    // Register main command
    const disposable = vscode.commands.registerCommand('vibearchitect.openMissionControl', () => {
        MissionControlProvider.createOrShow(context.extensionUri, taskRunner, context);
    });

    context.subscriptions.push(disposable);

    // Register browser automation dependency commands
    registerDependencyCommands(context);

    // Auto-open for demo purposes
    vscode.commands.executeCommand('vibearchitect.openMissionControl');
}

export function deactivate() { }
