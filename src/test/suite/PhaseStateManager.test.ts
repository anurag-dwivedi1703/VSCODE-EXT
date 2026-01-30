/**
 * Unit tests for PhaseStateManager service
 * 
 * Tests phase state persistence and management
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    PhaseStateManager,
    createPhaseStateManager
} from '../../services/PhaseStateManager';
import { PhaseGenerationResult, Phase } from '../../services/PhaseGenerator';

suite('PhaseStateManager Test Suite', () => {
    let manager: PhaseStateManager;
    let tempDir: string;

    setup(() => {
        // Create a temporary directory for testing
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-state-test-'));
        manager = createPhaseStateManager(tempDir);
    });

    teardown(() => {
        // Clean up temporary directory
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    function createMockPhaseGenerationResult(): PhaseGenerationResult {
        const phases: Phase[] = [
            {
                id: 'phase-1',
                name: 'Foundation',
                description: 'Set up the foundation',
                requirements: ['Create models', 'Set up database'],
                deliverables: ['Models created', 'Database schema'],
                verificationCriteria: ['Code compiles'],
                estimatedTokens: 10000,
                dependencies: [],
                status: 'pending',
                order: 0,
                domains: ['backend'],
                riskFactors: []
            },
            {
                id: 'phase-2',
                name: 'API',
                description: 'Build the API',
                requirements: ['Create endpoints'],
                deliverables: ['Working API'],
                verificationCriteria: ['Endpoints respond'],
                estimatedTokens: 15000,
                dependencies: ['phase-1'],
                status: 'pending',
                order: 1,
                domains: ['backend'],
                riskFactors: []
            },
            {
                id: 'phase-3',
                name: 'Frontend',
                description: 'Build the UI',
                requirements: ['Create components'],
                deliverables: ['Working UI'],
                verificationCriteria: ['UI renders'],
                estimatedTokens: 12000,
                dependencies: ['phase-2'],
                status: 'pending',
                order: 2,
                domains: ['frontend'],
                riskFactors: []
            }
        ];

        return {
            originalRequirement: 'Build a full-stack app',
            totalPhases: 3,
            phases,
            executionOrder: ['phase-1', 'phase-2', 'phase-3'],
            estimatedTotalTokens: 37000,
            strategyUsed: 'layer-based',
            complexityScore: {
                level: 'HIGH',
                score: 55,
                estimatedTokens: 37000,
                metrics: {
                    featureCount: 5,
                    estimatedFileCount: 10,
                    scopeIndicators: ['full-stack'],
                    riskFactors: [],
                    textLength: 500,
                    technicalDomains: ['frontend', 'backend']
                },
                recommendation: 'SPLIT_PHASES',
                explanation: 'Test',
                suggestedPhaseCount: 3
            },
            summary: 'Test summary'
        };
    }

    suite('Initialization', () => {
        test('should initialize from generation result', () => {
            const genResult = createMockPhaseGenerationResult();
            const state = manager.initializeFromGeneration('task-1', 'Build app', genResult);

            assert.strictEqual(state.taskId, 'task-1');
            assert.strictEqual(state.originalRequirement, 'Build app');
            assert.strictEqual(state.phases.length, 3);
            assert.strictEqual(state.currentPhaseIndex, 0);
            assert.strictEqual(state.executionMode, 'phased');
            assert.strictEqual(state.overallStatus, 'in-progress');
        });

        test('should initialize single phase', () => {
            const state = manager.initializeSinglePhase('task-1', 'Fix bug', 5000);

            assert.strictEqual(state.taskId, 'task-1');
            assert.strictEqual(state.phases.length, 1);
            assert.strictEqual(state.executionMode, 'single');
            assert.strictEqual(state.estimatedTotalTokens, 5000);
        });

        test('should not have state before initialization', () => {
            assert.strictEqual(manager.hasState(), false);
            assert.strictEqual(manager.getState(), null);
        });

        test('should have state after initialization', () => {
            manager.initializeSinglePhase('task-1', 'Test', 1000);

            assert.strictEqual(manager.hasState(), true);
            assert.notStrictEqual(manager.getState(), null);
        });
    });

    suite('Persistence', () => {
        test('should save state to disk', () => {
            manager.initializeSinglePhase('task-1', 'Test', 1000);
            const saved = manager.save();

            assert.strictEqual(saved, true);

            const filePath = path.join(tempDir, 'phase-state.json');
            assert.strictEqual(fs.existsSync(filePath), true);
        });

        test('should load state from disk', () => {
            manager.initializeSinglePhase('task-1', 'Test requirement', 5000);
            manager.save();

            // Create new manager and load
            const newManager = createPhaseStateManager(tempDir);
            const loadedState = newManager.load();

            assert.notStrictEqual(loadedState, null);
            assert.strictEqual(loadedState!.taskId, 'task-1');
            assert.strictEqual(loadedState!.originalRequirement, 'Test requirement');
        });

        test('should return null when no state file exists', () => {
            const loadedState = manager.load();
            assert.strictEqual(loadedState, null);
        });

        test('should auto-save when configured', () => {
            const autoSaveManager = createPhaseStateManager(tempDir, { autoSave: true });
            autoSaveManager.initializeSinglePhase('task-1', 'Test', 1000);

            // Should have auto-saved
            const filePath = path.join(tempDir, 'phase-state.json');
            assert.strictEqual(fs.existsSync(filePath), true);
        });
    });

    suite('Phase Navigation', () => {
        test('should get current phase', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            const currentPhase = manager.getCurrentPhase();
            assert.notStrictEqual(currentPhase, null);
            assert.strictEqual(currentPhase!.id, 'phase-1');
        });

        test('should get current phase index', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            assert.strictEqual(manager.getCurrentPhaseIndex(), 0);
        });

        test('should get total phases', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            assert.strictEqual(manager.getTotalPhases(), 3);
        });

        test('should check if phased execution', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            assert.strictEqual(manager.isPhasedExecution(), true);
        });

        test('should not be phased for single execution', () => {
            manager.initializeSinglePhase('task-1', 'Fix bug', 5000);

            assert.strictEqual(manager.isPhasedExecution(), false);
        });
    });

    suite('Phase Completion', () => {
        test('should mark phase as started', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            manager.markPhaseStarted();

            const phase = manager.getCurrentPhase();
            assert.strictEqual(phase!.status, 'in-progress');
        });

        test('should mark phase as complete', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            const result = manager.markPhaseComplete({
                status: 'completed',
                filesCreated: ['src/model.ts'],
                filesModified: [],
                verificationPassed: true,
                userApproved: true,
                tokenUsage: 8000,
                summary: 'Phase 1 complete'
            });

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.phaseId, 'phase-1');
            assert.strictEqual(result!.status, 'completed');
            assert.strictEqual(manager.getCurrentPhaseIndex(), 1);
        });

        test('should not advance on failed phase', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            manager.markPhaseComplete({
                status: 'failed',
                filesCreated: [],
                filesModified: [],
                verificationPassed: false,
                userApproved: false,
                tokenUsage: 5000,
                errorMessage: 'Build failed'
            });

            assert.strictEqual(manager.getCurrentPhaseIndex(), 0);
            assert.strictEqual(manager.getState()!.overallStatus, 'failed');
        });

        test('should mark all phases complete', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            // Complete all 3 phases
            for (let i = 0; i < 3; i++) {
                manager.markPhaseComplete({
                    status: 'completed',
                    filesCreated: [],
                    filesModified: [],
                    verificationPassed: true,
                    userApproved: true,
                    tokenUsage: 5000
                });
            }

            assert.strictEqual(manager.isComplete(), true);
            assert.strictEqual(manager.getState()!.overallStatus, 'completed');
        });

        test('should skip phase', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            const result = manager.skipCurrentPhase('Not needed');

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.status, 'skipped');
            assert.strictEqual(manager.getCurrentPhaseIndex(), 1);
        });
    });

    suite('Execution Control', () => {
        test('should pause execution', () => {
            manager.initializeSinglePhase('task-1', 'Test', 1000);
            manager.pauseExecution();

            assert.strictEqual(manager.getState()!.overallStatus, 'paused');
        });

        test('should resume execution', () => {
            manager.initializeSinglePhase('task-1', 'Test', 1000);
            manager.pauseExecution();
            manager.resumeExecution();

            assert.strictEqual(manager.getState()!.overallStatus, 'in-progress');
        });

        test('should update token usage', () => {
            manager.initializeSinglePhase('task-1', 'Test', 1000);
            manager.updateTokenUsage(500);
            manager.updateTokenUsage(300);

            assert.strictEqual(manager.getState()!.actualTokensUsed, 800);
        });
    });

    suite('Results', () => {
        test('should get phase results', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            manager.markPhaseComplete({
                status: 'completed',
                filesCreated: ['file1.ts'],
                filesModified: ['file2.ts'],
                verificationPassed: true,
                userApproved: true,
                tokenUsage: 5000
            });

            const results = manager.getPhaseResults();
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0].phaseId, 'phase-1');
        });

        test('should get specific phase result', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            manager.markPhaseComplete({
                status: 'completed',
                filesCreated: [],
                filesModified: [],
                verificationPassed: true,
                userApproved: true,
                tokenUsage: 5000
            });

            const result = manager.getPhaseResult('phase-1');
            assert.notStrictEqual(result, undefined);
            assert.strictEqual(result!.status, 'completed');
        });
    });

    suite('Progress Summary', () => {
        test('should get progress summary', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            manager.markPhaseComplete({
                status: 'completed',
                filesCreated: [],
                filesModified: [],
                verificationPassed: true,
                userApproved: true,
                tokenUsage: 8000
            });

            const summary = manager.getProgressSummary();

            assert.strictEqual(summary.currentPhase, 2);
            assert.strictEqual(summary.totalPhases, 3);
            assert.strictEqual(summary.completedPhases, 1);
            assert.strictEqual(summary.tokensUsed, 8000);
            assert.strictEqual(summary.percentComplete, 33); // 1/3 = 33%
        });

        test('should generate progress report', () => {
            const genResult = createMockPhaseGenerationResult();
            manager.initializeFromGeneration('task-1', 'Build app', genResult);

            const report = manager.generateProgressReport();

            assert.ok(report.includes('Phase Execution Progress'));
            assert.ok(report.includes('Foundation'));
            assert.ok(report.includes('API'));
            assert.ok(report.includes('Frontend'));
        });
    });

    suite('Cleanup', () => {
        test('should clear state', () => {
            manager.initializeSinglePhase('task-1', 'Test', 1000);
            manager.save();

            manager.clearState();

            assert.strictEqual(manager.hasState(), false);

            const filePath = path.join(tempDir, 'phase-state.json');
            assert.strictEqual(fs.existsSync(filePath), false);
        });
    });

    suite('Configuration', () => {
        test('should use custom state filename', () => {
            const customManager = createPhaseStateManager(tempDir, {
                stateFileName: 'custom-state.json'
            });

            customManager.initializeSinglePhase('task-1', 'Test', 1000);
            customManager.save();

            const filePath = path.join(tempDir, 'custom-state.json');
            assert.strictEqual(fs.existsSync(filePath), true);
        });

        test('should update configuration', () => {
            manager.updateConfig({ autoSave: false });
            const config = manager.getConfig();

            assert.strictEqual(config.autoSave, false);
        });
    });
});
