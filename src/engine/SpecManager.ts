import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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

    /**
     * Initialize the SpecManager for a workspace.
     * Loads existing constitution if present.
     */
    async initialize(workspaceRoot: string): Promise<void> {
        this._workspaceRoot = workspaceRoot;

        // Constitution lives in .specify/memory/constitution.md
        const specifyDir = path.join(workspaceRoot, '.specify', 'memory');
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
     * Creates the .specify/memory directory if it doesn't exist.
     */
    async saveConstitution(content: string): Promise<void> {
        const dir = path.dirname(this._constitutionPath);

        // Ensure directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[SpecManager] Created directory: ${dir}`);
        }

        try {
            fs.writeFileSync(this._constitutionPath, content, 'utf-8');
            this._constitution = content;
            console.log(`[SpecManager] Saved constitution to ${this._constitutionPath}`);
        } catch (error) {
            console.error(`[SpecManager] Failed to save constitution:`, error);
            throw error;
        }
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
     */
    getConstitutionGenerationPrompt(): string {
        return `You are the Chief Architect of this repository. I have provided you with the file structure and configuration files. Your goal is to reverse-engineer the "Constitution" — the set of immutable rules that govern this codebase.

Generate a Markdown file that contains:

## Tech Stack
List the technologies and their versions inferred from package.json, go.mod, Cargo.toml, pyproject.toml, etc. Be specific about versions when available.

## Architecture Patterns
Infer the architecture style (e.g., "MVC", "Hexagonal", "Feature-Sliced", "Monolithic", "Microservices") based on the folder structure and organization.

## Coding Standards
Infer coding rules based on linter configs (.eslintrc, .prettierrc, etc.):
- Language preferences (TypeScript vs JavaScript)
- Formatting rules (semicolons, quotes, indentation)
- Import organization

## Testing Strategy
Infer testing tools (Jest, Playwright, pytest, etc.) and conventions:
- Test file location patterns
- Testing frameworks in use
- Coverage requirements if detectable

## Critical Invariants
Any patterns that MUST be preserved for the codebase to function:
- Required folder naming conventions
- Build system dependencies
- Configuration patterns

## Agent Constraints
Specific rules the AI agent MUST follow when working in this codebase:
- Never modify certain files
- Always run specific commands after changes
- Required code review steps

Output ONLY the markdown content for constitution.md. Do not include any preamble or explanation.`;
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
        if (!this._workspaceRoot) return true;

        try {
            const entries = fs.readdirSync(this._workspaceRoot);
            // Filter out hidden files/folders and common non-code items
            const meaningfulEntries = entries.filter(entry => {
                if (entry.startsWith('.')) return false;
                if (entry === 'node_modules') return false;
                if (entry === '.git') return false;
                return true;
            });
            return meaningfulEntries.length === 0;
        } catch {
            return true;
        }
    }
}
