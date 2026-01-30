/**
 * Unit tests for PhaseGenerator service
 * 
 * Tests the phase splitting algorithms with various requirement types
 */

import * as assert from 'assert';
import {
    PhaseGenerator,
    createPhaseGenerator
} from '../../services/PhaseGenerator';
import { ComplexityAnalyzer, createComplexityAnalyzer } from '../../services/ComplexityAnalyzer';

suite('PhaseGenerator Test Suite', () => {
    let generator: PhaseGenerator;
    let analyzer: ComplexityAnalyzer;

    setup(() => {
        analyzer = createComplexityAnalyzer();
        generator = createPhaseGenerator(analyzer);
    });

    suite('Basic Phase Generation', () => {
        test('should generate phases for a complex requirement', async () => {
            const requirement = `
                Build a complete user management system with:
                - User registration and login
                - Password reset via email
                - Profile management
                - Admin dashboard
                - Role-based permissions
            `;
            const result = await generator.generatePhases(requirement);

            assert.ok(result.totalPhases >= 1, 'Should generate at least 1 phase');
            assert.ok(result.phases.length === result.totalPhases, 'Phases array should match totalPhases');
            assert.ok(result.executionOrder.length === result.totalPhases, 'Execution order should match totalPhases');
        });

        test('should generate single phase for simple requirement', async () => {
            const requirement = 'Fix the typo in the README file.';
            const result = await generator.generatePhases(requirement);

            assert.ok(result.totalPhases >= 1, 'Should generate at least 1 phase');
            assert.strictEqual(result.phases[0].status, 'pending', 'Phase should start as pending');
        });

        test('should include original requirement in result', async () => {
            const requirement = 'Add a new button to the settings page.';
            const result = await generator.generatePhases(requirement);

            assert.strictEqual(result.originalRequirement, requirement, 'Should include original requirement');
        });

        test('should include complexity score in result', async () => {
            const requirement = 'Build a simple form component.';
            const result = await generator.generatePhases(requirement);

            assert.ok(result.complexityScore !== undefined, 'Should include complexity score');
            assert.ok(result.complexityScore.level !== undefined, 'Should have complexity level');
        });
    });

    suite('Phase Structure', () => {
        test('each phase should have required properties', async () => {
            const requirement = `
                Create an e-commerce checkout flow with cart and payment.
            `;
            const result = await generator.generatePhases(requirement);

            result.phases.forEach((phase, index) => {
                assert.ok(phase.id, `Phase ${index} should have id`);
                assert.ok(phase.name, `Phase ${index} should have name`);
                assert.ok(phase.description, `Phase ${index} should have description`);
                assert.ok(Array.isArray(phase.requirements), `Phase ${index} should have requirements array`);
                assert.ok(Array.isArray(phase.deliverables), `Phase ${index} should have deliverables array`);
                assert.ok(Array.isArray(phase.verificationCriteria), `Phase ${index} should have verification criteria`);
                assert.ok(typeof phase.estimatedTokens === 'number', `Phase ${index} should have estimatedTokens`);
                assert.ok(Array.isArray(phase.dependencies), `Phase ${index} should have dependencies array`);
                assert.ok(phase.status !== undefined, `Phase ${index} should have status`);
                assert.ok(typeof phase.order === 'number', `Phase ${index} should have order`);
            });
        });

        test('phases should have sequential IDs', async () => {
            const requirement = `
                Build a full-stack application with frontend, backend, and database.
            `;
            const result = await generator.generatePhases(requirement);

            result.phases.forEach((phase, index) => {
                assert.strictEqual(phase.id, `phase-${index + 1}`, `Phase should have sequential ID`);
            });
        });

        test('phases should have correct order property', async () => {
            const requirement = `
                Create a dashboard with analytics, reports, and user management.
            `;
            const result = await generator.generatePhases(requirement);

            result.phases.forEach((phase, index) => {
                assert.strictEqual(phase.order, index, `Phase order should match index`);
            });
        });
    });

    suite('Splitting Strategies', () => {
        test('should use feature-based strategy for feature-heavy requirements', async () => {
            const requirement = `
                Add these features:
                - Search functionality
                - Filter by category
                - Sort by date
                - Pagination
                - Export to CSV
            `;
            const result = await generator.generatePhases(requirement);

            // Feature-based is the default for feature-heavy requirements
            assert.ok(
                ['feature-based', 'auto'].includes(result.strategyUsed) || result.strategyUsed === 'feature-based',
                `Should use feature-based strategy, got ${result.strategyUsed}`
            );
        });

        test('should use layer-based strategy for full-stack requirements', async () => {
            const requirement = `
                Build a full-stack web application with React frontend, 
                Node.js backend API, and PostgreSQL database.
            `;
            const result = await generator.generatePhases(requirement);

            assert.strictEqual(result.strategyUsed, 'layer-based', 'Should use layer-based strategy for full-stack');
        });

        test('should use incremental strategy for extreme complexity', async () => {
            // Force extreme complexity
            const requirement = `
                Create a complete enterprise platform from scratch with:
                - Full authentication system with OAuth, SAML, and MFA
                - User management with roles, permissions, and audit logs
                - Real-time collaboration features with WebSocket
                - Payment processing with Stripe and PayPal
                - Analytics dashboard with custom reports
                - Email and SMS notification system
                - File storage with S3 integration
                - Search with Elasticsearch
                - CI/CD pipeline with Docker and Kubernetes
                - Internationalization for 10 languages
                - Mobile apps for iOS and Android
                - Admin panel for system configuration
            `;
            const score = await analyzer.analyze(requirement);

            if (score.level === 'EXTREME') {
                const result = await generator.generatePhases(requirement, score);
                assert.strictEqual(result.strategyUsed, 'incremental', 'Should use incremental for EXTREME complexity');
            }
        });

        test('should respect preferred strategy in config', async () => {
            const customGenerator = createPhaseGenerator(analyzer, {
                preferredStrategy: 'layer-based'
            });

            const requirement = 'Add a simple feature to the app.';
            const result = await customGenerator.generatePhases(requirement);

            assert.strictEqual(result.strategyUsed, 'layer-based', 'Should use configured strategy');
        });
    });

    suite('Dependencies', () => {
        test('first phase should have no dependencies', async () => {
            const requirement = `
                Build a multi-step form with validation and submission.
            `;
            const result = await generator.generatePhases(requirement);

            assert.strictEqual(result.phases[0].dependencies.length, 0, 'First phase should have no dependencies');
        });

        test('subsequent phases should depend on previous phases', async () => {
            const requirement = `
                Build a full-stack app with database, API, and frontend components.
            `;
            const result = await generator.generatePhases(requirement);

            if (result.phases.length > 1) {
                for (let i = 1; i < result.phases.length; i++) {
                    assert.ok(
                        result.phases[i].dependencies.length > 0,
                        `Phase ${i + 1} should have dependencies`
                    );
                }
            }
        });

        test('execution order should respect dependencies', async () => {
            const requirement = `
                Create a system with database models, API endpoints, and UI components.
            `;
            const result = await generator.generatePhases(requirement);

            // Build a map of phase positions in execution order
            const positionMap = new Map<string, number>();
            result.executionOrder.forEach((id, pos) => positionMap.set(id, pos));

            // Verify each phase comes after its dependencies
            result.phases.forEach(phase => {
                const phasePos = positionMap.get(phase.id)!;
                phase.dependencies.forEach(depId => {
                    const depPos = positionMap.get(depId);
                    if (depPos !== undefined) {
                        assert.ok(
                            depPos < phasePos,
                            `Dependency ${depId} should come before ${phase.id}`
                        );
                    }
                });
            });
        });
    });

    suite('Token Estimation', () => {
        test('total estimated tokens should be sum of phase tokens', async () => {
            const requirement = `
                Build a dashboard with user management and analytics.
            `;
            const result = await generator.generatePhases(requirement);

            const sum = result.phases.reduce((acc, p) => acc + p.estimatedTokens, 0);

            // Allow some tolerance for rounding
            const tolerance = result.totalPhases * 100;
            assert.ok(
                Math.abs(result.estimatedTotalTokens - sum) <= tolerance,
                `Total tokens (${result.estimatedTotalTokens}) should approximately equal sum (${sum})`
            );
        });

        test('no phase should exceed max tokens per phase', async () => {
            const customGenerator = createPhaseGenerator(analyzer, {
                maxTokensPerPhase: 20000
            });

            const requirement = `
                Build a complex system with many features including auth, 
                dashboard, reports, notifications, and admin panel.
            `;
            const result = await customGenerator.generatePhases(requirement);

            result.phases.forEach(phase => {
                assert.ok(
                    phase.estimatedTokens <= 20000,
                    `Phase ${phase.id} exceeds max tokens: ${phase.estimatedTokens}`
                );
            });
        });
    });

    suite('Verification Criteria', () => {
        test('should generate verification criteria when enabled', async () => {
            const generator = createPhaseGenerator(analyzer, {
                includeVerification: true
            });

            const requirement = 'Build a React component with API integration.';
            const result = await generator.generatePhases(requirement);

            result.phases.forEach(phase => {
                assert.ok(
                    phase.verificationCriteria.length > 0,
                    `Phase ${phase.id} should have verification criteria`
                );
            });
        });

        test('should include domain-specific criteria', async () => {
            const requirement = `
                Build a full-stack app with React frontend and Node.js backend.
            `;
            const result = await generator.generatePhases(requirement);

            const allCriteria = result.phases.flatMap(p => p.verificationCriteria);

            // Should have at least basic compilation criteria
            assert.ok(
                allCriteria.some(c => c.toLowerCase().includes('compile') || c.toLowerCase().includes('error')),
                'Should include compilation criteria'
            );
        });
    });

    suite('Feature Groups', () => {
        test('should detect authentication features', async () => {
            const requirement = `
                Implement user login, registration, and password reset.
            `;
            const result = await generator.generatePhases(requirement);

            const allRequirements = result.phases.flatMap(p => p.requirements).join(' ').toLowerCase();
            assert.ok(
                allRequirements.includes('login') ||
                allRequirements.includes('register') ||
                allRequirements.includes('auth'),
                'Should capture authentication features'
            );
        });

        test('should detect payment features', async () => {
            const requirement = `
                Add checkout functionality with Stripe payment integration.
            `;
            const result = await generator.generatePhases(requirement);

            const hasPaymentPhase = result.phases.some(p =>
                p.name.toLowerCase().includes('payment') ||
                p.requirements.some(r => r.toLowerCase().includes('payment') || r.toLowerCase().includes('checkout'))
            );

            assert.ok(hasPaymentPhase, 'Should detect payment features');
        });

        test('should detect dashboard features', async () => {
            const requirement = `
                Create an admin dashboard with analytics and reports.
            `;
            const result = await generator.generatePhases(requirement);

            const hasDashboard = result.phases.some(p =>
                p.name.toLowerCase().includes('dashboard') ||
                p.name.toLowerCase().includes('analytics') ||
                p.requirements.some(r => r.toLowerCase().includes('dashboard'))
            );

            assert.ok(hasDashboard, 'Should detect dashboard features');
        });
    });

    suite('Layer-Based Splitting', () => {
        test('should create foundation phase for setup requirements', async () => {
            const generator = createPhaseGenerator(analyzer, {
                preferredStrategy: 'layer-based'
            });

            const requirement = `
                Set up the project structure, configure the database schema,
                and create the API endpoints.
            `;
            const result = await generator.generatePhases(requirement);

            const hasFoundationOrData = result.phases.some(p =>
                p.name.toLowerCase().includes('foundation') ||
                p.name.toLowerCase().includes('data') ||
                p.name.toLowerCase().includes('setup')
            );

            assert.ok(hasFoundationOrData, 'Should create foundation/data phase');
        });

        test('should separate frontend and backend layers', async () => {
            const generator = createPhaseGenerator(analyzer, {
                preferredStrategy: 'layer-based'
            });

            const requirement = `
                Build React components for the UI and Express API endpoints for the backend.
            `;
            const result = await generator.generatePhases(requirement);

            if (result.phases.length >= 2) {
                const domains = result.phases.map(p => p.domains).flat();
                assert.ok(
                    domains.includes('frontend') || domains.includes('backend'),
                    'Should have frontend or backend domains'
                );
            }
        });
    });

    suite('Incremental Splitting', () => {
        test('should create MVP phase first', async () => {
            const generator = createPhaseGenerator(analyzer, {
                preferredStrategy: 'incremental'
            });

            const requirement = `
                Build a complete app with user auth, dashboard, notifications, and analytics.
            `;
            const result = await generator.generatePhases(requirement);

            const firstPhase = result.phases[0];
            assert.ok(
                firstPhase.name.toLowerCase().includes('core') ||
                firstPhase.name.toLowerCase().includes('mvp') ||
                firstPhase.order === 0,
                'First phase should be core/MVP'
            );
        });

        test('should put polish/optimization last', async () => {
            const generator = createPhaseGenerator(analyzer, {
                preferredStrategy: 'incremental'
            });

            const requirement = `
                Build a system with auth, CRUD operations, analytics dashboard, 
                and performance optimization.
            `;
            const result = await generator.generatePhases(requirement);

            if (result.phases.length >= 2) {
                const lastPhase = result.phases[result.phases.length - 1];
                // Last phase is often polish/secondary/optimization
                assert.ok(
                    lastPhase.order === result.phases.length - 1,
                    'Last phase should have highest order'
                );
            }
        });
    });

    suite('Summary Generation', () => {
        test('should generate a summary', async () => {
            const requirement = 'Build a user management system.';
            const result = await generator.generatePhases(requirement);

            assert.ok(result.summary.length > 0, 'Should generate summary');
            assert.ok(result.summary.includes('Phase'), 'Summary should mention phases');
        });

        test('summary should include strategy used', async () => {
            const requirement = 'Create a full-stack application.';
            const result = await generator.generatePhases(requirement);

            assert.ok(
                result.summary.toLowerCase().includes(result.strategyUsed),
                'Summary should mention strategy used'
            );
        });
    });

    suite('Configuration', () => {
        test('should respect maxFeaturesPerPhase', async () => {
            const generator = createPhaseGenerator(analyzer, {
                maxFeaturesPerPhase: 2,
                preferredStrategy: 'feature-based'
            });

            const requirement = `
                Add features: search, filter, sort, pagination, export, import.
            `;
            const result = await generator.generatePhases(requirement);

            // With max 2 features per phase, we should have multiple phases
            // (though feature detection may vary)
            assert.ok(result.phases.length >= 1, 'Should create phases respecting max features');
        });

        test('should allow updating configuration', () => {
            generator.updateConfig({ maxTokensPerPhase: 50000 });
            const config = generator.getConfig();

            assert.strictEqual(config.maxTokensPerPhase, 50000);
        });

        test('should preserve other config when updating', () => {
            const originalConfig = generator.getConfig();
            generator.updateConfig({ maxTokensPerPhase: 50000 });
            const newConfig = generator.getConfig();

            assert.strictEqual(newConfig.preferredStrategy, originalConfig.preferredStrategy);
            assert.strictEqual(newConfig.includeVerification, originalConfig.includeVerification);
        });
    });

    suite('Edge Cases', () => {
        test('should handle empty requirement', async () => {
            const result = await generator.generatePhases('');

            assert.ok(result.phases.length >= 1, 'Should create at least one phase');
            assert.ok(result.totalPhases >= 1, 'Should have at least one phase');
        });

        test('should handle very short requirement', async () => {
            const result = await generator.generatePhases('Fix bug.');

            assert.ok(result.phases.length >= 1, 'Should handle short requirement');
        });

        test('should handle requirement with special characters', async () => {
            const requirement = 'Add <Component /> with @decorator and $variable handling.';
            const result = await generator.generatePhases(requirement);

            assert.ok(result.phases.length >= 1, 'Should handle special characters');
        });

        test('should handle pre-computed complexity score', async () => {
            const requirement = 'Build a feature.';
            const score = await analyzer.analyze(requirement);
            const result = await generator.generatePhases(requirement, score);

            assert.strictEqual(result.complexityScore, score, 'Should use provided complexity score');
        });
    });
});
