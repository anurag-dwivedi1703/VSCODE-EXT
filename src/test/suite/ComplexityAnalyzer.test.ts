/**
 * Unit tests for ComplexityAnalyzer service
 * 
 * Tests the complexity scoring algorithm with various requirement types
 */

import * as assert from 'assert';
import {
    ComplexityAnalyzer,
    createComplexityAnalyzer,
    ComplexityLevel
} from '../../services/ComplexityAnalyzer';

suite('ComplexityAnalyzer Test Suite', () => {
    let analyzer: ComplexityAnalyzer;

    setup(() => {
        analyzer = createComplexityAnalyzer();
    });

    suite('Basic Analysis', () => {
        test('should analyze a simple requirement as LOW complexity', async () => {
            const requirement = 'Fix the typo in the README file.';
            const result = await analyzer.analyze(requirement);

            assert.strictEqual(result.level, 'LOW');
            assert.strictEqual(result.recommendation, 'PROCEED');
            assert.ok(result.score <= 20, `Score ${result.score} should be <= 20 for LOW`);
        });

        test('should analyze a medium requirement correctly', async () => {
            const requirement = `
                Add a new button to the settings page that allows users to export their data.
                The button should trigger a download of a JSON file containing user preferences.
            `;
            const result = await analyzer.analyze(requirement);

            assert.ok(['LOW', 'MEDIUM'].includes(result.level), `Level should be LOW or MEDIUM, got ${result.level}`);
            assert.ok(result.metrics.featureCount >= 1, 'Should detect at least 1 feature');
        });

        test('should analyze a complex requirement as HIGH', async () => {
            const requirement = `
                Build a complete authentication system with:
                - User registration with email verification
                - Login with password and OAuth (Google, GitHub)
                - Password reset functionality
                - Session management
                - Role-based access control
                - Admin dashboard to manage users
            `;
            const result = await analyzer.analyze(requirement);

            assert.ok(['HIGH', 'EXTREME'].includes(result.level), `Level should be HIGH or EXTREME, got ${result.level}`);
            assert.strictEqual(result.recommendation, 'SPLIT_PHASES');
            assert.ok(result.metrics.featureCount >= 4, `Should detect multiple features, got ${result.metrics.featureCount}`);
        });

        test('should analyze an extreme requirement correctly', async () => {
            const requirement = `
                Create a complete full-stack e-commerce platform from scratch with:
                - User authentication and authorization
                - Product catalog with categories and search
                - Shopping cart and checkout
                - Payment integration (Stripe, PayPal)
                - Order management and tracking
                - Admin dashboard for inventory
                - Real-time notifications
                - Mobile-responsive design
                - Database migration from legacy system
                - CI/CD pipeline setup
                - Performance optimization
                - Internationalization support
            `;
            const result = await analyzer.analyze(requirement);

            assert.strictEqual(result.level, 'EXTREME');
            assert.ok(
                result.recommendation === 'SPLIT_PHASES' || result.recommendation === 'REQUIRE_CLARIFICATION',
                `Should recommend SPLIT_PHASES or REQUIRE_CLARIFICATION, got ${result.recommendation}`
            );
            assert.ok(result.suggestedPhaseCount !== undefined, 'Should suggest phase count');
            assert.ok(result.suggestedPhaseCount! >= 3, `Should suggest at least 3 phases, got ${result.suggestedPhaseCount}`);
        });
    });

    suite('Feature Extraction', () => {
        test('should extract features from bullet points', async () => {
            const requirement = `
                - Create user profile page
                - Add settings panel
                - Implement notifications
            `;
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.featureCount >= 3, `Should extract at least 3 features, got ${result.metrics.featureCount}`);
        });

        test('should extract features from numbered lists', async () => {
            const requirement = `
                1. Build login form
                2. Create registration flow
                3. Add password reset
            `;
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.featureCount >= 3, `Should extract at least 3 features, got ${result.metrics.featureCount}`);
        });

        test('should extract features from action verbs', async () => {
            const requirement = 'Implement a search bar, create a filter component, and add sorting functionality.';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.featureCount >= 2, `Should extract at least 2 features, got ${result.metrics.featureCount}`);
        });
    });

    suite('Scope Indicator Detection', () => {
        test('should detect full-stack scope', async () => {
            const requirement = 'Build a full-stack application with React and Node.js';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.scopeIndicators.includes('full-stack'), 'Should detect full-stack indicator');
            assert.ok(result.score >= 15, 'Full-stack should add significant points');
        });

        test('should detect complete app scope', async () => {
            const requirement = 'Create a complete application for task management';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.scopeIndicators.includes('complete-app'), 'Should detect complete-app indicator');
        });

        test('should detect from-scratch scope', async () => {
            const requirement = 'Build the system from scratch with new architecture';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.scopeIndicators.includes('from-scratch'), 'Should detect from-scratch indicator');
        });

        test('should detect dashboard scope', async () => {
            const requirement = 'Create an admin dashboard for user management';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.scopeIndicators.includes('dashboard'), 'Should detect dashboard indicator');
        });

        test('should detect real-time scope', async () => {
            const requirement = 'Add real-time updates using websockets';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.scopeIndicators.includes('real-time'), 'Should detect real-time indicator');
        });
    });

    suite('Risk Factor Detection', () => {
        test('should detect database migration risk', async () => {
            const requirement = 'Migrate the database schema to support new features';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.riskFactors.includes('database-migration'), 'Should detect database-migration risk');
        });

        test('should detect major refactor risk', async () => {
            const requirement = 'Refactor the entire authentication module';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.riskFactors.includes('major-refactor'), 'Should detect major-refactor risk');
        });

        test('should detect security concerns', async () => {
            const requirement = 'Implement OAuth2 authentication with JWT tokens';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.riskFactors.includes('security-concerns'), 'Should detect security-concerns risk');
        });

        test('should detect deployment/infra concerns', async () => {
            const requirement = 'Set up CI/CD pipeline with Docker and Kubernetes';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.riskFactors.includes('deployment-infra'), 'Should detect deployment-infra risk');
        });

        test('should detect legacy concerns', async () => {
            const requirement = 'Update the legacy code to be backward compatible';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.riskFactors.includes('legacy-concerns'), 'Should detect legacy-concerns risk');
        });
    });

    suite('Technical Domain Detection', () => {
        test('should detect frontend domain', async () => {
            const requirement = 'Build a React component for the user profile';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.technicalDomains.includes('frontend'), 'Should detect frontend domain');
        });

        test('should detect backend domain', async () => {
            const requirement = 'Create an Express API endpoint for user data';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.technicalDomains.includes('backend'), 'Should detect backend domain');
        });

        test('should detect database domain', async () => {
            const requirement = 'Add PostgreSQL queries for the reporting feature';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.technicalDomains.includes('database'), 'Should detect database domain');
        });

        test('should detect multiple domains', async () => {
            const requirement = 'Build a React frontend with Node.js backend and PostgreSQL database';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.metrics.technicalDomains.length >= 2, `Should detect multiple domains, got ${result.metrics.technicalDomains.length}`);
        });
    });

    suite('Token Estimation', () => {
        test('should estimate more tokens for complex requirements', async () => {
            const simple = 'Fix a typo in the config file.';
            const complex = `
                Build a complete authentication system with registration, login, 
                password reset, OAuth integration, and admin dashboard.
            `;

            const simpleResult = await analyzer.analyze(simple);
            const complexResult = await analyzer.analyze(complex);

            assert.ok(
                complexResult.estimatedTokens > simpleResult.estimatedTokens,
                'Complex requirement should estimate more tokens'
            );
        });

        test('should suggest phases when tokens exceed budget', async () => {
            const largeRequirement = `
                Create a complete e-commerce platform with:
                - Full authentication system
                - Product catalog with categories
                - Shopping cart functionality
                - Checkout with payment integration
                - Order management
                - Admin dashboard
                - Email notifications
                - Search and filtering
            `;
            const result = await analyzer.analyze(largeRequirement);

            if (result.recommendation === 'SPLIT_PHASES') {
                assert.ok(result.suggestedPhaseCount !== undefined, 'Should suggest phase count');
                assert.ok(result.suggestedPhaseCount! >= 2, 'Should suggest at least 2 phases');
            }
        });
    });

    suite('Recommendations', () => {
        test('should recommend PROCEED for simple tasks', async () => {
            const requirement = 'Update the button color to blue.';
            const result = await analyzer.analyze(requirement);

            assert.strictEqual(result.recommendation, 'PROCEED');
        });

        test('should recommend SPLIT_PHASES for large tasks', async () => {
            const requirement = `
                Build a full-stack dashboard application with user authentication,
                real-time data visualization, admin panel, and database integration.
            `;
            const result = await analyzer.analyze(requirement);

            assert.strictEqual(result.recommendation, 'SPLIT_PHASES');
        });

        test('should include explanation in result', async () => {
            const requirement = 'Add a new feature to the settings page.';
            const result = await analyzer.analyze(requirement);

            assert.ok(result.explanation.length > 0, 'Should include explanation');
            assert.ok(result.explanation.includes('Complexity Score'), 'Explanation should include score');
        });
    });

    suite('Configuration', () => {
        test('should respect custom thresholds', async () => {
            const customAnalyzer = createComplexityAnalyzer({
                lowThreshold: 10,
                mediumThreshold: 20,
                highThreshold: 30
            });

            const requirement = 'Add three new features: search, filter, and sort.';
            const result = await customAnalyzer.analyze(requirement);

            // With lower thresholds, same requirement should be rated higher
            const defaultResult = await analyzer.analyze(requirement);

            // Custom analyzer should rate same or higher complexity level
            const levels: ComplexityLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'];
            const customIndex = levels.indexOf(result.level);
            const defaultIndex = levels.indexOf(defaultResult.level);

            assert.ok(customIndex >= defaultIndex, 'Custom thresholds should affect level classification');
        });

        test('should allow updating configuration', () => {
            analyzer.updateConfig({ tokensPerPhase: 50000 });
            const config = analyzer.getConfig();

            assert.strictEqual(config.tokensPerPhase, 50000);
        });

        test('should preserve other config when updating', () => {
            const originalConfig = analyzer.getConfig();
            analyzer.updateConfig({ tokensPerPhase: 50000 });
            const newConfig = analyzer.getConfig();

            assert.strictEqual(newConfig.lowThreshold, originalConfig.lowThreshold);
            assert.strictEqual(newConfig.mediumThreshold, originalConfig.mediumThreshold);
        });
    });

    suite('Edge Cases', () => {
        test('should handle empty requirement', async () => {
            const result = await analyzer.analyze('');

            assert.strictEqual(result.level, 'LOW');
            assert.strictEqual(result.score, 0);
            assert.strictEqual(result.recommendation, 'PROCEED');
        });

        test('should handle very long requirement', async () => {
            const longRequirement = 'Add feature. '.repeat(500);
            const result = await analyzer.analyze(longRequirement);

            // Should not crash and should cap score at 100
            assert.ok(result.score <= 100, 'Score should be capped at 100');
        });

        test('should handle special characters', async () => {
            const requirement = 'Fix bug in <Component /> with @decorator and $variable';
            const result = await analyzer.analyze(requirement);

            // Should not crash
            assert.ok(result.level !== undefined, 'Should produce a valid result');
        });

        test('should handle context files parameter', async () => {
            const requirement = 'Update the configuration';
            const contextFiles = ['src/config.ts', 'src/settings.ts', 'src/utils.ts'];
            const result = await analyzer.analyze(requirement, contextFiles);

            // Context files should slightly increase estimated file count
            const resultWithoutContext = await analyzer.analyze(requirement);
            assert.ok(
                result.metrics.estimatedFileCount >= resultWithoutContext.metrics.estimatedFileCount,
                'Context files should not decrease estimated file count'
            );
        });
    });
});
