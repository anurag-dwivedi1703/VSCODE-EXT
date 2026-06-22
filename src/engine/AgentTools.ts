import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { TerminalManager } from './TerminalManager';
import { GeminiClient } from '../ai/GeminiClient';
import { ClaudeClient } from '../ai/ClaudeClient';
import { CopilotClaudeClient } from '../ai/CopilotClaudeClient';
import { CopilotGPTClient } from '../ai/CopilotGPTClient';
import { CopilotGeminiClient } from '../ai/CopilotGeminiClient';
import { FileLockManager } from '../services/FileLockManager';
import { BrowserAutomationService, LoginCheckpointCallback } from '../services/BrowserAutomationService';
import { VisualComparisonService } from '../services/VisualComparisonService';
import { detectSecrets, detectPII } from '../ai/SecurityInstructions';
import { parseSearchReplaceBlocks, DiffLogContext } from '../utils/SearchReplaceParser';
import { DiffLogger, findBestMatch } from '../utils/DiffLogger';
import { getIDEDiffApplier } from '../utils/IDEDiffApplier';
import { getSymbolNavigator } from '../utils/SymbolNavigator';
import { RuleEnforcer } from '../services/RuleEnforcer';
import { FileSearch } from '../utils/FileSearch';
import { FileDiscovery } from '../utils/FileDiscovery';

export class AgentTools {
    private browserService: BrowserAutomationService | null = null;
    private visualService: VisualComparisonService | null = null;
    private readonly taskName: string;
    private readonly workspaceName: string;

    constructor(
        private readonly worktreeRoot: string,
        private readonly terminalManager?: TerminalManager,
        private readonly geminiClient?: GeminiClient,
        private readonly claudeClient?: ClaudeClient,
        private readonly copilotClaudeClient?: CopilotClaudeClient | CopilotGPTClient | CopilotGeminiClient,
        private readonly onReloadBrowserCallback?: () => void,
        private readonly onNavigateBrowserCallback?: (url: string) => void,
        private readonly fileLockManager?: FileLockManager,
        private readonly taskId?: string,
        private readonly loginCheckpointCallback?: LoginCheckpointCallback,
        taskName?: string,
        private readonly agentMode: 'auto' | 'review-enabled' = 'auto',
        private readonly ruleEnforcer?: RuleEnforcer,
        private readonly missionFolder?: string  // Mission-scoped artifact subfolder
    ) {
        // Derive workspace name from path
        this.workspaceName = worktreeRoot.split(/[\\/]/).pop() || worktreeRoot;
        // Use provided task name or default
        this.taskName = taskName || `Task-${taskId?.substring(0, 8) || 'unknown'}`;

        // Initialize browser automation services if taskId is available
        if (this.taskId) {
            this.browserService = new BrowserAutomationService(this.taskId, this.worktreeRoot);
            this.visualService = new VisualComparisonService(this.worktreeRoot, this.taskId);

            // Set login checkpoint callback if provided
            if (this.loginCheckpointCallback) {
                this.browserService.setLoginCheckpointCallback(this.loginCheckpointCallback);
            }
        }

        // Initialize task-specific terminal if taskId provided
        if (this.taskId && this.terminalManager) {
            this.terminalManager.getTerminalForTask(this.taskId, this.taskName, this.workspaceName);
        }

        if (this.missionFolder) {
            console.log(`[AgentTools] Mission folder routing active: ${this.missionFolder}`);
        }
    }


    private getUri(relativePath: string): vscode.Uri {
        const fullPath = path.resolve(this.worktreeRoot, relativePath);
        if (!fullPath.startsWith(path.resolve(this.worktreeRoot))) {
            throw new Error(`Access Denied: Path '${relativePath}' traverses outside the workspace root.`);
        }
        return vscode.Uri.file(fullPath);
    }

    /**
     * Transparently reroute .vibearchitect artifact paths to mission-scoped subfolder.
     * AI writes to '.vibearchitect/task.md' but this resolves to '.vibearchitect/missions/<taskId>/task.md'.
     * Constitution.md stays at root (workspace-wide artifact).
     */
    private resolveMissionPath(relativePath: string): string {
        if (!this.missionFolder) {
            return relativePath;
        }

        const normalized = relativePath.replace(/\\/g, '/');
        // Mission-scoped artifact files that should be rerouted
        const missionArtifacts = ['task.md', 'implementation_plan.md', 'mission_summary.md', 'prd.md'];

        for (const artifact of missionArtifacts) {
            const artifactPath = `.vibearchitect/${artifact}`;
            // Robust matching: exact match or ending with /artifactPath (handles ./ or /)
            if (normalized === artifactPath || normalized.endsWith('/' + artifactPath)) {
                // Compute relative path from worktreeRoot to missionFolder
                const relMissionFolder = path.relative(this.worktreeRoot, this.missionFolder);
                const rerouted = path.join(relMissionFolder, artifact).replace(/\\/g, '/');
                console.log(`[AgentTools] Rerouting artifact: ${relativePath} → ${rerouted}`);
                return rerouted;
            }
        }

        // Also handle .vibearchitect/current/ legacy paths
        if (normalized.startsWith('.vibearchitect/current/')) {
            const filename = normalized.substring('.vibearchitect/current/'.length);
            if (missionArtifacts.includes(filename)) {
                const relMissionFolder = path.relative(this.worktreeRoot, this.missionFolder);
                const rerouted = path.join(relMissionFolder, filename).replace(/\\/g, '/');
                console.log(`[AgentTools] Rerouting legacy current/ artifact: ${relativePath} → ${rerouted}`);
                return rerouted;
            }
        }

        return relativePath;
    }

    /**
     * Check if plan files exist in .vibearchitect folder.
     * Used by plan-first guard in review-enabled mode.
     */
    private async planFilesExist(): Promise<{ taskExists: boolean, planExists: boolean }> {
        const taskPath = this.resolveMissionPath('.vibearchitect/task.md');
        const planPath = this.resolveMissionPath('.vibearchitect/implementation_plan.md');

        let taskExists = false;
        let planExists = false;

        try {
            await vscode.workspace.fs.stat(this.getUri(taskPath));
            taskExists = true;
        } catch {
            // File doesn't exist
        }

        try {
            await vscode.workspace.fs.stat(this.getUri(planPath));
            planExists = true;
        } catch {
            // File doesn't exist
        }

        return { taskExists, planExists };
    }

    /**
     * Check if a path is a plan file (task.md or implementation_plan.md in .vibearchitect).
     */
    private isPlanFile(relativePath: string): boolean {
        const normalized = relativePath.replace(/\\/g, '/');
        return normalized.includes('.vibearchitect/task.md') ||
            normalized.includes('.vibearchitect/implementation_plan.md') ||
            normalized.includes('.vibearchitect/missions/') && (
                normalized.endsWith('/task.md') ||
                normalized.endsWith('/implementation_plan.md')
            );
    }

    async readFile(relativePath: string, startLine?: number, endLine?: number): Promise<string> {
        try {
            const resolvedPath = this.resolveMissionPath(relativePath);
            const fileUri = this.getUri(resolvedPath);
            const uint8Array = await vscode.workspace.fs.readFile(fileUri);
            const fullContent = new TextDecoder().decode(uint8Array);

            if (startLine !== undefined || endLine !== undefined) {
                const lines = fullContent.split('\n');
                const start = Math.max(1, startLine ?? 1) - 1; // Convert 1-indexed to 0-indexed
                const end = Math.min(lines.length, endLine ?? lines.length);
                const selectedLines = lines.slice(start, end);
                const totalLines = lines.length;

                let result = selectedLines.join('\n');
                result = `[Lines ${start + 1}-${end} of ${totalLines}]\n` + result;
                return result;
            }

            return fullContent;
        } catch (error: any) {
            const basename = relativePath.split('/').pop() || relativePath;
            const dirname = relativePath.includes('/') ? relativePath.substring(0, relativePath.lastIndexOf('/')) : '.';
            return `Error: File not found: ${relativePath}
→ Use file_search("**/*${basename}*") to find the correct path.
→ Use list_files("${dirname}") to see what files exist in that directory.
→ Do NOT guess paths — verify with file_search first.`;
        }
    }

    async grepSearch(
        query: string,
        options: {
            includePattern?: string;
            isRegexp?: boolean;
            maxResults?: number;
        } = {}
    ): Promise<string> {
        try {
            const { includePattern, isRegexp = false, maxResults = 50 } = options;
            const matches = await FileSearch.search(query, {
                include: includePattern || '**/*',
                exclude: '**/node_modules/**',
                maxResults,
                isRegex: isRegexp,
                caseSensitive: false,
                rootPath: this.worktreeRoot
            });

            if (matches.length === 0) {
                return 'No matches found.';
            }

            const workspaceRoot = this.worktreeRoot;
            const lines = matches.map(m => {
                const relPath = path.relative(workspaceRoot, m.uri.fsPath).replace(/\\/g, '/');
                return `${relPath}:${m.line}: ${m.linePreview.trim()}`;
            });

            return lines.join('\n');
        } catch (error: any) {
            return `Error searching: ${error.message}`;
        }
    }

    async fileSearch(pattern: string, maxResults: number = 50): Promise<string> {
        try {
            const result = await FileDiscovery.findFiles(pattern, '**/node_modules/**', maxResults, this.worktreeRoot);
            const workspaceRoot = this.worktreeRoot;
            const paths = result.files.map(f =>
                path.relative(workspaceRoot, f.fsPath).replace(/\\/g, '/')
            );

            if (paths.length === 0) {
                return 'No files found matching pattern.';
            }

            let output = paths.join('\n');
            if (result.truncated) {
                output += `\n\n[Results truncated: showing ${paths.length} of ${result.totalFound}+ matches]`;
            }
            return output;
        } catch (error: any) {
            return `Error searching files: ${error.message}`;
        }
    }

    async writeFile(relativePath: string, content: string): Promise<string> {
        try {
            // ==================== PLAN-FIRST GUARD (Review Enabled Mode Only) ====================
            if (this.agentMode === 'review-enabled' && !this.isPlanFile(relativePath)) {
                const { taskExists, planExists } = await this.planFilesExist();
                if (!taskExists || !planExists) {
                    console.log(`[AgentTools] WORKFLOW GUARD: write to ${relativePath} deferred - plan files pending (task: ${taskExists}, plan: ${planExists})`);
                    return `📋 WORKFLOW: Planning Phase Required

This is expected behavior in Review Enabled mode. You are in the PLANNING phase.

**Action Required** (not an error - this is the normal workflow):
1. Create .vibearchitect/task.md (${taskExists ? '✅ done' : '📝 create this first'})
2. Create .vibearchitect/implementation_plan.md (${planExists ? '✅ done' : '📝 create this next'})

After BOTH plan files exist, the system will pause for user review.
Once the user approves, you can proceed with implementation.

⚠️ Do NOT try workarounds (temp files, different paths, etc.) - just follow the workflow above.`;
                }
            }

            // ==================== CONSTITUTION RULE ENFORCEMENT ====================
            if (this.ruleEnforcer) {
                const violations = await this.ruleEnforcer.validateFileEdits([{
                    path: relativePath,
                    type: 'create',
                    content: content
                }]);

                // Check for strict violations (must block)
                const strictViolations = violations.filter(v => v.severity === 'strict');
                if (strictViolations.length > 0) {
                    const errorLines = strictViolations.map(v =>
                        `  ❌ ${v.rule.description}${v.rule.reason ? `: ${v.rule.reason}` : ''}`
                    ).join('\n');
                    console.log(`[AgentTools] BLOCKED write to ${relativePath} - constitution violation(s)`);
                    return `⛔ BLOCKED: Constitution violation(s) detected for ${relativePath}:

${errorLines}

Fix the violations and try again. These rules are defined in .vibearchitect/constitution.md`;
                }

                // Log warnings for non-strict violations (don't block)
                const warnings = violations.filter(v => v.severity === 'warning');
                if (warnings.length > 0) {
                    console.warn(`[AgentTools] Constitution warnings for ${relativePath}:`,
                        warnings.map(w => w.rule.description));
                }
            }

            const resolvedPath = this.resolveMissionPath(relativePath);
            const fileUri = this.getUri(resolvedPath);
            const absolutePath = fileUri.fsPath;

            // ==================== SECURITY CHECKS ====================
            const securityWarnings: string[] = [];
            const isEnvFile = relativePath.endsWith('.env') || relativePath.includes('.env.');
            // Check if this is a text-based file that should be scanned for PII
            // Includes source code, config files, data files, and files without extensions
            const isTextFile = /\.(js|ts|jsx|tsx|py|rb|java|go|rs|php|cs|cpp|c|h|txt|json|yaml|yml|xml|md|csv|sql|html|htm|css|scss|less|sh|bat|ps1|cfg|conf|ini|log|env)$/i.test(relativePath) ||
                !relativePath.includes('.'); // Files without extensions are often text

            // Detect secrets in content (warn but allow for prototyping)
            const detectedSecrets = detectSecrets(content);
            console.log(`[Security] File: ${relativePath}, isEnvFile: ${isEnvFile}, isTextFile: ${isTextFile}, secrets: ${detectedSecrets.length}`);
            if (detectedSecrets.length > 0 && !isEnvFile) {
                securityWarnings.push(`⚠️ SECURITY WARNING: Detected ${detectedSecrets.length} potential secret(s) in ${relativePath}:`);
                for (const secret of detectedSecrets.slice(0, 3)) { // Limit to first 3
                    securityWarnings.push(`  - ${secret.type} at line ${secret.line}: ${secret.suggestion}`);
                }
                if (detectedSecrets.length > 3) {
                    securityWarnings.push(`  ... and ${detectedSecrets.length - 3} more`);
                }
                securityWarnings.push(`  💡 TIP: Use environment variables instead of hardcoding secrets.`);
            }

            // Detect PII in text-based files
            if (isTextFile) {
                const detectedPII = detectPII(content);
                console.log(`[Security] PII detection: ${detectedPII.length} items found`);
                detectedPII.forEach(pii => console.log(`  - ${pii.type}: ${pii.match}`));
                const highSeverityPII = detectedPII.filter(p => p.severity === 'high');
                if (highSeverityPII.length > 0) {
                    securityWarnings.push(`⚠️ PII WARNING: Detected sensitive personal data in ${relativePath}:`);
                    for (const pii of highSeverityPII.slice(0, 3)) {
                        securityWarnings.push(`  - ${pii.type} at line ${pii.line}: Use ${pii.maskExample} for testing`);
                    }
                }
            } else {
                console.log(`[Security] Skipping PII check - not a text file: ${relativePath}`);
            }
            console.log(`[Security] Total warnings: ${securityWarnings.length}`);

            // ==================== .ENV FILE HANDLING ====================
            let envExampleCreated = false;
            let gitignoreUpdated = false;

            if (isEnvFile && relativePath.endsWith('.env')) {
                // Auto-create .env.example with placeholder values
                try {
                    const envExampleContent = this.generateEnvExample(content);
                    const envExamplePath = relativePath.replace(/\.env$/, '.env.example');
                    const envExampleUri = this.getUri(envExamplePath);

                    // Check if .env.example already exists
                    try {
                        await vscode.workspace.fs.stat(envExampleUri);
                    } catch {
                        // File doesn't exist, create it
                        const exampleUint8 = new TextEncoder().encode(envExampleContent);
                        await vscode.workspace.fs.writeFile(envExampleUri, exampleUint8);
                        envExampleCreated = true;
                    }
                } catch (e) {
                    // Ignore errors creating .env.example
                }

                // Auto-update .gitignore to exclude .env
                try {
                    gitignoreUpdated = await this.ensureGitignoreExcludes('.env');
                } catch (e) {
                    // Ignore errors updating .gitignore
                }
            }

            // ==================== ORIGINAL FILE WRITE ====================
            // Enforce Locking (thread-safe async version)
            if (this.fileLockManager && this.taskId) {
                const lockAcquired = await this.fileLockManager.acquireLock(absolutePath, this.taskId);
                if (!lockAcquired) {
                    return `Error: File ${relativePath} is currently locked by another agent. Please wait.`;
                }
            }

            try {
                const uint8Array = new TextEncoder().encode(content);
                const parentDir = vscode.Uri.file(path.dirname(path.join(this.worktreeRoot, relativePath)));
                await vscode.workspace.fs.createDirectory(parentDir);

                await vscode.workspace.fs.writeFile(fileUri, uint8Array);

                // Build response with security info
                let response = `Successfully wrote to ${relativePath}`;
                if (envExampleCreated) {
                    response += `\n✅ Auto-created .env.example with placeholder values`;
                }
                if (gitignoreUpdated) {
                    response += `\n✅ Added .env to .gitignore`;
                }
                if (securityWarnings.length > 0) {
                    response += `\n\n${securityWarnings.join('\n')}`;
                }
                return response;
            } finally {
                // Always release lock (thread-safe async version)
                if (this.fileLockManager && this.taskId) {
                    await this.fileLockManager.releaseLock(absolutePath, this.taskId);
                }
            }
        } catch (error: any) {
            return `Error writing file ${relativePath}: ${error.message}`;
        }
    }

    /**
     * Apply a SEARCH/REPLACE diff to a file
     * This is much more token-efficient than rewriting entire files
     * 
     * Enhanced with VS Code IDE integration:
     * - Optional line hints: <<<<<<< SEARCH @@ 120-135 @@
     * - Undo support via WorkspaceEdit
     * - Symbol-aware fallback matching
     * 
     * Format:
     * <<<<<<< SEARCH
     * exact code to find
     * =======
     * replacement code
     * >>>>>>> REPLACE
     * 
     * Or with line hints (faster for large files):
     * <<<<<<< SEARCH @@ 120-135 @@
     * exact code to find
     * =======
     * replacement code
     * >>>>>>> REPLACE
     * 
     * @param source - Optional source identifier for logging (e.g., 'CopilotClaude')
     */
    async applyDiff(relativePath: string, diffContent: string, source?: string): Promise<string> {
        // ==================== PLAN-FIRST GUARD (Review Enabled Mode Only) ====================
        if (this.agentMode === 'review-enabled' && !this.isPlanFile(relativePath)) {
            const { taskExists, planExists } = await this.planFilesExist();
            if (!taskExists || !planExists) {
                console.log(`[AgentTools] WORKFLOW GUARD: applyDiff to ${relativePath} deferred - plan files pending (task: ${taskExists}, plan: ${planExists})`);
                return `📋 WORKFLOW: Planning Phase Required

This is expected behavior in Review Enabled mode. You are in the PLANNING phase.

**Action Required** (not an error - this is the normal workflow):
1. Create .vibearchitect/task.md (${taskExists ? '✅ done' : '📝 create this first'})
2. Create .vibearchitect/implementation_plan.md (${planExists ? '✅ done' : '📝 create this next'})

After BOTH plan files exist, the system will pause for user review.
Once the user approves, you can proceed with implementation.

⚠️ Do NOT try workarounds (temp files, different paths, etc.) - just follow the workflow above.`;
            }
        }

        // ==================== CONSTITUTION RULE ENFORCEMENT (Path-based) ====================
        // For applyDiff, we check path-based rules before applying
        // Content-based rules will be checked after we compute the result
        if (this.ruleEnforcer) {
            const pathViolations = await this.ruleEnforcer.validateFileEdits([{
                path: relativePath,
                type: 'modify'
            }]);

            // Check for strict path-based violations (e.g., node_modules, .git)
            const strictViolations = pathViolations.filter(v => v.severity === 'strict');
            if (strictViolations.length > 0) {
                const errorLines = strictViolations.map(v =>
                    `  ❌ ${v.rule.description}${v.rule.reason ? `: ${v.rule.reason}` : ''}`
                ).join('\n');
                console.log(`[AgentTools] BLOCKED applyDiff to ${relativePath} - constitution violation(s)`);
                return `⛔ BLOCKED: Constitution violation(s) detected for ${relativePath}:

${errorLines}

This path is protected by rules in .vibearchitect/constitution.md`;
            }
        }

        // Initialize diff logger
        let logger: DiffLogger | null = null;
        try {
            logger = DiffLogger.getInstance(this.worktreeRoot);
        } catch {
            // Logger may fail to initialize, continue without it
        }

        try {
            const fileUri = this.getUri(relativePath);
            const absolutePath = fileUri.fsPath;

            // Verify file exists
            try {
                await vscode.workspace.fs.stat(fileUri);
            } catch (error: any) {
                return `Error: Cannot apply diff - file does not exist: ${relativePath}. Use write_file to create new files.`;
            }

            // Create logging context
            const logContext: DiffLogContext = {
                taskId: this.taskId,
                filePath: relativePath,
                source: source || 'unknown'
            };

            // Parse SEARCH/REPLACE blocks from diff content (now with line hints!)
            const blocks = parseSearchReplaceBlocks(diffContent, logContext);
            if (blocks.length === 0) {
                // Log the failure
                if (logger) {
                    logger.logResult(this.taskId, relativePath, false, 0, 0, [
                        'No valid SEARCH/REPLACE blocks found in diff content'
                    ]);
                }
                return `Error: No valid SEARCH/REPLACE blocks found in diff content. Expected format:
<<<<<<< SEARCH
exact code to find
=======
replacement code
>>>>>>> REPLACE

TIP: You can add line hints for faster matching:
<<<<<<< SEARCH @@ 120-135 @@`;
            }

            // Enforce locking BEFORE applying (thread-safe async version)
            if (this.fileLockManager && this.taskId) {
                const lockAcquired = await this.fileLockManager.acquireLock(absolutePath, this.taskId);
                if (!lockAcquired) {
                    return `Error: File ${relativePath} is currently locked by another agent. Please wait.`;
                }
            }

            try {
                // ============================================
                // IDE-INTEGRATED DIFF APPLICATION (BATCHED)
                // Uses VS Code's WorkspaceEdit for:
                // - Single atomic edit (all blocks applied at once)
                // - Single undo step (Ctrl+Z undoes all changes)
                // - No offset drift (blocks sorted by position descending)
                // ============================================
                const ideDiffApplier = getIDEDiffApplier();
                const symbolNavigator = getSymbolNavigator();

                // PHASE 1: Try batched application first (most reliable)
                const batchResult = await ideDiffApplier.applyBlocks(absolutePath, blocks);

                let appliedBlocks = batchResult.appliedBlocks;
                let failedBlocks = batchResult.failedBlocks;
                let errors = batchResult.errors;
                let usedLineHintsCount = batchResult.usedLineHintsCount;

                // PHASE 2: For any failed blocks, try symbol-aware fallback
                if (failedBlocks.length > 0) {
                    console.log(`[applyDiff] ${failedBlocks.length} blocks failed batch apply, trying symbol fallback...`);
                    const stillFailed: typeof blocks = [];
                    const fallbackErrors: string[] = [];

                    for (const block of failedBlocks) {
                        let fallbackSuccess = false;
                        try {
                            const document = await vscode.workspace.openTextDocument(fileUri);
                            const symbolMatch = await symbolNavigator.findNearSymbol(
                                document,
                                block.searchContent,
                                0.5 // minimum confidence
                            );

                            if (symbolMatch) {
                                // Found via symbol - apply using WorkspaceEdit
                                let finalReplace = block.replaceContent;
                                const docText = document.getText();
                                if (docText.includes('\r\n') && !block.replaceContent.includes('\r\n')) {
                                    finalReplace = block.replaceContent.replace(/\n/g, '\r\n');
                                }

                                const edit = new vscode.WorkspaceEdit();
                                edit.replace(document.uri, symbolMatch.range, finalReplace);
                                fallbackSuccess = await vscode.workspace.applyEdit(edit);

                                if (fallbackSuccess) {
                                    await document.save();
                                    appliedBlocks++;
                                    console.log(`[applyDiff] Block applied via symbol fallback (${symbolMatch.symbol.name}, confidence: ${symbolMatch.confidence.toFixed(2)})`);
                                }
                            }
                        } catch (fallbackError) {
                            console.warn('[applyDiff] Symbol fallback failed:', fallbackError);
                        }

                        if (!fallbackSuccess) {
                            stillFailed.push(block);

                            // Enhanced error with similarity feedback
                            const existingContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
                            const bestMatch = findBestMatch(block.searchContent, existingContent);

                            if (bestMatch && bestMatch.similarity > 0.5) {
                                // Found a similar match - provide helpful feedback
                                const document = await vscode.workspace.openTextDocument(fileUri);
                                const lineNum = document.positionAt(bestMatch.position).line + 1;
                                const similarityPct = Math.round(bestMatch.similarity * 100);

                                let errorMsg = `SEARCH content not found (${similarityPct}% similar match at line ${lineNum})`;

                                if (similarityPct >= 80) {
                                    errorMsg += `. The code may have changed slightly. Here's what I found:\n\`\`\`\n${bestMatch.text.slice(0, 200)}${bestMatch.text.length > 200 ? '...' : ''}\n\`\`\``;
                                } else if (similarityPct >= 50) {
                                    errorMsg += `. Found partial match but significant differences exist.`;
                                }

                                fallbackErrors.push(errorMsg);

                                // Log match failure with similarity analysis
                                if (logger) {
                                    logger.logMatchFailure(
                                        this.taskId,
                                        relativePath,
                                        stillFailed.length - 1,
                                        block.searchContent,
                                        existingContent,
                                        bestMatch
                                    );
                                }
                            } else {
                                // No similar content found
                                fallbackErrors.push('SEARCH content not found. No similar content found in file - verify the SEARCH block is exact.');
                            }
                        }
                    }

                    // Update with fallback results
                    failedBlocks = stillFailed;
                    errors = fallbackErrors;
                }

                // Check for complete failure
                if (appliedBlocks === 0) {
                    if (logger) {
                        logger.logResult(
                            this.taskId,
                            relativePath,
                            false,
                            appliedBlocks,
                            blocks.length,
                            errors
                        );
                    }
                    return `Error applying diff to ${relativePath}:\n` +
                        errors.join('\n') +
                        `\n\nTip: The SEARCH block must match the file content EXACTLY, including whitespace.` +
                        `\nTip: Add line hints <<<<<<< SEARCH @@ lineStart-lineEnd @@ for more precise matching.` +
                        `\n\n📋 Diagnostic logs written to: ${logger?.getLogDirectory() || '.antigravity/logs/'}`;
                }

                // POST-APPLY VALIDATION: Check for corruption and auto-repair
                const updatedContent = (await vscode.workspace.fs.readFile(fileUri)).toString();
                const corruption = this.detectFileCorruption(updatedContent, relativePath);

                if (corruption.hasIssues) {
                    const repaired = this.repairFileContent(updatedContent, corruption);
                    if (repaired !== updatedContent) {
                        // Write repaired content
                        const repairedBytes = new TextEncoder().encode(repaired);
                        await vscode.workspace.fs.writeFile(fileUri, repairedBytes);

                        // Log the repair
                        if (logger) {
                            logger.log({
                                timestamp: new Date().toISOString(),
                                type: 'DIFF_RESULT',
                                taskId: this.taskId,
                                filePath: relativePath,
                                data: {
                                    repaired: true,
                                    issues: corruption.issues,
                                    originalLength: updatedContent.length,
                                    repairedLength: repaired.length
                                }
                            });
                        }
                    }
                }

                // Log success
                if (logger) {
                    logger.logResult(
                        this.taskId,
                        relativePath,
                        failedBlocks.length === 0,
                        appliedBlocks,
                        blocks.length,
                        errors
                    );
                }

                // Build response
                let response = `✅ Successfully applied diff to ${relativePath}\n`;
                response += `   • Blocks applied: ${appliedBlocks}/${blocks.length}\n`;
                if (usedLineHintsCount > 0) {
                    response += `   • Line hints used: ${usedLineHintsCount} (faster matching)\n`;
                }
                response += `   • Undo supported: Ctrl+Z to revert\n`;

                if (failedBlocks.length > 0) {
                    response += `   ⚠️ ${failedBlocks.length} block(s) failed to apply:\n`;
                    errors.forEach((err, i) => {
                        response += `      ${i + 1}. ${err}\n`;
                    });
                    response += `   📋 See diagnostic logs: ${logger?.getLogDirectory() || '.antigravity/logs/'}\n`;
                }

                // Auto-reload for frontend files
                const p = relativePath.toLowerCase();
                if (p.endsWith('.html') || p.endsWith('.css') || p.endsWith('.js') || p.endsWith('.jsx') || p.endsWith('.tsx')) {
                    if (this.onReloadBrowserCallback) {
                        this.onReloadBrowserCallback();
                        response += `   • Browser preview auto-reloaded\n`;
                    }
                }

                return response;
            } finally {
                // Always release lock (thread-safe async version)
                if (this.fileLockManager && this.taskId) {
                    await this.fileLockManager.releaseLock(absolutePath, this.taskId);
                }
            }
        } catch (error: any) {
            return `Error applying diff to ${relativePath}: ${error.message}`;
        }
    }

    /**
     * Generate .env.example content from .env content by replacing values with placeholders
     */
    private generateEnvExample(envContent: string): string {
        const lines = envContent.split('\n');
        const exampleLines = lines.map(line => {
            // Keep comments and empty lines
            if (line.trim().startsWith('#') || line.trim() === '') {
                return line;
            }
            // Replace values with placeholders
            const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (match) {
                const [, key, value] = match;
                const placeholder = this.getPlaceholderForEnvKey(key, value);
                return `${key}=${placeholder}`;
            }
            return line;
        });
        return exampleLines.join('\n');
    }

    /**
     * Get appropriate placeholder for an environment variable key
     */
    private getPlaceholderForEnvKey(key: string, value: string): string {
        const keyLower = key.toLowerCase();
        if (keyLower.includes('key') || keyLower.includes('secret') || keyLower.includes('token')) {
            return `your_${keyLower}_here`;
        }
        if (keyLower.includes('password') || keyLower.includes('passwd') || keyLower.includes('pwd')) {
            return 'your_password_here';
        }
        if (keyLower.includes('database') || keyLower.includes('db_url') || keyLower.includes('connection')) {
            return 'your_connection_string_here';
        }
        if (keyLower.includes('url') || keyLower.includes('host') || keyLower.includes('endpoint')) {
            return 'https://your-service-url.com';
        }
        if (keyLower.includes('port')) {
            return value; // Keep port numbers as-is
        }
        // Default placeholder
        return `your_${keyLower}_here`;
    }

    /**
     * Ensure .gitignore contains the specified pattern
     */
    private async ensureGitignoreExcludes(pattern: string): Promise<boolean> {
        const gitignorePath = '.gitignore';
        const gitignoreUri = this.getUri(gitignorePath);

        let content = '';
        try {
            const uint8Array = await vscode.workspace.fs.readFile(gitignoreUri);
            content = new TextDecoder().decode(uint8Array);
        } catch {
            // .gitignore doesn't exist, create it
            content = '# Environment files\n';
        }

        // Check if pattern already exists
        const lines = content.split('\n');
        if (lines.some(line => line.trim() === pattern || line.trim() === pattern + '/')) {
            return false; // Already excluded
        }

        // Add the pattern
        const newContent = content.trimEnd() + '\n' + pattern + '\n';
        const uint8Array = new TextEncoder().encode(newContent);
        await vscode.workspace.fs.writeFile(gitignoreUri, uint8Array);
        return true;
    }

    async listFiles(relativePath: string): Promise<string> {
        try {
            const dirUri = this.getUri(relativePath);
            const entries = await vscode.workspace.fs.readDirectory(dirUri);

            // CRITICAL: Filter out other missions' folders for parallel isolation.
            // When listing '.vibearchitect/missions/', only show THIS task's folder.
            const normalized = relativePath.replace(/\\/g, '/');
            const isMissionsDir = normalized === '.vibearchitect/missions' ||
                normalized === '.vibearchitect/missions/';

            const filtered = entries.filter(([name, type]) => {
                if (isMissionsDir && this.taskId && type === vscode.FileType.Directory) {
                    // Only show this task's own mission folder
                    return name === this.taskId;
                }
                return true;
            });

            const formatted = filtered.map(([name, type]) => {
                const typeName = type === vscode.FileType.Directory ? 'DIR' : 'FILE';
                return `${typeName}\t${name}`;
            }).join('\n');
            return formatted || '(Empty Directory)';
        } catch (error: any) {
            return `Error listing directory ${relativePath}: ${error.message}`;
        }
    }

    async searchWeb(query: string): Promise<string> {
        // Strategy 1: Use VS Code's built-in web_search tool if available (real Bing search)
        const vsTools = vscode.lm.tools;
        const hasWebSearch = vsTools.some(t => t.name === 'web_search');

        if (hasWebSearch) {
            try {
                const result = await vscode.lm.invokeTool('web_search', {
                    input: { query },
                    toolInvocationToken: undefined
                });
                const textParts = result.content
                    .filter((p: any) => p instanceof vscode.LanguageModelTextPart)
                    .map((p: any) => p.value);
                if (textParts.length > 0) {
                    return textParts.join('\n');
                }
            } catch (e: any) {
                console.warn(`[AgentTools] web_search via vscode.lm.invokeTool failed: ${e.message}, falling back to LLM`);
            }
        }

        // Strategy 2: Fall back to existing LLM-based research
        if (this.geminiClient) {
            return await this.geminiClient.research(query);
        } else if (this.claudeClient) {
            return await this.claudeClient.research(query);
        } else if (this.copilotClaudeClient) {
            return await this.copilotClaudeClient.research(query);
        }
        return "Error: No search capability available.";
    }

    async getDiagnostics(filePath?: string): Promise<string> {
        if (filePath) {
            // Resolve relative paths against worktreeRoot
            const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.worktreeRoot, filePath);
            const uri = vscode.Uri.file(absolutePath);
            const diagnostics = vscode.languages.getDiagnostics(uri);
            if (diagnostics.length === 0) {
                return 'No errors or warnings found.';
            }
            return diagnostics.map(d =>
                `${this.severityLabel(d.severity)} Line ${d.range.start.line + 1}: ${d.message} [${d.source || ''}]`
            ).join('\n');
        }
        // All files with diagnostics
        const allDiagnostics = vscode.languages.getDiagnostics();
        const errors = allDiagnostics
            .filter(([_, diags]) => diags.some(d => d.severity === vscode.DiagnosticSeverity.Error))
            .map(([uri, diags]) => {
                const errs = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
                return `${vscode.workspace.asRelativePath(uri)}:\n${errs.map(d =>
                    `  Line ${d.range.start.line + 1}: ${d.message}`
                ).join('\n')}`;
            });
        return errors.length === 0
            ? 'No errors found across workspace.'
            : errors.join('\n\n');
    }

    private severityLabel(severity: vscode.DiagnosticSeverity): string {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error: return 'ERROR';
            case vscode.DiagnosticSeverity.Warning: return 'WARNING';
            case vscode.DiagnosticSeverity.Information: return 'INFO';
            case vscode.DiagnosticSeverity.Hint: return 'HINT';
        }
    }

    async codebaseSearch(query: string): Promise<string> {
        const vsTools = vscode.lm.tools;
        const toolName = vsTools.find(t => t.name === 'codebase')?.name
            || vsTools.find(t => t.name === 'code_search')?.name;

        if (toolName) {
            try {
                const result = await vscode.lm.invokeTool(toolName, {
                    input: { query },
                    toolInvocationToken: undefined
                });
                const textParts = result.content
                    .filter((p: any) => p instanceof vscode.LanguageModelTextPart)
                    .map((p: any) => p.value);
                if (textParts.length > 0) {
                    return textParts.join('\n');
                }
            } catch (e: any) {
                console.warn(`[AgentTools] codebase_search via vscode.lm.invokeTool failed: ${e.message}, falling back to grep`);
            }
        }

        // Fallback: use existing grep_search
        return await this.grepSearch(query, { maxResults: 20 });
    }

    async runTests(testPattern?: string): Promise<string> {
        const vsTools = vscode.lm.tools;
        const testTool = vsTools.find(t =>
            t.name === 'runTests' || t.name === 'run_tests'
        );

        if (testTool) {
            try {
                const input: Record<string, string> = {};
                if (testPattern) { input.pattern = testPattern; }
                const result = await vscode.lm.invokeTool(testTool.name, {
                    input,
                    toolInvocationToken: undefined
                });
                const textParts = result.content
                    .filter((p: any) => p instanceof vscode.LanguageModelTextPart)
                    .map((p: any) => p.value);
                if (textParts.length > 0) {
                    return textParts.join('\n');
                }
            } catch (e: any) {
                console.warn(`[AgentTools] run_tests via vscode.lm.invokeTool failed: ${e.message}, falling back to command`);
            }
        }

        // Fallback: Use run_command with test framework detection
        const testCmd = await this.detectTestCommand();
        const command = testPattern
            ? `${testCmd} -- ${testPattern}`
            : testCmd;
        return await this.runCommand(command, 60000);
    }

    private async detectTestCommand(): Promise<string> {
        try {
            const pkgUri = vscode.Uri.file(path.join(this.worktreeRoot, 'package.json'));
            const content = await vscode.workspace.fs.readFile(pkgUri);
            const pkg = JSON.parse(Buffer.from(content).toString('utf-8'));
            if (pkg.scripts?.test) {
                return 'npm test';
            }
        } catch { /* fallback */ }
        return 'npm test';
    }

    async reload_browser(): Promise<string> {
        // We need a way to signal the UI to reload. 
        // This tool instance doesn't have direct access to the TaskRunner's event emitter.
        // However, we can use vscode.commands to broadcast a signal? 
        // Or better, we can inject a callback or the event emitter into AgentTools.

        // LIMITATION: For this iteration, we will implement it by triggering a workspace command 
        // that the MissionControlProvider listens to, OR we simply return a message saying 
        // "Browser Reloaded (Visual Verification Required by User)".

        // Wait! The TaskRunner passes `this.onReloadBrowser` event... no, it doesn't pass it to AgentTools.
        // Let's check how AgentTools is instantiated. 

        // Ideally, AgentTools should emit an event. 
        // For now, let's just return a placeholder and we fix the wiring in TaskRunner.

        // EDIT: I will add a callback to the constructor for `onReloadBrowser`.
        if (this.onReloadBrowserCallback) {
            this.onReloadBrowserCallback();
            return "Browser Preview Reloaded. Please check the visual output.";
        }
        return "Browser Reload Triggered (Simulated).";
    }

    async navigate_browser(url: string): Promise<string> {
        if (this.onNavigateBrowserCallback) {
            this.onNavigateBrowserCallback(url);
            return `Browser navigated to ${url}. Please check the visual output.`;
        }
        return `Browser navigation to ${url} triggered (Simulated).`;
    }

    /**
     * Run a shell command with configurable timeout.
     * @param command - The command to execute
     * @param waitTimeoutMs - Timeout in milliseconds (default: 15000, max: 600000).
     *                        Use 120000+ for slow operations like pip/npm install.
     */
    async runCommand(command: string, waitTimeoutMs: number = 15000): Promise<string> {
        return new Promise((resolve) => {
            // Basic safety check
            if (command.includes('rm -rf /') || command.includes('format c:')) {
                resolve('Error: Command blocked for safety reasons.');
                return;
            }

            // Cap timeout at 10 minutes to prevent indefinite hangs
            const effectiveTimeout = Math.min(Math.max(waitTimeoutMs, 1000), 600000);

            // Show Terminal - use task-specific terminal if available
            if (this.terminalManager && this.taskId) {
                // Task-specific terminal (parallel-safe)
                this.terminalManager.showForTask(this.taskId);
                this.terminalManager.printCommandHeader(this.taskId, command);
                if (effectiveTimeout > 15000) {
                    this.terminalManager.printForTask(this.taskId, `\x1b[33m[Extended timeout: ${Math.round(effectiveTimeout / 1000)}s]\x1b[0m\n`);
                }
            } else if (this.terminalManager) {
                // Legacy fallback (single shared terminal)
                this.terminalManager.show();
                this.terminalManager.print(`\x1b[36m> ${command}\x1b[0m\n`);
                if (effectiveTimeout > 15000) {
                    this.terminalManager.print(`\x1b[33m[Using extended timeout: ${Math.round(effectiveTimeout / 1000)}s]\x1b[0m\n`);
                }
            }

            // Detect background execution request
            const isBackground = command.trim().endsWith('&');

            // Spawn Process
            const child = cp.spawn(command, {
                cwd: this.worktreeRoot,
                shell: true
            });

            // 1. TIMEOUT LOGIC
            // If not background, force resolve after timeout to prevent hanging
            if (!isBackground) {
                setTimeout(() => {
                    if (!resolved) {
                        child.kill(); // Kill the stuck process
                        const timeoutSec = Math.round(effectiveTimeout / 1000);
                        combinedOutput += `\n[System]: Command timed out after ${timeoutSec}s.`;
                        combinedOutput += ` For slow operations (pip install, npm install, venv creation), use waitTimeoutMs: 120000 or higher.`;
                        combinedOutput += ` For background processes, append '&' to the command.`;
                        safeResolve(combinedOutput);
                    }
                }, effectiveTimeout);
            }

            // 2. PREVENT INTERACTIVE HANGS
            // Immediately end stdin so commands waiting for input (like 'date') fail or exit instead of hanging
            child.stdin.end();

            let combinedOutput = '';
            let resolved = false;

            const safeResolve = (msg: string) => {
                if (!resolved) {
                    resolved = true;
                    resolve(msg);
                }
            };

            child.stdout.on('data', (data) => {
                const text = data.toString();
                combinedOutput += text;
                if (this.terminalManager && this.taskId) {
                    this.terminalManager.printForTask(this.taskId, text);
                } else if (this.terminalManager) {
                    this.terminalManager.print(text);
                }
            });

            child.stderr.on('data', (data) => {
                const text = data.toString();
                combinedOutput += text;
                if (this.terminalManager && this.taskId) {
                    this.terminalManager.printForTask(this.taskId, `\x1b[31m${text}\x1b[0m`);
                } else if (this.terminalManager) {
                    this.terminalManager.print(`\x1b[31m${text}\x1b[0m`);
                }
            });

            child.on('close', (code) => {
                if (!resolved) {
                    if (code !== 0) {
                        combinedOutput += `\n(Process exited with code ${code})`;
                    }
                    safeResolve(combinedOutput || '(No Output)');
                }
            });

            child.on('error', (err) => {
                const errorMsg = `Error spawning process: ${err.message}`;
                combinedOutput += errorMsg;
                if (this.terminalManager && this.taskId) {
                    this.terminalManager.printForTask(this.taskId, `\x1b[31m${errorMsg}\x1b[0m\n`);
                } else if (this.terminalManager) {
                    this.terminalManager.print(`\x1b[31m${errorMsg}\x1b[0m\n`);
                }
                safeResolve(combinedOutput);
            });

            // If background, resolve early to prevent blocking
            if (isBackground) {
                setTimeout(() => {
                    child.unref();
                    safeResolve(`(Background Process Started) Output so far:\n${combinedOutput}`);
                }, 2000); // Wait 2s to catch immediate startup errors
            }
        });
    }

    private splitCommand(command: string): string[] {
        // Very basic splitter, shell: true handles the heavy lifting usually
        // But for spawn(cmd, args), usually we pass command string with shell:true
        // Logic above uses shell:true so 'command' as string is fine.
        return [command];
    }

    // ==================== BROWSER AUTOMATION TOOLS ====================

    /**
     * Launch browser with optional video recording
     */
    async browserLaunch(recordVideo: boolean = false): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized. Task ID required.';
        }
        return await this.browserService.launchBrowser({ recordVideo });
    }

    /**
     * Navigate browser to a URL
     * Returns structured error messages to help agent decide appropriate next steps
     */
    async browserNavigate(url: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        const result = await this.browserService.navigateTo(url);
        if (result.success) {
            if (result.authRequired) {
                return `🔐 AUTH REQUIRED: Navigated to ${result.url} but login page detected. ` +
                    `User will be prompted via LoginCheckpoint - wait for auth completion then retry navigation.`;
            }
            return `✅ Navigated to: ${result.url}`;
        } else {
            // Provide specific, actionable error messages
            const error = result.error || 'Unknown error';

            if (error.includes('ECONNREFUSED') || error.includes('net::ERR_CONNECTION_REFUSED')) {
                return `❌ SERVER NOT RUNNING: Connection refused at ${url}. ` +
                    `Start the dev server first (e.g., npm run dev, python app.py). ` +
                    `Do NOT skip testing - start the server and try again.`;
            }

            if (error.includes('ENOTFOUND') || error.includes('net::ERR_NAME_NOT_RESOLVED')) {
                return `❌ HOST NOT FOUND: Cannot resolve ${url}. Check the URL is correct.`;
            }

            if (error.includes('timeout') || error.includes('Timeout')) {
                return `❌ TIMEOUT: Page at ${url} took too long to load. ` +
                    `Server may be starting slowly - wait a few seconds and retry.`;
            }

            // Generic error with actionable guidance
            return `❌ NAVIGATION FAILED: ${error}. ` +
                `IMPORTANT: Report this specific error to user before considering alternative verification methods.`;
        }
    }

    /**
     * Take a screenshot of the current page
     */
    async browserScreenshot(name?: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        const result = await this.browserService.takeScreenshot(name);
        if (typeof result === 'string') {
            return result; // Error message
        }
        return `Screenshot saved: ${result.path}`;
    }

    /**
     * Click on an element
     */
    async browserClick(selector: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.click(selector);
    }

    /**
     * Type text into an element
     */
    async browserType(selector: string, text: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.type(selector, text);
    }

    /**
     * Wait for an element to appear
     */
    async browserWaitFor(selector: string, timeout?: number): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.waitForSelector(selector, timeout);
    }

    /**
     * Get the current page's DOM content
     */
    async browserGetDOM(): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.getPageContent();
    }

    /**
     * Reload the current page
     */
    async browserReload(): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.reload();
    }

    /**
     * Evaluate JavaScript in the page
     */
    async browserEvaluate(script: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        return await this.browserService.evaluate(script);
    }

    /**
     * Close the browser and stop recording
     */
    async browserClose(): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }
        const result = await this.browserService.closeBrowser();
        if (typeof result === 'string') {
            return result;
        }
        return `Browser closed. Recording saved: ${result.path} (${Math.round(result.duration / 1000)}s)`;
    }

    /**
     * Verify UI by taking a screenshot and using Gemini Vision to analyze
     * whether it matches the expected description and mission objective.
     * This is the core of the self-healing system.
     */
    async browserVerifyUI(category: string, description: string, missionObjective?: string): Promise<string> {
        if (!this.browserService) {
            return 'Error: Browser service not initialized.';
        }

        try {
            // Take current screenshot
            const screenshotResult = await this.browserService.takeScreenshot(`verify_${category}`);
            if (typeof screenshotResult === 'string') {
                return screenshotResult; // Error
            }

            // Read the screenshot file for vision analysis
            const fs = await import('fs');
            const screenshotBuffer = fs.readFileSync(screenshotResult.path);
            const screenshotBase64 = screenshotBuffer.toString('base64');

            // Vision analysis priority:
            // 1. Gemini (best vision quality) - use passed client or create on-demand
            // 2. Claude API (good vision)
            // 3. Copilot Claude (fallback - no actual vision support)
            let analysis: {
                matches: boolean;
                confidence: number;
                issues: string[];
                suggestions: string[];
                analysis: string;
            } | null = null;

            // Vision Analysis Priority Order:
            // 1. Copilot Claude (vscode.lm) - works with Copilot subscription
            // 2. Gemini API - if API key configured
            // 3. Claude API - if API key configured

            // Priority 1: Try Copilot Claude for vision (most accessible)
            if (!analysis && this.copilotClaudeClient) {
                console.log('[AgentTools] Using Copilot Claude for vision analysis');
                try {
                    analysis = await this.copilotClaudeClient.analyzeScreenshot(
                        screenshotBuffer,
                        'image/png',
                        description,
                        missionObjective || 'Verify the UI looks correct'
                    );
                } catch (e: any) {
                    console.log(`[AgentTools] Copilot Claude vision failed: ${e.message}`);
                }
            }

            // Priority 2: Try Gemini API client (if configured)
            if (!analysis) {
                let visionClient = this.geminiClient;
                if (!visionClient) {
                    const config = vscode.workspace.getConfiguration('vibearchitect');
                    const geminiApiKey = config.get<string>('geminiApiKey') || '';
                    if (geminiApiKey) {
                        const { GeminiClient } = await import('../ai/GeminiClient.js');
                        visionClient = new GeminiClient(geminiApiKey, 'gemini-2.0-flash');
                        console.log('[AgentTools] Created on-demand Gemini API client for vision analysis');
                    }
                }

                if (visionClient) {
                    try {
                        analysis = await visionClient.analyzeScreenshot(
                            screenshotBase64,
                            'image/png',
                            description,
                            missionObjective || 'Verify the UI looks correct'
                        );
                    } catch (e: any) {
                        console.log(`[AgentTools] Gemini API vision failed: ${e.message}`);
                    }
                }
            }

            // Priority 3: Try Claude API client (if configured)
            if (!analysis && this.claudeClient) {
                console.log('[AgentTools] Using Claude API for vision analysis');
                try {
                    analysis = await this.claudeClient.analyzeScreenshot(
                        screenshotBase64,
                        'image/png',
                        description,
                        missionObjective || 'Verify the UI looks correct'
                    );
                } catch (e: any) {
                    console.log(`[AgentTools] Claude API vision failed: ${e.message}`);
                }
            }

            if (analysis) {
                // Build detailed result for the agent
                let result = `\n=== UI VERIFICATION: "${category}" ===\n`;
                result += `📊 VERDICT: ${analysis.matches ? '✅ PASS' : '❌ FAIL'}\n`;
                result += `🎯 Confidence: ${analysis.confidence}%\n\n`;

                result += `📝 Analysis:\n${analysis.analysis}\n\n`;

                if (analysis.issues.length > 0) {
                    result += `⚠️ Issues Found:\n`;
                    analysis.issues.forEach((issue, i) => {
                        result += `  ${i + 1}. ${issue}\n`;
                    });
                    result += '\n';
                }

                if (analysis.suggestions.length > 0) {
                    result += `💡 Suggested Fixes:\n`;
                    analysis.suggestions.forEach((suggestion, i) => {
                        result += `  ${i + 1}. ${suggestion}\n`;
                    });
                    result += '\n';
                }

                result += `📸 Screenshot: ${screenshotResult.path}\n`;
                result += `🎯 Expected: ${description}\n`;

                if (!analysis.matches) {
                    result += `\n🔧 ACTION REQUIRED: Please fix the issues above and call browser_verify_ui again to confirm the fix worked.\n`;
                }

                // Also do pixel comparison if visual service available and baseline exists
                if (this.visualService && this.visualService.hasBaseline(category)) {
                    const comparison = await this.visualService.compareAgainstBaseline(
                        screenshotResult.path,
                        category
                    );
                    if (comparison) {
                        result += `\n📐 Pixel Comparison: ${comparison.diffPercentage}% different from baseline`;
                        if (comparison.diffImagePath) {
                            result += ` (diff: ${comparison.diffImagePath})`;
                        }
                        result += '\n';
                    }
                } else if (this.visualService) {
                    // Save as new baseline
                    await this.visualService.saveBaseline(screenshotResult.path, category);
                    result += `\n📌 Saved as baseline for future comparisons.\n`;
                }

                return result;
            } else {
                // Fallback: Basic analysis without vision AI
                let result = `UI Verification for "${category}":\n`;
                result += `- Screenshot taken: ${screenshotResult.path}\n`;
                result += `- Expected: ${description}\n`;
                result += `- Note: No AI vision available for semantic analysis. `;
                result += `Please visually inspect the screenshot.\n`;

                if (this.visualService) {
                    const issues = await this.visualService.analyzeScreenshotForIssues(screenshotResult.path);
                    if (issues.length > 0) {
                        result += `- Basic issues detected:\n  ${issues.join('\n  ')}\n`;
                    }
                }

                return result;
            }
        } catch (error: any) {
            return `Error during UI verification: ${error.message}`;
        }
    }

    /**
     * Check if browser is currently running
     */
    public isBrowserRunning(): boolean {
        return this.browserService?.isRunning() ?? false;
    }

    /**
     * Check if currently recording video
     */
    public isBrowserRecording(): boolean {
        return this.browserService?.isRecordingVideo() ?? false;
    }

    // =========================================================================
    // POST-APPLY VALIDATION & SELF-HEALING
    // =========================================================================

    /**
     * Detect common corruption patterns in file content after diff application
     */
    private detectFileCorruption(content: string, filePath: string): { hasIssues: boolean; issues: string[] } {
        const issues: string[] = [];
        const ext = filePath.split('.').pop()?.toLowerCase() || '';

        // Check for trailing > (from regex marker leak)
        if (content.match(/\n>$/)) {
            issues.push('Trailing > at end of file (regex marker leak)');
        }
        if (content.match(/\n>\r?\n/g)) {
            issues.push('Stray > on its own line');
        }

        // Check for duplicate closing brackets/braces (common corruption pattern)
        if (content.includes('});});')) {
            issues.push('Duplicate });');
        }
        if (content.includes('}}}}')) {
            issues.push('Excessive closing braces');
        }
        if (content.includes('>>>>')) {
            issues.push('Potential REPLACE marker in content');
        }

        // For TypeScript/JavaScript files, do basic brace balance check
        if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
            let braceCount = 0;
            let bracketCount = 0;
            let parenCount = 0;

            for (const char of content) {
                if (char === '{') { braceCount++; }
                if (char === '}') { braceCount--; }
                if (char === '[') { bracketCount++; }
                if (char === ']') { bracketCount--; }
                if (char === '(') { parenCount++; }
                if (char === ')') { parenCount--; }
            }

            if (braceCount !== 0) {
                issues.push(`Unbalanced braces: ${braceCount > 0 ? 'missing ' + braceCount + ' closing' : 'extra ' + Math.abs(braceCount) + ' closing'}`);
            }
            if (bracketCount !== 0) {
                issues.push(`Unbalanced brackets: ${bracketCount > 0 ? 'missing closing' : 'extra closing'}`);
            }
            if (parenCount !== 0) {
                issues.push(`Unbalanced parentheses: ${parenCount > 0 ? 'missing closing' : 'extra closing'}`);
            }
        }

        return { hasIssues: issues.length > 0, issues };
    }

    /**
     * Attempt to auto-repair common corruption patterns
     */
    private repairFileContent(content: string, _corruption: { issues: string[] }): string {
        let repaired = content;

        // Fix trailing > at end of file
        repaired = repaired.replace(/\n>$/, '');

        // Fix stray > on its own line (common marker leak)
        repaired = repaired.replace(/\n>\r?\n/g, '\n');

        // Fix duplicate });
        repaired = repaired.replace(/\}\);\s*\}\);/g, '});');

        // Fix REPLACE markers that leaked into content
        repaired = repaired.replace(/\n?>>>>>>> REPLACE\s*$/g, '');
        repaired = repaired.replace(/<<<<<<< SEARCH\s*\n?/g, '');
        repaired = repaired.replace(/\n=======\n/g, '');

        return repaired;
    }
}
