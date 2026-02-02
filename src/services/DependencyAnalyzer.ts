/**
 * DependencyAnalyzer.ts
 * 
 * Analyzes project dependencies to identify:
 * - Critical dependencies that shouldn't be modified
 * - Circular imports that could cause issues
 * - Security vulnerabilities
 * - Outdated packages
 * 
 * This information feeds into the constitution generation
 * to create actionable rules for agents.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    CriticalDependency,
    CircularImport,
    DependencyAnalysis,
    SecurityVulnerability,
    RiskLevel
} from '../engine/ConstitutionSchema';

// ============================================
// KNOWN CRITICAL PACKAGES
// ============================================

/**
 * Packages that are commonly critical and should be flagged
 */
const KNOWN_CRITICAL_PACKAGES: Record<string, { reason: string; riskLevel: RiskLevel }> = {
    // Build tools
    'webpack': { reason: 'Build system - changes can break bundling', riskLevel: 'high' },
    'vite': { reason: 'Build system - changes can break bundling', riskLevel: 'high' },
    'rollup': { reason: 'Build system - changes can break bundling', riskLevel: 'high' },
    'esbuild': { reason: 'Build system - changes can break bundling', riskLevel: 'high' },
    'typescript': { reason: 'TypeScript compiler - version changes can cause type errors', riskLevel: 'high' },
    
    // Testing
    'jest': { reason: 'Test framework - changes can break test suite', riskLevel: 'medium' },
    'mocha': { reason: 'Test framework - changes can break test suite', riskLevel: 'medium' },
    'playwright': { reason: 'E2E test framework - browser compatibility sensitive', riskLevel: 'high' },
    'playwright-core': { reason: 'E2E test framework - browser compatibility sensitive', riskLevel: 'high' },
    'cypress': { reason: 'E2E test framework - browser compatibility sensitive', riskLevel: 'high' },
    
    // Framework core
    'react': { reason: 'UI framework - major versions have breaking changes', riskLevel: 'critical' },
    'react-dom': { reason: 'React DOM renderer - must match React version', riskLevel: 'critical' },
    'vue': { reason: 'UI framework - major versions have breaking changes', riskLevel: 'critical' },
    'angular': { reason: 'UI framework - major versions have breaking changes', riskLevel: 'critical' },
    '@angular/core': { reason: 'Angular core - major versions have breaking changes', riskLevel: 'critical' },
    'next': { reason: 'Next.js framework - major versions have breaking changes', riskLevel: 'critical' },
    'express': { reason: 'Server framework - API changes can break routes', riskLevel: 'high' },
    'fastify': { reason: 'Server framework - API changes can break routes', riskLevel: 'high' },
    
    // VS Code extension
    'vscode': { reason: 'VS Code API - breaking changes break extension', riskLevel: 'critical' },
    '@types/vscode': { reason: 'VS Code type definitions - must match vscode version', riskLevel: 'critical' },
    
    // Database
    'prisma': { reason: 'Database ORM - schema changes require migrations', riskLevel: 'critical' },
    '@prisma/client': { reason: 'Database client - must match Prisma version', riskLevel: 'critical' },
    'mongoose': { reason: 'MongoDB ORM - schema changes can cause data issues', riskLevel: 'high' },
    'sequelize': { reason: 'SQL ORM - schema changes require migrations', riskLevel: 'high' },
    'typeorm': { reason: 'SQL ORM - schema changes require migrations', riskLevel: 'high' },
    
    // Auth
    'passport': { reason: 'Authentication - changes can break login flow', riskLevel: 'critical' },
    'jsonwebtoken': { reason: 'JWT handling - changes can invalidate tokens', riskLevel: 'critical' },
    '@auth0/auth0-react': { reason: 'Auth provider - changes can break authentication', riskLevel: 'critical' },
    
    // State management
    'redux': { reason: 'State management - changes can break app state', riskLevel: 'high' },
    '@reduxjs/toolkit': { reason: 'Redux toolkit - changes can break state logic', riskLevel: 'high' },
    'mobx': { reason: 'State management - changes can break reactivity', riskLevel: 'high' },
    'zustand': { reason: 'State management - changes can break app state', riskLevel: 'medium' },
    
    // AI/LLM
    '@anthropic-ai/sdk': { reason: 'Claude API - breaking changes affect AI features', riskLevel: 'high' },
    '@google/generative-ai': { reason: 'Gemini API - breaking changes affect AI features', riskLevel: 'high' },
    'openai': { reason: 'OpenAI API - breaking changes affect AI features', riskLevel: 'high' },
};

// ============================================
// DEPENDENCY ANALYZER CLASS
// ============================================

export class DependencyAnalyzer {
    private workspaceRoot: string;
    
    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }
    
    /**
     * Perform full dependency analysis
     */
    async analyze(): Promise<DependencyAnalysis> {
        const packageJsonPath = path.join(this.workspaceRoot, 'package.json');
        
        // Check if package.json exists
        if (!fs.existsSync(packageJsonPath)) {
            return this.emptyAnalysis();
        }
        
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            
            const dependencies = packageJson.dependencies || {};
            const devDependencies = packageJson.devDependencies || {};
            
            // Identify critical dependencies
            const criticalDeps = this.identifyCriticalDependencies(dependencies, devDependencies);
            
            // Detect circular imports (basic detection)
            const circularImports = await this.detectCircularImports();
            
            // Check for vulnerabilities (if npm audit available)
            const vulnerabilities = await this.checkVulnerabilities();
            
            return {
                critical: criticalDeps,
                totalDependencies: Object.keys(dependencies).length,
                devDependencies: Object.keys(devDependencies).length,
                circularImports,
                vulnerabilities
            };
        } catch (error) {
            console.error('[DependencyAnalyzer] Error analyzing dependencies:', error);
            return this.emptyAnalysis();
        }
    }
    
    /**
     * Identify critical dependencies from package.json
     */
    private identifyCriticalDependencies(
        dependencies: Record<string, string>,
        devDependencies: Record<string, string>
    ): CriticalDependency[] {
        const critical: CriticalDependency[] = [];
        
        // Check production dependencies
        for (const [name, version] of Object.entries(dependencies)) {
            const known = KNOWN_CRITICAL_PACKAGES[name];
            if (known) {
                critical.push({
                    name,
                    version,
                    reason: known.reason,
                    riskLevel: known.riskLevel,
                    isDev: false
                });
            }
        }
        
        // Check dev dependencies (only high-risk build tools)
        for (const [name, version] of Object.entries(devDependencies)) {
            const known = KNOWN_CRITICAL_PACKAGES[name];
            if (known && (known.riskLevel === 'critical' || known.riskLevel === 'high')) {
                critical.push({
                    name,
                    version,
                    reason: known.reason,
                    riskLevel: known.riskLevel,
                    isDev: true
                });
            }
        }
        
        // Sort by risk level (critical first)
        const riskOrder: Record<RiskLevel, number> = {
            'critical': 0,
            'high': 1,
            'medium': 2,
            'low': 3
        };
        
        critical.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);
        
        return critical;
    }
    
    /**
     * Detect circular imports by analyzing import statements
     * This is a simplified detection - full detection would require a proper AST parser
     */
    private async detectCircularImports(): Promise<CircularImport[]> {
        const circularImports: CircularImport[] = [];
        
        try {
            // Build import graph
            const importGraph = new Map<string, Set<string>>();
            const srcDir = path.join(this.workspaceRoot, 'src');
            
            if (!fs.existsSync(srcDir)) {
                return circularImports;
            }
            
            // Scan TypeScript/JavaScript files
            await this.scanDirectoryForImports(srcDir, importGraph);
            
            // Detect cycles using DFS
            const visited = new Set<string>();
            const recursionStack = new Set<string>();
            
            for (const file of importGraph.keys()) {
                const cycle = this.detectCycle(file, importGraph, visited, recursionStack, []);
                if (cycle) {
                    circularImports.push({
                        cycle,
                        severity: 'warning',
                        suggestion: `Consider breaking the cycle by extracting shared types to a separate file`
                    });
                }
            }
        } catch (error) {
            console.error('[DependencyAnalyzer] Error detecting circular imports:', error);
        }
        
        return circularImports;
    }
    
    /**
     * Scan directory for import statements
     */
    private async scanDirectoryForImports(
        dir: string,
        importGraph: Map<string, Set<string>>
    ): Promise<void> {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                // Skip node_modules, dist, etc.
                if (['node_modules', 'dist', 'build', 'out', '.git'].includes(entry.name)) {
                    continue;
                }
                await this.scanDirectoryForImports(fullPath, importGraph);
            } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                const imports = this.extractImports(fullPath);
                const relativePath = path.relative(this.workspaceRoot, fullPath);
                importGraph.set(relativePath, imports);
            }
        }
    }
    
    /**
     * Extract import paths from a file
     */
    private extractImports(filePath: string): Set<string> {
        const imports = new Set<string>();
        
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const fileDir = path.dirname(filePath);
            
            // Match import statements
            const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
            const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
            
            let match;
            
            while ((match = importRegex.exec(content)) !== null) {
                const importPath = match[1];
                if (importPath.startsWith('.')) {
                    // Resolve relative import
                    const resolvedPath = this.resolveImportPath(fileDir, importPath);
                    if (resolvedPath) {
                        imports.add(path.relative(this.workspaceRoot, resolvedPath));
                    }
                }
            }
            
            while ((match = requireRegex.exec(content)) !== null) {
                const importPath = match[1];
                if (importPath.startsWith('.')) {
                    const resolvedPath = this.resolveImportPath(fileDir, importPath);
                    if (resolvedPath) {
                        imports.add(path.relative(this.workspaceRoot, resolvedPath));
                    }
                }
            }
        } catch (error) {
            // Ignore file read errors
        }
        
        return imports;
    }
    
    /**
     * Resolve import path to actual file
     */
    private resolveImportPath(fromDir: string, importPath: string): string | null {
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
        const basePath = path.resolve(fromDir, importPath);
        
        // Check if it's already a file
        if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
            return basePath;
        }
        
        // Try with extensions
        for (const ext of extensions) {
            const fullPath = basePath + ext;
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                return fullPath;
            }
        }
        
        return null;
    }
    
    /**
     * Detect cycle using DFS
     */
    private detectCycle(
        node: string,
        graph: Map<string, Set<string>>,
        visited: Set<string>,
        recursionStack: Set<string>,
        currentPath: string[]
    ): string[] | null {
        if (recursionStack.has(node)) {
            // Found a cycle - extract the cycle from currentPath
            const cycleStart = currentPath.indexOf(node);
            if (cycleStart !== -1) {
                return [...currentPath.slice(cycleStart), node];
            }
            return [node];
        }
        
        if (visited.has(node)) {
            return null;
        }
        
        visited.add(node);
        recursionStack.add(node);
        currentPath.push(node);
        
        const neighbors = graph.get(node) || new Set();
        for (const neighbor of neighbors) {
            const cycle = this.detectCycle(neighbor, graph, visited, recursionStack, currentPath);
            if (cycle) {
                return cycle;
            }
        }
        
        currentPath.pop();
        recursionStack.delete(node);
        
        return null;
    }
    
    /**
     * Check for security vulnerabilities using npm audit
     * Note: This requires npm to be available
     */
    private async checkVulnerabilities(): Promise<SecurityVulnerability[]> {
        const vulnerabilities: SecurityVulnerability[] = [];
        
        // For now, return empty - actual implementation would run npm audit
        // This could be implemented with child_process.exec('npm audit --json')
        // But that's slow and may not be available in all environments
        
        return vulnerabilities;
    }
    
    /**
     * Return empty analysis result
     */
    private emptyAnalysis(): DependencyAnalysis {
        return {
            critical: [],
            totalDependencies: 0,
            devDependencies: 0,
            circularImports: []
        };
    }
}

/**
 * Create a DependencyAnalyzer instance
 */
export function createDependencyAnalyzer(workspaceRoot: string): DependencyAnalyzer {
    return new DependencyAnalyzer(workspaceRoot);
}
