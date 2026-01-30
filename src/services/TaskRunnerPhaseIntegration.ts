/**
 * TaskRunnerPhaseIntegration - Bridge between TaskRunner and PhaseExecutor
 * 
 * This module provides integration hooks to enable phased execution
 * in the existing TaskRunner without major modifications.
 * 
 * Phase 5 of 5 - Integration
 */

import * as vscode from 'vscode';
import { PhaseExecutor, createPhaseExecutor, PhaseApprovalRequest } from './PhaseExecutor';
import { ComplexityScore } from './ComplexityAnalyzer';
import { PhaseGenerationResult, Phase } from './PhaseGenerator';
import { ContextBudget } from './ContextMonitor';
import { PhaseResult } from './PhaseStateManager';

/**
 * Phase execution info sent to webview
 */
export interface PhaseExecutionInfo {
    enabled: boolean;
    mode: 'single' | 'phased';
    currentPhaseIndex: number;
    totalPhases: number;
    phases: {
        id: string;
        name: string;
        description: string;
        status: string;
        tokenUsage?: number;
        estimatedTokens: number;
    }[];
    budget: {
        used: number;
        total: number;
        percentUsed: number;
        status: string;
    };
    totalTokensUsed: number;
    totalTokensEstimated: number;
}

/**
 * Configuration for phase integration
 */
export interface PhaseIntegrationConfig {
    /** Enable phased execution (default: true) */
    enabled: boolean;

    /** Token budget per phase (default: 30000) */
    tokenBudgetPerPhase: number;

    /** Complexity score threshold to trigger phased execution (default: 40) */
    phasedExecutionThreshold: number;

    /** Whether to auto-analyze requirements (default: true) */
    autoAnalyze: boolean;

    /** Whether to require approval between phases (default: true) */
    requireApprovalBetweenPhases: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: PhaseIntegrationConfig = {
    enabled: true,
    tokenBudgetPerPhase: 30000,
    phasedExecutionThreshold: 40,
    autoAnalyze: true,
    requireApprovalBetweenPhases: true
};

/**
 * TaskRunnerPhaseIntegration - Main integration class
 * 
 * Usage in TaskRunner:
 * 1. Create instance: this.phaseIntegration = new TaskRunnerPhaseIntegration(config)
 * 2. Before task execution: await this.phaseIntegration.analyzeAndPrepare(taskId, prompt, missionFolder)
 * 3. Get prompt context: this.phaseIntegration.getPromptContext(taskId)
 * 4. Track tokens: this.phaseIntegration.trackTokens(taskId, tokens, source)
 * 5. Check boundaries: this.phaseIntegration.shouldEndPhase(taskId)
 * 6. Complete phase: await this.phaseIntegration.completeCurrentPhase(taskId, summary, files)
 */
export class TaskRunnerPhaseIntegration {
    private config: PhaseIntegrationConfig;
    private executors: Map<string, PhaseExecutor> = new Map();

    // Events for webview communication
    private _onPhaseUpdate = new vscode.EventEmitter<{ taskId: string; info: PhaseExecutionInfo }>();
    readonly onPhaseUpdate = this._onPhaseUpdate.event;

    private _onApprovalNeeded = new vscode.EventEmitter<{ taskId: string; request: PhaseApprovalRequest }>();
    readonly onApprovalNeeded = this._onApprovalNeeded.event;

    private _onPhaseComplete = new vscode.EventEmitter<{ taskId: string; phaseId: string; result: PhaseResult }>();
    readonly onPhaseComplete = this._onPhaseComplete.event;

    private _onAllPhasesComplete = new vscode.EventEmitter<{ taskId: string; totalTokens: number }>();
    readonly onAllPhasesComplete = this._onAllPhasesComplete.event;

    constructor(config: Partial<PhaseIntegrationConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Analyze requirement and prepare for execution
     * 
     * Call this BEFORE starting task execution
     * 
     * @returns Analysis result with recommended mode
     */
    async analyzeAndPrepare(
        taskId: string,
        requirement: string,
        missionFolder: string
    ): Promise<{
        mode: 'single' | 'phased';
        score: ComplexityScore;
        phases?: PhaseGenerationResult;
        promptContext: string;
    }> {
        if (!this.config.enabled) {
            return {
                mode: 'single',
                score: {
                    level: 'LOW',
                    score: 0,
                    estimatedTokens: 10000,
                    metrics: {
                        featureCount: 0,
                        estimatedFileCount: 1,
                        scopeIndicators: [],
                        riskFactors: [],
                        textLength: requirement.length,
                        technicalDomains: []
                    },
                    recommendation: 'PROCEED',
                    explanation: 'Phase execution disabled'
                },
                promptContext: ''
            };
        }

        // Create executor for this task
        const executor = createPhaseExecutor({
            tokenBudgetPerPhase: this.config.tokenBudgetPerPhase,
            phasedExecutionThreshold: this.config.phasedExecutionThreshold,
            requireApprovalBetweenPhases: this.config.requireApprovalBetweenPhases,
            autoApprove: !this.config.requireApprovalBetweenPhases
        });

        executor.initialize(missionFolder, taskId);
        this.executors.set(taskId, executor);

        // Set up event forwarding
        this.setupEventForwarding(taskId, executor);

        // Analyze requirement
        const analysis = await executor.analyzeRequirement(requirement);

        // Start execution based on mode
        if (analysis.recommendedMode === 'phased' && analysis.phases) {
            executor.startPhasedExecution(taskId, requirement, analysis.phases);
        } else {
            executor.startSingleExecution(taskId, requirement, analysis.score.estimatedTokens);
        }

        // Begin first phase
        executor.beginPhaseExecution();

        // Get prompt context
        const promptContext = executor.getPhasePromptContext();

        // Fire initial update
        this._onPhaseUpdate.fire({
            taskId,
            info: this.getPhaseInfo(taskId)!
        });

        return {
            mode: analysis.recommendedMode === 'phased' ? 'phased' : 'single',
            score: analysis.score,
            phases: analysis.phases,
            promptContext
        };
    }

    /**
     * Set up event forwarding from executor to integration events
     */
    private setupEventForwarding(taskId: string, executor: PhaseExecutor): void {
        executor.events.onApprovalNeeded((request) => {
            this._onApprovalNeeded.fire({ taskId, request });
        });

        executor.events.onPhaseCompleted(({ phase, result }) => {
            this._onPhaseComplete.fire({ taskId, phaseId: phase.id, result });
            this._onPhaseUpdate.fire({
                taskId,
                info: this.getPhaseInfo(taskId)!
            });
        });

        executor.events.onAllPhasesComplete(({ totalTokens }) => {
            this._onAllPhasesComplete.fire({ taskId, totalTokens });
        });

        executor.events.onBudgetUpdate(() => {
            this._onPhaseUpdate.fire({
                taskId,
                info: this.getPhaseInfo(taskId)!
            });
        });
    }

    /**
     * Get the prompt context to inject into AI system prompt
     */
    getPromptContext(taskId: string): string {
        const executor = this.executors.get(taskId);
        if (!executor) { return ''; }
        return executor.getPhasePromptContext();
    }

    /**
     * Track token usage during execution
     */
    trackTokens(taskId: string, tokens: number, source: string): void {
        const executor = this.executors.get(taskId);
        if (!executor) { return; }
        executor.trackTokens(tokens, source);
    }

    /**
     * Track text content (auto-estimates tokens)
     */
    trackText(taskId: string, text: string, source: string): void {
        const executor = this.executors.get(taskId);
        if (!executor) { return; }
        const monitor = executor.getContextMonitor();
        const tokens = monitor.estimateTokens(text);
        executor.trackTokens(tokens, source);
    }

    /**
     * Check if current phase should end (budget critical)
     */
    shouldEndPhase(taskId: string): boolean {
        const executor = this.executors.get(taskId);
        if (!executor) { return false; }
        return executor.shouldTriggerPhaseBoundary();
    }

    /**
     * Get current budget status
     */
    getBudget(taskId: string): ContextBudget | null {
        const executor = this.executors.get(taskId);
        if (!executor) { return null; }
        return executor.getBudget();
    }

    /**
     * Get current phase info for webview
     */
    getPhaseInfo(taskId: string): PhaseExecutionInfo | null {
        const executor = this.executors.get(taskId);
        if (!executor) { return null; }

        const state = executor.getState();
        if (!state) { return null; }

        const budget = executor.getBudget();
        const progress = executor.getProgressSummary();

        return {
            enabled: this.config.enabled,
            mode: state.executionMode,
            currentPhaseIndex: state.currentPhaseIndex,
            totalPhases: state.phases.length,
            phases: state.phases.map((phase, _index) => {
                const result = state.phaseResults.find(r => r.phaseId === phase.id);
                return {
                    id: phase.id,
                    name: phase.name,
                    description: phase.description,
                    status: result?.status ?? phase.status,
                    tokenUsage: result?.tokenUsage,
                    estimatedTokens: phase.estimatedTokens
                };
            }),
            budget: {
                used: budget.used,
                total: budget.totalBudget,
                percentUsed: budget.percentUsed,
                status: budget.status
            },
            totalTokensUsed: progress.tokensUsed,
            totalTokensEstimated: progress.tokensEstimated
        };
    }

    /**
     * Complete the current phase
     * 
     * @returns Whether to continue to next phase
     */
    async completeCurrentPhase(
        taskId: string,
        summary: string,
        filesCreated: string[],
        filesModified: string[],
        verificationResults: string[] = ['Code compiles: PASS']
    ): Promise<{ continueToNext: boolean; isComplete: boolean }> {
        const executor = this.executors.get(taskId);
        if (!executor) {
            return { continueToNext: false, isComplete: true };
        }

        const response = await executor.completePhase(
            summary,
            filesCreated,
            filesModified,
            verificationResults
        );

        const state = executor.getState();
        const isComplete = state ? state.currentPhaseIndex >= state.phases.length : true;

        if (!isComplete && response.continueToNext) {
            // Prepare for next phase
            executor.beginPhaseExecution();
        }

        return {
            continueToNext: response.continueToNext && !response.abortMission,
            isComplete
        };
    }

    /**
     * Provide approval response (from webview)
     */
    provideApproval(
        taskId: string,
        approved: boolean,
        feedback?: string
    ): void {
        const executor = this.executors.get(taskId);
        if (!executor) { return; }

        executor.provideApproval({
            status: approved ? 'approved' : 'rejected',
            feedback,
            continueToNext: approved,
            abortMission: !approved
        });
    }

    /**
     * Skip current phase
     */
    skipPhase(taskId: string, reason: string): void {
        const executor = this.executors.get(taskId);
        if (!executor) { return; }
        executor.skipCurrentPhase(reason);
    }

    /**
     * Abort mission
     */
    abortMission(taskId: string, reason: string): void {
        const executor = this.executors.get(taskId);
        if (!executor) { return; }
        executor.abortMission(reason);
    }

    /**
     * Check if task has phased execution
     */
    hasPhaseExecution(taskId: string): boolean {
        return this.executors.has(taskId);
    }

    /**
     * Check if task is in phased mode (vs single)
     */
    isPhasedMode(taskId: string): boolean {
        const executor = this.executors.get(taskId);
        if (!executor) { return false; }
        const state = executor.getState();
        return state?.executionMode === 'phased';
    }

    /**
     * Get current phase for a task
     */
    getCurrentPhase(taskId: string): Phase | null {
        const executor = this.executors.get(taskId);
        if (!executor) { return null; }
        return executor.getCurrentPhase();
    }

    /**
     * Check if there's a pending approval
     */
    hasPendingApproval(taskId: string): boolean {
        const executor = this.executors.get(taskId);
        if (!executor) { return false; }
        return executor.hasPendingApproval();
    }

    /**
     * Generate progress report
     */
    generateReport(taskId: string): string {
        const executor = this.executors.get(taskId);
        if (!executor) { return 'No phase execution data available.'; }
        return executor.generateProgressReport();
    }

    /**
     * Clean up executor for a task
     */
    cleanup(taskId: string): void {
        const executor = this.executors.get(taskId);
        if (executor) {
            executor.dispose();
            this.executors.delete(taskId);
        }
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<PhaseIntegrationConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get configuration
     */
    getConfig(): PhaseIntegrationConfig {
        return { ...this.config };
    }

    /**
     * Dispose all executors
     */
    dispose(): void {
        this.executors.forEach(executor => executor.dispose());
        this.executors.clear();
        this._onPhaseUpdate.dispose();
        this._onApprovalNeeded.dispose();
        this._onPhaseComplete.dispose();
        this._onAllPhasesComplete.dispose();
    }
}

/**
 * Factory function
 */
export function createTaskRunnerPhaseIntegration(
    config?: Partial<PhaseIntegrationConfig>
): TaskRunnerPhaseIntegration {
    return new TaskRunnerPhaseIntegration(config);
}
