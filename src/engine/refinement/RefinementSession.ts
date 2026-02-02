/**
 * RefinementSession.ts
 * Implements the state machine for a single refinement session.
 * Manages transitions between Analyst, Critic, and Refiner agents.
 * 
 * Token-Efficient Design:
 * - Uses RefinementTokenManager to track and limit token usage
 * - Automatically summarizes conversation history when approaching limits
 * - Truncates context intelligently to preserve key information
 * - Supports multi-turn PRD generation for complex features
 */

import * as vscode from 'vscode';
import {
    RefinementState,
    RefinementSessionState,
    RefinementTurn,
    ClarifyingQuestion,
    UserClarification,
    CritiqueResult,
    CritiqueIssue,
    RefinementArtifact,
    RefinementEvent,
    QuestionnaireEventPayload
} from './RefinementTypes';
import {
    getPersonaPrompt,
    generateAnalystInitialPrompt,
    generateCriticPrompt,
    generateRefinerPrompt,
    generateTokenEfficientAnalystPrompt,
    generateTokenEfficientCriticPrompt,
    generateTokenEfficientRefinerPrompt
} from './RefinementPrompts';
import { ISession } from '../../ai/GeminiClient';
import { RefinementTokenManager, createTokenAwareSkeleton } from './RefinementTokenManager';

/**
 * Confidence threshold below which more clarifying questions are triggered.
 */
const CONFIDENCE_THRESHOLD = 70;

/**
 * Maximum refinement iterations to prevent infinite loops.
 */
const MAX_ITERATIONS = 5;

/**
 * Timeout for AI calls (e.g. Copilot/API) - safety net only; critic/refiner can take 1–2+ minutes.
 */
const AI_CALL_TIMEOUT_MS = 300000; // 5 minutes

/**
 * Token utilization threshold to trigger summarization (80%)
 */
const TOKEN_WARNING_THRESHOLD = 0.8;

export class RefinementSession {
    private _state: RefinementSessionState;
    private _aiSession: ISession | null = null;
    private _iterationCount = 0;
    private _tokenManager: RefinementTokenManager;
    private _modelId: string = 'default';
    private _skeletonContext: string = '';

    // Event emitter for UI updates
    private _onEvent = new vscode.EventEmitter<RefinementEvent>();
    public readonly onEvent = this._onEvent.event;

    constructor(
        sessionId: string,
        taskId: string,
        originalPrompt: string,
        modelId: string = 'default'
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
        this._modelId = modelId;
        this._tokenManager = new RefinementTokenManager(modelId);
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
     * 
     * Token-efficient: Truncates skeleton context if needed.
     */
    public async start(skeletonContext: string): Promise<RefinementTurn> {
        if (this._state.state !== 'IDLE') {
            throw new Error(`Cannot start from state: ${this._state.state}`);
        }

        this.transitionTo('DRAFTING');

        // Add the user's original prompt to history
        this.addTurn('user', this._state.originalPrompt);

        // Extract keywords for context relevance
        const keywords = this._tokenManager.extractKeywords(this._state.originalPrompt);
        
        // Get available tokens for analyst stage
        const availableTokens = this._tokenManager.getAvailableTokensForStage('analyst');
        
        // Create token-aware skeleton context
        const truncatedSkeleton = createTokenAwareSkeleton(
            skeletonContext,
            availableTokens,
            keywords
        );
        this._skeletonContext = truncatedSkeleton;
        
        const skeletonTokens = this._tokenManager.estimateTokens(truncatedSkeleton);
        const originalTokens = this._tokenManager.estimateTokens(skeletonContext);
        
        if (skeletonTokens < originalTokens) {
            console.log(`[RefinementSession] Skeleton truncated: ${originalTokens} -> ${skeletonTokens} tokens`);
            this._onEvent.fire({
                type: 'progress',
                sessionId: this.sessionId,
                payload: `Context optimized: ${originalTokens} -> ${skeletonTokens} tokens for efficiency`
            });
        }

        // Generate the Analyst's initial prompt (use token-efficient version for large contexts)
        const analystPrompt = skeletonTokens > 5000
            ? generateTokenEfficientAnalystPrompt(this._state.originalPrompt, truncatedSkeleton)
            : generateAnalystInitialPrompt(this._state.originalPrompt, truncatedSkeleton);
        
        console.log(`[RefinementSession] Analyst prompt length: ${analystPrompt.length} chars (~${this._tokenManager.estimateTokens(analystPrompt)} tokens)`);

        // Call the AI with Analyst persona
        const response = await this.callAI('analyst', analystPrompt);
        console.log(`[RefinementSession] Analyst response:`, response.substring(0, 500));

        // Track token usage
        this._tokenManager.addConversationTokens(
            this._tokenManager.estimateTokens(analystPrompt) + 
            this._tokenManager.estimateTokens(response)
        );
        this.logTokenUsage();

        // Parse the response for questions or draft
        const turn = this.parseAnalystResponse(response);
        const questionCount = turn.metadata?.questions?.length || 0;
        const hasDraft = turn.metadata?.hasDraft || false;
        console.log(`[RefinementSession] Parsed ${questionCount} questions, hasDraft: ${hasDraft}`);
        this.addTurn('analyst', response, turn.metadata);

        // ALWAYS fire a single 'analyst-response' event with the FULL response
        // The UI should display this as ONE bubble, not separate pieces
        this.transitionTo('AWAITING_USER');
        console.log(`[RefinementSession] Firing 'analyst-response' event`);
        this._onEvent.fire({
            type: 'analyst-response',
            sessionId: this.sessionId,
            payload: {
                content: response,
                hasQuestions: questionCount > 0,
                hasDraft: hasDraft,
                questionCount: questionCount
            }
        });

        // If structured questionnaire was detected, also fire questionnaire event for interactive UI
        const structuredQuestionnaire = this.parseQuestionnaireBlock(response);
        if (structuredQuestionnaire && structuredQuestionnaire.questions.length > 0) {
            console.log(`[RefinementSession] Firing 'questionnaire' event with ${structuredQuestionnaire.questions.length} structured questions`);
            const questionnairePayload: QuestionnaireEventPayload = {
                questions: structuredQuestionnaire.questions,
                contextSummary: structuredQuestionnaire.contextSummary,
                rawAnalystResponse: this.getResponseWithoutQuestionnaire(response)
            };
            this._onEvent.fire({
                type: 'questionnaire',
                sessionId: this.sessionId,
                payload: questionnairePayload
            });
        }

        return turn;
    }

    /**
     * Log current token usage for debugging.
     */
    private logTokenUsage(): void {
        const budget = this._tokenManager.getBudgetInfo();
        console.log(`[RefinementSession] Token usage: ${budget.usedTokens}/${budget.maxTokens} (${budget.utilizationPercent}%)`);
        
        if (budget.utilizationPercent > TOKEN_WARNING_THRESHOLD * 100) {
            console.warn(`[RefinementSession] Warning: Token usage at ${budget.utilizationPercent}%`);
            this._onEvent.fire({
                type: 'progress',
                sessionId: this.sessionId,
                payload: `Token usage: ${budget.utilizationPercent}% - summarizing conversation for efficiency`
            });
        }
    }

    /**
     * Handle user's response to clarifying questions.
     * Transitions: AWAITING_USER -> DRAFTING or CRITIQUING
     * 
     * Token-efficient: Summarizes conversation if approaching limits.
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

        // Check token budget and summarize if needed
        const budget = this._tokenManager.getBudgetInfo();
        if (budget.utilizationPercent > TOKEN_WARNING_THRESHOLD * 100) {
            this.summarizeConversationHistory();
        }

        // Continue with Analyst to incorporate the answer
        this.transitionTo('DRAFTING');

        // Use concise prompt for token efficiency
        const prompt = `User clarification: "${response}"

Incorporate this into your requirements. If sufficient info, produce a PRD draft. Otherwise, ask 2-3 focused follow-up questions.`;

        const aiResponse = await this.callAI('analyst', prompt);
        
        // Track token usage
        this._tokenManager.addConversationTokens(
            this._tokenManager.estimateTokens(prompt) + 
            this._tokenManager.estimateTokens(aiResponse)
        );
        this.logTokenUsage();
        
        const turn = this.parseAnalystResponse(aiResponse);
        this.addTurn('analyst', aiResponse, turn.metadata);

        // Check if we have a draft ready for critique
        if (this._state.currentDraft) {
            return this.triggerCritique();
        }

        // Fire a single 'analyst-response' event with the full response
        const questionCount = turn.metadata?.questions?.length || 0;
        const hasDraft = turn.metadata?.hasDraft || false;
        this.transitionTo('AWAITING_USER');
        this._onEvent.fire({
            type: 'analyst-response',
            sessionId: this.sessionId,
            payload: {
                content: aiResponse,
                hasQuestions: questionCount > 0,
                hasDraft: hasDraft,
                questionCount: questionCount
            }
        });

        // If structured questionnaire was detected, also fire questionnaire event for interactive UI
        const structuredQuestionnaire = this.parseQuestionnaireBlock(aiResponse);
        if (structuredQuestionnaire && structuredQuestionnaire.questions.length > 0) {
            console.log(`[RefinementSession] Firing 'questionnaire' event with ${structuredQuestionnaire.questions.length} structured questions`);
            const questionnairePayload: QuestionnaireEventPayload = {
                questions: structuredQuestionnaire.questions,
                contextSummary: structuredQuestionnaire.contextSummary,
                rawAnalystResponse: this.getResponseWithoutQuestionnaire(aiResponse)
            };
            this._onEvent.fire({
                type: 'questionnaire',
                sessionId: this.sessionId,
                payload: questionnairePayload
            });
        }

        return turn;
    }

    /**
     * Summarize older conversation turns to reduce token usage.
     */
    private summarizeConversationHistory(): void {
        const originalTurns = this._state.conversationHistory;
        const summarized = this._tokenManager.summarizeConversation(
            originalTurns.map(t => ({ role: t.role, content: t.content })),
            3  // Keep last 3 turns verbatim
        );

        if (summarized.length < originalTurns.length) {
            console.log(`[RefinementSession] Conversation summarized: ${originalTurns.length} -> ${summarized.length} turns`);
            
            // Replace conversation history with summarized version
            this._state.conversationHistory = summarized.map((s, i) => ({
                role: s.role as RefinementTurn['role'],
                content: s.content,
                timestamp: originalTurns[i]?.timestamp || Date.now()
            }));

            this._onEvent.fire({
                type: 'progress',
                sessionId: this.sessionId,
                payload: 'Conversation history summarized for token efficiency'
            });
        }
    }

    /**
     * Trigger the Critic to review the current draft.
     * Transitions: DRAFTING -> CRITIQUING
     * 
     * Token-efficient: Uses minimal context for critique.
     */
    public async triggerCritique(): Promise<RefinementTurn> {
        if (!this._state.currentDraft) {
            throw new Error('No draft available for critique');
        }

        this.transitionTo('CRITIQUING');

        // Check token budget and decide on prompt strategy
        const budget = this._tokenManager.getBudgetInfo();
        const draftTokens = this._tokenManager.estimateTokens(this._state.currentDraft);
        
        // Use token-efficient prompt if budget is constrained
        const useEfficientPrompt = budget.utilizationPercent > 50 || draftTokens > 3000;
        
        // Truncate draft if it's very large
        let draftForCritique = this._state.currentDraft;
        if (draftTokens > 4000) {
            const maxDraftTokens = this._tokenManager.getAvailableTokensForStage('critic');
            const result = this._tokenManager.truncateContext(this._state.currentDraft, maxDraftTokens);
            draftForCritique = result.content;
            if (result.wasTruncated) {
                console.log(`[RefinementSession] Draft truncated for critique: ${draftTokens} -> ${result.truncatedTokens} tokens`);
            }
        }

        const prompt = useEfficientPrompt
            ? generateTokenEfficientCriticPrompt(draftForCritique)
            : generateCriticPrompt(draftForCritique, this._skeletonContext);

        this._onEvent.fire({
            type: 'progress',
            sessionId: this.sessionId,
            payload: 'Calling critic... (this may take a minute or two)'
        });

        const response = await this.callAI('critic', prompt);
        
        // Track token usage
        this._tokenManager.addConversationTokens(
            this._tokenManager.estimateTokens(prompt) + 
            this._tokenManager.estimateTokens(response)
        );
        this.logTokenUsage();
        
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
            // Need more clarification - generate questions from issues
            const issues = critique.issues || [];
            const significantIssues = issues.filter(i => i.severity !== 'low').slice(0, 3);
            
            // If no specific issues but still failed validation, create a generic prompt
            if (significantIssues.length === 0) {
                console.log(`[RefinementSession] Critique failed (score: ${critique.confidenceScore}) but no issues provided. Proceeding with refinement anyway.`);
                
                // Fire an event to let user know what's happening
                this._onEvent.fire({
                    type: 'progress',
                    sessionId: this.sessionId,
                    payload: `Critique confidence is ${critique.confidenceScore}% (threshold: ${CONFIDENCE_THRESHOLD}%). Proceeding to generate PRD with current information.`
                });
                
                // Proceed to refinement since we have no specific issues to address
                return this.triggerRefine();
            }
            
            // We have specific issues to address
            this.transitionTo('AWAITING_USER');

            const questions = significantIssues.map((issue, idx) => ({
                id: `crit-${idx}`,
                question: `Issue: ${issue.description}. ${issue.suggestion || 'Please clarify.'}`,
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
     * 
     * Token-efficient: Uses chunked generation for complex features if needed.
     */
    public async triggerRefine(): Promise<RefinementTurn> {
        this.transitionTo('REFINING');

        // Summarize clarifications to reduce tokens
        const clarificationsText = this._state.clarifications.length > 5
            ? this.summarizeClarifications()
            : this._state.clarifications.map(c => `- ${c.response}`).join('\n');

        // Check if we need chunked generation
        const budget = this._tokenManager.getBudgetInfo();
        const draftTokens = this._tokenManager.estimateTokens(this._state.currentDraft || '');
        const critiqueTokens = this._tokenManager.estimateTokens(JSON.stringify(this._state.latestCritique));
        
        const needsChunking = this._tokenManager.needsChunkedGeneration(
            draftTokens + critiqueTokens,
            5000  // Estimated PRD output tokens
        );

        let response: string;
        
        if (needsChunking && budget.utilizationPercent > 60) {
            // Use chunked generation for very large/complex features
            console.log(`[RefinementSession] Using chunked PRD generation due to token constraints`);
            this._onEvent.fire({
                type: 'progress',
                sessionId: this.sessionId,
                payload: 'Generating PRD in sections for token efficiency...'
            });
            response = await this.generateChunkedPrd(clarificationsText);
        } else {
            // Standard single-call generation
            const useEfficientPrompt = budget.utilizationPercent > 50;
            
            // Truncate draft if needed
            let draftForRefiner = this._state.currentDraft || '';
            if (draftTokens > 3000) {
                const result = this._tokenManager.truncateContext(
                    draftForRefiner,
                    this._tokenManager.getAvailableTokensForStage('refiner')
                );
                draftForRefiner = result.content;
            }

            // Summarize critique to key issues only
            const critiqueSummary = this.summarizeCritique();

            const prompt = useEfficientPrompt
                ? generateTokenEfficientRefinerPrompt(draftForRefiner, critiqueSummary, clarificationsText)
                : generateRefinerPrompt(draftForRefiner, critiqueSummary, clarificationsText);

            response = await this.callAI('refiner', prompt);
            
            // Track token usage
            this._tokenManager.addConversationTokens(
                this._tokenManager.estimateTokens(prompt) + 
                this._tokenManager.estimateTokens(response)
            );
        }
        
        this.logTokenUsage();
        
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
     * Generate PRD in chunks for very large/complex features.
     */
    private async generateChunkedPrd(clarificationsText: string): Promise<string> {
        const sections = this._tokenManager.getPrdSections();
        const prdParts: string[] = [];
        
        for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            const previousSections = prdParts.join('\n\n');
            
            this._onEvent.fire({
                type: 'progress',
                sessionId: this.sessionId,
                payload: `Generating PRD section ${i + 1}/${sections.length}: ${section.replace('_', ' ')}`
            });

            const sectionPrompt = this._tokenManager.getChunkedPrompt(section, previousSections);
            const contextPrompt = `
Draft context (summarized): ${this._state.currentDraft?.slice(0, 1000) || 'Not available'}...

User clarifications: ${clarificationsText}

${sectionPrompt}`;

            const sectionResponse = await this.callAI('refiner', contextPrompt);
            prdParts.push(sectionResponse);
            
            // Track tokens
            this._tokenManager.addConversationTokens(
                this._tokenManager.estimateTokens(contextPrompt) + 
                this._tokenManager.estimateTokens(sectionResponse)
            );
        }

        // Combine all sections into final PRD
        return this.combinePrdSections(prdParts);
    }

    /**
     * Combine chunked PRD sections into a cohesive document.
     */
    private combinePrdSections(parts: string[]): string {
        const [problemStatement, funcReqs, nonFuncReqs, techPlan, acceptanceCriteria] = parts;
        
        return `# Product Requirement Document

## Problem Statement
${problemStatement || 'Not specified'}

## Functional Requirements
${funcReqs || 'Not specified'}

## Non-Functional Requirements
${nonFuncReqs || 'Not specified'}

## Technical Implementation Plan
${techPlan || 'Not specified'}

## Acceptance Criteria
${acceptanceCriteria || 'Not specified'}
`;
    }

    /**
     * Summarize clarifications to reduce token usage.
     */
    private summarizeClarifications(): string {
        const clarifications = this._state.clarifications;
        if (clarifications.length <= 3) {
            return clarifications.map(c => `- ${c.response}`).join('\n');
        }

        // Group and summarize older clarifications
        const recent = clarifications.slice(-3);
        const older = clarifications.slice(0, -3);
        
        const olderSummary = older.map(c => c.response.slice(0, 100)).join('; ');
        const recentList = recent.map(c => `- ${c.response}`).join('\n');
        
        return `Previous clarifications (summary): ${olderSummary}\n\nRecent clarifications:\n${recentList}`;
    }

    /**
     * Summarize critique to key issues only.
     */
    private summarizeCritique(): string {
        const critique = this._state.latestCritique;
        if (!critique) return 'No critique available';

        const highPriorityIssues = (critique.issues || [])
            .filter(i => i.severity === 'high' || i.severity === 'medium')
            .slice(0, 5)
            .map(i => `- [${i.severity}] ${i.description}`)
            .join('\n');

        return `Confidence: ${critique.confidenceScore}%\nKey issues:\n${highPriorityIssues || 'None'}`;
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

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`AI call (${persona}) timed out after ${AI_CALL_TIMEOUT_MS / 1000}s. The model may be busy or unavailable. Try again or use a different model.`));
            }, AI_CALL_TIMEOUT_MS);
        });

        try {
            console.log(`[RefinementSession] Calling AI with persona: ${persona}`);
            // Race the AI call against a timeout to prevent indefinite hang (e.g. on "Request Changes")
            const result = await Promise.race([
                this._aiSession.sendMessage(prompt),
                timeoutPromise
            ]);
            // response is an object, not a Promise
            const text = result.response.text();
            console.log(`[RefinementSession] AI response received (${text.length} chars)`);
            return text;
        } catch (error: any) {
            const message = error?.message || String(error);
            console.error(`[RefinementSession] AI call failed:`, error);
            this._onEvent.fire({
                type: 'error',
                sessionId: this.sessionId,
                payload: message
            });
            throw error;
        }
    }

    /**
     * Parse structured questionnaire JSON block from analyst response.
     * Returns parsed questions or null if no valid questionnaire block found.
     */
    private parseQuestionnaireBlock(response: string): { questions: ClarifyingQuestion[], contextSummary?: string } | null {
        // Look for ```questionnaire ... ``` block
        const match = response.match(/```questionnaire\s*([\s\S]*?)```/);
        if (!match) return null;

        try {
            const parsed = JSON.parse(match[1].trim());
            if (!parsed.questions || !Array.isArray(parsed.questions)) {
                return null;
            }

            // Validate and normalize questions
            const questions: ClarifyingQuestion[] = parsed.questions.map((q: any, idx: number) => ({
                id: q.id || `q${idx + 1}`,
                question: q.question || '',
                category: q.category || 'requirement',
                options: Array.isArray(q.options) ? q.options : undefined,
                allowMultiple: q.allowMultiple === true,
                inputType: q.inputType || (Array.isArray(q.options) ? 'select' : 'text'),
                placeholder: q.placeholder || undefined,
                required: q.required !== false  // Default to true
            })).filter((q: ClarifyingQuestion) => q.question.length > 0);

            return {
                questions,
                contextSummary: parsed.contextSummary || undefined
            };
        } catch (e) {
            console.warn('[RefinementSession] Failed to parse questionnaire JSON:', e);
            return null;
        }
    }

    /**
     * Get text content outside the questionnaire block for display.
     */
    private getResponseWithoutQuestionnaire(response: string): string {
        // Remove the questionnaire block but keep the rest of the response
        return response.replace(/```questionnaire\s*[\s\S]*?```/g, '').trim();
    }

    private parseAnalystResponse(response: string): RefinementTurn {
        // First, try to parse structured questionnaire block
        const structuredQuestionnaire = this.parseQuestionnaireBlock(response);
        
        // Check if response contains a PRD draft (look for structured headers)
        const hasDraft = response.includes('## Functional Requirements') ||
            response.includes('## Problem Statement') ||
            response.includes('# ') && response.includes('Requirements');

        if (hasDraft) {
            this._state.currentDraft = response;
            // NOTE: Do NOT fire event here - let the calling code decide what to display
            // to avoid duplicate bubbles in the UI
        }

        // If we have structured questions, use those
        if (structuredQuestionnaire && structuredQuestionnaire.questions.length > 0) {
            return {
                role: 'analyst',
                content: response,
                timestamp: Date.now(),
                metadata: {
                    questions: structuredQuestionnaire.questions,
                    hasDraft,
                    // Store context summary in metadata for UI
                    contextSummary: structuredQuestionnaire.contextSummary
                } as any  // Extended metadata type
            };
        }

        // Fallback: Extract questions from free-form text (look for numbered list or question marks)
        // This is for state tracking, NOT for separate display
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
            metadata: questions.length > 0 ? { questions, hasDraft } : (hasDraft ? { hasDraft } : undefined)
        };
    }

    private parseCritiqueResponse(response: string): CritiqueResult {
        // Try multiple strategies to parse the critique response
        
        // Strategy 1: Look for JSON in various formats
        const jsonPatterns = [
            /```json\n?([\s\S]*?)\n?```/i,    // ```json ... ```
            /```JSON\n?([\s\S]*?)\n?```/,      // ```JSON ... ```
            /```\n?(\{[\s\S]*?\})\n?```/,      // ``` { ... } ```
            /(\{[\s\S]*"confidenceScore"[\s\S]*\})/  // Raw JSON with confidenceScore
        ];

        for (const pattern of jsonPatterns) {
            const match = response.match(pattern);
            if (match && match[1]) {
                try {
                    const parsed = JSON.parse(match[1].trim());
                    if (typeof parsed.confidenceScore === 'number' || parsed.confidence_score !== undefined) {
                        const score = parsed.confidenceScore ?? parsed.confidence_score ?? 75;
                        return {
                            confidenceScore: score,
                            passedValidation: parsed.passedValidation ?? parsed.passed_validation ?? (score >= 70),
                            issues: Array.isArray(parsed.issues) ? parsed.issues : []
                        };
                    }
                } catch {
                    // Continue to next pattern
                }
            }
        }

        // Strategy 2: Try direct JSON parse
        try {
            const parsed = JSON.parse(response.trim());
            if (typeof parsed.confidenceScore === 'number') {
                return {
                    confidenceScore: parsed.confidenceScore,
                    passedValidation: parsed.passedValidation ?? (parsed.confidenceScore >= 70),
                    issues: Array.isArray(parsed.issues) ? parsed.issues : []
                };
            }
        } catch {
            // Continue to natural language extraction
        }

        // Strategy 3: Extract from natural language
        // Look for confidence score mentions
        const scoreMatch = response.match(/confidence[:\s]*(\d+)/i) ||
                          response.match(/score[:\s]*(\d+)/i) ||
                          response.match(/(\d+)%?\s*confidence/i) ||
                          response.match(/rating[:\s]*(\d+)/i);
        
        const extractedScore = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

        // Look for approval indicators
        const approvalIndicators = [
            /\bapprove[ds]?\b/i,
            /\blooks?\s+good\b/i,
            /\bno\s+(?:major\s+)?issues?\b/i,
            /\bwell[\s-]?defined\b/i,
            /\bcomprehensive\b/i,
            /\bpasses?\s+validation\b/i
        ];
        
        const rejectionIndicators = [
            /\breject(?:ed|s)?\b/i,
            /\bfail(?:ed|s)?\b/i,
            /\bmajor\s+issues?\b/i,
            /\bcritical\s+(?:issues?|problems?)\b/i,
            /\bnot\s+ready\b/i,
            /\bincomplete\b/i
        ];

        const hasApproval = approvalIndicators.some(p => p.test(response));
        const hasRejection = rejectionIndicators.some(p => p.test(response));

        // Determine result based on extracted information
        let confidenceScore = extractedScore ?? 75;
        let passedValidation = true;

        if (hasRejection && !hasApproval) {
            passedValidation = false;
            confidenceScore = extractedScore ?? 50;
        } else if (hasApproval) {
            passedValidation = true;
            confidenceScore = extractedScore ?? 85;
        }

        // Extract any issues mentioned (using proper CritiqueIssue types)
        const issues: CritiqueIssue[] = [];
        const issuePatterns = [
            /(?:issue|problem|concern|gap)[:\s]+([^.\n]+)/gi,
            /(?:missing|lacks?|needs?)[:\s]+([^.\n]+)/gi,
            /(?:ambiguous|unclear|vague)[:\s]+([^.\n]+)/gi
        ];

        for (const pattern of issuePatterns) {
            let issueMatch;
            while ((issueMatch = pattern.exec(response)) !== null) {
                issues.push({
                    type: 'ambiguity' as const,
                    severity: 'medium' as const,
                    description: issueMatch[1].trim()
                });
            }
        }

        console.log(`[RefinementSession] Extracted critique: score=${confidenceScore}, passed=${passedValidation}, issues=${issues.length}`);
        
        return {
            confidenceScore,
            passedValidation,
            issues
        };
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
