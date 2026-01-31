/**
 * RefinementTypes.ts
 * Core type definitions for the Refinement Mode feature.
 */

/**
 * States of the refinement session state machine.
 */
export type RefinementState =
    | 'IDLE'           // Initial state, waiting to start
    | 'DRAFTING'       // Analyst is drafting initial requirements
    | 'CRITIQUING'     // Critic is reviewing the draft
    | 'REFINING'       // Refiner is synthesizing final PRD
    | 'AWAITING_USER'  // Waiting for user response to clarifying questions
    | 'APPROVED'       // User approved the PRD, ready to transition
    | 'CANCELLED';     // User cancelled the refinement

/**
 * Agent personas used in the refinement loop.
 */
export type AgentPersona = 'analyst' | 'critic' | 'refiner';

/**
 * Structure for clarifying questions asked by the Analyst.
 */
export interface ClarifyingQuestion {
    id: string;
    question: string;
    options?: string[];  // Optional predefined options for Smart Buttons
    category: 'requirement' | 'constraint' | 'preference' | 'technical';
}

/**
 * User's response to a clarifying question.
 */
export interface UserClarification {
    questionId: string;
    response: string;
    timestamp: number;
}

/**
 * Critique result from the Critic agent.
 */
export interface CritiqueResult {
    confidenceScore: number;  // 0-100, <70 triggers more questions
    issues: CritiqueIssue[];
    passedValidation: boolean;
}

export interface CritiqueIssue {
    type: 'ambiguity' | 'contradiction' | 'omission' | 'security' | 'performance' | 'architecture';
    severity: 'low' | 'medium' | 'high';
    description: string;
    suggestion?: string;
}

/**
 * The Golden Prompt / PRD artifact produced by the Refiner.
 */
export interface RefinementArtifact {
    version: string;  // e.g., "1.0"
    title: string;
    problemStatement: string;
    functionalRequirements: string[];
    nonFunctionalRequirements: string[];
    technicalPlan: {
        filesToCreate: string[];
        filesToModify: string[];
        apiChanges?: string[];
    };
    acceptanceCriteria: string[];  // Gherkin-style scenarios
    mermaidDiagram?: string;       // Optional architecture diagram
    rawMarkdown: string;           // Full PRD as markdown
}

/**
 * Conversation turn in the refinement session.
 */
export interface RefinementTurn {
    role: 'user' | 'analyst' | 'critic' | 'refiner' | 'system';
    content: string;
    timestamp: number;
    metadata?: {
        questions?: ClarifyingQuestion[];
        critique?: CritiqueResult;
        artifact?: RefinementArtifact;
    };
}

/**
 * Full state of a refinement session.
 */
export interface RefinementSessionState {
    sessionId: string;
    taskId: string;
    state: RefinementState;
    originalPrompt: string;
    conversationHistory: RefinementTurn[];
    clarifications: UserClarification[];
    currentDraft?: string;         // Current PRD draft markdown
    latestCritique?: CritiqueResult;
    finalArtifact?: RefinementArtifact;
    createdAt: number;
    updatedAt: number;
}

/**
 * Project Axiom - persisted user preference (Phase 2 enhancement).
 */
export interface ProjectAxiom {
    id: string;
    rule: string;           // e.g., "All timestamps must be UTC"
    source: string;         // Task ID where this was established
    category: 'style' | 'security' | 'architecture' | 'convention';
    createdAt: number;
}

/**
 * Event emitted by RefinementSession for UI updates.
 */
export interface RefinementEvent {
    type: 'state-change' | 'question' | 'draft-ready' | 'critique-ready' | 'artifact-ready' | 'error';
    sessionId: string;
    payload: unknown;
}
