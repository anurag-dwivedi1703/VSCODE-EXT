/**
 * RefinementManager.ts
 * Orchestrates refinement sessions and provides the main entry point for Refinement Mode.
 * Decouples refinement logic from TaskRunner and MissionControlProvider.
 * 
 * Smart Context Building:
 * - Uses SmartContextBuilder to intelligently scan relevant files
 * - Provides full content for highly relevant files, skeleton for structure
 * - Eliminates need for mid-session tool calls or user-provided file contents
 */

import * as vscode from 'vscode';
import { RefinementSession } from './RefinementSession';
import { RefinementArtifact, RefinementEvent, RefinementState } from './RefinementTypes';
import { getPersonaPrompt } from './RefinementPrompts';
import { GeminiClient, ISession } from '../../ai/GeminiClient';
import { ClaudeClient } from '../../ai/ClaudeClient';
import { CopilotClaudeClient } from '../../ai/CopilotClaudeClient';
import { CopilotGPTClient } from '../../ai/CopilotGPTClient';
import { SmartContextBuilder, SmartContext } from './SmartContextBuilder';
import { RefinementTokenManager } from './RefinementTokenManager';

/**
 * AI Client type union for flexibility.
 */
type AIClient = GeminiClient | ClaudeClient | CopilotClaudeClient | CopilotGPTClient;

export class RefinementManager {
    private _sessions: Map<string, RefinementSession> = new Map();
    private _aiClients: Map<string, AIClient> = new Map();
    private _smartContextBuilder: SmartContextBuilder;

    // Event forwarding from sessions
    private _onEvent = new vscode.EventEmitter<RefinementEvent>();
    public readonly onEvent = this._onEvent.event;

    // Event for when refinement completes with approved artifact
    private _onRefinementComplete = new vscode.EventEmitter<{
        taskId: string;
        artifact: RefinementArtifact;
    }>();
    public readonly onRefinementComplete = this._onRefinementComplete.event;

    constructor() {
        this._smartContextBuilder = new SmartContextBuilder();
        console.log('[RefinementManager] Initialized with SmartContextBuilder');
    }

    // ========================================
    // Session Lifecycle
    // ========================================

    /**
     * Start a new refinement session with SMART context building.
     * This is the preferred method - it automatically scans relevant files.
     * 
     * IMPORTANT: Only searches within the specified workspaceRoot.
     * 
     * @param taskId The task/mission ID
     * @param userPrompt The user's original prompt
     * @param aiClient The AI client to use for LLM calls
     * @param workspaceRoot The workspace root to search for files (REQUIRED)
     * @param modelId Optional model identifier for token budget calculation
     * @returns The session ID
     */
    public async startSessionWithSmartContext(
        taskId: string,
        userPrompt: string,
        aiClient: AIClient,
        workspaceRoot: string,
        modelId?: string
    ): Promise<string> {
        // Validate workspace root
        if (!workspaceRoot) {
            throw new Error('workspaceRoot is required for smart context building');
        }

        // Detect model ID from client if not provided
        const effectiveModelId = modelId || this.detectModelId(aiClient);
        
        // Calculate token budget for context based on model
        const tokenManager = new RefinementTokenManager(effectiveModelId);
        const tokenBudget = tokenManager.getAvailableTokensForStage('analyst');
        
        // Fire progress event for UI feedback
        this._onEvent.fire({
            type: 'progress',
            sessionId: taskId,
            payload: `Scanning workspace for relevant files: ${workspaceRoot}`
        });
        
        console.log(`[RefinementManager] Building smart context for workspace: ${workspaceRoot}`);
        console.log(`[RefinementManager] Prompt: "${userPrompt.slice(0, 100)}..."`);
        
        // CRITICAL: Set the workspace root on the builder BEFORE building context
        this._smartContextBuilder.setWorkspaceRoot(workspaceRoot);
        
        // Build smart context using SmartContextBuilder (will only search within workspaceRoot)
        const smartContext = await this._smartContextBuilder.buildContext(userPrompt, tokenBudget, workspaceRoot);
        
        console.log(`[RefinementManager] Smart context built: ${smartContext.fullContentFiles} full files, ${smartContext.skeletonFiles} skeleton files, ~${smartContext.estimatedTokens} tokens`);
        
        // Fire progress event with results
        this._onEvent.fire({
            type: 'progress',
            sessionId: taskId,
            payload: `Found ${smartContext.fullContentFiles} relevant files (${smartContext.keywords.slice(0, 5).join(', ')})`
        });
        
        // Now start the session with the smart context
        return this.startSession(taskId, userPrompt, aiClient, smartContext.content, modelId);
    }

    /**
     * Start a new refinement session for a task.
     * @param taskId The task/mission ID
     * @param userPrompt The user's original prompt
     * @param aiClient The AI client to use for LLM calls
     * @param skeletonContext The codebase skeleton context (or smart context)
     * @param modelId Optional model identifier for token budget calculation
     * @returns The session ID
     */
    public async startSession(
        taskId: string,
        userPrompt: string,
        aiClient: AIClient,
        skeletonContext: string,
        modelId?: string
    ): Promise<string> {
        const sessionId = `refine-${taskId}-${Date.now()}`;

        // Detect model ID from client if not provided
        const effectiveModelId = modelId || this.detectModelId(aiClient);

        // Create the session with model ID for token budget awareness
        const session = new RefinementSession(sessionId, taskId, userPrompt, effectiveModelId);

        // Subscribe to session events and forward them
        session.onEvent((event) => {
            this._onEvent.fire(event);
        });

        // Create an AI session with Analyst persona for initial interaction
        // IMPORTANT: Pass false for includeToolInstructions to prevent AI from using tools in Refinement Mode
        const analystPrompt = getPersonaPrompt('analyst');
        const aiSession = aiClient.startSession(analystPrompt, 'high', false);
        session.setAISession(aiSession);

        // Store the session
        this._sessions.set(sessionId, session);
        this._aiClients.set(sessionId, aiClient);

        console.log(`[RefinementManager] Started session ${sessionId} for task ${taskId}`);

        // Start the refinement process
        await session.start(skeletonContext);

        return sessionId;
    }

    /**
     * Handle user message during an active refinement session.
     * @param sessionId The session ID
     * @param message The user's message
     */
    public async handleUserMessage(sessionId: string, message: string): Promise<void> {
        const session = this._sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        // Check if this is an approval command
        if (this.isApprovalCommand(message)) {
            this.approveSession(sessionId);
            return;
        }

        // Check if this is a cancel command
        if (this.isCancelCommand(message)) {
            this.cancelSession(sessionId);
            return;
        }

        // Handle as a clarification response
        await session.handleUserResponse(message);
    }

    /**
     * Approve the current refinement artifact.
     * @param sessionId The session ID
     */
    public approveSession(sessionId: string): void {
        const session = this._sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        session.approve();

        const artifact = session.finalArtifact;
        if (artifact) {
            this._onRefinementComplete.fire({
                taskId: this.getTaskIdFromSession(sessionId),
                artifact
            });
        }

        // Clean up
        this.cleanupSession(sessionId);
    }

    /**
     * Cancel an active refinement session.
     * @param sessionId The session ID
     */
    public cancelSession(sessionId: string): void {
        const session = this._sessions.get(sessionId);
        if (!session) {
            return;
        }

        session.cancel();
        this.cleanupSession(sessionId);
    }

    // ========================================
    // Session Queries
    // ========================================

    /**
     * Get the state of a refinement session.
     */
    public getSessionState(sessionId: string): RefinementState | null {
        const session = this._sessions.get(sessionId);
        return session ? session.state : null;
    }

    /**
     * Get the current draft/artifact from a session.
     */
    public getSessionDraft(sessionId: string): string | null {
        const session = this._sessions.get(sessionId);
        if (!session) return null;

        const state = session.getStateObject();
        return state.currentDraft || state.finalArtifact?.rawMarkdown || null;
    }

    /**
     * Get the session ID for a given task.
     */
    public getSessionForTask(taskId: string): string | null {
        for (const [sessionId, session] of this._sessions) {
            if (sessionId.includes(taskId)) {
                return sessionId;
            }
        }
        return null;
    }

    /**
     * Check if a task has an active refinement session.
     */
    public hasActiveSession(taskId: string): boolean {
        return this.getSessionForTask(taskId) !== null;
    }

    /**
     * Get the final artifact for a completed session.
     */
    public getArtifact(sessionId: string): RefinementArtifact | null {
        const session = this._sessions.get(sessionId);
        return session ? session.finalArtifact || null : null;
    }

    /**
     * Get conversation history for a session.
     */
    public getConversationHistory(sessionId: string): string {
        const session = this._sessions.get(sessionId);
        if (!session) {
            return '';
        }

        return session.conversationHistory
            .map(turn => `[${turn.role.toUpperCase()}]: ${turn.content}`)
            .join('\n\n---\n\n');
    }

    // ========================================
    // Private Helpers
    // ========================================

    private isApprovalCommand(message: string): boolean {
        const lower = message.toLowerCase().trim();
        return lower === 'approve' ||
            lower === 'lgtm' ||
            lower === 'approved' ||
            lower === 'yes' ||
            lower.includes('approve the plan');
    }

    private isCancelCommand(message: string): boolean {
        const lower = message.toLowerCase().trim();
        return lower === 'cancel' ||
            lower === 'abort' ||
            lower === 'stop refinement' ||
            lower === 'exit';
    }

    private getTaskIdFromSession(sessionId: string): string {
        // Session IDs are formatted as: refine-{taskId}-{timestamp}
        const parts = sessionId.split('-');
        if (parts.length >= 2) {
            // Reconstruct taskId (which may contain hyphens)
            return parts.slice(1, -1).join('-');
        }
        return sessionId;
    }

    private cleanupSession(sessionId: string): void {
        this._sessions.delete(sessionId);
        this._aiClients.delete(sessionId);
        console.log(`[RefinementManager] Cleaned up session ${sessionId}`);
    }

    /**
     * Detect model ID from AI client for token budget calculation.
     */
    private detectModelId(client: AIClient): string {
        // Check for model identifier based on client type
        if (client instanceof CopilotClaudeClient) {
            return 'claude-sonnet-4';
        }
        if (client instanceof CopilotGPTClient) {
            return 'gpt-4o';
        }
        if (client instanceof ClaudeClient) {
            return 'claude-3-5-sonnet';
        }
        if (client instanceof GeminiClient) {
            return 'gemini-2.0-flash';
        }
        return 'default';
    }

    /**
     * Dispose all sessions and resources.
     */
    public dispose(): void {
        for (const sessionId of this._sessions.keys()) {
            this.cleanupSession(sessionId);
        }
        this._onEvent.dispose();
        this._onRefinementComplete.dispose();
    }
}

// Singleton instance for use across the extension
let _instance: RefinementManager | null = null;

export function getRefinementManager(): RefinementManager {
    if (!_instance) {
        _instance = new RefinementManager();
    }
    return _instance;
}
