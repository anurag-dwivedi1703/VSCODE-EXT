/**
 * RefinementTokenManager.ts
 * Manages token budgets for refinement mode to prevent exhaustion.
 * 
 * Key strategies:
 * 1. Context truncation - Limit skeleton context to fit budget
 * 2. Conversation summarization - Compress older turns
 * 3. Progressive disclosure - Only include relevant context per stage
 * 4. Multi-turn chunking - Break large PRDs into sections
 */

// Token estimation: ~4 chars per token for English text
const CHARS_PER_TOKEN = 4;

// Default token limits for different models
const MODEL_TOKEN_LIMITS: Record<string, number> = {
    'gpt-4': 128000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'claude-3-5-sonnet': 200000,
    'claude-3-opus': 200000,
    'claude-sonnet-4': 200000,
    'gemini-2.0-flash': 1000000,
    'gemini-1.5-pro': 2000000,
    'default': 32000  // Conservative default for unknown models
};

// Reserve tokens for response generation
const RESPONSE_RESERVE_RATIO = 0.25;  // Reserve 25% for response

// Maximum context sizes per refinement stage
const STAGE_CONTEXT_LIMITS = {
    analyst: 0.4,   // Analyst gets 40% of available tokens for context
    critic: 0.3,    // Critic gets 30% (needs less context, more analysis)
    refiner: 0.5    // Refiner gets 50% (needs to see full draft + clarifications)
};

export interface TokenBudgetInfo {
    maxTokens: number;
    usedTokens: number;
    availableTokens: number;
    responseReserve: number;
    utilizationPercent: number;
}

export interface TruncationResult {
    content: string;
    originalTokens: number;
    truncatedTokens: number;
    wasTruncated: boolean;
}

/**
 * Manages token budget for a refinement session.
 */
export class RefinementTokenManager {
    private maxTokens: number;
    private responseReserve: number;
    private conversationTokens: number = 0;
    private systemPromptTokens: number = 0;

    constructor(modelId: string = 'default') {
        // Get model-specific limit or use default
        const modelKey = Object.keys(MODEL_TOKEN_LIMITS).find(
            key => modelId.toLowerCase().includes(key)
        ) || 'default';
        
        this.maxTokens = MODEL_TOKEN_LIMITS[modelKey];
        this.responseReserve = Math.floor(this.maxTokens * RESPONSE_RESERVE_RATIO);
        
        console.log(`[RefinementTokenManager] Initialized with ${this.maxTokens} tokens for model ${modelId}`);
    }

    // ========================================
    // Token Estimation
    // ========================================

    /**
     * Estimate tokens from character count.
     */
    public estimateTokens(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    /**
     * Get available tokens for a specific stage.
     */
    public getAvailableTokensForStage(stage: 'analyst' | 'critic' | 'refiner'): number {
        const baseAvailable = this.maxTokens - this.responseReserve - this.systemPromptTokens - this.conversationTokens;
        return Math.floor(baseAvailable * STAGE_CONTEXT_LIMITS[stage]);
    }

    /**
     * Set system prompt tokens (called once per session).
     */
    public setSystemPromptTokens(tokens: number): void {
        this.systemPromptTokens = tokens;
    }

    /**
     * Update conversation tokens (call after each turn).
     */
    public addConversationTokens(tokens: number): void {
        this.conversationTokens += tokens;
    }

    /**
     * Get current budget info.
     */
    public getBudgetInfo(): TokenBudgetInfo {
        const usedTokens = this.systemPromptTokens + this.conversationTokens;
        const availableTokens = this.maxTokens - usedTokens - this.responseReserve;
        
        return {
            maxTokens: this.maxTokens,
            usedTokens,
            availableTokens,
            responseReserve: this.responseReserve,
            utilizationPercent: Math.round((usedTokens / this.maxTokens) * 100)
        };
    }

    // ========================================
    // Context Truncation
    // ========================================

    /**
     * Truncate context to fit within token budget.
     * Uses smart truncation that preserves structure.
     */
    public truncateContext(context: string, maxTokens: number): TruncationResult {
        const originalTokens = this.estimateTokens(context);
        
        if (originalTokens <= maxTokens) {
            return {
                content: context,
                originalTokens,
                truncatedTokens: originalTokens,
                wasTruncated: false
            };
        }

        // Smart truncation: preserve file headers and key signatures
        const maxChars = maxTokens * CHARS_PER_TOKEN;
        const truncated = this.smartTruncate(context, maxChars);
        
        return {
            content: truncated,
            originalTokens,
            truncatedTokens: this.estimateTokens(truncated),
            wasTruncated: true
        };
    }

    /**
     * Smart truncation that preserves structure.
     */
    private smartTruncate(content: string, maxChars: number): string {
        if (content.length <= maxChars) {
            return content;
        }

        // Split by file separators (--- or file headers)
        const sections = content.split(/\n---\n|\n\/\/ \w+\.\w+|\n# \w+\.\w+/);
        
        // If no clear sections, use simple truncation with middle ellipsis
        if (sections.length <= 1) {
            const half = Math.floor(maxChars / 2) - 50;
            return content.slice(0, half) + 
                '\n\n... [CONTENT TRUNCATED FOR TOKEN EFFICIENCY] ...\n\n' + 
                content.slice(-half);
        }

        // Prioritize first and last sections, trim middle
        const result: string[] = [];
        let currentLength = 0;
        const reserveForEnd = Math.floor(maxChars * 0.3);
        
        // Add sections from start
        for (let i = 0; i < sections.length && currentLength < maxChars - reserveForEnd; i++) {
            const section = sections[i];
            if (currentLength + section.length < maxChars - reserveForEnd) {
                result.push(section);
                currentLength += section.length;
            } else {
                // Partial section
                const remaining = maxChars - reserveForEnd - currentLength - 100;
                if (remaining > 200) {
                    result.push(section.slice(0, remaining) + '\n... [truncated]');
                }
                break;
            }
        }

        // Add truncation indicator
        result.push('\n\n... [MIDDLE SECTIONS OMITTED FOR TOKEN EFFICIENCY] ...\n');

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

    // ========================================
    // Conversation Summarization
    // ========================================

    /**
     * Summarize conversation history to reduce tokens.
     * Keeps recent turns verbatim, summarizes older ones.
     */
    public summarizeConversation(
        turns: Array<{ role: string; content: string }>,
        keepRecentTurns: number = 3
    ): Array<{ role: string; content: string }> {
        if (turns.length <= keepRecentTurns + 1) {
            return turns;
        }

        const result: Array<{ role: string; content: string }> = [];
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

        // Add recent turns verbatim
        result.push(...recentTurns);

        return result;
    }

    /**
     * Summarize a single turn to key points.
     */
    private summarizeTurn(turn: { role: string; content: string }): string {
        const content = turn.content;
        
        // Extract key information based on role
        if (turn.role === 'user') {
            // Keep user messages short but intact
            if (content.length <= 200) {
                return content;
            }
            return content.slice(0, 200) + '...';
        }

        if (turn.role === 'analyst') {
            // Extract questions asked
            const questions = content.match(/\d+\.\s*[^?\n]+\?/g) || [];
            if (questions.length > 0) {
                return `Asked ${questions.length} questions: ${questions.slice(0, 3).join('; ')}`;
            }
            return content.slice(0, 150) + '...';
        }

        if (turn.role === 'critic') {
            // Extract confidence score if present
            const scoreMatch = content.match(/confidenceScore["']?\s*:\s*(\d+)/);
            if (scoreMatch) {
                return `Critique with confidence ${scoreMatch[1]}%`;
            }
            return 'Provided critique feedback';
        }

        return content.slice(0, 100) + '...';
    }

    // ========================================
    // PRD Chunking for Large Features
    // ========================================

    /**
     * Check if PRD needs to be generated in chunks.
     */
    public needsChunkedGeneration(contextTokens: number, estimatedPrdTokens: number): boolean {
        const available = this.maxTokens - this.responseReserve - this.systemPromptTokens;
        return (contextTokens + estimatedPrdTokens) > available * 0.8;
    }

    /**
     * Get PRD sections for chunked generation.
     */
    public getPrdSections(): string[] {
        return [
            'problem_statement',
            'functional_requirements',
            'non_functional_requirements',
            'technical_plan',
            'acceptance_criteria'
        ];
    }

    /**
     * Generate prompt for a specific PRD section.
     */
    public getChunkedPrompt(section: string, previousSections: string): string {
        const sectionPrompts: Record<string, string> = {
            'problem_statement': 
                `Generate ONLY the Problem Statement section of the PRD. Be concise but complete.`,
            'functional_requirements': 
                `Generate ONLY the Functional Requirements section. List each requirement with clear acceptance criteria.
                
Previous sections for context:
${previousSections}`,
            'non_functional_requirements':
                `Generate ONLY the Non-Functional Requirements section (performance, security, scalability).
                
Previous sections for context:
${previousSections}`,
            'technical_plan':
                `Generate ONLY the Technical Implementation Plan section (files to create/modify, API changes).
                
Previous sections for context:
${previousSections}`,
            'acceptance_criteria':
                `Generate ONLY the Acceptance Criteria section using Gherkin format.
                
Previous sections for context:
${previousSections}`
        };

        return sectionPrompts[section] || '';
    }

    // ========================================
    // Skeleton Context Optimization
    // ========================================

    /**
     * Prioritize skeleton files based on relevance to the request.
     */
    public prioritizeSkeletonFiles(
        skeletonSections: string[],
        keywords: string[],
        maxSections: number = 10
    ): string[] {
        // Score each section by keyword relevance
        const scored = skeletonSections.map(section => {
            const lowerSection = section.toLowerCase();
            let score = 0;
            
            for (const keyword of keywords) {
                if (lowerSection.includes(keyword.toLowerCase())) {
                    score += 10;
                }
            }
            
            // Boost for important file types
            if (lowerSection.includes('service') || lowerSection.includes('manager')) {
                score += 5;
            }
            if (lowerSection.includes('types') || lowerSection.includes('interface')) {
                score += 3;
            }
            
            return { section, score };
        });

        // Sort by score and take top N
        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, maxSections)
            .map(s => s.section);
    }

    /**
     * Extract keywords from user prompt for context relevance.
     */
    public extractKeywords(prompt: string): string[] {
        // Remove common words and extract meaningful terms
        const commonWords = new Set([
            'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
            'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
            'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
            'into', 'through', 'during', 'before', 'after', 'above', 'below',
            'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
            'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
            'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that',
            'want', 'make', 'create', 'add', 'implement', 'build', 'feature'
        ]);

        const words = prompt.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 2 && !commonWords.has(word));

        // Remove duplicates and return
        return [...new Set(words)];
    }
}

/**
 * Create a token-aware skeleton context from a full skeleton.
 */
export function createTokenAwareSkeleton(
    fullSkeleton: string,
    maxTokens: number,
    keywords: string[] = []
): string {
    const manager = new RefinementTokenManager();
    
    // Split skeleton into file sections
    const sections = fullSkeleton.split(/\n---\n|\n(?=\/\/ \w+\.\w+)|\n(?=# \w+\.\w+)/);
    
    // If small enough, return as-is
    if (manager.estimateTokens(fullSkeleton) <= maxTokens) {
        return fullSkeleton;
    }

    // Prioritize and truncate
    const prioritized = manager.prioritizeSkeletonFiles(sections, keywords, 15);
    const combined = prioritized.join('\n\n---\n\n');
    
    const result = manager.truncateContext(combined, maxTokens);
    
    if (result.wasTruncated) {
        console.log(`[RefinementTokenManager] Skeleton truncated from ${result.originalTokens} to ${result.truncatedTokens} tokens`);
    }
    
    return result.content;
}
