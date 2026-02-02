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
    EnforcementLevel
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
        
        return violations;
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
