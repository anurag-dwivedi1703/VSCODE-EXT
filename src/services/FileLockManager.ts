// FileLockManager - manages file locks across agents

/**
 * Manages file locks to prevent concurrent write access by different agents.
 */
export class FileLockManager {
    private static instance: FileLockManager;
    private locks: Map<string, string> = new Map(); // path -> ownerId (taskId)

    private constructor() { }

    public static getInstance(): FileLockManager {
        if (!FileLockManager.instance) {
            FileLockManager.instance = new FileLockManager();
        }
        return FileLockManager.instance;
    }

    /**
     * Attempts to acquire a lock for the given file path.
     * @param path Absolute file path
     * @param ownerId ID of the agent requesting the lock
     * @returns true if lock acquired, false if already locked by someone else
     */
    public acquireLock(path: string, ownerId: string): boolean {
        const currentOwner = this.locks.get(path);

        if (currentOwner && currentOwner !== ownerId) {
            // Already locked by another agent
            return false;
        }

        // Lock it
        this.locks.set(path, ownerId);
        return true;
    }

    /**
     * Releases the lock for the given file path.
     * @param path Absolute file path
     * @param ownerId ID of the agent releasing the lock
     */
    public releaseLock(path: string, ownerId: string): void {
        const currentOwner = this.locks.get(path);
        if (currentOwner === ownerId) {
            this.locks.delete(path);
        }
    }

    /**
     * Checks if a file is locked by a specific owner.
     */
    public isLockedBy(path: string, ownerId: string): boolean {
        return this.locks.get(path) === ownerId;
    }

    /**
     * Force releases all locks for a specific owner (e.g. on task failure).
     */
    public releaseAll(ownerId: string): void {
        for (const [path, owner] of this.locks.entries()) {
            if (owner === ownerId) {
                this.locks.delete(path);
            }
        }
    }
}
