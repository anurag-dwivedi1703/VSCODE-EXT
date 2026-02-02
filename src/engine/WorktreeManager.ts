import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

const exec = util.promisify(cp.exec);

/**
 * Simple async mutex for serializing git operations.
 * Prevents race conditions when multiple tasks perform worktree operations.
 */
class AsyncMutex {
    private locked = false;
    private queue: Array<() => void> = [];

    async acquire(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.locked) {
                this.locked = true;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }

    release(): void {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) next();
        } else {
            this.locked = false;
        }
    }

    async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

/**
 * Manages git worktrees for parallel task execution.
 * Thread-safe: Uses operation queue to serialize git commands.
 */
export class WorktreeManager {
    // Shared mutex per workspace to prevent concurrent git worktree operations
    private static workspaceMutexes: Map<string, AsyncMutex> = new Map();
    private operationMutex: AsyncMutex;

    constructor(private readonly workspaceRoot: string) {
        // Get or create a mutex for this workspace
        let mutex = WorktreeManager.workspaceMutexes.get(workspaceRoot);
        if (!mutex) {
            mutex = new AsyncMutex();
            WorktreeManager.workspaceMutexes.set(workspaceRoot, mutex);
        }
        this.operationMutex = mutex;
    }

    /**
     * List all worktrees. Thread-safe.
     */
    async listWorktrees(): Promise<string[]> {
        return this.operationMutex.runExclusive(async () => {
            try {
                const { stdout } = await exec('git worktree list', { cwd: this.workspaceRoot });
                return stdout.split('\n').filter(line => line.trim() !== '');
            } catch (error) {
                console.error('Failed to list worktrees', error);
                return [];
            }
        });
    }

    /**
     * Create a new worktree. Thread-safe.
     */
    async createWorktree(branchName: string): Promise<string> {
        return this.operationMutex.runExclusive(async () => {
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
        });
    }

    /**
     * Remove a worktree. Thread-safe.
     */
    async removeWorktree(worktreePath: string): Promise<void> {
        return this.operationMutex.runExclusive(async () => {
            try {
                await exec(`git worktree remove "${worktreePath}" --force`, { cwd: this.workspaceRoot });
            } catch (error) {
                console.error('Failed to remove worktree', error);
                throw error;
            }
        });
    }

    /**
     * Clean up workspace mutex when no longer needed.
     */
    static cleanupWorkspace(workspaceRoot: string): void {
        WorktreeManager.workspaceMutexes.delete(workspaceRoot);
    }
}
