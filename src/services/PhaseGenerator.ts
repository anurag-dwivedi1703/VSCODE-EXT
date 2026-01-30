/**
 * PhaseGenerator - Splits complex requirements into manageable phases
 * 
 * This service is part of the Phased Execution Guard-Rails system that prevents
 * context exhaustion when users submit large, monolithic requirements.
 * 
 * Phase 2 of 5 - Phase Generation
 */

import { ComplexityAnalyzer, ComplexityScore } from './ComplexityAnalyzer';

/**
 * Status of a phase in the execution lifecycle
 */
export type PhaseStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';

/**
 * Splitting strategy to use for phase generation
 */
export type SplittingStrategy = 'feature-based' | 'layer-based' | 'incremental' | 'auto';

/**
 * A single phase in the execution plan
 */
export interface Phase {
    /** Unique phase identifier (e.g., "phase-1") */
    id: string;

    /** Human-readable phase name */
    name: string;

    /** Detailed description of what this phase accomplishes */
    description: string;

    /** Specific requirements/tasks for this phase */
    requirements: string[];

    /** Expected outputs/deliverables from this phase */
    deliverables: string[];

    /** Criteria to verify phase completion */
    verificationCriteria: string[];

    /** Estimated token budget for this phase */
    estimatedTokens: number;

    /** Phase IDs that must complete before this phase */
    dependencies: string[];

    /** Current status of this phase */
    status: PhaseStatus;

    /** Order index for execution (0-based) */
    order: number;

    /** Technical domains involved in this phase */
    domains: string[];

    /** Risk factors specific to this phase */
    riskFactors: string[];
}

/**
 * Result of phase generation
 */
export interface PhaseGenerationResult {
    /** Original requirement text */
    originalRequirement: string;

    /** Total number of phases generated */
    totalPhases: number;

    /** Array of generated phases */
    phases: Phase[];

    /** Ordered list of phase IDs for execution */
    executionOrder: string[];

    /** Total estimated tokens across all phases */
    estimatedTotalTokens: number;

    /** Strategy used for splitting */
    strategyUsed: SplittingStrategy;

    /** Complexity score that triggered phase generation */
    complexityScore: ComplexityScore;

    /** Summary explanation of the phase split */
    summary: string;
}

/**
 * Configuration options for phase generation
 */
export interface PhaseGeneratorConfig {
    /** Maximum tokens per phase (default: 30000) */
    maxTokensPerPhase: number;

    /** Minimum features per phase (default: 1) */
    minFeaturesPerPhase: number;

    /** Maximum features per phase (default: 5) */
    maxFeaturesPerPhase: number;

    /** Preferred splitting strategy (default: 'auto') */
    preferredStrategy: SplittingStrategy;

    /** Whether to include verification criteria (default: true) */
    includeVerification: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: PhaseGeneratorConfig = {
    maxTokensPerPhase: 30000,
    minFeaturesPerPhase: 1,
    maxFeaturesPerPhase: 5,
    preferredStrategy: 'auto',
    includeVerification: true
};

/**
 * Layer definitions for layer-based splitting
 */
const LAYER_DEFINITIONS = [
    {
        name: 'Foundation',
        keywords: ['setup', 'config', 'initialize', 'scaffold', 'structure', 'types', 'interfaces', 'models', 'schema'],
        domains: ['database', 'backend'],
        order: 0
    },
    {
        name: 'Data Layer',
        keywords: ['database', 'model', 'schema', 'migration', 'entity', 'repository', 'data'],
        domains: ['database'],
        order: 1
    },
    {
        name: 'Backend/API',
        keywords: ['api', 'endpoint', 'controller', 'service', 'backend', 'server', 'route', 'handler'],
        domains: ['backend'],
        order: 2
    },
    {
        name: 'Business Logic',
        keywords: ['logic', 'validation', 'process', 'workflow', 'rule', 'calculation'],
        domains: ['backend'],
        order: 3
    },
    {
        name: 'Frontend/UI',
        keywords: ['frontend', 'ui', 'component', 'page', 'view', 'screen', 'form', 'display'],
        domains: ['frontend'],
        order: 4
    },
    {
        name: 'Integration',
        keywords: ['integrate', 'connect', 'sync', 'webhook', 'external', 'third-party'],
        domains: ['backend', 'frontend'],
        order: 5
    },
    {
        name: 'Testing & Polish',
        keywords: ['test', 'testing', 'qa', 'fix', 'polish', 'refine', 'optimize'],
        domains: ['frontend', 'backend', 'database'],
        order: 6
    }
];

/**
 * Feature grouping patterns for feature-based splitting
 */
const FEATURE_GROUPS = [
    {
        name: 'Authentication',
        patterns: [/auth/i, /login/i, /register/i, /password/i, /session/i, /oauth/i, /jwt/i, /token/i]
    },
    {
        name: 'User Management',
        patterns: [/user/i, /profile/i, /account/i, /role/i, /permission/i, /admin/i]
    },
    {
        name: 'Data Management',
        patterns: [/crud/i, /create/i, /read/i, /update/i, /delete/i, /list/i, /view/i, /edit/i]
    },
    {
        name: 'Search & Filter',
        patterns: [/search/i, /filter/i, /sort/i, /query/i, /find/i]
    },
    {
        name: 'Notifications',
        patterns: [/notif/i, /email/i, /alert/i, /message/i, /sms/i, /push/i]
    },
    {
        name: 'Payments',
        patterns: [/payment/i, /checkout/i, /cart/i, /order/i, /invoice/i, /billing/i, /stripe/i, /paypal/i]
    },
    {
        name: 'Dashboard & Analytics',
        patterns: [/dashboard/i, /analytics/i, /report/i, /chart/i, /graph/i, /metric/i, /stat/i]
    },
    {
        name: 'Settings & Configuration',
        patterns: [/setting/i, /config/i, /preference/i, /option/i, /customize/i]
    },
    {
        name: 'File Management',
        patterns: [/file/i, /upload/i, /download/i, /image/i, /document/i, /media/i, /storage/i]
    },
    {
        name: 'Communication',
        patterns: [/chat/i, /comment/i, /forum/i, /discussion/i, /real-?time/i, /websocket/i]
    }
];

/**
 * PhaseGenerator - Main service class
 */
export class PhaseGenerator {
    private config: PhaseGeneratorConfig;
    private complexityAnalyzer: ComplexityAnalyzer;

    constructor(
        complexityAnalyzer?: ComplexityAnalyzer,
        config: Partial<PhaseGeneratorConfig> = {}
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.complexityAnalyzer = complexityAnalyzer || new ComplexityAnalyzer();
    }

    /**
     * Generate phases for a requirement
     * 
     * @param requirement - The user's requirement text
     * @param complexityScore - Pre-computed complexity score (optional)
     * @returns PhaseGenerationResult with all phases
     */
    async generatePhases(
        requirement: string,
        complexityScore?: ComplexityScore
    ): Promise<PhaseGenerationResult> {
        // Get complexity score if not provided
        const score = complexityScore || await this.complexityAnalyzer.analyze(requirement);

        // Determine best splitting strategy
        const strategy = this.determineStrategy(requirement, score);

        // Generate phases based on strategy
        let phases: Phase[];
        switch (strategy) {
            case 'layer-based':
                phases = this.splitByLayers(requirement, score);
                break;
            case 'incremental':
                phases = this.splitIncremental(requirement, score);
                break;
            case 'feature-based':
            default:
                phases = this.splitByFeatures(requirement, score);
                break;
        }

        // Ensure we have at least one phase
        if (phases.length === 0) {
            phases = [this.createSinglePhase(requirement, score)];
        }

        // Calculate dependencies and order
        this.calculateDependencies(phases);

        // Add verification criteria if enabled
        if (this.config.includeVerification) {
            phases.forEach(phase => {
                if (phase.verificationCriteria.length === 0) {
                    phase.verificationCriteria = this.generateVerificationCriteria(phase);
                }
            });
        }

        // Build execution order
        const executionOrder = this.buildExecutionOrder(phases);

        // Calculate total tokens
        const estimatedTotalTokens = phases.reduce((sum, p) => sum + p.estimatedTokens, 0);

        // Generate summary
        const summary = this.generateSummary(phases, strategy, score);

        return {
            originalRequirement: requirement,
            totalPhases: phases.length,
            phases,
            executionOrder,
            estimatedTotalTokens,
            strategyUsed: strategy,
            complexityScore: score,
            summary
        };
    }

    /**
     * Determine the best splitting strategy based on requirement analysis
     */
    private determineStrategy(requirement: string, score: ComplexityScore): SplittingStrategy {
        if (this.config.preferredStrategy !== 'auto') {
            return this.config.preferredStrategy;
        }

        const metrics = score.metrics;
        const text = requirement.toLowerCase();

        // If multiple technical domains, layer-based is often best
        if (metrics.technicalDomains.length >= 3) {
            return 'layer-based';
        }

        // If "full-stack" or "end-to-end" mentioned, use layer-based
        if (text.includes('full-stack') || text.includes('full stack') ||
            text.includes('end-to-end') || text.includes('end to end')) {
            return 'layer-based';
        }

        // If complexity is EXTREME, use incremental (MVP first)
        if (score.level === 'EXTREME') {
            return 'incremental';
        }

        // If many distinct features detected, use feature-based
        if (metrics.featureCount >= 4) {
            return 'feature-based';
        }

        // Default to feature-based
        return 'feature-based';
    }

    /**
     * Split requirement by features
     */
    private splitByFeatures(requirement: string, score: ComplexityScore): Phase[] {
        const phases: Phase[] = [];
        const features = this.extractFeatureGroups(requirement);

        // Group features to respect max features per phase
        const featureChunks = this.chunkFeatures(features, this.config.maxFeaturesPerPhase);

        featureChunks.forEach((chunk, index) => {
            const phase = this.createPhaseFromFeatures(chunk, index, score);
            phases.push(phase);
        });

        // Ensure token budgets are respected
        return this.balancePhaseTokens(phases, score);
    }

    /**
     * Split requirement by architectural layers
     */
    private splitByLayers(requirement: string, score: ComplexityScore): Phase[] {
        const phases: Phase[] = [];
        const text = requirement.toLowerCase();
        const metrics = score.metrics;

        // Determine which layers are relevant
        const relevantLayers = LAYER_DEFINITIONS.filter(layer => {
            // Check if any keywords match
            const keywordMatch = layer.keywords.some(kw => text.includes(kw));

            // Check if domains match
            const domainMatch = layer.domains.some(d => metrics.technicalDomains.includes(d));

            return keywordMatch || domainMatch;
        });

        // If no specific layers detected, use a sensible default
        const layersToUse = relevantLayers.length > 0
            ? relevantLayers
            : LAYER_DEFINITIONS.filter(l => ['Foundation', 'Backend/API', 'Frontend/UI'].includes(l.name));

        // Sort by order
        layersToUse.sort((a, b) => a.order - b.order);

        // Create a phase for each layer
        layersToUse.forEach((layer, index) => {
            const phase = this.createPhaseFromLayer(layer, requirement, index, score);
            phases.push(phase);
        });

        return this.balancePhaseTokens(phases, score);
    }

    /**
     * Split requirement incrementally (MVP → Enhanced → Polish)
     */
    private splitIncremental(requirement: string, score: ComplexityScore): Phase[] {
        const phases: Phase[] = [];
        const features = this.extractFeatureGroups(requirement);

        // Categorize features by priority
        const coreFeatues: string[] = [];
        const secondaryFeatures: string[] = [];
        const polishFeatures: string[] = [];

        features.forEach(feature => {
            const name = feature.name.toLowerCase();
            const items = feature.items;

            // Core: Authentication, basic CRUD, essential functionality
            if (name.includes('auth') || name.includes('user') ||
                name.includes('data management') || items.length > 0) {
                coreFeatues.push(...items, feature.name);
            }
            // Polish: Analytics, optimization, advanced features
            else if (name.includes('analytics') || name.includes('dashboard') ||
                name.includes('notification')) {
                polishFeatures.push(...items, feature.name);
            }
            // Secondary: Everything else
            else {
                secondaryFeatures.push(...items, feature.name);
            }
        });

        // Phase 1: MVP / Core
        if (coreFeatues.length > 0 || features.length === 0) {
            phases.push({
                id: 'phase-1',
                name: 'Core MVP',
                description: 'Implement the essential core functionality that forms the foundation of the system.',
                requirements: coreFeatues.length > 0 ? coreFeatues : ['Implement basic structure and core features'],
                deliverables: ['Working core functionality', 'Basic data flow established'],
                verificationCriteria: [],
                estimatedTokens: Math.floor(score.estimatedTokens * 0.4),
                dependencies: [],
                status: 'pending',
                order: 0,
                domains: score.metrics.technicalDomains.slice(0, 2),
                riskFactors: score.metrics.riskFactors.filter(r => r.includes('security') || r.includes('migration'))
            });
        }

        // Phase 2: Secondary Features
        if (secondaryFeatures.length > 0) {
            phases.push({
                id: 'phase-2',
                name: 'Secondary Features',
                description: 'Add secondary features that enhance the core functionality.',
                requirements: secondaryFeatures,
                deliverables: ['Enhanced functionality', 'Additional features working'],
                verificationCriteria: [],
                estimatedTokens: Math.floor(score.estimatedTokens * 0.35),
                dependencies: ['phase-1'],
                status: 'pending',
                order: 1,
                domains: score.metrics.technicalDomains,
                riskFactors: score.metrics.riskFactors.filter(r => r.includes('integration'))
            });
        }

        // Phase 3: Polish & Optimization
        if (polishFeatures.length > 0 || score.metrics.riskFactors.some(r => r.includes('performance'))) {
            phases.push({
                id: `phase-${phases.length + 1}`,
                name: 'Polish & Optimization',
                description: 'Add analytics, optimize performance, and polish the user experience.',
                requirements: polishFeatures.length > 0 ? polishFeatures : ['Performance optimization', 'Final polish'],
                deliverables: ['Optimized performance', 'Complete feature set', 'Production-ready code'],
                verificationCriteria: [],
                estimatedTokens: Math.floor(score.estimatedTokens * 0.25),
                dependencies: phases.map(p => p.id),
                status: 'pending',
                order: phases.length,
                domains: score.metrics.technicalDomains,
                riskFactors: score.metrics.riskFactors.filter(r => r.includes('performance') || r.includes('testing'))
            });
        }

        return phases;
    }

    /**
     * Extract and group features from requirement text
     */
    private extractFeatureGroups(requirement: string): { name: string; items: string[] }[] {
        const groups: { name: string; items: string[] }[] = [];
        const text = requirement.toLowerCase();

        // Check each feature group pattern
        FEATURE_GROUPS.forEach(group => {
            const matchingItems: string[] = [];

            group.patterns.forEach(pattern => {
                if (pattern.test(text)) {
                    // Extract the context around the match
                    const match = text.match(pattern);
                    if (match) {
                        matchingItems.push(match[0]);
                    }
                }
            });

            if (matchingItems.length > 0) {
                groups.push({
                    name: group.name,
                    items: Array.from(new Set(matchingItems)) // Dedupe
                });
            }
        });

        // If no groups detected, create a generic one
        if (groups.length === 0) {
            // Extract bullet points or numbered items
            const bullets = requirement.match(/^\s*[-*•]\s*(.+)$/gm) || [];
            const numbered = requirement.match(/^\s*\d+[.)\s]+(.+)$/gm) || [];
            const items = [...bullets, ...numbered].map(s => s.trim());

            if (items.length > 0) {
                groups.push({ name: 'General Features', items });
            } else {
                groups.push({ name: 'Implementation', items: [requirement.slice(0, 100)] });
            }
        }

        return groups;
    }

    /**
     * Chunk features into groups respecting max per phase
     */
    private chunkFeatures(
        features: { name: string; items: string[] }[],
        maxPerPhase: number
    ): { name: string; items: string[] }[][] {
        const chunks: { name: string; items: string[] }[][] = [];
        let currentChunk: { name: string; items: string[] }[] = [];
        let currentCount = 0;

        features.forEach(feature => {
            if (currentCount + 1 > maxPerPhase && currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentCount = 0;
            }
            currentChunk.push(feature);
            currentCount++;
        });

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    /**
     * Create a phase from a group of features
     */
    private createPhaseFromFeatures(
        features: { name: string; items: string[] }[],
        index: number,
        score: ComplexityScore
    ): Phase {
        const featureNames = features.map(f => f.name);
        const allItems = features.flatMap(f => f.items);

        return {
            id: `phase-${index + 1}`,
            name: featureNames.length === 1 ? featureNames[0] : `Features: ${featureNames.join(', ')}`,
            description: `Implement ${featureNames.join(', ').toLowerCase()} functionality.`,
            requirements: allItems.length > 0 ? allItems : featureNames,
            deliverables: featureNames.map(n => `Working ${n.toLowerCase()}`),
            verificationCriteria: [],
            estimatedTokens: Math.floor(score.estimatedTokens / Math.max(score.suggestedPhaseCount || 2, 2)),
            dependencies: index > 0 ? [`phase-${index}`] : [],
            status: 'pending',
            order: index,
            domains: score.metrics.technicalDomains,
            riskFactors: []
        };
    }

    /**
     * Create a phase from an architectural layer
     */
    private createPhaseFromLayer(
        layer: typeof LAYER_DEFINITIONS[0],
        requirement: string,
        index: number,
        score: ComplexityScore
    ): Phase {
        const relevantRequirements = this.extractLayerRequirements(requirement, layer);

        return {
            id: `phase-${index + 1}`,
            name: layer.name,
            description: `Implement the ${layer.name.toLowerCase()} components of the system.`,
            requirements: relevantRequirements,
            deliverables: [`Completed ${layer.name.toLowerCase()}`, `${layer.name} tests passing`],
            verificationCriteria: [],
            estimatedTokens: Math.floor(score.estimatedTokens / Math.max(score.suggestedPhaseCount || 3, 3)),
            dependencies: index > 0 ? [`phase-${index}`] : [],
            status: 'pending',
            order: index,
            domains: layer.domains,
            riskFactors: score.metrics.riskFactors.filter(r =>
                layer.domains.some(d => r.toLowerCase().includes(d))
            )
        };
    }

    /**
     * Extract requirements relevant to a specific layer
     */
    private extractLayerRequirements(requirement: string, layer: typeof LAYER_DEFINITIONS[0]): string[] {
        const requirements: string[] = [];
        const lines = requirement.split(/[.\n]/).map(l => l.trim()).filter(l => l.length > 0);

        lines.forEach(line => {
            const lineLower = line.toLowerCase();
            if (layer.keywords.some(kw => lineLower.includes(kw))) {
                requirements.push(line);
            }
        });

        // If no specific requirements found, add generic ones
        if (requirements.length === 0) {
            requirements.push(`Implement ${layer.name.toLowerCase()} components`);
        }

        return requirements;
    }

    /**
     * Create a single phase for simple requirements
     */
    private createSinglePhase(requirement: string, score: ComplexityScore): Phase {
        return {
            id: 'phase-1',
            name: 'Implementation',
            description: 'Complete implementation of the requirement.',
            requirements: [requirement],
            deliverables: ['Working implementation', 'Tests passing'],
            verificationCriteria: ['Code compiles without errors', 'Basic functionality works'],
            estimatedTokens: score.estimatedTokens,
            dependencies: [],
            status: 'pending',
            order: 0,
            domains: score.metrics.technicalDomains,
            riskFactors: score.metrics.riskFactors
        };
    }

    /**
     * Balance token budgets across phases
     */
    private balancePhaseTokens(phases: Phase[], score: ComplexityScore): Phase[] {
        const totalTokens = score.estimatedTokens;
        const maxPerPhase = this.config.maxTokensPerPhase;

        // Check if any phase exceeds budget
        phases.forEach(phase => {
            if (phase.estimatedTokens > maxPerPhase) {
                phase.estimatedTokens = maxPerPhase;
            }
        });

        // Redistribute if total is way off
        const currentTotal = phases.reduce((sum, p) => sum + p.estimatedTokens, 0);
        if (Math.abs(currentTotal - totalTokens) > totalTokens * 0.2) {
            const factor = totalTokens / currentTotal;
            phases.forEach(phase => {
                phase.estimatedTokens = Math.floor(phase.estimatedTokens * factor);
            });
        }

        return phases;
    }

    /**
     * Calculate dependencies between phases
     */
    private calculateDependencies(phases: Phase[]): void {
        // Simple linear dependencies if not already set
        phases.forEach((phase, index) => {
            if (phase.dependencies.length === 0 && index > 0) {
                phase.dependencies = [`phase-${index}`];
            }
            phase.order = index;
        });
    }

    /**
     * Build execution order respecting dependencies
     */
    private buildExecutionOrder(phases: Phase[]): string[] {
        // Simple topological sort (phases are mostly linear)
        const order: string[] = [];
        const visited = new Set<string>();

        const visit = (phaseId: string) => {
            if (visited.has(phaseId)) { return; }

            const phase = phases.find(p => p.id === phaseId);
            if (!phase) { return; }

            // Visit dependencies first
            phase.dependencies.forEach(depId => visit(depId));

            visited.add(phaseId);
            order.push(phaseId);
        };

        // Sort by order first, then visit
        phases.sort((a, b) => a.order - b.order);
        phases.forEach(phase => visit(phase.id));

        return order;
    }

    /**
     * Generate verification criteria for a phase
     */
    private generateVerificationCriteria(phase: Phase): string[] {
        const criteria: string[] = [];

        // Basic criteria
        criteria.push('Code compiles/transpiles without errors');

        // Domain-specific criteria
        if (phase.domains.includes('frontend')) {
            criteria.push('UI components render correctly');
            criteria.push('No console errors in browser');
        }

        if (phase.domains.includes('backend')) {
            criteria.push('API endpoints respond correctly');
            criteria.push('No server errors in logs');
        }

        if (phase.domains.includes('database')) {
            criteria.push('Database migrations run successfully');
            criteria.push('Data integrity maintained');
        }

        // Deliverable-based criteria
        phase.deliverables.forEach(deliverable => {
            criteria.push(`${deliverable} is functional`);
        });

        // Risk-based criteria
        if (phase.riskFactors.includes('security-concerns')) {
            criteria.push('Security measures implemented and tested');
        }

        if (phase.riskFactors.includes('performance-optimization')) {
            criteria.push('Performance meets acceptable thresholds');
        }

        return Array.from(new Set(criteria)); // Dedupe
    }

    /**
     * Generate summary of the phase split
     */
    private generateSummary(
        phases: Phase[],
        strategy: SplittingStrategy,
        score: ComplexityScore
    ): string {
        const parts: string[] = [];

        parts.push(`## Phase Generation Summary`);
        parts.push('');
        parts.push(`**Strategy Used:** ${strategy}`);
        parts.push(`**Complexity Level:** ${score.level} (Score: ${score.score}/100)`);
        parts.push(`**Total Phases:** ${phases.length}`);
        parts.push('');
        parts.push(`### Phases Overview`);
        parts.push('');

        phases.forEach((phase, index) => {
            parts.push(`**${index + 1}. ${phase.name}**`);
            parts.push(`   - ${phase.description}`);
            parts.push(`   - Estimated tokens: ~${phase.estimatedTokens.toLocaleString()}`);
            parts.push(`   - Deliverables: ${phase.deliverables.join(', ')}`);
            parts.push('');
        });

        return parts.join('\n');
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<PhaseGeneratorConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current configuration
     */
    getConfig(): PhaseGeneratorConfig {
        return { ...this.config };
    }
}

/**
 * Factory function for creating a PhaseGenerator
 */
export function createPhaseGenerator(
    complexityAnalyzer?: ComplexityAnalyzer,
    config?: Partial<PhaseGeneratorConfig>
): PhaseGenerator {
    return new PhaseGenerator(complexityAnalyzer, config);
}
