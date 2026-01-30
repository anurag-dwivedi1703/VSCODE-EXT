import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

const exec = util.promisify(cp.exec);

export class WorktreeManager {
    constructor(private readonly workspaceRoot: string) { }

    async listWorktrees(): Promise<string[]> {
        try {
            const { stdout } = await exec('git worktree list', { cwd: this.workspaceRoot });
            return stdout.split('\n').filter(line => line.trim() !== '');
        } catch (error) {
            console.error('Failed to list worktrees', error);
            return [];
        }
    }

    async createWorktree(branchName: string): Promise<string> {
        const worktreePath = path.join(this.workspaceRoot, '..', `.antigravity-worktrees`, branchName);

        // Ensure parent dir exists
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

        try {
            // Get current branch name
            const { stdout: currentBranch } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: this.workspaceRoot });
            const baseBranch = currentBranch.trim();

            await exec(`git worktree add -b ${branchName} "${worktreePath}" ${baseBranch}`, { cwd: this.workspaceRoot });
            return worktreePath;
        } catch (error: any) {
            console.error('Failed to create worktree', error);

            if (error.message && (error.message.includes('ambiguous argument') || error.message.includes('unknown revision'))) {
                throw new Error("Your Git repository is empty (no commits). Antigravity needs at least one commit to create a worktree. Please run 'git commit' first.");
            }

            // Fallback: One last try with HEAD (detached mostly, but giving it a base)
            try {
                await exec(`git worktree add -b ${branchName} "${worktreePath}" HEAD`, { cwd: this.workspaceRoot });
                return worktreePath;
            } catch (inner) {
                // If this also fails, throw the original friendly error if applicable, or the inner one
                if (error.message && (error.message.includes('ambiguous argument') || error.message.includes('unknown revision'))) {
                    throw new Error("Your Git repository is empty (no commits). Antigravity needs at least one commit to create a worktree. Please run 'git commit' first.");
                }
                throw inner;
            }
        }
    }

    async removeWorktree(path: string): Promise<void> {
        try {
            await exec(`git worktree remove "${path}" --force`, { cwd: this.workspaceRoot });
        } catch (error) {
            console.error('Failed to remove worktree', error);
            throw error;
        }
    }
}
