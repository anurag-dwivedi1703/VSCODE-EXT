/**
 * RefinementCheckpointManager.ts
 * File-based state persistence for refinement cycles.
 * 
 * Writes checkpoint files to {missionFolder}/refinement/checkpoint.json
 * so that stage-isolated sessions can reconstruct context from disk
 * rather than relying on accumulated message history.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CritiqueResult, RefinementCheckpoint, RefinementCycle } from './RefinementTypes';

/** Maximum checkpoint file size before older cycle drafts are truncated */
const MAX_CHECKPOINT_SIZE_BYTES = 500 * 1024; // 500KB

/** Truncation marker appended when cycle content is trimmed */
const TRUNCATION_MARKER = '\n[TRUNCATED]';

export class RefinementCheckpointManager {
    private _checkpoint: RefinementCheckpoint | null = null;
    private _checkpointDir: string;
    private _checkpointPath: string;
    private _noOp: boolean;

    constructor(missionFolderPath: string, sessionId: string, taskId: string) {
        if (!missionFolderPath) {
            console.warn('[RefinementCheckpointManager] No mission folder provided — operating in no-op mode');
            this._noOp = true;
            this._checkpointDir = '';
            this._checkpointPath = '';
            return;
        }

        this._noOp = false;
        this._checkpointDir = path.join(missionFolderPath, 'refinement');
        this._checkpointPath = path.join(this._checkpointDir, 'checkpoint.json');

        // Initialize a blank checkpoint structure
        this._checkpoint = {
            sessionId,
            taskId,
            originalPrompt: '',
            skeletonContext: '',
            constitutionContext: '',
            cycles: [],
            currentCycleNumber: 1,
            totalIterationCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }

    // ========================================
    // Initialization
    // ========================================

    /**
     * Initialize checkpoint with immutable context.
     */
    initCheckpoint(originalPrompt: string, skeletonContext: string, constitutionContext: string): void {
        if (this._noOp || !this._checkpoint) { return; }
        this._checkpoint.originalPrompt = originalPrompt;
        this._checkpoint.skeletonContext = skeletonContext;
        this._checkpoint.constitutionContext = constitutionContext;
        this.writeToDisk();
    }

    /**
     * Load existing checkpoint from disk (for crash recovery — future use).
     */
    loadCheckpoint(): RefinementCheckpoint | null {
        if (this._noOp) { return null; }
        try {
            if (fs.existsSync(this._checkpointPath)) {
                const raw = fs.readFileSync(this._checkpointPath, 'utf-8');
                this._checkpoint = JSON.parse(raw) as RefinementCheckpoint;
                console.log(`[RefinementCheckpointManager] Loaded checkpoint: cycle ${this._checkpoint.currentCycleNumber}`);
                return this._checkpoint;
            }
        } catch (err) {
            console.error('[RefinementCheckpointManager] Failed to load checkpoint:', err);
        }
        return null;
    }

    // ========================================
    // Stage-Completion Writes
    // ========================================

    /**
     * Save analyst draft at the end of the analyst stage.
     */
    saveAnalystDraft(cycleNumber: number, draft: string, clarifications: string[]): void {
        if (this._noOp || !this._checkpoint) { return; }

        const cycle = this.getOrCreateCycle(cycleNumber);
        cycle.analystDraft = draft;
        cycle.clarifications = clarifications;
        this._checkpoint.currentCycleNumber = cycleNumber;
        this.writeToDisk();
    }

    /**
     * Save critique result at the end of the critic stage.
     */
    saveCritiqueResult(cycleNumber: number, critique: CritiqueResult): void {
        if (this._noOp || !this._checkpoint) { return; }

        const cycle = this.getOrCreateCycle(cycleNumber);
        cycle.critiqueResult = critique;
        this.writeToDisk();
    }

    /**
     * Save refined PRD at the end of the refiner stage.
     */
    saveRefinedPrd(cycleNumber: number, prd: string): void {
        if (this._noOp || !this._checkpoint) { return; }

        const cycle = this.getOrCreateCycle(cycleNumber);
        cycle.refinedPrd = prd;
        this.writeToDisk();
    }

    /**
     * Save user feedback when a new cycle begins.
     */
    saveUserFeedback(cycleNumber: number, feedback: string): void {
        if (this._noOp || !this._checkpoint) { return; }

        const cycle = this.getOrCreateCycle(cycleNumber);
        cycle.userFeedback = feedback;
        this.writeToDisk();
    }

    // ========================================
    // Accessors for Building Stage Prompts
    // ========================================

    /**
     * Get the latest refined PRD across all cycles.
     */
    getLatestRefinedPrd(): string | undefined {
        if (this._noOp || !this._checkpoint) { return undefined; }
        for (let i = this._checkpoint.cycles.length - 1; i >= 0; i--) {
            if (this._checkpoint.cycles[i].refinedPrd) {
                return this._checkpoint.cycles[i].refinedPrd;
            }
        }
        return undefined;
    }

    /**
     * Get the latest critique result across all cycles.
     */
    getLatestCritique(): CritiqueResult | undefined {
        if (this._noOp || !this._checkpoint) { return undefined; }
        for (let i = this._checkpoint.cycles.length - 1; i >= 0; i--) {
            if (this._checkpoint.cycles[i].critiqueResult) {
                return this._checkpoint.cycles[i].critiqueResult;
            }
        }
        return undefined;
    }

    /**
     * Get all user feedback strings across cycles.
     */
    getAllUserFeedback(): string[] {
        if (this._noOp || !this._checkpoint) { return []; }
        return this._checkpoint.cycles
            .filter(c => c.userFeedback)
            .map(c => c.userFeedback!);
    }

    /**
     * Get a compact summary of all clarifications across cycles.
     */
    getCompactClarificationHistory(): string {
        if (this._noOp || !this._checkpoint) { return ''; }
        const allClarifications: string[] = [];
        for (const cycle of this._checkpoint.cycles) {
            for (const c of cycle.clarifications) {
                allClarifications.push(c);
            }
        }
        if (allClarifications.length === 0) { return ''; }
        return allClarifications.map((c, i) => `${i + 1}. ${c}`).join('\n');
    }

    /**
     * Get artifacts for a specific cycle.
     */
    getCycleArtifacts(cycleNumber: number): RefinementCycle | undefined {
        if (this._noOp || !this._checkpoint) { return undefined; }
        return this._checkpoint.cycles.find(c => c.cycleNumber === cycleNumber);
    }

    // ========================================
    // Cleanup
    // ========================================

    /**
     * Dispose internal state. Does NOT delete checkpoint files
     * (they inherit MissionFolderManager's retention policy).
     */
    dispose(): void {
        this._checkpoint = null;
    }

    // ========================================
    // Private Helpers
    // ========================================

    private getOrCreateCycle(cycleNumber: number): RefinementCycle {
        if (!this._checkpoint) {
            throw new Error('Checkpoint not initialized');
        }
        let cycle = this._checkpoint.cycles.find(c => c.cycleNumber === cycleNumber);
        if (!cycle) {
            cycle = {
                cycleNumber,
                analystDraft: '',
                clarifications: [],
                timestamp: Date.now(),
            };
            this._checkpoint.cycles.push(cycle);
        }
        return cycle;
    }

    private writeToDisk(): void {
        if (this._noOp || !this._checkpoint) { return; }

        this._checkpoint.updatedAt = Date.now();

        try {
            fs.mkdirSync(this._checkpointDir, { recursive: true });

            let json = JSON.stringify(this._checkpoint, null, 2);

            // Safety check: truncate older cycle drafts if file would exceed limit
            if (Buffer.byteLength(json, 'utf-8') > MAX_CHECKPOINT_SIZE_BYTES) {
                this.truncateOlderCycles();
                json = JSON.stringify(this._checkpoint, null, 2);
            }

            fs.writeFileSync(this._checkpointPath, json, 'utf-8');
        } catch (err) {
            console.error('[RefinementCheckpointManager] Failed to write checkpoint:', err);
        }
    }

    private truncateOlderCycles(): void {
        if (!this._checkpoint) { return; }
        // Keep the latest cycle intact, truncate older ones
        for (let i = 0; i < this._checkpoint.cycles.length - 1; i++) {
            const cycle = this._checkpoint.cycles[i];
            if (cycle.analystDraft.length > 500) {
                cycle.analystDraft = cycle.analystDraft.slice(0, 500) + TRUNCATION_MARKER;
            }
            if (cycle.refinedPrd && cycle.refinedPrd.length > 500) {
                cycle.refinedPrd = cycle.refinedPrd.slice(0, 500) + TRUNCATION_MARKER;
            }
        }
    }
}
