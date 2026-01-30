/**
 * PhaseExecutor - Orchestrates phased execution of complex requirements
 * 
 * This service is part of the Phased Execution Guard-Rails system that prevents
 * context exhaustion when users submit large, monolithic requirements.
 * 
 * Phase 4 of 5 - Phase Execution (Orchestration)
 */

import * as vscode from 'vscode';
import { ComplexityAnalyzer, ComplexityScore, createComplexityAnalyzer } from './ComplexityAnalyzer';
import { PhaseGenerator, Phase, PhaseGenerationResult, createPhaseGenerator } from './PhaseGenerator';
import { ContextMonitor, ContextBudget, createContextMonitor } from './ContextMonitor';
import { PhaseStateManager, PhaseExecutionState, PhaseResult, createPhaseStateManager } from './PhaseStateManager';

/**
 * Execution mode for the phase executor
 */
export type ExecutionMode = 'auto' | 'single' | 'phased';

/**
 * Phase approval status
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'modified';

/**
 * Request for phase approval
 */
export interface PhaseApprovalRequest {
    /** Phase being approved */
    phase: Phase;
    
    /** Index of the phase */
    phaseIndex: number;
    
    /** Total phases */
    totalPhases: number;
    
    /** Result from executing the phase */
    executionSummary: string;
    
    /** Files created */
    filesCreated: string[];
    
    /** Files modified */
    filesModified: string[];
    
    /** Verification results */
    verificationResults: string[];
    
    /** Token usage in this phase */
    tokenUsage: number;
    
    /** Timestamp */
    timestamp: number;
}

/**
 * Response to a phase approval request
 */
export interface PhaseApprovalResponse {
    /** Approval status */
    status: ApprovalStatus;
    
    /** User feedback (if any) */
    feedback?: string;
    
    /** Whether to continue to next phase */
    continueToNext: boolean;
    
    /** Whether to abort the entire mission */
    abortMission: boolean;
}

/**
 * Events emitted by the PhaseExecutor
 */
export interface PhaseExecutorEvents {
    /** Fired when analysis determines execution mode */
    onModeDecided: vscode.Event<{ mode: ExecutionMode; reason: string; phases?: number }>;
    
    /** Fired when a phase starts */
    onPhaseStarted: vscode.Event<{ phase: Phase; index: number; total: number }>;
    
    /** Fired when a phase completes */
    onPhaseCompleted: vscode.Event<{ phase: Phase; result: PhaseResult }>;
    
    /** Fired when approval is needed */
    onApprovalNeeded: vscode.Event<PhaseApprovalRequest>;
    
    /** Fired when context budget changes */
    onBudgetUpdate: vscode.Event<ContextBudget>;
    
    /** Fired when all phases complete */
    onAllPhasesComplete: vscode.Event<{ results: PhaseResult[]; totalTokens: number }>;
    
    /** Fired on execution error */
    onError: vscode.Event<{ phase?: Phase; error: Error }>;
}

/**
 * Configuration for PhaseExecutor
 */
export interface PhaseExecutorConfig {
    /** Token budget per phase (default: 30000) */
    tokenBudgetPerPhase: number;
    
    /** Whether to auto-approve phases (default: false) */
    autoApprove: boolean;
    
    /** Complexity threshold to trigger phased execution (default: 40 = HIGH) */
    phasedExecutionThreshold: number;
    
    /** Whether to require approval between phases (default: true) */
    requireApprovalBetweenPhases: boolean;
    
    /** Maximum retries for a failed phase (default: 1) */
    maxPhaseRetries: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: PhaseExecutorConfig = {
    tokenBudgetPerPhase: 30000,
    autoApprove: false,
    phasedExecutionThreshold: 40,
    requireApprovalBetweenPhases: true,
    maxPhaseRetries: 1
};

/**
 * PhaseExecutor - Main orchestration service
 */
export class PhaseExecutor {
    private config: PhaseExecutorConfig;
    private complexityAnalyzer: ComplexityAnalyzer;
    private phaseGenerator: PhaseGenerator;
    private contextMonitor: ContextMonitor;
    private stateManager: PhaseStateManager | null = null;
    
    // Event emitters
    private _onModeDecided = new vscode.EventEmitter<{ mode: ExecutionMode; reason: string; phases?: number }>();
    private _onPhaseStarted = new vscode.EventEmitter<{ phase: Phase; index: number; total: number }>();
    private _onPhaseCompleted = new vscode.EventEmitter<{ phase: Phase; result: PhaseResult }>();
    private _onApprovalNeeded = new vscode.EventEmitter<PhaseApprovalRequest>();
    private _onBudgetUpdate = new vscode.EventEmitter<ContextBudget>();
    private _onAllPhasesComplete = new vscode.EventEmitter<{ results: PhaseResult[]; totalTokens: number }>();
    private _onError = new vscode.EventEmitter<{ phase?: Phase; error: Error }>();
    
    // Approval handling
    private pendingApproval: {
        request: PhaseApprovalRequest;
        resolve: (response: PhaseApprovalResponse) => void;
    } | null = null;

    /** Events */
    readonly events: PhaseExecutorEvents = {
        onModeDecided: this._onModeDecided.event,
        onPhaseStarted: this._onPhaseStarted.event,
        onPhaseCompleted: this._onPhaseCompleted.event,
        onApprovalNeeded: this._onApprovalNeeded.event,
        onBudgetUpdate: this._onBudgetUpdate.event,
        onAllPhasesComplete: this._onAllPhasesComplete.event,
        onError: this._onError.event
    };

    constructor(config: Partial<PhaseExecutorConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.complexityAnalyzer = createComplexityAnalyzer();
        this.phaseGenerator = createPhaseGenerator(this.complexityAnalyzer);
        this.contextMonitor = createContextMonitor({
            totalBudget: this.config.tokenBudgetPerPhase
        });
        
        // Listen to context monitor events
        this.contextMonitor.events.onStatusChange((budget) => {
            this._onBudgetUpdate.fire(budget);
        });
    }

    /**
     * Initialize for a mission
     * 
     * @param missionFolder - Folder to store state
     * @param taskId - Task identifier
     */
    initialize(missionFolder: string, taskId: string): void {
        this.stateManager = createPhaseStateManager(missionFolder);
        
        // Try to load existing state
        const existingState = this.stateManager.load();
        if (existingState && existingState.taskId === taskId) {
            console.log(`[PhaseExecutor] Resuming execution for task ${taskId}`);
        }
    }

    /**
     * Analyze a requirement and determine execution mode
     * 
     * @param requirement - The user's requirement
     * @returns Analysis result with recommended mode
     */
    async analyzeRequirement(requirement: string): Promise<{
        score: ComplexityScore;
        recommendedMode: ExecutionMode;
        phases?: PhaseGenerationResult;
    }> {
        // Analyze complexity
        const score = await this.complexityAnalyzer.analyze(requirement);
        
        // Determine mode based on score and config
        let recommendedMode: ExecutionMode;
        let reason: string;
        let phases: PhaseGenerationResult | undefined;
        
        if (score.score >= this.config.phasedExecutionThreshold || 
            score.recommendation === 'SPLIT_PHASES') {
            recommendedMode = 'phased';
            reason = `Complexity score ${score.score} exceeds threshold ${this.config.phasedExecutionThreshold}`;
            
            // Generate phases
            phases = await this.phaseGenerator.generatePhases(requirement, score);
        } else if (score.recommendation === 'REQUIRE_CLARIFICATION') {
            recommendedMode = 'phased';
            reason = 'Requirement is too broad and needs clarification or phasing';
            phases = await this.phaseGenerator.generatePhases(requirement, score);
        } else {
            recommendedMode = 'single';
            reason = `Complexity score ${score.score} is within single-execution threshold`;
        }
        
        // Fire event
        this._onModeDecided.fire({
            mode: recommendedMode,
            reason,
            phases: phases?.totalPhases
        });
        
        return { score, recommendedMode, phases };
    }

    /**
     * Start phased execution
     * 
     * @param taskId - Task identifier
     * @param requirement - Original requirement
     * @param phases - Generated phases
     */
    startPhasedExecution(
        taskId: string,
        requirement: string,
        phases: PhaseGenerationResult
    ): PhaseExecutionState {
        if (!this.stateManager) {
            throw new Error('PhaseExecutor not initialized. Call initialize() first.');
        }
        
        const state = this.stateManager.initializeFromGeneration(taskId, requirement, phases);
        
        // Reset context monitor for first phase
        const firstPhase = phases.phases[0];
        this.contextMonitor.reset(firstPhase.estimatedTokens, firstPhase.id);
        
        return state;
    }

    /**
     * Start single-phase execution
     * 
     * @param taskId - Task identifier
     * @param requirement - Original requirement
     * @param estimatedTokens - Estimated tokens
     */
    startSingleExecution(
        taskId: string,
        requirement: string,
        estimatedTokens: number
    ): PhaseExecutionState {
        if (!this.stateManager) {
            throw new Error('PhaseExecutor not initialized. Call initialize() first.');
        }
        
        const state = this.stateManager.initializeSinglePhase(taskId, requirement, estimatedTokens);
        
        // Reset context monitor
        this.contextMonitor.reset(estimatedTokens, 'phase-1');
        
        return state;
    }

    /**
     * Get current execution state
     */
    getState(): PhaseExecutionState | null {
        return this.stateManager?.getState() ?? null;
    }

    /**
     * Get current phase
     */
    getCurrentPhase(): Phase | null {
        return this.stateManager?.getCurrentPhase() ?? null;
    }

    /**
     * Get the context monitor instance
     */
    getContextMonitor(): ContextMonitor {
        return this.contextMonitor;
    }

    /**
     * Signal that the current phase is starting execution
     */
    beginPhaseExecution(): void {
        const phase = this.getCurrentPhase();
        if (!phase || !this.stateManager) {return;}
        
        this.stateManager.markPhaseStarted();
        
        const state = this.stateManager.getState()!;
        this._onPhaseStarted.fire({
            phase,
            index: state.currentPhaseIndex,
            total: state.phases.length
        });
        
        // Reset context monitor for this phase
        this.contextMonitor.reset(phase.estimatedTokens, phase.id);
    }

    /**
     * Track token usage during phase execution
     */
    trackTokens(tokens: number, source: string): void {
        this.contextMonitor.trackUsage({
            type: 'prompt',
            tokens,
            timestamp: Date.now(),
            source
        });
        
        this.stateManager?.updateTokenUsage(tokens);
    }

    /**
     * Check if phase boundary should be triggered
     */
    shouldTriggerPhaseBoundary(): boolean {
        return this.contextMonitor.shouldTriggerPhaseBoundary();
    }

    /**
     * Get current budget status
     */
    getBudget(): ContextBudget {
        return this.contextMonitor.getBudget();
    }

    /**
     * Complete the current phase and request approval
     * 
     * @param summary - Summary of what was accomplished
     * @param filesCreated - Files created in this phase
     * @param filesModified - Files modified in this phase
     * @param verificationResults - Results of verification
     */
    async completePhase(
        summary: string,
        filesCreated: string[],
        filesModified: string[],
        verificationResults: string[]
    ): Promise<PhaseApprovalResponse> {
        const phase = this.getCurrentPhase();
        const state = this.stateManager?.getState();
        
        if (!phase || !state) {
            throw new Error('No active phase to complete');
        }
        
        const budget = this.contextMonitor.getBudget();
        
        // Create approval request
        const request: PhaseApprovalRequest = {
            phase,
            phaseIndex: state.currentPhaseIndex,
            totalPhases: state.phases.length,
            executionSummary: summary,
            filesCreated,
            filesModified,
            verificationResults,
            tokenUsage: budget.used,
            timestamp: Date.now()
        };
        
        // If auto-approve or not requiring approval, approve automatically
        if (this.config.autoApprove || !this.config.requireApprovalBetweenPhases) {
            return this.processApproval(request, {
                status: 'approved',
                continueToNext: true,
                abortMission: false
            });
        }
        
        // Request approval from user
        return this.requestApproval(request);
    }

    /**
     * Request approval for a phase (async, waits for user response)
     */
    private requestApproval(request: PhaseApprovalRequest): Promise<PhaseApprovalResponse> {
        return new Promise((resolve) => {
            this.pendingApproval = { request, resolve };
            this._onApprovalNeeded.fire(request);
        });
    }

    /**
     * Provide approval response (called by UI)
     */
    provideApproval(response: PhaseApprovalResponse): void {
        if (!this.pendingApproval) {
            console.warn('[PhaseExecutor] No pending approval to respond to');
            return;
        }
        
        const { request, resolve } = this.pendingApproval;
        this.pendingApproval = null;
        
        this.processApproval(request, response).then(resolve);
    }

    /**
     * Process an approval response
     */
    private async processApproval(
        request: PhaseApprovalRequest,
        response: PhaseApprovalResponse
    ): Promise<PhaseApprovalResponse> {
        if (!this.stateManager) {
            throw new Error('PhaseExecutor not initialized');
        }
        
        const verificationPassed = request.verificationResults.every(
            r => !r.toLowerCase().includes('fail')
        );
        
        // Record phase result
        const result = this.stateManager.markPhaseComplete({
            status: response.abortMission ? 'failed' : 
                    response.status === 'approved' ? 'completed' : 'partial',
            filesCreated: request.filesCreated,
            filesModified: request.filesModified,
            verificationPassed,
            userApproved: response.status === 'approved',
            tokenUsage: request.tokenUsage,
            summary: request.executionSummary,
            errorMessage: response.abortMission ? 'Mission aborted by user' : undefined
        });
        
        if (result) {
            this._onPhaseCompleted.fire({ phase: request.phase, result });
        }
        
        // Check if all phases complete
        if (this.stateManager.isComplete()) {
            const state = this.stateManager.getState()!;
            this._onAllPhasesComplete.fire({
                results: state.phaseResults,
                totalTokens: state.actualTokensUsed
            });
        } else if (response.continueToNext && !response.abortMission) {
            // Prepare for next phase
            const nextPhase = this.getCurrentPhase();
            if (nextPhase) {
                this.contextMonitor.reset(nextPhase.estimatedTokens, nextPhase.id);
            }
        }
        
        return response;
    }

    /**
     * Abort the current mission
     */
    abortMission(reason: string): void {
        if (this.pendingApproval) {
            this.pendingApproval.resolve({
                status: 'rejected',
                feedback: reason,
                continueToNext: false,
                abortMission: true
            });
            this.pendingApproval = null;
        }
        
        this.stateManager?.pauseExecution();
    }

    /**
     * Skip the current phase
     */
    skipCurrentPhase(reason: string): PhaseResult | null {
        const result = this.stateManager?.skipCurrentPhase(reason) ?? null;
        
        if (result) {
            const phase = this.stateManager?.getState()?.phases.find(p => p.id === result.phaseId);
            if (phase) {
                this._onPhaseCompleted.fire({ phase, result });
            }
            
            // Prepare for next phase
            const nextPhase = this.getCurrentPhase();
            if (nextPhase) {
                this.contextMonitor.reset(nextPhase.estimatedTokens, nextPhase.id);
            }
        }
        
        return result;
    }

    /**
     * Get progress summary
     */
    getProgressSummary(): ReturnType<PhaseStateManager['getProgressSummary']> {
        return this.stateManager?.getProgressSummary() ?? {
            currentPhase: 0,
            totalPhases: 0,
            completedPhases: 0,
            failedPhases: 0,
            percentComplete: 0,
            tokensUsed: 0,
            tokensEstimated: 0,
            status: 'not-started'
        };
    }

    /**
     * Generate a progress report
     */
    generateProgressReport(): string {
        return this.stateManager?.generateProgressReport() ?? 'No execution state available.';
    }

    /**
     * Get the prompt context for the current phase
     * This should be injected into the AI prompt
     */
    getPhasePromptContext(): string {
        const phase = this.getCurrentPhase();
        const state = this.stateManager?.getState();
        
        if (!phase || !state) {
            return '';
        }
        
        const previousResults = state.phaseResults;
        const budget = this.contextMonitor.getBudget();
        
        const lines: string[] = [
            `## PHASE EXECUTION CONTEXT`,
            ``,
            `You are executing **Phase ${state.currentPhaseIndex + 1} of ${state.phases.length}**: ${phase.name}`,
            ``,
            `### Phase Objective`,
            phase.description,
            ``,
            `### Requirements for This Phase`,
            ...phase.requirements.map(r => `- ${r}`),
            ``,
            `### Expected Deliverables`,
            ...phase.deliverables.map(d => `- ${d}`),
            ``,
            `### Verification Criteria`,
            ...phase.verificationCriteria.map(v => `- ${v}`),
            ``
        ];
        
        if (previousResults.length > 0) {
            lines.push(`### Previous Phase Results`);
            previousResults.forEach(result => {
                lines.push(`- **${result.phaseId}**: ${result.status}`);
                if (result.summary) {
                    lines.push(`  - ${result.summary}`);
                }
            });
            lines.push(``);
        }
        
        lines.push(`### Token Budget`);
        lines.push(`- **Used:** ${budget.used.toLocaleString()} / ${budget.totalBudget.toLocaleString()} (${budget.percentUsed}%)`);
        lines.push(`- **Status:** ${budget.status}`);
        lines.push(`- **Action:** ${budget.recommendedAction}`);
        lines.push(``);
        lines.push(`### IMPORTANT CONSTRAINTS`);
        lines.push(`- Focus ONLY on this phase's requirements`);
        lines.push(`- Do NOT implement features from future phases`);
        lines.push(`- Complete deliverables before finishing`);
        lines.push(`- If budget is critical, wrap up and note remaining work`);
        
        return lines.join('\n');
    }

    /**
     * Check if there's a pending approval
     */
    hasPendingApproval(): boolean {
        return this.pendingApproval !== null;
    }

    /**
     * Get pending approval request
     */
    getPendingApproval(): PhaseApprovalRequest | null {
        return this.pendingApproval?.request ?? null;
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<PhaseExecutorConfig>): void {
        this.config = { ...this.config, ...config };
        
        if (config.tokenBudgetPerPhase) {
            this.contextMonitor.updateConfig({ totalBudget: config.tokenBudgetPerPhase });
        }
    }

    /**
     * Get configuration
     */
    getConfig(): PhaseExecutorConfig {
        return { ...this.config };
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this._onModeDecided.dispose();
        this._onPhaseStarted.dispose();
        this._onPhaseCompleted.dispose();
        this._onApprovalNeeded.dispose();
        this._onBudgetUpdate.dispose();
        this._onAllPhasesComplete.dispose();
        this._onError.dispose();
        this.contextMonitor.dispose();
    }
}

/**
 * Factory function for creating a PhaseExecutor
 */
export function createPhaseExecutor(config?: Partial<PhaseExecutorConfig>): PhaseExecutor {
    return new PhaseExecutor(config);
}
