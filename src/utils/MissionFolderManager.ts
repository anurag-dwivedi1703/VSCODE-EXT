import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface MissionFolderConfig {
    retentionDays: number;      // Default: 7
    maxFolders: number;         // Default: 50 (safety limit)
    enableSymlink: boolean;     // Default: true
}

export interface CleanupResult {
    deleted: string[];
    kept: string[];
}

/**
 * Simple async mutex for serializing operations.
 * Prevents race conditions when multiple tasks access shared resources.
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
 * Manages chat-specific mission folders to prevent context bleeding
 * between missions in the same chat session.
 * 
 * Thread-safe: Uses mutex for symlink operations and tracks active folders
 * to prevent cleanup from deleting in-use folders.
 * 
 * Folder structure:
 * .vibearchitect/
 * ├── current -> ./2025-01-16_14-30-22_abc123/   (symlink to active)
 * ├── 2025-01-15_10-00-00_xyz789/
 * │   ├── task.md
 * │   ├── implementation_plan.md
 * │   └── mission_summary.md
 * └── 2025-01-16_14-30-22_abc123/                (current mission)
 */
export class MissionFolderManager {
    private workspaceRoot: string;
    private config: MissionFolderConfig;
    private symlinkMutex = new AsyncMutex();

    // Track active folders to prevent cleanup from deleting them
    private static activeFolders: Set<string> = new Set();

    constructor(workspaceRoot: string, config?: Partial<MissionFolderConfig>) {
        this.workspaceRoot = workspaceRoot;
        this.config = {
            retentionDays: config?.retentionDays ?? 7,
            maxFolders: config?.maxFolders ?? 50,
            enableSymlink: config?.enableSymlink ?? true
        };
    }

    /**
     * Mark a folder as active (in use by a task).
     * Active folders will not be deleted during cleanup.
     */
    public static markActive(folderPath: string): void {
        MissionFolderManager.activeFolders.add(folderPath);
    }

    /**
     * Mark a folder as inactive (task completed).
     */
    public static markInactive(folderPath: string): void {
        MissionFolderManager.activeFolders.delete(folderPath);
    }

    /**
     * Check if a folder is currently active.
     */
    public static isActive(folderPath: string): boolean {
        return MissionFolderManager.activeFolders.has(folderPath);
    }

    /**
     * Generate unique session/chat ID
     * Format: 8-character alphanumeric (hex)
     */
    public generateChatId(): string {
        return crypto.randomBytes(4).toString('hex');
    }

    /**
     * Create timestamped folder name
     * Format: YYYY-MM-DD_HH-mm-ss_chatId
     */
    public createFolderName(chatId: string): string {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');

        return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}_${chatId}`;
    }

    /**
     * Get the base .vibearchitect directory path
     */
    public getBaseDir(): string {
        return path.join(this.workspaceRoot, '.vibearchitect');
    }

    /**
     * Get or create mission folder for a chat session.
     * If a folder already exists for this chatId, returns it.
     * Otherwise, creates a new timestamped folder.
     * 
     * Thread-safe: Uses atomic mkdir with recursive: true.
     */
    public getMissionFolder(chatId: string): string {
        const baseDir = this.getBaseDir();

        // Atomic directory creation - ignores EEXIST, safe for concurrent calls
        try {
            fs.mkdirSync(baseDir, { recursive: true });
            // Ensure .vibearchitect is in .gitignore (fire-and-forget)
            this.ensureGitignoreExcludes('.vibearchitect/');
        } catch (error: any) {
            // Only throw if it's not an "already exists" error
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }

        // Check if folder already exists for this chatId
        try {
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            const existing = entries.find(entry =>
                entry.isDirectory() &&
                entry.name.endsWith(`_${chatId}`) &&
                /^\d{4}-\d{2}-\d{2}_/.test(entry.name)
            );

            if (existing) {
                const existingPath = path.join(baseDir, existing.name);
                // Mark as active and update symlink
                MissionFolderManager.markActive(existingPath);
                if (this.config.enableSymlink) {
                    this.updateCurrentSymlinkAsync(existingPath);
                }
                return existingPath;
            }
        } catch (error) {
            console.warn(`[MissionFolderManager] Error reading base dir: ${error}`);
        }

        // Create new folder - atomic with recursive: true
        const folderName = this.createFolderName(chatId);
        const folderPath = path.join(baseDir, folderName);

        try {
            fs.mkdirSync(folderPath, { recursive: true });
            console.log(`[MissionFolderManager] Created mission folder: ${folderName}`);

            // Mark as active
            MissionFolderManager.markActive(folderPath);

            // Update symlink (async, non-blocking)
            if (this.config.enableSymlink) {
                this.updateCurrentSymlinkAsync(folderPath);
            }
        } catch (error: any) {
            // If another task created it first, that's fine - use it
            if (error.code === 'EEXIST') {
                MissionFolderManager.markActive(folderPath);
                return folderPath;
            }
            console.error(`[MissionFolderManager] Failed to create folder: ${error}`);
            throw error;
        }

        return folderPath;
    }

    /**
     * Async wrapper for symlink update to avoid blocking.
     * Uses mutex to prevent concurrent symlink operations.
     */
    private updateCurrentSymlinkAsync(targetFolder: string): void {
        this.symlinkMutex.runExclusive(() => {
            this.updateCurrentSymlink(targetFolder);
        }).catch(err => {
            console.warn(`[MissionFolderManager] Async symlink update failed: ${err}`);
        });
    }

    /**
     * Update 'current' symlink/junction to point to active mission folder.
     * On Windows, uses junction (doesn't require admin privileges).
     * Falls back to a .current_folder text file if symlink fails.
     */
    public updateCurrentSymlink(targetFolder: string): void {
        const baseDir = this.getBaseDir();
        const symlinkPath = path.join(baseDir, 'current');

        try {
            // Remove existing symlink/junction if present
            if (fs.existsSync(symlinkPath)) {
                const stats = fs.lstatSync(symlinkPath);
                if (stats.isSymbolicLink() || stats.isDirectory()) {
                    // On Windows, junctions appear as directories
                    try {
                        fs.unlinkSync(symlinkPath);
                    } catch {
                        // If unlink fails, try rmdir for junctions
                        fs.rmdirSync(symlinkPath);
                    }
                }
            }

            // Create symlink (junction on Windows for directory)
            const isWindows = process.platform === 'win32';
            if (isWindows) {
                // Use junction for Windows (doesn't require admin)
                fs.symlinkSync(targetFolder, symlinkPath, 'junction');
            } else {
                // Use relative path for Unix symlinks
                const relativePath = path.relative(baseDir, targetFolder);
                fs.symlinkSync(relativePath, symlinkPath, 'dir');
            }

            console.log(`[MissionFolderManager] Updated 'current' symlink -> ${path.basename(targetFolder)}`);
        } catch (error) {
            console.warn(`[MissionFolderManager] Could not create symlink: ${error}`);
            // Fallback: write a .current_folder file with the path
            this.writeCurrentFolderFallback(targetFolder);
        }
    }

    /**
     * Fallback method: write current folder path to a text file
     */
    private writeCurrentFolderFallback(targetFolder: string): void {
        const baseDir = this.getBaseDir();
        const fallbackPath = path.join(baseDir, '.current_folder');

        try {
            fs.writeFileSync(fallbackPath, targetFolder, 'utf-8');
            console.log(`[MissionFolderManager] Created fallback .current_folder file`);
        } catch (error) {
            console.error(`[MissionFolderManager] Failed to write fallback file: ${error}`);
        }
    }

    /**
     * Get the current mission folder path (from symlink or fallback file)
     */
    public getCurrentMissionFolder(): string | null {
        const baseDir = this.getBaseDir();
        const symlinkPath = path.join(baseDir, 'current');
        const fallbackPath = path.join(baseDir, '.current_folder');

        // Try symlink first
        if (fs.existsSync(symlinkPath)) {
            try {
                const resolved = fs.realpathSync(symlinkPath);
                if (fs.existsSync(resolved)) {
                    return resolved;
                }
            } catch (error) {
                console.warn(`[MissionFolderManager] Could not resolve symlink: ${error}`);
            }
        }

        // Try fallback file
        if (fs.existsSync(fallbackPath)) {
            try {
                const folderPath = fs.readFileSync(fallbackPath, 'utf-8').trim();
                if (fs.existsSync(folderPath)) {
                    return folderPath;
                }
            } catch (error) {
                console.warn(`[MissionFolderManager] Could not read fallback file: ${error}`);
            }
        }

        return null;
    }

    /**
     * Clean up old mission folders based on retention policy.
     * Deletes folders older than retentionDays or exceeding maxFolders limit.
     */
    public cleanup(): CleanupResult {
        const baseDir = this.getBaseDir();
        const result: CleanupResult = { deleted: [], kept: [] };

        if (!fs.existsSync(baseDir)) {
            return result;
        }

        const now = Date.now();
        const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;

        // Get all mission folders (matching timestamp pattern)
        let folders: { name: string; path: string; timestamp: number }[];

        try {
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            folders = entries
                .filter(entry => {
                    // Match timestamp pattern: YYYY-MM-DD_HH-mm-ss_chatId
                    return entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/.test(entry.name);
                })
                .map(entry => ({
                    name: entry.name,
                    path: path.join(baseDir, entry.name),
                    timestamp: this.parseFolderTimestamp(entry.name)
                }))
                .sort((a, b) => b.timestamp - a.timestamp); // Newest first
        } catch (error) {
            console.error(`[MissionFolderManager] Error reading folders for cleanup: ${error}`);
            return result;
        }

        folders.forEach((folder, index) => {
            const age = now - folder.timestamp;
            const isExpired = age > retentionMs;
            const exceedsLimit = index >= this.config.maxFolders;

            // Skip folders that are currently in use by active tasks
            if (MissionFolderManager.isActive(folder.path)) {
                console.log(`[MissionFolderManager] Skipping active folder: ${folder.name}`);
                result.kept.push(folder.name);
                return;
            }

            if (isExpired || exceedsLimit) {
                try {
                    fs.rmSync(folder.path, { recursive: true, force: true });
                    result.deleted.push(folder.name);
                    console.log(`[MissionFolderManager] Deleted old folder: ${folder.name}`);
                } catch (error) {
                    console.warn(`[MissionFolderManager] Could not delete ${folder.name}: ${error}`);
                    result.kept.push(folder.name);
                }
            } else {
                result.kept.push(folder.name);
            }
        });

        return result;
    }

    /**
     * Parse timestamp from folder name.
     * Expected format: YYYY-MM-DD_HH-mm-ss_chatId
     */
    private parseFolderTimestamp(folderName: string): number {
        const match = folderName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
        if (match) {
            const [, year, month, day, hour, min, sec] = match;
            return new Date(
                parseInt(year),
                parseInt(month) - 1,
                parseInt(day),
                parseInt(hour),
                parseInt(min),
                parseInt(sec)
            ).getTime();
        }
        return 0;
    }

    /**
     * Get relative path from workspace to mission folder.
     * Useful for system prompts.
     */
    public getRelativeMissionPath(chatId: string): string {
        const folder = this.getMissionFolder(chatId);
        return path.relative(this.workspaceRoot, folder).replace(/\\/g, '/');
    }

    /**
     * List all mission folders with metadata
     */
    public listMissionFolders(): { name: string; path: string; timestamp: Date; chatId: string }[] {
        const baseDir = this.getBaseDir();

        if (!fs.existsSync(baseDir)) {
            return [];
        }

        try {
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            return entries
                .filter(entry =>
                    entry.isDirectory() &&
                    /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-f0-9]+$/.test(entry.name)
                )
                .map(entry => {
                    const chatIdMatch = entry.name.match(/_([a-f0-9]+)$/);
                    return {
                        name: entry.name,
                        path: path.join(baseDir, entry.name),
                        timestamp: new Date(this.parseFolderTimestamp(entry.name)),
                        chatId: chatIdMatch ? chatIdMatch[1] : 'unknown'
                    };
                })
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        } catch (error) {
            console.error(`[MissionFolderManager] Error listing folders: ${error}`);
            return [];
        }
    }

    /**
     * Ensure a pattern is in the workspace .gitignore
     * Fire-and-forget - errors are logged but don't affect folder creation
     */
    private ensureGitignoreExcludes(pattern: string): void {
        try {
            const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
            let content = '';

            if (fs.existsSync(gitignorePath)) {
                content = fs.readFileSync(gitignorePath, 'utf-8');
            }

            // Check if pattern already exists
            const lines = content.split('\n');
            const patternNoSlash = pattern.replace(/\/$/, '');
            if (lines.some(line => line.trim() === pattern || line.trim() === patternNoSlash)) {
                return; // Already excluded
            }

            // Add the pattern
            const newContent = content.trimEnd() + '\n' + pattern + '\n';
            fs.writeFileSync(gitignorePath, newContent, 'utf-8');
            console.log(`[MissionFolderManager] Added ${pattern} to .gitignore`);
        } catch (error) {
            console.warn(`[MissionFolderManager] Failed to update .gitignore: ${error}`);
        }
    }
}
