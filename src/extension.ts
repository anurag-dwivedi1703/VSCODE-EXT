import * as vscode from 'vscode';
import { TaskRunner } from './engine/TaskRunner';
import { MissionControlProvider } from './panels/MissionControlProvider';
import { registerDependencyCommands } from './services/BrowserDependencyInstaller';
import { logFeatureFlags } from './utils/FeatureFlags';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vibearchitect" is now active!');
    logFeatureFlags();

    // Log available VS Code LM tools for debugging
    try {
        const vsTools = vscode.lm.tools;
        console.log(`[VibeArchitect] VS Code LM tools available: ${vsTools.map(t => t.name).join(', ') || 'none'}`);
    } catch (e) {
        console.log('[VibeArchitect] vscode.lm.tools API not available');
    }

    vscode.window.showInformationMessage('VibeArchitect Agent Manager Active! 🚀');

    const taskRunner = new TaskRunner(context);

    // Register main command
    const disposable = vscode.commands.registerCommand('vibearchitect.openMissionControl', () => {
        MissionControlProvider.createOrShow(context.extensionUri, taskRunner, context);
    });

    context.subscriptions.push(disposable);

    // Register activity bar sidebar view — clicking the icon opens Mission Control in a new window
    const treeProvider: vscode.TreeDataProvider<string> = {
        getTreeItem: () => new vscode.TreeItem('Open Mission Control'),
        getChildren: () => []
    };
    const treeView = vscode.window.createTreeView('vibearchitect-missions', {
        treeDataProvider: treeProvider
    });
    treeView.onDidChangeVisibility(async (e) => {
        if (e.visible && !MissionControlProvider.currentPanel) {
            MissionControlProvider.createOrShow(context.extensionUri, taskRunner, context);
            setTimeout(async () => {
                try {
                    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
                } catch { /* Pre-1.85 VS Code — silently ignore */ }
            }, 200);
        }
    });
    context.subscriptions.push(treeView);

    // Register browser automation dependency commands
    registerDependencyCommands(context);

    // Auto-open for demo purposes
    vscode.commands.executeCommand('vibearchitect.openMissionControl');
}

export function deactivate() {
    // Clean up any workspace folders added by VibeArchitect
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (let i = folders.length - 1; i >= 0; i--) {
            if (folders[i].name.startsWith('[VA] ')) {
                vscode.workspace.updateWorkspaceFolders(i, 1);
            }
        }
    }
}
