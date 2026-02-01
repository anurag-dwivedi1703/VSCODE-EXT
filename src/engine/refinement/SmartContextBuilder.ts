/**
 * SmartContextBuilder.ts
 * Intelligent context gathering for Refinement Mode.
 * 
 * Uses VS Code's search APIs to find relevant files based on user's request,
 * then provides full content for highly relevant files and skeleton for others.
 * 
 * This eliminates the need for:
 * - Mid-session tool calls (which caused hangs)
 * - Users manually providing file contents
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { FileSearch, SearchMatch } from '../../utils/FileSearch';
import { skeletonizeFile } from './ContextSkeletonizer';

// Directories to always exclude from search
const EXCLUDED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
    'coverage', 'vendor', 'tmp', 'temp', '.cache', '.vscode', '.idea',
    '__pycache__', '.pytest_cache', 'venv', 'env', '.env',
    '.vibearchitect', '.antigravity', '.specify'
]);

// File patterns to exclude
const EXCLUDED_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/coverage/**',
    '**/*.min.js',
    '**/*.map',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/*.log'
];

// Token estimation: ~4 chars per token
const CHARS_PER_TOKEN = 4;

export interface SmartContext {
    /** Combined context string (full files + skeletons) */
    content: string;
    /** Number of files with full content */
    fullContentFiles: number;
    /** Number of files with skeleton only */
    skeletonFiles: number;
    /** Total estimated tokens */
    estimatedTokens: number;
    /** Files that were included with full content */
    relevantFiles: string[];
    /** Search keywords used */
    keywords: string[];
}

export interface RelevantFile {
    /** File URI */
    uri: vscode.Uri;
    /** Relative path from workspace root */
    relativePath: string;
    /** Number of keyword matches in file */
    matchCount: number;
    /** Relevance score (0-100) */
    score: number;
    /** File content (loaded on demand) */
    content?: string;
}

/**
 * SmartContextBuilder - Builds intelligent, targeted context for Refinement Mode.
 * 
 * IMPORTANT: Only searches within the specified workspace root.
 * Does NOT search other workspaces or the extension's own codebase.
 */
export class SmartContextBuilder {
    private workspaceRoot: string;

    constructor(workspaceRoot?: string) {
        // Default to first workspace folder if not specified
        const folders = vscode.workspace.workspaceFolders;
        this.workspaceRoot = workspaceRoot || (folders?.[0]?.uri.fsPath ?? '');
    }

    /**
     * Set the workspace root for context building.
     * MUST be called before buildContext() if workspace changes.
     */
    public setWorkspaceRoot(workspaceRoot: string): void {
        this.workspaceRoot = workspaceRoot;
        console.log(`[SmartContextBuilder] Workspace root set to: ${workspaceRoot}`);
    }

    /**
     * Check if a file path is within the current workspace root.
     * This is CRITICAL to prevent searching other workspaces.
     */
    private isWithinWorkspace(filePath: string): boolean {
        // Normalize paths for comparison
        const normalizedRoot = this.workspaceRoot.toLowerCase().replace(/\\/g, '/');
        const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
        return normalizedPath.startsWith(normalizedRoot);
    }

    /**
     * Build smart context based on user's feature request.
     * 
     * IMPORTANT: Only searches within this.workspaceRoot - NOT other workspaces.
     * 
     * @param userPrompt - The user's feature request
     * @param tokenBudget - Maximum tokens for context (default: 20000)
     * @param workspaceRoot - Optional override for workspace root
     * @returns SmartContext with full files for relevant matches + skeleton for structure
     */
    public async buildContext(
        userPrompt: string,
        tokenBudget: number = 20000,
        workspaceRoot?: string
    ): Promise<SmartContext> {
        // Update workspace root if provided
        if (workspaceRoot) {
            this.workspaceRoot = workspaceRoot;
        }

        console.log(`[SmartContextBuilder] Building context for workspace: ${this.workspaceRoot}`);
        console.log(`[SmartContextBuilder] Prompt (${userPrompt.length} chars), budget: ${tokenBudget} tokens`);

        if (!this.workspaceRoot) {
            console.warn('[SmartContextBuilder] No workspace root set - cannot search files');
            return this.buildEmptyContext();
        }

        // Step 1: Extract keywords from user's request
        const keywords = this.extractKeywords(userPrompt);
        console.log(`[SmartContextBuilder] Extracted keywords: ${keywords.join(', ')}`);

        if (keywords.length === 0) {
            // No keywords - fall back to skeleton-only approach
            return this.buildSkeletonOnlyContext(tokenBudget);
        }

        // Step 2: Search for files containing keywords (ONLY in current workspace)
        const relevantFiles = await this.searchRelevantFiles(keywords);
        console.log(`[SmartContextBuilder] Found ${relevantFiles.length} relevant files in ${this.workspaceRoot}`);

        // If no files match keywords, fall back to skeleton-only approach
        // This is IMPORTANT - a project may not contain any of the keywords
        // (e.g., asking for "login" in a game that has no auth)
        if (relevantFiles.length === 0) {
            console.log(`[SmartContextBuilder] No keyword matches - falling back to skeleton context`);
            return this.buildSkeletonOnlyContext(tokenBudget);
        }

        // Step 3: Rank files by relevance
        const rankedFiles = this.rankByRelevance(relevantFiles, keywords);

        // Step 4: Generate context with full content for top files + skeleton for rest
        const context = await this.generateContext(rankedFiles, tokenBudget, keywords);

        return context;
    }

    /**
     * Build empty context when no workspace is available.
     */
    private buildEmptyContext(): SmartContext {
        return {
            content: '(No workspace context available)',
            fullContentFiles: 0,
            skeletonFiles: 0,
            estimatedTokens: 10,
            relevantFiles: [],
            keywords: []
        };
    }

    /**
     * Extract meaningful keywords from user prompt.
     * Uses NLP-style extraction focusing on technical terms.
     */
    public extractKeywords(prompt: string): string[] {
        // Common words to exclude
        const stopWords = new Set([
            'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
            'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
            'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
            'into', 'through', 'during', 'before', 'after', 'above', 'below',
            'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
            'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
            'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that',
            'want', 'make', 'create', 'add', 'implement', 'build', 'feature',
            'like', 'new', 'use', 'using', 'also', 'when', 'how', 'what', 'which',
            'please', 'help', 'need', 'some', 'any', 'all', 'each', 'every',
            'file', 'files', 'code', 'project', 'app', 'application'
        ]);

        // Extract words
        const words = prompt.toLowerCase()
            .replace(/[^a-z0-9_\s-]/g, ' ')  // Keep underscores and hyphens (common in code)
            .split(/\s+/)
            .filter(word => word.length > 2 && !stopWords.has(word));

        // Extract potential identifiers (camelCase, PascalCase, snake_case)
        const identifiers = prompt.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)*|[a-z]+(?:_[a-z]+)+/g) || [];
        
        // Combine and deduplicate
        const allKeywords = [...new Set([...words, ...identifiers.map(i => i.toLowerCase())])];

        // Prioritize technical terms (containing common code patterns)
        const prioritized = allKeywords.sort((a, b) => {
            const aScore = this.getKeywordPriority(a);
            const bScore = this.getKeywordPriority(b);
            return bScore - aScore;
        });

        // Return top keywords (limit to prevent over-searching)
        return prioritized.slice(0, 10);
    }

    /**
     * Get priority score for a keyword based on technical relevance.
     */
    private getKeywordPriority(keyword: string): number {
        let score = 0;

        // Technical suffixes
        if (keyword.endsWith('service')) score += 10;
        if (keyword.endsWith('manager')) score += 10;
        if (keyword.endsWith('controller')) score += 10;
        if (keyword.endsWith('handler')) score += 8;
        if (keyword.endsWith('provider')) score += 8;
        if (keyword.endsWith('client')) score += 8;
        if (keyword.endsWith('api')) score += 7;
        if (keyword.endsWith('util') || keyword.endsWith('utils')) score += 5;
        if (keyword.endsWith('helper')) score += 5;
        if (keyword.endsWith('config')) score += 5;
        if (keyword.endsWith('type') || keyword.endsWith('types')) score += 4;
        if (keyword.endsWith('interface')) score += 4;
        if (keyword.endsWith('model')) score += 6;
        if (keyword.endsWith('schema')) score += 6;

        // Technical prefixes
        if (keyword.startsWith('auth')) score += 8;
        if (keyword.startsWith('user')) score += 6;
        if (keyword.startsWith('api')) score += 6;
        if (keyword.startsWith('http')) score += 5;
        if (keyword.startsWith('db') || keyword.startsWith('database')) score += 5;

        // Boost longer words (more specific)
        if (keyword.length > 8) score += 3;
        if (keyword.length > 12) score += 2;

        // Contains underscore (likely code identifier)
        if (keyword.includes('_')) score += 2;

        return score;
    }

    /**
     * Search for files containing the given keywords.
     * IMPORTANT: Only returns files within this.workspaceRoot.
     */
    public async searchRelevantFiles(keywords: string[]): Promise<RelevantFile[]> {
        const fileMatches = new Map<string, RelevantFile>();

        // Search for each keyword
        for (const keyword of keywords) {
            try {
                const matches = await FileSearch.search(keyword, {
                    include: '**/*.{ts,tsx,js,jsx,py,java,go,rs,cs,vue,svelte}',
                    exclude: EXCLUDED_PATTERNS.join(','),
                    maxResults: 100,  // Get more results to filter
                    maxFiles: 300,
                    caseSensitive: false
                });

                // Aggregate matches by file - ONLY if within current workspace
                for (const match of matches) {
                    const filePath = match.uri.fsPath;

                    // CRITICAL: Skip files outside the current workspace
                    if (!this.isWithinWorkspace(filePath)) {
                        continue;
                    }

                    const key = match.uri.toString();
                    // Calculate relative path from workspace root, not VS Code's default
                    const relativePath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');

                    // Skip excluded directories
                    if (this.isExcludedPath(relativePath)) {
                        continue;
                    }

                    if (fileMatches.has(key)) {
                        const existing = fileMatches.get(key)!;
                        existing.matchCount++;
                    } else {
                        fileMatches.set(key, {
                            uri: match.uri,
                            relativePath,
                            matchCount: 1,
                            score: 0
                        });
                    }
                }
            } catch (error) {
                console.warn(`[SmartContextBuilder] Search failed for keyword "${keyword}":`, error);
            }
        }

        console.log(`[SmartContextBuilder] Filtered to ${fileMatches.size} files within workspace`);
        return Array.from(fileMatches.values());
    }

    /**
     * Check if a path should be excluded.
     */
    private isExcludedPath(relativePath: string): boolean {
        const parts = relativePath.split(/[/\\]/);
        return parts.some(part => EXCLUDED_DIRS.has(part));
    }

    /**
     * Rank files by relevance to the user's request.
     */
    public rankByRelevance(files: RelevantFile[], keywords: string[]): RelevantFile[] {
        for (const file of files) {
            let score = file.matchCount * 10;  // Base score from matches

            const pathLower = file.relativePath.toLowerCase();

            // Path-based scoring
            if (pathLower.includes('src/')) score += 15;
            if (pathLower.includes('lib/')) score += 10;
            if (pathLower.includes('core/')) score += 12;
            if (pathLower.includes('services/')) score += 10;
            if (pathLower.includes('components/')) score += 8;
            if (pathLower.includes('utils/')) score += 5;
            if (pathLower.includes('api/')) score += 8;
            if (pathLower.includes('engine/')) score += 10;

            // Penalize test files (unless user asked about tests)
            const isTestRelated = keywords.some(k => k.includes('test') || k.includes('spec'));
            if (!isTestRelated && (pathLower.includes('test') || pathLower.includes('spec'))) {
                score -= 20;
            }

            // Penalize example/demo files
            if (pathLower.includes('example') || pathLower.includes('demo')) {
                score -= 15;
            }

            // Boost files with keyword in filename
            const fileName = path.basename(file.relativePath).toLowerCase();
            for (const keyword of keywords) {
                if (fileName.includes(keyword.toLowerCase())) {
                    score += 20;
                }
            }

            // Boost main entry points
            if (fileName === 'index.ts' || fileName === 'index.js') score += 5;
            if (fileName === 'main.ts' || fileName === 'main.js') score += 5;
            if (fileName === 'app.ts' || fileName === 'app.js') score += 5;

            file.score = Math.max(0, score);
        }

        // Sort by score descending
        return files.sort((a, b) => b.score - a.score);
    }

    /**
     * Generate the final context with full content for top files + skeleton for structure.
     */
    public async generateContext(
        rankedFiles: RelevantFile[],
        tokenBudget: number,
        keywords: string[]
    ): Promise<SmartContext> {
        const fullContentParts: string[] = [];
        const skeletonParts: string[] = [];
        let currentTokens = 0;

        // Reserve tokens for skeleton context (30% of budget)
        const fullContentBudget = Math.floor(tokenBudget * 0.7);
        const skeletonBudget = Math.floor(tokenBudget * 0.3);

        const relevantFilePaths: string[] = [];
        let fullContentCount = 0;
        let skeletonCount = 0;

        // Add full content for top relevant files
        for (const file of rankedFiles) {
            if (currentTokens >= fullContentBudget) {
                break;
            }

            // Skip files with very low scores
            if (file.score < 10) {
                continue;
            }

            try {
                const document = await vscode.workspace.openTextDocument(file.uri);
                const content = document.getText();
                const contentTokens = Math.ceil(content.length / CHARS_PER_TOKEN);

                // Skip very large files (>5000 tokens) - use skeleton instead
                if (contentTokens > 5000) {
                    const skeleton = skeletonizeFile(file.uri.fsPath);
                    if (skeleton) {
                        const skeletonTokens = Math.ceil(skeleton.length / CHARS_PER_TOKEN);
                        if (currentTokens + skeletonTokens <= fullContentBudget) {
                            skeletonParts.push(`## ${file.relativePath}\n\`\`\`\n${skeleton}\n\`\`\``);
                            currentTokens += skeletonTokens;
                            skeletonCount++;
                        }
                    }
                    continue;
                }

                // Check if we have budget for full content
                if (currentTokens + contentTokens <= fullContentBudget) {
                    fullContentParts.push(
                        `## ${file.relativePath} (Full Content - Score: ${file.score})\n` +
                        `\`\`\`${this.getLanguageId(file.relativePath)}\n${content}\n\`\`\``
                    );
                    currentTokens += contentTokens;
                    relevantFilePaths.push(file.relativePath);
                    fullContentCount++;

                    // Limit to top 10 full content files
                    if (fullContentCount >= 10) {
                        break;
                    }
                }
            } catch (error) {
                console.warn(`[SmartContextBuilder] Failed to read ${file.relativePath}:`, error);
            }
        }

        // Add skeleton for remaining structural context (if budget allows)
        if (currentTokens < tokenBudget) {
            const remainingBudget = Math.min(skeletonBudget, tokenBudget - currentTokens);
            const structuralSkeleton = await this.generateStructuralSkeleton(
                rankedFiles.slice(fullContentCount),
                remainingBudget
            );
            
            if (structuralSkeleton) {
                skeletonParts.push(`## Additional Project Structure (Signatures Only)\n${structuralSkeleton}`);
                skeletonCount += structuralSkeleton.split('---').length;
            }
        }

        // Combine all parts
        const allParts: string[] = [];

        if (fullContentParts.length > 0) {
            allParts.push('# Relevant Files (Full Content)\n\nThese files are most relevant to your request:\n');
            allParts.push(...fullContentParts);
        }

        if (skeletonParts.length > 0) {
            allParts.push('\n# Project Structure Overview (Signatures Only)\n\n');
            allParts.push(...skeletonParts);
        }

        const content = allParts.join('\n\n');
        const estimatedTokens = Math.ceil(content.length / CHARS_PER_TOKEN);

        console.log(`[SmartContextBuilder] Generated context: ${fullContentCount} full files, ${skeletonCount} skeleton files, ~${estimatedTokens} tokens`);

        return {
            content,
            fullContentFiles: fullContentCount,
            skeletonFiles: skeletonCount,
            estimatedTokens,
            relevantFiles: relevantFilePaths,
            keywords
        };
    }

    /**
     * Generate skeleton-only context when no keywords are found.
     * IMPORTANT: Only includes files within this.workspaceRoot.
     * 
     * This is the FALLBACK when keyword search finds nothing.
     * We MUST return something useful to the AI.
     */
    private async buildSkeletonOnlyContext(tokenBudget: number): Promise<SmartContext> {
        console.log(`[SmartContextBuilder] Building skeleton-only context for: ${this.workspaceRoot}`);

        const skeletonParts: string[] = [];
        const fileListing: string[] = [];
        let currentTokens = 0;

        try {
            // Create RelativePattern to search ONLY in the workspace root
            const workspaceFolder = vscode.workspace.workspaceFolders?.find(
                f => this.isWithinWorkspace(f.uri.fsPath) || f.uri.fsPath === this.workspaceRoot
            );
            
            // Use RelativePattern if we have a workspace folder, otherwise use glob
            const searchPattern = workspaceFolder 
                ? new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx,js,jsx,py,html,css,json}')
                : new vscode.RelativePattern(vscode.Uri.file(this.workspaceRoot), '**/*.{ts,tsx,js,jsx,py,html,css,json}');
            
            // Exclude pattern - must be a proper GlobPattern, not comma-separated
            const excludePattern = '**/node_modules/**';
            
            console.log(`[SmartContextBuilder] Searching with pattern in: ${this.workspaceRoot}`);
            
            const files = await vscode.workspace.findFiles(
                searchPattern,
                excludePattern,
                500  // Get more files
            );

            console.log(`[SmartContextBuilder] findFiles returned ${files.length} files`);

            // Build file listing first (always useful)
            for (const file of files) {
                // Double-check workspace containment
                if (!this.isWithinWorkspace(file.fsPath)) {
                    console.log(`[SmartContextBuilder] Skipping file outside workspace: ${file.fsPath}`);
                    continue;
                }

                const relativePath = path.relative(this.workspaceRoot, file.fsPath).replace(/\\/g, '/');
                fileListing.push(relativePath);
            }

            // Always add file listing as context
            if (fileListing.length > 0) {
                const listingHeader = `## Project Files in ${path.basename(this.workspaceRoot)}\n\`\`\`\n${fileListing.join('\n')}\n\`\`\``;
                const listingTokens = Math.ceil(listingHeader.length / CHARS_PER_TOKEN);
                skeletonParts.push(listingHeader);
                currentTokens += listingTokens;
            }

            // Now add skeleton content for code files
            for (const file of files) {
                if (currentTokens >= tokenBudget) break;

                if (!this.isWithinWorkspace(file.fsPath)) {
                    continue;
                }

                const skeleton = skeletonizeFile(file.fsPath);
                if (skeleton) {
                    const skeletonTokens = Math.ceil(skeleton.length / CHARS_PER_TOKEN);
                    if (currentTokens + skeletonTokens <= tokenBudget) {
                        skeletonParts.push(skeleton);
                        currentTokens += skeletonTokens;
                    }
                } else {
                    // For non-skeletonizable files (HTML, CSS, JSON), read and include if small
                    const ext = path.extname(file.fsPath).toLowerCase();
                    if (['.html', '.css', '.json'].includes(ext)) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(file);  // file IS the Uri
                            const content = doc.getText();
                            if (content.length < 5000) {  // Only include small files
                                const relativePath = path.relative(this.workspaceRoot, file.fsPath).replace(/\\/g, '/');
                                const fileContent = `## ${relativePath}\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\``;
                                const contentTokens = Math.ceil(fileContent.length / CHARS_PER_TOKEN);
                                if (currentTokens + contentTokens <= tokenBudget) {
                                    skeletonParts.push(fileContent);
                                    currentTokens += contentTokens;
                                }
                            }
                        } catch (e) {
                            // Ignore read errors
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('[SmartContextBuilder] Failed to build skeleton context:', error);
        }

        // If we still have nothing, create a minimal context
        if (skeletonParts.length === 0) {
            const fallback = `## Workspace: ${path.basename(this.workspaceRoot)}\n(No recognizable source files found. This may be an empty project or use unsupported file types.)`;
            skeletonParts.push(fallback);
            currentTokens = Math.ceil(fallback.length / CHARS_PER_TOKEN);
        }

        const content = skeletonParts.join('\n\n---\n\n');
        console.log(`[SmartContextBuilder] Skeleton context: ${skeletonParts.length} parts, ${fileListing.length} files listed, ~${currentTokens} tokens`);

        return {
            content,
            fullContentFiles: 0,
            skeletonFiles: skeletonParts.length,
            estimatedTokens: currentTokens,
            relevantFiles: fileListing,
            keywords: []
        };
    }

    /**
     * Generate structural skeleton for remaining files.
     */
    private async generateStructuralSkeleton(
        files: RelevantFile[],
        tokenBudget: number
    ): Promise<string> {
        const skeletons: string[] = [];
        let currentTokens = 0;

        for (const file of files.slice(0, 20)) {  // Limit to 20 files
            if (currentTokens >= tokenBudget) break;

            try {
                const skeleton = skeletonizeFile(file.uri.fsPath);
                if (skeleton) {
                    const skeletonTokens = Math.ceil(skeleton.length / CHARS_PER_TOKEN);
                    if (currentTokens + skeletonTokens <= tokenBudget) {
                        skeletons.push(skeleton);
                        currentTokens += skeletonTokens;
                    }
                }
            } catch (error) {
                // Skip files that can't be skeletonized
            }
        }

        return skeletons.join('\n\n---\n\n');
    }

    /**
     * Get language identifier for syntax highlighting.
     */
    private getLanguageId(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const langMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'tsx',
            '.js': 'javascript',
            '.jsx': 'jsx',
            '.py': 'python',
            '.java': 'java',
            '.go': 'go',
            '.rs': 'rust',
            '.cs': 'csharp',
            '.vue': 'vue',
            '.svelte': 'svelte'
        };
        return langMap[ext] || 'text';
    }
}

/**
 * Singleton instance for convenience.
 */
let _instance: SmartContextBuilder | null = null;

export function getSmartContextBuilder(): SmartContextBuilder {
    if (!_instance) {
        _instance = new SmartContextBuilder();
    }
    return _instance;
}

/**
 * Build smart context - convenience function.
 */
export async function buildSmartContext(
    userPrompt: string,
    tokenBudget: number = 20000
): Promise<SmartContext> {
    return getSmartContextBuilder().buildContext(userPrompt, tokenBudget);
}
