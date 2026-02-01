import * as vscode from 'vscode';
import { TaskRunner } from './engine/TaskRunner';
import { MissionControlProvider } from './panels/MissionControlProvider';
import { MissionFolderManager } from './utils/MissionFolderManager';
import { registerDependencyCommands } from './services/BrowserDependencyInstaller';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vibearchitect" is now active!');
    vscode.window.showInformationMessage('VibeArchitect Agent Manager Active! 🚀');

    // Run mission folder cleanup on activation
    cleanupOldMissionFolders();

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

/**
 * Clean up old mission folders based on retention policy.
 * Runs silently on extension activation.
 */
function cleanupOldMissionFolders() {
    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    const config = vscode.workspace.getConfiguration('vibearchitect');
    const retentionDays = config.get<number>('missionFolderRetentionDays') || 7;
    const maxFolders = config.get<number>('maxMissionFolders') || 50;
    const enableSymlink = config.get<boolean>('enableMissionFolderSymlink') ?? true;

    for (const folder of vscode.workspace.workspaceFolders) {
        try {
            const folderManager = new MissionFolderManager(folder.uri.fsPath, {
                retentionDays,
                maxFolders,
                enableSymlink
            });
            const result = folderManager.cleanup();
            
            if (result.deleted.length > 0) {
                console.log(`[VibeArchitect] Cleaned up ${result.deleted.length} old mission folder(s) in ${folder.name}`);
            }
        } catch (error) {
            console.warn(`[VibeArchitect] Could not cleanup mission folders in ${folder.name}:`, error);
        }
    }
}

export function deactivate() { }
