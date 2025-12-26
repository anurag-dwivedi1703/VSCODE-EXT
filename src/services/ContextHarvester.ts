import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Files that provide high-leverage context about a project.
 * These are scanned to build the constitution.
 */
const HIGH_LEVERAGE_FILES = [
    // Package managers & dependencies
    'package.json',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'pyproject.toml',
    'requirements.txt',
    'Pipfile',
    'Cargo.toml',
    'go.mod',
    'go.sum',
    'Gemfile',
    'composer.json',
    'pom.xml',
    'build.gradle',

    // Android-specific
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.properties',
    'local.properties',
    'app/build.gradle',
    'app/build.gradle.kts',

    // Build & Config
    'tsconfig.json',
    'jsconfig.json',
    'webpack.config.js',
    'vite.config.js',
    'vite.config.ts',
    'rollup.config.js',
    'esbuild.config.js',
    'next.config.js',
    'next.config.mjs',
    'nuxt.config.js',
    'angular.json',
    'vue.config.js',

    // Documentation
    'README.md',
    'README.rst',
    'CONTRIBUTING.md',
    'ARCHITECTURE.md',

    // Linting & Formatting
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.json',
    '.stylelintrc',
    '.editorconfig',
    'biome.json',

    // Testing
    'jest.config.js',
    'jest.config.ts',
    'vitest.config.js',
    'vitest.config.ts',
    'playwright.config.ts',
    'cypress.config.js',
    'karma.conf.js',
    'pytest.ini',
    'setup.cfg',

    // CI/CD
    '.github/workflows/*',
    '.gitlab-ci.yml',
    'Jenkinsfile',
    '.circleci/config.yml',

    // Docker & Infrastructure
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    '.dockerignore',
];

/**
 * Directories to exclude from the file tree.
 */
const EXCLUDED_DIRS = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.tox',
    '.nox',
    'venv',
    '.venv',
    'env',
    '.env',
    'dist',
    'build',
    'out',
    'target',
    'coverage',
    '.next',
    '.nuxt',
    '.cache',
    'vendor',
    'tmp',
    'temp',
    '.specify',  // Our own directory
]);

/**
 * ContextHarvester - Intelligent workspace scanner.
 * 
 * Extracts high-leverage context from a workspace without reading
 * every file, optimizing for token efficiency.
 */
export class ContextHarvester {
    /**
     * Scan the workspace and build context for constitution generation.
     * Returns a formatted string suitable for feeding to the AI.
     */
    async scanWorkspace(workspaceRoot: string): Promise<string> {
        let contextBuffer = '';

        try {
            // 1. Project Metadata (high-leverage files)
            const metadata = await this.extractProjectMetadata(workspaceRoot);
            if (metadata) {
                contextBuffer += `## Project Metadata\n\n${metadata}\n\n`;
            }

            // 2. Directory Structure
            const tree = await this.generateFileTree(workspaceRoot, 0, 3);
            if (tree) {
                contextBuffer += `## Project Structure\n\n\`\`\`\n${tree}\`\`\`\n\n`;
            }

            // 3. Tech Stack Detection
            const techStack = await this.detectTechStack(workspaceRoot);
            if (techStack.length > 0) {
                contextBuffer += `## Detected Technologies\n\n${techStack.join('\n')}\n\n`;
            }

            console.log(`[ContextHarvester] Scanned workspace, context size: ${contextBuffer.length} chars`);
        } catch (error) {
            console.error('[ContextHarvester] Error scanning workspace:', error);
            contextBuffer = `Error scanning workspace: ${error}`;
        }

        return contextBuffer;
    }

    /**
     * Extract project metadata from high-leverage config files.
     */
    private async extractProjectMetadata(workspaceRoot: string): Promise<string> {
        let metadata = '';

        for (const filename of HIGH_LEVERAGE_FILES) {
            // Handle glob patterns like '.github/workflows/*'
            if (filename.includes('*')) {
                continue; // Skip glob patterns for now, could expand later
            }

            const filePath = path.join(workspaceRoot, filename);

            if (fs.existsSync(filePath)) {
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isFile()) {
                        const content = fs.readFileSync(filePath, 'utf-8');

                        // Limit file size to prevent token explosion
                        const truncatedContent = content.length > 5000
                            ? content.substring(0, 5000) + '\n... [truncated]'
                            : content;

                        metadata += `### ${filename}\n\n\`\`\`\n${truncatedContent}\n\`\`\`\n\n`;
                    }
                } catch (error) {
                    console.warn(`[ContextHarvester] Could not read ${filename}:`, error);
                }
            }
        }

        return metadata;
    }

    /**
     * Generate a directory tree, limited by depth.
     */
    private async generateFileTree(
        dir: string,
        currentDepth: number = 0,
        maxDepth: number = 3,
        prefix: string = ''
    ): Promise<string> {
        if (currentDepth > maxDepth) {
            return '';
        }

        let tree = '';

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            // Sort: directories first, then files
            entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            });

            const filteredEntries = entries.filter(entry => {
                // Skip hidden files/folders (except some config files)
                if (entry.name.startsWith('.') && !entry.name.startsWith('.eslint') && !entry.name.startsWith('.prettier')) {
                    return false;
                }
                // Skip excluded directories
                if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) {
                    return false;
                }
                return true;
            });

            for (let i = 0; i < filteredEntries.length; i++) {
                const entry = filteredEntries[i];
                const isLast = i === filteredEntries.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                const childPrefix = isLast ? '    ' : '│   ';

                if (entry.isDirectory()) {
                    tree += `${prefix}${connector}${entry.name}/\n`;

                    // Recurse into directory
                    const childTree = await this.generateFileTree(
                        path.join(dir, entry.name),
                        currentDepth + 1,
                        maxDepth,
                        prefix + childPrefix
                    );
                    tree += childTree;
                } else {
                    tree += `${prefix}${connector}${entry.name}\n`;
                }
            }
        } catch (error) {
            console.warn(`[ContextHarvester] Could not read directory ${dir}:`, error);
        }

        return tree;
    }

    /**
     * Detect the tech stack based on files present.
     */
    private async detectTechStack(workspaceRoot: string): Promise<string[]> {
        const detected: string[] = [];

        const checks: { file: string; tech: string }[] = [
            // JavaScript/TypeScript ecosystem
            { file: 'package.json', tech: '- **Node.js/NPM** project detected' },
            { file: 'tsconfig.json', tech: '- **TypeScript** enabled' },
            { file: 'next.config.js', tech: '- **Next.js** framework' },
            { file: 'next.config.mjs', tech: '- **Next.js** framework' },
            { file: 'nuxt.config.js', tech: '- **Nuxt.js** framework' },
            { file: 'angular.json', tech: '- **Angular** framework' },
            { file: 'vue.config.js', tech: '- **Vue.js** framework' },
            { file: 'vite.config.js', tech: '- **Vite** build tool' },
            { file: 'vite.config.ts', tech: '- **Vite** build tool' },
            { file: 'webpack.config.js', tech: '- **Webpack** bundler' },

            // Python
            { file: 'pyproject.toml', tech: '- **Python** project (pyproject.toml)' },
            { file: 'requirements.txt', tech: '- **Python** project (requirements.txt)' },
            { file: 'Pipfile', tech: '- **Python** project (Pipenv)' },
            { file: 'setup.py', tech: '- **Python** package' },

            // Rust
            { file: 'Cargo.toml', tech: '- **Rust** project' },

            // Go
            { file: 'go.mod', tech: '- **Go** module' },

            // Ruby
            { file: 'Gemfile', tech: '- **Ruby** project' },

            // PHP
            { file: 'composer.json', tech: '- **PHP/Composer** project' },

            // Java/JVM
            { file: 'pom.xml', tech: '- **Java/Maven** project' },
            { file: 'build.gradle', tech: '- **Java/Gradle** project' },
            { file: 'build.gradle.kts', tech: '- **Kotlin/Gradle** project' },

            // Android
            { file: 'settings.gradle', tech: '- **Android** project (Gradle)' },
            { file: 'settings.gradle.kts', tech: '- **Android** project (Gradle KTS)' },
            { file: 'app/build.gradle', tech: '- **Android** app module' },
            { file: 'app/build.gradle.kts', tech: '- **Android** app module (KTS)' },

            // Testing
            { file: 'jest.config.js', tech: '- **Jest** testing framework' },
            { file: 'jest.config.ts', tech: '- **Jest** testing framework' },
            { file: 'vitest.config.js', tech: '- **Vitest** testing framework' },
            { file: 'vitest.config.ts', tech: '- **Vitest** testing framework' },
            { file: 'playwright.config.ts', tech: '- **Playwright** E2E testing' },
            { file: 'cypress.config.js', tech: '- **Cypress** E2E testing' },
            { file: 'pytest.ini', tech: '- **pytest** testing framework' },

            // Linting
            { file: '.eslintrc', tech: '- **ESLint** configured' },
            { file: '.eslintrc.js', tech: '- **ESLint** configured' },
            { file: '.eslintrc.json', tech: '- **ESLint** configured' },
            { file: '.prettierrc', tech: '- **Prettier** configured' },
            { file: '.prettierrc.js', tech: '- **Prettier** configured' },
            { file: 'biome.json', tech: '- **Biome** (linting/formatting)' },

            // Docker
            { file: 'Dockerfile', tech: '- **Docker** containerization' },
            { file: 'docker-compose.yml', tech: '- **Docker Compose** orchestration' },
        ];

        for (const check of checks) {
            const filePath = path.join(workspaceRoot, check.file);
            if (fs.existsSync(filePath)) {
                // Avoid duplicate detections
                if (!detected.includes(check.tech)) {
                    detected.push(check.tech);
                }
            }
        }

        return detected;
    }

    /**
     * Get a quick summary of the workspace for comparison purposes.
     * This is a lighter-weight scan for drift detection.
     */
    async getQuickSummary(workspaceRoot: string): Promise<string> {
        let summary = '';

        // Just get package.json and top-level structure for quick comparison
        const packageJsonPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            try {
                const content = fs.readFileSync(packageJsonPath, 'utf-8');
                summary += `### package.json\n\`\`\`json\n${content}\n\`\`\`\n\n`;
            } catch (e) {
                // ignore
            }
        }

        // Top-level directory listing
        try {
            const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
            const dirs = entries
                .filter(e => e.isDirectory() && !EXCLUDED_DIRS.has(e.name) && !e.name.startsWith('.'))
                .map(e => e.name);
            summary += `### Top-Level Directories\n${dirs.join(', ')}\n`;
        } catch (e) {
            // ignore
        }

        return summary;
    }
}
