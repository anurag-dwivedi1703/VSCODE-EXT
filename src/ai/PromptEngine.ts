import { getSecurityInstructions } from './SecurityInstructions';

export const IMPLEMENTATION_PLAN_INSTRUCTIONS = `
You are an expert software architect acting as a "VibeArchitect Agent".
Your goal is to analyze the user's request and produce a detailed IMPLEMENTATION PLAN.

FORMATTING RULES:
1. You must output a Markdown document.
2. The document must start with a level 1 header: # Implementation Plan - [Mission Name]
3. You must include a section: ## Proposed Changes
4. Under Proposed Changes, list every file you intend to create or modify.
5. Use [NEW] and [MODIFY] tags for files.

Example of expected output:
# Implementation Plan - Refactor Auth

## Proposed Changes
- [MODIFY] src/auth/login.ts
- [NEW] src/auth/types.ts

## Verification
- Run npm test
`;

/**
 * Formats the constitution content for injection into the system prompt.
 * Places it at HIGH PRIORITY position so the agent sees it first.
 */
function formatConstitutionBlock(constitution?: string): string {
    if (!constitution || constitution.trim().length === 0) {
        return '';
    }
    
    return `
═══════════════════════════════════════════════════════════════════════════════
⚠️ WORKSPACE CONSTITUTION - MANDATORY RULES
═══════════════════════════════════════════════════════════════════════════════

The following rules are MANDATORY for this workspace. You MUST follow them
for ALL actions. Violations will be blocked.

${constitution}

═══════════════════════════════════════════════════════════════════════════════

`;
}

export class PromptEngine {
    /**
     * Get the system prompt for the AI agent.
     * @param mode - 'PLANNING' or 'FAST' mode
     * @param constitution - Optional constitution content to inject (from .vibearchitect/constitution.md)
     */
    static getSystemPrompt(mode: 'PLANNING' | 'FAST', constitution?: string): string {
        const securityInstructions = getSecurityInstructions();
        const constitutionBlock = formatConstitutionBlock(constitution);

        if (mode === 'PLANNING') {
            return `
You are in PLANNING mode.
${constitutionBlock}${IMPLEMENTATION_PLAN_INSTRUCTIONS}

${securityInstructions}

Do not write code yet. Focus on the plan.
            `.trim();
        } else {
            return `
You are in FAST mode.
${constitutionBlock}You are a highly efficient coding assistant.
Execute the user's request directly.

${securityInstructions}
            `.trim();
        }
    }
}
