/**
 * IDEDiffApplier - VS Code IDE-integrated diff application
 * 
 * This module provides IDE-aware diff application, leveraging VS Code's
 * TextDocument and WorkspaceEdit APIs for:
 * - Line-range restricted searching (when line hints are provided)
 * - Undo/redo support through VS Code's edit system
 * - Better integration with open editors
 * 
 * @module IDEDiffApplier
 */

import * as vscode from 'vscode';
import { SearchReplaceBlock } from './SearchReplaceParser';

export interface ApplyBlockResult {
    success: boolean;
    error?: string;
    /** The range that was replaced (for logging/diagnostics) */
    replacedRange?: vscode.Range;
    /** Whether line hints were used for matching */
    usedLineHints: boolean;
}

export interface FindResult {
    range: vscode.Range;
    /** How the match was found: 'lineHint', 'fullDoc', or 'normalized' */
    matchMethod: 'lineHint' | 'fullDoc' | 'normalized';
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
     * Find search content in the full document (fallback when no line hints)
     */
    findInFullDocument(
        document: vscode.TextDocument,
        searchContent: string
    ): FindResult | null {
        const fullText = document.getText();

        // Strategy 1: Exact match
        let matchIndex = fullText.indexOf(searchContent);
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

        return null;
    }

    /**
     * Apply a SearchReplaceBlock to a document using VS Code's WorkspaceEdit
     * This provides undo support through VS Code's edit system
     */
    async applyBlock(
        absolutePath: string,
        block: SearchReplaceBlock
    ): Promise<ApplyBlockResult> {
        try {
            const document = await this.openDocument(absolutePath);
            let findResult: FindResult | null = null;

            // Tier 1: Try line-range search if hints provided
            if (block.startLineHint && block.endLineHint) {
                findResult = this.findInRange(
                    document,
                    block.searchContent,
                    block.startLineHint,
                    block.endLineHint,
                    10 // expand search by 10 lines in each direction for tolerance
                );
            }

            // Tier 2: Fall back to full document search
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

            // Apply using WorkspaceEdit (supports undo!)
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, findResult.range, finalReplace);

            const success = await vscode.workspace.applyEdit(edit);

            if (!success) {
                return {
                    success: false,
                    error: 'VS Code failed to apply the edit (WorkspaceEdit rejected)',
                    usedLineHints: findResult.matchMethod === 'lineHint'
                };
            }

            // Save the document after edit
            await document.save();

            return {
                success: true,
                replacedRange: findResult.range,
                usedLineHints: findResult.matchMethod === 'lineHint'
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
     * Apply multiple blocks to a file
     * Each block is applied sequentially, and after each apply
     * we re-open the document to get the updated content
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
    }> {
        const result = {
            success: true,
            appliedBlocks: 0,
            failedBlocks: [] as SearchReplaceBlock[],
            errors: [] as string[],
            usedLineHintsCount: 0
        };

        for (const block of blocks) {
            const applyResult = await this.applyBlock(absolutePath, block);

            if (applyResult.success) {
                result.appliedBlocks++;
                if (applyResult.usedLineHints) {
                    result.usedLineHintsCount++;
                }
            } else {
                result.failedBlocks.push(block);
                result.errors.push(applyResult.error || 'Unknown error');
            }
        }

        result.success = result.failedBlocks.length === 0;
        return result;
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
