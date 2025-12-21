import simpleGit, { SimpleGit, CleanOptions } from 'simple-git';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export class ShadowRepository {
    public git: SimpleGit;
    public shadowDir: string; // Where .git lives (Global Storage)
    public workTree: string;  // The User's Workspace

    /**
     * @param context Extension Context to access globalStorageUri
     * @param workspaceRoot The root of the user's workspace to track
     */
    constructor(context: vscode.ExtensionContext, workspaceRoot: string) {
        this.workTree = workspaceRoot;

        // Generate a stable hash for the workspace path to create a unique shadow ID
        const workspaceHash = crypto.createHash('sha256').update(this.workTree).digest('hex').substring(0, 12);
        this.shadowDir = path.join(context.globalStorageUri.fsPath, 'shadows', workspaceHash);

        // Initialize simple-git instance
        // We set baseDir to the workTree because we want git to see the files,
        // but we will override GIT_DIR environment variable to point to our shadow dir.
        this.git = simpleGit({
            baseDir: this.workTree,
            binary: 'git',
            maxConcurrentProcesses: 1, // Serial execution is safer for checkpoints
        });
    }

    /**
     * Initializes the shadow repository if it doesn't exist.
     * Uses --separate-git-dir to decouple the .git folder from the work tree.
     */
    public async initialize(): Promise<void> {
        // Ensure the shadow directory exists in global storage
        await fs.ensureDir(this.shadowDir);

        // Check if it's already a valid git repo
        const isRepo = await fs.pathExists(path.join(this.shadowDir, 'HEAD'));

        if (!isRepo) {
            console.log(`[ShadowRepo] Initializing new shadow repo at ${this.shadowDir}`);

            // git init --separate-git-dir <PATH>
            // Note: simple-git init() takes an array of args
            // We need to run this command carefully. 
            // The cleanest way with simple-git is to use distinct environment vars or just raw commands.

            // Actually, `git init --separate-git-dir` is meant to be run IN the worktree.
            // But we don't want to leave a .git file in the user's worktree if possible.
            // A better approach for "invisible" git is to just init a bare repo or init in the shadow dir
            // and ALWAYS use --work-tree.

            // Let's try: Init in shadowDir (bare: false), but we treat it as the git dir.
            // Wait, if we init in shadowDir, the worktree defaults to shadowDir. 
            // We want worktree to be user dir.

            // Command: git init --separate-git-dir=<SHADOW_DIR> <WORK_TREE> 
            // allows creating the linkage file.

            // To be 100% invisible (no .git file in user repo), we do this:
            // 1. mkdir shadowDir
            // 2. git --git-dir=shadowDir --work-tree=workTree init

            const env = {
                ...process.env,
                GIT_DIR: this.shadowDir,
                GIT_WORK_TREE: this.workTree
            };

            await this.git.env(env).init(false); // false = not bare, but since we set GIT_DIR/WORK_TREE it setup correctly

            // Configure exclusions immediately to preventing tracking .git or other ignored files
            await this.configureExclusions();

            // Create an initial commit
            await this.snapshot('Initial Workspace State');
        } else {
            // Just ensure exclusions are up to date
            await this.configureExclusions();
        }
    }

    private async configureExclusions(): Promise<void> {
        const excludePath = path.join(this.shadowDir, 'info', 'exclude');
        await fs.ensureFile(excludePath);

        // Mandatory ignores to prevent recursion and heavy files
        const mandatoryIgnores = [
            '.git',          // User's real git folder
            '.vscode',       // VS Code settings (optional, but arguably shouldn't be checkpointed if unstable)
            'node_modules',  // Dependencies - WAY too big
            'dist',          // Build artifacts
            'out',
            'build',
            '*.lock',        // Lock files change often, maybe skip? No, keep lock files.
            '*.log',
            '.DS_Store',
            'Thumbs.db',
            'bin',
            'obj'
        ];

        // We write these rules directly to the shadow repo's internal exclude file
        // unique set
        const existing = (await fs.readFile(excludePath, 'utf-8')).split('\n');
        const set = new Set([...existing, ...mandatoryIgnores]);
        const finalContent = Array.from(set).filter(l => l.trim().length > 0).join('\n');

        await fs.writeFile(excludePath, finalContent);
    }

    /**
     * Creates a checkpoint of the current workspace state.
     * @param message Description of the action (e.g., "Pre-Tool: write_file")
     * @returns The commit hash
     */
    public async snapshot(message: string): Promise<string> {
        try {
            const env = {
                ...process.env,
                GIT_DIR: this.shadowDir,
                GIT_WORK_TREE: this.workTree
            };

            // 1. Add all changes. 
            // -A: Update index for all files in the working tree (additions, modifications, deletions)
            // This is respecting our info/exclude file.
            await this.git.env(env).add(['-A', '.']);

            // 2. Commit
            // --allow-empty is crucial because sometimes the workspace hasn't changed, 
            // but we still want a marker in the timeline.
            const commitResult = await this.git.env(env).commit(message, ['--allow-empty']);

            console.log(`[ShadowRepo] Snapshot created: ${commitResult.commit} - ${message}`);
            return commitResult.commit;
        } catch (error: any) {
            console.error('Shadow Snapshot Failed:', error);
            // We do not want to crash the agent if checkpoint fails, but we should know.
            throw new Error(`Failed to create checkpoint: ${error.message}`);
        }
    }

    public async getHistory(): Promise<{ hash: string, message: string, date: string }[]> {
        try {
            const env = {
                ...process.env,
                GIT_DIR: this.shadowDir,
                GIT_WORK_TREE: this.workTree
            };
            const log = await this.git.env(env).log();
            return log.all.map(l => ({
                hash: l.hash,
                message: l.message,
                date: l.date
            }));
        } catch (e) {
            return [];
        }
    }
}
