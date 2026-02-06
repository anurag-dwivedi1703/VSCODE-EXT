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

    // ========================================
    // Section 1: Project Identity
    // ========================================
    const identityMatch = markdown.match(/## 1\. Project Identity[\s\S]*?(?=## \d|---|\Z)/i);
    if (identityMatch) {
        const section = identityMatch[0];

        const nameMatch = section.match(/\*\*Name\*\*:\s*([^\n]+)/i);
        if (nameMatch) constitution.identity.name = nameMatch[1].trim();

        const typeMatch = section.match(/\*\*Type\*\*:\s*([^\n]+)/i);
        if (typeMatch) {
            const typeVal = typeMatch[1].trim().toLowerCase() as ProjectType;
            if (['extension', 'webapp', 'api', 'library', 'cli', 'monorepo', 'unknown'].includes(typeVal)) {
                constitution.identity.type = typeVal;
            }
        }

        const langMatch = section.match(/\*\*Primary Language\*\*:\s*([^\n]+)/i);
        if (langMatch) {
            const langVal = langMatch[1].trim().toLowerCase() as PrimaryLanguage;
            if (['typescript', 'javascript', 'python', 'java', 'go', 'rust', 'csharp', 'other'].includes(langVal)) {
                constitution.identity.primaryLanguage = langVal;
            }
        }

        const frameworkMatch = section.match(/\*\*Framework\*\*:\s*([^\n]+)/i);
        if (frameworkMatch) constitution.identity.framework = frameworkMatch[1].trim();

        const descMatch = section.match(/\*\*Description\*\*:\s*([^\n]+)/i);
        if (descMatch) constitution.identity.description = descMatch[1].trim();
    }

    // ========================================
    // Section 2: Critical Dependencies
    // ========================================
    const depsMatch = markdown.match(/## 2\. Critical Dependencies[\s\S]*?(?=## \d|---|$)/i);
    if (depsMatch) {
        const section = depsMatch[0];
        const tableRows = section.match(/\|[^|\n]+\|[^|\n]+\|[^|\n]+\|[^|\n]+\|/g) || [];

        // Parse into temporary array first
        const parsedDeps: CriticalDependency[] = [];

        for (const row of tableRows) {
            // Skip header and separator rows
            if (row.includes('Package') || row.includes('---') || row.includes('Version')) continue;

            const cells = row.split('|').filter(c => c.trim()).map(c => c.trim());
            if (cells.length >= 4) {
                parsedDeps.push({
                    name: cells[0],
                    version: cells[1],
                    reason: cells[2],
                    riskLevel: cells[3].toLowerCase() as 'critical' | 'high' | 'medium' | 'low'
                });
            }
        }

        // Only update if we parsed something OR if there's no existing data to preserve
        if (parsedDeps.length > 0 || constitution.criticalDependencies.length === 0) {
            constitution.criticalDependencies = parsedDeps;
        }
        // If parsedDeps is empty but we have existing data, keep the existing data
    }

    // ========================================
    // Section 3: Architecture Rules
    // ========================================
    const archMatch = markdown.match(/## 3\. Architecture Rules[\s\S]*?(?=## \d|---|\Z)/i);
    if (archMatch) {
        const section = archMatch[0];

        const patternMatch = section.match(/\*\*Pattern\*\*:\s*([^\n]+)/i);
        if (patternMatch) {
            const patternVal = patternMatch[1].trim().toLowerCase().replace(/[^a-z-]/g, '') as ArchitecturePattern;
            if (['mvc', 'hexagonal', 'clean', 'layered', 'feature-sliced', 'microservices', 'serverless', 'monolith', 'other'].includes(patternVal)) {
                constitution.architectureRules.pattern = patternVal;
            }
        }

        const entryMatch = section.match(/\*\*Entry Point\*\*:\s*`?([^`\n]+)`?/i);
        if (entryMatch) constitution.architectureRules.entryPoint = entryMatch[1].trim();

        // Parse module boundaries
        const boundariesMatch = section.match(/### Module Boundaries[\s\S]*?(?=###|## \d|---|\Z)/i);
        if (boundariesMatch) {
            const boundarySection = boundariesMatch[0];
            const boundaryLines = boundarySection.match(/\*\*([^*]+)\*\*:\s*([^\n]+)/g) || [];

            constitution.architectureRules.moduleBoundaries = [];
            for (const line of boundaryLines) {
                const match = line.match(/\*\*([^*]+)\*\*:\s*([^\n]+)/);
                if (match) {
                    constitution.architectureRules.moduleBoundaries.push({
                        name: match[1].trim(),
                        purpose: match[2].trim(),
                        includes: [match[1].trim().toLowerCase()]
                    });
                }
            }
        }

        // Parse import rules
        const importRulesMatch = section.match(/### Import Rules[\s\S]*?(?=###|## \d|---|\Z)/i);
        if (importRulesMatch) {
            const importSection = importRulesMatch[0];
            const ruleLines = importSection.split('\n').filter(l => l.trim().startsWith('-'));

            constitution.architectureRules.importRules = [];
            for (let i = 0; i < ruleLines.length; i++) {
                const line = ruleLines[i].replace(/^-\s*/, '').trim();
                if (line.includes('cannot import') || line.includes('should not import')) {
                    constitution.architectureRules.importRules.push({
                        id: `import-rule-${i}`,
                        from: 'auto-detected',
                        cannotImport: [],
                        reason: line
                    });
                }
            }
        }
    }

    // ========================================
    // Section 5: Forbidden Patterns
    // ========================================
    const forbiddenMatch = markdown.match(/## 5\. Forbidden Patterns[\s\S]*?(?=## \d|---|\Z)/i);
    if (forbiddenMatch) {
        const section = forbiddenMatch[0];
        const patterns = section.split(/(?=- ❌|\*\*[^*]+\*\*)/);

        constitution.forbiddenPatterns = [];

        for (const pattern of patterns) {
            const descMatch = pattern.match(/(?:❌\s*)?(?:\*\*)?([^*\n]+)(?:\*\*)?/);
            const reasonMatch = pattern.match(/Reason:\s*([^\n]+)/i);
            const insteadMatch = pattern.match(/Instead:\s*([^\n]+)/i);

            if (descMatch && descMatch[1].trim() && !descMatch[1].includes('Forbidden Patterns')) {
                constitution.forbiddenPatterns.push({
                    id: `forbidden-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    description: descMatch[1].trim().replace(/^-\s*/, ''),
                    reason: reasonMatch ? reasonMatch[1].trim() : 'Pattern forbidden by constitution',
                    enforcement: 'warning',
                    autoDetected: false,
                    suggestion: insteadMatch ? insteadMatch[1].trim() : undefined
                });
            }
        }
    }

    // ========================================
    // Section 6: Testing Requirements
    // ========================================
    const testingMatch = markdown.match(/## 6\. Testing Requirements[\s\S]*?(?=## \d|---|\Z)/i);
    if (testingMatch) {
        const section = testingMatch[0];

        const frameworkMatch = section.match(/\*\*Framework\*\*:\s*([^\n]+)/i);
        if (frameworkMatch) {
            const fw = frameworkMatch[1].trim().toLowerCase() as TestFramework;
            if (['jest', 'mocha', 'vitest', 'playwright', 'cypress', 'pytest', 'junit', 'other'].includes(fw)) {
                constitution.testingRequirements.framework = fw;
            }
        }

        const patternMatch = section.match(/\*\*Test Pattern\*\*:\s*`?([^`\n]+)`?/i);
        if (patternMatch) constitution.testingRequirements.testFilePattern = patternMatch[1].trim();

        const coverageMatch = section.match(/\*\*Coverage Minimum\*\*:\s*(\d+)/i);
        if (coverageMatch) constitution.testingRequirements.coverageMinimum = parseInt(coverageMatch[1], 10);

        const typesMatch = section.match(/\*\*Required Test Types\*\*:\s*([^\n]+)/i);
        if (typesMatch) {
            const types = typesMatch[1].split(/[,\s]+/).filter(t => t.trim());
            constitution.testingRequirements.requiredTestTypes = types.map(t => t.toLowerCase().trim() as TestType);
        }
    }

    // ========================================
    // Section 7: Agent Constraints
    // ========================================
    const constraintsMatch = markdown.match(/## 7\. Agent Constraints[\s\S]*?(?=## \d|---|\Z)/i);
    if (constraintsMatch) {
        const section = constraintsMatch[0];

        // Parse MUST rules
        const mustMatch = section.match(/### MUST\b[\s\S]*?(?=###|## \d|---|\Z)/i);
        if (mustMatch) {
            const mustSection = mustMatch[0];
            const rules = parseAgentRules(mustSection, 'strict');
            constitution.agentConstraints.must = rules;
        }

        // Parse MUST NOT rules
        const mustNotMatch = section.match(/### MUST NOT\b[\s\S]*?(?=###|## \d|---|\Z)/i);
        if (mustNotMatch) {
            const mustNotSection = mustNotMatch[0];
            const rules = parseAgentRules(mustNotSection, 'strict');
            constitution.agentConstraints.mustNot = rules;
        }

        // Parse SHOULD rules
        const shouldMatch = section.match(/### SHOULD\b[\s\S]*?(?=###|## \d|---|\Z)/i);
        if (shouldMatch) {
            const shouldSection = shouldMatch[0];
            const rules = parseAgentRules(shouldSection, 'suggestion');
            constitution.agentConstraints.should = rules;
        }
    }

    // ========================================
    // Section 8: Custom Rules
    // ========================================
    const customRulesMatch = markdown.match(/## 8\. Custom Rules[\s\S]*?(?=## \d|---|\Z)/);
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

            if (description && !description.startsWith('[') && !description.startsWith('*')) {
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

/**
 * Helper function to parse agent rules from a markdown section.
 */
function parseAgentRules(section: string, defaultEnforcement: EnforcementLevel): AgentRule[] {
    const rules: AgentRule[] = [];
    const lines = section.split('\n').filter(line => {
        const trimmed = line.trim();
        return trimmed.startsWith('-') || trimmed.startsWith('✅') || trimmed.startsWith('❌') || trimmed.startsWith('💡');
    });

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cleanLine = line.replace(/^[-✅❌💡]\s*/, '').trim();

        if (cleanLine && !cleanLine.startsWith('[') && !cleanLine.startsWith('*')) {
            // Check for reason on next line
            let reason: string | undefined;
            if (i + 1 < lines.length) {
                const nextLine = lines[i + 1].trim();
                if (nextLine.startsWith('*Reason:') || nextLine.startsWith('- *Reason:')) {
                    reason = nextLine.replace(/^[-\s]*\*Reason:\s*/i, '').replace(/\*$/, '').trim();
                }
            }

            rules.push({
                id: `rule-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                description: cleanLine,
                enforcement: defaultEnforcement,
                autoDetect: false,
                reason
            });
        }
    }

    return rules;
}

// ============================================
// CONSTITUTION VALIDATION
// ============================================

/**
 * Validation result for a constitution
 */
export interface ConstitutionValidationResult {
    /** Whether the constitution is valid */
    isValid: boolean;
    /** Validation errors (critical issues) */
    errors: string[];
    /** Validation warnings (non-critical issues) */
    warnings: string[];
    /** Detected sections */
    detectedSections: string[];
    /** Missing required sections */
    missingSections: string[];
}

/**
 * Required sections that must be present in a valid constitution
 */
const REQUIRED_SECTIONS = [
    { pattern: /## 1\. Project Identity/i, name: 'Project Identity' },
    { pattern: /## 7\. Agent Constraints/i, name: 'Agent Constraints' },
];

/**
 * Optional but recommended sections
 */
const RECOMMENDED_SECTIONS = [
    { pattern: /## 2\. Critical Dependencies/i, name: 'Critical Dependencies' },
    { pattern: /## 3\. Architecture Rules/i, name: 'Architecture Rules' },
    { pattern: /## 4\. Coding Standards/i, name: 'Coding Standards' },
    { pattern: /## 5\. Forbidden Patterns/i, name: 'Forbidden Patterns' },
    { pattern: /## 6\. Testing Requirements/i, name: 'Testing Requirements' },
    { pattern: /## 8\. Custom Rules/i, name: 'Custom Rules' },
];

/**
 * Validate a constitution markdown string.
 * Checks for required sections, proper structure, and common issues.
 * 
 * @param markdown The constitution markdown content to validate
 * @returns Validation result with errors, warnings, and detected sections
 */
export function validateConstitutionMarkdown(markdown: string): ConstitutionValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const detectedSections: string[] = [];
    const missingSections: string[] = [];

    // Basic validation
    if (!markdown || markdown.trim().length === 0) {
        return {
            isValid: false,
            errors: ['Constitution is empty'],
            warnings: [],
            detectedSections: [],
            missingSections: REQUIRED_SECTIONS.map(s => s.name)
        };
    }

    // Check minimum length (constitution should have meaningful content)
    if (markdown.length < 200) {
        errors.push('Constitution is too short (less than 200 characters). May be incomplete or malformed.');
    }

    // Check for title/header
    if (!markdown.match(/^#\s+.*(Constitution|Rules|Guidelines)/im)) {
        warnings.push('Constitution should start with a title header (e.g., "# Workspace Constitution")');
    }

    // Check required sections
    for (const section of REQUIRED_SECTIONS) {
        if (section.pattern.test(markdown)) {
            detectedSections.push(section.name);
        } else {
            missingSections.push(section.name);
            errors.push(`Missing required section: ${section.name}`);
        }
    }

    // Check recommended sections
    for (const section of RECOMMENDED_SECTIONS) {
        if (section.pattern.test(markdown)) {
            detectedSections.push(section.name);
        } else {
            warnings.push(`Missing recommended section: ${section.name}`);
        }
    }

    // Check for Agent Constraints subsections (MUST/MUST NOT/SHOULD)
    const hasAgentConstraints = /## 7\. Agent Constraints/i.test(markdown);
    if (hasAgentConstraints) {
        const hasMust = /### MUST\b/i.test(markdown);
        const hasMustNot = /### MUST NOT\b/i.test(markdown);
        const hasShould = /### SHOULD\b/i.test(markdown);

        if (!hasMust && !hasMustNot && !hasShould) {
            warnings.push('Agent Constraints section exists but has no MUST/MUST NOT/SHOULD subsections');
        }

        // Check for actual rules in the subsections
        if (hasMust && !/### MUST\b[\s\S]*?-\s+[✅\w]/i.test(markdown)) {
            warnings.push('MUST section exists but appears to have no rules');
        }
        if (hasMustNot && !/### MUST NOT\b[\s\S]*?-\s+[❌\w]/i.test(markdown)) {
            warnings.push('MUST NOT section exists but appears to have no rules');
        }
    }

    // Check for common formatting issues
    if (markdown.includes('```json') && !markdown.includes('```')) {
        warnings.push('Unclosed JSON code block detected');
    }

    // Check for malformed markdown tables
    const tableHeaders = markdown.match(/\|[^|]+\|[^|]+\|/g) || [];
    const tableSeparators = markdown.match(/\|[-:]+\|[-:]+\|/g) || [];
    if (tableHeaders.length > 0 && tableSeparators.length === 0) {
        warnings.push('Markdown table(s) detected without proper separator rows');
    }

    // Check for very long lines (may indicate malformed content)
    const lines = markdown.split('\n');
    const veryLongLines = lines.filter(line => line.length > 500);
    if (veryLongLines.length > 0) {
        warnings.push(`${veryLongLines.length} very long line(s) detected (>500 chars). May indicate malformed content.`);
    }

    // Check for duplicate section headers
    const sectionHeaders = markdown.match(/^##\s+\d+\.\s+.+$/gm) || [];
    const headerSet = new Set<string>();
    for (const header of sectionHeaders) {
        const normalized = header.toLowerCase().trim();
        if (headerSet.has(normalized)) {
            warnings.push(`Duplicate section header detected: ${header}`);
        }
        headerSet.add(normalized);
    }

    // Check for placeholder text that wasn't filled in
    const placeholderPatterns = [
        /\[your rule here\]/i,
        /\[enter .+\]/i,
        /\[placeholder\]/i,
        /\[TODO\]/i,
        /\[FILL IN\]/i
    ];
    for (const pattern of placeholderPatterns) {
        if (pattern.test(markdown)) {
            warnings.push('Constitution contains unfilled placeholder text');
            break;
        }
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
        detectedSections,
        missingSections
    };
}

/**
 * Attempt to repair a malformed constitution by ensuring required sections exist.
 * Returns the repaired markdown or the original if repair isn't needed.
 * 
 * @param markdown The potentially malformed constitution
 * @param projectName Optional project name for fallback content
 * @returns Repaired constitution markdown
 */
export function repairConstitutionMarkdown(markdown: string, projectName: string = 'Unknown Project'): string {
    const validation = validateConstitutionMarkdown(markdown);

    // If already valid, return as-is
    if (validation.isValid) {
        return markdown;
    }

    let repaired = markdown;

    // Add missing title if needed
    if (!markdown.match(/^#\s+.*(Constitution|Rules|Guidelines)/im)) {
        repaired = `# Workspace Constitution\n\n${repaired}`;
    }

    // Add missing Project Identity section
    if (!validation.detectedSections.includes('Project Identity')) {
        const identitySection = `
## 1. Project Identity

- **Name**: ${projectName}
- **Type**: unknown
- **Primary Language**: other

`;
        // Insert after title
        const titleMatch = repaired.match(/^#\s+.+\n/);
        if (titleMatch) {
            const insertPos = titleMatch[0].length;
            repaired = repaired.slice(0, insertPos) + '\n' + identitySection + repaired.slice(insertPos);
        } else {
            repaired = identitySection + repaired;
        }
    }

    // Add missing Agent Constraints section
    if (!validation.detectedSections.includes('Agent Constraints')) {
        const constraintsSection = `
## 7. Agent Constraints (ENFORCED)

### MUST
- ✅ Verify changes compile/lint before marking task complete

### MUST NOT
- ❌ Modify files in node_modules/ or .git/
- ❌ Change version numbers without explicit approval

### SHOULD
- 💡 Prefer existing utilities over new implementations

`;
        // Append before Custom Rules or at end
        if (repaired.includes('## 8. Custom Rules')) {
            repaired = repaired.replace('## 8. Custom Rules', constraintsSection + '\n## 8. Custom Rules');
        } else {
            repaired = repaired + '\n' + constraintsSection;
        }
    }

    return repaired;
}
