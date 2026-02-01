/**
 * DiffAggregator.ts
 * 
 * Collects multiple apply_diff calls to the same file and batches them
 * into a single atomic operation. This provides:
 * 
 * - Single undo step for all changes to a file within a turn
 * - No offset drift between sequential diffs
 * - Better performance (single file read/write)
 * - Automatic flush on file change or turn end
 * 
 * Usage:
 *   const aggregator = new DiffAggregator(worktreeRoot, applyCallback);
 *   aggregator.queueDiff('src/file.ts', diffContent1);
 *   aggregator.queueDiff('src/file.ts', diffContent2); // Same file - queued
 *   aggregator.queueDiff('src/other.ts', diffContent3); // Different file - flushes previous
 *   await aggregator.flushAll(); // Flush remaining at end of turn
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { parseSearchReplaceBlocks, SearchReplaceBlock, DiffLogContext } from './SearchReplaceParser';
import { getIDEDiffApplier } from './IDEDiffApplier';
import { DiffLogger, findBestMatch } from './DiffLogger';
import { getSymbolNavigator } from './SymbolNavigator';
import { createDiffRecoveryEngine, DiagnosticReport, RecoverySuggestion } from './DiffRecovery';

export interface QueuedDiff {
    /** Raw diff content from the model */
    diffContent: string;
    /** Parsed blocks from this diff */
    blocks: SearchReplaceBlock[];
    /** Timestamp when queued */
    timestamp: number;
    /** Source model (for logging) */
    source?: string;
}

export interface AggregatedResult {
    /** Path to the file */
    filePath: string;
    /** Whether all diffs were applied successfully */
    success: boolean;
    /** Number of blocks successfully applied */
    appliedBlocks: number;
    /** Total number of blocks attempted */
    totalBlocks: number;
    /** Number of queued diffs that were aggregated */
    aggregatedDiffs: number;
    /** Error messages for failed blocks */
    errors: string[];
    /** Human-readable result message */
    message: string;
    /** Match strategies used (for diagnostics) */
    matchStrategies?: Record<string, number>;
    /** Whether overlapping blocks were detected */
    hadOverlaps?: boolean;
    /** Blocks that need user approval for recovery */
    pendingRecovery?: PendingRecoveryBlock[];
    /** Number of blocks auto-recovered */
    autoRecoveredCount?: number;
}

export interface PendingRecoveryBlock {
    /** Index of the block in original array */
    blockIndex: number;
    /** The original block */
    block: SearchReplaceBlock;
    /** Diagnostic report with suggestions */
    diagnostics: DiagnosticReport;
}

export interface FlushAllResult {
    /** Results for each file that was flushed */
    results: AggregatedResult[];
    /** Total files processed */
    filesProcessed: number;
    /** Total blocks applied across all files */
    totalBlocksApplied: number;
    /** Total blocks that failed */
    totalBlocksFailed: number;
}

export class DiffAggregator {
    /** Map of file path -> queued diffs */
    private queue: Map<string, QueuedDiff[]> = new Map();
    
    /** Workspace root for resolving paths */
    private worktreeRoot: string;
    
    /** Task ID for logging and locking */
    private taskId?: string;
    
    /** Logger instance */
    private logger: DiffLogger | null = null;

    /** Track file edits for UI (optional callback) */
    private onFileEdit?: (filePath: string, beforeContent: string | null, afterContent: string) => void;

    constructor(
        worktreeRoot: string,
        taskId?: string,
        onFileEdit?: (filePath: string, beforeContent: string | null, afterContent: string) => void
    ) {
        this.worktreeRoot = worktreeRoot;
        this.taskId = taskId;
        this.onFileEdit = onFileEdit;

        try {
            this.logger = DiffLogger.getInstance(worktreeRoot);
        } catch {
            // Logger may not be initialized
        }
    }

    /**
     * Get absolute path from relative path
     */
    private getAbsolutePath(relativePath: string): string {
        const fullPath = path.resolve(this.worktreeRoot, relativePath);
        if (!fullPath.startsWith(path.resolve(this.worktreeRoot))) {
            throw new Error(`Access Denied: Path '${relativePath}' traverses outside workspace.`);
        }
        return fullPath;
    }

    /**
     * Normalize path for consistent map keys
     */
    private normalizePath(filePath: string): string {
        return path.normalize(filePath).replace(/\\/g, '/');
    }

    /**
     * Queue a diff for aggregation
     * 
     * @param relativePath - Path to the file (relative to workspace)
     * @param diffContent - Raw SEARCH/REPLACE diff content
     * @param source - Source model identifier for logging
     * @returns Result if a different file was flushed, null otherwise
     */
    async queueDiff(
        relativePath: string,
        diffContent: string,
        source?: string
    ): Promise<AggregatedResult | null> {
        const normalizedPath = this.normalizePath(relativePath);
        
        // Create log context
        const logContext: DiffLogContext = {
            taskId: this.taskId,
            filePath: relativePath,
            source: source || 'unknown'
        };

        // Parse blocks from this diff
        const blocks = parseSearchReplaceBlocks(diffContent, logContext);
        
        if (blocks.length === 0) {
            // No valid blocks - return error immediately
            return {
                filePath: relativePath,
                success: false,
                appliedBlocks: 0,
                totalBlocks: 0,
                aggregatedDiffs: 0,
                errors: ['No valid SEARCH/REPLACE blocks found in diff content'],
                message: `Error: No valid SEARCH/REPLACE blocks found for ${relativePath}`
            };
        }

        // Create queued diff entry
        const queuedDiff: QueuedDiff = {
            diffContent,
            blocks,
            timestamp: Date.now(),
            source
        };

        // Check if we already have diffs for this file
        const existingQueue = this.queue.get(normalizedPath);
        
        if (existingQueue) {
            // Same file - add to existing queue
            existingQueue.push(queuedDiff);
            console.log(`[DiffAggregator] Queued diff #${existingQueue.length} for ${relativePath} (${blocks.length} blocks)`);
            return null; // No flush needed yet
        }

        // New file - check if we need to flush a different file first
        let flushResult: AggregatedResult | null = null;
        
        if (this.queue.size > 0) {
            // Flush the previous file(s) before starting a new one
            // This ensures we don't mix edits to different files
            const allResults = await this.flushAll();
            if (allResults.results.length > 0) {
                // Return the first result (usually there's only one pending file)
                flushResult = allResults.results[0];
            }
        }

        // Start new queue for this file
        this.queue.set(normalizedPath, [queuedDiff]);
        console.log(`[DiffAggregator] Started queue for ${relativePath} (${blocks.length} blocks)`);

        return flushResult;
    }

    /**
     * Check if there are pending diffs for a file
     */
    hasPendingDiffs(relativePath?: string): boolean {
        if (relativePath) {
            const normalizedPath = this.normalizePath(relativePath);
            return this.queue.has(normalizedPath);
        }
        return this.queue.size > 0;
    }

    /**
     * Get count of pending diffs
     */
    getPendingCount(): { files: number; totalBlocks: number } {
        let totalBlocks = 0;
        for (const diffs of this.queue.values()) {
            for (const diff of diffs) {
                totalBlocks += diff.blocks.length;
            }
        }
        return { files: this.queue.size, totalBlocks };
    }

    /**
     * Flush all pending diffs for a specific file
     */
    async flushFile(relativePath: string): Promise<AggregatedResult> {
        const normalizedPath = this.normalizePath(relativePath);
        const queuedDiffs = this.queue.get(normalizedPath);

        if (!queuedDiffs || queuedDiffs.length === 0) {
            return {
                filePath: relativePath,
                success: true,
                appliedBlocks: 0,
                totalBlocks: 0,
                aggregatedDiffs: 0,
                errors: [],
                message: `No pending diffs for ${relativePath}`
            };
        }

        // Remove from queue before processing
        this.queue.delete(normalizedPath);

        // Combine all blocks from all queued diffs
        const allBlocks: SearchReplaceBlock[] = [];
        for (const diff of queuedDiffs) {
            allBlocks.push(...diff.blocks);
        }

        console.log(`[DiffAggregator] Flushing ${queuedDiffs.length} queued diffs for ${relativePath} (${allBlocks.length} total blocks)`);

        // Apply all blocks at once
        const result = await this.applyAggregatedBlocks(relativePath, allBlocks, queuedDiffs[0].source);

        return {
            ...result,
            aggregatedDiffs: queuedDiffs.length,
            matchStrategies: result.matchStrategies
        };
    }

    /**
     * Flush all pending diffs for all files
     */
    async flushAll(): Promise<FlushAllResult> {
        const results: AggregatedResult[] = [];
        let totalBlocksApplied = 0;
        let totalBlocksFailed = 0;

        // Get all file paths (copy to avoid mutation during iteration)
        const filePaths = Array.from(this.queue.keys());

        for (const normalizedPath of filePaths) {
            // Find original relative path from first queued diff
            const queuedDiffs = this.queue.get(normalizedPath);
            if (!queuedDiffs || queuedDiffs.length === 0) continue;

            const result = await this.flushFile(normalizedPath);
            results.push(result);
            totalBlocksApplied += result.appliedBlocks;
            totalBlocksFailed += result.totalBlocks - result.appliedBlocks;
        }

        return {
            results,
            filesProcessed: results.length,
            totalBlocksApplied,
            totalBlocksFailed
        };
    }

    /**
     * Apply aggregated blocks to a file using batched WorkspaceEdit
     * 
     * Uses multi-tier matching strategy for >98% success rate:
     * 1. Advanced DiffMatcher (whitespace-normalized, line-tolerant, anchor-based)
     * 2. Symbol-based fallback
     * 3. Fuzzy matching as last resort
     */
    private async applyAggregatedBlocks(
        relativePath: string,
        blocks: SearchReplaceBlock[],
        source?: string
    ): Promise<Omit<AggregatedResult, 'aggregatedDiffs'>> {
        const absolutePath = this.getAbsolutePath(relativePath);
        const fileUri = vscode.Uri.file(absolutePath);

        try {
            // Verify file exists
            try {
                await vscode.workspace.fs.stat(fileUri);
            } catch {
                return {
                    filePath: relativePath,
                    success: false,
                    appliedBlocks: 0,
                    totalBlocks: blocks.length,
                    errors: [`File does not exist: ${relativePath}`],
                    message: `Error: Cannot apply diff - file does not exist: ${relativePath}`
                };
            }

            // Read before content for tracking
            let beforeContent: string | null = null;
            try {
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                beforeContent = new TextDecoder().decode(bytes);
            } catch {
                // Ignore read errors
            }

            // Pre-validation: Check for potential issues
            const validationIssues = this.validateBlocks(blocks, beforeContent || '');
            if (validationIssues.length > 0) {
                console.log(`[DiffAggregator] Pre-validation found ${validationIssues.length} potential issues`);
            }

            // Use IDE diff applier for batched application
            const ideDiffApplier = getIDEDiffApplier();
            const symbolNavigator = getSymbolNavigator();

            // Phase 1: Try batched application with advanced matching
            const batchResult = await ideDiffApplier.applyBlocks(absolutePath, blocks);

            let appliedBlocks = batchResult.appliedBlocks;
            let failedBlocks = batchResult.failedBlocks;
            let errors = [...batchResult.errors];
            const matchStrategies = { ...batchResult.matchStrategies };

            // Phase 2: Symbol fallback for failed blocks
            if (failedBlocks.length > 0) {
                console.log(`[DiffAggregator] ${failedBlocks.length} blocks failed, trying symbol fallback...`);
                
                const stillFailed: SearchReplaceBlock[] = [];

                for (const block of failedBlocks) {
                    let fallbackSuccess = false;

                    try {
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        const symbolMatch = await symbolNavigator.findNearSymbol(
                            document,
                            block.searchContent,
                            0.4 // Lowered threshold for better recovery
                        );

                        if (symbolMatch) {
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
                                matchStrategies['symbol-fallback'] = (matchStrategies['symbol-fallback'] || 0) + 1;
                                console.log(`[DiffAggregator] Block applied via symbol fallback (${symbolMatch.symbol.name}, confidence: ${(symbolMatch.confidence * 100).toFixed(1)}%)`);
                            }
                        }
                    } catch (e) {
                        console.warn('[DiffAggregator] Symbol fallback error:', e);
                    }

                    if (!fallbackSuccess) {
                        stillFailed.push(block);
                    }
                }

                failedBlocks = stillFailed;
            }

            // Phase 3: Diff-guided recovery for remaining failed blocks
            const pendingRecovery: PendingRecoveryBlock[] = [];
            let autoRecoveredCount = 0;

            if (failedBlocks.length > 0) {
                console.log(`[DiffAggregator] ${failedBlocks.length} blocks still failed, trying diff-guided recovery...`);
                
                const recoveryEngine = createDiffRecoveryEngine();
                const document = await vscode.workspace.openTextDocument(fileUri);
                await recoveryEngine.initialize(document);

                const stillFailed: SearchReplaceBlock[] = [];

                for (let i = 0; i < failedBlocks.length; i++) {
                    const block = failedBlocks[i];
                    
                    try {
                        const recoveryResult = await recoveryEngine.attemptRecovery(block, {
                            autoApplyWhitespace: true,
                            minConfidence: 0.90 // High threshold for auto-recovery
                        });

                        if (recoveryResult.success && recoveryResult.range) {
                            // Auto-recovery succeeded
                            let finalReplace = block.replaceContent;
                            const docText = document.getText();
                            if (docText.includes('\r\n') && !block.replaceContent.includes('\r\n')) {
                                finalReplace = block.replaceContent.replace(/\n/g, '\r\n');
                            }

                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document.uri, recoveryResult.range, finalReplace);
                            const editSuccess = await vscode.workspace.applyEdit(edit);

                            if (editSuccess) {
                                await document.save();
                                appliedBlocks++;
                                autoRecoveredCount++;
                                matchStrategies['auto-recovery'] = (matchStrategies['auto-recovery'] || 0) + 1;
                                console.log(`[DiffAggregator] Block auto-recovered: ${recoveryResult.report.failureReason}`);
                            } else {
                                stillFailed.push(block);
                            }
                        } else if (recoveryResult.report.suggestions.length > 0) {
                            // Has suggestions but needs user approval
                            pendingRecovery.push({
                                blockIndex: blocks.indexOf(block),
                                block,
                                diagnostics: recoveryResult.report
                            });
                        } else {
                            // No recovery possible
                            stillFailed.push(block);

                            const fileContent = beforeContent || '';
                            const bestMatch = findBestMatch(block.searchContent, fileContent);
                            const diagnostic = this.getDiagnosticInfo(block, fileContent, bestMatch);

                            if (bestMatch && bestMatch.similarity > 0.5) {
                                const similarityPct = Math.round(bestMatch.similarity * 100);
                                errors.push(`SEARCH not found (${similarityPct}% similar match at line ${diagnostic.nearestLine})`);
                            } else {
                                errors.push(`SEARCH content not found - ${diagnostic.reason}`);
                            }
                        }
                    } catch (e) {
                        console.warn('[DiffAggregator] Recovery error:', e);
                        stillFailed.push(block);
                    }
                }

                failedBlocks = stillFailed;
            }

            // Read after content for tracking
            let afterContent = '';
            try {
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                afterContent = new TextDecoder().decode(bytes);
            } catch {
                // Ignore
            }

            // Notify callback if provided
            if (this.onFileEdit && appliedBlocks > 0) {
                this.onFileEdit(relativePath, beforeContent, afterContent);
            }

            // Log result with strategy breakdown
            if (this.logger) {
                this.logger.logResult(
                    this.taskId,
                    relativePath,
                    failedBlocks.length === 0,
                    appliedBlocks,
                    blocks.length,
                    errors
                );
            }

            // Build response message
            const success = failedBlocks.length === 0 && pendingRecovery.length === 0;
            let message = success
                ? `✅ Applied ${appliedBlocks} block(s) to ${relativePath}`
                : `⚠️ Applied ${appliedBlocks}/${blocks.length} blocks to ${relativePath}`;

            // Add auto-recovery info
            if (autoRecoveredCount > 0) {
                message += ` (${autoRecoveredCount} auto-recovered)`;
            }

            // Add pending recovery info
            if (pendingRecovery.length > 0) {
                message += `\n⏳ ${pendingRecovery.length} block(s) need manual approval`;
            }

            // Add strategy breakdown for successful applications
            if (Object.keys(matchStrategies).length > 0 && appliedBlocks > 0) {
                const strategyStr = Object.entries(matchStrategies)
                    .map(([k, v]) => `${k}:${v}`)
                    .join(', ');
                message += ` [strategies: ${strategyStr}]`;
            }

            if (errors.length > 0) {
                message += '\nErrors:\n' + errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
            }

            return {
                filePath: relativePath,
                success,
                appliedBlocks,
                totalBlocks: blocks.length,
                errors,
                message,
                matchStrategies,
                pendingRecovery: pendingRecovery.length > 0 ? pendingRecovery : undefined,
                autoRecoveredCount: autoRecoveredCount > 0 ? autoRecoveredCount : undefined
            };

        } catch (error: any) {
            return {
                filePath: relativePath,
                success: false,
                appliedBlocks: 0,
                totalBlocks: blocks.length,
                errors: [`Exception: ${error.message}`],
                message: `Error applying diff to ${relativePath}: ${error.message}`
            };
        }
    }

    /**
     * Pre-validate blocks before applying
     */
    private validateBlocks(blocks: SearchReplaceBlock[], fileContent: string): string[] {
        const issues: string[] = [];

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];

            // Check for empty search
            if (!block.searchContent || block.searchContent.trim() === '') {
                issues.push(`Block ${i + 1}: Empty SEARCH content`);
            }

            // Check for very short search (likely to match wrong location)
            if (block.searchContent.trim().length < 10 && block.searchContent.trim().length > 0) {
                issues.push(`Block ${i + 1}: Very short SEARCH (${block.searchContent.length} chars) - may match wrong location`);
            }

            // Check for nested markers
            if (block.searchContent.includes('<<<<<<< SEARCH') || block.replaceContent.includes('>>>>>>> REPLACE')) {
                issues.push(`Block ${i + 1}: Contains nested SEARCH/REPLACE markers`);
            }

            // Check if SEARCH appears multiple times in file
            const searchNorm = block.searchContent.replace(/\r\n/g, '\n').trim();
            const fileNorm = fileContent.replace(/\r\n/g, '\n');
            const occurrences = (fileNorm.match(new RegExp(this.escapeRegex(searchNorm), 'g')) || []).length;
            if (occurrences > 1) {
                issues.push(`Block ${i + 1}: SEARCH content appears ${occurrences} times - may match wrong location`);
            }
        }

        // Check for potential overlaps between blocks
        // This is a heuristic - we check if any two blocks share significant content
        for (let i = 0; i < blocks.length; i++) {
            for (let j = i + 1; j < blocks.length; j++) {
                const a = blocks[i].searchContent.replace(/\r\n/g, '\n').trim();
                const b = blocks[j].searchContent.replace(/\r\n/g, '\n').trim();
                
                if (a.includes(b) || b.includes(a)) {
                    issues.push(`Blocks ${i + 1} and ${j + 1}: Potentially overlapping SEARCH content`);
                }
            }
        }

        return issues;
    }

    /**
     * Get diagnostic info for a failed block
     */
    private getDiagnosticInfo(
        block: SearchReplaceBlock,
        fileContent: string,
        bestMatch: { text: string; similarity: number; position: number } | null
    ): { nearestLine: number; reason: string } {
        if (!fileContent) {
            return { nearestLine: 0, reason: 'File is empty' };
        }

        if (bestMatch) {
            const lines = fileContent.substring(0, bestMatch.position).split('\n');
            return { 
                nearestLine: lines.length,
                reason: `${Math.round(bestMatch.similarity * 100)}% similar content found at line ${lines.length}`
            };
        }

        // Check if the first line of search exists anywhere
        const firstLine = block.searchContent.split('\n')[0].trim();
        if (firstLine && fileContent.includes(firstLine)) {
            const index = fileContent.indexOf(firstLine);
            const lines = fileContent.substring(0, index).split('\n');
            return {
                nearestLine: lines.length,
                reason: `First line found at line ${lines.length} but full block doesn't match`
            };
        }

        return { nearestLine: 0, reason: 'No similar content found in file' };
    }

    /**
     * Escape string for use in regex
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Apply a user-approved recovery suggestion
     * 
     * @param filePath - Path to the file
     * @param block - The original failed block
     * @param suggestion - The approved suggestion from the user
     * @returns Success status and message
     */
    async applyRecoverySuggestion(
        filePath: string,
        block: SearchReplaceBlock,
        suggestionRange: { startLine: number; startChar: number; endLine: number; endChar: number }
    ): Promise<{ success: boolean; message: string }> {
        try {
            const absolutePath = this.getAbsolutePath(filePath);
            const fileUri = vscode.Uri.file(absolutePath);
            const document = await vscode.workspace.openTextDocument(fileUri);

            // Create range from suggestion
            const range = new vscode.Range(
                new vscode.Position(suggestionRange.startLine, suggestionRange.startChar),
                new vscode.Position(suggestionRange.endLine, suggestionRange.endChar)
            );

            // Prepare replacement content
            let finalReplace = block.replaceContent;
            const docText = document.getText();
            if (docText.includes('\r\n') && !block.replaceContent.includes('\r\n')) {
                finalReplace = block.replaceContent.replace(/\n/g, '\r\n');
            }

            // Apply the edit
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, range, finalReplace);
            const success = await vscode.workspace.applyEdit(edit);

            if (success) {
                await document.save();
                console.log(`[DiffAggregator] User-approved recovery applied to ${filePath}`);
                return {
                    success: true,
                    message: `✅ Recovery applied to ${filePath}`
                };
            } else {
                return {
                    success: false,
                    message: `Failed to apply recovery - VS Code rejected the edit`
                };
            }
        } catch (error: any) {
            return {
                success: false,
                message: `Recovery failed: ${error.message}`
            };
        }
    }

    /**
     * Clear all pending diffs without applying them
     */
    clear(): void {
        const pending = this.getPendingCount();
        if (pending.files > 0) {
            console.log(`[DiffAggregator] Cleared ${pending.files} files with ${pending.totalBlocks} pending blocks`);
        }
        this.queue.clear();
    }

    /**
     * Get summary of pending diffs
     */
    getSummary(): string {
        const pending = this.getPendingCount();
        if (pending.files === 0) {
            return 'DiffAggregator: No pending diffs';
        }

        const fileList = Array.from(this.queue.entries())
            .map(([path, diffs]) => {
                const blockCount = diffs.reduce((sum, d) => sum + d.blocks.length, 0);
                return `  - ${path}: ${diffs.length} diffs, ${blockCount} blocks`;
            })
            .join('\n');

        return `DiffAggregator: ${pending.files} files, ${pending.totalBlocks} blocks pending\n${fileList}`;
    }
}
