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

import { DiffLogger, validateDiffBlock, ValidationIssue } from './DiffLogger';

export interface SearchReplaceBlock {
    searchContent: string;
    replaceContent: string;
    /** Line number in the diff output where this block started (for error reporting) */
    lineNumber?: number;
    /** Optional: Start line hint from @@ startLine-endLine @@ marker (1-indexed) */
    startLineHint?: number;
    /** Optional: End line hint from @@ startLine-endLine @@ marker (1-indexed) */
    endLineHint?: number;
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
 * Extract optional line hints from a SEARCH marker
 * Format: <<<<<<< SEARCH @@ 120-135 @@ or <<<<<<< SEARCH @@ 120 @@
 * @returns Object with startLine and endLine (1-indexed), or undefined if no hints
 */
export function extractLineHints(marker: string): { startLine?: number; endLine?: number } {
    // Pattern: @@ startLine-endLine @@ or @@ singleLine @@
    const rangeMatch = marker.match(/@@\s*(\d+)\s*-\s*(\d+)\s*@@/);
    if (rangeMatch) {
        return {
            startLine: parseInt(rangeMatch[1], 10),
            endLine: parseInt(rangeMatch[2], 10)
        };
    }

    // Single line hint: @@ lineNum @@
    const singleMatch = marker.match(/@@\s*(\d+)\s*@@/);
    if (singleMatch) {
        const line = parseInt(singleMatch[1], 10);
        return { startLine: line, endLine: line };
    }

    return {};
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

    // Pattern to match SEARCH/REPLACE blocks with optional line hints
    // CRITICAL: Use strict pattern to avoid capturing > from REPLACE marker
    // Require exactly 7 chevrons and mandatory newline before markers
    // Captures: [1] = full SEARCH marker (for extracting line hints), [2] = search content, [3] = replace content
    const blockPattern = /(<{7}[ ]*SEARCH[^\r\n]*)[ ]*\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>{7}[ ]*REPLACE/g;

    let match;
    while ((match = blockPattern.exec(text)) !== null) {
        const searchMarker = match[1];  // e.g., "<<<<<<< SEARCH @@ 120-135 @@"
        let searchContent = match[2];
        let replaceContent = match[3];

        // CLEANUP: Strip any trailing > that may have leaked from marker parsing
        replaceContent = replaceContent.replace(/\n?>$/g, '');
        searchContent = searchContent.replace(/\n?>$/g, '');

        // Calculate approximate line number for error reporting
        const precedingText = text.slice(0, match.index);
        const lineNumber = (precedingText.match(/\n/g) || []).length + 1;

        // Extract optional line hints from the SEARCH marker
        const lineHints = extractLineHints(searchMarker);

        blocks.push({
            searchContent,
            replaceContent,
            lineNumber,
            startLineHint: lineHints.startLine,
            endLineHint: lineHints.endLine
        });
    }

    // Also try alternative format (some models use slightly different markers)
    if (blocks.length === 0) {
        // Alternative pattern wrapped in code fences - also supports line hints
        const altPattern = /```(?:diff|patch)?\s*\n(<{7}[ ]*SEARCH[^\r\n]*)[ ]*\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>{7}[ ]*REPLACE\s*\n```/g;

        while ((match = altPattern.exec(text)) !== null) {
            const searchMarker = match[1];
            let searchContent = match[2];
            let replaceContent = match[3];

            // CLEANUP: Strip any trailing > that may have leaked
            replaceContent = replaceContent.replace(/\n?>$/g, '');
            searchContent = searchContent.replace(/\n?>$/g, '');

            // Extract optional line hints
            const lineHints = extractLineHints(searchMarker);

            blocks.push({
                searchContent,
                replaceContent,
                lineNumber: (text.slice(0, match.index).match(/\n/g) || []).length + 1,
                startLineHint: lineHints.startLine,
                endLineHint: lineHints.endLine
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
 * Normalize whitespace for comparison
 * - Converts tabs to spaces
 * - Trims trailing whitespace
 * - Normalizes line endings to LF
 */
export function normalizeForComparison(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\t/g, '  ')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n');
}

/**
 * Find search content in file, handling CRLF/LF differences and whitespace variations
 * Returns the start index in the ORIGINAL content, or -1 if not found
 * 
 * Matching strategies (in order):
 * 1. Exact match
 * 2. CRLF/LF normalized match
 * 3. Whitespace-normalized match (tabs, trailing spaces)
 * 4. Line-by-line trimmed comparison
 */
export function findSearchBlock(fileContent: string, searchContent: string): { index: number; matchLength: number; strategy: string } | null {
    // Strategy 1: Try exact match first (fastest)
    const index = fileContent.indexOf(searchContent);
    if (index !== -1) {
        return { index, matchLength: searchContent.length, strategy: 'exact' };
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
        return { index: originalIndex, matchLength, strategy: 'crlf-normalized' };
    }

    // Strategy 3: Full whitespace normalization (tabs + trailing spaces)
    const wsNormalizedFile = normalizeForComparison(fileContent);
    const wsNormalizedSearch = normalizeForComparison(searchContent);

    const wsIndex = wsNormalizedFile.indexOf(wsNormalizedSearch);
    if (wsIndex !== -1) {
        // Map back to original position
        const result = mapNormalizedIndexToOriginal(fileContent, wsNormalizedFile, wsIndex, wsNormalizedSearch.length);
        if (result) {
            return { ...result, strategy: 'whitespace-normalized' };
        }
    }

    // Strategy 4: Line-by-line comparison with whitespace trimming
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
            return { index: charIndex, matchLength: matchLen, strategy: 'line-trimmed' };
        }
    }

    // Strategy 5: Indentation-normalized (handles different base indentation)
    const result = findWithIndentationNormalization(fileContent, searchContent);
    if (result) {
        return { ...result, strategy: 'indent-normalized' };
    }

    return null;
}

/**
 * Map an index from normalized content back to original content
 */
function mapNormalizedIndexToOriginal(
    original: string,
    normalized: string,
    normalizedIndex: number,
    normalizedLength: number
): { index: number; matchLength: number } | null {
    // Find the line number in normalized content
    const normalizedLines = normalized.split('\n');
    const originalLines = original.replace(/\r\n/g, '\n').split('\n');

    let charCount = 0;
    let startLine = 0;
    for (let i = 0; i < normalizedLines.length; i++) {
        if (charCount + normalizedLines[i].length >= normalizedIndex) {
            startLine = i;
            break;
        }
        charCount += normalizedLines[i].length + 1;
    }

    // Count lines in the match
    charCount = 0;
    let endLine = startLine;
    for (let i = 0; i < normalizedLines.length; i++) {
        if (charCount >= normalizedIndex + normalizedLength) {
            endLine = Math.max(startLine, i - 1);
            break;
        }
        charCount += normalizedLines[i].length + 1;
        endLine = i;
    }

    // Calculate original position
    if (startLine < originalLines.length && endLine < originalLines.length) {
        let originalStart = 0;
        for (let i = 0; i < startLine; i++) {
            originalStart += originalLines[i].length + (original.includes('\r\n') ? 2 : 1);
        }

        let originalEnd = originalStart;
        for (let i = startLine; i <= endLine; i++) {
            originalEnd += originalLines[i].length + (original.includes('\r\n') ? 2 : 1);
        }
        originalEnd -= (original.includes('\r\n') ? 2 : 1);

        return { index: originalStart, matchLength: originalEnd - originalStart };
    }

    return null;
}

/**
 * Find match with indentation normalization
 * Handles cases where search and file have different base indentation
 */
function findWithIndentationNormalization(
    fileContent: string,
    searchContent: string
): { index: number; matchLength: number } | null {
    const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');
    const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');

    // Get the minimum indentation of search content
    const searchMinIndent = getMinIndent(searchLines);

    // Try to find a match by adjusting indentation
    for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
        const fileMinIndent = getMinIndent(fileLines.slice(i, i + searchLines.length));
        const indentDiff = fileMinIndent - searchMinIndent;

        let matches = true;
        for (let j = 0; j < searchLines.length; j++) {
            const searchLine = searchLines[j].replace(/\t/g, '  ');
            const fileLine = fileLines[i + j].replace(/\t/g, '  ');

            // Adjust search line indentation
            let adjustedSearch: string;
            if (searchLine.trim() === '') {
                adjustedSearch = '';
            } else if (indentDiff >= 0) {
                adjustedSearch = ' '.repeat(indentDiff) + searchLine;
            } else {
                // Remove indentation from search line
                const searchIndent = searchLine.match(/^\s*/)?.[0].length || 0;
                const removeCount = Math.min(searchIndent, -indentDiff);
                adjustedSearch = searchLine.slice(removeCount);
            }

            if (fileLine.trimEnd() !== adjustedSearch.trimEnd()) {
                matches = false;
                break;
            }
        }

        if (matches) {
            // Calculate position
            let charIndex = 0;
            for (let k = 0; k < i; k++) {
                charIndex += fileLines[k].length + (fileContent.includes('\r\n') ? 2 : 1);
            }
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
 * Get minimum indentation of non-empty lines
 */
function getMinIndent(lines: string[]): number {
    let minIndent = Infinity;
    for (const line of lines) {
        if (line.trim() === '') continue;
        const indent = line.replace(/\t/g, '  ').match(/^\s*/)?.[0].length || 0;
        minIndent = Math.min(minIndent, indent);
    }
    return minIndent === Infinity ? 0 : minIndent;
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
    if (searchIndex === -1) { return null; }

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

// ============================================
// FUZZY MATCHING SUPPORT
// ============================================

/**
 * Calculate Levenshtein distance between two strings
 * Returns the minimum number of single-character edits needed to transform a into b
 * 
 * @param a - First string
 * @param b - Second string
 * @returns Edit distance (lower = more similar)
 */
export function levenshteinDistance(a: string, b: string): number {
    // Edge cases
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Optimization: only keep two rows of the matrix
    let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
    let currRow = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
        currRow[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            currRow[j] = Math.min(
                prevRow[j] + 1,       // deletion
                currRow[j - 1] + 1,   // insertion
                prevRow[j - 1] + cost // substitution
            );
        }
        // Swap rows
        [prevRow, currRow] = [currRow, prevRow];
    }

    return prevRow[b.length];
}

/**
 * Calculate similarity ratio between two strings (0-1)
 * Uses Levenshtein distance normalized by max length
 * 
 * @returns Similarity between 0 (completely different) and 1 (identical)
 */
export function levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const distance = levenshteinDistance(a, b);
    const maxLen = Math.max(a.length, b.length);
    return 1 - (distance / maxLen);
}

export interface FuzzyMatchResult {
    /** Character index in the original file content */
    index: number;
    /** Length of the matched content in original file */
    matchLength: number;
    /** Similarity score between 0 and 1 */
    similarity: number;
    /** The actual matched text from the file */
    matchedText: string;
}

/**
 * Find a fuzzy match for search content in file content
 * Uses a sliding window approach with Levenshtein distance
 * 
 * Enhanced with:
 * - Adaptive window sizing (handles insertions/deletions)
 * - Whitespace normalization option
 * - Better performance for large files
 * 
 * @param fileContent - The full file content to search in
 * @param searchContent - The content to search for
 * @param tolerance - Maximum difference ratio allowed (default: 0.10 = 10%)
 * @returns Match result with position and similarity, or null if no good match found
 */
export function findFuzzyMatch(
    fileContent: string,
    searchContent: string,
    tolerance: number = 0.10
): FuzzyMatchResult | null {
    // Normalize line endings for comparison
    const normalizedFile = fileContent.replace(/\r\n/g, '\n');
    const normalizedSearch = searchContent.replace(/\r\n/g, '\n');

    // Split into lines for sliding window
    const fileLines = normalizedFile.split('\n');
    const searchLines = normalizedSearch.split('\n');

    // Calculate minimum similarity threshold
    const minSimilarity = 1 - tolerance;

    let bestMatch: FuzzyMatchResult | null = null;

    // Allow window size to vary slightly (handles added/removed lines)
    const windowVariance = Math.max(2, Math.ceil(searchLines.length * 0.15));
    const minWindowSize = Math.max(1, searchLines.length - windowVariance);
    const maxWindowSize = searchLines.length + windowVariance;

    // Slide through file looking for similar content
    for (let windowSize = searchLines.length; windowSize >= minWindowSize && windowSize <= maxWindowSize; windowSize++) {
        for (let i = 0; i <= fileLines.length - windowSize; i++) {
            // Build candidate string from file lines
            const candidateLines = fileLines.slice(i, i + windowSize);
            const candidate = candidateLines.join('\n');

            // Quick length check - if lengths differ too much, skip
            const lengthRatio = Math.min(candidate.length, normalizedSearch.length) /
                Math.max(candidate.length, normalizedSearch.length);
            if (lengthRatio < minSimilarity * 0.7) {
                continue;
            }

            // Quick first-line check for performance (skip if first lines are very different)
            if (searchLines.length > 0 && candidateLines.length > 0) {
                const firstLineSim = levenshteinSimilarity(searchLines[0].trim(), candidateLines[0].trim());
                if (firstLineSim < 0.5) {
                    continue; // First lines too different, skip this window
                }
            }

            // Calculate similarity
            const similarity = levenshteinSimilarity(normalizedSearch, candidate);

            if (similarity >= minSimilarity && (!bestMatch || similarity > bestMatch.similarity)) {
                // Calculate character index in original file
                let charIndex = 0;
                for (let j = 0; j < i; j++) {
                    charIndex += fileLines[j].length + 1; // +1 for newline
                }

                // Adjust for CRLF if original has it
                if (fileContent.includes('\r\n')) {
                    charIndex += i; // Add back the \r characters
                }

                // Calculate match length in original content
                let matchLength = candidateLines.join('\n').length;
                if (fileContent.includes('\r\n')) {
                    matchLength += windowSize - 1; // Add \r for each line break
                }

                bestMatch = {
                    index: charIndex,
                    matchLength,
                    similarity,
                    matchedText: candidate
                };

                // Early exit on near-perfect match
                if (similarity > 0.99) {
                    return bestMatch;
                }
            }
        }

        // If we found a good match with exact window size, don't try other sizes
        if (bestMatch && bestMatch.similarity >= 0.95 && windowSize === searchLines.length) {
            break;
        }
    }

    return bestMatch;
}

/**
 * Get a human-readable description of the match quality
 */
export function describeFuzzyMatch(similarity: number): string {
    if (similarity >= 0.99) return 'near-perfect match';
    if (similarity >= 0.97) return 'very close match (minor whitespace/typo difference)';
    if (similarity >= 0.95) return 'close match (small edits detected)';
    if (similarity >= 0.90) return 'moderate match (some changes detected)';
    if (similarity >= 0.80) return 'partial match (significant differences)';
    return 'weak match (substantial differences)';
}
