import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    ConstitutionV2,
    WorkspaceAnalysis,
    createEmptyConstitution,
    constitutionToMarkdown,
    parseMarkdownConstitution,
    validateConstitutionMarkdown,
    repairConstitutionMarkdown,
    ConstitutionValidationResult,
    CodingStandard,
    ProjectIdentity,
    CriticalDependency,
    AgentRule,
    ForbiddenPattern
} from './ConstitutionSchema';
import {
    CorporateGuidelinesConfig,
    DEFAULT_GUIDELINES_CONFIG,
    getEnabledGuidelines,
    guidelinesToAgentConstraints
} from './CorporateGuidelines';

/**
 * Phases of the Spec-Kit lifecycle.
 */
export enum SpecPhase {
    IDLE = 'IDLE',                              // No active mission
    CONSTITUTION_GENERATION = 'CONSTITUTION',   // Scanning workspace, generating constitution
    CONSTITUTION_REVIEW = 'REVIEW',             // Waiting for user approval
    DRIFT_DETECTION = 'DRIFT',                  // Comparing current repo state with constitution
    SPECIFICATION = 'SPEC',                     // Mission in progress
    POST_MISSION_REVIEW = 'POST_REVIEW'         // Checking if constitution needs updates
}

/**
 * Result of drift detection comparison.
 */
export interface DriftResult {
    hasDrift: boolean;
    driftSummary: string;
    suggestedUpdates: string;
}

/**
 * Result of post-mission update check.
 */
export interface UpdateCheckResult {
    needsUpdate: boolean;
    suggestedChanges: string;
}

/**
 * SpecManager - Core state machine for Spec-Kit lifecycle.
 * 
 * Manages the constitution.md file which governs workspace rules,
 * patterns, and constraints that the AI agent must follow.
 */
export class SpecManager {
    private _phase: SpecPhase = SpecPhase.IDLE;
    private _constitution: string = '';
    private _constitutionPath: string = '';
    private _workspaceRoot: string = '';
    private _structuredConstitution: ConstitutionV2 | null = null;
    private _guidelinesConfig: CorporateGuidelinesConfig = DEFAULT_GUIDELINES_CONFIG;

    // File watcher for external constitution changes
    private _watcher: vscode.FileSystemWatcher | null = null;
    private _onConstitutionChanged = new vscode.EventEmitter<{ type: 'changed' | 'deleted'; content?: string }>();

    /**
     * Event that fires when the constitution file is changed externally.
     * Subscribe to this to reload the constitution in your components.
     */
    public readonly onConstitutionChanged = this._onConstitutionChanged.event;

    /**
     * Initialize the SpecManager for a workspace.
     * Loads existing constitution if present.
     */
    async initialize(workspaceRoot: string): Promise<void> {
        this._workspaceRoot = workspaceRoot;

        // Constitution lives in .vibearchitect/constitution.md
        const specifyDir = path.join(workspaceRoot, '.vibearchitect');
        this._constitutionPath = path.join(specifyDir, 'constitution.md');

        if (fs.existsSync(this._constitutionPath)) {
            try {
                this._constitution = fs.readFileSync(this._constitutionPath, 'utf-8');
                console.log(`[SpecManager] Loaded existing constitution from ${this._constitutionPath}`);
            } catch (error) {
                console.error(`[SpecManager] Failed to read constitution:`, error);
                this._constitution = '';
            }
        } else {
            console.log(`[SpecManager] No constitution found at ${this._constitutionPath}`);
            this._constitution = '';
        }
    }

    /**
     * Check if the workspace has an existing constitution.
     */
    hasConstitution(): boolean {
        return this._constitution.length > 0;
    }

    /**
     * Get the current constitution content.
     */
    getConstitution(): string {
        return this._constitution;
    }

    /**
     * Get constitution file path.
     */
    getConstitutionPath(): string {
        return this._constitutionPath;
    }

    /**
     * Get current phase.
     */
    getPhase(): SpecPhase {
        return this._phase;
    }

    /**
     * Set current phase.
     */
    setPhase(phase: SpecPhase): void {
        console.log(`[SpecManager] Phase transition: ${this._phase} -> ${phase}`);
        this._phase = phase;
    }

    /**
     * Save constitution to disk.
     * Creates the .vibearchitect directory if it doesn't exist.
     * Validates the constitution before saving.
     * 
     * @param content The constitution markdown content
     * @param autoRepair If true, automatically repairs minor issues (default: true)
     * @returns Validation result indicating any issues found
     */
    async saveConstitution(content: string, autoRepair: boolean = true): Promise<ConstitutionValidationResult> {
        const dir = path.dirname(this._constitutionPath);

        // Validate the constitution content
        let validation = validateConstitutionMarkdown(content);
        let finalContent = content;

        // Auto-repair if enabled and there are errors
        if (!validation.isValid && autoRepair) {
            console.log(`[SpecManager] Constitution has validation errors, attempting repair...`);
            const projectName = this._structuredConstitution?.identity.name ||
                path.basename(this._workspaceRoot) || 'Unknown';
            finalContent = repairConstitutionMarkdown(content, projectName);

            // Re-validate after repair
            const revalidation = validateConstitutionMarkdown(finalContent);
            if (revalidation.isValid) {
                console.log(`[SpecManager] Constitution repaired successfully`);
                validation = revalidation;
            } else {
                console.warn(`[SpecManager] Constitution repair incomplete. Remaining errors:`, revalidation.errors);
                validation = revalidation;
            }
        }

        // Log validation results
        if (validation.errors.length > 0) {
            console.warn(`[SpecManager] Constitution validation errors:`, validation.errors);
        }
        if (validation.warnings.length > 0) {
            console.log(`[SpecManager] Constitution validation warnings:`, validation.warnings);
        }
        console.log(`[SpecManager] Detected sections:`, validation.detectedSections);

        // Ensure directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[SpecManager] Created directory: ${dir}`);
        }

        try {
            fs.writeFileSync(this._constitutionPath, finalContent, 'utf-8');
            this._constitution = finalContent;
            // Parse into structured form so regenerateWithGuidelines() can work
            this._structuredConstitution = parseMarkdownConstitution(finalContent);
            console.log(`[SpecManager] Saved constitution to ${this._constitutionPath} (valid: ${validation.isValid})`);
        } catch (error) {
            console.error(`[SpecManager] Failed to save constitution:`, error);
            throw error;
        }

        return validation;
    }

    /**
     * Validate the current constitution without saving.
     * Useful for checking user edits before approval.
     */
    validateCurrentConstitution(): ConstitutionValidationResult {
        return validateConstitutionMarkdown(this._constitution);
    }

    // ============================================
    // FILE SYSTEM WATCHER
    // ============================================

    /**
     * Start watching the constitution file for external changes.
     * Call this after initialize() to enable real-time sync.
     */
    startWatching(): void {
        if (this._watcher) {
            this._watcher.dispose();
        }

        if (!this._constitutionPath) {
            console.warn('[SpecManager] Cannot start watching - no constitution path set');
            return;
        }

        // Create a file watcher for the constitution file
        const pattern = new vscode.RelativePattern(
            path.dirname(this._constitutionPath),
            path.basename(this._constitutionPath)
        );

        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

        // Handle file changes
        this._watcher.onDidChange(async (uri) => {
            console.log(`[SpecManager] Constitution file changed externally: ${uri.fsPath}`);
            await this.reloadConstitution();
            this._onConstitutionChanged.fire({ type: 'changed', content: this._constitution });
        });

        // Handle file deletion
        this._watcher.onDidDelete((uri) => {
            console.log(`[SpecManager] Constitution file deleted: ${uri.fsPath}`);
            this._constitution = '';
            this._structuredConstitution = null;
            this._onConstitutionChanged.fire({ type: 'deleted' });
        });

        // Handle file creation (if it didn't exist before)
        this._watcher.onDidCreate(async (uri) => {
            console.log(`[SpecManager] Constitution file created: ${uri.fsPath}`);
            await this.reloadConstitution();
            this._onConstitutionChanged.fire({ type: 'changed', content: this._constitution });
        });

        console.log(`[SpecManager] Started watching constitution file: ${this._constitutionPath}`);
    }

    /**
     * Stop watching the constitution file.
     * Call this when disposing the SpecManager.
     */
    stopWatching(): void {
        if (this._watcher) {
            this._watcher.dispose();
            this._watcher = null;
            console.log('[SpecManager] Stopped watching constitution file');
        }
    }

    /**
     * Reload the constitution from disk.
     * Called automatically by the file watcher on external changes.
     */
    async reloadConstitution(): Promise<boolean> {
        if (!this._constitutionPath) {
            return false;
        }

        try {
            if (fs.existsSync(this._constitutionPath)) {
                const content = fs.readFileSync(this._constitutionPath, 'utf-8');

                // Only update if content actually changed
                if (content !== this._constitution) {
                    this._constitution = content;
                    // Parse into structured form so regenerateWithGuidelines() can work
                    this._structuredConstitution = parseMarkdownConstitution(content);
                    console.log(`[SpecManager] Reloaded constitution (${content.length} chars)`);

                    // Validate the reloaded content
                    const validation = validateConstitutionMarkdown(content);
                    if (!validation.isValid) {
                        console.warn('[SpecManager] Reloaded constitution has validation issues:', validation.errors);
                    }

                    return true;
                }
            } else {
                // File was deleted
                this._constitution = '';
                this._structuredConstitution = null;
                return true;
            }
        } catch (error) {
            console.error('[SpecManager] Failed to reload constitution:', error);
        }

        return false;
    }

    /**
     * Dispose all resources including file watcher.
     */
    dispose(): void {
        this.stopWatching();
        this._onConstitutionChanged.dispose();
    }

    /**
     * Update the in-memory constitution (without saving to disk yet).
     * Used when user edits the constitution before approval.
     */
    updateConstitutionContent(content: string): void {
        this._constitution = content;
    }

    /**
     * Generate the system prompt for constitution generation.
     * This is fed to the AI along with the harvested context.
     * 
     * @param analysis - Pre-computed workspace analysis (optional)
     */
    getConstitutionGenerationPrompt(analysis?: WorkspaceAnalysis): string {
        // If we have pre-computed analysis, use the structured prompt
        if (analysis) {
            return this.getStructuredConstitutionPrompt(analysis);
        }

        // Legacy prompt for backward compatibility
        return `You are the Chief Architect of this repository. I have provided you with the file structure and configuration files. Your goal is to reverse-engineer the "Constitution" — the set of immutable rules that govern this codebase.

Generate a Markdown file following this EXACT structure:

# Workspace Constitution v2.0

## 1. Project Identity
- **Name**: [Project name from package.json or directory]
- **Type**: [extension|webapp|api|library|cli|monorepo]
- **Primary Language**: [typescript|javascript|python|java|go|etc]
- **Framework**: [React|Vue|Express|FastAPI|etc if applicable]
- **Description**: [Brief one-line description]

## 2. Critical Dependencies (DO NOT MODIFY WITHOUT REVIEW)
| Package | Version | Reason | Risk Level |
|---------|---------|--------|------------|
| [package] | [version] | [Why this is critical] | [CRITICAL|HIGH|MEDIUM|LOW] |

## 3. Architecture Rules
- **Pattern**: [MVC|Hexagonal|Feature-Sliced|Layered|etc]
- **Entry Point**: [Main entry file path]

### Module Boundaries
- **[module-name]**: [Purpose of this module]

### Import Rules
- [Describe import direction rules, e.g., "services cannot import from controllers"]

## 4. Coding Standards
List each standard with enforcement level:
- 🔴 **[Standard]**: [Value] (STRICT - must follow)
- 🟡 **[Standard]**: [Value] (WARNING - should follow)
- 🟢 **[Standard]**: [Value] (SUGGESTION)

## 5. Forbidden Patterns
- ❌ **[Pattern description]**
  - Reason: [Why this is forbidden]
  - Instead: [What to do instead]

## 6. Testing Requirements
- **Framework**: [jest|mocha|playwright|pytest|etc]
- **Test Pattern**: [e.g., **/*.test.ts]
- **Coverage Minimum**: [percentage if enforced]
- **Required Test Types**: [unit|integration|e2e]

## 7. Agent Constraints (ENFORCED)

### MUST
- ✅ [Things the agent MUST do]

### MUST NOT
- ❌ [Things the agent MUST NOT do]

### SHOULD
- 💡 [Things the agent SHOULD do when possible]

## 8. Custom Rules (User-Defined)
*Add custom rules here using the format:*
\`\`\`
- MUST: [Your rule here]
- MUST NOT: [Your rule here]
- SHOULD: [Your rule here]
\`\`\`

---
*This constitution is the source of truth for AI agents working in this workspace.*

RULES FOR GENERATION:
1. Be SPECIFIC - "Don't use any" is bad, "Use 'unknown' instead of 'any' for API responses" is good
2. Be ACTIONABLE - Each rule should be verifiable by looking at the code
3. Include REASONING - Why does this rule exist?
4. Set ENFORCEMENT levels appropriately based on severity
5. Do NOT dump raw config files - only include distilled, actionable rules
6. Keep the constitution under 500 lines - be concise

Output ONLY the markdown content. Do not include any preamble or explanation.`;
    }

    /**
     * Generate structured constitution prompt with pre-computed analysis
     */
    private getStructuredConstitutionPrompt(analysis: WorkspaceAnalysis): string {
        const criticalDepsTable = analysis.dependencies.critical.length > 0
            ? analysis.dependencies.critical.map(d =>
                `| ${d.name} | ${d.version} | ${d.reason} | ${d.riskLevel.toUpperCase()} |`
            ).join('\n')
            : '*No critical dependencies identified*';

        const lintRulesList = analysis.lintRules.length > 0
            ? analysis.lintRules.slice(0, 10).map(r => {
                const icon = r.enforcement === 'strict' ? '🔴' : r.enforcement === 'warning' ? '🟡' : '🟢';
                return `- ${icon} **${r.description}**: ${r.value}`;
            }).join('\n')
            : '*No lint rules detected*';

        const risksList = analysis.risks.length > 0
            ? analysis.risks.slice(0, 5).map(r =>
                `- **${r.description}** (${r.type}, ${r.severity})`
            ).join('\n')
            : '*No risks detected*';

        return `You are generating a Constitution for an AI coding agent. This is the "Agent Bible" - the source of truth for all rules in this workspace.

## PRE-COMPUTED ANALYSIS (from workspace scanning)

### Project Identity
- Name: ${analysis.identity.name}
- Type: ${analysis.identity.type}
- Primary Language: ${analysis.identity.primaryLanguage}
${analysis.identity.framework ? `- Framework: ${analysis.identity.framework}` : ''}

### Critical Dependencies (auto-detected)
| Package | Version | Reason | Risk Level |
|---------|---------|--------|------------|
${criticalDepsTable}

### Lint Rules (extracted from config)
${lintRulesList}

### Detected Risks
${risksList}

### File Structure Summary
${analysis.fileTreeSummary}

### High-Leverage Files
${analysis.highLeverageFiles.slice(0, 10).map(f => `- ${f}`).join('\n')}

---

## YOUR TASK

Using the above analysis, generate a constitution.md following this EXACT structure:

# Workspace Constitution v2.0

## 1. Project Identity
[Use the detected identity above, add description if inferrable]

## 2. Critical Dependencies (DO NOT MODIFY WITHOUT REVIEW)
[Use the critical dependencies table above]

## 3. Architecture Rules
- **Pattern**: [Infer from file structure: MVC|Hexagonal|Feature-Sliced|Layered|etc]
- **Entry Point**: [Main entry file path]

### Module Boundaries
[Infer logical module boundaries from the file structure]

### Import Rules
[Infer import direction rules based on architecture]

## 4. Coding Standards
[Use the lint rules above, add any additional inferred standards]

## 5. Forbidden Patterns
[Convert detected risks to forbidden patterns with reasons and alternatives]

## 6. Testing Requirements
[Infer from file structure and dependencies]

## 7. Agent Constraints (ENFORCED)

### MUST
- ✅ Run lint/type checks before completing code changes
- ✅ Use apply_diff instead of write_file for existing files
- ✅ [Add project-specific MUST rules]

### MUST NOT  
- ❌ Modify files in node_modules/ or .git/
- ❌ Change version numbers without explicit approval
- ❌ [Add project-specific MUST NOT rules based on risks]

### SHOULD
- 💡 Prefer existing utilities over new implementations
- 💡 Add documentation comments to public functions
- 💡 [Add project-specific SHOULD rules]

## 8. Custom Rules (User-Defined)
*Add custom rules here using the MUST/MUST NOT/SHOULD format*

---

RULES FOR GENERATION:
1. Be SPECIFIC and ACTIONABLE - vague rules are useless
2. Include REASONING for each rule - why does it exist?
3. Use the pre-computed analysis - don't dump raw configs
4. Keep it CONCISE - under 500 lines, no verbose explanations
5. Make rules VERIFIABLE - an agent should be able to check compliance

Output ONLY the markdown content. No preamble.`;
    }

    /**
     * Get the structured constitution object
     */
    getStructuredConstitution(): ConstitutionV2 | null {
        return this._structuredConstitution;
    }

    /**
     * Set the structured constitution (and update markdown representation)
     */
    setStructuredConstitution(constitution: ConstitutionV2): void {
        this._structuredConstitution = constitution;
        this._constitution = constitutionToMarkdown(constitution);
    }

    /**
     * Create a structured constitution from workspace analysis
     */
    createConstitutionFromAnalysis(analysis: WorkspaceAnalysis): ConstitutionV2 {
        const constitution = createEmptyConstitution(analysis.identity.name);

        // Set identity
        constitution.identity = analysis.identity;

        // Set critical dependencies
        constitution.criticalDependencies = analysis.dependencies.critical;

        // Set coding standards
        for (const rule of analysis.lintRules) {
            if (rule.id.includes('indent') || rule.id.includes('semi') ||
                rule.id.includes('quote') || rule.id.includes('spacing')) {
                constitution.codingStandards.formatting.push(rule);
            } else if (rule.id.includes('naming') || rule.id.includes('camel')) {
                constitution.codingStandards.naming.push(rule);
            } else if (rule.id.includes('import')) {
                constitution.codingStandards.imports.push(rule);
            } else {
                constitution.codingStandards.other.push(rule);
            }
        }

        // Convert risks to forbidden patterns
        for (const risk of analysis.risks) {
            constitution.forbiddenPatterns.push({
                id: risk.id,
                description: risk.description,
                reason: `Detected risk: ${risk.type}`,
                enforcement: risk.severity,
                autoDetected: true,
                suggestion: risk.suggestion
            });
        }

        // Add corporate guidelines if enabled
        const guidelines = getEnabledGuidelines(this._guidelinesConfig);
        const guidelineConstraints = guidelinesToAgentConstraints(guidelines);

        constitution.agentConstraints.must.push(...guidelineConstraints.must);
        constitution.agentConstraints.mustNot.push(...guidelineConstraints.mustNot);
        constitution.agentConstraints.should.push(...guidelineConstraints.should);

        // Add built-in constraints
        this.addBuiltInConstraints(constitution);

        constitution.generatedAt = new Date().toISOString();

        return constitution;
    }

    /**
     * Add built-in agent constraints that always apply
     */
    private addBuiltInConstraints(constitution: ConstitutionV2): void {
        // MUST rules
        const builtInMust: AgentRule[] = [
            {
                id: 'builtin-use-apply-diff',
                description: 'Use apply_diff instead of write_file for existing files',
                enforcement: 'strict',
                autoDetect: false,
                reason: 'apply_diff preserves formatting and reduces merge conflicts'
            },
            {
                id: 'builtin-verify-changes',
                description: 'Verify changes compile/lint before marking task complete',
                enforcement: 'strict',
                autoDetect: false,
                reason: 'Broken code wastes user time and erodes trust'
            }
        ];

        // MUST NOT rules
        const builtInMustNot: AgentRule[] = [
            {
                id: 'builtin-no-node-modules',
                description: 'Never modify files in node_modules/',
                enforcement: 'strict',
                autoDetect: true,
                pattern: '^node_modules/',
                reason: 'node_modules contains third-party code'
            },
            {
                id: 'builtin-no-git-folder',
                description: 'Never modify files in .git/',
                enforcement: 'strict',
                autoDetect: true,
                pattern: '^\\.git/',
                reason: '.git contains version control internals'
            },
            {
                id: 'builtin-no-version-bump',
                description: 'Do not change version numbers without explicit approval',
                enforcement: 'warning',
                autoDetect: false,
                reason: 'Version changes have release implications'
            }
        ];

        // SHOULD rules
        const builtInShould: AgentRule[] = [
            {
                id: 'builtin-prefer-existing',
                description: 'Prefer existing utilities and patterns over new implementations',
                enforcement: 'suggestion',
                autoDetect: false,
                reason: 'Reduces code duplication and maintains consistency'
            },
            {
                id: 'builtin-document-public',
                description: 'Add documentation comments to public functions and classes',
                enforcement: 'suggestion',
                autoDetect: false,
                reason: 'Documentation helps future maintainers'
            }
        ];

        // Add built-in rules (avoid duplicates)
        for (const rule of builtInMust) {
            if (!constitution.agentConstraints.must.some(r => r.id === rule.id)) {
                constitution.agentConstraints.must.push(rule);
            }
        }
        for (const rule of builtInMustNot) {
            if (!constitution.agentConstraints.mustNot.some(r => r.id === rule.id)) {
                constitution.agentConstraints.mustNot.push(rule);
            }
        }
        for (const rule of builtInShould) {
            if (!constitution.agentConstraints.should.some(r => r.id === rule.id)) {
                constitution.agentConstraints.should.push(rule);
            }
        }
    }

    /**
     * Set corporate guidelines configuration
     */
    setGuidelinesConfig(config: Partial<CorporateGuidelinesConfig>): void {
        this._guidelinesConfig = { ...this._guidelinesConfig, ...config };
    }

    /**
     * Get corporate guidelines configuration
     */
    getGuidelinesConfig(): CorporateGuidelinesConfig {
        return this._guidelinesConfig;
    }

    /**
     * Regenerate constitution markdown with updated corporate guidelines.
     * 
     * This is used for LIVE PREVIEW in the Constitution Review Modal:
     * when the user toggles a guideline category, this method strips old guideline
     * rules from agentConstraints, adds the newly-selected ones, and re-renders
     * the markdown -- all without an AI call.
     * 
     * Does NOT save to disk (that happens on Approve).
     */
    regenerateWithGuidelines(config: CorporateGuidelinesConfig): string | null {
        if (!this._structuredConstitution) {
            console.warn('[SpecManager] No structured constitution in memory for guideline regeneration');
            return null;
        }

        // DEEP CLONE to prevent mutation issues on repeated toggles
        // This ensures each toggle starts from a clean state
        const workingConstitution = JSON.parse(JSON.stringify(this._structuredConstitution)) as ConstitutionV2;

        // Guideline rule ID prefixes to strip
        const guidelinePrefixes = ['SEC-', 'PERF-', 'MAINT-', 'TEST-', 'A11Y-'];
        const isGuidelineRule = (rule: AgentRule) =>
            rule.id ? guidelinePrefixes.some(prefix => rule.id!.startsWith(prefix)) : false;

        // Strip all existing guideline-sourced rules from agentConstraints (on the CLONE)
        workingConstitution.agentConstraints.must =
            workingConstitution.agentConstraints.must.filter(r => !isGuidelineRule(r));
        workingConstitution.agentConstraints.mustNot =
            workingConstitution.agentConstraints.mustNot.filter(r => !isGuidelineRule(r));
        workingConstitution.agentConstraints.should =
            workingConstitution.agentConstraints.should.filter(r => !isGuidelineRule(r));

        // Add back rules from the newly enabled guideline categories
        const guidelines = getEnabledGuidelines(config);
        const guidelineConstraints = guidelinesToAgentConstraints(guidelines);

        workingConstitution.agentConstraints.must.push(...guidelineConstraints.must);
        workingConstitution.agentConstraints.mustNot.push(...guidelineConstraints.mustNot);
        workingConstitution.agentConstraints.should.push(...guidelineConstraints.should);

        // Update stored config
        this._guidelinesConfig = { ...config };

        // Update the structured constitution AFTER successful manipulation
        this._structuredConstitution = workingConstitution;

        // Re-render to markdown
        const markdown = constitutionToMarkdown(workingConstitution);

        // Update in-memory markdown (but do NOT write to disk during preview)
        // Disk write should only happen on Approve to prevent corruption
        this._constitution = markdown;
        console.log(`[SpecManager] Regenerated constitution preview with guidelines: ${JSON.stringify(config)}`);

        return markdown;
    }

    /**
     * Parse markdown constitution into structured format
     */
    parseConstitutionToStructured(): ConstitutionV2 | null {
        if (!this._constitution) {
            return null;
        }

        try {
            return parseMarkdownConstitution(this._constitution, this._structuredConstitution || undefined);
        } catch (error) {
            console.warn('[SpecManager] Failed to parse constitution to structured format:', error);
            return null;
        }
    }

    /**
     * Get constitution as agent prompt injection
     * Returns a concise version suitable for system prompts
     */
    getConstitutionForPrompt(): string {
        if (!this._constitution) {
            return '';
        }

        // If we have a structured constitution, generate a concise version
        if (this._structuredConstitution) {
            return this.generateConcisePrompt(this._structuredConstitution);
        }

        // Otherwise, return the raw constitution (truncated if too long)
        const maxLength = 4000; // Keep prompt injection reasonable
        if (this._constitution.length > maxLength) {
            return this._constitution.substring(0, maxLength) + '\n\n[Constitution truncated for brevity]';
        }
        return this._constitution;
    }

    /**
     * Generate a concise prompt from structured constitution
     */
    private generateConcisePrompt(constitution: ConstitutionV2): string {
        const lines: string[] = [
            '=== WORKSPACE CONSTITUTION (Agent Rules) ===',
            '',
            `Project: ${constitution.identity.name} (${constitution.identity.type}, ${constitution.identity.primaryLanguage})`,
            ''
        ];

        // Critical dependencies
        if (constitution.criticalDependencies.length > 0) {
            lines.push('CRITICAL DEPENDENCIES (do not modify):');
            for (const dep of constitution.criticalDependencies.slice(0, 5)) {
                lines.push(`- ${dep.name}@${dep.version} [${dep.riskLevel}]`);
            }
            lines.push('');
        }

        // Agent constraints
        if (constitution.agentConstraints.must.length > 0) {
            lines.push('MUST:');
            for (const rule of constitution.agentConstraints.must.slice(0, 5)) {
                lines.push(`- ${rule.description}`);
            }
            lines.push('');
        }

        if (constitution.agentConstraints.mustNot.length > 0) {
            lines.push('MUST NOT:');
            for (const rule of constitution.agentConstraints.mustNot.slice(0, 5)) {
                lines.push(`- ${rule.description}`);
            }
            lines.push('');
        }

        if (constitution.agentConstraints.should.length > 0) {
            lines.push('SHOULD:');
            for (const rule of constitution.agentConstraints.should.slice(0, 3)) {
                lines.push(`- ${rule.description}`);
            }
            lines.push('');
        }

        // Forbidden patterns
        if (constitution.forbiddenPatterns.length > 0) {
            lines.push('FORBIDDEN:');
            for (const pattern of constitution.forbiddenPatterns.slice(0, 3)) {
                lines.push(`- ${pattern.description}`);
            }
            lines.push('');
        }

        // Custom rules
        if (constitution.customRules.length > 0) {
            lines.push('CUSTOM RULES:');
            for (const rule of constitution.customRules) {
                lines.push(`- ${rule.description}`);
            }
            lines.push('');
        }

        lines.push('=== END CONSTITUTION ===');

        return lines.join('\n');
    }

    /**
     * Generate the prompt for detecting drift between current state and constitution.
     */
    getDriftDetectionPrompt(currentContext: string): string {
        return `Compare the current workspace state with the existing constitution.

=== CURRENT CONSTITUTION ===
${this._constitution}
=== END CONSTITUTION ===

=== CURRENT WORKSPACE STATE ===
${currentContext}
=== END WORKSPACE STATE ===

Analyze if there are significant changes that require updating the constitution:
- New major dependencies added to the project
- Architecture pattern changes (new folders, restructured code)
- New testing frameworks or tools
- Changed build processes
- New linting or formatting rules

If there are significant changes, respond in this exact format:
DRIFT_DETECTED
SUMMARY: [One-line summary of what changed]
---
[Full updated constitution.md content]

If there are no significant changes or only minor updates, respond with:
NO_DRIFT`;
    }

    /**
     * Generate the prompt for post-mission constitution review.
     */
    getPostMissionReviewPrompt(changedFiles: string[]): string {
        return `Review the changes made during this mission and determine if the constitution needs updates.

=== CURRENT CONSTITUTION ===
${this._constitution}
=== END CONSTITUTION ===

=== FILES CHANGED DURING MISSION ===
${changedFiles.join('\n')}
=== END CHANGES ===

Determine if any of the following occurred that would require constitution updates:
- New major dependencies added
- Architecture patterns changed (new folders, new patterns)
- New testing tools or frameworks introduced
- New coding conventions established
- New critical invariants created

If the constitution needs updates, respond in this exact format:
UPDATE_NEEDED
---
[Full updated constitution.md content]

If no updates are needed, respond with:
NO_UPDATE_NEEDED`;
    }

    /**
     * Parse the AI response for drift detection.
     */
    parseDriftResponse(response: string): DriftResult {
        const trimmed = response.trim();

        if (trimmed.startsWith('NO_DRIFT') || !trimmed.includes('DRIFT_DETECTED')) {
            return {
                hasDrift: false,
                driftSummary: '',
                suggestedUpdates: ''
            };
        }

        // Parse DRIFT_DETECTED response
        const lines = trimmed.split('\n');
        let summary = '';
        let updates = '';
        let pastSeparator = false;

        for (const line of lines) {
            if (line.startsWith('SUMMARY:')) {
                summary = line.replace('SUMMARY:', '').trim();
            } else if (line.trim() === '---') {
                pastSeparator = true;
            } else if (pastSeparator) {
                updates += line + '\n';
            }
        }

        return {
            hasDrift: true,
            driftSummary: summary || 'Changes detected in workspace structure',
            suggestedUpdates: updates.trim() || this._constitution
        };
    }

    /**
     * Parse the AI response for post-mission review.
     */
    parseUpdateCheckResponse(response: string): UpdateCheckResult {
        const trimmed = response.trim();

        if (trimmed.startsWith('NO_UPDATE_NEEDED') || !trimmed.includes('UPDATE_NEEDED')) {
            return {
                needsUpdate: false,
                suggestedChanges: ''
            };
        }

        // Parse UPDATE_NEEDED response
        const separatorIndex = trimmed.indexOf('---');
        if (separatorIndex === -1) {
            return {
                needsUpdate: true,
                suggestedChanges: this._constitution // Fallback to existing
            };
        }

        const updates = trimmed.substring(separatorIndex + 3).trim();
        return {
            needsUpdate: true,
            suggestedChanges: updates
        };
    }

    /**
     * Check if the workspace is empty (no meaningful files).
     * Empty workspaces don't need a constitution.
     */
    isWorkspaceEmpty(): boolean {
        if (!this._workspaceRoot) { return true; }

        try {
            const entries = fs.readdirSync(this._workspaceRoot);
            // Filter out hidden files/folders and common non-code items
            const meaningfulEntries = entries.filter(entry => {
                if (entry.startsWith('.')) { return false; }
                if (entry === 'node_modules') { return false; }
                if (entry === '.git') { return false; }
                return true;
            });
            return meaningfulEntries.length === 0;
        } catch {
            return true;
        }
    }
}
