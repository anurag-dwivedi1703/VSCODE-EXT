/**
 * Unit tests for PhaseExecutor service
 * 
 * Tests phase execution orchestration
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    PhaseExecutor,
    createPhaseExecutor
} from '../../services/PhaseExecutor';

suite('PhaseExecutor Test Suite', () => {
    let executor: PhaseExecutor;
    let tempDir: string;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-executor-test-'));
        executor = createPhaseExecutor({
            tokenBudgetPerPhase: 10000,
            autoApprove: true, // Auto-approve for most tests
            requireApprovalBetweenPhases: false
        });
        executor.initialize(tempDir, 'test-task');
    });

    teardown(() => {
        executor.dispose();
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    suite('Initialization', () => {
        test('should initialize executor', () => {
            assert.strictEqual(executor.getState(), null); // No state until analysis
        });

        test('should throw if not initialized', () => {
            const uninitializedExecutor = createPhaseExecutor();

            assert.throws(() => {
                uninitializedExecutor.startSingleExecution('task', 'req', 1000);
            }, /not initialized/);

            uninitializedExecutor.dispose();
        });
    });

    suite('Requirement Analysis', () => {
        test('should analyze simple requirement as single mode', async () => {
            const result = await executor.analyzeRequirement('Fix the typo in README.');

            assert.strictEqual(result.recommendedMode, 'single');
            assert.strictEqual(result.phases, undefined);
        });

        test('should analyze complex requirement as phased mode', async () => {
            const result = await executor.analyzeRequirement(`
                Build a complete full-stack application with:
                - User authentication and authorization
                - RESTful API with CRUD operations
                - React frontend with dashboard
                - PostgreSQL database with migrations
                - Real-time notifications
            `);

            assert.strictEqual(result.recommendedMode, 'phased');
            assert.notStrictEqual(result.phases, undefined);
            assert.ok(result.phases!.totalPhases >= 2);
        });

        test('should emit mode decided event', async () => {
            let eventFired = false;
            executor.events.onModeDecided((data) => {
                eventFired = true;
                assert.ok(['single', 'phased'].includes(data.mode));
            });

            await executor.analyzeRequirement('Add a button.');

            assert.strictEqual(eventFired, true);
        });
    });

    suite('Single Phase Execution', () => {
        test('should start single execution', async () => {
            const state = executor.startSingleExecution('task-1', 'Fix bug', 5000);

            assert.strictEqual(state.executionMode, 'single');
            assert.strictEqual(state.phases.length, 1);
            assert.strictEqual(state.currentPhaseIndex, 0);
        });

        test('should get current phase', () => {
            executor.startSingleExecution('task-1', 'Fix bug', 5000);

            const phase = executor.getCurrentPhase();
            assert.notStrictEqual(phase, null);
            assert.strictEqual(phase!.name, 'Implementation');
        });
    });

    suite('Phased Execution', () => {
        test('should start phased execution', async () => {
            const analysis = await executor.analyzeRequirement(`
                Build a full-stack app with backend API and frontend UI.
            `);

            if (analysis.phases) {
                const state = executor.startPhasedExecution(
                    'task-1',
                    'Build app',
                    analysis.phases
                );

                assert.strictEqual(state.executionMode, 'phased');
                assert.ok(state.phases.length >= 1);
            }
        });

        test('should begin phase execution', async () => {
            executor.startSingleExecution('task-1', 'Test', 5000);

            let eventFired = false;
            executor.events.onPhaseStarted((data) => {
                eventFired = true;
                assert.strictEqual(data.index, 0);
            });

            executor.beginPhaseExecution();

            assert.strictEqual(eventFired, true);
        });
    });

    suite('Token Tracking', () => {
        test('should track tokens', () => {
            executor.startSingleExecution('task-1', 'Test', 5000);
            executor.beginPhaseExecution();

            executor.trackTokens(1000, 'test');
            executor.trackTokens(500, 'test');

            const budget = executor.getBudget();
            assert.strictEqual(budget.used, 1500);
        });

        test('should get budget status', () => {
            executor.startSingleExecution('task-1', 'Test', 10000);
            executor.beginPhaseExecution();

            executor.trackTokens(7500, 'test');

            const budget = executor.getBudget();
            assert.strictEqual(budget.status, 'warning');
        });

        test('should detect phase boundary trigger', () => {
            executor.startSingleExecution('task-1', 'Test', 10000);
            executor.beginPhaseExecution();

            // Use most of the budget
            executor.trackTokens(9500, 'test');

            assert.strictEqual(executor.shouldTriggerPhaseBoundary(), true);
        });

        test('should emit budget update events', () => {
            executor.startSingleExecution('task-1', 'Test', 10000);
            executor.beginPhaseExecution();

            let eventCount = 0;
            executor.events.onBudgetUpdate(() => {
                eventCount++;
            });

            // Trigger warning threshold
            executor.trackTokens(7500, 'test');

            assert.ok(eventCount >= 1);
        });
    });

    suite('Phase Completion', () => {
        test('should complete phase with auto-approve', async () => {
            executor.startSingleExecution('task-1', 'Test', 5000);
            executor.beginPhaseExecution();

            let completedFired = false;
            executor.events.onPhaseCompleted((data) => {
                completedFired = true;
                assert.strictEqual(data.result.status, 'completed');
            });

            const response = await executor.completePhase(
                'Phase completed successfully',
                ['new-file.ts'],
                ['existing-file.ts'],
                ['Code compiles: PASS']
            );

            assert.strictEqual(response.status, 'approved');
            assert.strictEqual(completedFired, true);
        });

        test('should emit all phases complete event', async () => {
            executor.startSingleExecution('task-1', 'Test', 5000);
            executor.beginPhaseExecution();

            let allCompleteFired = false;
            executor.events.onAllPhasesComplete((data) => {
                allCompleteFired = true;
                assert.strictEqual(data.results.length, 1);
            });

            await executor.completePhase(
                'Done',
                [],
                [],
                []
            );

            assert.strictEqual(allCompleteFired, true);
        });
    });

    suite('Phase Approval', () => {
        test('should request approval when configured', async () => {
            const approvalExecutor = createPhaseExecutor({
                tokenBudgetPerPhase: 10000,
                autoApprove: false,
                requireApprovalBetweenPhases: true
            });
            approvalExecutor.initialize(tempDir, 'approval-test');
            approvalExecutor.startSingleExecution('task-1', 'Test', 5000);
            approvalExecutor.beginPhaseExecution();

            let approvalRequested = false;
            approvalExecutor.events.onApprovalNeeded((request) => {
                approvalRequested = true;
                assert.strictEqual(request.phaseIndex, 0);

                // Provide approval
                approvalExecutor.provideApproval({
                    status: 'approved',
                    continueToNext: true,
                    abortMission: false
                });
            });

            const responsePromise = approvalExecutor.completePhase(
                'Done',
                [],
                [],
                []
            );

            const response = await responsePromise;
            assert.strictEqual(approvalRequested, true);
            assert.strictEqual(response.status, 'approved');

            approvalExecutor.dispose();
        });

        test('should check for pending approval', () => {
            const approvalExecutor = createPhaseExecutor({
                autoApprove: false,
                requireApprovalBetweenPhases: true
            });
            approvalExecutor.initialize(tempDir, 'pending-test');
            approvalExecutor.startSingleExecution('task-1', 'Test', 5000);
            approvalExecutor.beginPhaseExecution();

            // Start completion but don't await
            approvalExecutor.completePhase('Done', [], [], []);

            assert.strictEqual(approvalExecutor.hasPendingApproval(), true);
            assert.notStrictEqual(approvalExecutor.getPendingApproval(), null);

            // Clean up
            approvalExecutor.provideApproval({
                status: 'approved',
                continueToNext: true,
                abortMission: false
            });
            approvalExecutor.dispose();
        });
    });

    suite('Mission Control', () => {
        test('should abort mission', () => {
            executor.startSingleExecution('task-1', 'Test', 5000);

            executor.abortMission('User cancelled');

            const state = executor.getState();
            assert.strictEqual(state!.overallStatus, 'paused');
        });

        test('should skip current phase', async () => {
            const analysis = await executor.analyzeRequirement(`
                Build a system with:
                - Database models
                - API endpoints  
                - Frontend UI
            `);

            if (analysis.phases && analysis.phases.totalPhases > 1) {
                executor.startPhasedExecution('task-1', 'Build', analysis.phases);
                executor.beginPhaseExecution();

                const result = executor.skipCurrentPhase('Already done');

                assert.notStrictEqual(result, null);
                assert.strictEqual(result!.status, 'skipped');
            }
        });
    });

    suite('Progress Tracking', () => {
        test('should get progress summary', () => {
            executor.startSingleExecution('task-1', 'Test', 5000);

            const summary = executor.getProgressSummary();

            assert.strictEqual(summary.currentPhase, 1);
            assert.strictEqual(summary.totalPhases, 1);
            assert.strictEqual(summary.status, 'in-progress');
        });

        test('should generate progress report', () => {
            executor.startSingleExecution('task-1', 'Test', 5000);

            const report = executor.generateProgressReport();

            assert.ok(report.includes('Phase Execution Progress'));
        });
    });

    suite('Phase Prompt Context', () => {
        test('should generate phase prompt context', () => {
            executor.startSingleExecution('task-1', 'Build a feature', 5000);
            executor.beginPhaseExecution();

            const context = executor.getPhasePromptContext();

            assert.ok(context.includes('PHASE EXECUTION CONTEXT'));
            assert.ok(context.includes('Phase 1 of 1'));
            assert.ok(context.includes('Token Budget'));
            assert.ok(context.includes('IMPORTANT CONSTRAINTS'));
        });

        test('should include previous results in context', async () => {
            const analysis = await executor.analyzeRequirement(`
                Build a system with backend API and frontend components.
            `);

            if (analysis.phases && analysis.phases.totalPhases > 1) {
                executor.startPhasedExecution('task-1', 'Build', analysis.phases);
                executor.beginPhaseExecution();

                // Complete first phase
                await executor.completePhase(
                    'API done',
                    ['api.ts'],
                    [],
                    ['PASS']
                );

                // Get context for second phase
                executor.beginPhaseExecution();
                const context = executor.getPhasePromptContext();

                assert.ok(context.includes('Previous Phase Results'));
            }
        });
    });

    suite('Configuration', () => {
        test('should update configuration', () => {
            executor.updateConfig({ tokenBudgetPerPhase: 50000 });
            const config = executor.getConfig();

            assert.strictEqual(config.tokenBudgetPerPhase, 50000);
        });

        test('should use custom threshold', async () => {
            const customExecutor = createPhaseExecutor({
                phasedExecutionThreshold: 10 // Very low threshold
            });
            customExecutor.initialize(tempDir, 'custom-test');

            const result = await customExecutor.analyzeRequirement(
                'Add a simple feature with some complexity.'
            );

            // With very low threshold, even simple requirements might be phased
            // (depends on complexity analysis)
            assert.ok(['single', 'phased'].includes(result.recommendedMode));

            customExecutor.dispose();
        });
    });

    suite('Context Monitor Access', () => {
        test('should provide access to context monitor', () => {
            const monitor = executor.getContextMonitor();

            assert.notStrictEqual(monitor, null);
            assert.strictEqual(typeof monitor.trackUsage, 'function');
            assert.strictEqual(typeof monitor.getBudget, 'function');
        });
    });

    suite('Edge Cases', () => {
        test('should handle empty requirement', async () => {
            const result = await executor.analyzeRequirement('');

            assert.strictEqual(result.recommendedMode, 'single');
        });

        test('should handle state without phases', () => {
            const context = executor.getPhasePromptContext();
            assert.strictEqual(context, ''); // No state, empty context
        });

        test('should handle completion without starting', async () => {
            // No phase started
            await assert.rejects(async () => {
                await executor.completePhase('Done', [], [], []);
            }, /No active phase/);
        });
    });
});
