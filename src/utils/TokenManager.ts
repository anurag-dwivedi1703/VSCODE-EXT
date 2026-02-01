/**
 * TokenManager.ts
 * 
 * Unified token budget management for all modes (Refinement, Planning, Fast).
 * 
 * PRIORITY FOR TOKEN LIMITS:
 * 1. VS Code Language Model API's model.maxInputTokens (most accurate)
 * 2. Model-specific fallbacks (conservative estimates)
 * 3. Default fallback (32000 - very conservative)
 * 
 * This replaces the separate RefinementTokenManager and TokenBudget classes
 * to ensure consistent token management across all modes.
 */

import * as vscode from 'vscode';

// =============================================================================
// Constants
// =============================================================================

/** Token estimation: ~4 characters per token for English text */
const CHARS_PER_TOKEN = 4;

/**
 * Fallback token limits when VS Code LM API doesn't provide maxInputTokens.
 * These are CONSERVATIVE estimates - VS Code LM API limits may be higher.
 * 
 * Note: VS Code Copilot typically provides model.maxInputTokens which should
 * be used instead of these fallbacks whenever available.
 */
const MODEL_FALLBACK_LIMITS: Record<string, number> = {
    // Copilot-provided models (typical limits)
    'gpt-4': 128000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-5': 128000,
    'claude': 128000,      // Copilot Claude - conservative
    'claude-3': 128000,
    'claude-opus': 128000,
    'claude-sonnet': 128000,
    'gemini': 128000,      // Copilot Gemini - conservative
    'gemini-flash': 128000,
    'gemini-pro': 128000,
    
    // Direct API models (if used outside Copilot)
    'claude-3-5-sonnet': 200000,
    'claude-3-opus': 200000,
    'claude-sonnet-4': 200000,
    'claude-opus-4': 200000,
    'gemini-2.0-flash': 1000000,
    'gemini-1.5-pro': 2000000,
    
    // Default fallback - very conservative
    'default': 32000
};

/** Reserve ratio for model response generation */
const RESPONSE_RESERVE_RATIO = 0.2;  // Reserve 20% for response

/** Context allocation by mode */
const MODE_CONTEXT_RATIOS = {
    refinement: {
        analyst: 0.4,    // Analyst gets 40% for context
        critic: 0.3,     // Critic gets 30%
        refiner: 0.5     // Refiner gets 50%
    },
    planning: 0.6,       // Planning gets 60% for context
    fast: 0.7            // Fast mode gets 70% (less conversation history)
};

// =============================================================================
// Interfaces
// =============================================================================

export interface TokenBudgetInfo {
    maxTokens: number;
    usedTokens: number;
    availableTokens: number;
    responseReserve: number;
    utilizationPercent: number;
    source: 'vscode-api' | 'model-fallback' | 'default';
}

export interface TruncationResult {
    content: string;
    originalTokens: number;
    truncatedTokens: number;
    wasTruncated: boolean;
}

export interface ConversationTurn {
    role: string;
    content: string;
}

// =============================================================================
// TokenManager Class
// =============================================================================

/**
 * Unified token budget manager for all execution modes.
 */
export class TokenManager {
    private maxTokens: number;
    private responseReserve: number;
    private conversationTokens: number = 0;
    private systemPromptTokens: number = 0;
    private tokenSource: 'vscode-api' | 'model-fallback' | 'default';

    /**
     * Create a TokenManager with specified limits.
     * 
     * @param maxTokens - Maximum tokens (from VS Code LM API or fallback)
     * @param source - Where the limit came from
     */
    constructor(maxTokens: number, source: 'vscode-api' | 'model-fallback' | 'default' = 'default') {
        this.maxTokens = maxTokens;
        this.responseReserve = Math.floor(maxTokens * RESPONSE_RESERVE_RATIO);
        this.tokenSource = source;
        
        console.log(`[TokenManager] Initialized: ${maxTokens} tokens (source: ${source})`);
    }

    /**
     * Create TokenManager from VS Code Language Model (PREFERRED).
     * Uses the model's actual maxInputTokens from the API.
     */
    static fromVSCodeModel(model: vscode.LanguageModelChat): TokenManager {
        const maxTokens = model.maxInputTokens;
        
        if (maxTokens && maxTokens > 0) {
            console.log(`[TokenManager] Using VS Code LM API limit: ${maxTokens} tokens for ${model.id}`);
            return new TokenManager(maxTokens, 'vscode-api');
        }
        
        // Fall back to model ID matching
        console.warn(`[TokenManager] VS Code LM API didn't provide maxInputTokens for ${model.id}, using fallback`);
        return TokenManager.fromModelId(model.id);
    }

    /**
     * Create TokenManager from model ID string (FALLBACK).
     * Used when we don't have a VS Code model object.
     */
    static fromModelId(modelId: string = 'default'): TokenManager {
        const modelIdLower = modelId.toLowerCase();
        
        // Find matching fallback limit
        const matchedKey = Object.keys(MODEL_FALLBACK_LIMITS).find(
            key => modelIdLower.includes(key)
        );
        
        if (matchedKey && matchedKey !== 'default') {
            const limit = MODEL_FALLBACK_LIMITS[matchedKey];
            console.log(`[TokenManager] Using fallback limit for ${modelId}: ${limit} tokens`);
            return new TokenManager(limit, 'model-fallback');
        }
        
        console.log(`[TokenManager] Using default fallback: ${MODEL_FALLBACK_LIMITS['default']} tokens`);
        return new TokenManager(MODEL_FALLBACK_LIMITS['default'], 'default');
    }

    // =========================================================================
    // Token Estimation
    // =========================================================================

    /**
     * Estimate tokens from text (conservative: ~4 chars per token).
     */
    public estimateTokens(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    /**
     * Get available tokens for a specific mode/stage.
     */
    public getAvailableTokens(mode: 'planning' | 'fast' | 'analyst' | 'critic' | 'refiner'): number {
        const baseAvailable = this.maxTokens - this.responseReserve - this.systemPromptTokens - this.conversationTokens;
        
        let ratio: number;
        if (mode === 'planning') {
            ratio = MODE_CONTEXT_RATIOS.planning;
        } else if (mode === 'fast') {
            ratio = MODE_CONTEXT_RATIOS.fast;
        } else {
            ratio = MODE_CONTEXT_RATIOS.refinement[mode];
        }
        
        return Math.floor(Math.max(0, baseAvailable) * ratio);
    }

    /**
     * Get total available tokens (without mode-specific ratio).
     */
    public getTotalAvailableTokens(): number {
        return Math.max(0, this.maxTokens - this.responseReserve - this.systemPromptTokens - this.conversationTokens);
    }

    // =========================================================================
    // Token Tracking
    // =========================================================================

    /**
     * Set system prompt tokens (call once at session start).
     */
    public setSystemPromptTokens(tokens: number): void {
        this.systemPromptTokens = tokens;
    }

    /**
     * Add conversation tokens (call after each turn).
     */
    public addConversationTokens(tokens: number): void {
        this.conversationTokens += tokens;
    }

    /**
     * Update conversation tokens (replace, not add).
     */
    public setConversationTokens(tokens: number): void {
        this.conversationTokens = tokens;
    }

    /**
     * Reset conversation tokens (e.g., after summarization).
     */
    public resetConversationTokens(): void {
        this.conversationTokens = 0;
    }

    /**
     * Get current budget info.
     */
    public getBudgetInfo(): TokenBudgetInfo {
        const usedTokens = this.systemPromptTokens + this.conversationTokens;
        const availableTokens = Math.max(0, this.maxTokens - usedTokens - this.responseReserve);
        
        return {
            maxTokens: this.maxTokens,
            usedTokens,
            availableTokens,
            responseReserve: this.responseReserve,
            utilizationPercent: Math.round((usedTokens / this.maxTokens) * 100),
            source: this.tokenSource
        };
    }

    // =========================================================================
    // Context Truncation
    // =========================================================================

    /**
     * Truncate content to fit within token budget.
     */
    public truncateToFit(content: string, maxTokens: number): TruncationResult {
        const originalTokens = this.estimateTokens(content);
        
        if (originalTokens <= maxTokens) {
            return {
                content,
                originalTokens,
                truncatedTokens: originalTokens,
                wasTruncated: false
            };
        }

        const maxChars = maxTokens * CHARS_PER_TOKEN;
        const truncated = this.smartTruncate(content, maxChars);
        
        return {
            content: truncated,
            originalTokens,
            truncatedTokens: this.estimateTokens(truncated),
            wasTruncated: true
        };
    }

    /**
     * Smart truncation that preserves structure (file headers, signatures).
     */
    private smartTruncate(content: string, maxChars: number): string {
        if (content.length <= maxChars) {
            return content;
        }

        // Split by file separators
        const sections = content.split(/\n---\n|\n## /);
        
        // If no clear sections, use simple truncation
        if (sections.length <= 1) {
            const half = Math.floor(maxChars / 2) - 50;
            return content.slice(0, half) + 
                '\n\n... [CONTENT TRUNCATED FOR TOKEN EFFICIENCY] ...\n\n' + 
                content.slice(-half);
        }

        // Prioritize first and last sections
        const result: string[] = [];
        let currentLength = 0;
        const reserveForEnd = Math.floor(maxChars * 0.3);
        
        for (let i = 0; i < sections.length && currentLength < maxChars - reserveForEnd; i++) {
            const section = sections[i];
            if (currentLength + section.length < maxChars - reserveForEnd) {
                result.push(section);
                currentLength += section.length;
            } else {
                const remaining = maxChars - reserveForEnd - currentLength - 100;
                if (remaining > 200) {
                    result.push(section.slice(0, remaining) + '\n... [section truncated]');
                }
                break;
            }
        }

        result.push('\n\n... [MIDDLE SECTIONS OMITTED] ...\n');

        // Add last section if room
        if (sections.length > 1) {
            const lastSection = sections[sections.length - 1];
            if (lastSection.length < reserveForEnd) {
                result.push(lastSection);
            } else {
                result.push('... [truncated]\n' + lastSection.slice(-reserveForEnd + 50));
            }
        }

        return result.join('\n---\n');
    }

    /**
     * Truncate file content intelligently (preserves imports, exports, signatures).
     */
    public truncateFile(content: string, maxChars: number, filePath: string): string {
        if (content.length <= maxChars) {
            return content;
        }

        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const lines = content.split('\n');
        
        if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
            return this.truncateTypeScriptFile(lines, maxChars);
        } else if (['py'].includes(ext)) {
            return this.truncatePythonFile(lines, maxChars);
        } else {
            // Generic: keep start and end
            const halfMax = Math.floor(maxChars / 2) - 50;
            return content.slice(0, halfMax) + 
                '\n\n... [TRUNCATED - middle portion omitted] ...\n\n' +
                content.slice(-halfMax);
        }
    }

    private truncateTypeScriptFile(lines: string[], maxChars: number): string {
        const importantLines: string[] = [];
        let charCount = 0;
        
        // Keep imports
        for (const line of lines) {
            if (line.trim().startsWith('import ') || line.trim().startsWith('export * from')) {
                importantLines.push(line);
                charCount += line.length + 1;
            }
        }
        
        // Keep exports and signatures
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

    private truncatePythonFile(lines: string[], maxChars: number): string {
        const importantLines: string[] = [];
        let charCount = 0;
        
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

    // =========================================================================
    // Conversation Summarization
    // =========================================================================

    /**
     * Summarize conversation history to reduce tokens.
     * Keeps recent turns verbatim, summarizes older ones.
     */
    public summarizeConversation(
        turns: ConversationTurn[],
        keepRecentTurns: number = 3
    ): ConversationTurn[] {
        if (turns.length <= keepRecentTurns + 1) {
            return turns;
        }

        const result: ConversationTurn[] = [];
        const turnsToSummarize = turns.slice(0, -keepRecentTurns);
        const recentTurns = turns.slice(-keepRecentTurns);

        // Create summary of older turns
        const summaryParts: string[] = [];
        for (const turn of turnsToSummarize) {
            const summary = this.summarizeTurn(turn);
            if (summary) {
                summaryParts.push(`[${turn.role.toUpperCase()}]: ${summary}`);
            }
        }

        if (summaryParts.length > 0) {
            result.push({
                role: 'system',
                content: `[CONVERSATION SUMMARY]\n${summaryParts.join('\n')}\n[END SUMMARY]`
            });
        }

        result.push(...recentTurns);
        return result;
    }

    /**
     * Summarize a single turn to key points.
     */
    private summarizeTurn(turn: ConversationTurn): string {
        const content = turn.content;
        
        if (content.length < 200) {
            return content;
        }

        // Extract key elements based on role
        if (turn.role === 'user') {
            // Keep first sentence or question
            const firstSentence = content.match(/^[^.!?]+[.!?]/)?.[0] || content.slice(0, 150);
            return firstSentence + '...';
        }
        
        // For AI responses, extract key decisions/actions
        const keyPhrases: string[] = [];
        
        // Look for decisions
        const decisions = content.match(/(?:decided|chose|will|should|must|recommend)[^.!?]+[.!?]/gi);
        if (decisions) {
            keyPhrases.push(...decisions.slice(0, 2));
        }
        
        // Look for questions asked
        const questions = content.match(/[^.!?]*\?/g);
        if (questions) {
            keyPhrases.push(...questions.slice(0, 2));
        }
        
        if (keyPhrases.length > 0) {
            return keyPhrases.join(' ');
        }
        
        // Fallback: first 150 chars
        return content.slice(0, 150) + '...';
    }

    // =========================================================================
    // Tool Result Truncation
    // =========================================================================

    /**
     * Truncate tool results intelligently.
     * Special handling for compile errors, npm output, etc.
     */
    public truncateToolResult(toolName: string, result: string, maxChars: number = 8000): string {
        if (result.length <= maxChars) {
            return result;
        }

        // Special handling for compile/build output
        if (toolName === 'run_command') {
            // TypeScript/build errors
            if (result.includes('error TS') || result.includes('Error:') || result.includes('error:')) {
                const lines = result.split('\n');
                const errorLines = lines.filter(l => 
                    l.includes('error') || l.includes('Error') || l.includes('warning')
                );
                
                if (errorLines.length > 0) {
                    const totalErrors = errorLines.length;
                    const previewCount = Math.min(15, totalErrors);
                    const preview = errorLines.slice(0, previewCount).join('\n');

                    return `[COMPILE OUTPUT TRUNCATED - ${totalErrors} total errors/warnings]\n\n` +
                        `First ${previewCount} errors:\n${preview}\n\n` +
                        (totalErrors > previewCount
                            ? `[...${totalErrors - previewCount} more truncated]\n\n`
                            : '') +
                        `ACTION: Fix the above issues first, then recompile.`;
                }
            }

            // npm output
            if (result.includes('npm WARN') || result.includes('added ') || result.includes('packages in')) {
                const lines = result.split('\n');
                const summaryLine = lines.find(l => l.includes('added ') || l.includes('removed '));
                const warningLines = lines.filter(l => l.includes('npm WARN')).slice(0, 5);

                return `[NPM OUTPUT TRUNCATED]\n\n` +
                    (warningLines.length > 0 ? `Key warnings:\n${warningLines.join('\n')}\n\n` : '') +
                    (summaryLine ? `Summary: ${summaryLine}` : 'Installation completed.');
            }
        }

        // Default truncation
        return result.substring(0, maxChars) +
            `\n\n[OUTPUT TRUNCATED - original was ${result.length} chars]\n` +
            `TIP: Run a more specific command if you need more details.`;
    }

    // =========================================================================
    // Utility Methods
    // =========================================================================

    /**
     * Check if content would fit in available tokens.
     */
    public wouldFit(content: string, mode: 'planning' | 'fast' | 'analyst' | 'critic' | 'refiner'): boolean {
        return this.estimateTokens(content) <= this.getAvailableTokens(mode);
    }

    /**
     * Get summary for logging.
     */
    public getSummary(): string {
        const info = this.getBudgetInfo();
        return `TokenManager: ${info.usedTokens}/${info.maxTokens} tokens (${info.utilizationPercent}%), source: ${info.source}`;
    }

    /**
     * Get the max tokens limit.
     */
    public getMaxTokens(): number {
        return this.maxTokens;
    }
}

// =============================================================================
// Singleton for convenience
// =============================================================================

let _defaultManager: TokenManager | null = null;

/**
 * Get or create a default TokenManager instance.
 */
export function getDefaultTokenManager(): TokenManager {
    if (!_defaultManager) {
        _defaultManager = TokenManager.fromModelId('default');
    }
    return _defaultManager;
}

/**
 * Set the default TokenManager (call when model is selected).
 */
export function setDefaultTokenManager(manager: TokenManager): void {
    _defaultManager = manager;
}
