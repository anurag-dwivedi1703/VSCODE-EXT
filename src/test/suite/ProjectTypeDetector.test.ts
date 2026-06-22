/**
 * Unit tests for ProjectTypeDetector service
 * 
 * Tests the UI detection logic and project type classification
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import {
    ProjectTypeDetector,
    ProjectTypeDetectionResult,
    detectProjectType,
    shouldRequireBrowserTesting,
    BrowserTestingSetting
} from '../../services/ProjectTypeDetector';

suite('ProjectTypeDetector Test Suite', () => {
    let tempDir: string;

    setup(async () => {
        // Create a temporary directory for each test
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-type-detector-test-'));
    });

    teardown(async () => {
        // Clean up temporary directory
        if (tempDir && await fs.pathExists(tempDir)) {
            await fs.remove(tempDir);
        }
        // Clear the cache
        ProjectTypeDetector.clearCache();
    });

    suite('React Project Detection', () => {
        test('should detect React project from package.json', async () => {
            // Setup: Create package.json with React dependency
            const pkg = {
                name: 'test-react-app',
                dependencies: {
                    'react': '^18.0.0',
                    'react-dom': '^18.0.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, true, 'Should detect UI presence');
            assert.strictEqual(result.projectType, 'frontend', 'Should classify as frontend');
            assert.ok(result.detectedIndicators.some(i => i.includes('react')), 'Should include react in indicators');
            assert.strictEqual(result.browserTestingRecommended, true, 'Should recommend browser testing');
        });

        test('should detect React project with high confidence when config files present', async () => {
            // Setup: Create package.json and vite config
            const pkg = {
                name: 'test-react-vite',
                dependencies: {
                    'react': '^18.0.0'
                },
                devDependencies: {
                    'vite': '^5.0.0',
                    '@vitejs/plugin-react': '^4.0.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);
            await fs.writeFile(path.join(tempDir, 'vite.config.ts'), 'export default {}');

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, true);
            assert.strictEqual(result.confidence, 'high', 'Should have high confidence');
        });
    });

    suite('Vue Project Detection', () => {
        test('should detect Vue project from package.json', async () => {
            const pkg = {
                name: 'test-vue-app',
                dependencies: {
                    'vue': '^3.0.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, true);
            assert.ok(result.detectedIndicators.some(i => i.includes('vue')));
        });
    });

    suite('Backend-Only Project Detection', () => {
        test('should detect Express-only project as backend without UI', async () => {
            const pkg = {
                name: 'test-express-api',
                dependencies: {
                    'express': '^4.18.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, false, 'Should not detect UI');
            assert.strictEqual(result.projectType, 'backend', 'Should classify as backend');
            assert.strictEqual(result.browserTestingRecommended, false, 'Should not recommend browser testing');
        });

        test('should detect Fastify-only project as backend without UI', async () => {
            const pkg = {
                name: 'test-fastify-api',
                dependencies: {
                    'fastify': '^4.0.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, false);
            assert.strictEqual(result.projectType, 'backend');
        });

        test('should detect NestJS project as backend', async () => {
            const pkg = {
                name: 'test-nestjs-api',
                dependencies: {
                    '@nestjs/core': '^10.0.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, false);
            assert.strictEqual(result.projectType, 'backend');
        });
    });

    suite('CLI Project Detection', () => {
        test('should detect CLI project with commander', async () => {
            const pkg = {
                name: 'test-cli-tool',
                bin: {
                    'mycli': './bin/cli.js'
                },
                dependencies: {
                    'commander': '^11.0.0',
                    'chalk': '^5.0.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, false);
            assert.strictEqual(result.projectType, 'cli');
            assert.strictEqual(result.browserTestingRecommended, false);
        });
    });

    suite('Library Project Detection', () => {
        test('should detect library project with types and lib exports', async () => {
            const pkg = {
                name: 'test-library',
                main: './lib/index.js',
                types: './lib/index.d.ts'
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, false);
            assert.strictEqual(result.projectType, 'library');
        });
    });

    suite('Fullstack Project Detection', () => {
        test('should detect fullstack project with React and Express', async () => {
            const pkg = {
                name: 'test-fullstack',
                dependencies: {
                    'react': '^18.0.0',
                    'react-dom': '^18.0.0',
                    'express': '^4.18.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, true, 'Fullstack should have UI');
            assert.strictEqual(result.projectType, 'fullstack');
            assert.strictEqual(result.browserTestingRecommended, true);
        });
    });

    suite('Empty/Unknown Project Detection', () => {
        test('should return unknown with low confidence for empty project', async () => {
            // No files created, empty directory
            const detector = new ProjectTypeDetector({ workspacePath: tempDir });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, false);
            assert.strictEqual(result.projectType, 'unknown');
            assert.strictEqual(result.confidence, 'low');
        });
    });

    suite('Constitution Override', () => {
        test('should respect "disabled" constitution setting', async () => {
            // Setup: Create a React project
            const pkg = {
                name: 'test-react-app',
                dependencies: {
                    'react': '^18.0.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ 
                workspacePath: tempDir,
                constitutionSetting: 'disabled'
            });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, true, 'Should still detect UI');
            assert.strictEqual(result.browserTestingRecommended, false, 'Should not recommend browser testing due to constitution');
        });

        test('should respect "required" constitution setting for backend project', async () => {
            const pkg = {
                name: 'test-express-api',
                dependencies: {
                    'express': '^4.18.0'
                }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector = new ProjectTypeDetector({ 
                workspacePath: tempDir,
                constitutionSetting: 'required'
            });
            const result = await detector.detect();

            assert.strictEqual(result.hasUI, false, 'Should detect no UI');
            assert.strictEqual(result.browserTestingRecommended, true, 'Should recommend browser testing due to constitution override');
        });
    });

    suite('shouldRequireBrowserTesting utility', () => {
        test('should require browser testing for UI project without override', () => {
            const result: ProjectTypeDetectionResult = {
                hasUI: true,
                confidence: 'high',
                detectedIndicators: ['react'],
                projectType: 'frontend',
                recommendedVerification: ['browser_testing'],
                browserTestingRecommended: true
            };

            assert.strictEqual(shouldRequireBrowserTesting(result), true);
        });

        test('should not require browser testing for non-UI project', () => {
            const result: ProjectTypeDetectionResult = {
                hasUI: false,
                confidence: 'high',
                detectedIndicators: ['express'],
                projectType: 'backend',
                recommendedVerification: ['api_testing', 'unit_tests'],
                browserTestingRecommended: false
            };

            assert.strictEqual(shouldRequireBrowserTesting(result), false);
        });

        test('should override with "required" setting', () => {
            const result: ProjectTypeDetectionResult = {
                hasUI: false,
                confidence: 'high',
                detectedIndicators: ['express'],
                projectType: 'backend',
                recommendedVerification: ['api_testing'],
                browserTestingRecommended: false
            };

            assert.strictEqual(shouldRequireBrowserTesting(result, 'required'), true);
        });

        test('should override with "disabled" setting', () => {
            const result: ProjectTypeDetectionResult = {
                hasUI: true,
                confidence: 'high',
                detectedIndicators: ['react'],
                projectType: 'frontend',
                recommendedVerification: ['browser_testing'],
                browserTestingRecommended: true
            };

            assert.strictEqual(shouldRequireBrowserTesting(result, 'disabled'), false);
        });
    });

    suite('Summary and Suggestion Methods', () => {
        test('getSummary should return readable message', () => {
            const result: ProjectTypeDetectionResult = {
                hasUI: true,
                confidence: 'high',
                detectedIndicators: ['react'],
                projectType: 'frontend',
                recommendedVerification: ['browser_testing'],
                browserTestingRecommended: true
            };

            const summary = ProjectTypeDetector.getSummary(result);
            assert.ok(summary.includes('Frontend Application'));
            assert.ok(summary.includes('high'));
            assert.ok(summary.includes('required'));
        });

        test('getLowConfidenceSuggestion should return suggestion for low confidence', () => {
            const result: ProjectTypeDetectionResult = {
                hasUI: false,
                confidence: 'low',
                detectedIndicators: [],
                projectType: 'unknown',
                recommendedVerification: ['build_verification'],
                browserTestingRecommended: false
            };

            const suggestion = ProjectTypeDetector.getLowConfidenceSuggestion(result);
            assert.ok(suggestion !== null);
            assert.ok(suggestion!.includes('constitution.md'));
        });

        test('getLowConfidenceSuggestion should return null for high confidence', () => {
            const result: ProjectTypeDetectionResult = {
                hasUI: true,
                confidence: 'high',
                detectedIndicators: ['react'],
                projectType: 'frontend',
                recommendedVerification: ['browser_testing'],
                browserTestingRecommended: true
            };

            const suggestion = ProjectTypeDetector.getLowConfidenceSuggestion(result);
            assert.strictEqual(suggestion, null);
        });
    });

    suite('Caching', () => {
        test('should cache detection results', async () => {
            const pkg = {
                name: 'test-cache',
                dependencies: { 'react': '^18.0.0' }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector1 = new ProjectTypeDetector({ workspacePath: tempDir });
            const result1 = await detector1.detect();

            // Second detection should use cache
            const detector2 = new ProjectTypeDetector({ workspacePath: tempDir });
            const result2 = await detector2.detect();

            assert.deepStrictEqual(result1, result2);
        });

        test('should clear cache when requested', async () => {
            const pkg = {
                name: 'test-cache-clear',
                dependencies: { 'react': '^18.0.0' }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg);

            const detector1 = new ProjectTypeDetector({ workspacePath: tempDir });
            await detector1.detect();

            // Clear cache
            ProjectTypeDetector.clearCache(tempDir);

            // Update package.json
            const pkg2 = {
                name: 'test-cache-clear',
                dependencies: { 'express': '^4.18.0' }
            };
            await fs.writeJson(path.join(tempDir, 'package.json'), pkg2);

            // Should get fresh result
            const detector2 = new ProjectTypeDetector({ workspacePath: tempDir });
            const result2 = await detector2.detect();

            assert.strictEqual(result2.hasUI, false);
            assert.strictEqual(result2.projectType, 'backend');
        });
    });
});
