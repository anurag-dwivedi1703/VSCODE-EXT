/**
 * DiffMatcher - Advanced code matching engine for reliable diff application
 * 
 * This module provides a multi-tier matching strategy designed to achieve
 * >98% success rate in applying diffs to large codebases:
 * 
 * Tier 1: Exact match (fastest)
 * Tier 2: Whitespace-normalized match (handles indentation/trailing spaces)
 * Tier 3: Line-by-line match with tolerance (handles minor per-line changes)
 * Tier 4: Anchor-based match (uses unique identifiers to narrow search)
 * Tier 5: Fuzzy match with constraints (last resort, tightly controlled)
 * 
 * @module DiffMatcher
 */

import * as vscode from 'vscode';

// ============================================
// TYPES
// ============================================

export interface MatchResult {
    /** Whether a match was found */
    found: boolean;
    /** The range in the document where the match was found */
    range?: vscode.Range;
    /** The strategy that found the match */
    strategy: MatchStrategy;
    /** Confidence score 0-1 */
    confidence: number;
    /** The actual text that was matched (may differ slightly from search) */
    matchedText?: string;
    /** Details about what differed (for diagnostics) */
    differenceDetails?: DifferenceDetail[];
}

export interface DifferenceDetail {
    lineNumber: number;
    type: 'whitespace' | 'content' | 'missing' | 'extra';
    expected: string;
    actual: string;
}

export type MatchStrategy =
    | 'exact'
    | 'whitespace-normalized'
    | 'line-tolerant'
    | 'anchor-based'
    | 'fuzzy-constrained'
    | 'none';

export interface MatchOptions {
    /** Maximum whitespace tolerance per line (default: true) */
    normalizeWhitespace?: boolean;
    /** Allow trailing whitespace differences (default: true) */
    ignoreTrailingWhitespace?: boolean;
    /** Allow leading whitespace/indentation differences (default: true) */
    ignoreLeadingWhitespace?: boolean;
    /** Allow blank line differences (default: true) */
    ignoreBlankLines?: boolean;
    /** Maximum lines that can differ for line-tolerant match (default: 2) */
    maxLineDifferences?: number;
    /** Line range hint (1-indexed) */
    lineRangeHint?: { start: number; end: number };
    /** Expand line range by this many lines (default: 20) */
    lineRangeExpansion?: number;
    /** Minimum confidence for fuzzy match (default: 0.85) */
    minFuzzyConfidence?: number;
    /** Use anchor-based search (default: true) */
    useAnchors?: boolean;
}

// ============================================
// WHITESPACE NORMALIZATION
// ============================================

/**
 * Normalize whitespace in a string for comparison
 * - Converts tabs to spaces (2 spaces per tab)
 * - Removes trailing whitespace from each line
 * - Normalizes line endings to LF
 * - Optionally removes leading whitespace (indentation)
 */
export function normalizeWhitespace(
    text: string,
    options: {
        removeLeading?: boolean;
        removeTrailing?: boolean;
        tabsToSpaces?: boolean;
        collapseBlankLines?: boolean;
    } = {}
): string {
    const {
        removeLeading = false,
        removeTrailing = true,
        tabsToSpaces = true,
        collapseBlankLines = false
    } = options;

    let result = text;

    // Normalize line endings first
    result = result.replace(/\r\n/g, '\n');

    // Convert tabs to spaces
    if (tabsToSpaces) {
        result = result.replace(/\t/g, '  ');
    }

    // Process line by line
    let lines = result.split('\n');

    lines = lines.map(line => {
        let processed = line;
        if (removeTrailing) {
            processed = processed.trimEnd();
        }
        if (removeLeading) {
            processed = processed.trimStart();
        }
        return processed;
    });

    // Collapse multiple blank lines into one
    if (collapseBlankLines) {
        const collapsed: string[] = [];
        let lastWasBlank = false;
        for (const line of lines) {
            const isBlank = line.trim() === '';
            if (isBlank && lastWasBlank) {
                continue;
            }
            collapsed.push(line);
            lastWasBlank = isBlank;
        }
        lines = collapsed;
    }

    return lines.join('\n');
}

/**
 * Compute the minimum indentation level of a code block
 */
export function getMinIndentation(text: string): number {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return 0;

    let minIndent = Infinity;
    for (const line of lines) {
        const match = line.match(/^(\s*)/);
        if (match) {
            const indent = match[1].replace(/\t/g, '  ').length;
            minIndent = Math.min(minIndent, indent);
        }
    }

    return minIndent === Infinity ? 0 : minIndent;
}

/**
 * Normalize indentation to a common base
 * Useful when search content has different base indentation than file
 */
export function normalizeIndentation(text: string): string {
    const minIndent = getMinIndentation(text);
    if (minIndent === 0) return text;

    const lines = text.split('\n');
    return lines.map(line => {
        if (line.trim().length === 0) return '';
        const expanded = line.replace(/\t/g, '  ');
        return expanded.slice(minIndent);
    }).join('\n');
}

// ============================================
// LINE HASH INDEX
// ============================================

/**
 * Line hash index for O(1) line lookups
 * Builds a map of normalized line content -> line numbers
 */
export class LineHashIndex {
    private lineMap: Map<string, number[]> = new Map();
    private lines: string[] = [];
    private normalizedLines: string[] = [];

    constructor(content: string) {
        this.lines = content.replace(/\r\n/g, '\n').split('\n');
        this.normalizedLines = this.lines.map(l => this.normalizeLine(l));

        // Build index
        for (let i = 0; i < this.normalizedLines.length; i++) {
            const normalized = this.normalizedLines[i];
            const existing = this.lineMap.get(normalized);
            if (existing) {
                existing.push(i);
            } else {
                this.lineMap.set(normalized, [i]);
            }
        }
    }

    private normalizeLine(line: string): string {
        return line.replace(/\t/g, '  ').trim().toLowerCase();
    }

    /**
     * Find all line numbers where a line appears (0-indexed)
     */
    findLine(line: string): number[] {
        const normalized = this.normalizeLine(line);
        return this.lineMap.get(normalized) || [];
    }

    /**
     * Find sequences of lines that match
     * Returns starting line numbers of potential matches
     */
    findSequenceStart(searchLines: string[]): number[] {
        if (searchLines.length === 0) return [];

        // Find all positions where first line matches
        const firstLineMatches = this.findLine(searchLines[0]);
        if (firstLineMatches.length === 0) return [];

        // For each potential start, verify remaining lines
        const validStarts: number[] = [];
        for (const start of firstLineMatches) {
            if (start + searchLines.length > this.lines.length) continue;

            let matches = true;
            for (let i = 1; i < searchLines.length && matches; i++) {
                const fileNorm = this.normalizedLines[start + i];
                const searchNorm = this.normalizeLine(searchLines[i]);
                // Allow blank lines to match any blank line
                if (searchNorm === '' && fileNorm === '') continue;
                if (fileNorm !== searchNorm) matches = false;
            }

            if (matches) {
                validStarts.push(start);
            }
        }

        return validStarts;
    }

    /**
     * Get original line content
     */
    getLine(index: number): string {
        return this.lines[index] || '';
    }

    /**
     * Get total line count
     */
    get lineCount(): number {
        return this.lines.length;
    }
}

// ============================================
// ANCHOR EXTRACTION
// ============================================

/**
 * Extract unique anchor identifiers from code
 * These are used to narrow down the search range
 */
export function extractAnchors(code: string): string[] {
    const anchors: string[] = [];
    const seen = new Set<string>();

    // Patterns for unique identifiers
    const patterns = [
        // Function/method declarations
        /(?:function|def|async)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
        // Class declarations
        /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        // Const/let/var with arrow functions or values
        /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
        // Interface/type declarations
        /(?:interface|type)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        // Method names (TypeScript/JS class methods)
        /^\s*(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*[:{]/gm,
        // Export declarations
        /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        // Python decorators (unique)
        /@([a-zA-Z_][a-zA-Z0-9_]*)/g,
        // Unique string literals (>10 chars, likely unique)
        /['"]([a-zA-Z][a-zA-Z0-9_\s-]{10,})['"]/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) {
            const anchor = match[1];
            if (anchor && !seen.has(anchor) && anchor.length > 2) {
                seen.add(anchor);
                anchors.push(anchor);
            }
        }
    }

    return anchors;
}

/**
 * Score how unique an anchor is within a document
 */
export function scoreAnchorUniqueness(anchor: string, document: vscode.TextDocument): number {
    const text = document.getText();
    const regex = new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const matches = text.match(regex);
    const count = matches ? matches.length : 0;

    if (count === 0) return 0;
    if (count === 1) return 1.0;
    if (count === 2) return 0.8;
    if (count <= 5) return 0.5;
    return 0.2;
}

// ============================================
// DIFF MATCHER CLASS
// ============================================

export class DiffMatcher {
    private lineIndex: LineHashIndex | null = null;
    private documentText: string = '';
    private document: vscode.TextDocument | null = null;

    /**
     * Initialize matcher with document
     */
    async initialize(document: vscode.TextDocument): Promise<void> {
        this.document = document;
        this.documentText = document.getText();
        this.lineIndex = new LineHashIndex(this.documentText);
    }

    /**
     * Main entry point: Find the best match for search content
     * Tries multiple strategies in order of reliability
     */
    async findMatch(
        searchContent: string,
        options: MatchOptions = {}
    ): Promise<MatchResult> {
        if (!this.document || !this.lineIndex) {
            return { found: false, strategy: 'none', confidence: 0 };
        }

        const {
            normalizeWhitespace: normalizeWs = true,
            ignoreTrailingWhitespace = true,
            ignoreLeadingWhitespace = false,
            lineRangeHint,
            lineRangeExpansion = 20,
            minFuzzyConfidence = 0.85,
            useAnchors = true,
            maxLineDifferences = 2
        } = options;

        // Tier 1: Exact match
        const exactResult = this.findExactMatch(searchContent);
        if (exactResult.found) {
            return exactResult;
        }

        // Tier 2: Whitespace-normalized match
        if (normalizeWs) {
            const normalizedResult = this.findWhitespaceNormalizedMatch(
                searchContent,
                { ignoreTrailingWhitespace, ignoreLeadingWhitespace }
            );
            if (normalizedResult.found) {
                return normalizedResult;
            }
        }

        // Tier 3: Line-by-line match with tolerance
        const lineTolerantResult = this.findLineTolerantMatch(
            searchContent,
            maxLineDifferences,
            lineRangeHint ? {
                start: Math.max(0, lineRangeHint.start - 1 - lineRangeExpansion),
                end: Math.min(this.lineIndex.lineCount - 1, lineRangeHint.end - 1 + lineRangeExpansion)
            } : undefined
        );
        if (lineTolerantResult.found) {
            return lineTolerantResult;
        }

        // Tier 4: Anchor-based match
        if (useAnchors) {
            const anchorResult = await this.findAnchorBasedMatch(searchContent);
            if (anchorResult.found) {
                return anchorResult;
            }
        }

        // Tier 5: Constrained fuzzy match (last resort)
        const fuzzyResult = this.findConstrainedFuzzyMatch(
            searchContent,
            minFuzzyConfidence,
            lineRangeHint
        );
        if (fuzzyResult.found) {
            return fuzzyResult;
        }

        return { found: false, strategy: 'none', confidence: 0 };
    }

    /**
     * Tier 1: Exact match
     */
    private findExactMatch(searchContent: string): MatchResult {
        const index = this.documentText.indexOf(searchContent);
        if (index !== -1) {
            const startPos = this.document!.positionAt(index);
            const endPos = this.document!.positionAt(index + searchContent.length);
            return {
                found: true,
                range: new vscode.Range(startPos, endPos),
                strategy: 'exact',
                confidence: 1.0,
                matchedText: searchContent
            };
        }

        // Try with normalized line endings
        const normalizedDoc = this.documentText.replace(/\r\n/g, '\n');
        const normalizedSearch = searchContent.replace(/\r\n/g, '\n');
        const normalizedIndex = normalizedDoc.indexOf(normalizedSearch);

        if (normalizedIndex !== -1) {
            // Convert back to original document position
            const originalIndex = this.convertNormalizedIndex(normalizedIndex);
            const originalLength = this.getOriginalLength(originalIndex, normalizedSearch.length);

            const startPos = this.document!.positionAt(originalIndex);
            const endPos = this.document!.positionAt(originalIndex + originalLength);
            return {
                found: true,
                range: new vscode.Range(startPos, endPos),
                strategy: 'exact',
                confidence: 1.0,
                matchedText: this.documentText.substring(originalIndex, originalIndex + originalLength)
            };
        }

        return { found: false, strategy: 'exact', confidence: 0 };
    }

    /**
     * Tier 2: Whitespace-normalized match
     */
    private findWhitespaceNormalizedMatch(
        searchContent: string,
        options: { ignoreTrailingWhitespace: boolean; ignoreLeadingWhitespace: boolean }
    ): MatchResult {
        const { ignoreTrailingWhitespace, ignoreLeadingWhitespace } = options;

        // Normalize both search and document
        const normalizedSearch = normalizeWhitespace(searchContent, {
            removeTrailing: ignoreTrailingWhitespace,
            removeLeading: ignoreLeadingWhitespace,
            tabsToSpaces: true
        });

        const normalizedDoc = normalizeWhitespace(this.documentText, {
            removeTrailing: ignoreTrailingWhitespace,
            removeLeading: ignoreLeadingWhitespace,
            tabsToSpaces: true
        });

        const index = normalizedDoc.indexOf(normalizedSearch);
        if (index === -1) {
            return { found: false, strategy: 'whitespace-normalized', confidence: 0 };
        }

        // Map back to original document position
        // This is tricky because normalization may have changed character counts
        const range = this.mapNormalizedRangeToOriginal(
            normalizedDoc,
            index,
            normalizedSearch.length,
            { ignoreTrailingWhitespace, ignoreLeadingWhitespace }
        );

        if (range) {
            return {
                found: true,
                range,
                strategy: 'whitespace-normalized',
                confidence: 0.95,
                matchedText: this.document!.getText(range)
            };
        }

        return { found: false, strategy: 'whitespace-normalized', confidence: 0 };
    }

    /**
     * Tier 3: Line-by-line match with tolerance
     * Allows a small number of lines to differ
     */
    private findLineTolerantMatch(
        searchContent: string,
        maxDifferences: number,
        lineRange?: { start: number; end: number }
    ): MatchResult {
        const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');
        const docLines = this.documentText.replace(/\r\n/g, '\n').split('\n');

        const startLine = lineRange?.start ?? 0;
        const endLine = lineRange?.end ?? docLines.length - 1;

        let bestMatch: {
            startLine: number;
            differences: DifferenceDetail[];
            confidence: number;
        } | null = null;

        // Slide through document looking for matches
        for (let i = startLine; i <= endLine - searchLines.length + 1; i++) {
            const differences: DifferenceDetail[] = [];
            let totalDiff = 0;

            for (let j = 0; j < searchLines.length; j++) {
                const searchLine = searchLines[j];
                const docLine = docLines[i + j];

                // Normalize for comparison
                const normSearch = searchLine.replace(/\t/g, '  ').trimEnd();
                const normDoc = docLine.replace(/\t/g, '  ').trimEnd();

                if (normSearch !== normDoc) {
                    // Check if it's just whitespace difference
                    if (normSearch.trim() === normDoc.trim()) {
                        differences.push({
                            lineNumber: i + j,
                            type: 'whitespace',
                            expected: searchLine,
                            actual: docLine
                        });
                    } else {
                        totalDiff++;
                        differences.push({
                            lineNumber: i + j,
                            type: 'content',
                            expected: searchLine,
                            actual: docLine
                        });
                    }
                }
            }

            if (totalDiff <= maxDifferences) {
                const confidence = 1 - (totalDiff * 0.1) - (differences.length * 0.02);
                if (!bestMatch || confidence > bestMatch.confidence) {
                    bestMatch = { startLine: i, differences, confidence };
                }
            }
        }

        if (bestMatch && bestMatch.confidence >= 0.7) {
            // Calculate character range
            let startChar = 0;
            for (let i = 0; i < bestMatch.startLine; i++) {
                startChar += docLines[i].length + 1; // +1 for newline
            }
            // Adjust for CRLF
            if (this.documentText.includes('\r\n')) {
                startChar += bestMatch.startLine;
            }

            let endChar = startChar;
            for (let i = 0; i < searchLines.length; i++) {
                endChar += docLines[bestMatch.startLine + i].length + 1;
            }
            if (this.documentText.includes('\r\n')) {
                endChar += searchLines.length - 1;
            }
            endChar--; // Remove last newline

            const startPos = this.document!.positionAt(startChar);
            const endPos = this.document!.positionAt(endChar);

            return {
                found: true,
                range: new vscode.Range(startPos, endPos),
                strategy: 'line-tolerant',
                confidence: bestMatch.confidence,
                matchedText: this.document!.getText(new vscode.Range(startPos, endPos)),
                differenceDetails: bestMatch.differences
            };
        }

        return { found: false, strategy: 'line-tolerant', confidence: 0 };
    }

    /**
     * Tier 4: Anchor-based match
     * Uses unique identifiers to narrow search
     */
    private async findAnchorBasedMatch(searchContent: string): Promise<MatchResult> {
        if (!this.document) {
            return { found: false, strategy: 'anchor-based', confidence: 0 };
        }

        const anchors = extractAnchors(searchContent);
        if (anchors.length === 0) {
            return { found: false, strategy: 'anchor-based', confidence: 0 };
        }

        // Score anchors by uniqueness
        const scoredAnchors = anchors.map(anchor => ({
            anchor,
            score: scoreAnchorUniqueness(anchor, this.document!)
        })).filter(a => a.score > 0.3).sort((a, b) => b.score - a.score);

        if (scoredAnchors.length === 0) {
            return { found: false, strategy: 'anchor-based', confidence: 0 };
        }

        // Use best anchor to find candidate regions
        const bestAnchor = scoredAnchors[0];
        const anchorRegex = new RegExp(bestAnchor.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        
        let match;
        const candidates: { start: number; end: number }[] = [];
        
        while ((match = anchorRegex.exec(this.documentText)) !== null) {
            // Expand to include surrounding context
            const startPos = this.document.positionAt(match.index);
            const startLine = Math.max(0, startPos.line - 20);
            const endLine = Math.min(this.document.lineCount - 1, startPos.line + 50);
            
            candidates.push({ start: startLine, end: endLine });
        }

        // Search within each candidate region
        for (const candidate of candidates) {
            const result = this.findLineTolerantMatch(searchContent, 1, candidate);
            if (result.found) {
                return {
                    ...result,
                    strategy: 'anchor-based',
                    confidence: result.confidence * bestAnchor.score
                };
            }
        }

        return { found: false, strategy: 'anchor-based', confidence: 0 };
    }

    /**
     * Tier 5: Constrained fuzzy match
     * Only used as last resort with strict constraints
     */
    private findConstrainedFuzzyMatch(
        searchContent: string,
        minConfidence: number,
        lineRangeHint?: { start: number; end: number }
    ): MatchResult {
        const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');
        const docLines = this.documentText.replace(/\r\n/g, '\n').split('\n');

        // Use line hash index for faster searching
        const potentialStarts = this.lineIndex!.findSequenceStart(searchLines);

        let bestMatch: {
            start: number;
            similarity: number;
        } | null = null;

        // If we have potential starts from hash index, prioritize those
        const searchStarts = potentialStarts.length > 0
            ? potentialStarts
            : this.generateSearchStarts(docLines.length, searchLines.length, lineRangeHint);

        for (const start of searchStarts) {
            if (start + searchLines.length > docLines.length) continue;

            // Calculate line-by-line similarity
            let totalSimilarity = 0;
            for (let i = 0; i < searchLines.length; i++) {
                const searchLine = searchLines[i].trim();
                const docLine = docLines[start + i].trim();
                
                if (searchLine === docLine) {
                    totalSimilarity += 1;
                } else if (searchLine === '' || docLine === '') {
                    totalSimilarity += 0.5; // Partial credit for blank lines
                } else {
                    // Quick similarity check using token overlap
                    const similarity = this.quickLineSimilarity(searchLine, docLine);
                    totalSimilarity += similarity;
                }
            }

            const avgSimilarity = totalSimilarity / searchLines.length;

            if (avgSimilarity >= minConfidence && (!bestMatch || avgSimilarity > bestMatch.similarity)) {
                bestMatch = { start, similarity: avgSimilarity };
            }
        }

        if (bestMatch) {
            // Calculate range
            let startChar = 0;
            for (let i = 0; i < bestMatch.start; i++) {
                startChar += docLines[i].length + 1;
            }
            if (this.documentText.includes('\r\n')) {
                startChar += bestMatch.start;
            }

            let endChar = startChar;
            for (let i = 0; i < searchLines.length; i++) {
                endChar += docLines[bestMatch.start + i].length + 1;
            }
            if (this.documentText.includes('\r\n')) {
                endChar += searchLines.length - 1;
            }
            endChar--;

            const startPos = this.document!.positionAt(startChar);
            const endPos = this.document!.positionAt(endChar);

            return {
                found: true,
                range: new vscode.Range(startPos, endPos),
                strategy: 'fuzzy-constrained',
                confidence: bestMatch.similarity,
                matchedText: this.document!.getText(new vscode.Range(startPos, endPos))
            };
        }

        return { found: false, strategy: 'fuzzy-constrained', confidence: 0 };
    }

    /**
     * Generate search start positions, prioritizing line hint range
     */
    private generateSearchStarts(
        docLength: number,
        searchLength: number,
        lineRangeHint?: { start: number; end: number }
    ): number[] {
        const starts: number[] = [];
        const maxStart = docLength - searchLength;

        if (lineRangeHint) {
            // Search within hint range first
            const hintStart = Math.max(0, lineRangeHint.start - 1 - 30);
            const hintEnd = Math.min(maxStart, lineRangeHint.end - 1 + 30);
            
            for (let i = hintStart; i <= hintEnd; i++) {
                starts.push(i);
            }
        }

        // Then search rest of document
        for (let i = 0; i <= maxStart; i++) {
            if (!starts.includes(i)) {
                starts.push(i);
            }
        }

        return starts;
    }

    /**
     * Quick line similarity using token overlap
     */
    private quickLineSimilarity(a: string, b: string): number {
        if (a === b) return 1;
        if (!a || !b) return 0;

        const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 1));
        const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 1));

        if (tokensA.size === 0 || tokensB.size === 0) return 0;

        let intersection = 0;
        for (const token of tokensA) {
            if (tokensB.has(token)) intersection++;
        }

        const union = tokensA.size + tokensB.size - intersection;
        return union > 0 ? intersection / union : 0;
    }

    /**
     * Convert index from normalized (LF-only) to original content
     */
    private convertNormalizedIndex(normalizedIndex: number): number {
        let originalIndex = 0;
        let normalizedPos = 0;

        while (normalizedPos < normalizedIndex && originalIndex < this.documentText.length) {
            if (this.documentText[originalIndex] === '\r' && this.documentText[originalIndex + 1] === '\n') {
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
     * Get length in original content corresponding to normalized length
     */
    private getOriginalLength(startIndex: number, normalizedLength: number): number {
        let length = 0;
        let normalizedPos = 0;
        let i = startIndex;

        while (normalizedPos < normalizedLength && i < this.documentText.length) {
            if (this.documentText[i] === '\r' && this.documentText[i + 1] === '\n') {
                length += 2;
                normalizedPos += 1;
                i += 2;
            } else {
                length += 1;
                normalizedPos += 1;
                i += 1;
            }
        }

        return length;
    }

    /**
     * Map a range in normalized content back to original document
     */
    private mapNormalizedRangeToOriginal(
        normalizedDoc: string,
        normalizedStart: number,
        normalizedLength: number,
        _options: { ignoreTrailingWhitespace: boolean; ignoreLeadingWhitespace: boolean }
    ): vscode.Range | null {
        // For simple cases, use line-based mapping
        const normalizedLines = normalizedDoc.split('\n');
        const originalLines = this.documentText.replace(/\r\n/g, '\n').split('\n');

        // Find line number in normalized
        let charCount = 0;
        let startLine = 0;
        for (let i = 0; i < normalizedLines.length; i++) {
            if (charCount + normalizedLines[i].length >= normalizedStart) {
                startLine = i;
                break;
            }
            charCount += normalizedLines[i].length + 1;
        }

        // Calculate end line
        charCount = 0;
        let endLine = startLine;
        for (let i = 0; i < normalizedLines.length; i++) {
            if (charCount >= normalizedStart + normalizedLength) {
                endLine = Math.max(startLine, i - 1);
                break;
            }
            charCount += normalizedLines[i].length + 1;
            endLine = i;
        }

        // Find corresponding original lines
        if (startLine < originalLines.length && endLine < originalLines.length) {
            // Calculate character offsets in original
            let originalStart = 0;
            for (let i = 0; i < startLine; i++) {
                originalStart += originalLines[i].length + (this.documentText.includes('\r\n') ? 2 : 1);
            }

            let originalEnd = originalStart;
            for (let i = startLine; i <= endLine; i++) {
                originalEnd += originalLines[i].length + (this.documentText.includes('\r\n') ? 2 : 1);
            }
            originalEnd -= (this.documentText.includes('\r\n') ? 2 : 1); // Remove last line ending

            const startPos = this.document!.positionAt(originalStart);
            const endPos = this.document!.positionAt(originalEnd);
            return new vscode.Range(startPos, endPos);
        }

        return null;
    }
}

// ============================================
// SINGLETON
// ============================================

let _instance: DiffMatcher | null = null;

export function getDiffMatcher(): DiffMatcher {
    if (!_instance) {
        _instance = new DiffMatcher();
    }
    return _instance;
}

/**
 * Create a new DiffMatcher instance (for isolated use)
 */
export function createDiffMatcher(): DiffMatcher {
    return new DiffMatcher();
}
