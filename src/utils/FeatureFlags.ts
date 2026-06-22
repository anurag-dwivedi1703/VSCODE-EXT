/**
 * FeatureFlags.ts
 * 
 * Centralized feature flags for gradual rollout and A/B testing.
 * These flags allow enabling/disabling features without code changes.
 */

/**
 * Feature flags interface - defines all available flags
 */
export interface IFeatureFlags {
    /**
     * Enable the TurnManager for phase-aware context management.
     * When enabled, the TaskRunner will use TurnManager to:
     * - Track conversation turns with phase associations
     * - Summarize completed phases to free context space
     * - Inject phase progress into agent context
     * 
     * Default: false (safe rollout - existing behavior unchanged)
     */
    USE_TURN_MANAGER: boolean;

    /**
     * Enable verbose logging for TurnManager operations.
     * Logs phase transitions, summarizations, and context optimizations.
     * 
     * Default: true (helpful for debugging during rollout)
     */
    TURN_MANAGER_LOGGING: boolean;

    /**
     * Enable stage-isolated AI sessions for Refinement Mode.
     * When enabled, each stage (analyst/critic/refiner) gets a fresh ISession
     * with the correct persona system prompt, preventing cross-stage token
     * accumulation and message array bloat.
     * Also enables file-based state persistence between stages and cycles.
     *
     * Default: false (existing behavior unchanged)
     */
    USE_STAGE_ISOLATED_SESSIONS: boolean;

    /**
     * When enabled, creates a fresh AI session at artifact-driven phase boundaries
     * (planning→implementation, implementation phase N→N+1, implementation→testing)
     * to prevent context window exhaustion. Artifacts on disk serve as persistent
     * state across sessions.
     *
     * Default: false (safe rollout, zero behavior change)
     */
    USE_PHASE_BOUNDARY_RESETS: boolean;

    /**
     * Enable parallel sub-agent discovery. When enabled, the main agent
     * can spawn read-only sub-agents to analyze file groups in parallel
     * during the Discovery phase, keeping its own context small.
     *
     * Default: true
     */
    USE_DISCOVERY_SUB_AGENTS: boolean;

    /**
     * Enable mid-session context pruning in Copilot clients.
     * When disabled, the messages[] array is never pruned.
     * Intended to be disabled when USE_DISCOVERY_SUB_AGENTS is true,
     * since sub-agents prevent context accumulation in the first place.
     *
     * Default: false
     */
    ENABLE_CONTEXT_PRUNING: boolean;

    /**
     * Enable native tool calling via vscode.lm API for Copilot clients.
     * When enabled, Copilot clients pass LanguageModelChatTool[] to sendRequest()
     * and process LanguageModelToolCallPart from the response stream.
     * When disabled, falls back to text-parsed tool calling (```tool_call blocks).
     *
     * Default: true
     */
    USE_NATIVE_TOOL_CALLING: boolean;

    /**
     * Enable discovery sub-agents during Refinement Mode.
     * When enabled, the analyst and refiner can request targeted codebase
     * investigations via spawn_analysis_agents. The Critic is unaffected.
     * Requires USE_DISCOVERY_SUB_AGENTS to also be true.
     *
     * Default: false (safe rollout — existing refinement behavior unchanged)
     */
    USE_REFINEMENT_DISCOVERY: boolean;
}

/**
 * Default feature flag values
 */
const DEFAULT_FLAGS: IFeatureFlags = {
    USE_TURN_MANAGER: false,
    TURN_MANAGER_LOGGING: true,
    USE_STAGE_ISOLATED_SESSIONS: true,
    USE_PHASE_BOUNDARY_RESETS: true,
    USE_DISCOVERY_SUB_AGENTS: true,
    ENABLE_CONTEXT_PRUNING: false,
    USE_NATIVE_TOOL_CALLING: true,
    USE_REFINEMENT_DISCOVERY: true,
};

/**
 * Runtime feature flags - can be modified at runtime if needed
 */
export const FEATURE_FLAGS: IFeatureFlags = { ...DEFAULT_FLAGS };

/**
 * Reset all flags to default values
 */
export function resetFeatureFlags(): void {
    Object.assign(FEATURE_FLAGS, DEFAULT_FLAGS);
}

/**
 * Set a specific feature flag
 */
export function setFeatureFlag<K extends keyof IFeatureFlags>(
    flag: K,
    value: IFeatureFlags[K]
): void {
    FEATURE_FLAGS[flag] = value;
}

/**
 * Get current value of a feature flag
 */
export function getFeatureFlag<K extends keyof IFeatureFlags>(
    flag: K
): IFeatureFlags[K] {
    return FEATURE_FLAGS[flag];
}

/**
 * Check if TurnManager should be used
 * Convenience function for common check
 */
export function useTurnManager(): boolean {
    return FEATURE_FLAGS.USE_TURN_MANAGER;
}

/**
 * Check if TurnManager logging is enabled
 * Convenience function for common check
 */
export function turnManagerLoggingEnabled(): boolean {
    return FEATURE_FLAGS.TURN_MANAGER_LOGGING;
}

/**
 * Log current feature flag configuration. Call at startup.
 */
export function logFeatureFlags(): void {
    console.log(
        `[FeatureFlags] Discovery sub-agents: ${FEATURE_FLAGS.USE_DISCOVERY_SUB_AGENTS ? 'enabled' : 'disabled'}, ` +
        `Context pruning: ${FEATURE_FLAGS.ENABLE_CONTEXT_PRUNING ? 'enabled' : 'disabled'}, ` +
        `Refinement discovery: ${FEATURE_FLAGS.USE_REFINEMENT_DISCOVERY ? 'enabled' : 'disabled'}, ` +
        `Native tool calling: ${FEATURE_FLAGS.USE_NATIVE_TOOL_CALLING ? 'enabled' : 'disabled'}, ` +
        `Stage isolated sessions: ${FEATURE_FLAGS.USE_STAGE_ISOLATED_SESSIONS ? 'enabled' : 'disabled'}`
    );
    if (!FEATURE_FLAGS.USE_DISCOVERY_SUB_AGENTS && !FEATURE_FLAGS.ENABLE_CONTEXT_PRUNING) {
        console.warn('[FeatureFlags] ⚠️ Both discovery sub-agents AND context pruning are disabled — unbounded context accumulation may occur');
    }
}
