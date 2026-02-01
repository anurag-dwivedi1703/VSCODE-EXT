/**
 * IDEDiffApplier - VS Code IDE-integrated diff application
 * 
 * This module provides IDE-aware diff application, leveraging VS Code's
 * TextDocument and WorkspaceEdit APIs for:
 * - Line-range restricted searching (when line hints are provided)
 * - Undo/redo support through VS Code's edit system
 * - Better integration with open editors
 * - Multi-tier matching for >98% success rate
 * 
 * @module IDEDiffApplier
 */

import * as vscode from 'vscode';
import { SearchReplaceBlock, findFuzzyMatch, describeFuzzyMatch } from './SearchReplaceParser';
import { DiffMatcher, createDiffMatcher, MatchResult, MatchOptions } from './DiffMatcher';

export interface ApplyBlockResult {
    success: boolean;
    error?: string;
    /** The range that was replaced (for logging/diagnostics) */
    replacedRange?: vscode.Range;
    /** Whether line hints were used for matching */
    usedLineHints: boolean;
    /** The matching strategy that succeeded */
    matchStrategy?: string;
    /** Confidence score of the match (0-1) */
    matchConfidence?: number;
}

export interface FindResult {
    range: vscode.Range;
    /** How the match was found: 'lineHint', 'fullDoc', 'normalized', or 'fuzzy' */
    matchMethod: 'lineHint' | 'fullDoc' | 'normalized' | 'fuzzy' | 'advanced';
    /** Similarity score for fuzzy matches (0-1) */
    similarity?: number;
    /** The strategy used by advanced matcher */
    advancedStrategy?: string;
}

export class IDEDiffApplier {
    /**
     * Open a document by absolute path (does not require workspace)
     */
    async openDocument(absolutePath: string): Promise<vscode.TextDocument> {
        const uri = vscode.Uri.file(absolutePath);
        return await vscode.workspace.openTextDocument(uri);
    }

    /**
     * Find search content within a specific line range (when line hints provided)
     * Uses VS Code's TextDocument for precise line access
     * 
     * @param document The VS Code TextDocument
     * @param searchContent The content to search for
     * @param startLine Start line (1-indexed from LLM, converted to 0-indexed)
     * @param endLine End line (1-indexed from LLM, converted to 0-indexed)
     * @param expandRange How many lines to expand the search range (for tolerance)
     */
    findInRange(
        document: vscode.TextDocument,
        searchContent: string,
        startLine: number,
        endLine: number,
        expandRange: number = 10
    ): FindResult | null {
        // Convert 1-indexed (LLM convention) to 0-indexed (VS Code convention)
        const start0 = Math.max(0, startLine - 1 - expandRange);
        const end0 = Math.min(document.lineCount - 1, endLine - 1 + expandRange);

        // Get text within the range
        const rangeStart = new vscode.Position(start0, 0);
        const rangeEnd = new vscode.Position(end0, document.lineAt(end0).text.length);
        const rangeText = document.getText(new vscode.Range(rangeStart, rangeEnd));

        // Normalize line endings for comparison
        const normalizedRangeText = rangeText.replace(/\r\n/g, '\n');
        const normalizedSearch = searchContent.replace(/\r\n/g, '\n');

        // Find within the range
        const matchIndex = normalizedRangeText.indexOf(normalizedSearch);
        if (matchIndex === -1) {
            return null;
        }

        // Convert match index in range text to document position
        const beforeMatch = normalizedRangeText.substring(0, matchIndex);
        const linesBeforeMatch = beforeMatch.split('\n').length - 1;
        const lastNewlineInBefore = beforeMatch.lastIndexOf('\n');
        const columnInLine = lastNewlineInBefore === -1
            ? matchIndex
            : matchIndex - lastNewlineInBefore - 1;

        const matchStartLine = start0 + linesBeforeMatch;
        const matchStartPos = new vscode.Position(matchStartLine, columnInLine);

        // Calculate end position
        const matchLines = normalizedSearch.split('\n');
        const matchEndLine = matchStartLine + matchLines.length - 1;
        const matchEndColumn = matchLines.length === 1
            ? columnInLine + matchLines[0].length
            : matchLines[matchLines.length - 1].length;
        const matchEndPos = new vscode.Position(matchEndLine, matchEndColumn);

        return {
            range: new vscode.Range(matchStartPos, matchEndPos),
            matchMethod: 'lineHint'
        };
    }

    /**
     * Advanced multi-tier matching using DiffMatcher
     * This is the primary matching strategy for high reliability
     */
    async findWithAdvancedMatcher(
        document: vscode.TextDocument,
        searchContent: string,
        options?: MatchOptions
    ): Promise<FindResult | null> {
        const matcher = createDiffMatcher();
        await matcher.initialize(document);

        const result = await matcher.findMatch(searchContent, options);

        if (result.found && result.range) {
            console.log(`[IDEDiffApplier] Advanced match: strategy=${result.strategy}, confidence=${(result.confidence * 100).toFixed(1)}%`);
            return {
                range: result.range,
                matchMethod: 'advanced',
                similarity: result.confidence,
                advancedStrategy: result.strategy
            };
        }

        return null;
    }

    /**
     * Find search content in the full document (fallback when no line hints)
     */
    findInFullDocument(
        document: vscode.TextDocument,
        searchContent: string
    ): FindResult | null {
        const fullText = document.getText();

        // Strategy 1: Exact match
        const matchIndex = fullText.indexOf(searchContent);
        if (matchIndex !== -1) {
            const startPos = document.positionAt(matchIndex);
            const endPos = document.positionAt(matchIndex + searchContent.length);
            return {
                range: new vscode.Range(startPos, endPos),
                matchMethod: 'fullDoc'
            };
        }

        // Strategy 2: Normalized line endings
        const normalizedFile = fullText.replace(/\r\n/g, '\n');
        const normalizedSearch = searchContent.replace(/\r\n/g, '\n');

        const normalizedIndex = normalizedFile.indexOf(normalizedSearch);
        if (normalizedIndex !== -1) {
            // Convert normalized index back to original document position
            // Count how many \r\n pairs occur before this position
            let originalIndex = 0;
            let normalizedPos = 0;

            while (normalizedPos < normalizedIndex && originalIndex < fullText.length) {
                if (fullText[originalIndex] === '\r' && fullText[originalIndex + 1] === '\n') {
                    originalIndex += 2;
                    normalizedPos += 1;
                } else {
                    originalIndex += 1;
                    normalizedPos += 1;
                }
            }

            // Calculate match length in original content
            let matchLength = 0;
            normalizedPos = 0;
            let i = originalIndex;
            while (normalizedPos < normalizedSearch.length && i < fullText.length) {
                if (fullText[i] === '\r' && fullText[i + 1] === '\n' && normalizedSearch[normalizedPos] === '\n') {
                    matchLength += 2;
                    normalizedPos += 1;
                    i += 2;
                } else {
                    matchLength += 1;
                    normalizedPos += 1;
                    i += 1;
                }
            }

            const startPos = document.positionAt(originalIndex);
            const endPos = document.positionAt(originalIndex + matchLength);
            return {
                range: new vscode.Range(startPos, endPos),
                matchMethod: 'normalized'
            };
        }

        // Strategy 3: Fuzzy matching with adaptive tolerance
        // Start with 10% tolerance (handles minor whitespace/comment changes)
        // For short searches (<100 chars), allow up to 15% tolerance
        const baseContentLength = searchContent.length;
        const adaptiveTolerance = baseContentLength < 100 ? 0.15 : 0.10;
        const minSimilarity = 1 - adaptiveTolerance;

        const fuzzyResult = findFuzzyMatch(fullText, searchContent, adaptiveTolerance);
        if (fuzzyResult && fuzzyResult.similarity >= minSimilarity) {
            console.log(`[IDEDiffApplier] Fuzzy match found: ${describeFuzzyMatch(fuzzyResult.similarity)} (${(fuzzyResult.similarity * 100).toFixed(1)}%, tolerance: ${(adaptiveTolerance * 100).toFixed(0)}%)`);
            const startPos = document.positionAt(fuzzyResult.index);
            const endPos = document.positionAt(fuzzyResult.index + fuzzyResult.matchLength);
            return {
                range: new vscode.Range(startPos, endPos),
                matchMethod: 'fuzzy',
                similarity: fuzzyResult.similarity
            };
        }

        return null;
    }

    /**
     * Apply a SearchReplaceBlock to a document using VS Code's WorkspaceEdit
     * This provides undo support through VS Code's edit system
     * 
     * Uses multi-tier matching strategy:
     * 1. Advanced DiffMatcher (whitespace-normalized, line-tolerant, anchor-based)
     * 2. Line-range search with hints (if provided)
     * 3. Full document exact/normalized/fuzzy search
     */
    async applyBlock(
        absolutePath: string,
        block: SearchReplaceBlock
    ): Promise<ApplyBlockResult> {
        try {
            const document = await this.openDocument(absolutePath);
            let findResult: FindResult | null = null;

            // Build match options from block hints
            const matchOptions: MatchOptions = {
                normalizeWhitespace: true,
                ignoreTrailingWhitespace: true,
                ignoreLeadingWhitespace: false,
                maxLineDifferences: 2,
                minFuzzyConfidence: 0.85,
                useAnchors: true
            };

            if (block.startLineHint && block.endLineHint) {
                matchOptions.lineRangeHint = {
                    start: block.startLineHint,
                    end: block.endLineHint
                };
                matchOptions.lineRangeExpansion = 30; // More generous expansion
            }

            // Tier 1: Try advanced multi-tier matcher (PRIMARY)
            findResult = await this.findWithAdvancedMatcher(document, block.searchContent, matchOptions);

            // Tier 2: Fall back to line-range search if hints provided and advanced failed
            if (!findResult && block.startLineHint && block.endLineHint) {
                findResult = this.findInRange(
                    document,
                    block.searchContent,
                    block.startLineHint,
                    block.endLineHint,
                    30 // Increased from 10 to 30 lines
                );
            }

            // Tier 3: Fall back to legacy full document search
            if (!findResult) {
                findResult = this.findInFullDocument(document, block.searchContent);
            }

            if (!findResult) {
                const preview = block.searchContent.slice(0, 60).replace(/\n/g, '\\n');
                return {
                    success: false,
                    error: `SEARCH block not found: "${preview}..."`,
                    usedLineHints: !!(block.startLineHint && block.endLineHint)
                };
            }

            // Preserve original line ending style in replacement
            const documentText = document.getText();
            let finalReplace = block.replaceContent;
            if (documentText.includes('\r\n') && !block.replaceContent.includes('\r\n')) {
                finalReplace = block.replaceContent.replace(/\n/g, '\r\n');
            }

            // Apply using WorkspaceEdit (supports undo)
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, findResult.range, finalReplace);

            const success = await vscode.workspace.applyEdit(edit);

            if (!success) {
                return {
                    success: false,
                    error: 'VS Code failed to apply the edit (WorkspaceEdit rejected)',
                    usedLineHints: findResult.matchMethod === 'lineHint',
                    matchStrategy: findResult.advancedStrategy || findResult.matchMethod
                };
            }

            // Save the document after edit
            await document.save();

            return {
                success: true,
                replacedRange: findResult.range,
                usedLineHints: findResult.matchMethod === 'lineHint',
                matchStrategy: findResult.advancedStrategy || findResult.matchMethod,
                matchConfidence: findResult.similarity
            };
        } catch (error: any) {
            return {
                success: false,
                error: `Exception: ${error.message}`,
                usedLineHints: false
            };
        }
    }

    /**
     * Apply multiple blocks to a file using BATCHED WorkspaceEdit
     * 
     * All blocks are found first, then applied in a single atomic edit.
     * This provides:
     * - Single undo step for user (Ctrl+Z undoes all blocks at once)
     * - Atomic rollback on failure
     * 
     * Uses multi-tier matching for each block:
     * 1. Advanced DiffMatcher (whitespace-normalized, line-tolerant, anchor-based)
     * 2. Line-range search with hints
     * 3. Full document search
     * 
     * Blocks are sorted by position DESCENDING before applying to prevent
     * offset drift issues when earlier edits change line positions.
     */
    async applyBlocks(
        absolutePath: string,
        blocks: SearchReplaceBlock[]
    ): Promise<{
        success: boolean;
        appliedBlocks: number;
        failedBlocks: SearchReplaceBlock[];
        errors: string[];
        usedLineHintsCount: number;
        matchStrategies: Record<string, number>;
    }> {
        const failedBlocks: SearchReplaceBlock[] = [];
        const errors: string[] = [];
        let usedLineHintsCount = 0;
        const matchStrategies: Record<string, number> = {};

        try {
            const document = await this.openDocument(absolutePath);
            const documentText = document.getText();

            // Phase 1: Find all ranges BEFORE applying any edits
            const replacements: Array<{
                block: SearchReplaceBlock;
                range: vscode.Range;
                content: string;
                usedLineHints: boolean;
                strategy: string;
            }> = [];

            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];
                let findResult: FindResult | null = null;

                // Build match options from block hints
                const matchOptions: MatchOptions = {
                    normalizeWhitespace: true,
                    ignoreTrailingWhitespace: true,
                    ignoreLeadingWhitespace: false,
                    maxLineDifferences: 2,
                    minFuzzyConfidence: 0.85,
                    useAnchors: true
                };

                if (block.startLineHint && block.endLineHint) {
                    matchOptions.lineRangeHint = {
                        start: block.startLineHint,
                        end: block.endLineHint
                    };
                    matchOptions.lineRangeExpansion = 30;
                }

                // Tier 1: Try advanced multi-tier matcher (PRIMARY)
                findResult = await this.findWithAdvancedMatcher(document, block.searchContent, matchOptions);

                // Tier 2: Fall back to line-range search if hints provided
                if (!findResult && block.startLineHint && block.endLineHint) {
                    findResult = this.findInRange(
                        document,
                        block.searchContent,
                        block.startLineHint,
                        block.endLineHint,
                        30
                    );
                }

                // Tier 3: Fall back to legacy full document search
                if (!findResult) {
                    findResult = this.findInFullDocument(document, block.searchContent);
                }

                if (findResult) {
                    // Preserve line ending style in replacement
                    let finalReplace = block.replaceContent;
                    if (documentText.includes('\r\n') && !block.replaceContent.includes('\r\n')) {
                        finalReplace = block.replaceContent.replace(/\n/g, '\r\n');
                    }

                    const strategy = findResult.advancedStrategy || findResult.matchMethod;
                    matchStrategies[strategy] = (matchStrategies[strategy] || 0) + 1;

                    replacements.push({
                        block,
                        range: findResult.range,
                        content: finalReplace,
                        usedLineHints: findResult.matchMethod === 'lineHint',
                        strategy
                    });

                    if (findResult.matchMethod === 'lineHint') {
                        usedLineHintsCount++;
                    }
                } else {
                    const preview = block.searchContent.slice(0, 60).replace(/\n/g, '\\n');
                    failedBlocks.push(block);
                    errors.push(`Block ${i + 1}: SEARCH content not found: "${preview}..."`);
                }
            }

            // If no valid replacements, return early
            if (replacements.length === 0) {
                return {
                    success: false,
                    appliedBlocks: 0,
                    failedBlocks,
                    errors,
                    usedLineHintsCount: 0,
                    matchStrategies
                };
            }

            // Phase 2: Check for overlapping ranges (NEW)
            const overlapCheck = this.checkForOverlappingRanges(replacements.map(r => r.range));
            if (overlapCheck.hasOverlaps) {
                console.warn(`[IDEDiffApplier] Detected ${overlapCheck.overlappingPairs.length} overlapping block pairs`);
                // For now, log warning but continue - could abort or merge in future
            }

            // Phase 3: Sort by position DESCENDING to avoid offset drift
            // When applying from bottom to top, earlier line numbers stay valid
            replacements.sort((a, b) => b.range.start.compareTo(a.range.start));

            // Phase 4: Create single batched WorkspaceEdit
            const batchEdit = new vscode.WorkspaceEdit();
            for (const r of replacements) {
                batchEdit.replace(document.uri, r.range, r.content);
            }

            // Phase 5: Apply atomically (single undo step)
            const success = await vscode.workspace.applyEdit(batchEdit);

            if (!success) {
                return {
                    success: false,
                    appliedBlocks: 0,
                    failedBlocks: blocks,
                    errors: ['VS Code failed to apply batched edit (WorkspaceEdit rejected)'],
                    usedLineHintsCount: 0,
                    matchStrategies
                };
            }

            // Save the document after successful edit
            await document.save();

            console.log(`[IDEDiffApplier] Applied ${replacements.length} blocks. Strategies: ${JSON.stringify(matchStrategies)}`);

            return {
                success: failedBlocks.length === 0,
                appliedBlocks: replacements.length,
                failedBlocks,
                errors,
                usedLineHintsCount,
                matchStrategies
            };

        } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                appliedBlocks: 0,
                failedBlocks: blocks,
                errors: [`Exception during batch apply: ${errorMsg}`],
                usedLineHintsCount: 0,
                matchStrategies
            };
        }
    }

    /**
     * Check for overlapping ranges among replacements
     * This can cause undefined behavior if not handled
     */
    private checkForOverlappingRanges(ranges: vscode.Range[]): {
        hasOverlaps: boolean;
        overlappingPairs: Array<[number, number]>;
    } {
        const overlappingPairs: Array<[number, number]> = [];

        for (let i = 0; i < ranges.length; i++) {
            for (let j = i + 1; j < ranges.length; j++) {
                const a = ranges[i];
                const b = ranges[j];

                // Check if ranges overlap
                const overlaps = !(
                    a.end.isBefore(b.start) || 
                    b.end.isBefore(a.start)
                );

                if (overlaps) {
                    overlappingPairs.push([i, j]);
                }
            }
        }

        return {
            hasOverlaps: overlappingPairs.length > 0,
            overlappingPairs
        };
    }

    /**
     * Preview diff using VS Code's native diff editor
     * This shows a side-by-side comparison before applying changes
     * 
     * @param absolutePath - Path to the file being modified
     * @param blocks - The SEARCH/REPLACE blocks to preview
     * @returns True if user can see the diff, false on error
     */
    async previewDiff(absolutePath: string, blocks: SearchReplaceBlock[]): Promise<boolean> {
        try {
            const document = await this.openDocument(absolutePath);
            const originalContent = document.getText();
            
            // Apply blocks to create preview content (in memory only)
            let previewContent = originalContent;
            for (const block of blocks) {
                const normalizedContent = previewContent.replace(/\r\n/g, '\n');
                const normalizedSearch = block.searchContent.replace(/\r\n/g, '\n');
                
                const matchIndex = normalizedContent.indexOf(normalizedSearch);
                if (matchIndex !== -1) {
                    // Convert normalized index to original
                    let originalIndex = 0;
                    let normalizedPos = 0;
                    while (normalizedPos < matchIndex && originalIndex < previewContent.length) {
                        if (previewContent[originalIndex] === '\r' && previewContent[originalIndex + 1] === '\n') {
                            originalIndex += 2;
                            normalizedPos += 1;
                        } else {
                            originalIndex += 1;
                            normalizedPos += 1;
                        }
                    }
                    
                    // Find original match length
                    let matchLen = 0;
                    normalizedPos = 0;
                    let i = originalIndex;
                    while (normalizedPos < normalizedSearch.length && i < previewContent.length) {
                        if (previewContent[i] === '\r' && previewContent[i + 1] === '\n' && normalizedSearch[normalizedPos] === '\n') {
                            matchLen += 2;
                            normalizedPos += 1;
                            i += 2;
                        } else {
                            matchLen += 1;
                            normalizedPos += 1;
                            i += 1;
                        }
                    }
                    
                    // Preserve line endings
                    let replacement = block.replaceContent;
                    if (previewContent.includes('\r\n') && !replacement.includes('\r\n')) {
                        replacement = replacement.replace(/\n/g, '\r\n');
                    }
                    
                    previewContent = previewContent.slice(0, originalIndex) + replacement + previewContent.slice(originalIndex + matchLen);
                }
            }
            
            // Create virtual documents for diff view
            const originalUri = vscode.Uri.parse(`antigravity-diff-original:${absolutePath}`);
            const previewUri = vscode.Uri.parse(`antigravity-diff-preview:${absolutePath}`);
            
            // Register content providers if not already done
            const originalProvider = new (class implements vscode.TextDocumentContentProvider {
                provideTextDocumentContent(): string { return originalContent; }
            })();
            const previewProvider = new (class implements vscode.TextDocumentContentProvider {
                provideTextDocumentContent(): string { return previewContent; }
            })();
            
            const disposable1 = vscode.workspace.registerTextDocumentContentProvider('antigravity-diff-original', originalProvider);
            const disposable2 = vscode.workspace.registerTextDocumentContentProvider('antigravity-diff-preview', previewProvider);
            
            // Show diff editor
            const fileName = absolutePath.split(/[/\\]/).pop() || 'file';
            await vscode.commands.executeCommand('vscode.diff', originalUri, previewUri, `${fileName} (Preview Changes)`);
            
            // Cleanup providers after a delay
            setTimeout(() => {
                disposable1.dispose();
                disposable2.dispose();
            }, 60000); // Keep for 1 minute
            
            return true;
        } catch (error: any) {
            console.error('[IDEDiffApplier] Preview failed:', error.message);
            return false;
        }
    }

    /**
     * Get token estimate for a file (rough approximation)
     * Uses ~4 characters per token as heuristic
     */
    estimateTokens(content: string): number {
        return Math.ceil(content.length / 4);
    }
}

// Singleton instance for reuse
let _instance: IDEDiffApplier | null = null;

export function getIDEDiffApplier(): IDEDiffApplier {
    if (!_instance) {
        _instance = new IDEDiffApplier();
    }
    return _instance;
}
