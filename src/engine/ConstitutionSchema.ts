/**
 * ConstitutionSchema.ts
 * 
 * Defines the typed, structured format for the workspace constitution.
 * The constitution is the "Agent Bible" - a set of rules that agents MUST follow.
 * 
 * This schema enables:
 * - Structured generation (not raw config dumps)
 * - Rule enforcement validation
 * - User customization with guidance
 * - Corporate guidelines integration
 */

// ============================================
// CORE TYPES
// ============================================

/**
 * Current schema version for migration support
 */
export const CONSTITUTION_VERSION = '2.0';

/**
 * Project type classification
 */
export type ProjectType = 
    | 'extension'      // VS Code extension
    | 'webapp'         // Web application (React, Vue, etc.)
    | 'api'            // Backend API service
    | 'library'        // Reusable library/package
    | 'cli'            // Command-line tool
    | 'monorepo'       // Multi-package repository
    | 'unknown';       // Could not determine

/**
 * Primary programming language
 */
export type PrimaryLanguage = 
    | 'typescript'
    | 'javascript'
    | 'python'
    | 'java'
    | 'go'
    | 'rust'
    | 'csharp'
    | 'other';

/**
 * Rule enforcement level
 */
export type EnforcementLevel = 
    | 'strict'       // Error - must be fixed immediately
    | 'warning'      // Warning - should be fixed
    | 'suggestion';  // Suggestion - nice to have

/**
 * Risk level for dependencies
 */
export type RiskLevel = 
    | 'critical'     // Breaking changes will break the system
    | 'high'         // Major impact on functionality
    | 'medium'       // Moderate impact
    | 'low';         // Minor impact

// ============================================
// IDENTITY
// ============================================

/**
 * Project identity information
 */
export interface ProjectIdentity {
    /** Project name from package.json or directory */
    name: string;
    /** Inferred project type */
    type: ProjectType;
    /** Primary programming language */
    primaryLanguage: PrimaryLanguage;
    /** Secondary languages if any */
    secondaryLanguages?: PrimaryLanguage[];
    /** Framework in use (React, Express, FastAPI, etc.) */
    framework?: string;
    /** Brief description */
    description?: string;
}

// ============================================
// DEPENDENCIES
// ============================================

/**
 * Critical dependency that should not be modified without care
 */
export interface CriticalDependency {
    /** Package name */
    name: string;
    /** Current version or version range */
    version: string;
    /** Why this dependency is critical */
    reason: string;
    /** Risk level if modified */
    riskLevel: RiskLevel;
    /** Is this a dev dependency? */
    isDev?: boolean;
    /** Known breaking versions to avoid */
    avoidVersions?: string[];
}

/**
 * Detected circular import issue
 */
export interface CircularImport {
    /** Files involved in the cycle */
    cycle: string[];
    /** Severity of the issue */
    severity: 'error' | 'warning';
    /** Suggested fix */
    suggestion?: string;
}

/**
 * Dependency analysis result
 */
export interface DependencyAnalysis {
    /** Critical dependencies */
    critical: CriticalDependency[];
    /** Total dependency count */
    totalDependencies: number;
    /** Dev dependency count */
    devDependencies: number;
    /** Detected circular imports */
    circularImports: CircularImport[];
    /** Outdated packages (if detected) */
    outdated?: string[];
    /** Security vulnerabilities (if detected) */
    vulnerabilities?: SecurityVulnerability[];
}

/**
 * Security vulnerability in a dependency
 */
export interface SecurityVulnerability {
    /** Package name */
    package: string;
    /** Severity level */
    severity: 'critical' | 'high' | 'moderate' | 'low';
    /** CVE or advisory ID */
    advisoryId?: string;
    /** Brief description */
    description: string;
    /** Fixed in version */
    fixedIn?: string;
}

// ============================================
// ARCHITECTURE
// ============================================

/**
 * Architecture pattern type
 */
export type ArchitecturePattern = 
    | 'mvc'              // Model-View-Controller
    | 'mvvm'             // Model-View-ViewModel
    | 'hexagonal'        // Ports and Adapters
    | 'clean'            // Clean Architecture
    | 'feature-sliced'   // Feature-Sliced Design
    | 'layered'          // Traditional layered
    | 'microservices'    // Microservices
    | 'monolithic'       // Monolithic
    | 'serverless'       // Serverless functions
    | 'unknown';

/**
 * Architecture rules for the project
 */
export interface ArchitectureRules {
    /** Detected architecture pattern */
    pattern: ArchitecturePattern;
    /** Main entry point file */
    entryPoint?: string;
    /** Module/folder boundaries that should be respected */
    moduleBoundaries: ModuleBoundary[];
    /** Import direction rules (e.g., "services can't import from controllers") */
    importRules: ImportRule[];
}

/**
 * Module boundary definition
 */
export interface ModuleBoundary {
    /** Module name/path */
    name: string;
    /** Description of the module's purpose */
    purpose: string;
    /** Folders included in this module */
    includes: string[];
    /** This module should not import from these modules */
    cannotImportFrom?: string[];
}

/**
 * Import direction rule
 */
export interface ImportRule {
    /** Rule ID */
    id: string;
    /** From path pattern */
    from: string;
    /** Cannot import from these patterns */
    cannotImport: string[];
    /** Reason for this rule */
    reason: string;
}

// ============================================
// CODING STANDARDS
// ============================================

/**
 * Coding standard extracted from linter configs
 */
export interface CodingStandard {
    /** Standard ID (e.g., 'semi', 'quotes') */
    id: string;
    /** Human-readable description */
    description: string;
    /** The expected value/behavior */
    value: string;
    /** Enforcement level */
    enforcement: EnforcementLevel;
    /** Source config file */
    source?: string;
}

/**
 * Coding standards collection
 */
export interface CodingStandardsCollection {
    /** Formatting rules */
    formatting: CodingStandard[];
    /** Naming conventions */
    naming: CodingStandard[];
    /** Import organization rules */
    imports: CodingStandard[];
    /** Other standards */
    other: CodingStandard[];
}

// ============================================
// FORBIDDEN PATTERNS
// ============================================

/**
 * Pattern that is forbidden in the codebase
 */
export interface ForbiddenPattern {
    /** Pattern ID */
    id: string;
    /** Human-readable description */
    description: string;
    /** Regex pattern to detect (as string for JSON serialization) */
    pattern?: string;
    /** File patterns this applies to (e.g., '*.ts', 'src/**') */
    appliesTo?: string[];
    /** Why this pattern is forbidden */
    reason: string;
    /** Enforcement level */
    enforcement: EnforcementLevel;
    /** Was this auto-detected? */
    autoDetected: boolean;
    /** Suggested alternative */
    suggestion?: string;
}

// ============================================
// TESTING REQUIREMENTS
// ============================================

/**
 * Testing framework type
 */
export type TestFramework = 
    | 'jest'
    | 'mocha'
    | 'vitest'
    | 'playwright'
    | 'cypress'
    | 'pytest'
    | 'junit'
    | 'other';

/**
 * Test type classification
 */
export type TestType = 'unit' | 'integration' | 'e2e' | 'smoke' | 'performance';

/**
 * Testing requirements for the project
 */
export interface TestingRequirements {
    /** Primary test framework */
    framework: TestFramework;
    /** Additional test frameworks */
    additionalFrameworks?: TestFramework[];
    /** Test file location pattern */
    testFilePattern: string;
    /** Minimum coverage percentage (if enforced) */
    coverageMinimum?: number;
    /** Required test types */
    requiredTestTypes: TestType[];
    /** Test commands */
    testCommands: {
        unit?: string;
        integration?: string;
        e2e?: string;
        all: string;
    };
}

// ============================================
// AGENT RULES
// ============================================

/**
 * A rule that agents must follow
 */
export interface AgentRule {
    /** Unique rule ID */
    id: string;
    /** Human-readable description */
    description: string;
    /** Enforcement level */
    enforcement: EnforcementLevel;
    /** Can this rule be auto-detected/validated? */
    autoDetect: boolean;
    /** Regex pattern for auto-detection (as string) */
    pattern?: string;
    /** File patterns this applies to */
    appliesTo?: string[];
    /** Reason for this rule */
    reason?: string;
    /** Is this a user-defined rule? */
    userDefined?: boolean;
    /** Category for grouping */
    category?: string;
}

/**
 * Agent constraints collection
 */
export interface AgentConstraints {
    /** Rules the agent MUST follow (strict) */
    must: AgentRule[];
    /** Rules the agent MUST NOT violate (strict) */
    mustNot: AgentRule[];
    /** Rules the agent SHOULD follow (warning/suggestion) */
    should: AgentRule[];
}

// ============================================
// MAIN CONSTITUTION INTERFACE
// ============================================

/**
 * The complete workspace constitution (v2.0)
 * This is the "Agent Bible" - the source of truth for workspace rules.
 */
export interface ConstitutionV2 {
    /** Schema version */
    version: '2.0';
    /** When this constitution was generated/updated */
    generatedAt: string;
    /** Project identity */
    identity: ProjectIdentity;
    /** Critical dependencies */
    criticalDependencies: CriticalDependency[];
    /** Architecture rules */
    architectureRules: ArchitectureRules;
    /** Coding standards from linters */
    codingStandards: CodingStandardsCollection;
    /** Forbidden patterns */
    forbiddenPatterns: ForbiddenPattern[];
    /** Testing requirements */
    testingRequirements: TestingRequirements;
    /** Agent constraints (MUST/MUST NOT/SHOULD) */
    agentConstraints: AgentConstraints;
    /** User-defined custom rules */
    customRules: AgentRule[];
    /** Corporate guidelines enabled */
    corporateGuidelines?: {
        security: boolean;
        performance: boolean;
        maintainability: boolean;
    };
}

// ============================================
// RULE VIOLATION
// ============================================

/**
 * A detected rule violation
 */
export interface RuleViolation {
    /** The rule that was violated */
    rule: AgentRule | ForbiddenPattern;
    /** File where the violation occurred */
    filePath: string;
    /** Line number if applicable */
    lineNumber?: number;
    /** The violating content */
    content?: string;
    /** Severity of the violation */
    severity: EnforcementLevel;
    /** Timestamp of detection */
    detectedAt: string;
}

// ============================================
// WORKSPACE ANALYSIS RESULT
// ============================================

/**
 * Complete workspace analysis result (input for constitution generation)
 */
export interface WorkspaceAnalysis {
    /** Project identity */
    identity: ProjectIdentity;
    /** Dependency analysis */
    dependencies: DependencyAnalysis;
    /** Detected lint rules */
    lintRules: CodingStandard[];
    /** Detected risks */
    risks: DetectedRisk[];
    /** File tree summary */
    fileTreeSummary: string;
    /** High-leverage files found */
    highLeverageFiles: string[];
}

/**
 * A detected risk in the workspace
 */
export interface DetectedRisk {
    /** Risk ID */
    id: string;
    /** Risk type */
    type: 'secret' | 'security' | 'stability' | 'performance' | 'maintainability';
    /** Description */
    description: string;
    /** Severity */
    severity: EnforcementLevel;
    /** File where detected */
    file?: string;
    /** Line number */
    line?: number;
    /** Suggested fix */
    suggestion?: string;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Create a default/empty constitution structure
 */
export function createEmptyConstitution(projectName: string = 'Unknown'): ConstitutionV2 {
    return {
        version: '2.0',
        generatedAt: new Date().toISOString(),
        identity: {
            name: projectName,
            type: 'unknown',
            primaryLanguage: 'other'
        },
        criticalDependencies: [],
        architectureRules: {
            pattern: 'unknown',
            moduleBoundaries: [],
            importRules: []
        },
        codingStandards: {
            formatting: [],
            naming: [],
            imports: [],
            other: []
        },
        forbiddenPatterns: [],
        testingRequirements: {
            framework: 'other',
            testFilePattern: '**/*.test.*',
            requiredTestTypes: [],
            testCommands: { all: 'npm test' }
        },
        agentConstraints: {
            must: [],
            mustNot: [],
            should: []
        },
        customRules: []
    };
}

/**
 * Convert ConstitutionV2 to markdown for display/storage
 */
export function constitutionToMarkdown(constitution: ConstitutionV2): string {
    const lines: string[] = [];
    
    lines.push(`# Workspace Constitution v${constitution.version}`);
    lines.push('');
    lines.push(`> Generated: ${constitution.generatedAt}`);
    lines.push('');
    
    // Identity
    lines.push('## 1. Project Identity');
    lines.push('');
    lines.push(`- **Name**: ${constitution.identity.name}`);
    lines.push(`- **Type**: ${constitution.identity.type}`);
    lines.push(`- **Primary Language**: ${constitution.identity.primaryLanguage}`);
    if (constitution.identity.framework) {
        lines.push(`- **Framework**: ${constitution.identity.framework}`);
    }
    if (constitution.identity.description) {
        lines.push(`- **Description**: ${constitution.identity.description}`);
    }
    lines.push('');
    
    // Critical Dependencies
    lines.push('## 2. Critical Dependencies (DO NOT MODIFY WITHOUT REVIEW)');
    lines.push('');
    if (constitution.criticalDependencies.length > 0) {
        lines.push('| Package | Version | Reason | Risk Level |');
        lines.push('|---------|---------|--------|------------|');
        for (const dep of constitution.criticalDependencies) {
            lines.push(`| ${dep.name} | ${dep.version} | ${dep.reason} | ${dep.riskLevel.toUpperCase()} |`);
        }
    } else {
        lines.push('*No critical dependencies identified*');
    }
    lines.push('');
    
    // Architecture Rules
    lines.push('## 3. Architecture Rules');
    lines.push('');
    lines.push(`- **Pattern**: ${constitution.architectureRules.pattern}`);
    if (constitution.architectureRules.entryPoint) {
        lines.push(`- **Entry Point**: \`${constitution.architectureRules.entryPoint}\``);
    }
    if (constitution.architectureRules.moduleBoundaries.length > 0) {
        lines.push('');
        lines.push('### Module Boundaries');
        for (const boundary of constitution.architectureRules.moduleBoundaries) {
            lines.push(`- **${boundary.name}**: ${boundary.purpose}`);
        }
    }
    if (constitution.architectureRules.importRules.length > 0) {
        lines.push('');
        lines.push('### Import Rules');
        for (const rule of constitution.architectureRules.importRules) {
            lines.push(`- ${rule.from} cannot import from ${rule.cannotImport.join(', ')} (${rule.reason})`);
        }
    }
    lines.push('');
    
    // Coding Standards
    lines.push('## 4. Coding Standards');
    lines.push('');
    const allStandards = [
        ...constitution.codingStandards.formatting,
        ...constitution.codingStandards.naming,
        ...constitution.codingStandards.imports,
        ...constitution.codingStandards.other
    ];
    if (allStandards.length > 0) {
        for (const standard of allStandards) {
            const icon = standard.enforcement === 'strict' ? '🔴' : 
                        standard.enforcement === 'warning' ? '🟡' : '🟢';
            lines.push(`- ${icon} **${standard.description}**: ${standard.value}`);
        }
    } else {
        lines.push('*No specific coding standards detected*');
    }
    lines.push('');
    
    // Forbidden Patterns
    lines.push('## 5. Forbidden Patterns');
    lines.push('');
    if (constitution.forbiddenPatterns.length > 0) {
        for (const pattern of constitution.forbiddenPatterns) {
            const icon = pattern.enforcement === 'strict' ? '❌' : '⚠️';
            lines.push(`- ${icon} **${pattern.description}**`);
            lines.push(`  - Reason: ${pattern.reason}`);
            if (pattern.suggestion) {
                lines.push(`  - Instead: ${pattern.suggestion}`);
            }
        }
    } else {
        lines.push('*No forbidden patterns defined*');
    }
    lines.push('');
    
    // Testing Requirements
    lines.push('## 6. Testing Requirements');
    lines.push('');
    lines.push(`- **Framework**: ${constitution.testingRequirements.framework}`);
    lines.push(`- **Test Pattern**: \`${constitution.testingRequirements.testFilePattern}\``);
    if (constitution.testingRequirements.coverageMinimum) {
        lines.push(`- **Coverage Minimum**: ${constitution.testingRequirements.coverageMinimum}%`);
    }
    if (constitution.testingRequirements.requiredTestTypes.length > 0) {
        lines.push(`- **Required Test Types**: ${constitution.testingRequirements.requiredTestTypes.join(', ')}`);
    }
    lines.push('');
    
    // Agent Constraints
    lines.push('## 7. Agent Constraints (ENFORCED)');
    lines.push('');
    
    if (constitution.agentConstraints.must.length > 0) {
        lines.push('### MUST');
        for (const rule of constitution.agentConstraints.must) {
            lines.push(`- ✅ ${rule.description}`);
            if (rule.reason) {
                lines.push(`  - *Reason: ${rule.reason}*`);
            }
        }
        lines.push('');
    }
    
    if (constitution.agentConstraints.mustNot.length > 0) {
        lines.push('### MUST NOT');
        for (const rule of constitution.agentConstraints.mustNot) {
            lines.push(`- ❌ ${rule.description}`);
            if (rule.reason) {
                lines.push(`  - *Reason: ${rule.reason}*`);
            }
        }
        lines.push('');
    }
    
    if (constitution.agentConstraints.should.length > 0) {
        lines.push('### SHOULD');
        for (const rule of constitution.agentConstraints.should) {
            lines.push(`- 💡 ${rule.description}`);
            if (rule.reason) {
                lines.push(`  - *Reason: ${rule.reason}*`);
            }
        }
        lines.push('');
    }
    
    // Custom Rules
    lines.push('## 8. Custom Rules (User-Defined)');
    lines.push('');
    if (constitution.customRules.length > 0) {
        for (const rule of constitution.customRules) {
            const icon = rule.enforcement === 'strict' ? '🔴' : 
                        rule.enforcement === 'warning' ? '🟡' : '🟢';
            lines.push(`- ${icon} ${rule.description}`);
        }
    } else {
        lines.push('*Add custom rules here using the format:*');
        lines.push('```');
        lines.push('- MUST: [Your rule here]');
        lines.push('- MUST NOT: [Your rule here]');
        lines.push('- SHOULD: [Your rule here]');
        lines.push('```');
    }
    lines.push('');
    
    lines.push('---');
    lines.push('*This constitution is the source of truth for AI agents working in this workspace.*');
    
    return lines.join('\n');
}

/**
 * Parse markdown constitution back to structured format
 * This is a best-effort parser for user-edited constitutions
 */
export function parseMarkdownConstitution(markdown: string, existingConstitution?: ConstitutionV2): ConstitutionV2 {
    const constitution = existingConstitution || createEmptyConstitution();
    
    // Parse custom rules section
    const customRulesMatch = markdown.match(/## 8\. Custom Rules[\s\S]*?(?=##|---|\Z)/);
    if (customRulesMatch) {
        const customRulesSection = customRulesMatch[0];
        const ruleLines = customRulesSection.split('\n').filter(line => line.trim().startsWith('- '));
        
        constitution.customRules = [];
        
        for (const line of ruleLines) {
            const cleanLine = line.replace(/^-\s*[🔴🟡🟢❌✅💡]*\s*/, '').trim();
            
            let enforcement: EnforcementLevel = 'suggestion';
            let description = cleanLine;
            
            if (cleanLine.startsWith('MUST NOT:')) {
                enforcement = 'strict';
                description = cleanLine.replace('MUST NOT:', '').trim();
            } else if (cleanLine.startsWith('MUST:')) {
                enforcement = 'strict';
                description = cleanLine.replace('MUST:', '').trim();
            } else if (cleanLine.startsWith('SHOULD:')) {
                enforcement = 'warning';
                description = cleanLine.replace('SHOULD:', '').trim();
            }
            
            if (description && !description.startsWith('[')) {
                constitution.customRules.push({
                    id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    description,
                    enforcement,
                    autoDetect: false,
                    userDefined: true
                });
            }
        }
    }
    
    constitution.generatedAt = new Date().toISOString();
    
    return constitution;
}
