/**
 * PhaseStateManager - Persists phase execution state to disk
 * 
 * This service is part of the Phased Execution Guard-Rails system that prevents
 * context exhaustion when users submit large, monolithic requirements.
 * 
 * Phase 4 of 5 - Phase Execution (State Persistence)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Phase, PhaseGenerationResult } from './PhaseGenerator';

/**
 * Result of a completed phase
 */
export interface PhaseResult {
    /** Phase ID */
    phaseId: string;
    
    /** Completion status */
    status: 'completed' | 'failed' | 'partial' | 'skipped';
    
    /** Files created during this phase */
    filesCreated: string[];
    
    /** Files modified during this phase */
    filesModified: string[];
    
    /** Whether verification passed */
    verificationPassed: boolean;
    
    /** Whether user approved the phase */
    userApproved: boolean;
    
    /** Tokens used in this phase */
    tokenUsage: number;
    
    /** Timestamp when phase completed */
    completedAt: number;
    
    /** Error message if failed */
    errorMessage?: string;
    
    /** Summary of what was accomplished */
    summary?: string;
}

/**
 * Complete execution state for a phased mission
 */
export interface PhaseExecutionState {
    /** Mission/Task ID */
    taskId: string;
    
    /** Original requirement */
    originalRequirement: string;
    
    /** Generated phases */
    phases: Phase[];
    
    /** Current phase index (0-based) */
    currentPhaseIndex: number;
    
    /** Results of completed phases */
    phaseResults: PhaseResult[];
    
    /** Execution mode */
    executionMode: 'single' | 'phased';
    
    /** Strategy used for splitting */
    strategyUsed: string;
    
    /** Total estimated tokens */
    estimatedTotalTokens: number;
    
    /** Actual tokens used so far */
    actualTokensUsed: number;
    
    /** Timestamp when execution started */
    startedAt: number;
    
    /** Timestamp of last update */
    lastUpdatedAt: number;
    
    /** Overall status */
    overallStatus: 'in-progress' | 'completed' | 'failed' | 'paused';
}

/**
 * Configuration for PhaseStateManager
 */
export interface PhaseStateManagerConfig {
    /** Whether to auto-save on every update (default: true) */
    autoSave: boolean;
    
    /** Filename for state file (default: 'phase-state.json') */
    stateFileName: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: PhaseStateManagerConfig = {
    autoSave: true,
    stateFileName: 'phase-state.json'
};

/**
 * PhaseStateManager - Manages persistence of phase execution state
 */
export class PhaseStateManager {
    private missionFolder: string;
    private config: PhaseStateManagerConfig;
    private state: PhaseExecutionState | null = null;

    constructor(missionFolder: string, config: Partial<PhaseStateManagerConfig> = {}) {
        this.missionFolder = missionFolder;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Get the state file path
     */
    private getStateFilePath(): string {
        return path.join(this.missionFolder, this.config.stateFileName);
    }

    /**
     * Initialize state from a PhaseGenerationResult
     */
    initializeFromGeneration(
        taskId: string,
        requirement: string,
        generationResult: PhaseGenerationResult
    ): PhaseExecutionState {
        this.state = {
            taskId,
            originalRequirement: requirement,
            phases: generationResult.phases,
            currentPhaseIndex: 0,
            phaseResults: [],
            executionMode: generationResult.totalPhases > 1 ? 'phased' : 'single',
            strategyUsed: generationResult.strategyUsed,
            estimatedTotalTokens: generationResult.estimatedTotalTokens,
            actualTokensUsed: 0,
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
            overallStatus: 'in-progress'
        };

        if (this.config.autoSave) {
            this.save();
        }

        return this.state;
    }

    /**
     * Initialize state for single-phase execution (no splitting)
     */
    initializeSinglePhase(
        taskId: string,
        requirement: string,
        estimatedTokens: number
    ): PhaseExecutionState {
        const singlePhase: Phase = {
            id: 'phase-1',
            name: 'Implementation',
            description: 'Complete implementation of the requirement',
            requirements: [requirement],
            deliverables: ['Working implementation'],
            verificationCriteria: ['Code compiles', 'Basic functionality works'],
            estimatedTokens,
            dependencies: [],
            status: 'pending',
            order: 0,
            domains: [],
            riskFactors: []
        };

        this.state = {
            taskId,
            originalRequirement: requirement,
            phases: [singlePhase],
            currentPhaseIndex: 0,
            phaseResults: [],
            executionMode: 'single',
            strategyUsed: 'none',
            estimatedTotalTokens: estimatedTokens,
            actualTokensUsed: 0,
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
            overallStatus: 'in-progress'
        };

        if (this.config.autoSave) {
            this.save();
        }

        return this.state;
    }

    /**
     * Load state from disk
     */
    load(): PhaseExecutionState | null {
        const filePath = this.getStateFilePath();

        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            this.state = JSON.parse(content) as PhaseExecutionState;
            return this.state;
        } catch (error) {
            console.error(`[PhaseStateManager] Failed to load state:`, error);
            return null;
        }
    }

    /**
     * Save current state to disk
     */
    save(): boolean {
        if (!this.state) {
            console.warn('[PhaseStateManager] No state to save');
            return false;
        }

        // Ensure mission folder exists
        if (!fs.existsSync(this.missionFolder)) {
            fs.mkdirSync(this.missionFolder, { recursive: true });
        }

        try {
            const filePath = this.getStateFilePath();
            this.state.lastUpdatedAt = Date.now();
            fs.writeFileSync(filePath, JSON.stringify(this.state, null, 2), 'utf-8');
            return true;
        } catch (error) {
            console.error(`[PhaseStateManager] Failed to save state:`, error);
            return false;
        }
    }

    /**
     * Get current state
     */
    getState(): PhaseExecutionState | null {
        return this.state;
    }

    /**
     * Check if state exists
     */
    hasState(): boolean {
        return this.state !== null;
    }

    /**
     * Get current phase
     */
    getCurrentPhase(): Phase | null {
        if (!this.state || this.state.currentPhaseIndex >= this.state.phases.length) {
            return null;
        }
        return this.state.phases[this.state.currentPhaseIndex];
    }

    /**
     * Get current phase index
     */
    getCurrentPhaseIndex(): number {
        return this.state?.currentPhaseIndex ?? -1;
    }

    /**
     * Get total phase count
     */
    getTotalPhases(): number {
        return this.state?.phases.length ?? 0;
    }

    /**
     * Check if all phases are complete
     */
    isComplete(): boolean {
        if (!this.state) return false;
        return this.state.currentPhaseIndex >= this.state.phases.length;
    }

    /**
     * Check if execution is in phased mode
     */
    isPhasedExecution(): boolean {
        return this.state?.executionMode === 'phased';
    }

    /**
     * Mark current phase as started
     */
    markPhaseStarted(): void {
        if (!this.state) return;

        const currentPhase = this.getCurrentPhase();
        if (currentPhase) {
            currentPhase.status = 'in-progress';
            this.state.lastUpdatedAt = Date.now();

            if (this.config.autoSave) {
                this.save();
            }
        }
    }

    /**
     * Mark current phase as complete and record result
     */
    markPhaseComplete(result: Omit<PhaseResult, 'phaseId' | 'completedAt'>): PhaseResult | null {
        if (!this.state) return null;

        const currentPhase = this.getCurrentPhase();
        if (!currentPhase) return null;

        // Create full result
        const fullResult: PhaseResult = {
            ...result,
            phaseId: currentPhase.id,
            completedAt: Date.now()
        };

        // Update phase status
        currentPhase.status = result.status === 'completed' ? 'completed' : 'failed';

        // Record result
        this.state.phaseResults.push(fullResult);

        // Update token usage
        this.state.actualTokensUsed += result.tokenUsage;

        // Move to next phase if successful
        if (result.status === 'completed' && result.userApproved) {
            this.state.currentPhaseIndex++;

            // Check if all phases complete
            if (this.state.currentPhaseIndex >= this.state.phases.length) {
                this.state.overallStatus = 'completed';
            }
        } else if (result.status === 'failed') {
            this.state.overallStatus = 'failed';
        }

        this.state.lastUpdatedAt = Date.now();

        if (this.config.autoSave) {
            this.save();
        }

        return fullResult;
    }

    /**
     * Skip current phase
     */
    skipCurrentPhase(reason: string): PhaseResult | null {
        return this.markPhaseComplete({
            status: 'skipped',
            filesCreated: [],
            filesModified: [],
            verificationPassed: false,
            userApproved: true, // Skipping is a form of approval
            tokenUsage: 0,
            summary: `Phase skipped: ${reason}`
        });
    }

    /**
     * Pause execution (for later resumption)
     */
    pauseExecution(): void {
        if (!this.state) return;

        this.state.overallStatus = 'paused';
        this.state.lastUpdatedAt = Date.now();

        if (this.config.autoSave) {
            this.save();
        }
    }

    /**
     * Resume execution
     */
    resumeExecution(): void {
        if (!this.state) return;

        if (this.state.overallStatus === 'paused') {
            this.state.overallStatus = 'in-progress';
            this.state.lastUpdatedAt = Date.now();

            if (this.config.autoSave) {
                this.save();
            }
        }
    }

    /**
     * Update token usage for current phase
     */
    updateTokenUsage(tokens: number): void {
        if (!this.state) return;

        this.state.actualTokensUsed += tokens;
        this.state.lastUpdatedAt = Date.now();

        // Don't auto-save on every token update (too frequent)
    }

    /**
     * Get phase results
     */
    getPhaseResults(): PhaseResult[] {
        return this.state?.phaseResults ?? [];
    }

    /**
     * Get result for a specific phase
     */
    getPhaseResult(phaseId: string): PhaseResult | undefined {
        return this.state?.phaseResults.find(r => r.phaseId === phaseId);
    }

    /**
     * Get execution progress summary
     */
    getProgressSummary(): {
        currentPhase: number;
        totalPhases: number;
        completedPhases: number;
        failedPhases: number;
        percentComplete: number;
        tokensUsed: number;
        tokensEstimated: number;
        status: string;
    } {
        if (!this.state) {
            return {
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

        const completedPhases = this.state.phaseResults.filter(
            r => r.status === 'completed' || r.status === 'skipped'
        ).length;

        const failedPhases = this.state.phaseResults.filter(
            r => r.status === 'failed'
        ).length;

        return {
            currentPhase: this.state.currentPhaseIndex + 1,
            totalPhases: this.state.phases.length,
            completedPhases,
            failedPhases,
            percentComplete: Math.round((completedPhases / this.state.phases.length) * 100),
            tokensUsed: this.state.actualTokensUsed,
            tokensEstimated: this.state.estimatedTotalTokens,
            status: this.state.overallStatus
        };
    }

    /**
     * Generate a progress report
     */
    generateProgressReport(): string {
        if (!this.state) {
            return 'No execution state available.';
        }

        const summary = this.getProgressSummary();
        const lines: string[] = [
            '## Phase Execution Progress',
            '',
            `**Status:** ${summary.status.toUpperCase()}`,
            `**Progress:** Phase ${summary.currentPhase} of ${summary.totalPhases} (${summary.percentComplete}% complete)`,
            `**Tokens:** ${summary.tokensUsed.toLocaleString()} / ${summary.tokensEstimated.toLocaleString()} estimated`,
            '',
            '### Phases',
            '',
            '| # | Phase | Status | Tokens |',
            '|---|-------|--------|--------|'
        ];

        this.state.phases.forEach((phase, index) => {
            const result = this.getPhaseResult(phase.id);
            const status = result?.status ?? phase.status;
            const tokens = result?.tokenUsage ?? '-';
            const indicator = index === this.state!.currentPhaseIndex ? '→' : ' ';
            lines.push(`| ${indicator}${index + 1} | ${phase.name} | ${status} | ${tokens} |`);
        });

        if (this.state.phaseResults.length > 0) {
            lines.push('');
            lines.push('### Completed Phase Results');
            lines.push('');

            this.state.phaseResults.forEach(result => {
                lines.push(`**${result.phaseId}:** ${result.status}`);
                if (result.summary) {
                    lines.push(`  - ${result.summary}`);
                }
                if (result.filesCreated.length > 0) {
                    lines.push(`  - Files created: ${result.filesCreated.join(', ')}`);
                }
                if (result.filesModified.length > 0) {
                    lines.push(`  - Files modified: ${result.filesModified.join(', ')}`);
                }
                lines.push('');
            });
        }

        return lines.join('\n');
    }

    /**
     * Clear state (for testing or reset)
     */
    clearState(): void {
        this.state = null;
        const filePath = this.getStateFilePath();
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<PhaseStateManagerConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get configuration
     */
    getConfig(): PhaseStateManagerConfig {
        return { ...this.config };
    }
}

/**
 * Factory function for creating a PhaseStateManager
 */
export function createPhaseStateManager(
    missionFolder: string,
    config?: Partial<PhaseStateManagerConfig>
): PhaseStateManager {
    return new PhaseStateManager(missionFolder, config);
}
