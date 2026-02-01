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
            aggregatedDiffs: queuedDiffs.length
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

            // Use IDE diff applier for batched application
            const ideDiffApplier = getIDEDiffApplier();
            const symbolNavigator = getSymbolNavigator();

            // Phase 1: Try batched application
            const batchResult = await ideDiffApplier.applyBlocks(absolutePath, blocks);

            let appliedBlocks = batchResult.appliedBlocks;
            let failedBlocks = batchResult.failedBlocks;
            let errors = [...batchResult.errors];

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
                            0.5
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
                                console.log(`[DiffAggregator] Block applied via symbol fallback (${symbolMatch.symbol.name})`);
                            }
                        }
                    } catch (e) {
                        console.warn('[DiffAggregator] Symbol fallback error:', e);
                    }

                    if (!fallbackSuccess) {
                        stillFailed.push(block);

                        // Get similarity feedback
                        const fileContent = beforeContent || '';
                        const bestMatch = findBestMatch(block.searchContent, fileContent);

                        if (bestMatch && bestMatch.similarity > 0.5) {
                            const similarityPct = Math.round(bestMatch.similarity * 100);
                            errors.push(`SEARCH not found (${similarityPct}% similar match exists)`);
                        } else {
                            errors.push('SEARCH content not found - no similar content in file');
                        }
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

            // Log result
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
            const success = failedBlocks.length === 0;
            let message = success
                ? `✅ Applied ${appliedBlocks} block(s) to ${relativePath}`
                : `⚠️ Applied ${appliedBlocks}/${blocks.length} blocks to ${relativePath}`;

            if (errors.length > 0) {
                message += '\nErrors:\n' + errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
            }

            return {
                filePath: relativePath,
                success,
                appliedBlocks,
                totalBlocks: blocks.length,
                errors,
                message
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
