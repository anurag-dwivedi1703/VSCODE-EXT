/**
 * FileSearch - Workspace-wide file content search
 * 
 * Provides efficient search capabilities across workspace files using
 * VS Code's workspace.findFiles and file system APIs.
 * 
 * @module FileSearch
 */

import * as vscode from 'vscode';

export interface SearchMatch {
    /** File URI where match was found */
    uri: vscode.Uri;
    /** Line number (1-indexed) */
    line: number;
    /** Column number (1-indexed) */
    column: number;
    /** The matched text */
    matchText: string;
    /** Preview of the line containing the match */
    linePreview: string;
}

export interface SearchOptions {
    /** Glob pattern for files to include (default: all files) */
    include?: string;
    /** Glob pattern for files to exclude (default: node_modules) */
    exclude?: string;
    /** Maximum number of results (default: 100) */
    maxResults?: number;
    /** Maximum files to search (default: 500) */
    maxFiles?: number;
    /** Case-sensitive search (default: false) */
    caseSensitive?: boolean;
    /** Use regex pattern (default: false) */
    isRegex?: boolean;
}

export class FileSearch {
    /**
     * Search for text pattern across workspace files
     * 
     * @param pattern - Text or regex pattern to search for
     * @param options - Search configuration options
     * @returns Array of search matches
     */
    static async search(
        pattern: string,
        options: SearchOptions = {}
    ): Promise<SearchMatch[]> {
        const {
            include = '**/*',
            exclude = '**/node_modules/**',
            maxResults = 100,
            maxFiles = 500,
            caseSensitive = false,
            isRegex = false
        } = options;

        const results: SearchMatch[] = [];

        // Build search regex
        let searchRegex: RegExp;
        try {
            if (isRegex) {
                searchRegex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
            } else {
                // Escape special regex characters for literal search
                const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                searchRegex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
            }
        } catch {
            // Invalid regex - return empty
            return [];
        }

        // Find files to search
        const files = await vscode.workspace.findFiles(include, exclude, maxFiles);

        // Search each file
        for (const file of files) {
            if (results.length >= maxResults) {
                break;
            }

            try {
                const document = await vscode.workspace.openTextDocument(file);
                const text = document.getText();
                const lines = text.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    searchRegex.lastIndex = 0; // Reset regex state

                    let match: RegExpExecArray | null;
                    while ((match = searchRegex.exec(line)) !== null) {
                        results.push({
                            uri: file,
                            line: i + 1,
                            column: match.index + 1,
                            matchText: match[0],
                            linePreview: line.trim().slice(0, 200)
                        });

                        if (results.length >= maxResults) {
                            return results;
                        }

                        // Prevent infinite loop for zero-length matches
                        if (match[0].length === 0) {
                            searchRegex.lastIndex++;
                        }
                    }
                }
            } catch {
                // Skip files that can't be opened (binary, etc.)
                continue;
            }
        }

        return results;
    }

    /**
     * Search for symbol/identifier references
     * 
     * @param symbolName - Name of the symbol to find
     * @param options - Search options
     */
    static async findReferences(
        symbolName: string,
        options: SearchOptions = {}
    ): Promise<SearchMatch[]> {
        // Use word boundary for more precise symbol matching
        const pattern = `\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        return this.search(pattern, { ...options, isRegex: true });
    }

    /**
     * Count occurrences of a pattern across workspace
     */
    static async countOccurrences(
        pattern: string,
        options: SearchOptions = {}
    ): Promise<{ count: number; fileCount: number }> {
        const results = await this.search(pattern, { ...options, maxResults: 10000 });
        const uniqueFiles = new Set(results.map(r => r.uri.toString()));
        return {
            count: results.length,
            fileCount: uniqueFiles.size
        };
    }

    /**
     * Find files containing all specified patterns
     * Useful for finding files that import multiple modules
     */
    static async findFilesWithAll(
        patterns: string[],
        options: SearchOptions = {}
    ): Promise<vscode.Uri[]> {
        if (patterns.length === 0) return [];

        // Search for first pattern
        const firstResults = await this.search(patterns[0], {
            ...options,
            maxResults: 1000
        });

        // Get unique files
        const candidateFiles = new Set(firstResults.map(r => r.uri.toString()));

        // Filter to files containing all patterns
        const matchingFiles: vscode.Uri[] = [];

        for (const fileStr of candidateFiles) {
            const uri = vscode.Uri.parse(fileStr);
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const content = doc.getText();

                let matchesAll = true;
                for (let i = 1; i < patterns.length; i++) {
                    if (!content.includes(patterns[i])) {
                        matchesAll = false;
                        break;
                    }
                }

                if (matchesAll) {
                    matchingFiles.push(uri);
                }
            } catch {
                continue;
            }
        }

        return matchingFiles;
    }

    /**
     * Find TODO/FIXME/HACK comments in the codebase
     */
    static async findTodos(
        options: SearchOptions = {}
    ): Promise<SearchMatch[]> {
        return this.search(
            '\\b(TODO|FIXME|HACK|XXX|BUG)\\b:?\\s*',
            { ...options, isRegex: true, include: '**/*.{ts,tsx,js,jsx,py,java,go,rs,c,cpp,h}' }
        );
    }

    /**
     * Search and replace preview (dry run)
     * Returns what would change without modifying files
     */
    static async previewReplace(
        searchPattern: string,
        replacement: string,
        options: SearchOptions = {}
    ): Promise<{ matches: SearchMatch[]; previewLines: string[] }> {
        const matches = await this.search(searchPattern, options);

        const previewLines = matches.map(m => {
            const replaced = m.linePreview.replace(
                new RegExp(searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                replacement
            );
            return `${vscode.workspace.asRelativePath(m.uri)}:${m.line}: ${replaced}`;
        });

        return { matches, previewLines };
    }
}
