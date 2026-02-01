/**
 * RefinementSession.ts
 * Implements the state machine for a single refinement session.
 * Manages transitions between Analyst, Critic, and Refiner agents.
 */

import * as vscode from 'vscode';
import {
    RefinementState,
    RefinementSessionState,
    RefinementTurn,
    ClarifyingQuestion,
    UserClarification,
    CritiqueResult,
    RefinementArtifact,
    RefinementEvent
} from './RefinementTypes';
import {
    getPersonaPrompt,
    generateAnalystInitialPrompt,
    generateCriticPrompt,
    generateRefinerPrompt
} from './RefinementPrompts';
import { ISession } from '../../ai/GeminiClient';

/**
 * Confidence threshold below which more clarifying questions are triggered.
 */
const CONFIDENCE_THRESHOLD = 70;

/**
 * Maximum refinement iterations to prevent infinite loops.
 */
const MAX_ITERATIONS = 5;

export class RefinementSession {
    private _state: RefinementSessionState;
    private _aiSession: ISession | null = null;
    private _iterationCount = 0;

    // Event emitter for UI updates
    private _onEvent = new vscode.EventEmitter<RefinementEvent>();
    public readonly onEvent = this._onEvent.event;

    constructor(
        sessionId: string,
        taskId: string,
        originalPrompt: string
    ) {
        this._state = {
            sessionId,
            taskId,
            state: 'IDLE',
            originalPrompt,
            conversationHistory: [],
            clarifications: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
    }

    // ========================================
    // Public Getters
    // ========================================

    get state(): RefinementState {
        return this._state.state;
    }

    get sessionId(): string {
        return this._state.sessionId;
    }

    get finalArtifact(): RefinementArtifact | undefined {
        return this._state.finalArtifact;
    }

    get currentDraft(): string | undefined {
        return this._state.currentDraft;
    }


    /**
     * Get the full state object for external access.
     */
    getStateObject() {
        return this._state;
    }

    get conversationHistory(): RefinementTurn[] {
        return this._state.conversationHistory;
    }

    // ========================================
    // State Machine Transitions
    // ========================================

    /**
     * Set the AI session to use for LLM calls.
     */
    public setAISession(session: ISession): void {
        this._aiSession = session;
    }

    /**
     * Start the refinement process with the initial prompt.
     * Transitions: IDLE -> DRAFTING
     */
    public async start(skeletonContext: string): Promise<RefinementTurn> {
        if (this._state.state !== 'IDLE') {
            throw new Error(`Cannot start from state: ${this._state.state}`);
        }

        this.transitionTo('DRAFTING');

        // Add the user's original prompt to history
        this.addTurn('user', this._state.originalPrompt);

        // Generate the Analyst's initial prompt
        const analystPrompt = generateAnalystInitialPrompt(
            this._state.originalPrompt,
            skeletonContext
        );
        console.log(`[RefinementSession] Analyst prompt length: ${analystPrompt.length} chars`);

        // Call the AI with Analyst persona
        const response = await this.callAI('analyst', analystPrompt);
        console.log(`[RefinementSession] Analyst response:`, response.substring(0, 500));

        // Parse the response for questions or draft
        const turn = this.parseAnalystResponse(response);
        console.log(`[RefinementSession] Parsed ${turn.metadata?.questions?.length || 0} questions`);
        this.addTurn('analyst', response, turn.metadata);

        // If questions were asked, wait for user
        if (turn.metadata?.questions && turn.metadata.questions.length > 0) {
            this.transitionTo('AWAITING_USER');
            console.log(`[RefinementSession] Firing 'question' event with ${turn.metadata.questions.length} questions`);
            this._onEvent.fire({
                type: 'question',
                sessionId: this.sessionId,
                payload: turn.metadata.questions
            });
        } else {
            // No questions found - the AI might have gone straight to a draft or given a generic response
            // Fire the response as a draft anyway so the user can see it
            console.log(`[RefinementSession] No questions parsed, firing response as draft`);
            this._onEvent.fire({
                type: 'draft-ready',
                sessionId: this.sessionId,
                payload: response
            });
            this.transitionTo('AWAITING_USER');
        }

        return turn;
    }

    /**
     * Handle user's response to clarifying questions.
     * Transitions: AWAITING_USER -> DRAFTING or CRITIQUING
     */
    public async handleUserResponse(response: string): Promise<RefinementTurn> {
        if (this._state.state !== 'AWAITING_USER') {
            throw new Error(`Cannot handle user response in state: ${this._state.state}`);
        }

        // Store the user's clarification
        const clarification: UserClarification = {
            questionId: `q-${Date.now()}`,
            response,
            timestamp: Date.now()
        };
        this._state.clarifications.push(clarification);
        this.addTurn('user', response);

        this._iterationCount++;

        if (this._iterationCount >= MAX_ITERATIONS) {
            // Force transition to refining to prevent infinite loops
            return this.forceRefine();
        }

        // Continue with Analyst to incorporate the answer
        this.transitionTo('DRAFTING');

        const prompt = `The user has provided the following clarification:\n\n"${response}"\n\nIncorporate this into your requirements draft. If you have enough information, produce a complete PRD draft. Otherwise, ask follow-up questions.`;

        const aiResponse = await this.callAI('analyst', prompt);
        const turn = this.parseAnalystResponse(aiResponse);
        this.addTurn('analyst', aiResponse, turn.metadata);

        // Check if we have a draft ready for critique
        if (this._state.currentDraft) {
            return this.triggerCritique();
        }

        // If more questions, wait for user
        if (turn.metadata?.questions && turn.metadata.questions.length > 0) {
            this.transitionTo('AWAITING_USER');
            this._onEvent.fire({
                type: 'question',
                sessionId: this.sessionId,
                payload: turn.metadata.questions
            });
        }

        return turn;
    }

    /**
     * Trigger the Critic to review the current draft.
     * Transitions: DRAFTING -> CRITIQUING
     */
    public async triggerCritique(): Promise<RefinementTurn> {
        if (!this._state.currentDraft) {
            throw new Error('No draft available for critique');
        }

        this.transitionTo('CRITIQUING');

        const prompt = generateCriticPrompt(
            this._state.currentDraft,
            '' // Skeleton context - will be injected by manager
        );

        const response = await this.callAI('critic', prompt);
        const critique = this.parseCritiqueResponse(response);
        this._state.latestCritique = critique;

        const turn: RefinementTurn = {
            role: 'critic',
            content: response,
            timestamp: Date.now(),
            metadata: { critique }
        };
        this._state.conversationHistory.push(turn);

        this._onEvent.fire({
            type: 'critique-ready',
            sessionId: this.sessionId,
            payload: critique
        });

        // Check confidence threshold
        if (critique.confidenceScore >= CONFIDENCE_THRESHOLD) {
            // Ready to refine
            return this.triggerRefine();
        } else {
            // Need more clarification
            this.transitionTo('AWAITING_USER');

            // Generate questions based on critique issues (null safety)
            const questions = (critique.issues || [])
                .filter(i => i.severity !== 'low')
                .map((issue, idx) => ({
                    id: `crit-${idx}`,
                    question: `The Critic found an issue: ${issue.description}. ${issue.suggestion || 'Please clarify.'}`,
                    category: 'requirement' as const
                }));

            this._onEvent.fire({
                type: 'question',
                sessionId: this.sessionId,
                payload: questions
            });
        }

        return turn;
    }

    /**
     * Trigger the Refiner to produce the final PRD.
     * Transitions: CRITIQUING -> REFINING -> AWAITING_USER (for approval)
     */
    public async triggerRefine(): Promise<RefinementTurn> {
        this.transitionTo('REFINING');

        const clarificationsText = this._state.clarifications
            .map(c => `- ${c.response}`)
            .join('\n');

        const prompt = generateRefinerPrompt(
            this._state.currentDraft || '',
            JSON.stringify(this._state.latestCritique, null, 2),
            clarificationsText
        );

        const response = await this.callAI('refiner', prompt);
        const artifact = this.parseRefinedArtifact(response);
        this._state.finalArtifact = artifact;

        const turn: RefinementTurn = {
            role: 'refiner',
            content: response,
            timestamp: Date.now(),
            metadata: { artifact }
        };
        this._state.conversationHistory.push(turn);

        // Wait for user approval
        this.transitionTo('AWAITING_USER');

        this._onEvent.fire({
            type: 'artifact-ready',
            sessionId: this.sessionId,
            payload: artifact
        });

        return turn;
    }

    /**
     * User approves the final PRD.
     * Transitions: AWAITING_USER -> APPROVED
     */
    public approve(): void {
        if (!this._state.finalArtifact) {
            throw new Error('No artifact to approve');
        }
        this.transitionTo('APPROVED');
    }

    /**
     * User cancels the refinement.
     * Transitions: any -> CANCELLED
     */
    public cancel(): void {
        this.transitionTo('CANCELLED');
    }

    // ========================================
    // Private Helpers
    // ========================================

    private transitionTo(newState: RefinementState): void {
        console.log(`[RefinementSession] ${this._state.state} -> ${newState}`);
        this._state.state = newState;
        this._state.updatedAt = Date.now();

        this._onEvent.fire({
            type: 'state-change',
            sessionId: this.sessionId,
            payload: newState
        });
    }

    private addTurn(role: RefinementTurn['role'], content: string, metadata?: RefinementTurn['metadata']): void {
        this._state.conversationHistory.push({
            role,
            content,
            timestamp: Date.now(),
            metadata
        });
    }

    private async callAI(persona: 'analyst' | 'critic' | 'refiner', prompt: string): Promise<string> {
        if (!this._aiSession) {
            throw new Error('No AI session configured');
        }

        try {
            console.log(`[RefinementSession] Calling AI with persona: ${persona}`);
            // The AI session should already be configured with the persona's system prompt
            const result = await this._aiSession.sendMessage(prompt);
            // response is an object, not a Promise
            const text = result.response.text();
            console.log(`[RefinementSession] AI response received (${text.length} chars)`);
            return text;
        } catch (error: any) {
            console.error(`[RefinementSession] AI call failed:`, error);
            this._onEvent.fire({
                type: 'error',
                sessionId: this.sessionId,
                payload: `AI call failed: ${error.message}`
            });
            throw error;
        }
    }

    private parseAnalystResponse(response: string): RefinementTurn {
        // Check if response contains a PRD draft (look for structured headers)
        const hasDraft = response.includes('## Functional Requirements') ||
            response.includes('## Problem Statement') ||
            response.includes('# ') && response.includes('Requirements');

        if (hasDraft) {
            this._state.currentDraft = response;
            this._onEvent.fire({
                type: 'draft-ready',
                sessionId: this.sessionId,
                payload: response
            });
        }

        // Extract questions (look for numbered list or question marks)
        const questions: ClarifyingQuestion[] = [];
        const lines = response.split('\n');
        let questionIndex = 0;

        for (const line of lines) {
            const trimmed = line.trim();
            // Match numbered questions or lines ending with ?
            if (/^\d+\.\s/.test(trimmed) && trimmed.includes('?')) {
                questions.push({
                    id: `q-${questionIndex++}`,
                    question: trimmed.replace(/^\d+\.\s*/, ''),
                    category: 'requirement'
                });
            } else if (trimmed.endsWith('?') && trimmed.length > 10) {
                questions.push({
                    id: `q-${questionIndex++}`,
                    question: trimmed,
                    category: 'requirement'
                });
            }
        }

        return {
            role: 'analyst',
            content: response,
            timestamp: Date.now(),
            metadata: questions.length > 0 ? { questions } : undefined
        };
    }

    private parseCritiqueResponse(response: string): CritiqueResult {
        // Try to parse JSON from response
        const defaultFallback: CritiqueResult = {
            confidenceScore: 75,
            passedValidation: true,
            issues: [{
                type: 'ambiguity',
                severity: 'low',
                description: 'Critique response was not in expected format'
            }]
        };

        try {
            let parsed: any;
            const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[1]);
            } else {
                // Try direct JSON parse
                parsed = JSON.parse(response);
            }

            // Validate parsed JSON has required structure
            if (typeof parsed.confidenceScore !== 'number') {
                console.warn('[RefinementSession] Parsed critique missing confidenceScore, using fallback');
                return defaultFallback;
            }

            // Ensure issues is an array
            if (!Array.isArray(parsed.issues)) {
                parsed.issues = [];
            }

            // Ensure passedValidation exists
            if (typeof parsed.passedValidation !== 'boolean') {
                parsed.passedValidation = parsed.confidenceScore >= 70;
            }

            return parsed as CritiqueResult;
        } catch {
            // Fallback: create a default critique
            console.warn('[RefinementSession] Failed to parse Critic JSON, using fallback');
            return defaultFallback;
        }
    }

    private parseRefinedArtifact(response: string): RefinementArtifact {
        // Extract title from first heading
        const titleMatch = response.match(/^#\s+(.+)/m);
        const title = titleMatch ? titleMatch[1].replace(/- Product Requirement Document/i, '').trim() : 'Untitled';

        // Extract problem statement
        const problemMatch = response.match(/## Problem Statement\n([\s\S]*?)(?=\n##|$)/);
        const problemStatement = problemMatch ? problemMatch[1].trim() : '';

        // Extract functional requirements
        const funcReqMatch = response.match(/## Functional Requirements\n([\s\S]*?)(?=\n##|$)/);
        const funcReqs = funcReqMatch
            ? funcReqMatch[1].split('\n').filter(l => l.trim().startsWith('-') || /^\d+\./.test(l.trim()))
            : [];

        // Extract non-functional requirements
        const nonFuncMatch = response.match(/## Non-Functional Requirements\n([\s\S]*?)(?=\n##|$)/);
        const nonFuncReqs = nonFuncMatch
            ? nonFuncMatch[1].split('\n').filter(l => l.trim().startsWith('-') || /^\d+\./.test(l.trim()))
            : [];

        // Extract acceptance criteria (Gherkin)
        const gherkinMatch = response.match(/```gherkin\n?([\s\S]*?)\n?```/);
        const acceptanceCriteria = gherkinMatch
            ? [gherkinMatch[1]]
            : [];

        // Extract Mermaid diagram
        const mermaidMatch = response.match(/```mermaid\n?([\s\S]*?)\n?```/);
        const mermaidDiagram = mermaidMatch ? mermaidMatch[1] : undefined;

        return {
            version: '1.0',
            title,
            problemStatement,
            functionalRequirements: funcReqs.map(r => r.trim()),
            nonFunctionalRequirements: nonFuncReqs.map(r => r.trim()),
            technicalPlan: {
                filesToCreate: [],
                filesToModify: []
            },
            acceptanceCriteria,
            mermaidDiagram,
            rawMarkdown: response
        };
    }

    private async forceRefine(): Promise<RefinementTurn> {
        console.warn('[RefinementSession] Max iterations reached, forcing refinement');
        this.addTurn('system', 'Maximum clarification iterations reached. Proceeding with available information.');

        if (!this._state.currentDraft) {
            // Create a minimal draft from conversation
            this._state.currentDraft = `# Requirements Draft\n\n${this._state.originalPrompt}\n\n## Clarifications\n${this._state.clarifications.map(c => `- ${c.response}`).join('\n')}`;
        }

        return this.triggerRefine();
    }
}
