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
import { RefinementArtifact, RefinementEvent, RefinementState, DiscoveryExecutor, RefinementToolExecutor } from './RefinementTypes';
import { getPersonaPrompt, formatConstitutionForRefinement, GPT_ANALYST_ENHANCEMENT, getDiscoveryInstructions } from './RefinementPrompts';
import { GeminiClient, ISession } from '../../ai/GeminiClient';
import { ClaudeClient } from '../../ai/ClaudeClient';
import { CopilotClaudeClient } from '../../ai/CopilotClaudeClient';
import { CopilotGPTClient } from '../../ai/CopilotGPTClient';
import { CopilotGeminiClient } from '../../ai/CopilotGeminiClient';
import { SmartContextBuilder, SmartContext } from './SmartContextBuilder';
import { RefinementTokenManager } from './RefinementTokenManager';
import { RefinementCheckpointManager } from './RefinementCheckpointManager';
import { FEATURE_FLAGS } from '../../utils/FeatureFlags';
import { getRefinementDiscoveryTools } from '../../ai/CopilotToolDefinitions';

/**
 * AI Client type union for flexibility.
 */
type AIClient = GeminiClient | ClaudeClient | CopilotClaudeClient | CopilotGPTClient | CopilotGeminiClient;

export class RefinementManager {
    private _sessions: Map<string, RefinementSession> = new Map();
    private _aiClients: Map<string, AIClient> = new Map();
    private _discoveryEnabled: Map<string, boolean> = new Map();
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
     * @param constitution Optional workspace constitution content
     * @param missionFolder Optional mission folder path for checkpoint persistence
     * @returns The session ID
     */
    public async startSessionWithSmartContext(
        taskId: string,
        userPrompt: string,
        aiClient: AIClient,
        workspaceRoot: string,
        modelId?: string,
        constitution?: string,
        missionFolder?: string,
        discoveryExecutor?: DiscoveryExecutor,
        toolExecutor?: RefinementToolExecutor
    ): Promise<string> {
        // Validate workspace root
        if (!workspaceRoot) {
            throw new Error('workspaceRoot is required for smart context building');
        }

        // Detect model ID from client if not provided
        const effectiveModelId = modelId || this.detectModelId(aiClient);
        
        // Extract dynamic token limits from Copilot clients (if available)
        const apiMaxInput = this.extractMaxInputTokens(aiClient);

        // Check if discovery tools are enabled — if so, skip expensive SmartContext
        const discoveryToolsEnabled = FEATURE_FLAGS.USE_REFINEMENT_DISCOVERY &&
                                       FEATURE_FLAGS.USE_DISCOVERY_SUB_AGENTS &&
                                       !!discoveryExecutor;

        console.log(`[RefinementManager] Discovery check: flags=[DISCOVERY=${FEATURE_FLAGS.USE_REFINEMENT_DISCOVERY}, SUB_AGENTS=${FEATURE_FLAGS.USE_DISCOVERY_SUB_AGENTS}], hasExecutor=${!!discoveryExecutor}, hasToolExecutor=${!!toolExecutor}, result=${discoveryToolsEnabled}`);

        if (discoveryToolsEnabled) {
            // Agent has search tools — skip expensive SmartContext, provide minimal orientation
            this._onEvent.fire({
                type: 'progress', sessionId: taskId,
                payload: 'Discovery tools enabled — agent will search codebase on-demand'
            });

            const minimalContext = await this.buildMinimalProjectContext(workspaceRoot);

            console.log(`[RefinementManager] Using minimal project context (~${minimalContext.length} chars) instead of SmartContext`);

            return this.startSession(taskId, userPrompt, aiClient, minimalContext,
                modelId, constitution, missionFolder, discoveryExecutor, toolExecutor);
        }

        // Calculate token budget for context based on model
        const tokenManager = new RefinementTokenManager(effectiveModelId, apiMaxInput);
        const tokenBudget = tokenManager.getAvailableTokensForStage('analyst');
        
        // Fire progress event for UI feedback
        this._onEvent.fire({
            type: 'progress',
            sessionId: taskId,
            payload: `Scanning workspace for relevant files: ${workspaceRoot}`
        });
        
        console.log(`[RefinementManager] Building smart context for workspace: ${workspaceRoot}`);
        console.log(`[RefinementManager] Prompt: "${userPrompt.slice(0, 100)}..."`);
        if (constitution) {
            console.log(`[RefinementManager] Constitution provided (${constitution.length} chars)`);
        }
        
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
        
        // Now start the session with the smart context and constitution
        return this.startSession(taskId, userPrompt, aiClient, smartContext.content, modelId, constitution, missionFolder, discoveryExecutor, toolExecutor);
    }

    /**
     * Start a new refinement session for a task.
     * @param taskId The task/mission ID
     * @param userPrompt The user's original prompt
     * @param aiClient The AI client to use for LLM calls
     * @param skeletonContext The codebase skeleton context (or smart context)
     * @param modelId Optional model identifier for token budget calculation
     * @param constitution Optional workspace constitution content
     * @param missionFolder Optional mission folder path for checkpoint persistence
     * @returns The session ID
     */
    public async startSession(
        taskId: string,
        userPrompt: string,
        aiClient: AIClient,
        skeletonContext: string,
        modelId?: string,
        constitution?: string,
        missionFolder?: string,
        discoveryExecutor?: DiscoveryExecutor,
        toolExecutor?: RefinementToolExecutor
    ): Promise<string> {
        const sessionId = `refine-${taskId}-${Date.now()}`;

        // Detect model ID from client if not provided
        const effectiveModelId = modelId || this.detectModelId(aiClient);

        // Extract dynamic token limits from Copilot clients (if available)
        const apiMaxInput = this.extractMaxInputTokens(aiClient);

        // Create the session with model ID for token budget awareness
        const session = new RefinementSession(sessionId, taskId, userPrompt, effectiveModelId, apiMaxInput);

        // Subscribe to session events and forward them
        session.onEvent((event) => {
            this._onEvent.fire(event);
        });

        // Create an AI session with Analyst persona for initial interaction
        // IMPORTANT: Pass false for includeToolInstructions to prevent AI from using tools in Refinement Mode
        // Inject constitution context into the system prompt if available
        const constitutionContext = formatConstitutionForRefinement(constitution);
        let analystPrompt = constitutionContext 
            ? `${constitutionContext}\n\n${getPersonaPrompt('analyst')}`
            : getPersonaPrompt('analyst');
        
        if (constitutionContext) {
            console.log(`[RefinementManager] Injected constitution context into analyst prompt (${constitutionContext.length} chars)`);
        }
        
        // Apply GPT-specific prompt enhancement for GPT models
        if (this.isGPTModel(aiClient)) {
            analystPrompt += GPT_ANALYST_ENHANCEMENT;
            console.log(`[RefinementManager] Applied GPT-specific prompt enhancement for better format compliance`);
        }

        const discoveryToolsEnabled = FEATURE_FLAGS.USE_REFINEMENT_DISCOVERY && 
                                       FEATURE_FLAGS.USE_DISCOVERY_SUB_AGENTS && 
                                       !!discoveryExecutor;

        if (discoveryToolsEnabled) {
            analystPrompt += getDiscoveryInstructions();
        }

        const aiSession = discoveryToolsEnabled
            ? aiClient.startSession(analystPrompt, 'high', true, getRefinementDiscoveryTools())
            : aiClient.startSession(analystPrompt, 'high', false);
        session.setAISession(aiSession);

        // Store the session and constitution for later persona switches
        this._sessions.set(sessionId, session);
        this._aiClients.set(sessionId, aiClient);
        this._discoveryEnabled.set(sessionId, discoveryToolsEnabled);
        // Store constitution for use when switching to critic/refiner personas
        (session as any)._constitutionContext = constitutionContext;

        // Provide a factory for creating stage-isolated sessions (used when flag is ON)
        session.setSessionFactory((persona) => this.createStageSession(sessionId, persona));

        // Enable discovery sub-agents if executor provided and flag is on
        if (discoveryExecutor && FEATURE_FLAGS.USE_REFINEMENT_DISCOVERY) {
            session.setDiscoveryExecutor(discoveryExecutor);
            console.log(`[RefinementManager] Discovery sub-agents enabled for session ${sessionId}`);
        }

        // Enable lightweight tool executor if provided and flag is on
        if (toolExecutor && FEATURE_FLAGS.USE_REFINEMENT_DISCOVERY) {
            session.setToolExecutor(toolExecutor);
            console.log(`[RefinementManager] Lightweight tools enabled for session ${sessionId}`);
        }

        // Initialize checkpoint manager for file-based state persistence
        if (FEATURE_FLAGS.USE_STAGE_ISOLATED_SESSIONS && missionFolder) {
            const checkpointMgr = new RefinementCheckpointManager(missionFolder, sessionId, taskId);
            checkpointMgr.initCheckpoint(userPrompt, skeletonContext, constitutionContext || '');
            session.setCheckpointManager(checkpointMgr);
        }

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
        this._discoveryEnabled.delete(sessionId);
        console.log(`[RefinementManager] Cleaned up session ${sessionId}`);
    }

    /**
     * Create a fresh ISession for a specific refinement stage.
     * Each stage gets its own session with the correct persona system prompt,
     * preventing cross-stage token accumulation.
     */
    private createStageSession(
        sessionId: string,
        persona: 'analyst' | 'critic' | 'refiner'
    ): ISession {
        const aiClient = this._aiClients.get(sessionId);
        if (!aiClient) {
            throw new Error(`No AI client for session: ${sessionId}`);
        }

        const session = this._sessions.get(sessionId);
        const constitutionContext = (session as any)?._constitutionContext || '';

        let systemPrompt = constitutionContext
            ? `${constitutionContext}\n\n${getPersonaPrompt(persona)}`
            : getPersonaPrompt(persona);

        // Apply GPT enhancement for analyst on GPT models
        if (persona === 'analyst' && this.isGPTModel(aiClient)) {
            systemPrompt += GPT_ANALYST_ENHANCEMENT;
        }

        // Determine if this persona should get discovery tools
        const discoveryEnabled = this._discoveryEnabled.get(sessionId) === true &&
                                 (persona === 'analyst' || persona === 'refiner');

        if (discoveryEnabled) {
            systemPrompt += getDiscoveryInstructions();
            return aiClient.startSession(systemPrompt, 'high', true, getRefinementDiscoveryTools());
        } else {
            return aiClient.startSession(systemPrompt, 'high', false);
        }
    }

    /**
     * Public wrapper for creating stage sessions (used by RefinementSession via factory).
     */
    public getStageSession(sessionId: string, persona: 'analyst' | 'critic' | 'refiner'): ISession {
        return this.createStageSession(sessionId, persona);
    }

    /**
     * Extract maxInputTokens from Copilot clients that expose getModelLimits().
     */
    private extractMaxInputTokens(client: AIClient): number | undefined {
        if (client instanceof CopilotClaudeClient || client instanceof CopilotGPTClient || client instanceof CopilotGeminiClient) {
            return client.getModelLimits().maxInputTokens;
        }
        return undefined;
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
            return 'gpt-5-mini';
        }
        if (client instanceof CopilotGeminiClient) {
            return 'gemini-2.5-pro';
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
     * Check if the AI client is a GPT-based model.
     * GPT models may need different prompt formatting than Claude/Gemini.
     */
    private isGPTModel(client: AIClient): boolean {
        if (client instanceof CopilotGPTClient) {
            return true;
        }
        // Also check if there's a modelId property that indicates GPT
        const clientAny = client as any;
        if (clientAny.modelId && typeof clientAny.modelId === 'string') {
            const modelId = clientAny.modelId.toLowerCase();
            return modelId.includes('gpt') || modelId.includes('o1') || modelId.includes('codex');
        }
        return false;
    }

    /**
     * Build a minimal project context for discovery-enabled refinement sessions.
     * Provides just enough orientation (~500 tokens) for the agent to start
     * using search tools intelligently. Replaces the 21K+ token SmartContext.
     */
    private async buildMinimalProjectContext(workspaceRoot: string): Promise<string> {
        const parts: string[] = [];
        const path = await import('path');
        const fs = await import('fs');

        // 1. Project name
        parts.push(`## Workspace: ${path.basename(workspaceRoot)}`);

        // 2. package.json summary (if exists)
        const pkgPath = path.join(workspaceRoot, 'package.json');
        try {
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                const deps = Object.keys(pkg.dependencies || {}).slice(0, 15).join(', ');
                const devDeps = Object.keys(pkg.devDependencies || {}).slice(0, 10).join(', ');
                parts.push(`**Project:** ${pkg.name || 'unknown'} — ${pkg.description || 'No description'}`);
                if (deps) { parts.push(`**Dependencies:** ${deps}`); }
                if (devDeps) { parts.push(`**Dev Dependencies:** ${devDeps}`); }
            }
        } catch { /* ignore parse errors */ }

        // 3. Top-level directory listing
        try {
            const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
            const dirs = entries.filter((e: any) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
                .map((e: any) => e.name + '/').slice(0, 20);
            const files = entries.filter((e: any) => e.isFile()).map((e: any) => e.name).slice(0, 15);
            parts.push(`**Top-level directories:** ${dirs.join(', ')}`);
            parts.push(`**Top-level files:** ${files.join(', ')}`);
        } catch { /* ignore access errors */ }

        // 4. Guidance
        parts.push(`\nYou have grep_search, codebase_search, list_files, file_search, get_diagnostics, and spawn_analysis_agents tools available.`);
        parts.push(`Use them to explore this codebase and understand it before drafting requirements.`);
        parts.push(`Prefer codebase_search when exploring by concept (e.g., "authentication flow") and grep_search for exact text matches.`);

        return parts.join('\n');
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
