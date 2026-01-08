Phase 1: The "Architect" Engine (Native TypeScript Implementation)
Instead of calling an external CLI, we implement the Spec-Kit logic directly in your extension's source code. This makes it faster and fully integrated with your existing Agent.

Step 1.1: Define the Spec State Machine
Create a SpecManager class to track where the user is in the flow (Ideation -> Constitution -> Spec -> Plan -> Code).

TypeScript

// src/engines/SpecManager.ts
export enum SpecPhase {
    IDLE = 'IDLE',
    CONSTITUTION_GENERATION = 'CONSTITUTION',
    SPECIFICATION = 'SPEC',
    PLANNING = 'PLAN',
    EXECUTION = 'EXECUTION'
}

export class SpecManager {
    private _phase: SpecPhase = SpecPhase.IDLE;
    private _constitution: string = '';

    // Check if constitution exists on startup
    async initialize(workspaceRoot: string) {
        const constitutionPath = path.join(workspaceRoot, '.specify', 'memory', 'constitution.md');
        if (fs.existsSync(constitutionPath)) {
            this._constitution = fs.readFileSync(constitutionPath, 'utf-8');
            this._phase = SpecPhase.IDLE;
        } else {
            // Trigger "First Run" experience
            await this.generateAutoConstitution();
        }
    }
}
Phase 2: Automated Constitution Generation (The "First Interaction")
This is the core feature you requested: The agent scans the workspace immediately and tells the user "Here is how this project works."

Step 2.1: The ContextHarvester Service
We need a deterministic way to grab high-leverage context without reading every file (which wastes tokens).

TypeScript

// src/services/ContextHarvester.ts
import * as vscode from 'vscode';

export class ContextHarvester {
    async scanWorkspace(): Promise<string> {
        const files = await vscode.workspace.findFiles('{package.json,tsconfig.json,go.mod,Cargo.toml,README.md,.eslintrc*}', '**/node_modules/**');
        
        let contextBuffer = "## Project Metadata\n";

        // 1. Dependency/Config Analysis
        for (const file of files) {
            const content = await vscode.workspace.fs.readFile(file);
            contextBuffer += `\n### File: ${vscode.workspace.asRelativePath(file)}\n\`\`\`\n${content.toString()}\n\`\`\``;
        }

        // 2. Directory Structure (Tree)
        // Implement a lightweight 'tree' command equivalent using fs
        const tree = await this.generateFileTree(vscode.workspace.workspaceFolders.uri.fsPath);
        contextBuffer += `\n### Project Structure\n\`\`\`\n${tree}\n\`\`\``;

        return contextBuffer;
    }

    private async generateFileTree(dir: string, depth: number = 0): Promise<string> {
        if (depth > 2) return ''; // Limit depth to save tokens
        //... (implementation of directory walking)
    }
}
Step 2.2: The "Architect" System Prompt
You feed the harvested context into your LLM (Gemini/Claude) with this specific system prompt to generate the constitution.md.

System Prompt: You are the Chief Architect of this repository. I have provided you with the file structure and configuration files. Your goal is to reverse-engineer the "Constitution" — the set of immutable rules that govern this codebase.

Generate a Markdown file that contains:

Tech Stack: Strict versions inferred from package.json/go.mod.

Design Patterns: Infer architecture (e.g., "MVC", "Hexagonal", "Feature-Sliced") based on the folder tree.

Coding Standards: Infer rules (e.g., "Use TypeScript", "Semicolons required") based on linter configs.

Testing Strategy: Infer testing tools (Jest, Playwright) and conventions (e.g., "Tests live alongside code").

Output ONLY the markdown content for constitution.md.

