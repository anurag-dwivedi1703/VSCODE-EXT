/**
 * SearchReplaceParser - Parses and applies SEARCH/REPLACE blocks from LLM output
 * 
 * This module enables differential editing, reducing output token usage by ~90%
 * compared to full file rewrites. Based on the format used by Aider and Cline.
 * 
 * Format:
 * <<<<<<< SEARCH
 * exact code to find (must match character-for-character)
 * =======
 * replacement code
 * >>>>>>> REPLACE
 */

import { DiffLogger, validateDiffBlock, findBestMatch, ValidationIssue } from './DiffLogger';

export interface SearchReplaceBlock {
    searchContent: string;
    replaceContent: string;
    /** Line number in the diff output where this block started (for error reporting) */
    lineNumber?: number;
}

export interface ApplyResult {
    success: boolean;
    newContent: string;
    appliedBlocks: number;
    failedBlocks: SearchReplaceBlock[];
    errors: string[];
}

/**
 * Context for logging during diff operations
 */
export interface DiffLogContext {
    taskId?: string;
    filePath: string;
    source?: string; // 'CopilotClaude' | 'CopilotGPT' | etc.
}

/**
 * Parse SEARCH/REPLACE blocks from LLM output text
 * Supports multiple blocks in a single response
 * @param text - Raw diff content from LLM
 * @param logContext - Optional context for diagnostic logging
 */
export function parseSearchReplaceBlocks(
    text: string,
    logContext?: DiffLogContext
): SearchReplaceBlock[] {
    const startTime = Date.now();
    const blocks: SearchReplaceBlock[] = [];
    let logger: DiffLogger | null = null;

    // Try to get logger instance (may not be initialized)
    try {
        logger = DiffLogger.getInstance();
    } catch {
        // Logger not initialized, continue without logging
    }

    // Log raw diff received
    if (logger && logContext) {
        logger.logDiffReceived(
            logContext.taskId,
            logContext.filePath,
            text,
            logContext.source || 'unknown'
        );
    }

    // Pattern to match SEARCH/REPLACE blocks
    // Supports variations in whitespace and line endings
    const blockPattern = /<<<<<<?[ ]*SEARCH[ ]*\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>?[ ]*REPLACE/g;

    let match;
    while ((match = blockPattern.exec(text)) !== null) {
        const searchContent = match[1];
        const replaceContent = match[2];

        // Calculate approximate line number for error reporting
        const precedingText = text.slice(0, match.index);
        const lineNumber = (precedingText.match(/\n/g) || []).length + 1;

        blocks.push({
            searchContent,
            replaceContent,
            lineNumber
        });
    }

    // Also try alternative format (some models use slightly different markers)
    if (blocks.length === 0) {
        const altPattern = /```(?:diff|patch)?\s*\n<<<<<<?[ ]*SEARCH[ ]*\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>?[ ]*REPLACE\s*\n```/g;

        while ((match = altPattern.exec(text)) !== null) {
            blocks.push({
                searchContent: match[1],
                replaceContent: match[2],
                lineNumber: (text.slice(0, match.index).match(/\n/g) || []).length + 1
            });
        }
    }

    // Log parsed blocks and run validation
    if (logger && logContext) {
        const parseTimeMs = Date.now() - startTime;
        logger.logDiffParsed(logContext.taskId, logContext.filePath, blocks, parseTimeMs);

        // Validate each block and log issues
        const allIssues: ValidationIssue[] = [];
        blocks.forEach((block, index) => {
            const issues = validateDiffBlock(block.searchContent, block.replaceContent, index);
            allIssues.push(...issues);
        });

        if (allIssues.length > 0) {
            logger.logValidation(logContext.taskId, logContext.filePath, allIssues);
        }
    }

    return blocks;
}

/**
 * Validate that a search block exists in the file content
 * Returns the index where the match was found, or -1 if not found
 */
export function findSearchBlock(fileContent: string, searchContent: string): number {
    // Try exact match first
    let index = fileContent.indexOf(searchContent);
    if (index !== -1) {
        return index;
    }

    // Try with normalized line endings (CRLF vs LF)
    const normalizedContent = fileContent.replace(/\r\n/g, '\n');
    const normalizedSearch = searchContent.replace(/\r\n/g, '\n');
    index = normalizedContent.indexOf(normalizedSearch);
    if (index !== -1) {
        // For normalized match, the index in normalized content works for replacement
        // since we're returning the position where the match starts
        return index;
    }


    // Try with trimmed whitespace on each line (handles trailing space differences)
    const contentLines = fileContent.split('\n');
    const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let matches = true;
        for (let j = 0; j < searchLines.length; j++) {
            const contentLine = contentLines[i + j].replace(/\r$/, '').trimEnd();
            const searchLine = searchLines[j].trimEnd();
            if (contentLine !== searchLine) {
                matches = false;
                break;
            }
        }
        if (matches) {
            // Calculate the character index
            let charIndex = 0;
            for (let k = 0; k < i; k++) {
                charIndex += contentLines[k].length + 1; // +1 for newline
            }
            return charIndex;
        }
    }

    return -1;
}

/**
 * Apply a single SEARCH/REPLACE block to file content
 */
export function applySingleBlock(
    fileContent: string,
    block: SearchReplaceBlock
): { success: boolean; newContent: string; error?: string } {
    const searchIndex = findSearchBlock(fileContent, block.searchContent);

    if (searchIndex === -1) {
        // Try to provide helpful error message
        const searchPreview = block.searchContent.slice(0, 50).replace(/\n/g, '\\n');
        return {
            success: false,
            newContent: fileContent,
            error: `SEARCH block not found in file. Looking for: "${searchPreview}..."`
        };
    }

    // Find the exact match length (accounting for normalized search)
    const normalizedContent = fileContent.replace(/\r\n/g, '\n');
    const normalizedSearch = block.searchContent.replace(/\r\n/g, '\n');

    // Simple replacement at the found index
    const before = fileContent.slice(0, searchIndex);
    const after = fileContent.slice(searchIndex + block.searchContent.length);

    // Handle case where we matched normalized version
    if (fileContent.indexOf(block.searchContent) === -1) {
        // Need to find actual length in original content
        const searchLen = findActualMatchLength(fileContent, searchIndex, block.searchContent);
        const actualBefore = fileContent.slice(0, searchIndex);
        const actualAfter = fileContent.slice(searchIndex + searchLen);
        return {
            success: true,
            newContent: actualBefore + block.replaceContent + actualAfter
        };
    }

    return {
        success: true,
        newContent: before + block.replaceContent + after
    };
}

/**
 * Find the actual length of a match in the original content
 * (handles line ending differences)
 */
function findActualMatchLength(content: string, startIndex: number, searchContent: string): number {
    const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');
    const contentFromStart = content.slice(startIndex);
    const contentLines = contentFromStart.split('\n');

    let actualLength = 0;
    for (let i = 0; i < searchLines.length; i++) {
        if (i < contentLines.length) {
            actualLength += contentLines[i].length;
            if (i < searchLines.length - 1) {
                // Add 1 for newline, or 2 if CRLF
                actualLength += content[startIndex + actualLength] === '\r' ? 2 : 1;
            }
        }
    }

    return actualLength;
}

/**
 * Apply multiple SEARCH/REPLACE blocks to file content
 * Blocks are applied in order, and each successive block operates on the
 * result of the previous application.
 */
export function applySearchReplace(fileContent: string, blocks: SearchReplaceBlock[]): ApplyResult {
    const result: ApplyResult = {
        success: true,
        newContent: fileContent,
        appliedBlocks: 0,
        failedBlocks: [],
        errors: []
    };

    if (blocks.length === 0) {
        result.errors.push('No SEARCH/REPLACE blocks found in diff content');
        result.success = false;
        return result;
    }

    let currentContent = fileContent;

    for (const block of blocks) {
        const applyResult = applySingleBlock(currentContent, block);

        if (applyResult.success) {
            currentContent = applyResult.newContent;
            result.appliedBlocks++;
        } else {
            result.failedBlocks.push(block);
            result.errors.push(applyResult.error || 'Unknown error applying block');
            // Continue trying other blocks - partial success is better than total failure
        }
    }

    result.newContent = currentContent;
    result.success = result.failedBlocks.length === 0;

    return result;
}

/**
 * Check if text contains SEARCH/REPLACE blocks (for auto-detection)
 */
export function containsSearchReplaceBlocks(text: string): boolean {
    return text.includes('<<<<<<< SEARCH') &&
        text.includes('=======') &&
        text.includes('>>>>>>> REPLACE');
}

/**
 * Extract file path from LLM response that may include it before the diff
 * Format: "path/to/file.ts" or [path/to/file.ts] before the SEARCH block
 */
export function extractFilePath(text: string): string | null {
    // Look for path before the first SEARCH marker
    const searchIndex = text.indexOf('<<<<<<< SEARCH');
    if (searchIndex === -1) return null;

    const textBefore = text.slice(0, searchIndex);

    // Try to find a file path pattern
    const patterns = [
        /(?:^|\n)([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\s*$/m,  // path/to/file.ext
        /\[([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\]/,           // [path/to/file.ext]
        /`([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)`/              // `path/to/file.ext`
    ];

    for (const pattern of patterns) {
        const match = textBefore.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}
