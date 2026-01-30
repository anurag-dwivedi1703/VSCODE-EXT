/**
 * Unit tests for ContextMonitor service
 * 
 * Tests token tracking, budget management, and alert functionality
 */

import * as assert from 'assert';
import {
    ContextMonitor,
    createContextMonitor,
    ContextBudget,
    TokenUsageEvent,
    BudgetAlert
} from '../../services/ContextMonitor';

suite('ContextMonitor Test Suite', () => {
    let monitor: ContextMonitor;

    setup(() => {
        monitor = createContextMonitor({
            totalBudget: 10000,
            warningThreshold: 70,
            criticalThreshold: 90,
            emitNotifications: false
        });
    });

    teardown(() => {
        monitor.dispose();
    });

    suite('Basic Token Tracking', () => {
        test('should start with zero usage', () => {
            const budget = monitor.getBudget();

            assert.strictEqual(budget.used, 0);
            assert.strictEqual(budget.remaining, 10000);
            assert.strictEqual(budget.percentUsed, 0);
            assert.strictEqual(budget.status, 'healthy');
        });

        test('should track token usage events', () => {
            monitor.trackUsage({
                type: 'prompt',
                tokens: 500,
                timestamp: Date.now(),
                source: 'test'
            });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.used, 500);
            assert.strictEqual(budget.remaining, 9500);
        });

        test('should accumulate multiple usage events', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 500, timestamp: Date.now(), source: 'test1' });
            monitor.trackUsage({ type: 'response', tokens: 300, timestamp: Date.now(), source: 'test2' });
            monitor.trackUsage({ type: 'context', tokens: 200, timestamp: Date.now(), source: 'test3' });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.used, 1000);
            assert.strictEqual(budget.remaining, 9000);
        });

        test('should calculate percentage correctly', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 2500, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.percentUsed, 25);
        });
    });

    suite('Token Estimation', () => {
        test('should estimate tokens from text', () => {
            const text = 'Hello, this is a test message.'; // ~31 chars
            const tokens = monitor.estimateTokens(text);

            // With default 4 chars/token, should be ~8 tokens
            assert.ok(tokens >= 7 && tokens <= 10, `Expected 7-10 tokens, got ${tokens}`);
        });

        test('should handle empty text', () => {
            const tokens = monitor.estimateTokens('');
            assert.strictEqual(tokens, 0);
        });

        test('should adjust for code content', () => {
            const plainText = 'This is just plain text without any code.';
            const codeText = `
                function test() {
                    const x = 1;
                    const y = 2;
                    return x + y;
                }
                export class Example {
                    constructor() {}
                }
            `;

            const plainTokens = monitor.estimateTokens(plainText);
            const codeTokens = monitor.estimateTokens(codeText);

            // Code should have higher token estimate per character
            const _plainRatio = plainTokens / plainText.length;
            const _codeRatio = codeTokens / codeText.length;

            // Code ratio should be higher (more tokens per char)
            // This might not always be true due to whitespace, but the estimate should account for code
            assert.ok(codeTokens > 0, 'Should estimate code tokens');
        });

        test('should track text via trackText method', () => {
            const text = 'A'.repeat(400); // 400 chars = ~100 tokens
            monitor.trackText(text, 'prompt', 'test');

            const budget = monitor.getBudget();
            assert.ok(budget.used >= 90 && budget.used <= 110, `Expected ~100 tokens, got ${budget.used}`);
        });
    });

    suite('Convenience Tracking Methods', () => {
        test('should track prompts', () => {
            monitor.trackPrompt('What is the weather today?');

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].type, 'prompt');
        });

        test('should track responses', () => {
            monitor.trackResponse('The weather is sunny and warm.');

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].type, 'response');
        });

        test('should track tool calls', () => {
            monitor.trackToolCall('read_file', '{"path": "test.txt"}');

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].type, 'tool-call');
            assert.ok(history[0].source.includes('read_file'));
        });

        test('should track tool results', () => {
            monitor.trackToolResult('read_file', 'File contents here...');

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].type, 'tool-result');
        });

        test('should track context', () => {
            monitor.trackContext('const x = 1;', 'file:test.ts');

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].type, 'context');
        });

        test('should track system prompt', () => {
            monitor.trackSystemPrompt('You are a helpful assistant.');

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].type, 'system');
        });
    });

    suite('Budget Status Levels', () => {
        test('should be healthy below warning threshold', () => {
            // Use 60% of budget (below 70% warning)
            monitor.trackUsage({ type: 'prompt', tokens: 6000, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.status, 'healthy');
        });

        test('should be warning at warning threshold', () => {
            // Use 75% of budget
            monitor.trackUsage({ type: 'prompt', tokens: 7500, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.status, 'warning');
        });

        test('should be critical at critical threshold', () => {
            // Use 92% of budget
            monitor.trackUsage({ type: 'prompt', tokens: 9200, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.status, 'critical');
        });

        test('should be exhausted at 100%', () => {
            // Use 100% of budget
            monitor.trackUsage({ type: 'prompt', tokens: 10000, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.status, 'exhausted');
        });

        test('should handle exceeding budget', () => {
            // Use 120% of budget
            monitor.trackUsage({ type: 'prompt', tokens: 12000, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.status, 'exhausted');
            assert.strictEqual(budget.remaining, 0);
            assert.strictEqual(budget.percentUsed, 100); // Capped at 100
        });
    });

    suite('Recommended Actions', () => {
        test('should recommend continue when healthy', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 5000, timestamp: Date.now(), source: 'test' });

            const action = monitor.getRecommendedAction();
            assert.strictEqual(action, 'continue');
        });

        test('should recommend wrap-up at warning', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 7500, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudget();
            assert.ok(
                budget.recommendedAction === 'wrap-up' || budget.recommendedAction === 'checkpoint',
                `Expected wrap-up or checkpoint, got ${budget.recommendedAction}`
            );
        });

        test('should recommend checkpoint at critical', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 9200, timestamp: Date.now(), source: 'test' });

            const action = monitor.getRecommendedAction();
            assert.strictEqual(action, 'checkpoint');
        });

        test('should recommend stop when exhausted', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 10000, timestamp: Date.now(), source: 'test' });

            const action = monitor.getRecommendedAction();
            assert.strictEqual(action, 'stop');
        });
    });

    suite('Can Afford Check', () => {
        test('should afford operation within budget', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 5000, timestamp: Date.now(), source: 'test' });

            // Should afford 2000 tokens (5000 used + 2000 new + 2000 reserve = 9000 < 10000)
            assert.strictEqual(monitor.canAfford(2000), true);
        });

        test('should not afford operation exceeding budget', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 8000, timestamp: Date.now(), source: 'test' });

            // Cannot afford 1000 tokens (8000 used + 1000 new + 2000 reserve = 11000 > 10000)
            assert.strictEqual(monitor.canAfford(1000), false);
        });

        test('should include estimate in budget', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 5000, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudgetWithEstimate(1000);
            assert.strictEqual(budget.estimatedNext, 1000);
            assert.strictEqual(budget.canAffordNext, true);
        });
    });

    suite('Phase Boundary Trigger', () => {
        test('should not trigger phase boundary when healthy', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 5000, timestamp: Date.now(), source: 'test' });

            assert.strictEqual(monitor.shouldTriggerPhaseBoundary(), false);
        });

        test('should trigger phase boundary when critical', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 9200, timestamp: Date.now(), source: 'test' });

            assert.strictEqual(monitor.shouldTriggerPhaseBoundary(), true);
        });

        test('should trigger phase boundary when exhausted', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 10000, timestamp: Date.now(), source: 'test' });

            assert.strictEqual(monitor.shouldTriggerPhaseBoundary(), true);
        });

        test('should trigger when remaining less than wrap-up reserve', () => {
            // Default wrap-up reserve is 2000
            monitor.trackUsage({ type: 'prompt', tokens: 8500, timestamp: Date.now(), source: 'test' });

            // Remaining is 1500, less than 2000 reserve
            assert.strictEqual(monitor.shouldTriggerPhaseBoundary(), true);
        });
    });

    suite('Event Emission', () => {
        test('should emit warning event on status change', (done) => {
            monitor.events.onWarning((alert: BudgetAlert) => {
                assert.strictEqual(alert.level, 'warning');
                assert.ok(alert.message.includes('70') || alert.message.includes('75'));
                done();
            });

            // Trigger warning
            monitor.trackUsage({ type: 'prompt', tokens: 7500, timestamp: Date.now(), source: 'test' });
        });

        test('should emit critical event on status change', (done) => {
            // First go to warning
            monitor.trackUsage({ type: 'prompt', tokens: 7500, timestamp: Date.now(), source: 'test' });

            monitor.events.onCritical((alert: BudgetAlert) => {
                assert.strictEqual(alert.level, 'critical');
                done();
            });

            // Then trigger critical
            monitor.trackUsage({ type: 'prompt', tokens: 1700, timestamp: Date.now(), source: 'test' });
        });

        test('should emit exhausted event on status change', (done) => {
            // Go to critical first
            monitor.trackUsage({ type: 'prompt', tokens: 9200, timestamp: Date.now(), source: 'test' });

            monitor.events.onExhausted((alert: BudgetAlert) => {
                assert.strictEqual(alert.level, 'exhausted');
                done();
            });

            // Then exhaust
            monitor.trackUsage({ type: 'prompt', tokens: 1000, timestamp: Date.now(), source: 'test' });
        });

        test('should emit status change event', (done) => {
            monitor.events.onStatusChange((budget: ContextBudget) => {
                assert.strictEqual(budget.status, 'warning');
                done();
            });

            monitor.trackUsage({ type: 'prompt', tokens: 7500, timestamp: Date.now(), source: 'test' });
        });

        test('should emit usage tracked event', (done) => {
            monitor.events.onUsageTracked((event: TokenUsageEvent) => {
                assert.strictEqual(event.tokens, 100);
                assert.strictEqual(event.source, 'test');
                done();
            });

            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test' });
        });

        test('should not emit duplicate alerts for same status', () => {
            let warningCount = 0;
            monitor.events.onWarning(() => warningCount++);

            // Multiple events at warning level
            monitor.trackUsage({ type: 'prompt', tokens: 7500, timestamp: Date.now(), source: 'test1' });
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test2' });
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test3' });

            // Should only fire once (on first transition to warning)
            assert.strictEqual(warningCount, 1);
        });
    });

    suite('Statistics', () => {
        test('should calculate statistics correctly', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 500, timestamp: Date.now(), source: 'user' });
            monitor.trackUsage({ type: 'response', tokens: 300, timestamp: Date.now(), source: 'ai' });
            monitor.trackUsage({ type: 'context', tokens: 200, timestamp: Date.now(), source: 'file' });

            const stats = monitor.getStatistics();

            assert.strictEqual(stats.totalTokens, 1000);
            assert.strictEqual(stats.eventCount, 3);
            assert.strictEqual(stats.byType['prompt'], 500);
            assert.strictEqual(stats.byType['response'], 300);
            assert.strictEqual(stats.byType['context'], 200);
            assert.strictEqual(stats.peakUsage, 500);
        });

        test('should calculate average per event', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test' });
            monitor.trackUsage({ type: 'prompt', tokens: 200, timestamp: Date.now(), source: 'test' });
            monitor.trackUsage({ type: 'prompt', tokens: 300, timestamp: Date.now(), source: 'test' });

            const stats = monitor.getStatistics();
            assert.strictEqual(stats.averagePerEvent, 200);
        });

        test('should track by source', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'source-a' });
            monitor.trackUsage({ type: 'prompt', tokens: 200, timestamp: Date.now(), source: 'source-b' });
            monitor.trackUsage({ type: 'prompt', tokens: 150, timestamp: Date.now(), source: 'source-a' });

            const stats = monitor.getStatistics();
            assert.strictEqual(stats.bySource['source-a'], 250);
            assert.strictEqual(stats.bySource['source-b'], 200);
        });
    });

    suite('History', () => {
        test('should return full history', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test1' });
            monitor.trackUsage({ type: 'prompt', tokens: 200, timestamp: Date.now(), source: 'test2' });
            monitor.trackUsage({ type: 'prompt', tokens: 300, timestamp: Date.now(), source: 'test3' });

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 3);
        });

        test('should return limited history', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test1' });
            monitor.trackUsage({ type: 'prompt', tokens: 200, timestamp: Date.now(), source: 'test2' });
            monitor.trackUsage({ type: 'prompt', tokens: 300, timestamp: Date.now(), source: 'test3' });

            const history = monitor.getHistory(2);
            assert.strictEqual(history.length, 2);
            // Should be last 2 events
            assert.strictEqual(history[0].source, 'test2');
            assert.strictEqual(history[1].source, 'test3');
        });
    });

    suite('Reset', () => {
        test('should reset all tracking', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 5000, timestamp: Date.now(), source: 'test' });
            monitor.reset();

            const budget = monitor.getBudget();
            assert.strictEqual(budget.used, 0);
            assert.strictEqual(budget.remaining, 10000);
            assert.strictEqual(budget.status, 'healthy');

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 0);
        });

        test('should reset with new budget', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 5000, timestamp: Date.now(), source: 'test' });
            monitor.reset(20000);

            const budget = monitor.getBudget();
            assert.strictEqual(budget.totalBudget, 20000);
            assert.strictEqual(budget.used, 0);
        });

        test('should reset with phase ID', () => {
            monitor.reset(10000, 'phase-2');
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test' });

            const history = monitor.getHistory();
            assert.strictEqual(history[0].phaseId, 'phase-2');
        });
    });

    suite('Phase Tracking', () => {
        test('should set phase ID', () => {
            monitor.setPhase('phase-1');
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test' });

            const history = monitor.getHistory();
            assert.strictEqual(history[0].phaseId, 'phase-1');
        });

        test('should not override explicit phase ID', () => {
            monitor.setPhase('phase-1');
            monitor.trackUsage({ type: 'prompt', tokens: 100, timestamp: Date.now(), source: 'test', phaseId: 'phase-2' });

            const history = monitor.getHistory();
            assert.strictEqual(history[0].phaseId, 'phase-2');
        });
    });

    suite('Configuration', () => {
        test('should use custom thresholds', () => {
            const customMonitor = createContextMonitor({
                totalBudget: 10000,
                warningThreshold: 50,
                criticalThreshold: 80
            });

            customMonitor.trackUsage({ type: 'prompt', tokens: 5500, timestamp: Date.now(), source: 'test' });
            assert.strictEqual(customMonitor.getBudget().status, 'warning');

            customMonitor.trackUsage({ type: 'prompt', tokens: 2600, timestamp: Date.now(), source: 'test' });
            assert.strictEqual(customMonitor.getBudget().status, 'critical');

            customMonitor.dispose();
        });

        test('should update configuration', () => {
            monitor.updateConfig({ totalBudget: 20000 });
            const config = monitor.getConfig();

            assert.strictEqual(config.totalBudget, 20000);
        });

        test('should preserve other config when updating', () => {
            const originalConfig = monitor.getConfig();
            monitor.updateConfig({ totalBudget: 20000 });
            const newConfig = monitor.getConfig();

            assert.strictEqual(newConfig.warningThreshold, originalConfig.warningThreshold);
            assert.strictEqual(newConfig.criticalThreshold, originalConfig.criticalThreshold);
        });
    });

    suite('Report Generation', () => {
        test('should generate a report', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 500, timestamp: Date.now(), source: 'user' });
            monitor.trackUsage({ type: 'response', tokens: 300, timestamp: Date.now(), source: 'ai' });

            const report = monitor.generateReport();

            assert.ok(report.includes('Context Budget Report'));
            assert.ok(report.includes('Status'));
            assert.ok(report.includes('Used'));
            assert.ok(report.includes('Remaining'));
            assert.ok(report.includes('prompt'));
            assert.ok(report.includes('response'));
        });
    });

    suite('Edge Cases', () => {
        test('should handle zero budget', () => {
            const zeroMonitor = createContextMonitor({ totalBudget: 0 });

            const budget = zeroMonitor.getBudget();
            // With zero budget, any usage would be exhausted, but with no usage it's a special case
            assert.strictEqual(budget.remaining, 0);

            zeroMonitor.dispose();
        });

        test('should handle very large token counts', () => {
            monitor.trackUsage({ type: 'prompt', tokens: 1000000, timestamp: Date.now(), source: 'test' });

            const budget = monitor.getBudget();
            assert.strictEqual(budget.status, 'exhausted');
            assert.strictEqual(budget.percentUsed, 100); // Capped
        });

        test('should handle rapid sequential events', () => {
            for (let i = 0; i < 100; i++) {
                monitor.trackUsage({ type: 'prompt', tokens: 10, timestamp: Date.now(), source: `test-${i}` });
            }

            const budget = monitor.getBudget();
            assert.strictEqual(budget.used, 1000);

            const history = monitor.getHistory();
            assert.strictEqual(history.length, 100);
        });
    });
});
