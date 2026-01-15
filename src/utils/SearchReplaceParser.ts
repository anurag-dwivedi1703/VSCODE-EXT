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
    // CRITICAL: Use strict pattern to avoid capturing > from REPLACE marker
    // Require exactly 7 chevrons and mandatory newline before markers
    const blockPattern = /<<<<<<<[ ]*SEARCH[ ]*\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>[ ]*REPLACE/g;

    let match;
    while ((match = blockPattern.exec(text)) !== null) {
        let searchContent = match[1];
        let replaceContent = match[2];

        // CLEANUP: Strip any trailing > that may have leaked from marker parsing
        replaceContent = replaceContent.replace(/\n?>$/g, '');
        searchContent = searchContent.replace(/\n?>$/g, '');

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
        // Alternative pattern wrapped in code fences
        const altPattern = /```(?:diff|patch)?\s*\n<<<<<<<[ ]*SEARCH[ ]*\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>[ ]*REPLACE\s*\n```/g;

        while ((match = altPattern.exec(text)) !== null) {
            let searchContent = match[1];
            let replaceContent = match[2];

            // CLEANUP: Strip any trailing > that may have leaked
            replaceContent = replaceContent.replace(/\n?>$/g, '');
            searchContent = searchContent.replace(/\n?>$/g, '');

            blocks.push({
                searchContent,
                replaceContent,
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
 * Find search content in file, handling CRLF/LF differences
 * Returns the start index in the ORIGINAL content, or -1 if not found
 */
export function findSearchBlock(fileContent: string, searchContent: string): { index: number; matchLength: number } | null {
    // Strategy 1: Try exact match first (fastest)
    let index = fileContent.indexOf(searchContent);
    if (index !== -1) {
        return { index, matchLength: searchContent.length };
    }

    // Strategy 2: Normalize BOTH to LF and find match
    const normalizedFile = fileContent.replace(/\r\n/g, '\n');
    const normalizedSearch = searchContent.replace(/\r\n/g, '\n');

    const normalizedIndex = normalizedFile.indexOf(normalizedSearch);
    if (normalizedIndex !== -1) {
        // Found in normalized content - now find corresponding position in original
        // Count how many \r characters are before this position in original
        const originalIndex = convertNormalizedIndexToOriginal(fileContent, normalizedIndex);
        const matchLength = findMatchLengthInOriginal(fileContent, originalIndex, normalizedSearch);
        return { index: originalIndex, matchLength };
    }

    // Strategy 3: Line-by-line comparison with whitespace trimming
    const fileLines = fileContent.split(/\r?\n/);
    const searchLines = normalizedSearch.split('\n');

    for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
        let matches = true;
        for (let j = 0; j < searchLines.length; j++) {
            // Compare trimmed lines (handles trailing whitespace)
            if (fileLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
                matches = false;
                break;
            }
        }
        if (matches) {
            // Calculate character index in original content
            let charIndex = 0;
            for (let k = 0; k < i; k++) {
                charIndex += fileLines[k].length + (fileContent.includes('\r\n') ? 2 : 1);
            }
            // Calculate match length including line endings
            let matchLen = 0;
            for (let k = 0; k < searchLines.length; k++) {
                matchLen += fileLines[i + k].length;
                if (k < searchLines.length - 1) {
                    matchLen += fileContent.includes('\r\n') ? 2 : 1;
                }
            }
            return { index: charIndex, matchLength: matchLen };
        }
    }

    return null;
}

/**
 * Convert an index in normalized (LF-only) content to index in original (possibly CRLF) content
 */
function convertNormalizedIndexToOriginal(original: string, normalizedIndex: number): number {
    let originalIndex = 0;
    let normalizedPos = 0;

    while (normalizedPos < normalizedIndex && originalIndex < original.length) {
        if (original[originalIndex] === '\r' && original[originalIndex + 1] === '\n') {
            // CRLF counts as 1 in normalized but 2 in original
            originalIndex += 2;
            normalizedPos += 1;
        } else {
            originalIndex += 1;
            normalizedPos += 1;
        }
    }

    return originalIndex;
}

/**
 * Find the length of the match in original content given normalized search length
 */
function findMatchLengthInOriginal(original: string, startIndex: number, normalizedSearch: string): number {
    let originalLen = 0;
    let normalizedPos = 0;
    let i = startIndex;

    while (normalizedPos < normalizedSearch.length && i < original.length) {
        if (original[i] === '\r' && original[i + 1] === '\n' && normalizedSearch[normalizedPos] === '\n') {
            // CRLF in original matches LF in search
            originalLen += 2;
            normalizedPos += 1;
            i += 2;
        } else {
            originalLen += 1;
            normalizedPos += 1;
            i += 1;
        }
    }

    return originalLen;
}

/**
 * Apply a single SEARCH/REPLACE block to file content
 */
export function applySingleBlock(
    fileContent: string,
    block: SearchReplaceBlock
): { success: boolean; newContent: string; error?: string } {
    // Clean up search and replace content (remove any leaked > from regex)
    const cleanSearch = block.searchContent.replace(/\n?>$/g, '');
    const cleanReplace = block.replaceContent.replace(/\n?>$/g, '');

    const match = findSearchBlock(fileContent, cleanSearch);

    if (!match) {
        const searchPreview = cleanSearch.slice(0, 50).replace(/\n/g, '\\n');
        return {
            success: false,
            newContent: fileContent,
            error: `SEARCH block not found in file. Looking for: "${searchPreview}..."`
        };
    }

    // Perform the replacement
    const before = fileContent.slice(0, match.index);
    const after = fileContent.slice(match.index + match.matchLength);

    // Preserve original line ending style in replacement
    let finalReplace = cleanReplace;
    if (fileContent.includes('\r\n') && !cleanReplace.includes('\r\n')) {
        // Original uses CRLF, replacement uses LF - convert replacement to CRLF
        finalReplace = cleanReplace.replace(/\n/g, '\r\n');
    }

    return {
        success: true,
        newContent: before + finalReplace + after
    };
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
