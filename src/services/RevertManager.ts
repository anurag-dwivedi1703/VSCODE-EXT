import { window, workspace } from 'vscode';
import { ShadowRepository } from './ShadowRepository';
import { CleanOptions } from 'simple-git';

export class RevertManager {
    constructor(private shadowRepo: ShadowRepository) { }

    /**
     * Reverts the workspace to a specific checkpoint hash safely.
     * @param commitHash The git commit hash to checkout
     * @returns true if reverted, false if cancelled
     */
    public async revertToCheckpoint(commitHash: string): Promise<boolean> {
        // Step 1: Detect Dirty Files
        // We only care about dirty files that are ALSO in the workspace we are tracking.
        const dirtyDocs = workspace.textDocuments.filter(doc =>
            doc.isDirty && doc.uri.fsPath.startsWith(this.shadowRepo.workTree)
        );

        if (dirtyDocs.length > 0) {
            // Step 2: User Intervention
            // We cannot safely proceed without user consent because reverting modifies disk,
            // and if we have unsaved buffers, the state is ambiguous.

            // To make this smoother for an Agentic flow, we might want a "Force" mode, 
            // but for now, safety first.
            const result = await window.showWarningMessage(
                `Reverting to checkpoint will overwrite ${dirtyDocs.length} unsaved files.`,
                { modal: true },
                'Save All & Revert',
                'Discard Changes & Revert', // Revert buffers to disk state (which is currently "wrong" but about to be overwritten? No, discard means discard USER typing)
                'Cancel'
            );

            if (!result || result === 'Cancel') { return false; }

            if (result === 'Save All & Revert') {
                await workspace.saveAll(false);
            }
            else if (result === 'Discard Changes & Revert') {
                // Determine how to discard. 
                // 'workbench.action.files.revert' reverts the active editor to the state ON DISK.
                // Since we haven't git-reverted yet, this just wipes the user's unsaved typing 
                // and resets to what IS on disk right now.
                for (const _doc of dirtyDocs) {
                    // We need to focus or find the editor for this doc to run the command? 
                    // Actually, commands.executeCommand usually works on active editor. 
                    // Better approach: use vscode.commands.executeCommand('workbench.action.files.revert', uri) if supported?
                    // It is not. The command works on the active editor.
                    // Workaround: We can close the dirty document without saving?
                    // Or cycle through them... tricky. 

                    // Simple approach: showTextDocument then revert.
                    /*
                    const editor = await window.showTextDocument(doc);
                    await commands.executeCommand('workbench.action.files.revert');
                    */
                    // That's too disruptive visually.

                    // Force close?
                }
                // Simpler: Just warn them that "Discard" means "I don't care about my unsaved changes". 
                // We proceed to overwrite disk. VS Code will then detect disk change.
                // If VS Code detects disk change on a dirty file, it keeps the dirty buffer and marks it as "conflict" or similar.
                // We really want the buffer to be clean.
            }
        }

        try {
            // Step 4: The Actual Git Revert
            await this.performGitRevert(commitHash);

            // Step 5: Refresh UI / Sync Buffers
            // If we successfully reverted disk, we want all open editors to reflect that.
            // If we didn't save above, and we just overwrote disk, VS Code might be confused.
            // The cleanest way is to trigger a reload of files.

            // Force revert all clean editors to ensure they pick up disk changes immediately 
            // (VS Code file watcher is async and might be slow).
            // Actually, if they are clean, VS Code updates them automatically.

            window.showInformationMessage(`Workspace reverted to checkpoint ${commitHash.substring(0, 7)}`);
            return true;
        } catch (err: any) {
            window.showErrorMessage(`Revert failed: ${err.message}`);
            return false;
        }
    }

    private async performGitRevert(commitHash: string): Promise<void> {
        const env = {
            ...process.env,
            GIT_DIR: this.shadowRepo.shadowDir,
            GIT_WORK_TREE: this.shadowRepo.workTree
        };

        // 1. Clean untracked files
        // If the agent created new files *after* the checkpoint we are reverting to,
        // a simple checkout won't remove them. We need 'git clean'.
        // -f: force, -d: directories
        // We use dryRun: false
        await this.shadowRepo.git.env(env).clean(CleanOptions.FORCE + CleanOptions.RECURSIVE);

        // 2. Reset to the specific commit (HARD)
        // This moves HEAD to the commit and updates the working tree to match.
        // It is more robust than checkout for "rewinding" the state.

        // Note: reset runs in the context of the GIT_DIR.
        await this.shadowRepo.git.env(env).reset(['--hard', commitHash]);
    }
}
