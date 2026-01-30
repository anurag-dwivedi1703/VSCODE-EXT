/**
 * SymbolNavigator - Symbol-aware code navigation using VS Code's Language Services
 * 
 * This module provides intelligent fallback matching by leveraging VS Code's
 * built-in language services to find code by symbol (function, class, variable) names.
 * 
 * When a SEARCH block fails to match because code has moved or changed slightly,
 * the SymbolNavigator can help locate the code by finding the relevant symbol.
 * 
 * @module SymbolNavigator
 */

import * as vscode from 'vscode';

export interface SymbolMatch {
    symbol: vscode.DocumentSymbol;
    /** The range of the symbol including some context lines */
    contextRange: vscode.Range;
    /** Confidence score 0-1 */
    confidence: number;
}

export class SymbolNavigator {
    /**
     * Get all symbols (functions, classes, variables) in a document
     * Uses VS Code's built-in document symbol provider
     */
    async getSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );
            return symbols || [];
        } catch (error) {
            console.warn('[SymbolNavigator] Failed to get symbols:', error);
            return [];
        }
    }

    /**
     * Flatten nested symbols into a single array
     */
    flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
        const result: vscode.DocumentSymbol[] = [];

        const flatten = (syms: vscode.DocumentSymbol[]) => {
            for (const sym of syms) {
                result.push(sym);
                if (sym.children && sym.children.length > 0) {
                    flatten(sym.children);
                }
            }
        };

        flatten(symbols);
        return result;
    }

    /**
     * Extract potential symbol names from a code snippet
     * Looks for function/class/variable declarations
     */
    extractSymbolNames(codeSnippet: string): string[] {
        const names: string[] = [];

        // TypeScript/JavaScript patterns
        const patterns = [
            // function declarations: function foo(
            /function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
            // arrow functions: const foo = (
            /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
            // class declarations: class Foo
            /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
            // method declarations: foo( or async foo(
            /^\s*(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*[:{]/gm,
            // interface/type: interface Foo, type Foo
            /(?:interface|type)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
            // Python patterns
            /def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
            /class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:(]/g,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(codeSnippet)) !== null) {
                if (match[1] && !names.includes(match[1])) {
                    names.push(match[1]);
                }
            }
        }

        return names;
    }

    /**
     * Find the symbol that best matches a code snippet
     * Returns the symbol and a confidence score
     */
    findMatchingSymbol(
        symbols: vscode.DocumentSymbol[],
        codeSnippet: string
    ): SymbolMatch | null {
        const flatSymbols = this.flattenSymbols(symbols);
        const extractedNames = this.extractSymbolNames(codeSnippet);

        if (extractedNames.length === 0) {
            return null;
        }

        // Find symbols that match any of the extracted names
        let bestMatch: { symbol: vscode.DocumentSymbol; confidence: number } | null = null;

        for (const name of extractedNames) {
            for (const symbol of flatSymbols) {
                if (symbol.name === name) {
                    // Exact match
                    const confidence = this.calculateConfidence(symbol, codeSnippet, name);
                    if (!bestMatch || confidence > bestMatch.confidence) {
                        bestMatch = { symbol, confidence };
                    }
                } else if (symbol.name.toLowerCase() === name.toLowerCase()) {
                    // Case-insensitive match (lower confidence)
                    const confidence = this.calculateConfidence(symbol, codeSnippet, name) * 0.8;
                    if (!bestMatch || confidence > bestMatch.confidence) {
                        bestMatch = { symbol, confidence };
                    }
                }
            }
        }

        if (!bestMatch) {
            return null;
        }

        return {
            symbol: bestMatch.symbol,
            contextRange: bestMatch.symbol.range,
            confidence: bestMatch.confidence
        };
    }

    /**
     * Calculate confidence score for a symbol match
     */
    private calculateConfidence(
        symbol: vscode.DocumentSymbol,
        codeSnippet: string,
        _matchedName: string
    ): number {
        let confidence = 0.5; // Base confidence for name match

        // Boost confidence based on symbol type
        const symbolKindBoosts: { [key: number]: number } = {
            [vscode.SymbolKind.Function]: 0.2,
            [vscode.SymbolKind.Method]: 0.2,
            [vscode.SymbolKind.Class]: 0.3,
            [vscode.SymbolKind.Interface]: 0.25,
        };

        confidence += symbolKindBoosts[symbol.kind] || 0.1;

        // Boost if the snippet contains unique identifiers from the symbol's detail
        if (symbol.detail && codeSnippet.includes(symbol.detail)) {
            confidence += 0.15;
        }

        // Cap at 1.0
        return Math.min(1.0, confidence);
    }

    /**
     * Get the range of a symbol plus some context lines
     */
    getSymbolRangeWithContext(
        document: vscode.TextDocument,
        symbol: vscode.DocumentSymbol,
        contextLinesBefore: number = 2,
        contextLinesAfter: number = 2
    ): vscode.Range {
        const startLine = Math.max(0, symbol.range.start.line - contextLinesBefore);
        const endLine = Math.min(document.lineCount - 1, symbol.range.end.line + contextLinesAfter);

        return new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length)
        );
    }

    /**
     * Find content near a matched symbol
     * This is the main fallback method - when direct text search fails,
     * we find the relevant symbol and search within its range
     */
    async findNearSymbol(
        document: vscode.TextDocument,
        searchContent: string,
        minConfidence: number = 0.5
    ): Promise<{ range: vscode.Range; symbol: vscode.DocumentSymbol; confidence: number } | null> {
        const symbols = await this.getSymbols(document.uri);
        if (symbols.length === 0) {
            return null;
        }

        const match = this.findMatchingSymbol(symbols, searchContent);
        if (!match || match.confidence < minConfidence) {
            return null;
        }

        // Get expanded range around the symbol
        const contextRange = this.getSymbolRangeWithContext(document, match.symbol, 5, 5);
        const rangeText = document.getText(contextRange);

        // Normalize and search within the symbol's range
        const normalizedRange = rangeText.replace(/\r\n/g, '\n');
        const normalizedSearch = searchContent.replace(/\r\n/g, '\n');

        const matchIndex = normalizedRange.indexOf(normalizedSearch);
        if (matchIndex === -1) {
            // Content not found even near symbol - return null
            return null;
        }

        // Calculate the actual range of the match
        const beforeMatch = normalizedRange.substring(0, matchIndex);
        const linesBeforeMatch = beforeMatch.split('\n').length - 1;
        const lastNewline = beforeMatch.lastIndexOf('\n');
        const column = lastNewline === -1 ? matchIndex : matchIndex - lastNewline - 1;

        const matchStartLine = contextRange.start.line + linesBeforeMatch;
        const matchLines = normalizedSearch.split('\n');
        const matchEndLine = matchStartLine + matchLines.length - 1;
        const matchEndColumn = matchLines.length === 1
            ? column + matchLines[0].length
            : matchLines[matchLines.length - 1].length;

        return {
            range: new vscode.Range(
                new vscode.Position(matchStartLine, column),
                new vscode.Position(matchEndLine, matchEndColumn)
            ),
            symbol: match.symbol,
            confidence: match.confidence
        };
    }
}

// Singleton instance
let _instance: SymbolNavigator | null = null;

export function getSymbolNavigator(): SymbolNavigator {
    if (!_instance) {
        _instance = new SymbolNavigator();
    }
    return _instance;
}
