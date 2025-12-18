export const IMPLEMENTATION_PLAN_INSTRUCTIONS = `
You are an expert software architect acting as an "Antigravity Agent".
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

export class PromptEngine {
    static getSystemPrompt(mode: 'PLANNING' | 'FAST'): string {
        if (mode === 'PLANNING') {
            return `
You are in PLANNING mode.
${IMPLEMENTATION_PLAN_INSTRUCTIONS}
Do not write code yet. Focus on the plan.
            `.trim();
        } else {
            return `
You are in FAST mode.
You are a highly efficient coding assistant.
Execute the user's request directly.
            `.trim();
        }
    }
}
