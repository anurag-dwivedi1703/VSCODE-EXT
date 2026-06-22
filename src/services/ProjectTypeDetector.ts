/**
 * ProjectTypeDetector - Detects whether a project requires browser-based UI testing
 * 
 * This service analyzes the workspace to determine if it contains UI components
 * that would benefit from browser-based automated testing. It provides:
 * - File pattern detection for frontend frameworks
 * - Package.json dependency analysis
 * - Build configuration detection
 * - Confidence-scored results for decision making
 * 
 * Part of the Conditional Browser Testing system.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';

/**
 * Confidence level for UI detection
 */
export type DetectionConfidence = 'high' | 'medium' | 'low';

/**
 * Verification methods available based on project type
 */
export type VerificationMethod = 
    | 'browser_testing'
    | 'api_testing'
    | 'unit_tests'
    | 'build_verification'
    | 'lint_check';

/**
 * Project type classification
 */
export type ProjectType = 'frontend' | 'backend' | 'fullstack' | 'library' | 'cli' | 'unknown';

/**
 * Result of project type detection
 */
export interface ProjectTypeDetectionResult {
    /** Whether the project has UI components */
    hasUI: boolean;
    /** Confidence level of the detection */
    confidence: DetectionConfidence;
    /** Indicators that led to this detection */
    detectedIndicators: string[];
    /** Classified project type */
    projectType: ProjectType;
    /** Recommended verification methods based on project type */
    recommendedVerification: VerificationMethod[];
    /** Whether browser testing is recommended */
    browserTestingRecommended: boolean;
}

/**
 * Browser testing requirement from constitution
 */
export type BrowserTestingSetting = 'required' | 'optional' | 'disabled';

/**
 * Configuration for the detector
 */
export interface ProjectTypeDetectorConfig {
    /** Workspace root path */
    workspacePath: string;
    /** Constitution browser testing setting (if specified) */
    constitutionSetting?: BrowserTestingSetting;
    /** Maximum files to scan (for performance) */
    maxFilesToScan?: number;
}

// UI-indicating file patterns
const UI_FILE_PATTERNS = [
    '**/*.tsx',
    '**/*.jsx',
    '**/*.vue',
    '**/*.svelte',
    '**/index.html',
    'src/**/*.html',
    'public/**/*.html',
    'app/**/*.html',
];

// Style file patterns (supporting evidence)
const STYLE_FILE_PATTERNS = [
    '**/*.css',
    '**/*.scss',
    '**/*.sass',
    '**/*.less',
    '**/tailwind.config.*',
    '**/postcss.config.*',
];

// Frontend framework dependencies
const FRONTEND_DEPENDENCIES = [
    'react',
    'react-dom',
    'vue',
    'angular',
    '@angular/core',
    '@angular/common',
    'svelte',
    'next',
    'nuxt',
    'gatsby',
    'solid-js',
    '@solidjs/router',
    'preact',
    'lit',
    'lit-element',
    'ember-source',
    '@ember/core',
    'backbone',
    'alpinejs',
    'stimulus',
    '@hotwired/stimulus',
    'htmx.org',
];

// Build tool dependencies indicating frontend
const FRONTEND_BUILD_TOOLS = [
    'vite',
    'webpack',
    '@vitejs/plugin-react',
    '@vitejs/plugin-vue',
    '@sveltejs/vite-plugin-svelte',
    'parcel',
    'esbuild',
    'rollup',
    'snowpack',
    'create-react-app',
    'react-scripts',
];

// Frontend config files
const FRONTEND_CONFIG_FILES = [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'webpack.config.js',
    'webpack.config.ts',
    'next.config.js',
    'next.config.mjs',
    'nuxt.config.js',
    'nuxt.config.ts',
    'svelte.config.js',
    'angular.json',
    'gatsby-config.js',
    'gatsby-config.ts',
    'remix.config.js',
    'astro.config.mjs',
];

// Backend-only dependencies (no UI)
const BACKEND_ONLY_DEPENDENCIES = [
    'express',
    'fastify',
    'koa',
    'hapi',
    '@hapi/hapi',
    'hono',
    'restify',
    'nestjs',
    '@nestjs/core',
    'fastapi', // Python, but might be in package.json scripts
    'flask',
    'django',
];

// CLI-related dependencies
const CLI_DEPENDENCIES = [
    'commander',
    'yargs',
    'inquirer',
    'prompts',
    'chalk',
    'ora',
    'meow',
    'cac',
    'clipanion',
    'oclif',
    '@oclif/core',
    'arg',
    'minimist',
];

// Library indicators (main export patterns)
const LIBRARY_INDICATORS = [
    'types', // TypeScript types package
    'dist',
    'lib',
];

/**
 * Cache for detection results to avoid redundant scans
 */
const detectionCache = new Map<string, { result: ProjectTypeDetectionResult; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * ProjectTypeDetector - Analyzes workspace to determine project type and UI presence
 */
export class ProjectTypeDetector {
    private workspacePath: string;
    private constitutionSetting?: BrowserTestingSetting;
    private maxFilesToScan: number;

    constructor(config: ProjectTypeDetectorConfig) {
        this.workspacePath = config.workspacePath;
        this.constitutionSetting = config.constitutionSetting;
        this.maxFilesToScan = config.maxFilesToScan || 10000;
    }

    /**
     * Detect project type and UI presence
     * Returns cached result if available and fresh
     */
    async detect(): Promise<ProjectTypeDetectionResult> {
        const cacheKey = this.workspacePath;
        const cached = detectionCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
            console.log(`[ProjectTypeDetector] Using cached result for ${cacheKey}`);
            return cached.result;
        }

        console.log(`[ProjectTypeDetector] Analyzing workspace: ${this.workspacePath}`);
        const startTime = Date.now();

        const result = await this.analyzeWorkspace();

        const elapsed = Date.now() - startTime;
        console.log(`[ProjectTypeDetector] Analysis completed in ${elapsed}ms`);
        console.log(`[ProjectTypeDetector] Result: hasUI=${result.hasUI}, confidence=${result.confidence}, type=${result.projectType}`);
        console.log(`[ProjectTypeDetector] Indicators: ${result.detectedIndicators.join(', ')}`);

        // Cache the result
        detectionCache.set(cacheKey, { result, timestamp: Date.now() });

        return result;
    }

    /**
     * Clear cached detection result for a workspace
     */
    static clearCache(workspacePath?: string): void {
        if (workspacePath) {
            detectionCache.delete(workspacePath);
        } else {
            detectionCache.clear();
        }
    }

    /**
     * Analyze the workspace to determine project type
     */
    private async analyzeWorkspace(): Promise<ProjectTypeDetectionResult> {
        const indicators: string[] = [];
        let uiScore = 0;
        let backendScore = 0;
        let cliScore = 0;
        let libraryScore = 0;

        // 1. Check package.json dependencies
        const pkgAnalysis = await this.analyzePackageJson();
        indicators.push(...pkgAnalysis.indicators);
        uiScore += pkgAnalysis.uiScore;
        backendScore += pkgAnalysis.backendScore;
        cliScore += pkgAnalysis.cliScore;
        libraryScore += pkgAnalysis.libraryScore;

        // 2. Check for frontend config files
        const configAnalysis = await this.analyzeFrontendConfigs();
        indicators.push(...configAnalysis.indicators);
        uiScore += configAnalysis.uiScore;

        // 3. Check for UI file patterns
        const fileAnalysis = await this.analyzeFilePatterns();
        indicators.push(...fileAnalysis.indicators);
        uiScore += fileAnalysis.uiScore;

        // 4. Check for style files (supporting evidence)
        const styleAnalysis = await this.analyzeStyleFiles();
        indicators.push(...styleAnalysis.indicators);
        uiScore += styleAnalysis.uiScore;

        // 5. Check for Python/other backend frameworks
        const otherBackendAnalysis = await this.analyzeOtherBackendIndicators();
        indicators.push(...otherBackendAnalysis.indicators);
        backendScore += otherBackendAnalysis.backendScore;

        // Determine project type and confidence
        const { projectType, hasUI, confidence } = this.classifyProject(
            uiScore, 
            backendScore, 
            cliScore, 
            libraryScore,
            indicators
        );

        // Determine recommended verification methods
        const recommendedVerification = this.getRecommendedVerification(
            projectType, 
            hasUI, 
            backendScore > 0
        );

        // Determine if browser testing is recommended
        const browserTestingRecommended = this.isBrowserTestingRecommended(
            hasUI, 
            confidence, 
            this.constitutionSetting
        );

        return {
            hasUI,
            confidence,
            detectedIndicators: indicators,
            projectType,
            recommendedVerification,
            browserTestingRecommended,
        };
    }

    /**
     * Analyze package.json for dependencies
     */
    private async analyzePackageJson(): Promise<{
        indicators: string[];
        uiScore: number;
        backendScore: number;
        cliScore: number;
        libraryScore: number;
    }> {
        const indicators: string[] = [];
        let uiScore = 0;
        let backendScore = 0;
        let cliScore = 0;
        let libraryScore = 0;

        const pkgPath = path.join(this.workspacePath, 'package.json');
        
        if (!await fs.pathExists(pkgPath)) {
            return { indicators, uiScore, backendScore, cliScore, libraryScore };
        }

        try {
            const pkg = await fs.readJson(pkgPath);
            const allDeps = {
                ...pkg.dependencies,
                ...pkg.devDependencies,
            };

            // Check frontend dependencies
            for (const dep of FRONTEND_DEPENDENCIES) {
                if (allDeps[dep]) {
                    indicators.push(`package.json: ${dep}`);
                    uiScore += 3; // High weight for framework dependencies
                }
            }

            // Check frontend build tools
            for (const tool of FRONTEND_BUILD_TOOLS) {
                if (allDeps[tool]) {
                    indicators.push(`package.json: ${tool} (build tool)`);
                    uiScore += 2;
                }
            }

            // Check backend-only dependencies
            for (const dep of BACKEND_ONLY_DEPENDENCIES) {
                if (allDeps[dep]) {
                    indicators.push(`package.json: ${dep} (backend)`);
                    backendScore += 2;
                }
            }

            // Check CLI dependencies
            for (const dep of CLI_DEPENDENCIES) {
                if (allDeps[dep]) {
                    indicators.push(`package.json: ${dep} (CLI)`);
                    cliScore += 2;
                }
            }

            // Check for bin entries (CLI indicator)
            if (pkg.bin) {
                indicators.push('package.json: has bin entry (CLI)');
                cliScore += 3;
            }

            // Check main entry for library patterns
            if (pkg.main) {
                for (const pattern of LIBRARY_INDICATORS) {
                    if (pkg.main.includes(pattern)) {
                        indicators.push(`package.json: main points to ${pattern}/ (library)`);
                        libraryScore += 2;
                    }
                }
            }

            // Check for types field (library indicator)
            if (pkg.types || pkg.typings) {
                indicators.push('package.json: has types field (library)');
                libraryScore += 1;
            }

        } catch (error) {
            console.error('[ProjectTypeDetector] Error reading package.json:', error);
        }

        return { indicators, uiScore, backendScore, cliScore, libraryScore };
    }

    /**
     * Check for frontend configuration files
     */
    private async analyzeFrontendConfigs(): Promise<{
        indicators: string[];
        uiScore: number;
    }> {
        const indicators: string[] = [];
        let uiScore = 0;

        for (const configFile of FRONTEND_CONFIG_FILES) {
            const configPath = path.join(this.workspacePath, configFile);
            if (await fs.pathExists(configPath)) {
                indicators.push(`config: ${configFile}`);
                uiScore += 3; // High weight for config files
            }
        }

        return { indicators, uiScore };
    }

    /**
     * Analyze file patterns for UI files
     */
    private async analyzeFilePatterns(): Promise<{
        indicators: string[];
        uiScore: number;
    }> {
        const indicators: string[] = [];
        let uiScore = 0;

        try {
            for (const pattern of UI_FILE_PATTERNS) {
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(this.workspacePath, pattern),
                    '**/node_modules/**',
                    5 // Only need to find a few to confirm
                );

                if (files.length > 0) {
                    const ext = pattern.includes('.') ? pattern.split('.').pop() : pattern;
                    indicators.push(`files: found ${files.length}+ ${ext} files`);
                    uiScore += 2;
                }
            }
        } catch (error) {
            console.error('[ProjectTypeDetector] Error scanning file patterns:', error);
        }

        return { indicators, uiScore };
    }

    /**
     * Analyze style files (supporting evidence for UI)
     */
    private async analyzeStyleFiles(): Promise<{
        indicators: string[];
        uiScore: number;
    }> {
        const indicators: string[] = [];
        let uiScore = 0;

        try {
            for (const pattern of STYLE_FILE_PATTERNS) {
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(this.workspacePath, pattern),
                    '**/node_modules/**',
                    3
                );

                if (files.length > 0) {
                    if (pattern.includes('tailwind') || pattern.includes('postcss')) {
                        indicators.push(`config: ${pattern.split('/').pop()}`);
                        uiScore += 2;
                    } else {
                        const ext = pattern.split('.').pop();
                        indicators.push(`files: found ${ext} stylesheets`);
                        uiScore += 1; // Lower weight, supporting evidence
                    }
                }
            }
        } catch (error) {
            console.error('[ProjectTypeDetector] Error scanning style files:', error);
        }

        return { indicators, uiScore };
    }

    /**
     * Analyze other backend indicators (Python, Go, etc.)
     */
    private async analyzeOtherBackendIndicators(): Promise<{
        indicators: string[];
        backendScore: number;
    }> {
        const indicators: string[] = [];
        let backendScore = 0;

        // Check for Python backend frameworks
        const requirementsPath = path.join(this.workspacePath, 'requirements.txt');
        if (await fs.pathExists(requirementsPath)) {
            try {
                const content = await fs.readFile(requirementsPath, 'utf-8');
                const pythonBackendFrameworks = ['flask', 'django', 'fastapi', 'starlette', 'tornado', 'bottle'];
                for (const framework of pythonBackendFrameworks) {
                    if (content.toLowerCase().includes(framework)) {
                        indicators.push(`requirements.txt: ${framework} (Python backend)`);
                        backendScore += 2;
                    }
                }
            } catch (error) {
                // Ignore read errors
            }
        }

        // Check for Go backend
        const goModPath = path.join(this.workspacePath, 'go.mod');
        if (await fs.pathExists(goModPath)) {
            indicators.push('go.mod: Go project detected');
            backendScore += 1; // Could be CLI or backend
        }

        // Check for Dockerfile (often indicates backend service)
        const dockerfilePath = path.join(this.workspacePath, 'Dockerfile');
        if (await fs.pathExists(dockerfilePath)) {
            indicators.push('Dockerfile: containerized service');
            backendScore += 1;
        }

        return { indicators, backendScore };
    }

    /**
     * Classify the project based on collected scores
     */
    private classifyProject(
        uiScore: number,
        backendScore: number,
        cliScore: number,
        libraryScore: number,
        indicators: string[]
    ): { projectType: ProjectType; hasUI: boolean; confidence: DetectionConfidence } {
        // If no indicators found at all
        if (indicators.length === 0) {
            return {
                projectType: 'unknown',
                hasUI: false,
                confidence: 'low',
            };
        }

        // Determine primary project type
        let projectType: ProjectType;
        let hasUI = false;
        let confidence: DetectionConfidence;

        // Calculate totals for confidence
        const totalScore = uiScore + backendScore + cliScore + libraryScore;

        if (uiScore > 0 && backendScore > 0) {
            // Fullstack project
            projectType = 'fullstack';
            hasUI = true;
            confidence = uiScore >= 5 && backendScore >= 3 ? 'high' : 'medium';
        } else if (uiScore > backendScore && uiScore > cliScore && uiScore > libraryScore) {
            // Frontend project
            projectType = 'frontend';
            hasUI = true;
            confidence = uiScore >= 6 ? 'high' : uiScore >= 3 ? 'medium' : 'low';
        } else if (cliScore > backendScore && cliScore > libraryScore) {
            // CLI project
            projectType = 'cli';
            hasUI = false;
            confidence = cliScore >= 5 ? 'high' : cliScore >= 3 ? 'medium' : 'low';
        } else if (libraryScore > backendScore) {
            // Library project
            projectType = 'library';
            hasUI = false;
            confidence = libraryScore >= 4 ? 'high' : 'medium';
        } else if (backendScore > 0) {
            // Backend project
            projectType = 'backend';
            hasUI = false;
            confidence = backendScore >= 4 ? 'high' : backendScore >= 2 ? 'medium' : 'low';
        } else {
            // Unknown
            projectType = 'unknown';
            hasUI = false;
            confidence = 'low';
        }

        return { projectType, hasUI, confidence };
    }

    /**
     * Get recommended verification methods based on project type
     */
    private getRecommendedVerification(
        projectType: ProjectType,
        hasUI: boolean,
        hasBackend: boolean
    ): VerificationMethod[] {
        const methods: VerificationMethod[] = [];

        // Always recommend build verification and lint check
        methods.push('build_verification');
        methods.push('lint_check');

        // Unit tests are (almost) always recommended
        methods.push('unit_tests');

        // Browser testing for UI projects
        if (hasUI) {
            methods.push('browser_testing');
        }

        // API testing for backend/fullstack
        if (hasBackend || projectType === 'backend' || projectType === 'fullstack') {
            methods.push('api_testing');
        }

        return methods;
    }

    /**
     * Determine if browser testing is recommended based on detection and settings
     */
    private isBrowserTestingRecommended(
        hasUI: boolean,
        confidence: DetectionConfidence,
        constitutionSetting?: BrowserTestingSetting
    ): boolean {
        // Constitution setting takes precedence
        if (constitutionSetting === 'required') {
            return true;
        }
        if (constitutionSetting === 'disabled') {
            return false;
        }
        // 'optional' or undefined: use auto-detection
        return hasUI;
    }

    /**
     * Get a human-readable summary of the detection result
     */
    static getSummary(result: ProjectTypeDetectionResult): string {
        const typeLabels: Record<ProjectType, string> = {
            frontend: 'Frontend Application',
            backend: 'Backend API/Service',
            fullstack: 'Full-Stack Application',
            library: 'Library/Package',
            cli: 'CLI Tool',
            unknown: 'Unknown Project Type',
        };

        const browserStatus = result.browserTestingRecommended
            ? 'required'
            : 'not required';

        return `Detected: ${typeLabels[result.projectType]} (${result.confidence} confidence) - Browser testing: ${browserStatus}`;
    }

    /**
     * Generate a suggestion message for low-confidence detections
     */
    static getLowConfidenceSuggestion(result: ProjectTypeDetectionResult): string | null {
        if (result.confidence !== 'low') {
            return null;
        }

        return `Low confidence project type detection. Consider adding explicit setting to constitution.md:
## Testing Requirements
- **Browser Testing**: ${result.hasUI ? 'required' : 'disabled'}`;
    }
}

/**
 * Convenience function to detect project type for a workspace
 */
export async function detectProjectType(
    workspacePath: string,
    constitutionSetting?: BrowserTestingSetting
): Promise<ProjectTypeDetectionResult> {
    const detector = new ProjectTypeDetector({
        workspacePath,
        constitutionSetting,
    });
    return detector.detect();
}

/**
 * Check if browser testing should be required for mission completion
 */
export function shouldRequireBrowserTesting(
    detectionResult: ProjectTypeDetectionResult,
    constitutionSetting?: BrowserTestingSetting
): boolean {
    // Constitution setting takes absolute precedence
    if (constitutionSetting === 'required') {
        return true;
    }
    if (constitutionSetting === 'disabled') {
        return false;
    }
    // 'optional' or undefined: use detection result
    return detectionResult.browserTestingRecommended;
}
