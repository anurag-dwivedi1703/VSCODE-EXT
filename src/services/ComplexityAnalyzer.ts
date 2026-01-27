/**
 * ComplexityAnalyzer - Analyzes user requirements and produces complexity scores
 * 
 * This service is part of the Phased Execution Guard-Rails system that prevents
 * context exhaustion when users submit large, monolithic requirements.
 * 
 * Phase 1 of 5 - Foundation
 */

/**
 * Complexity level classification
 */
export type ComplexityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

/**
 * Recommendation for how to handle the requirement
 */
export type ComplexityRecommendation = 'PROCEED' | 'SPLIT_PHASES' | 'REQUIRE_CLARIFICATION';

/**
 * Detailed metrics extracted from requirement analysis
 */
export interface ComplexityMetrics {
    /** Number of distinct features identified in the requirement */
    featureCount: number;
    
    /** Estimated number of files to be created or modified */
    estimatedFileCount: number;
    
    /** Keywords indicating broad scope (e.g., "full stack", "complete app") */
    scopeIndicators: string[];
    
    /** Factors that increase implementation risk/complexity */
    riskFactors: string[];
    
    /** Raw text length of the requirement */
    textLength: number;
    
    /** Detected technical domains (frontend, backend, database, etc.) */
    technicalDomains: string[];
}

/**
 * Complete complexity analysis result
 */
export interface ComplexityScore {
    /** Categorical complexity level */
    level: ComplexityLevel;
    
    /** Numeric score from 0-100 */
    score: number;
    
    /** Estimated tokens needed for full implementation */
    estimatedTokens: number;
    
    /** Detailed breakdown of complexity factors */
    metrics: ComplexityMetrics;
    
    /** Recommended action based on analysis */
    recommendation: ComplexityRecommendation;
    
    /** Human-readable explanation of the analysis */
    explanation: string;
    
    /** Suggested number of phases if splitting is recommended */
    suggestedPhaseCount?: number;
}

/**
 * Configuration options for the analyzer
 */
export interface ComplexityAnalyzerConfig {
    /** Token budget per phase (default: 30000) */
    tokensPerPhase: number;
    
    /** Score threshold for LOW complexity (default: 20) */
    lowThreshold: number;
    
    /** Score threshold for MEDIUM complexity (default: 40) */
    mediumThreshold: number;
    
    /** Score threshold for HIGH complexity (default: 70) */
    highThreshold: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ComplexityAnalyzerConfig = {
    tokensPerPhase: 30000,
    lowThreshold: 20,
    mediumThreshold: 40,
    highThreshold: 70
};

/**
 * Keywords that indicate broad scope - weighted by impact
 */
const SCOPE_INDICATORS: { pattern: RegExp; weight: number; label: string }[] = [
    { pattern: /\b(full[- ]?stack|end[- ]?to[- ]?end)\b/i, weight: 15, label: 'full-stack' },
    { pattern: /\b(complete|entire|whole)\s+(app|application|system|platform)\b/i, weight: 15, label: 'complete-app' },
    { pattern: /\b(from\s+scratch|ground\s+up|greenfield)\b/i, weight: 12, label: 'from-scratch' },
    { pattern: /\b(microservices?|distributed)\b/i, weight: 10, label: 'microservices' },
    { pattern: /\b(authentication|auth)\s*(and|&|\+|,)?\s*(authorization|authz)\b/i, weight: 8, label: 'auth-system' },
    { pattern: /\b(crud|create,?\s*read,?\s*update,?\s*delete)\b/i, weight: 5, label: 'crud-operations' },
    { pattern: /\b(api|rest|graphql)\s*(endpoints?|server|layer)\b/i, weight: 6, label: 'api-layer' },
    { pattern: /\b(dashboard|admin\s*panel|control\s*panel)\b/i, weight: 7, label: 'dashboard' },
    { pattern: /\b(real[- ]?time|websocket|live\s+update)\b/i, weight: 8, label: 'real-time' },
    { pattern: /\b(mobile|responsive|cross[- ]?platform)\b/i, weight: 6, label: 'multi-platform' },
];

/**
 * Risk factors that increase complexity
 */
const RISK_FACTORS: { pattern: RegExp; weight: number; label: string }[] = [
    { pattern: /\b(migration|migrate|upgrade)\s*(database|db|schema|data)\b/i, weight: 10, label: 'database-migration' },
    { pattern: /\b(refactor|rewrite|restructure)\b/i, weight: 8, label: 'major-refactor' },
    { pattern: /\b(security|encrypt|ssl|https|oauth|jwt)\b/i, weight: 6, label: 'security-concerns' },
    { pattern: /\b(performance|optimize|scale|caching)\b/i, weight: 5, label: 'performance-optimization' },
    { pattern: /\b(test|testing|tdd|coverage|e2e|integration\s*test)\b/i, weight: 4, label: 'testing-requirements' },
    { pattern: /\b(deploy|ci\/cd|docker|kubernetes|aws|azure|gcp)\b/i, weight: 6, label: 'deployment-infra' },
    { pattern: /\b(third[- ]?party|external\s*api|integration)\b/i, weight: 5, label: 'external-integrations' },
    { pattern: /\b(legacy|backward[- ]?compatible|deprecat)\b/i, weight: 7, label: 'legacy-concerns' },
    { pattern: /\b(concurrent|parallel|async|thread)\b/i, weight: 5, label: 'concurrency' },
    { pattern: /\b(i18n|internationali[sz]ation|locali[sz]ation|l10n)\b/i, weight: 4, label: 'internationalization' },
];

/**
 * Technical domain indicators
 */
const TECHNICAL_DOMAINS: { pattern: RegExp; label: string }[] = [
    { pattern: /\b(frontend|front[- ]?end|ui|ux|react|vue|angular|svelte)\b/i, label: 'frontend' },
    { pattern: /\b(backend|back[- ]?end|server|api|node|express|fastify)\b/i, label: 'backend' },
    { pattern: /\b(database|db|sql|nosql|postgres|mysql|mongo|redis)\b/i, label: 'database' },
    { pattern: /\b(mobile|ios|android|react[- ]?native|flutter)\b/i, label: 'mobile' },
    { pattern: /\b(devops|infrastructure|cloud|aws|azure|gcp)\b/i, label: 'devops' },
    { pattern: /\b(machine\s*learning|ml|ai|neural|model)\b/i, label: 'ml-ai' },
    { pattern: /\b(blockchain|web3|smart\s*contract|ethereum)\b/i, label: 'blockchain' },
];

/**
 * Feature extraction patterns
 */
const FEATURE_PATTERNS: RegExp[] = [
    // Action verbs followed by nouns
    /\b(create|build|implement|add|develop|design)\s+(?:a\s+)?([\w\s]+?)(?:\.|,|$|\band\b)/gi,
    // "X feature" or "X functionality"
    /\b([\w\s]+?)\s+(feature|functionality|module|component|page|screen|view)\b/gi,
    // Bullet points or numbered items (common in requirements)
    /^\s*[-*•]\s*(.+)$/gm,
    /^\s*\d+[.)\s]+(.+)$/gm,
    // "should be able to X"
    /should\s+(?:be\s+able\s+to\s+)?([\w\s]+?)(?:\.|,|$)/gi,
    // "needs to X" or "must X"
    /(?:needs?|must|shall)\s+(?:to\s+)?([\w\s]+?)(?:\.|,|$)/gi,
];

/**
 * ComplexityAnalyzer - Main service class
 */
export class ComplexityAnalyzer {
    private config: ComplexityAnalyzerConfig;

    constructor(config: Partial<ComplexityAnalyzerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Analyze a requirement and produce a complexity score
     * 
     * @param requirement - The user's requirement text
     * @param contextFiles - Optional list of existing files for context
     * @returns ComplexityScore with full analysis
     */
    async analyze(requirement: string, contextFiles?: string[]): Promise<ComplexityScore> {
        // Extract all metrics
        const metrics = this.extractMetrics(requirement, contextFiles);
        
        // Calculate numeric score
        const score = this.calculateScore(metrics);
        
        // Determine complexity level
        const level = this.determineLevel(score);
        
        // Estimate tokens needed
        const estimatedTokens = this.estimateTokens(requirement, metrics);
        
        // Determine recommendation
        const recommendation = this.determineRecommendation(level, estimatedTokens);
        
        // Calculate suggested phases if splitting
        const suggestedPhaseCount = recommendation === 'SPLIT_PHASES' 
            ? Math.ceil(estimatedTokens / this.config.tokensPerPhase)
            : undefined;
        
        // Generate explanation
        const explanation = this.generateExplanation(metrics, score, level, recommendation);
        
        return {
            level,
            score,
            estimatedTokens,
            metrics,
            recommendation,
            explanation,
            suggestedPhaseCount
        };
    }

    /**
     * Extract all metrics from the requirement text
     */
    private extractMetrics(requirement: string, contextFiles?: string[]): ComplexityMetrics {
        const features = this.extractFeatures(requirement);
        const scopeIndicators = this.detectScopeIndicators(requirement);
        const riskFactors = this.detectRiskFactors(requirement);
        const technicalDomains = this.detectTechnicalDomains(requirement);
        const estimatedFileCount = this.estimateFileCount(features, technicalDomains, contextFiles);
        
        return {
            featureCount: features.length,
            estimatedFileCount,
            scopeIndicators,
            riskFactors,
            textLength: requirement.length,
            technicalDomains
        };
    }

    /**
     * Extract distinct features from requirement text
     */
    private extractFeatures(text: string): string[] {
        const features = new Set<string>();
        
        for (const pattern of FEATURE_PATTERNS) {
            // Reset lastIndex for global patterns
            pattern.lastIndex = 0;
            
            let match;
            while ((match = pattern.exec(text)) !== null) {
                // Get the captured group (feature description)
                const feature = (match[1] || match[2] || '').trim().toLowerCase();
                
                // Filter out noise
                if (feature.length > 3 && feature.length < 100 && !this.isNoiseWord(feature)) {
                    features.add(feature);
                }
            }
        }
        
        // Also count explicit "and" separated items as potentially multiple features
        const andSeparated = text.match(/\b(\w+)(?:\s*,\s*|\s+and\s+)(\w+)(?:\s*,\s*|\s+and\s+)(\w+)\b/gi);
        if (andSeparated) {
            features.add('multiple-listed-items');
        }
        
        return Array.from(features);
    }

    /**
     * Check if a word is just noise (common words that aren't features)
     */
    private isNoiseWord(word: string): boolean {
        const noiseWords = [
            'the', 'this', 'that', 'with', 'from', 'they', 'have', 'been',
            'some', 'them', 'these', 'those', 'then', 'than', 'into', 'also',
            'just', 'only', 'such', 'like', 'well', 'back', 'even', 'still',
            'able', 'following', 'something', 'anything', 'everything'
        ];
        return noiseWords.includes(word.toLowerCase());
    }

    /**
     * Detect scope indicators in the requirement
     */
    private detectScopeIndicators(text: string): string[] {
        const detected: string[] = [];
        
        for (const indicator of SCOPE_INDICATORS) {
            if (indicator.pattern.test(text)) {
                detected.push(indicator.label);
            }
        }
        
        return detected;
    }

    /**
     * Detect risk factors in the requirement
     */
    private detectRiskFactors(text: string): string[] {
        const detected: string[] = [];
        
        for (const factor of RISK_FACTORS) {
            if (factor.pattern.test(text)) {
                detected.push(factor.label);
            }
        }
        
        return detected;
    }

    /**
     * Detect technical domains mentioned
     */
    private detectTechnicalDomains(text: string): string[] {
        const detected: string[] = [];
        
        for (const domain of TECHNICAL_DOMAINS) {
            if (domain.pattern.test(text)) {
                detected.push(domain.label);
            }
        }
        
        return detected;
    }

    /**
     * Estimate the number of files that will be created/modified
     */
    private estimateFileCount(
        features: string[], 
        domains: string[], 
        contextFiles?: string[]
    ): number {
        // Base: 1-2 files per feature
        let estimate = features.length * 1.5;
        
        // Add files for each technical domain (typically need multiple files per domain)
        estimate += domains.length * 3;
        
        // If context files provided, assume some percentage will be modified
        if (contextFiles && contextFiles.length > 0) {
            estimate += Math.min(contextFiles.length * 0.1, 10);
        }
        
        // Minimum of 1, maximum of 50 for sanity
        return Math.max(1, Math.min(Math.round(estimate), 50));
    }

    /**
     * Calculate the numeric complexity score (0-100)
     */
    private calculateScore(metrics: ComplexityMetrics): number {
        let score = 0;
        
        // Feature count: 3 points each (max 30)
        score += Math.min(metrics.featureCount * 3, 30);
        
        // File count: 2 points each (max 20)
        score += Math.min(metrics.estimatedFileCount * 2, 20);
        
        // Scope indicators: variable weight
        for (const indicator of metrics.scopeIndicators) {
            const match = SCOPE_INDICATORS.find(s => s.label === indicator);
            if (match) {
                score += match.weight;
            }
        }
        
        // Risk factors: variable weight
        for (const factor of metrics.riskFactors) {
            const match = RISK_FACTORS.find(r => r.label === factor);
            if (match) {
                score += match.weight;
            }
        }
        
        // Text length: 1 point per 100 chars (max 20)
        score += Math.min(Math.floor(metrics.textLength / 100), 20);
        
        // Technical domains: 3 points each for multiple domains
        if (metrics.technicalDomains.length > 1) {
            score += (metrics.technicalDomains.length - 1) * 3;
        }
        
        // Cap at 100
        return Math.min(score, 100);
    }

    /**
     * Determine complexity level from score
     */
    private determineLevel(score: number): ComplexityLevel {
        if (score <= this.config.lowThreshold) {
            return 'LOW';
        } else if (score <= this.config.mediumThreshold) {
            return 'MEDIUM';
        } else if (score <= this.config.highThreshold) {
            return 'HIGH';
        } else {
            return 'EXTREME';
        }
    }

    /**
     * Estimate tokens needed for full implementation
     */
    private estimateTokens(requirement: string, metrics: ComplexityMetrics): number {
        // Base tokens for requirement itself (~4 chars per token)
        let tokens = Math.ceil(requirement.length / 4);
        
        // Tokens for each file (average ~500 tokens per file for reading + writing)
        tokens += metrics.estimatedFileCount * 500;
        
        // Tokens for each feature discussion/implementation
        tokens += metrics.featureCount * 1000;
        
        // Additional tokens for complex domains
        tokens += metrics.technicalDomains.length * 2000;
        
        // Risk factors add overhead
        tokens += metrics.riskFactors.length * 1500;
        
        // Scope indicators add significant overhead
        tokens += metrics.scopeIndicators.length * 3000;
        
        return tokens;
    }

    /**
     * Determine recommendation based on analysis
     */
    private determineRecommendation(
        level: ComplexityLevel, 
        estimatedTokens: number
    ): ComplexityRecommendation {
        // If tokens exceed budget significantly, require clarification
        if (estimatedTokens > this.config.tokensPerPhase * 5) {
            return 'REQUIRE_CLARIFICATION';
        }
        
        // If HIGH or EXTREME, recommend splitting
        if (level === 'HIGH' || level === 'EXTREME') {
            return 'SPLIT_PHASES';
        }
        
        // If tokens exceed single phase but level is low/medium, still split
        if (estimatedTokens > this.config.tokensPerPhase) {
            return 'SPLIT_PHASES';
        }
        
        return 'PROCEED';
    }

    /**
     * Generate human-readable explanation
     */
    private generateExplanation(
        metrics: ComplexityMetrics,
        score: number,
        level: ComplexityLevel,
        recommendation: ComplexityRecommendation
    ): string {
        const parts: string[] = [];
        
        parts.push(`Complexity Score: ${score}/100 (${level})`);
        parts.push(``);
        parts.push(`Analysis found:`);
        parts.push(`- ${metrics.featureCount} distinct feature(s)`);
        parts.push(`- ~${metrics.estimatedFileCount} file(s) estimated`);
        
        if (metrics.scopeIndicators.length > 0) {
            parts.push(`- Scope indicators: ${metrics.scopeIndicators.join(', ')}`);
        }
        
        if (metrics.riskFactors.length > 0) {
            parts.push(`- Risk factors: ${metrics.riskFactors.join(', ')}`);
        }
        
        if (metrics.technicalDomains.length > 0) {
            parts.push(`- Technical domains: ${metrics.technicalDomains.join(', ')}`);
        }
        
        parts.push(``);
        
        switch (recommendation) {
            case 'PROCEED':
                parts.push(`✅ Recommendation: PROCEED - This requirement can be handled in a single execution.`);
                break;
            case 'SPLIT_PHASES':
                parts.push(`⚠️ Recommendation: SPLIT INTO PHASES - This requirement is too large for single execution.`);
                break;
            case 'REQUIRE_CLARIFICATION':
                parts.push(`🛑 Recommendation: REQUIRE CLARIFICATION - This requirement is too broad. Please break it down.`);
                break;
        }
        
        return parts.join('\n');
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<ComplexityAnalyzerConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current configuration
     */
    getConfig(): ComplexityAnalyzerConfig {
        return { ...this.config };
    }
}

/**
 * Factory function for creating a ComplexityAnalyzer with default config
 */
export function createComplexityAnalyzer(config?: Partial<ComplexityAnalyzerConfig>): ComplexityAnalyzer {
    return new ComplexityAnalyzer(config);
}
