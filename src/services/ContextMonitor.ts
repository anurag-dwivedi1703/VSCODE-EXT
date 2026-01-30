/**
 * ContextMonitor - Tracks token usage and triggers phase boundaries
 * 
 * This service is part of the Phased Execution Guard-Rails system that prevents
 * context exhaustion when users submit large, monolithic requirements.
 * 
 * Phase 3 of 5 - Context Monitoring
 */

import * as vscode from 'vscode';

/**
 * Budget status levels
 */
export type BudgetStatus = 'healthy' | 'warning' | 'critical' | 'exhausted';

/**
 * Recommended action based on budget status
 */
export type RecommendedAction = 'continue' | 'wrap-up' | 'checkpoint' | 'stop';

/**
 * Type of token usage event
 */
export type TokenUsageType = 'prompt' | 'response' | 'context' | 'tool-call' | 'tool-result' | 'system';

/**
 * A single token usage event
 */
export interface TokenUsageEvent {
    /** Type of usage */
    type: TokenUsageType;
    
    /** Number of tokens used */
    tokens: number;
    
    /** Timestamp of the event */
    timestamp: number;
    
    /** Source identifier (e.g., "user-message", "file-read", "ai-response") */
    source: string;
    
    /** Optional description of what caused this usage */
    description?: string;
    
    /** Phase ID if tracking per-phase */
    phaseId?: string;
}

/**
 * Current context budget state
 */
export interface ContextBudget {
    /** Maximum tokens allowed for this phase/session */
    totalBudget: number;
    
    /** Tokens consumed so far */
    used: number;
    
    /** Tokens remaining */
    remaining: number;
    
    /** Percentage of budget used (0-100) */
    percentUsed: number;
    
    /** Current status level */
    status: BudgetStatus;
    
    /** Recommended action based on current state */
    recommendedAction: RecommendedAction;
    
    /** Estimated tokens for next operation (if known) */
    estimatedNext?: number;
    
    /** Whether the next operation can be afforded */
    canAffordNext?: boolean;
}

/**
 * Budget alert information
 */
export interface BudgetAlert {
    /** Alert level */
    level: BudgetStatus;
    
    /** Human-readable message */
    message: string;
    
    /** Current budget state */
    budget: ContextBudget;
    
    /** Timestamp of alert */
    timestamp: number;
    
    /** Suggested actions */
    suggestions: string[];
}

/**
 * Token usage statistics
 */
export interface UsageStatistics {
    /** Total tokens used */
    totalTokens: number;
    
    /** Breakdown by type */
    byType: Record<TokenUsageType, number>;
    
    /** Breakdown by source */
    bySource: Record<string, number>;
    
    /** Number of events recorded */
    eventCount: number;
    
    /** Average tokens per event */
    averagePerEvent: number;
    
    /** Peak usage in a single event */
    peakUsage: number;
    
    /** Time span of tracking (ms) */
    timeSpan: number;
    
    /** Tokens per minute rate */
    tokensPerMinute: number;
}

/**
 * Configuration options for the context monitor
 */
export interface ContextMonitorConfig {
    /** Total token budget (default: 30000) */
    totalBudget: number;
    
    /** Warning threshold percentage (default: 70) */
    warningThreshold: number;
    
    /** Critical threshold percentage (default: 90) */
    criticalThreshold: number;
    
    /** Characters per token estimate (default: 4) */
    charsPerToken: number;
    
    /** Whether to emit VS Code notifications (default: false) */
    emitNotifications: boolean;
    
    /** Minimum tokens to reserve for wrap-up (default: 2000) */
    wrapUpReserve: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ContextMonitorConfig = {
    totalBudget: 30000,
    warningThreshold: 70,
    criticalThreshold: 90,
    charsPerToken: 4,
    emitNotifications: false,
    wrapUpReserve: 2000
};

/**
 * Event emitter for budget alerts
 */
export class BudgetEventEmitter {
    private _onWarning = new vscode.EventEmitter<BudgetAlert>();
    private _onCritical = new vscode.EventEmitter<BudgetAlert>();
    private _onExhausted = new vscode.EventEmitter<BudgetAlert>();
    private _onStatusChange = new vscode.EventEmitter<ContextBudget>();
    private _onUsageTracked = new vscode.EventEmitter<TokenUsageEvent>();

    /** Fired when budget reaches warning threshold (70%) */
    readonly onWarning = this._onWarning.event;
    
    /** Fired when budget reaches critical threshold (90%) */
    readonly onCritical = this._onCritical.event;
    
    /** Fired when budget is exhausted (100%) */
    readonly onExhausted = this._onExhausted.event;
    
    /** Fired when budget status changes */
    readonly onStatusChange = this._onStatusChange.event;
    
    /** Fired when usage is tracked */
    readonly onUsageTracked = this._onUsageTracked.event;

    fireWarning(alert: BudgetAlert): void {
        this._onWarning.fire(alert);
    }

    fireCritical(alert: BudgetAlert): void {
        this._onCritical.fire(alert);
    }

    fireExhausted(alert: BudgetAlert): void {
        this._onExhausted.fire(alert);
    }

    fireStatusChange(budget: ContextBudget): void {
        this._onStatusChange.fire(budget);
    }

    fireUsageTracked(event: TokenUsageEvent): void {
        this._onUsageTracked.fire(event);
    }

    dispose(): void {
        this._onWarning.dispose();
        this._onCritical.dispose();
        this._onExhausted.dispose();
        this._onStatusChange.dispose();
        this._onUsageTracked.dispose();
    }
}

/**
 * ContextMonitor - Main service class
 * 
 * Tracks token usage in real-time and triggers alerts/actions when
 * approaching budget limits.
 */
export class ContextMonitor {
    private config: ContextMonitorConfig;
    private usageHistory: TokenUsageEvent[] = [];
    private currentUsed: number = 0;
    private lastStatus: BudgetStatus = 'healthy';
    private phaseId?: string;
    private startTime: number;
    
    /** Event emitters for budget alerts */
    readonly events: BudgetEventEmitter;

    constructor(config: Partial<ContextMonitorConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.events = new BudgetEventEmitter();
        this.startTime = Date.now();
    }

    /**
     * Track a token usage event
     * 
     * @param event - The usage event to track
     */
    trackUsage(event: TokenUsageEvent): void {
        // Add phase ID if set
        if (this.phaseId && !event.phaseId) {
            event.phaseId = this.phaseId;
        }
        
        // Record the event
        this.usageHistory.push(event);
        this.currentUsed += event.tokens;
        
        // Fire usage tracked event
        this.events.fireUsageTracked(event);
        
        // Check for status changes and alerts
        this.checkBudgetStatus();
    }

    /**
     * Track usage from text content (estimates tokens)
     * 
     * @param text - The text content
     * @param type - Type of usage
     * @param source - Source identifier
     */
    trackText(text: string, type: TokenUsageType, source: string): void {
        const tokens = this.estimateTokens(text);
        this.trackUsage({
            type,
            tokens,
            timestamp: Date.now(),
            source,
            description: `${text.length} chars → ~${tokens} tokens`
        });
    }

    /**
     * Track a prompt being sent
     */
    trackPrompt(prompt: string, source: string = 'user-prompt'): void {
        this.trackText(prompt, 'prompt', source);
    }

    /**
     * Track a response received
     */
    trackResponse(response: string, source: string = 'ai-response'): void {
        this.trackText(response, 'response', source);
    }

    /**
     * Track a tool call
     */
    trackToolCall(toolName: string, args: string): void {
        const tokens = this.estimateTokens(toolName + args);
        this.trackUsage({
            type: 'tool-call',
            tokens,
            timestamp: Date.now(),
            source: `tool:${toolName}`,
            description: `Tool call: ${toolName}`
        });
    }

    /**
     * Track a tool result
     */
    trackToolResult(toolName: string, result: string): void {
        const tokens = this.estimateTokens(result);
        this.trackUsage({
            type: 'tool-result',
            tokens,
            timestamp: Date.now(),
            source: `tool-result:${toolName}`,
            description: `Tool result: ${toolName} (${result.length} chars)`
        });
    }

    /**
     * Track context/file content being loaded
     */
    trackContext(content: string, source: string): void {
        this.trackText(content, 'context', source);
    }

    /**
     * Track system prompt overhead
     */
    trackSystemPrompt(prompt: string): void {
        this.trackText(prompt, 'system', 'system-prompt');
    }

    /**
     * Estimate token count for text
     * 
     * Uses a simple character-based estimation.
     * For more accuracy, consider using tiktoken or model-specific tokenizers.
     * 
     * @param text - Text to estimate
     * @returns Estimated token count
     */
    estimateTokens(text: string): number {
        if (!text) {return 0;}
        
        // Base estimation: ~4 characters per token for English
        let estimate = Math.ceil(text.length / this.config.charsPerToken);
        
        // Adjust for code (tends to have more tokens per character)
        const codeIndicators = /[{}[\]();=<>]|function|const|let|var|import|export|class|interface/g;
        const codeMatches = text.match(codeIndicators);
        if (codeMatches && codeMatches.length > 10) {
            estimate = Math.ceil(estimate * 1.2); // 20% increase for code
        }
        
        // Adjust for whitespace-heavy content
        const whitespaceRatio = (text.match(/\s/g) || []).length / text.length;
        if (whitespaceRatio > 0.3) {
            estimate = Math.ceil(estimate * 0.9); // 10% decrease for whitespace-heavy
        }
        
        return estimate;
    }

    /**
     * Get current budget state
     */
    getBudget(): ContextBudget {
        const totalBudget = this.config.totalBudget;
        const used = this.currentUsed;
        const remaining = Math.max(0, totalBudget - used);
        const percentUsed = Math.min(100, (used / totalBudget) * 100);
        const status = this.calculateStatus(percentUsed);
        const recommendedAction = this.calculateRecommendedAction(status, remaining);
        
        return {
            totalBudget,
            used,
            remaining,
            percentUsed: Math.round(percentUsed * 10) / 10, // 1 decimal place
            status,
            recommendedAction
        };
    }

    /**
     * Check if an operation with estimated tokens can be afforded
     * 
     * @param estimatedTokens - Estimated tokens for the operation
     * @returns Whether the operation can be afforded
     */
    canAfford(estimatedTokens: number): boolean {
        const remaining = this.config.totalBudget - this.currentUsed;
        // Reserve some tokens for wrap-up
        const availableForOperation = remaining - this.config.wrapUpReserve;
        return estimatedTokens <= availableForOperation;
    }

    /**
     * Get budget with next operation estimate
     * 
     * @param estimatedNext - Estimated tokens for next operation
     */
    getBudgetWithEstimate(estimatedNext: number): ContextBudget {
        const budget = this.getBudget();
        budget.estimatedNext = estimatedNext;
        budget.canAffordNext = this.canAfford(estimatedNext);
        return budget;
    }

    /**
     * Check if phase boundary should be triggered
     * 
     * @returns Whether to trigger a phase boundary
     */
    shouldTriggerPhaseBoundary(): boolean {
        const budget = this.getBudget();
        
        // Trigger if critical or exhausted
        if (budget.status === 'critical' || budget.status === 'exhausted') {
            return true;
        }
        
        // Trigger if remaining is less than wrap-up reserve
        if (budget.remaining < this.config.wrapUpReserve) {
            return true;
        }
        
        return false;
    }

    /**
     * Get recommended action based on current state
     */
    getRecommendedAction(): RecommendedAction {
        return this.getBudget().recommendedAction;
    }

    /**
     * Get usage statistics
     */
    getStatistics(): UsageStatistics {
        const byType: Record<TokenUsageType, number> = {
            'prompt': 0,
            'response': 0,
            'context': 0,
            'tool-call': 0,
            'tool-result': 0,
            'system': 0
        };
        
        const bySource: Record<string, number> = {};
        let peakUsage = 0;
        
        this.usageHistory.forEach(event => {
            byType[event.type] += event.tokens;
            bySource[event.source] = (bySource[event.source] || 0) + event.tokens;
            if (event.tokens > peakUsage) {
                peakUsage = event.tokens;
            }
        });
        
        const timeSpan = Date.now() - this.startTime;
        const minutes = timeSpan / 60000;
        
        return {
            totalTokens: this.currentUsed,
            byType,
            bySource,
            eventCount: this.usageHistory.length,
            averagePerEvent: this.usageHistory.length > 0 
                ? Math.round(this.currentUsed / this.usageHistory.length) 
                : 0,
            peakUsage,
            timeSpan,
            tokensPerMinute: minutes > 0 ? Math.round(this.currentUsed / minutes) : 0
        };
    }

    /**
     * Get usage history
     * 
     * @param limit - Maximum number of events to return (default: all)
     */
    getHistory(limit?: number): TokenUsageEvent[] {
        if (limit) {
            return this.usageHistory.slice(-limit);
        }
        return [...this.usageHistory];
    }

    /**
     * Reset the monitor for a new phase
     * 
     * @param newBudget - Optional new budget (uses config default if not provided)
     * @param phaseId - Optional phase identifier
     */
    reset(newBudget?: number, phaseId?: string): void {
        this.usageHistory = [];
        this.currentUsed = 0;
        this.lastStatus = 'healthy';
        this.startTime = Date.now();
        this.phaseId = phaseId;
        
        if (newBudget !== undefined) {
            this.config.totalBudget = newBudget;
        }
    }

    /**
     * Set the current phase ID
     */
    setPhase(phaseId: string): void {
        this.phaseId = phaseId;
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<ContextMonitorConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current configuration
     */
    getConfig(): ContextMonitorConfig {
        return { ...this.config };
    }

    /**
     * Generate a budget report string
     */
    generateReport(): string {
        const budget = this.getBudget();
        const stats = this.getStatistics();
        
        const lines: string[] = [
            '## Context Budget Report',
            '',
            `**Status:** ${budget.status.toUpperCase()}`,
            `**Used:** ${budget.used.toLocaleString()} / ${budget.totalBudget.toLocaleString()} tokens (${budget.percentUsed}%)`,
            `**Remaining:** ${budget.remaining.toLocaleString()} tokens`,
            `**Recommended Action:** ${budget.recommendedAction}`,
            '',
            '### Usage Breakdown',
            '',
            '| Type | Tokens | % of Total |',
            '|------|--------|------------|'
        ];
        
        const types: TokenUsageType[] = ['prompt', 'response', 'context', 'tool-call', 'tool-result', 'system'];
        types.forEach(type => {
            const tokens = stats.byType[type];
            const percent = stats.totalTokens > 0 
                ? ((tokens / stats.totalTokens) * 100).toFixed(1) 
                : '0.0';
            lines.push(`| ${type} | ${tokens.toLocaleString()} | ${percent}% |`);
        });
        
        lines.push('');
        lines.push('### Statistics');
        lines.push('');
        lines.push(`- **Events Tracked:** ${stats.eventCount}`);
        lines.push(`- **Average per Event:** ${stats.averagePerEvent} tokens`);
        lines.push(`- **Peak Usage:** ${stats.peakUsage} tokens`);
        lines.push(`- **Rate:** ${stats.tokensPerMinute} tokens/minute`);
        
        return lines.join('\n');
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.events.dispose();
    }

    // Private methods

    /**
     * Calculate status based on percentage used
     */
    private calculateStatus(percentUsed: number): BudgetStatus {
        if (percentUsed >= 100) {
            return 'exhausted';
        } else if (percentUsed >= this.config.criticalThreshold) {
            return 'critical';
        } else if (percentUsed >= this.config.warningThreshold) {
            return 'warning';
        }
        return 'healthy';
    }

    /**
     * Calculate recommended action based on status and remaining tokens
     */
    private calculateRecommendedAction(status: BudgetStatus, remaining: number): RecommendedAction {
        switch (status) {
            case 'exhausted':
                return 'stop';
            case 'critical':
                return 'checkpoint';
            case 'warning':
                // If very close to critical, suggest checkpoint
                if (remaining < this.config.wrapUpReserve * 2) {
                    return 'checkpoint';
                }
                return 'wrap-up';
            default:
                return 'continue';
        }
    }

    /**
     * Check budget status and fire alerts if needed
     */
    private checkBudgetStatus(): void {
        const budget = this.getBudget();
        const currentStatus = budget.status;
        
        // Only fire alerts on status changes (to avoid spamming)
        if (currentStatus !== this.lastStatus) {
            this.events.fireStatusChange(budget);
            
            const alert = this.createAlert(currentStatus, budget);
            
            switch (currentStatus) {
                case 'warning':
                    this.events.fireWarning(alert);
                    if (this.config.emitNotifications) {
                        vscode.window.showWarningMessage(
                            `Context budget at ${budget.percentUsed}% - consider wrapping up soon`
                        );
                    }
                    break;
                    
                case 'critical':
                    this.events.fireCritical(alert);
                    if (this.config.emitNotifications) {
                        vscode.window.showWarningMessage(
                            `Context budget CRITICAL at ${budget.percentUsed}% - save checkpoint now`
                        );
                    }
                    break;
                    
                case 'exhausted':
                    this.events.fireExhausted(alert);
                    if (this.config.emitNotifications) {
                        vscode.window.showErrorMessage(
                            `Context budget EXHAUSTED - must stop and transition to next phase`
                        );
                    }
                    break;
            }
            
            this.lastStatus = currentStatus;
        }
    }

    /**
     * Create a budget alert object
     */
    private createAlert(level: BudgetStatus, budget: ContextBudget): BudgetAlert {
        let message: string;
        let suggestions: string[];
        
        switch (level) {
            case 'warning':
                message = `Token budget is at ${budget.percentUsed}%. Consider completing current task and creating a checkpoint.`;
                suggestions = [
                    'Complete the current task',
                    'Avoid starting new large operations',
                    'Consider creating a checkpoint'
                ];
                break;
                
            case 'critical':
                message = `Token budget is CRITICAL at ${budget.percentUsed}%. Stop new work and save progress immediately.`;
                suggestions = [
                    'Stop starting new tasks',
                    'Save current progress',
                    'Create a checkpoint now',
                    'Prepare to transition to next phase'
                ];
                break;
                
            case 'exhausted':
                message = `Token budget is EXHAUSTED. Must stop and transition to next phase.`;
                suggestions = [
                    'Stop all operations',
                    'Save state immediately',
                    'Transition to next phase',
                    'Report partial completion'
                ];
                break;
                
            default:
                message = `Token budget is healthy at ${budget.percentUsed}%.`;
                suggestions = ['Continue normal operation'];
        }
        
        return {
            level,
            message,
            budget,
            timestamp: Date.now(),
            suggestions
        };
    }
}

/**
 * Factory function for creating a ContextMonitor
 */
export function createContextMonitor(config?: Partial<ContextMonitorConfig>): ContextMonitor {
    return new ContextMonitor(config);
}
