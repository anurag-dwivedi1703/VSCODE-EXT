/**
 * RuleEnforcer.ts
 * 
 * Validates agent outputs against constitution rules.
 * 
 * This service:
 * - Checks file changes for rule violations
 * - Validates against forbidden patterns
 * - Enforces MUST/MUST NOT/SHOULD rules
 * - Formats violations for agent feedback
 * 
 * Integrates with TaskRunner to provide real-time rule enforcement.
 */

import * as path from 'path';
import {
    ConstitutionV2,
    AgentRule,
    ForbiddenPattern,
    RuleViolation,
    EnforcementLevel,
    ModuleBoundary,
    ImportRule,
    TestingRequirements
} from '../engine/ConstitutionSchema';

// ============================================
// FILE EDIT INTERFACE
// ============================================

/**
 * Represents a file edit made by the agent
 */
export interface FileEdit {
    /** File path */
    path: string;
    /** Type of edit */
    type: 'create' | 'modify' | 'delete';
    /** New content (for create/modify) */
    content?: string;
    /** Previous content (for modify) */
    previousContent?: string;
    /** Diff or summary of changes */
    diff?: string;
}

// ============================================
// BUILT-IN RULES
// ============================================

/**
 * Built-in rules that are always enforced
 */
const BUILT_IN_MUST_NOT_RULES: AgentRule[] = [
    {
        id: 'builtin-no-node-modules',
        description: 'Do not modify files in node_modules/',
        enforcement: 'strict',
        autoDetect: true,
        pattern: '^node_modules/',
        reason: 'node_modules contains third-party code that should not be modified'
    },
    {
        id: 'builtin-no-git',
        description: 'Do not modify files in .git/',
        enforcement: 'strict',
        autoDetect: true,
        pattern: '^\\.git/',
        reason: '.git contains version control internals'
    },
    {
        id: 'builtin-no-dist',
        description: 'Do not modify files in dist/ or build/',
        enforcement: 'warning',
        autoDetect: true,
        pattern: '^(dist|build|out)/',
        reason: 'Build output directories are generated and should not be modified manually'
    },
    {
        id: 'builtin-no-lock-files',
        description: 'Do not manually edit lock files',
        enforcement: 'warning',
        autoDetect: true,
        pattern: '(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml)$',
        reason: 'Lock files should be updated by the package manager, not manually'
    },
];

// ============================================
// RULE ENFORCER CLASS
// ============================================

export class RuleEnforcer {
    private constitution: ConstitutionV2 | null = null;
    
    /**
     * Set the constitution to enforce
     */
    setConstitution(constitution: ConstitutionV2): void {
        this.constitution = constitution;
    }
    
    /**
     * Get the current constitution
     */
    getConstitution(): ConstitutionV2 | null {
        return this.constitution;
    }
    
    /**
     * Validate file edits against constitution rules
     */
    async validateFileEdits(edits: FileEdit[]): Promise<RuleViolation[]> {
        const violations: RuleViolation[] = [];
        
        for (const edit of edits) {
            // Check built-in rules (always enforced)
            const builtInViolations = this.checkBuiltInRules(edit);
            violations.push(...builtInViolations);
            
            // Check constitution rules if available
            if (this.constitution) {
                const constitutionViolations = await this.checkConstitutionRules(edit);
                violations.push(...constitutionViolations);
            }
        }
        
        // Sort by severity (strict first)
        return this.sortViolationsBySeverity(violations);
    }
    
    /**
     * Check built-in rules that always apply
     */
    private checkBuiltInRules(edit: FileEdit): RuleViolation[] {
        const violations: RuleViolation[] = [];
        const relativePath = edit.path.replace(/\\/g, '/');
        
        for (const rule of BUILT_IN_MUST_NOT_RULES) {
            if (rule.pattern) {
                const pattern = new RegExp(rule.pattern);
                if (pattern.test(relativePath)) {
                    violations.push({
                        rule,
                        filePath: edit.path,
                        severity: rule.enforcement,
                        detectedAt: new Date().toISOString()
                    });
                }
            }
        }
        
        return violations;
    }
    
    /**
     * Check constitution-specific rules
     */
    private async checkConstitutionRules(edit: FileEdit): Promise<RuleViolation[]> {
        const violations: RuleViolation[] = [];
        
        if (!this.constitution) {
            return violations;
        }
        
        // Check MUST NOT rules
        for (const rule of this.constitution.agentConstraints.mustNot) {
            if (rule.autoDetect && rule.pattern) {
                const violation = this.checkRule(edit, rule);
                if (violation) {
                    violations.push(violation);
                }
            }
        }
        
        // Check forbidden patterns
        for (const pattern of this.constitution.forbiddenPatterns) {
            if (pattern.pattern) {
                const violation = this.checkForbiddenPattern(edit, pattern);
                if (violation) {
                    violations.push(violation);
                }
            }
        }
        
        // Check architecture rules (import rules and module boundaries)
        const archViolations = this.checkArchitectureRules(edit);
        violations.push(...archViolations);
        
        return violations;
    }
    
    // ============================================
    // ARCHITECTURE RULES ENFORCEMENT
    // ============================================
    
    /**
     * Check architecture rules for a file edit.
     * Validates import rules and module boundaries.
     */
    private checkArchitectureRules(edit: FileEdit): RuleViolation[] {
        const violations: RuleViolation[] = [];
        
        if (!this.constitution?.architectureRules || !edit.content) {
            return violations;
        }
        
        const archRules = this.constitution.architectureRules;
        const relativePath = this.normalizePathForMatching(edit.path);
        
        // Extract imports from the file content
        const imports = this.extractImports(edit.content);
        
        if (imports.length === 0) {
            return violations;
        }
        
        // Check import rules
        const importRuleViolations = this.validateImportRules(relativePath, imports, archRules.importRules);
        violations.push(...importRuleViolations);
        
        // Check module boundaries
        const boundaryViolations = this.validateModuleBoundaries(relativePath, imports, archRules.moduleBoundaries);
        violations.push(...boundaryViolations);
        
        return violations;
    }
    
    /**
     * Extract import statements from file content.
     * Supports TypeScript/JavaScript import/require syntax.
     */
    private extractImports(content: string): { statement: string; target: string; line: number }[] {
        const imports: { statement: string; target: string; line: number }[] = [];
        const lines = content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNumber = i + 1;
            
            // ES6 imports: import x from 'path' or import { x } from 'path'
            const es6Match = line.match(/import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/);
            if (es6Match) {
                imports.push({
                    statement: line.trim(),
                    target: es6Match[1],
                    line: lineNumber
                });
                continue;
            }
            
            // CommonJS: require('path')
            const cjsMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            if (cjsMatch) {
                imports.push({
                    statement: line.trim(),
                    target: cjsMatch[1],
                    line: lineNumber
                });
                continue;
            }
            
            // Dynamic imports: import('path')
            const dynamicMatch = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            if (dynamicMatch) {
                imports.push({
                    statement: line.trim(),
                    target: dynamicMatch[1],
                    line: lineNumber
                });
            }
        }
        
        return imports;
    }
    
    /**
     * Validate imports against import rules.
     * Import rules define patterns like "from: services/* cannotImport: controllers/*"
     */
    private validateImportRules(
        filePath: string,
        imports: { statement: string; target: string; line: number }[],
        importRules: ImportRule[]
    ): RuleViolation[] {
        const violations: RuleViolation[] = [];
        
        for (const rule of importRules) {
            // Check if this rule applies to the current file
            const fromPattern = this.globToRegex(rule.from);
            if (!fromPattern.test(filePath)) {
                continue;
            }
            
            // Check each import against the cannotImport patterns
            for (const imp of imports) {
                const resolvedTarget = this.resolveImportPath(filePath, imp.target);
                
                for (const cannotImport of rule.cannotImport) {
                    const cannotImportPattern = this.globToRegex(cannotImport);
                    
                    if (cannotImportPattern.test(resolvedTarget)) {
                        violations.push({
                            rule: {
                                id: rule.id,
                                description: `Import rule violation: files in ${rule.from} cannot import from ${cannotImport}`,
                                enforcement: 'warning',
                                autoDetect: true,
                                reason: rule.reason
                            },
                            filePath: filePath,
                            lineNumber: imp.line,
                            content: imp.statement,
                            severity: 'warning',
                            detectedAt: new Date().toISOString()
                        });
                    }
                }
            }
        }
        
        return violations;
    }
    
    /**
     * Validate imports against module boundaries.
     * Module boundaries define which modules cannot import from each other.
     */
    private validateModuleBoundaries(
        filePath: string,
        imports: { statement: string; target: string; line: number }[],
        moduleBoundaries: ModuleBoundary[]
    ): RuleViolation[] {
        const violations: RuleViolation[] = [];
        
        // Find which module this file belongs to
        const sourceModule = this.findModuleForPath(filePath, moduleBoundaries);
        if (!sourceModule || !sourceModule.cannotImportFrom || sourceModule.cannotImportFrom.length === 0) {
            return violations;
        }
        
        // Check each import
        for (const imp of imports) {
            const resolvedTarget = this.resolveImportPath(filePath, imp.target);
            const targetModule = this.findModuleForPath(resolvedTarget, moduleBoundaries);
            
            if (targetModule && sourceModule.cannotImportFrom.includes(targetModule.name)) {
                violations.push({
                    rule: {
                        id: `boundary-${sourceModule.name}-${targetModule.name}`,
                        description: `Module boundary violation: ${sourceModule.name} cannot import from ${targetModule.name}`,
                        enforcement: 'warning',
                        autoDetect: true,
                        reason: `${sourceModule.purpose} should not depend on ${targetModule.purpose}`
                    },
                    filePath: filePath,
                    lineNumber: imp.line,
                    content: imp.statement,
                    severity: 'warning',
                    detectedAt: new Date().toISOString()
                });
            }
        }
        
        return violations;
    }
    
    /**
     * Find which module a file path belongs to.
     */
    private findModuleForPath(filePath: string, moduleBoundaries: ModuleBoundary[]): ModuleBoundary | null {
        const normalizedPath = this.normalizePathForMatching(filePath);
        
        for (const module of moduleBoundaries) {
            for (const include of module.includes) {
                const pattern = this.globToRegex(include);
                if (pattern.test(normalizedPath)) {
                    return module;
                }
            }
        }
        
        return null;
    }
    
    /**
     * Resolve a relative import path to a normalized path.
     */
    private resolveImportPath(fromFile: string, importPath: string): string {
        // Skip external packages (no ./ or ../)
        if (!importPath.startsWith('.')) {
            return importPath;
        }
        
        const fromDir = path.dirname(fromFile);
        const resolved = path.join(fromDir, importPath).replace(/\\/g, '/');
        
        // Remove leading ./ if present
        return resolved.startsWith('./') ? resolved.substring(2) : resolved;
    }
    
    /**
     * Normalize file path for pattern matching.
     */
    private normalizePathForMatching(filePath: string): string {
        return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    }
    
    /**
     * Convert a glob pattern to a RegExp.
     */
    private globToRegex(glob: string): RegExp {
        // Escape regex special chars except * and **
        let pattern = glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '<<DOUBLESTAR>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<DOUBLESTAR>>/g, '.*');
        
        // Ensure the pattern matches the start of the path
        if (!pattern.startsWith('.*') && !pattern.startsWith('^')) {
            pattern = '(?:^|/)' + pattern;
        }
        
        return new RegExp(pattern, 'i');
    }
    
    // ============================================
    // TESTING REQUIREMENTS ENFORCEMENT
    // ============================================
    
    /**
     * Validate testing requirements for a set of file edits.
     * This is called separately from validateFileEdits to check for missing tests.
     * 
     * @param edits The file edits made during a mission
     * @param existingFiles List of files that already exist (for checking if tests exist)
     * @returns Violations for missing or inadequate test coverage
     */
    public validateTestingRequirements(
        edits: FileEdit[],
        existingFiles: string[] = []
    ): RuleViolation[] {
        const violations: RuleViolation[] = [];
        
        if (!this.constitution?.testingRequirements) {
            return violations;
        }
        
        const testReqs = this.constitution.testingRequirements;
        const testPattern = this.globToRegex(testReqs.testFilePattern);
        
        // Find all newly created or modified source files (non-test files)
        const sourceEdits = edits.filter(edit => {
            const normalizedPath = this.normalizePathForMatching(edit.path);
            // Exclude test files, node_modules, config files, etc.
            if (testPattern.test(normalizedPath)) return false;
            if (normalizedPath.includes('node_modules')) return false;
            if (normalizedPath.includes('.config.')) return false;
            if (normalizedPath.endsWith('.json')) return false;
            if (normalizedPath.endsWith('.md')) return false;
            // Only include files with code extensions
            const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs'];
            return codeExtensions.some(ext => normalizedPath.endsWith(ext));
        });
        
        // Find test files in the edits
        const testEdits = edits.filter(edit => {
            const normalizedPath = this.normalizePathForMatching(edit.path);
            return testPattern.test(normalizedPath);
        });
        
        // Check for new source files without corresponding test files
        for (const sourceEdit of sourceEdits) {
            if (sourceEdit.type !== 'create') continue;
            
            const sourcePath = this.normalizePathForMatching(sourceEdit.path);
            const expectedTestFile = this.getExpectedTestFilePath(sourcePath, testReqs.testFilePattern);
            
            // Check if test file exists in edits or in existing files
            const hasTest = testEdits.some(te => 
                this.normalizePathForMatching(te.path).includes(path.basename(expectedTestFile).replace('.test', ''))
            ) || existingFiles.some(ef => 
                this.normalizePathForMatching(ef) === expectedTestFile
            );
            
            if (!hasTest && testReqs.requiredTestTypes.length > 0) {
                violations.push({
                    rule: {
                        id: 'testing-missing-test-file',
                        description: `New source file created without corresponding test file`,
                        enforcement: 'suggestion',
                        autoDetect: true,
                        reason: `Testing requirements specify that ${testReqs.requiredTestTypes.join(', ')} tests are required`
                    },
                    filePath: sourceEdit.path,
                    severity: 'suggestion',
                    detectedAt: new Date().toISOString(),
                    content: `Expected test file: ${expectedTestFile}`
                });
            }
        }
        
        // Check for significant changes to existing files without test updates
        for (const sourceEdit of sourceEdits) {
            if (sourceEdit.type !== 'modify') continue;
            if (!sourceEdit.content || !sourceEdit.previousContent) continue;
            
            // Check if this is a significant change (more than just formatting)
            const significantChange = this.isSignificantChange(sourceEdit.previousContent, sourceEdit.content);
            
            if (significantChange) {
                const sourcePath = this.normalizePathForMatching(sourceEdit.path);
                const hasTestUpdate = testEdits.some(te => {
                    const testPath = this.normalizePathForMatching(te.path);
                    // Check if test file is related to source file
                    const sourceBaseName = path.basename(sourcePath, path.extname(sourcePath));
                    return testPath.includes(sourceBaseName);
                });
                
                if (!hasTestUpdate && testReqs.requiredTestTypes.includes('unit')) {
                    violations.push({
                        rule: {
                            id: 'testing-no-test-update',
                            description: `Source file significantly modified without test updates`,
                            enforcement: 'suggestion',
                            autoDetect: true,
                            reason: 'Unit tests may need to be updated to cover the new functionality'
                        },
                        filePath: sourceEdit.path,
                        severity: 'suggestion',
                        detectedAt: new Date().toISOString()
                    });
                }
            }
        }
        
        return violations;
    }
    
    /**
     * Generate expected test file path based on source file and test pattern.
     */
    private getExpectedTestFilePath(sourcePath: string, testPattern: string): string {
        const dir = path.dirname(sourcePath);
        const ext = path.extname(sourcePath);
        const baseName = path.basename(sourcePath, ext);
        
        // Extract test suffix from pattern (e.g., "*.test.*" -> ".test")
        const suffixMatch = testPattern.match(/\*(\.[^*.]+)\.\*/);
        const testSuffix = suffixMatch ? suffixMatch[1] : '.test';
        
        return path.join(dir, `${baseName}${testSuffix}${ext}`).replace(/\\/g, '/');
    }
    
    /**
     * Determine if a file change is significant (not just formatting).
     */
    private isSignificantChange(oldContent: string, newContent: string): boolean {
        // Normalize whitespace and compare
        const normalizeWs = (s: string) => s.replace(/\s+/g, ' ').trim();
        const oldNorm = normalizeWs(oldContent);
        const newNorm = normalizeWs(newContent);
        
        if (oldNorm === newNorm) {
            return false; // Just whitespace changes
        }
        
        // Count significant changes (functions, classes, etc.)
        const functionPattern = /(function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|class\s+\w+|\w+\s*:\s*function)/g;
        const oldFunctions = (oldContent.match(functionPattern) || []).sort();
        const newFunctions = (newContent.match(functionPattern) || []).sort();
        
        // If function signatures changed, it's significant
        if (JSON.stringify(oldFunctions) !== JSON.stringify(newFunctions)) {
            return true;
        }
        
        // Check for significant line additions (more than 5 non-blank lines)
        const oldLines = oldContent.split('\n').filter(l => l.trim()).length;
        const newLines = newContent.split('\n').filter(l => l.trim()).length;
        
        return Math.abs(newLines - oldLines) > 5;
    }
    
    /**
     * Get testing requirements status summary for a mission.
     */
    getTestingRequirementsSummary(): {
        framework: string;
        testPattern: string;
        coverageMinimum?: number;
        requiredTypes: string[];
        testCommands: { [key: string]: string };
    } | null {
        if (!this.constitution?.testingRequirements) {
            return null;
        }
        
        const tr = this.constitution.testingRequirements;
        return {
            framework: tr.framework,
            testPattern: tr.testFilePattern,
            coverageMinimum: tr.coverageMinimum,
            requiredTypes: tr.requiredTestTypes,
            testCommands: tr.testCommands
        };
    }
    
    /**
     * Check a single rule against a file edit
     */
    private checkRule(edit: FileEdit, rule: AgentRule): RuleViolation | null {
        if (!rule.pattern || !edit.content) {
            return null;
        }
        
        // Check if rule applies to this file type
        if (rule.appliesTo && rule.appliesTo.length > 0) {
            const ext = path.extname(edit.path);
            if (!rule.appliesTo.some(pattern => 
                pattern === ext || 
                new RegExp(pattern.replace('*', '.*')).test(edit.path)
            )) {
                return null;
            }
        }
        
        try {
            const regex = new RegExp(rule.pattern, 'gi');
            const match = regex.exec(edit.content);
            
            if (match) {
                // Find line number
                const lineNumber = this.findLineNumber(edit.content, match.index);
                
                return {
                    rule,
                    filePath: edit.path,
                    lineNumber,
                    content: match[0].substring(0, 100), // Truncate for safety
                    severity: rule.enforcement,
                    detectedAt: new Date().toISOString()
                };
            }
        } catch (error) {
            console.warn(`[RuleEnforcer] Invalid pattern for rule ${rule.id}:`, error);
        }
        
        return null;
    }
    
    /**
     * Check a forbidden pattern against a file edit
     */
    private checkForbiddenPattern(edit: FileEdit, pattern: ForbiddenPattern): RuleViolation | null {
        if (!pattern.pattern || !edit.content) {
            return null;
        }
        
        // Check if pattern applies to this file
        if (pattern.appliesTo && pattern.appliesTo.length > 0) {
            const ext = path.extname(edit.path);
            if (!pattern.appliesTo.some(p => 
                p === ext || 
                new RegExp(p.replace('*', '.*')).test(edit.path)
            )) {
                return null;
            }
        }
        
        try {
            const regex = new RegExp(pattern.pattern, 'gi');
            const match = regex.exec(edit.content);
            
            if (match) {
                const lineNumber = this.findLineNumber(edit.content, match.index);
                
                return {
                    rule: pattern,
                    filePath: edit.path,
                    lineNumber,
                    content: match[0].substring(0, 100),
                    severity: pattern.enforcement,
                    detectedAt: new Date().toISOString()
                };
            }
        } catch (error) {
            console.warn(`[RuleEnforcer] Invalid pattern for forbidden pattern ${pattern.id}:`, error);
        }
        
        return null;
    }
    
    /**
     * Find line number for a character index
     */
    private findLineNumber(content: string, index: number): number {
        const lines = content.substring(0, index).split('\n');
        return lines.length;
    }
    
    /**
     * Sort violations by severity
     */
    private sortViolationsBySeverity(violations: RuleViolation[]): RuleViolation[] {
        const severityOrder: Record<EnforcementLevel, number> = {
            'strict': 0,
            'warning': 1,
            'suggestion': 2
        };
        
        return violations.sort((a, b) => 
            severityOrder[a.severity] - severityOrder[b.severity]
        );
    }
    
    /**
     * Format violations for agent prompt injection
     */
    formatViolationsForAgent(violations: RuleViolation[]): string {
        if (violations.length === 0) {
            return '';
        }
        
        const lines: string[] = [
            '',
            '⚠️ CONSTITUTION VIOLATIONS DETECTED:',
            ''
        ];
        
        const strictViolations = violations.filter(v => v.severity === 'strict');
        const warningViolations = violations.filter(v => v.severity === 'warning');
        const suggestionViolations = violations.filter(v => v.severity === 'suggestion');
        
        if (strictViolations.length > 0) {
            lines.push('🔴 CRITICAL (MUST FIX):');
            for (const v of strictViolations) {
                lines.push(this.formatSingleViolation(v));
            }
            lines.push('');
        }
        
        if (warningViolations.length > 0) {
            lines.push('🟡 WARNINGS (SHOULD FIX):');
            for (const v of warningViolations) {
                lines.push(this.formatSingleViolation(v));
            }
            lines.push('');
        }
        
        if (suggestionViolations.length > 0) {
            lines.push('🟢 SUGGESTIONS:');
            for (const v of suggestionViolations) {
                lines.push(this.formatSingleViolation(v));
            }
            lines.push('');
        }
        
        lines.push('Please address the CRITICAL violations before proceeding.');
        
        return lines.join('\n');
    }
    
    /**
     * Format a single violation
     */
    private formatSingleViolation(violation: RuleViolation): string {
        const rule = violation.rule;
        let text = `- ${rule.description}`;
        
        if (violation.filePath) {
            text += `\n  File: ${violation.filePath}`;
            if (violation.lineNumber) {
                text += `:${violation.lineNumber}`;
            }
        }
        
        if (rule.reason) {
            text += `\n  Reason: ${rule.reason}`;
        }
        
        // Check if it's a ForbiddenPattern with suggestion
        if ('suggestion' in rule && rule.suggestion) {
            text += `\n  Fix: ${rule.suggestion}`;
        }
        
        return text;
    }
    
    /**
     * Get summary of violations
     */
    getViolationsSummary(violations: RuleViolation[]): {
        total: number;
        strict: number;
        warning: number;
        suggestion: number;
        hasBlockers: boolean;
    } {
        const strict = violations.filter(v => v.severity === 'strict').length;
        const warning = violations.filter(v => v.severity === 'warning').length;
        const suggestion = violations.filter(v => v.severity === 'suggestion').length;
        
        return {
            total: violations.length,
            strict,
            warning,
            suggestion,
            hasBlockers: strict > 0
        };
    }
    
    /**
     * Check if violations should block completion
     */
    shouldBlockCompletion(violations: RuleViolation[]): boolean {
        return violations.some(v => v.severity === 'strict');
    }
    
    /**
     * Generate log message for violations
     */
    generateLogMessage(violations: RuleViolation[]): string {
        const summary = this.getViolationsSummary(violations);
        
        if (summary.total === 0) {
            return '> [Constitution]: ✅ No rule violations detected';
        }
        
        const parts: string[] = [];
        if (summary.strict > 0) {
            parts.push(`${summary.strict} critical`);
        }
        if (summary.warning > 0) {
            parts.push(`${summary.warning} warnings`);
        }
        if (summary.suggestion > 0) {
            parts.push(`${summary.suggestion} suggestions`);
        }
        
        const icon = summary.strict > 0 ? '❌' : summary.warning > 0 ? '⚠️' : 'ℹ️';
        
        return `> [Constitution]: ${icon} ${summary.total} violations detected (${parts.join(', ')})`;
    }
}

/**
 * Create a RuleEnforcer instance
 */
export function createRuleEnforcer(): RuleEnforcer {
    return new RuleEnforcer();
}

/**
 * Quick validation function for single file
 */
export async function validateFileContent(
    content: string,
    filePath: string,
    constitution?: ConstitutionV2
): Promise<RuleViolation[]> {
    const enforcer = createRuleEnforcer();
    
    if (constitution) {
        enforcer.setConstitution(constitution);
    }
    
    return enforcer.validateFileEdits([{
        path: filePath,
        type: 'modify',
        content
    }]);
}
