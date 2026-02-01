/**
 * DiffRecovery - Intelligent diff recovery and diagnostic system
 * 
 * When a SEARCH block fails to match, this module provides:
 * 1. Diff-guided recovery: Analyzes differences and auto-corrects if trivial
 * 2. Diagnostic information: Detailed analysis of why the match failed
 * 3. Recovery suggestions: Ranked list of potential matches for user approval
 * 
 * @module DiffRecovery
 */

import * as vscode from 'vscode';
import { SearchReplaceBlock } from './SearchReplaceParser';
import { normalizeWhitespace, LineHashIndex } from './DiffMatcher';

// ============================================
// TYPES
// ============================================

export interface LineDiff {
    lineNumber: number;
    searchLine: string;
    fileLine: string;
    diffType: 'match' | 'whitespace' | 'content' | 'missing' | 'extra';
    /** For whitespace diffs, what specifically differs */
    whitespaceDetails?: {
        leadingDiff: boolean;
        trailingDiff: boolean;
        tabsVsSpaces: boolean;
    };
}

export interface RecoveryAnalysis {
    /** Whether recovery is possible */
    canRecover: boolean;
    /** Recovery method if possible */
    recoveryMethod?: 'whitespace-adjust' | 'line-reorder' | 'partial-match';
    /** Confidence in the recovery (0-1) */
    confidence: number;
    /** The adjusted search content that would match */
    adjustedSearch?: string;
    /** Line-by-line diff analysis */
    lineDiffs: LineDiff[];
    /** Summary of differences */
    summary: {
        totalLines: number;
        matchingLines: number;
        whitespaceDiffs: number;
        contentDiffs: number;
        missingLines: number;
        extraLines: number;
    };
    /** Human-readable explanation */
    explanation: string;
}

export interface RecoverySuggestion {
    /** The matched text from the file */
    matchedText: string;
    /** Range in the document */
    range: vscode.Range;
    /** Similarity score (0-1) */
    similarity: number;
    /** Line number where match starts (1-indexed) */
    startLine: number;
    /** What type of match this is */
    matchType: 'exact-adjusted' | 'whitespace-only' | 'near-match' | 'partial';
    /** Differences from the search content */
    differences: string[];
    /** Whether auto-recovery is recommended */
    autoRecoveryRecommended: boolean;
}

export interface DiagnosticReport {
    /** The search content that failed */
    searchContent: string;
    /** File path */
    filePath: string;
    /** Why the match failed */
    failureReason: string;
    /** Detailed analysis */
    analysis: RecoveryAnalysis;
    /** Recovery suggestions ranked by confidence */
    suggestions: RecoverySuggestion[];
    /** Whether any auto-recovery was applied */
    autoRecoveryApplied: boolean;
    /** The suggestion that was auto-applied (if any) */
    appliedSuggestion?: RecoverySuggestion;
}

// ============================================
// DIFF ANALYSIS
// ============================================

/**
 * Analyze line-by-line differences between search content and a file region
 */
export function analyzeLineDiffs(
    searchContent: string,
    fileContent: string,
    startLine: number = 0
): LineDiff[] {
    const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');
    const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');
    const diffs: LineDiff[] = [];

    const maxLines = Math.max(searchLines.length, fileLines.length);

    for (let i = 0; i < maxLines; i++) {
        const searchLine = i < searchLines.length ? searchLines[i] : undefined;
        const fileLine = i < fileLines.length ? fileLines[i] : undefined;

        if (searchLine === undefined) {
            // Extra line in file
            diffs.push({
                lineNumber: startLine + i,
                searchLine: '',
                fileLine: fileLine!,
                diffType: 'extra'
            });
        } else if (fileLine === undefined) {
            // Missing line in file
            diffs.push({
                lineNumber: startLine + i,
                searchLine: searchLine,
                fileLine: '',
                diffType: 'missing'
            });
        } else if (searchLine === fileLine) {
            // Exact match
            diffs.push({
                lineNumber: startLine + i,
                searchLine,
                fileLine,
                diffType: 'match'
            });
        } else {
            // Check if it's just whitespace difference
            const wsAnalysis = analyzeWhitespaceDiff(searchLine, fileLine);
            if (wsAnalysis.isWhitespaceOnly) {
                diffs.push({
                    lineNumber: startLine + i,
                    searchLine,
                    fileLine,
                    diffType: 'whitespace',
                    whitespaceDetails: wsAnalysis.details
                });
            } else {
                diffs.push({
                    lineNumber: startLine + i,
                    searchLine,
                    fileLine,
                    diffType: 'content'
                });
            }
        }
    }

    return diffs;
}

/**
 * Analyze if difference between two lines is whitespace-only
 */
function analyzeWhitespaceDiff(
    searchLine: string,
    fileLine: string
): {
    isWhitespaceOnly: boolean;
    details: { leadingDiff: boolean; trailingDiff: boolean; tabsVsSpaces: boolean };
} {
    // Normalize tabs to spaces for comparison
    const searchNorm = searchLine.replace(/\t/g, '  ');
    const fileNorm = fileLine.replace(/\t/g, '  ');

    // Check if content matches when trimmed
    const searchTrimmed = searchLine.trim();
    const fileTrimmed = fileLine.trim();

    if (searchTrimmed !== fileTrimmed) {
        // Not whitespace-only - actual content differs
        // But check if it's just tabs vs spaces in the content
        const searchContent = searchLine.replace(/\t/g, '  ').trim();
        const fileContent = fileLine.replace(/\t/g, '  ').trim();
        
        if (searchContent === fileContent) {
            return {
                isWhitespaceOnly: true,
                details: {
                    leadingDiff: false,
                    trailingDiff: false,
                    tabsVsSpaces: true
                }
            };
        }
        
        return {
            isWhitespaceOnly: false,
            details: { leadingDiff: false, trailingDiff: false, tabsVsSpaces: false }
        };
    }

    // Content matches - analyze whitespace differences
    const searchLeading = searchNorm.match(/^\s*/)?.[0] || '';
    const fileLeading = fileNorm.match(/^\s*/)?.[0] || '';
    const searchTrailing = searchNorm.match(/\s*$/)?.[0] || '';
    const fileTrailing = fileNorm.match(/\s*$/)?.[0] || '';

    return {
        isWhitespaceOnly: true,
        details: {
            leadingDiff: searchLeading !== fileLeading,
            trailingDiff: searchTrailing !== fileTrailing,
            tabsVsSpaces: searchLine.includes('\t') !== fileLine.includes('\t')
        }
    };
}

// ============================================
// RECOVERY ANALYSIS
// ============================================

/**
 * Analyze if recovery is possible for a failed search block
 */
export function analyzeRecovery(
    searchContent: string,
    fileContent: string,
    candidateStart: number
): RecoveryAnalysis {
    const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');
    const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');

    // Get the candidate region from file
    const candidateEnd = Math.min(candidateStart + searchLines.length, fileLines.length);
    const candidateRegion = fileLines.slice(candidateStart, candidateEnd).join('\n');

    // Analyze differences
    const lineDiffs = analyzeLineDiffs(searchContent, candidateRegion, candidateStart);

    // Count diff types
    const summary = {
        totalLines: searchLines.length,
        matchingLines: lineDiffs.filter(d => d.diffType === 'match').length,
        whitespaceDiffs: lineDiffs.filter(d => d.diffType === 'whitespace').length,
        contentDiffs: lineDiffs.filter(d => d.diffType === 'content').length,
        missingLines: lineDiffs.filter(d => d.diffType === 'missing').length,
        extraLines: lineDiffs.filter(d => d.diffType === 'extra').length
    };

    // Determine if recovery is possible
    let canRecover = false;
    let recoveryMethod: RecoveryAnalysis['recoveryMethod'];
    let confidence = 0;
    let explanation = '';
    let adjustedSearch: string | undefined;

    // Case 1: Only whitespace differences - high confidence recovery
    if (summary.contentDiffs === 0 && summary.missingLines === 0 && summary.extraLines === 0) {
        canRecover = true;
        recoveryMethod = 'whitespace-adjust';
        confidence = 0.95;
        explanation = `All ${summary.whitespaceDiffs} differing lines have only whitespace differences (indentation/trailing spaces)`;
        
        // Generate adjusted search that would match
        adjustedSearch = generateWhitespaceAdjustedSearch(searchLines, fileLines.slice(candidateStart, candidateEnd));
    }
    // Case 2: Minor content differences (1-2 lines)
    else if (summary.contentDiffs <= 2 && summary.missingLines === 0 && summary.extraLines === 0) {
        const contentMatchRatio = (summary.matchingLines + summary.whitespaceDiffs) / summary.totalLines;
        if (contentMatchRatio >= 0.8) {
            canRecover = true;
            recoveryMethod = 'partial-match';
            confidence = contentMatchRatio * 0.9;
            explanation = `${summary.contentDiffs} lines have content differences, but ${Math.round(contentMatchRatio * 100)}% of lines match`;
        } else {
            explanation = `Too many content differences (${summary.contentDiffs} lines, ${Math.round((1 - contentMatchRatio) * 100)}% different)`;
        }
    }
    // Case 3: Lines might be reordered or have insertions
    else if (summary.missingLines > 0 || summary.extraLines > 0) {
        // Check if it's a simple insertion/deletion
        if (summary.missingLines <= 1 && summary.extraLines <= 1 && summary.contentDiffs === 0) {
            canRecover = true;
            recoveryMethod = 'line-reorder';
            confidence = 0.7;
            explanation = `Minor line insertion/deletion detected (${summary.missingLines} missing, ${summary.extraLines} extra)`;
        } else {
            explanation = `Significant structural differences (${summary.missingLines} missing, ${summary.extraLines} extra lines)`;
        }
    } else {
        explanation = `Multiple content differences prevent automatic recovery`;
    }

    return {
        canRecover,
        recoveryMethod,
        confidence,
        adjustedSearch,
        lineDiffs,
        summary,
        explanation
    };
}

/**
 * Generate whitespace-adjusted search content to match file
 */
function generateWhitespaceAdjustedSearch(
    searchLines: string[],
    fileLines: string[]
): string {
    const adjusted: string[] = [];

    for (let i = 0; i < searchLines.length; i++) {
        if (i < fileLines.length) {
            // Use file's whitespace but verify content matches
            const searchTrimmed = searchLines[i].replace(/\t/g, '  ').trim();
            const fileTrimmed = fileLines[i].replace(/\t/g, '  ').trim();

            if (searchTrimmed === fileTrimmed) {
                // Content matches - use file's version
                adjusted.push(fileLines[i]);
            } else {
                // Content differs - keep search version
                adjusted.push(searchLines[i]);
            }
        } else {
            adjusted.push(searchLines[i]);
        }
    }

    return adjusted.join('\n');
}

// ============================================
// RECOVERY SUGGESTIONS
// ============================================

/**
 * Find recovery suggestions for a failed search block
 */
export async function findRecoverySuggestions(
    document: vscode.TextDocument,
    searchContent: string,
    maxSuggestions: number = 5
): Promise<RecoverySuggestion[]> {
    const suggestions: RecoverySuggestion[] = [];
    const fileContent = document.getText();
    const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');
    const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');

    // Build line hash index for efficient searching
    const lineIndex = new LineHashIndex(fileContent);

    // Strategy 1: Find exact first-line matches and analyze region
    const firstLineMatches = findFirstLineMatches(searchLines[0], fileLines);
    
    for (const startLine of firstLineMatches) {
        if (startLine + searchLines.length > fileLines.length) continue;

        const analysis = analyzeRecovery(searchContent, fileContent, startLine);
        
        if (analysis.canRecover || analysis.summary.matchingLines > searchLines.length * 0.5) {
            const endLine = startLine + searchLines.length - 1;
            const matchedText = fileLines.slice(startLine, startLine + searchLines.length).join('\n');
            
            const suggestion: RecoverySuggestion = {
                matchedText,
                range: new vscode.Range(
                    new vscode.Position(startLine, 0),
                    new vscode.Position(endLine, fileLines[endLine].length)
                ),
                similarity: (analysis.summary.matchingLines + analysis.summary.whitespaceDiffs * 0.9) / analysis.summary.totalLines,
                startLine: startLine + 1, // 1-indexed for user
                matchType: analysis.recoveryMethod === 'whitespace-adjust' ? 'whitespace-only' : 
                          analysis.canRecover ? 'near-match' : 'partial',
                differences: generateDifferencesSummary(analysis),
                autoRecoveryRecommended: analysis.canRecover && analysis.confidence >= 0.9
            };

            suggestions.push(suggestion);
        }
    }

    // Strategy 2: Sliding window search for similar content
    if (suggestions.length < maxSuggestions) {
        const windowSuggestions = findSlidingWindowMatches(
            searchContent,
            fileContent,
            fileLines,
            maxSuggestions - suggestions.length
        );
        
        // Add unique suggestions
        for (const suggestion of windowSuggestions) {
            const isDuplicate = suggestions.some(s => 
                Math.abs(s.startLine - suggestion.startLine) < 3
            );
            if (!isDuplicate) {
                suggestions.push(suggestion);
            }
        }
    }

    // Sort by similarity descending
    suggestions.sort((a, b) => b.similarity - a.similarity);

    return suggestions.slice(0, maxSuggestions);
}

/**
 * Find lines that match the first line of search
 */
function findFirstLineMatches(firstLine: string, fileLines: string[]): number[] {
    const matches: number[] = [];
    const searchNorm = firstLine.replace(/\t/g, '  ').trim();

    for (let i = 0; i < fileLines.length; i++) {
        const fileNorm = fileLines[i].replace(/\t/g, '  ').trim();
        
        // Exact trimmed match
        if (fileNorm === searchNorm) {
            matches.push(i);
            continue;
        }

        // Check for high similarity
        if (searchNorm.length > 10 && fileNorm.length > 10) {
            const similarity = calculateLineSimilarity(searchNorm, fileNorm);
            if (similarity > 0.8) {
                matches.push(i);
            }
        }
    }

    return matches;
}

/**
 * Calculate similarity between two lines using token overlap
 */
function calculateLineSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const tokensA = new Set(a.toLowerCase().split(/\W+/).filter(t => t.length > 1));
    const tokensB = new Set(b.toLowerCase().split(/\W+/).filter(t => t.length > 1));

    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const token of tokensA) {
        if (tokensB.has(token)) intersection++;
    }

    const union = tokensA.size + tokensB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Find matches using sliding window approach
 */
function findSlidingWindowMatches(
    searchContent: string,
    fileContent: string,
    fileLines: string[],
    maxSuggestions: number
): RecoverySuggestion[] {
    const suggestions: RecoverySuggestion[] = [];
    const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');

    // Create normalized versions for comparison
    const searchNorm = searchLines.map(l => l.replace(/\t/g, '  ').trim());

    for (let start = 0; start <= fileLines.length - searchLines.length; start++) {
        // Quick check: count matching lines
        let matchCount = 0;
        for (let i = 0; i < searchLines.length; i++) {
            const fileNorm = fileLines[start + i].replace(/\t/g, '  ').trim();
            if (fileNorm === searchNorm[i]) {
                matchCount++;
            }
        }

        const matchRatio = matchCount / searchLines.length;
        
        // Only consider if at least 50% lines match
        if (matchRatio >= 0.5) {
            const analysis = analyzeRecovery(searchContent, fileContent, start);
            const endLine = start + searchLines.length - 1;
            
            suggestions.push({
                matchedText: fileLines.slice(start, start + searchLines.length).join('\n'),
                range: new vscode.Range(
                    new vscode.Position(start, 0),
                    new vscode.Position(endLine, fileLines[endLine].length)
                ),
                similarity: matchRatio,
                startLine: start + 1,
                matchType: matchRatio >= 0.9 ? 'near-match' : 'partial',
                differences: generateDifferencesSummary(analysis),
                autoRecoveryRecommended: analysis.canRecover && analysis.confidence >= 0.9
            });

            if (suggestions.length >= maxSuggestions * 2) break; // Get extra for filtering
        }
    }

    return suggestions;
}

/**
 * Generate human-readable differences summary
 */
function generateDifferencesSummary(analysis: RecoveryAnalysis): string[] {
    const diffs: string[] = [];

    if (analysis.summary.whitespaceDiffs > 0) {
        const wsTypes: string[] = [];
        for (const diff of analysis.lineDiffs) {
            if (diff.diffType === 'whitespace' && diff.whitespaceDetails) {
                if (diff.whitespaceDetails.leadingDiff) wsTypes.push('indentation');
                if (diff.whitespaceDetails.trailingDiff) wsTypes.push('trailing spaces');
                if (diff.whitespaceDetails.tabsVsSpaces) wsTypes.push('tabs vs spaces');
            }
        }
        const unique = [...new Set(wsTypes)];
        if (unique.length > 0) {
            diffs.push(`Whitespace: ${unique.join(', ')} (${analysis.summary.whitespaceDiffs} lines)`);
        }
    }

    if (analysis.summary.contentDiffs > 0) {
        diffs.push(`Content differs: ${analysis.summary.contentDiffs} lines`);
    }

    if (analysis.summary.missingLines > 0) {
        diffs.push(`Missing: ${analysis.summary.missingLines} lines`);
    }

    if (analysis.summary.extraLines > 0) {
        diffs.push(`Extra: ${analysis.summary.extraLines} lines in file`);
    }

    return diffs;
}

// ============================================
// DIFF RECOVERY ENGINE
// ============================================

export class DiffRecoveryEngine {
    private document: vscode.TextDocument | null = null;

    /**
     * Initialize with a document
     */
    async initialize(document: vscode.TextDocument): Promise<void> {
        this.document = document;
    }

    /**
     * Attempt to recover a failed search block
     * Returns the range if recovery successful, null otherwise
     */
    async attemptRecovery(
        block: SearchReplaceBlock,
        options: {
            autoApplyWhitespace?: boolean;
            minConfidence?: number;
        } = {}
    ): Promise<{
        success: boolean;
        range?: vscode.Range;
        adjustedSearch?: string;
        report: DiagnosticReport;
    }> {
        const { autoApplyWhitespace = true, minConfidence = 0.85 } = options;

        if (!this.document) {
            throw new Error('DiffRecoveryEngine not initialized');
        }

        const fileContent = this.document.getText();
        const suggestions = await findRecoverySuggestions(
            this.document,
            block.searchContent,
            5
        );

        // Build diagnostic report
        const report: DiagnosticReport = {
            searchContent: block.searchContent,
            filePath: this.document.uri.fsPath,
            failureReason: suggestions.length === 0 
                ? 'No similar content found in file'
                : `Found ${suggestions.length} potential matches but none were exact`,
            analysis: suggestions.length > 0
                ? analyzeRecovery(block.searchContent, fileContent, suggestions[0].range.start.line)
                : {
                    canRecover: false,
                    confidence: 0,
                    lineDiffs: [],
                    summary: { totalLines: 0, matchingLines: 0, whitespaceDiffs: 0, contentDiffs: 0, missingLines: 0, extraLines: 0 },
                    explanation: 'No similar content found'
                },
            suggestions,
            autoRecoveryApplied: false
        };

        // Check for auto-recovery candidates
        const bestSuggestion = suggestions[0];
        if (bestSuggestion && autoApplyWhitespace) {
            // Auto-recover if it's whitespace-only with high confidence
            if (bestSuggestion.matchType === 'whitespace-only' && bestSuggestion.similarity >= minConfidence) {
                report.autoRecoveryApplied = true;
                report.appliedSuggestion = bestSuggestion;
                report.failureReason = 'Auto-recovered: whitespace-only differences';

                return {
                    success: true,
                    range: bestSuggestion.range,
                    adjustedSearch: bestSuggestion.matchedText,
                    report
                };
            }

            // Auto-recover if very high similarity
            if (bestSuggestion.autoRecoveryRecommended && bestSuggestion.similarity >= 0.95) {
                report.autoRecoveryApplied = true;
                report.appliedSuggestion = bestSuggestion;
                report.failureReason = 'Auto-recovered: near-perfect match';

                return {
                    success: true,
                    range: bestSuggestion.range,
                    adjustedSearch: bestSuggestion.matchedText,
                    report
                };
            }
        }

        return {
            success: false,
            report
        };
    }

    /**
     * Get diagnostic report without attempting recovery
     */
    async getDiagnostics(searchContent: string): Promise<DiagnosticReport> {
        if (!this.document) {
            throw new Error('DiffRecoveryEngine not initialized');
        }

        const suggestions = await findRecoverySuggestions(
            this.document,
            searchContent,
            5
        );

        const fileContent = this.document.getText();

        return {
            searchContent,
            filePath: this.document.uri.fsPath,
            failureReason: suggestions.length === 0
                ? 'No similar content found in file'
                : `Found ${suggestions.length} potential matches`,
            analysis: suggestions.length > 0
                ? analyzeRecovery(searchContent, fileContent, suggestions[0].range.start.line)
                : {
                    canRecover: false,
                    confidence: 0,
                    lineDiffs: [],
                    summary: { totalLines: 0, matchingLines: 0, whitespaceDiffs: 0, contentDiffs: 0, missingLines: 0, extraLines: 0 },
                    explanation: 'No similar content found'
                },
            suggestions,
            autoRecoveryApplied: false
        };
    }
}

// ============================================
// SINGLETON
// ============================================

let _instance: DiffRecoveryEngine | null = null;

export function getDiffRecoveryEngine(): DiffRecoveryEngine {
    if (!_instance) {
        _instance = new DiffRecoveryEngine();
    }
    return _instance;
}

export function createDiffRecoveryEngine(): DiffRecoveryEngine {
    return new DiffRecoveryEngine();
}
