// FileLockManager - manages file locks across agents with mutex protection

/**
 * Simple async mutex implementation for serializing lock operations.
 * Prevents race conditions when multiple tasks try to acquire/release locks simultaneously.
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

    /**
     * Execute a function with the mutex held.
     * Ensures exclusive access during the operation.
     */
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
 * Manages file locks to prevent concurrent write access by different agents.
 * 
 * Thread-safe: All lock operations are serialized via an async mutex to prevent
 * race conditions when multiple tasks attempt lock acquisition simultaneously.
 */
export class FileLockManager {
    private static instance: FileLockManager;
    private locks: Map<string, string> = new Map(); // path -> ownerId (taskId)
    private mutex = new AsyncMutex();

    private constructor() { }

    public static getInstance(): FileLockManager {
        if (!FileLockManager.instance) {
            FileLockManager.instance = new FileLockManager();
        }
        return FileLockManager.instance;
    }

    /**
     * Attempts to acquire a lock for the given file path.
     * Thread-safe: Uses mutex to prevent race conditions.
     * 
     * @param path Absolute file path
     * @param ownerId ID of the agent requesting the lock
     * @returns true if lock acquired, false if already locked by someone else
     */
    public async acquireLock(path: string, ownerId: string): Promise<boolean> {
        return this.mutex.runExclusive(() => {
            const currentOwner = this.locks.get(path);

            if (currentOwner && currentOwner !== ownerId) {
                // Already locked by another agent
                return false;
            }

            // Lock it - this is now atomic within the mutex
            this.locks.set(path, ownerId);
            return true;
        });
    }

    /**
     * Synchronous version for backward compatibility.
     * WARNING: Not thread-safe! Use acquireLock() for new code.
     * @deprecated Use acquireLock() instead for thread-safety
     */
    public acquireLockSync(path: string, ownerId: string): boolean {
        const currentOwner = this.locks.get(path);
        if (currentOwner && currentOwner !== ownerId) {
            return false;
        }
        this.locks.set(path, ownerId);
        return true;
    }

    /**
     * Releases the lock for the given file path.
     * Thread-safe: Uses mutex to prevent race conditions.
     * 
     * @param path Absolute file path
     * @param ownerId ID of the agent releasing the lock
     */
    public async releaseLock(path: string, ownerId: string): Promise<void> {
        return this.mutex.runExclusive(() => {
            const currentOwner = this.locks.get(path);
            if (currentOwner === ownerId) {
                this.locks.delete(path);
            }
        });
    }

    /**
     * Synchronous version for backward compatibility.
     * @deprecated Use releaseLock() instead for thread-safety
     */
    public releaseLockSync(path: string, ownerId: string): void {
        const currentOwner = this.locks.get(path);
        if (currentOwner === ownerId) {
            this.locks.delete(path);
        }
    }

    /**
     * Checks if a file is locked by a specific owner.
     * Note: This is a point-in-time check and may be stale by the time you act on it.
     */
    public isLockedBy(path: string, ownerId: string): boolean {
        return this.locks.get(path) === ownerId;
    }

    /**
     * Force releases all locks for a specific owner (e.g. on task failure).
     * Thread-safe: Uses mutex to prevent race conditions.
     * 
     * @param ownerId ID of the agent whose locks should be released
     */
    public async releaseAll(ownerId: string): Promise<void> {
        return this.mutex.runExclusive(() => {
            for (const [path, owner] of this.locks.entries()) {
                if (owner === ownerId) {
                    this.locks.delete(path);
                }
            }
        });
    }

    /**
     * Synchronous version for backward compatibility.
     * @deprecated Use releaseAll() instead for thread-safety
     */
    public releaseAllSync(ownerId: string): void {
        for (const [path, owner] of this.locks.entries()) {
            if (owner === ownerId) {
                this.locks.delete(path);
            }
        }
    }

    /**
     * Get count of active locks (for debugging/monitoring).
     */
    public getLockCount(): number {
        return this.locks.size;
    }

    /**
     * Get all locks for a specific owner (for debugging/monitoring).
     */
    public getLocksForOwner(ownerId: string): string[] {
        const result: string[] = [];
        for (const [path, owner] of this.locks.entries()) {
            if (owner === ownerId) {
                result.push(path);
            }
        }
        return result;
    }
}
