/**
 * DiffLogger - Structured file-based logging for diff diagnostics
 * 
 * Captures detailed information about diff parsing, validation, and matching
 * to help diagnose malformed diffs from LLMs.
 * 
 * Log format: JSON Lines (.jsonl) for easy parsing
 * Location: <workspaceRoot>/.antigravity/logs/diff-diagnostics-YYYY-MM-DD.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';

export type DiffLogType =
    | 'DIFF_RECEIVED'      // Raw diff content as received
    | 'DIFF_PARSE'         // Parsing attempt and results
    | 'DIFF_VALIDATE'      // Validation check results
    | 'DIFF_MATCH_ATTEMPT' // Each matching strategy tried
    | 'DIFF_MATCH_FAIL'    // Match failure with similarity analysis
    | 'DIFF_RESULT';       // Final apply result

export interface DiffLogEntry {
    timestamp: string;
    type: DiffLogType;
    taskId?: string;
    filePath?: string;
    data: Record<string, any>;
}

export interface ValidationIssue {
    code: string;
    message: string;
    severity: 'error' | 'warning';
    blockIndex?: number;
}

export class DiffLogger {
    private static instance: DiffLogger | null = null;
    private logDir: string;
    private currentLogFile: string | null = null;
    private enabled: boolean = true;

    private constructor(workspaceRoot: string) {
        this.logDir = path.join(workspaceRoot, '.antigravity', 'logs');
        this.ensureLogDir();
    }

    /**
     * Get or create singleton instance
     */
    public static getInstance(workspaceRoot?: string): DiffLogger {
        if (!DiffLogger.instance && workspaceRoot) {
            DiffLogger.instance = new DiffLogger(workspaceRoot);
        }
        if (!DiffLogger.instance) {
            throw new Error('DiffLogger not initialized. Call with workspaceRoot first.');
        }
        return DiffLogger.instance;
    }

    /**
     * Reset instance (useful for testing)
     */
    public static reset(): void {
        DiffLogger.instance = null;
    }

    private ensureLogDir(): void {
        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
        } catch (e) {
            console.error('[DiffLogger] Failed to create log directory:', e);
            this.enabled = false;
        }
    }

    private getLogFilePath(): string {
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        return path.join(this.logDir, `diff-diagnostics-${date}.jsonl`);
    }

    /**
     * Write a log entry to the current day's log file
     */
    public log(entry: DiffLogEntry): void {
        if (!this.enabled) return;

        try {
            const logFile = this.getLogFilePath();
            const line = JSON.stringify(entry) + '\n';
            fs.appendFileSync(logFile, line, 'utf8');
        } catch (e) {
            console.error('[DiffLogger] Failed to write log:', e);
        }
    }

    /**
     * Log raw diff content as received from LLM
     */
    public logDiffReceived(taskId: string | undefined, filePath: string, rawDiff: string, source: string): void {
        this.log({
            timestamp: new Date().toISOString(),
            type: 'DIFF_RECEIVED',
            taskId,
            filePath,
            data: {
                source, // 'CopilotClaude' | 'CopilotGPT' | etc.
                rawDiffLength: rawDiff.length,
                rawDiff: rawDiff,
                containsSearchMarker: rawDiff.includes('<<<<<<< SEARCH'),
                containsReplaceMarker: rawDiff.includes('>>>>>>> REPLACE'),
                containsSeparator: rawDiff.includes('======='),
                lineCount: rawDiff.split('\n').length
            }
        });
    }

    /**
     * Log parsed blocks with metadata
     */
    public logDiffParsed(
        taskId: string | undefined,
        filePath: string,
        blocks: Array<{ searchContent: string; replaceContent: string; lineNumber?: number }>,
        parseTimeMs: number
    ): void {
        this.log({
            timestamp: new Date().toISOString(),
            type: 'DIFF_PARSE',
            taskId,
            filePath,
            data: {
                blockCount: blocks.length,
                parseTimeMs,
                blocks: blocks.map((b, i) => ({
                    index: i,
                    lineNumber: b.lineNumber,
                    searchLength: b.searchContent.length,
                    replaceLength: b.replaceContent.length,
                    searchPreview: b.searchContent.substring(0, 100),
                    replacePreview: b.replaceContent.substring(0, 100),
                    searchContent: b.searchContent,
                    replaceContent: b.replaceContent,
                    searchLineCount: b.searchContent.split('\n').length,
                    replaceLineCount: b.replaceContent.split('\n').length
                }))
            }
        });
    }

    /**
     * Log validation results
     */
    public logValidation(
        taskId: string | undefined,
        filePath: string,
        issues: ValidationIssue[]
    ): void {
        this.log({
            timestamp: new Date().toISOString(),
            type: 'DIFF_VALIDATE',
            taskId,
            filePath,
            data: {
                issueCount: issues.length,
                hasErrors: issues.some(i => i.severity === 'error'),
                hasWarnings: issues.some(i => i.severity === 'warning'),
                issues
            }
        });
    }

    /**
     * Log a match attempt
     */
    public logMatchAttempt(
        taskId: string | undefined,
        filePath: string,
        blockIndex: number,
        strategy: 'exact' | 'normalized_crlf' | 'trimmed_lines',
        success: boolean,
        details: Record<string, any>
    ): void {
        this.log({
            timestamp: new Date().toISOString(),
            type: 'DIFF_MATCH_ATTEMPT',
            taskId,
            filePath,
            data: {
                blockIndex,
                strategy,
                success,
                ...details
            }
        });
    }

    /**
     * Log match failure with similarity analysis
     */
    public logMatchFailure(
        taskId: string | undefined,
        filePath: string,
        blockIndex: number,
        searchContent: string,
        fileContent: string,
        bestMatch: { text: string; similarity: number; position: number } | null
    ): void {
        this.log({
            timestamp: new Date().toISOString(),
            type: 'DIFF_MATCH_FAIL',
            taskId,
            filePath,
            data: {
                blockIndex,
                searchContent,
                searchLength: searchContent.length,
                fileContentLength: fileContent.length,
                fileContent, // Full file content for diagnosis
                bestMatch: bestMatch ? {
                    text: bestMatch.text,
                    similarity: bestMatch.similarity,
                    position: bestMatch.position,
                    positionLine: fileContent.substring(0, bestMatch.position).split('\n').length
                } : null
            }
        });
    }

    /**
     * Log final apply result
     */
    public logResult(
        taskId: string | undefined,
        filePath: string,
        success: boolean,
        appliedBlocks: number,
        totalBlocks: number,
        errors: string[]
    ): void {
        this.log({
            timestamp: new Date().toISOString(),
            type: 'DIFF_RESULT',
            taskId,
            filePath,
            data: {
                success,
                appliedBlocks,
                totalBlocks,
                failedBlocks: totalBlocks - appliedBlocks,
                errors
            }
        });
    }

    /**
     * Get log directory path (for UI display)
     */
    public getLogDirectory(): string {
        return this.logDir;
    }
}

/**
 * Validate a diff block for common issues
 */
export function validateDiffBlock(
    searchContent: string,
    replaceContent: string,
    blockIndex: number
): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for empty search content
    if (!searchContent || searchContent.trim() === '') {
        issues.push({
            code: 'EMPTY_SEARCH',
            message: 'SEARCH block is empty',
            severity: 'error',
            blockIndex
        });
    }

    // Check for nested SEARCH/REPLACE markers (malformed diff)
    if (searchContent.includes('<<<<<<< SEARCH') || searchContent.includes('>>>>>>> REPLACE')) {
        issues.push({
            code: 'NESTED_MARKERS',
            message: 'SEARCH content contains SEARCH/REPLACE markers - likely malformed diff',
            severity: 'error',
            blockIndex
        });
    }

    if (replaceContent.includes('<<<<<<< SEARCH') || replaceContent.includes('>>>>>>> REPLACE')) {
        issues.push({
            code: 'NESTED_MARKERS_REPLACE',
            message: 'REPLACE content contains SEARCH/REPLACE markers - likely malformed diff',
            severity: 'error',
            blockIndex
        });
    }

    // Check for JSON artifacts (model outputting in wrong format)
    if (searchContent.includes('"diff":') || searchContent.includes('```tool_call')) {
        issues.push({
            code: 'JSON_ARTIFACT',
            message: 'SEARCH content contains JSON tool_call syntax - wrong format used',
            severity: 'error',
            blockIndex
        });
    }

    // Check for markdown code fences inside content
    const fenceCount = (searchContent.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
        issues.push({
            code: 'UNBALANCED_FENCES',
            message: 'SEARCH content has unbalanced code fences',
            severity: 'warning',
            blockIndex
        });
    }

    // Check for suspiciously short search content (likely to match multiple places)
    if (searchContent.trim().length < 10 && searchContent.trim().length > 0) {
        issues.push({
            code: 'SHORT_SEARCH',
            message: 'SEARCH content is very short - may match multiple locations',
            severity: 'warning',
            blockIndex
        });
    }

    // Check for truncation indicators
    if (searchContent.includes('...') && searchContent.split('...').length > 2) {
        issues.push({
            code: 'POSSIBLE_TRUNCATION',
            message: 'SEARCH content contains multiple "..." - may be truncated',
            severity: 'warning',
            blockIndex
        });
    }

    return issues;
}

/**
 * Find the best matching substring in file content (for similarity analysis)
 * Uses a sliding window approach with Levenshtein distance
 */
export function findBestMatch(
    searchContent: string,
    fileContent: string,
    windowPadding: number = 50
): { text: string; similarity: number; position: number } | null {
    if (!searchContent || !fileContent) return null;

    const searchLines = searchContent.split('\n');
    const fileLines = fileContent.split('\n');

    // For performance, limit to first 5 lines of search for matching
    const searchFirstLines = searchLines.slice(0, 5).join('\n').trim();
    if (!searchFirstLines) return null;

    let bestMatch = { text: '', similarity: 0, position: 0 };

    // Slide through file looking for similar content
    for (let i = 0; i <= fileLines.length - Math.min(searchLines.length, 5); i++) {
        const windowLines = fileLines.slice(i, i + searchLines.length);
        const windowText = windowLines.join('\n');

        // Quick check: do first lines have any overlap?
        const windowFirstLines = windowLines.slice(0, 5).join('\n').trim();
        const similarity = calculateSimilarity(searchFirstLines, windowFirstLines);

        if (similarity > bestMatch.similarity) {
            // Calculate position in original file
            let position = 0;
            for (let j = 0; j < i; j++) {
                position += fileLines[j].length + 1;
            }

            bestMatch = {
                text: windowText.substring(0, searchContent.length + windowPadding),
                similarity,
                position
            };
        }
    }

    // Only return if we found something reasonably similar (>30%)
    return bestMatch.similarity > 0.3 ? bestMatch : null;
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses a simple token overlap approach for performance
 */
function calculateSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;

    // Tokenize by splitting on whitespace and special chars
    const tokensA = new Set(a.toLowerCase().split(/[\s\W]+/).filter(t => t.length > 2));
    const tokensB = new Set(b.toLowerCase().split(/[\s\W]+/).filter(t => t.length > 2));

    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const token of tokensA) {
        if (tokensB.has(token)) intersection++;
    }

    // Jaccard similarity
    const union = tokensA.size + tokensB.size - intersection;
    return union > 0 ? intersection / union : 0;
}
