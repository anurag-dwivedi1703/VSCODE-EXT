/**
 * FileDiscovery - Efficient file discovery using VS Code APIs
 * 
 * Uses workspace.findFiles for glob-based searches with automatic
 * exclusions respecting .gitignore and files.exclude settings.
 * 
 * @module FileDiscovery
 */

import * as vscode from 'vscode';

export interface DiscoveryResult {
    files: vscode.Uri[];
    truncated: boolean;
    totalFound: number;
}

export class FileDiscovery {
    /**
     * Find files matching a glob pattern
     * Automatically respects .gitignore and files.exclude settings
     * 
     * @param include - Glob pattern for files to include
     * @param exclude - Optional glob pattern for files to exclude
     * @param maxResults - Maximum number of results (default: 1000)
     */
    static async findFiles(
        include: string,
        exclude?: string,
        maxResults: number = 1000
    ): Promise<DiscoveryResult> {
        const files = await vscode.workspace.findFiles(include, exclude, maxResults + 1);

        return {
            files: files.slice(0, maxResults),
            truncated: files.length > maxResults,
            totalFound: Math.min(files.length, maxResults)
        };
    }

    /**
     * Find all source code files in workspace
     * Supports common languages: TS, JS, Python, Java, Go, Rust, C#, Ruby, PHP, C/C++
     */
    static async findSourceFiles(maxResults: number = 500): Promise<DiscoveryResult> {
        return this.findFiles(
            '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,kt,go,rs,cs,rb,php,cpp,c,h,hpp,swift,scala,vue,svelte}',
            '**/node_modules/**',
            maxResults
        );
    }

    /**
     * Find configuration files commonly used in projects
     */
    static async findConfigFiles(): Promise<DiscoveryResult> {
        return this.findFiles(
            '{package.json,tsconfig.json,*.config.{js,ts,mjs,cjs},pyproject.toml,Cargo.toml,go.mod,pom.xml,build.gradle,*.yaml,*.yml}',
            '**/node_modules/**',
            100
        );
    }

    /**
     * Find test files in the workspace
     */
    static async findTestFiles(): Promise<DiscoveryResult> {
        return this.findFiles(
            '**/*.{test,spec}.{ts,tsx,js,jsx,py}',
            '**/node_modules/**',
            200
        );
    }

    /**
     * Find files by extension
     * 
     * @param extensions - Array of extensions (without dot), e.g. ['ts', 'tsx']
     */
    static async findByExtension(
        extensions: string[],
        exclude?: string,
        maxResults: number = 500
    ): Promise<DiscoveryResult> {
        const pattern = `**/*.{${extensions.join(',')}}`;
        return this.findFiles(pattern, exclude || '**/node_modules/**', maxResults);
    }

    /**
     * Find files matching a filename pattern in a specific directory
     * 
     * @param dir - Directory path relative to workspace
     * @param pattern - Glob pattern for files
     */
    static async findInDirectory(
        dir: string,
        pattern: string = '*',
        maxResults: number = 100
    ): Promise<DiscoveryResult> {
        // Normalize path separators
        const normalizedDir = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const fullPattern = `${normalizedDir}/${pattern}`;
        return this.findFiles(fullPattern, undefined, maxResults);
    }

    /**
     * Check if a specific file exists in the workspace
     */
    static async fileExists(relativePath: string): Promise<boolean> {
        const result = await this.findFiles(relativePath, undefined, 1);
        return result.files.length > 0;
    }

    /**
     * Get workspace root(s)
     */
    static getWorkspaceRoots(): vscode.Uri[] {
        return vscode.workspace.workspaceFolders?.map(f => f.uri) || [];
    }

    /**
     * Find recently modified files (requires file system support)
     * Falls back to just finding all source files if modification time isn't available
     */
    static async findRecentlyModified(
        maxResults: number = 50,
        maxAgeDays: number = 7
    ): Promise<vscode.Uri[]> {
        const sourceFiles = await this.findSourceFiles(1000);
        const recentCutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

        const withStats: { uri: vscode.Uri; mtime: number }[] = [];

        for (const file of sourceFiles.files.slice(0, 500)) {
            try {
                const stat = await vscode.workspace.fs.stat(file);
                if (stat.mtime >= recentCutoff) {
                    withStats.push({ uri: file, mtime: stat.mtime });
                }
            } catch {
                // Skip files we can't stat
            }
        }

        // Sort by modification time, newest first
        withStats.sort((a, b) => b.mtime - a.mtime);

        return withStats.slice(0, maxResults).map(f => f.uri);
    }
}
