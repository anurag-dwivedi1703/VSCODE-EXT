/**
 * TokenBudget.ts
 * 
 * Utility for tracking and managing token usage with VS Code's Language Model API.
 * Helps stay within Copilot's token limits while maximizing useful context.
 * 
 * Token estimation uses ~4 characters per token (conservative estimate).
 */

import * as vscode from 'vscode';

export interface TokenBudgetOptions {
    /** Maximum tokens allowed (defaults to model's maxInputTokens or 128000) */
    maxTokens?: number;
    /** Reserve tokens for model response (default: 4000) */
    responseReserve?: number;
    /** Reserve tokens for system prompt (default: 2000) */
    systemPromptReserve?: number;
}

export interface ContentChunk {
    /** Identifier for this chunk (e.g., file path) */
    id: string;
    /** The actual content */
    content: string;
    /** Priority (higher = more important to keep) */
    priority: number;
    /** Estimated tokens */
    tokens: number;
}

export class TokenBudget {
    private maxTokens: number;
    private responseReserve: number;
    private systemPromptReserve: number;
    private chunks: ContentChunk[] = [];
    private usedTokens: number = 0;

    constructor(options: TokenBudgetOptions = {}) {
        this.maxTokens = options.maxTokens || 128000;
        this.responseReserve = options.responseReserve || 4000;
        this.systemPromptReserve = options.systemPromptReserve || 2000;
    }

    /**
     * Initialize budget from a VS Code Language Model
     */
    static async fromModel(model: vscode.LanguageModelChat, options: Omit<TokenBudgetOptions, 'maxTokens'> = {}): Promise<TokenBudget> {
        return new TokenBudget({
            maxTokens: model.maxInputTokens || 128000,
            ...options
        });
    }

    /**
     * Estimate tokens for a string (conservative: ~4 chars per token)
     */
    estimateTokens(content: string): number {
        // More accurate estimation considering:
        // - Whitespace compresses well
        // - Code has more symbols (less efficient)
        // - Comments compress better
        const codeChars = content.replace(/\s+/g, '').length;
        const whitespaceChars = content.length - codeChars;
        
        // Code: ~3.5 chars/token, Whitespace: ~6 chars/token
        return Math.ceil(codeChars / 3.5 + whitespaceChars / 6);
    }

    /**
     * Get available tokens for content (after reserves)
     */
    get availableTokens(): number {
        return this.maxTokens - this.responseReserve - this.systemPromptReserve - this.usedTokens;
    }

    /**
     * Get total budget info
     */
    get budget() {
        return {
            max: this.maxTokens,
            reserved: this.responseReserve + this.systemPromptReserve,
            used: this.usedTokens,
            available: this.availableTokens,
            chunks: this.chunks.length,
            utilizationPercent: Math.round((this.usedTokens / (this.maxTokens - this.responseReserve - this.systemPromptReserve)) * 100)
        };
    }

    /**
     * Add a content chunk to the budget
     * Returns false if content doesn't fit
     */
    addChunk(id: string, content: string, priority: number = 5): boolean {
        const tokens = this.estimateTokens(content);
        
        if (tokens > this.availableTokens) {
            console.log(`[TokenBudget] Cannot add ${id}: needs ${tokens} tokens, only ${this.availableTokens} available`);
            return false;
        }

        this.chunks.push({ id, content, priority, tokens });
        this.usedTokens += tokens;
        return true;
    }

    /**
     * Try to add content, truncating if necessary to fit
     * Returns the (possibly truncated) content that was added
     */
    addChunkWithTruncation(id: string, content: string, priority: number = 5): string {
        const tokens = this.estimateTokens(content);
        
        if (tokens <= this.availableTokens) {
            this.addChunk(id, content, priority);
            return content;
        }

        // Calculate how much we can fit
        const availableChars = this.availableTokens * 4; // Conservative
        
        if (availableChars < 100) {
            console.log(`[TokenBudget] Cannot add ${id}: not enough space for meaningful truncation`);
            return '';
        }

        // Truncate intelligently (keep start and note truncation)
        const truncated = content.slice(0, availableChars - 50) + 
            '\n\n... [TRUNCATED - file too large, showing first portion] ...';
        
        const truncatedTokens = this.estimateTokens(truncated);
        this.chunks.push({ id, content: truncated, priority, tokens: truncatedTokens });
        this.usedTokens += truncatedTokens;
        
        console.log(`[TokenBudget] Truncated ${id} from ${tokens} to ${truncatedTokens} tokens`);
        return truncated;
    }

    /**
     * Remove lowest priority chunks to make room for a new chunk
     * Returns true if successful
     */
    makeRoomFor(requiredTokens: number): boolean {
        if (this.availableTokens >= requiredTokens) {
            return true;
        }

        // Sort by priority (lowest first)
        const sortedChunks = [...this.chunks].sort((a, b) => a.priority - b.priority);
        let freedTokens = 0;
        const toRemove: string[] = [];

        for (const chunk of sortedChunks) {
            if (this.availableTokens + freedTokens >= requiredTokens) {
                break;
            }
            toRemove.push(chunk.id);
            freedTokens += chunk.tokens;
        }

        if (this.availableTokens + freedTokens < requiredTokens) {
            return false; // Can't free enough space
        }

        // Actually remove the chunks
        for (const id of toRemove) {
            this.removeChunk(id);
        }

        return true;
    }

    /**
     * Remove a chunk by ID
     */
    removeChunk(id: string): boolean {
        const index = this.chunks.findIndex(c => c.id === id);
        if (index === -1) return false;

        this.usedTokens -= this.chunks[index].tokens;
        this.chunks.splice(index, 1);
        return true;
    }

    /**
     * Get all content as a combined string
     */
    getAllContent(): string {
        return this.chunks.map(c => c.content).join('\n\n');
    }

    /**
     * Clear all chunks
     */
    clear(): void {
        this.chunks = [];
        this.usedTokens = 0;
    }

    /**
     * Check if a content chunk would fit
     */
    wouldFit(content: string): boolean {
        return this.estimateTokens(content) <= this.availableTokens;
    }

    /**
     * Get summary for logging
     */
    getSummary(): string {
        const b = this.budget;
        return `TokenBudget: ${b.used}/${b.max - b.reserved} tokens used (${b.utilizationPercent}%), ${b.chunks} chunks`;
    }
}

/**
 * Truncate file content intelligently for token efficiency
 * Keeps important parts: imports, exports, function signatures
 */
export function truncateFileIntelligently(content: string, maxChars: number, filePath: string): string {
    if (content.length <= maxChars) {
        return content;
    }

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const lines = content.split('\n');
    
    // Strategy varies by file type
    if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
        return truncateTypeScriptFile(lines, maxChars);
    } else if (['py'].includes(ext)) {
        return truncatePythonFile(lines, maxChars);
    } else {
        // Generic: keep start and end
        const halfMax = Math.floor(maxChars / 2) - 50;
        return content.slice(0, halfMax) + 
            '\n\n... [TRUNCATED - middle portion omitted] ...\n\n' +
            content.slice(-halfMax);
    }
}

function truncateTypeScriptFile(lines: string[], maxChars: number): string {
    const importantLines: string[] = [];
    let charCount = 0;
    
    // Phase 1: Keep all imports
    for (const line of lines) {
        if (line.trim().startsWith('import ') || line.trim().startsWith('export * from')) {
            importantLines.push(line);
            charCount += line.length + 1;
        }
    }
    
    // Phase 2: Keep export statements and function/class signatures
    for (const line of lines) {
        if (charCount >= maxChars - 100) break;
        
        const trimmed = line.trim();
        if (
            trimmed.startsWith('export ') ||
            trimmed.startsWith('class ') ||
            trimmed.startsWith('interface ') ||
            trimmed.startsWith('type ') ||
            trimmed.match(/^(async\s+)?function\s+\w+/) ||
            trimmed.match(/^(public|private|protected)\s+\w+\s*\(/)
        ) {
            if (!importantLines.includes(line)) {
                importantLines.push(line);
                charCount += line.length + 1;
            }
        }
    }
    
    importantLines.push('\n// ... [FILE TRUNCATED - showing imports and signatures only] ...');
    return importantLines.join('\n');
}

function truncatePythonFile(lines: string[], maxChars: number): string {
    const importantLines: string[] = [];
    let charCount = 0;
    
    // Keep imports and class/function definitions
    for (const line of lines) {
        if (charCount >= maxChars - 100) break;
        
        const trimmed = line.trim();
        if (
            trimmed.startsWith('import ') ||
            trimmed.startsWith('from ') ||
            trimmed.startsWith('class ') ||
            trimmed.startsWith('def ') ||
            trimmed.startsWith('async def ')
        ) {
            importantLines.push(line);
            charCount += line.length + 1;
        }
    }
    
    importantLines.push('\n# ... [FILE TRUNCATED - showing imports and definitions only] ...');
    return importantLines.join('\n');
}
