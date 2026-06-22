import * as vscode from 'vscode';
import { ISession } from './GeminiClient';
import { FEATURE_FLAGS } from '../utils/FeatureFlags';

/**
 * Claude client using VS Code's Language Model API (vscode.lm)
 * This leverages the user's GitHub Copilot subscription for Claude access
 */
export interface CopilotModelLimits {
    maxInputTokens: number | undefined;
    // Future: maxOutputTokens when VS Code LM API exposes it
}

export class CopilotClaudeClient {
    private model: vscode.LanguageModelChat | undefined;

    constructor() {
        // Model will be selected when session starts
    }

    public getModelLimits(): CopilotModelLimits {
        return {
            maxInputTokens: this.model?.maxInputTokens
        };
    }

    /**
     * Static method to discover and log all available vscode.lm models
     * Call this to see what models are available in your environment
     */
    public static async discoverModels(): Promise<vscode.LanguageModelChat[]> {
        try {
            const allModels = await vscode.lm.selectChatModels({});

            console.log('╔══════════════════════════════════════════════════════════════════╗');
            console.log('║           VS CODE LANGUAGE MODEL API - AVAILABLE MODELS          ║');
            console.log('╠══════════════════════════════════════════════════════════════════╣');

            allModels.forEach((m, i) => {
                console.log(`║ [${i + 1}] ID: ${m.id}`);
                console.log(`║     Name: ${m.name}`);
                console.log(`║     Vendor: ${m.vendor}`);
                console.log(`║     Family: ${m.family}`);
                console.log(`║     Max Input Tokens: ${m.maxInputTokens || 'N/A'}`);
                console.log('╟──────────────────────────────────────────────────────────────────╢');
            });

            console.log(`║ TOTAL MODELS AVAILABLE: ${allModels.length}`);
            console.log('╚══════════════════════════════════════════════════════════════════╝');

            return allModels;
        } catch (error: any) {
            console.error('[CopilotClaudeClient] Error discovering models:', error.message);
            return [];
        }
    }

    /**
     * Get a Gemini model for vision analysis via vscode.lm
     */
    public static async getGeminiVisionModel(): Promise<vscode.LanguageModelChat | undefined> {
        try {
            const allModels = await vscode.lm.selectChatModels({});

            // Look for Gemini Flash 3 first (best for vision)
            let geminiModel = allModels.find(m =>
                m.id.toLowerCase().includes('gemini-3-flash') ||
                m.id.toLowerCase().includes('gemini-flash-3')
            );

            // Fallback to any Gemini model
            if (!geminiModel) {
                geminiModel = allModels.find(m =>
                    m.id.toLowerCase().includes('gemini') ||
                    m.family.toLowerCase().includes('gemini')
                );
            }

            if (geminiModel) {
                console.log(`[CopilotClaudeClient] Found Gemini vision model: ${geminiModel.id}`);
            }

            return geminiModel;
        } catch (error: any) {
            console.error('[CopilotClaudeClient] Error finding Gemini model:', error.message);
            return undefined;
        }
    }

    public async initialize(targetModelId?: string): Promise<boolean> {
        try {
            // Log all available models for discovery
            const allModels = await CopilotClaudeClient.discoverModels();

            // If a specific model was requested, find it by matching ID
            if (targetModelId) {
                const targetLower = targetModelId.toLowerCase();
                const exactMatch = allModels.find(m =>
                    m.id.toLowerCase().includes(targetLower) ||
                    m.family.toLowerCase().includes(targetLower)
                );
                if (exactMatch) {
                    this.model = exactMatch;
                    console.log(`[CopilotClaudeClient] ✓ Selected requested model: ${this.model.id} (${this.model.name})`);
                    return true;
                }
                console.warn(`[CopilotClaudeClient] Requested model '${targetModelId}' not found, falling back to default selection`);
            }

            // Default: Try to find Claude model - prefer opus, then sonnet
            let claudeModel = allModels.find(m =>
                m.id.toLowerCase().includes('claude-opus-4') ||
                m.id.toLowerCase().includes('claude-4-opus')
            );

            // Try Claude Sonnet 4.5
            if (!claudeModel) {
                claudeModel = allModels.find(m =>
                    m.id.toLowerCase().includes('claude-sonnet-4') ||
                    m.id.toLowerCase().includes('claude-4-sonnet')
                );
            }

            // Fallback to any Claude model
            if (!claudeModel) {
                claudeModel = allModels.find(m =>
                    m.id.toLowerCase().includes('claude') ||
                    m.name.toLowerCase().includes('claude') ||
                    m.family.toLowerCase().includes('claude')
                );
            }

            if (claudeModel) {
                this.model = claudeModel;
                console.log(`[CopilotClaudeClient] ✓ Selected Claude model: ${this.model.id} (${this.model.name})`);
                return true;
            }

            // Fallback: try specific family filters that might work
            const familyAttempts = ['claude', 'anthropic', 'claude-3', 'claude-opus', 'claude-sonnet'];
            for (const family of familyAttempts) {
                const models = await vscode.lm.selectChatModels({ family });
                if (models.length > 0) {
                    this.model = models[0];
                    console.log(`[CopilotClaudeClient] ✓ Found Claude model via family '${family}': ${this.model.id}`);
                    return true;
                }
            }

            console.error('[CopilotClaudeClient] ✗ No Claude models found. Available:', allModels.map(m => m.id).join(', '));
            return false;
        } catch (error: any) {
            console.error('[CopilotClaudeClient] Error initializing:', error.message);
            return false;
        }
    }

    public startSession(systemPrompt: string, _thinkingLevel: 'low' | 'high' = 'high', includeToolInstructions: boolean = true, tools?: vscode.LanguageModelChatTool[]): ISession {
        const messages: vscode.LanguageModelChatMessage[] = [];
        const model = this.model;

        // Determine if native tool calling should be used
        const useNativeTools = FEATURE_FLAGS.USE_NATIVE_TOOL_CALLING && includeToolInstructions && !!tools && tools.length > 0;

        // Store tool call parts from last response for result pairing (native mode only)
        let lastToolCallParts: vscode.LanguageModelToolCallPart[] = [];

        console.log(`[CopilotClaudeClient] Session mode: ${useNativeTools ? 'NATIVE tool calling' : includeToolInstructions ? 'LEGACY text-parsed tool calling' : 'NO tools (refinement)'} (${tools?.length ?? 0} tools provided)`);

        // Build system context — no tool format instructions needed for native mode
        let systemContext: string;
        if (useNativeTools) {
            systemContext = `[SYSTEM CONTEXT]\n${systemPrompt}\n[END SYSTEM CONTEXT]`;
        } else if (!includeToolInstructions) {
            // Refinement mode — explicitly disable tool usage
            systemContext = `[SYSTEM CONTEXT]\n${systemPrompt}\n\nIMPORTANT: You are in analysis/refinement mode. Do NOT use tools like list_files, read_file, or write_file. Only provide text responses - questions, analysis, or structured documents.\n[END SYSTEM CONTEXT]`;
        } else {
            // Legacy fallback: includeToolInstructions=true but native tools unavailable
            // The model will still use text-parsed tool calling without native tool support
            systemContext = `[SYSTEM CONTEXT]\n${systemPrompt}\n[END SYSTEM CONTEXT]`;
        }
        messages.push(vscode.LanguageModelChatMessage.User(systemContext));

        // Token tracking for context window management
        const maxTokens = model?.maxInputTokens ?? 128000;
        const responseReserve = Math.max(8000, Math.floor(maxTokens * 0.05)); // 5% of context or 8000, whichever is larger
        let estimatedTokensUsed = Math.ceil(systemContext.length / 4);

        const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
        const getAvailableTokens = (): number => maxTokens - responseReserve - estimatedTokensUsed;

        // Mid-session context pruning constants
        const MAX_CONTEXT_MESSAGES = 40;
        const PRUNED_KEEP_RECENT = 20;

        console.log(`[CopilotClaudeClient] Context pruning: ${FEATURE_FLAGS.ENABLE_CONTEXT_PRUNING ? 'enabled' : 'disabled'} (ENABLE_CONTEXT_PRUNING flag)`);

        function pruneMessagesIfNeeded(): void {
            if (!FEATURE_FLAGS.ENABLE_CONTEXT_PRUNING) {
                return;  // Pruning disabled — sub-agent discovery prevents context accumulation
            }
            if (messages.length <= MAX_CONTEXT_MESSAGES) {
                return;
            }

            const beforeCount = messages.length;

            // Always keep messages[0] (system context)
            const systemMessage = messages[0];

            // Keep the most recent PRUNED_KEEP_RECENT messages
            const recentMessages = messages.slice(-PRUNED_KEEP_RECENT);

            // Clear in-place (preserves closure reference) and rebuild
            messages.length = 0;
            messages.push(systemMessage);
            messages.push(...recentMessages);

            // Recalculate estimatedTokensUsed from actual remaining messages
            estimatedTokensUsed = 0;
            for (const msg of messages) {
                const textContent = msg.content
                    .map((part: any) => part.value || part.text || '')
                    .join('');
                estimatedTokensUsed += estimateTokens(textContent);
            }

            console.log(
                `[CopilotClaudeClient] \u{1F504} Context pruned: ${beforeCount} \u{2192} ${messages.length} messages. ` +
                `Tokens recalculated: ${estimatedTokensUsed}. ` +
                `Kept: system(1) + recent(${recentMessages.length})`
            );
        }

        return {
            sendMessage: async (prompt: string | any[]) => {
                if (!model) {
                    return {
                        response: {
                            text: () => 'Error: Copilot Claude model not initialized. Ensure GitHub Copilot is installed and you have an active subscription.',
                            functionCalls: () => undefined
                        }
                    };
                }

                try {
                    // Handle prompt - could be string or array of parts (for tool results)
                    let userMessage = '';
                    let nativeToolResultsHandled = false;

                    if (typeof prompt === 'string') {
                        userMessage = prompt;
                    } else if (Array.isArray(prompt)) {
                        const toolResponses = prompt.filter((p: any) => p.functionResponse);
                        if (toolResponses.length > 0 && useNativeTools && lastToolCallParts.length > 0) {
                            // ==================== NATIVE TOOL RESULT HANDLING ====================
                            // Echo the assistant's tool calls back as an assistant message
                            const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [...lastToolCallParts];
                            messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                            // Build tool result parts matched by position index
                            const resultParts: (vscode.LanguageModelToolResultPart)[] = toolResponses.map((tr: any, index: number) => {
                                const matchedCall = lastToolCallParts[Math.min(index, lastToolCallParts.length - 1)];
                                if (index >= lastToolCallParts.length) {
                                    console.warn(`[CopilotClaudeClient] Tool result index ${index} exceeds lastToolCallParts length ${lastToolCallParts.length}, using last call ID`);
                                }
                                const resultText = typeof tr.functionResponse.response?.content === 'string'
                                    ? tr.functionResponse.response.content
                                    : JSON.stringify(tr.functionResponse.response);
                                return new vscode.LanguageModelToolResultPart(matchedCall.callId, [new vscode.LanguageModelTextPart(resultText)]);
                            });
                            messages.push(vscode.LanguageModelChatMessage.User(resultParts));

                            // Track tokens for tool results
                            const resultTokens = resultParts.reduce((sum, rp) => {
                                const textContent = rp.content.map((c: any) => c.value || '').join('');
                                return sum + estimateTokens(textContent);
                            }, 0);
                            estimatedTokensUsed += resultTokens;

                            nativeToolResultsHandled = true;
                            console.log(`[CopilotClaudeClient] Native tool results: ${toolResponses.length} results paired with ${lastToolCallParts.length} call(s)`);
                        } else if (toolResponses.length > 0) {
                            // Legacy: format tool responses as text
                            userMessage = toolResponses.map((tr: any) =>
                                `[TOOL RESULT: ${tr.functionResponse.name}]\n${JSON.stringify(tr.functionResponse.response, null, 2)}\n[END TOOL RESULT]`
                            ).join('\n\n');
                        } else {
                            // Regular text parts
                            userMessage = prompt.map((p: any) => p.text || '').join('\n');
                        }
                    }

                    if (userMessage && !nativeToolResultsHandled) {
                        // Track token usage
                        const messageTokens = estimateTokens(userMessage);
                        estimatedTokensUsed += messageTokens;

                        // Warn if approaching context limit (>80% usage)
                        const utilizationPct = Math.round((estimatedTokensUsed / (maxTokens - responseReserve)) * 100);
                        if (utilizationPct > 80) {
                            console.warn(`[CopilotClaudeClient] ⚠️ Token usage at ${utilizationPct}% (${estimatedTokensUsed}/${maxTokens - responseReserve})`);
                        }

                        // Truncate message if it would exceed available tokens
                        const available = getAvailableTokens();
                        if (messageTokens > available && available > 1000) {
                            const maxChars = available * 4;
                            userMessage = userMessage.slice(0, maxChars - 100) +
                                '\n\n[MESSAGE TRUNCATED - context limit reached. Please complete current work before reading more files.]';
                            console.warn(`[CopilotClaudeClient] Truncated message from ${messageTokens} to ${estimateTokens(userMessage)} tokens`);
                        }

                        // Prune old messages before adding the new one
                        pruneMessagesIfNeeded();

                        messages.push(vscode.LanguageModelChatMessage.User(userMessage));
                    }

                    // Send request to model with retry for transient errors
                    const cancellationToken = new vscode.CancellationTokenSource().token;
                    let responseText = '';
                    let currentToolCallParts: vscode.LanguageModelToolCallPart[] = [];
                    const MAX_API_RETRIES = 3;
                    const RETRY_BACKOFF_MS = [1000, 2000, 4000];
                    let lastApiError: any = null;

                    // Build request options — pass tools if native mode
                    const requestOptions: vscode.LanguageModelChatRequestOptions = {};
                    if (useNativeTools && tools && tools.length > 0) {
                        requestOptions.tools = tools;
                        requestOptions.toolMode = vscode.LanguageModelChatToolMode.Auto;
                    }

                    for (let attempt = 0; attempt < MAX_API_RETRIES; attempt++) {
                        try {
                            responseText = ''; // Reset on each attempt
                            currentToolCallParts = [];
                            const response = await model.sendRequest(
                                messages,
                                requestOptions,
                                cancellationToken
                            );

                            if (useNativeTools) {
                                // ==================== NATIVE STREAM PROCESSING ====================
                                for await (const part of response.stream) {
                                    if (part instanceof vscode.LanguageModelTextPart) {
                                        responseText += part.value;
                                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                                        currentToolCallParts.push(part);
                                    }
                                }
                            } else {
                                // Legacy: collect all text
                                for await (const fragment of response.text) {
                                    responseText += fragment;
                                }
                            }

                            lastApiError = null; // Success
                            break;
                        } catch (retryErr: any) {
                            lastApiError = retryErr;
                            const isTransient = CopilotClaudeClient.isTransientError(retryErr);

                            if (isTransient && attempt < MAX_API_RETRIES - 1) {
                                const waitMs = RETRY_BACKOFF_MS[attempt];
                                console.warn(
                                    `[CopilotClaudeClient] ⚠️ RETRY ${attempt + 1}/${MAX_API_RETRIES} - Transient error: "${retryErr.message}". ` +
                                    `Waiting ${waitMs}ms before retry. Messages in context: ${messages.length}`
                                );
                                await new Promise(r => setTimeout(r, waitMs));
                                responseText = ''; // Discard any partial streaming
                                currentToolCallParts = [];
                                continue;
                            }
                            // Non-transient or last attempt — break out for error handling
                            const errorCode = (retryErr as any).code || 'unknown';
                            console.error(
                                `[CopilotClaudeClient] ❌ API call failed after ${attempt + 1} attempt(s): "${retryErr.message}" ` +
                                `[code=${errorCode}, transient=${isTransient}, messages=${messages.length}, tokens=${estimatedTokensUsed}]`
                            );
                            break;
                        }
                    }

                    // If all retries failed, clean up context and return error
                    if (lastApiError) {
                        // Pop the orphaned messages to keep messages array clean
                        if (userMessage && !nativeToolResultsHandled) {
                            messages.pop();
                        } else if (nativeToolResultsHandled) {
                            // Remove the two messages we added (assistant tool calls + user tool results)
                            messages.pop();
                            messages.pop();
                        }
                        // Reverse the token count so budget isn't corrupted
                        if (userMessage && !nativeToolResultsHandled) {
                            const messageTokens = estimateTokens(userMessage);
                            estimatedTokensUsed -= messageTokens;
                        } else if (nativeToolResultsHandled) {
                            // Reverse token count for native tool results that were pushed
                            const reversedTokens = lastToolCallParts.length > 0 ? estimateTokens(JSON.stringify(lastToolCallParts.map(p => p.input))) : 0;
                            estimatedTokensUsed = Math.max(0, estimatedTokensUsed - reversedTokens);
                        }
                        console.error(
                            `[CopilotClaudeClient] 🛑 All ${MAX_API_RETRIES} retries exhausted. Context cleaned up ` +
                            `(messages: ${messages.length}, tokens: ${estimatedTokensUsed}). Error: ${lastApiError.message}`
                        );
                        throw lastApiError; // Let the outer catch handle classification
                    }

                    // Store tool call parts for next turn's result pairing
                    lastToolCallParts = currentToolCallParts;

                    // Track response tokens for context window management
                    const responseTokens = estimateTokens(responseText);
                    estimatedTokensUsed += responseTokens;

                    const finalUtilization = Math.round((estimatedTokensUsed / (maxTokens - responseReserve)) * 100);
                    console.log(`[CopilotClaudeClient] Context: ${estimatedTokensUsed} tokens used (${finalUtilization}% of ${maxTokens})`);

                    if (useNativeTools) {
                        // ==================== NATIVE TOOL CALL HANDLING ====================
                        const functionCalls = currentToolCallParts.map(tc => ({
                            name: tc.name,
                            args: tc.input
                        }));

                        if (functionCalls.length > 0) {
                            console.log(`[CopilotClaudeClient] Native tool calls: ${functionCalls.map(c => c.name).join(', ')}`);
                        }

                        // Only add assistant text to history if there were no tool calls.
                        // When tool calls exist, the assistant message (with tool call parts) is added
                        // in the tool-result-feedback flow on the NEXT sendMessage() call.
                        if (currentToolCallParts.length === 0 && responseText) {
                            messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                        }

                        return {
                            response: {
                                text: () => responseText,
                                functionCalls: () => functionCalls.length > 0 ? functionCalls : undefined
                            }
                        };
                    } else {
                        // ==================== LEGACY TEXT PARSING PATH ====================
                        // Truncation recovery (only for legacy mode)
                        if (this.detectTruncation(responseText)) {
                            console.log('[CopilotClaudeClient] Truncation detected! Initiating recovery...');
                            messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                            messages.push(vscode.LanguageModelChatMessage.User(
                                "Your previous response was truncated. Continue EXACTLY where you left off. " +
                                "Do not repeat any content. Complete the tool call or code block."
                            ));
                            const continuation = await this.continueGeneration(model, messages, cancellationToken, 0);
                            responseText = this.stitchResponses(responseText, continuation);
                            console.log(`[CopilotClaudeClient] Recovery complete. Total response: ${responseText.length} chars`);
                        }

                        messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));

                        // Parse tool calls from text
                        const textDiffs = this.parseTextDiffs(responseText);
                        const jsonToolCalls = this.parseToolCalls(responseText);
                        const functionCalls = [...textDiffs, ...jsonToolCalls];

                        console.log(`[CopilotClaudeClient] Parsed ${textDiffs.length} text diffs, ${jsonToolCalls.length} JSON tool calls`);

                        let cleanedText = this.stripToolCallsFromText(responseText);
                        cleanedText = this.stripTextDiffsFromText(cleanedText);

                        return {
                            response: {
                                text: () => cleanedText,
                                functionCalls: () => functionCalls.length > 0 ? functionCalls : undefined
                            }
                        };
                    }
                } catch (error: any) {
                    console.error(`[CopilotClaudeClient] API Error (after retries): ${error.message}`);

                    // Check for consent error
                    if (error.message?.includes('consent') || error.message?.includes('permission')) {
                        return {
                            response: {
                                text: () => `Error: Copilot access denied. Please grant permission when prompted, or use API mode instead.\n\nDetails: ${error.message}`,
                                functionCalls: () => undefined
                            }
                        };
                    } else if (error.message?.includes('filtered') || error.message?.includes('content policy')) {
                        return {
                            response: {
                                text: () => `**⚠️ Copilot Response Filtered**\n\nThe response was blocked by your organization's Copilot content filters (Responsible AI).\n\n**Why this happens:**\n- Code might resemble a security violation\n- System prompt complexity triggering safety guards\n- Enterprise policy restrictions\n\n**Workaround:**\nTry using the **Claude API Mode** (via API Key) instead, which bypasses these enterprise filters.`,
                                functionCalls: () => undefined
                            }
                        };
                    }

                    // Tag transient errors so TaskRunner can distinguish them
                    const isTransient = CopilotClaudeClient.isTransientError(error);
                    const errorPrefix = isTransient ? 'TransientError' : 'Error';
                    return {
                        response: {
                            text: () => `${errorPrefix}: ${error.message}`,
                            functionCalls: () => undefined
                        }
                    };
                }
            }
        };
    }

    /**
     * Classify whether an error is transient (worth retrying) vs fatal.
     * Transient: server overload, rate limits, empty responses, timeouts.
     * Fatal: auth, consent, content policy, model not found.
     */
    public static isTransientError(err: any): boolean {
        const msg = (err.message || '').toLowerCase();
        return msg.includes('no choices') ||
            msg.includes('response contained no choices') ||
            msg.includes('timeout') ||
            msg.includes('timed out') ||
            msg.includes('503') ||
            msg.includes('429') ||
            msg.includes('rate limit') ||
            msg.includes('service unavailable') ||
            msg.includes('server error') ||
            msg.includes('overloaded') ||
            msg.includes('capacity') ||
            msg.includes('temporarily') ||
            msg.includes('econnreset') ||
            msg.includes('socket hang up');
    }

    /**
     * Parse tool calls from text response
     * Model is instructed to output tool calls in a specific format
     * Enhanced to handle multi-line content in apply_diff args
     */
    private parseToolCalls(text: string): { name: string; args: any }[] {
        const calls: { name: string; args: any }[] = [];

        // Method 1: Look for fenced code blocks with tool_call
        // Format: ```tool_call\n{"name": "tool_name", "args": {...}}\n```
        const fencedRegex = /```tool_call\s*\n?([\s\S]*?)\n?```/g;
        let match;

        while ((match = fencedRegex.exec(text)) !== null) {
            try {
                // Pre-process to fix common JSON issues with multi-line strings
                const jsonStr = match[1].trim();
                const parsed = this.parseToolCallJson(jsonStr);
                if (parsed && parsed.name) {
                    calls.push({
                        name: parsed.name,
                        args: parsed.args || parsed.arguments || {}
                    });
                    console.log(`[CopilotClaudeClient] Parsed fenced tool call: ${parsed.name}`);
                }
            } catch (e: any) {
                console.warn('[CopilotClaudeClient] Failed to parse fenced tool call:', e.message);
            }
        }

        // Method 2: Look for inline JSON with "name" field (the model might not use code fences)
        // Format: {"name": "tool_name", "args": {...}}
        if (calls.length === 0) {
            const inlineRegex = /\{"name"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[^}]*\})\s*\}/g;
            while ((match = inlineRegex.exec(text)) !== null) {
                try {
                    const name = match[1];
                    const args = JSON.parse(match[2]);
                    calls.push({ name, args });
                    console.log(`[CopilotClaudeClient] Parsed inline tool call: ${name}`);
                } catch (e) {
                    console.warn('[CopilotClaudeClient] Failed to parse inline tool call');
                }
            }
        }

        // Method 3: Look for tool calls with nested objects in args (like command with nested object)
        if (calls.length === 0) {
            const nestedRegex = /\{"name"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}(?:\]|\)|$|[,\s])/g;
            while ((match = nestedRegex.exec(text)) !== null) {
                try {
                    const name = match[1];
                    const args = JSON.parse(match[2]);
                    calls.push({ name, args });
                    console.log(`[CopilotClaudeClient] Parsed nested tool call: ${name}`);
                } catch (e) {
                    // Skip malformed
                }
            }
        }

        console.log(`[CopilotClaudeClient] Total tool calls found: ${calls.length}`);
        return calls;
    }

    /**
     * Parse tool call JSON with special handling for multi-line string content
     * LLMs often output literal newlines in JSON strings instead of \n escapes
     */
    private parseToolCallJson(jsonStr: string): { name: string; args?: any; arguments?: any } | null {
        // First, try direct parse (works if model escaped correctly)
        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            // Continue to more robust parsing
        }

        // The model likely output literal newlines inside string values
        // Need to find and fix them
        console.log('[CopilotClaudeClient] Attempting robust JSON parse for multi-line content...');

        try {
            // Strategy: Extract the diff content separately, parse the structure, then recombine
            // Look for "diff": " followed by the diff content
            const diffMatch = jsonStr.match(/"diff"\s*:\s*"([\s\S]*?)"\s*\}/);
            if (diffMatch) {
                const diffContent = diffMatch[1];

                // Escape unescaped newlines and other special chars in the diff content
                const escapedDiff = diffContent
                    .replace(/\\/g, '\\\\')  // Escape backslashes first
                    .replace(/\n/g, '\\n')   // Then escape newlines
                    .replace(/\r/g, '\\r')   // Carriage returns
                    .replace(/\t/g, '\\t');  // Tabs

                // Rebuild the JSON with properly escaped diff
                const fixedJson = jsonStr.replace(
                    /"diff"\s*:\s*"[\s\S]*?"\s*\}/,
                    `"diff": "${escapedDiff}"}`
                );

                return JSON.parse(fixedJson);
            }

            // Try extracting path and diff separately for apply_diff
            const pathMatch = jsonStr.match(/"path"\s*:\s*"([^"]+)"/);
            if (pathMatch) {
                // Find where diff content starts
                const diffStart = jsonStr.indexOf('"diff"');
                if (diffStart !== -1) {
                    // Find the opening quote of the diff value
                    const valueStart = jsonStr.indexOf('"', diffStart + 6) + 1;
                    // Find the closing quote before the final }
                    const lastBrace = jsonStr.lastIndexOf('}');
                    const lastQuote = jsonStr.lastIndexOf('"', lastBrace);

                    if (valueStart > 0 && lastQuote > valueStart) {
                        const rawDiff = jsonStr.slice(valueStart, lastQuote);

                        return {
                            name: 'apply_diff',
                            args: {
                                path: pathMatch[1],
                                diff: rawDiff  // Use raw diff, JSON.parse handles escaping
                            }
                        };
                    }
                }
            }
        } catch (e: any) {
            console.warn('[CopilotClaudeClient] Robust parse also failed:', e.message);
        }

        return null;
    }

    /**
     * Strip tool call blocks from text to avoid showing raw JSON in the UI
     * This makes the output match Gemini's behavior where text and tool calls are separate
     */
    private stripToolCallsFromText(text: string): string {
        // Remove fenced tool_call blocks: ```tool_call\n{...}\n```
        let cleaned = text.replace(/```tool_call\s*\n?[\s\S]*?\n?```/g, '');

        // Remove inline JSON tool calls that might be at the end of lines
        // Pattern: {"name": "...", "args": {...}}
        cleaned = cleaned.replace(/\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^}]*\}\s*\}/g, '');

        // Clean up any extra whitespace left behind
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

        return cleaned;
    }

    // ==================== TEXT-BASED DIFF PARSING ====================

    /**
     * Parse text-based [APPLY_DIFF: path]...[END_DIFF] blocks
     * This format avoids JSON escaping issues with multi-line content
     * Returns function calls in the same format as parseToolCalls for consistency
     */
    private parseTextDiffs(text: string): { name: string; args: any }[] {
        const calls: { name: string; args: any }[] = [];

        // Pattern: [APPLY_DIFF: path]...content...[END_DIFF]
        const diffBlockPattern = /\[APPLY_DIFF:\s*([^\]]+)\]([\s\S]*?)\[END_DIFF\]/g;
        let match;

        while ((match = diffBlockPattern.exec(text)) !== null) {
            const filePath = match[1].trim();
            const diffContent = match[2].trim();

            if (filePath && diffContent) {
                calls.push({
                    name: 'apply_diff',
                    args: {
                        path: filePath,
                        diff: diffContent
                    }
                });
                console.log(`[CopilotClaudeClient] Parsed text-based apply_diff for: ${filePath}`);
            }
        }

        if (calls.length > 0) {
            console.log(`[CopilotClaudeClient] Found ${calls.length} text-based diff blocks`);
        }

        return calls;
    }

    /**
     * Strip text-based diff blocks from response to avoid showing in UI
     */
    private stripTextDiffsFromText(text: string): string {
        // Remove [APPLY_DIFF: ...]...[END_DIFF] blocks
        let cleaned = text.replace(/\[APPLY_DIFF:\s*[^\]]+\][\s\S]*?\[END_DIFF\]/g, '');

        // Clean up any extra whitespace left behind
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

        return cleaned;
    }

    // ==================== TRUNCATION RECOVERY (Strategy 2) ====================

    /**
     * Detect if response was truncated mid-output
     * This catches incomplete code blocks, SEARCH/REPLACE diffs, and tool calls
     */
    private detectTruncation(text: string): boolean {
        const trimmed = text.trim();

        // Check for incomplete tool_call JSON (most critical for apply_diff)
        if (trimmed.includes('```tool_call') && !trimmed.endsWith('```')) {
            console.log('[CopilotClaudeClient] Truncation: Incomplete tool_call block');
            return true;
        }

        // Check for incomplete code blocks (odd number of ```)
        const codeBlockStarts = (trimmed.match(/```/g) || []).length;
        if (codeBlockStarts % 2 !== 0) {
            console.log('[CopilotClaudeClient] Truncation: Odd number of code fences');
            return true;
        }

        // Check for incomplete SEARCH/REPLACE (critical for apply_diff)
        if (trimmed.includes('<<<<<<< SEARCH') && !trimmed.includes('>>>>>>> REPLACE')) {
            console.log('[CopilotClaudeClient] Truncation: Incomplete SEARCH/REPLACE block');
            return true;
        }

        // Check for incomplete text-based [APPLY_DIFF:]...[END_DIFF] block
        if (trimmed.includes('[APPLY_DIFF:') && !trimmed.includes('[END_DIFF]')) {
            console.log('[CopilotClaudeClient] Truncation: Incomplete [APPLY_DIFF:] block');
            return true;
        }

        // Check for incomplete JSON diff argument
        if (trimmed.includes('"diff":') && !trimmed.includes('>>>>>>> REPLACE')) {
            const lastDiff = trimmed.lastIndexOf('"diff":');
            const afterDiff = trimmed.slice(lastDiff);
            if (afterDiff.includes('<<<<<<< SEARCH') && !afterDiff.includes('>>>>>>> REPLACE')) {
                console.log('[CopilotClaudeClient] Truncation: Incomplete diff in tool call');
                return true;
            }
        }

        // Check for mid-word/mid-sentence truncation at end
        if (/[a-zA-Z]$/.test(trimmed) && !trimmed.endsWith('.')) {
            const lastNewline = trimmed.lastIndexOf('\n');
            const lastLine = trimmed.slice(lastNewline + 1);
            // If last line is short and doesn't end with proper terminator, likely truncated
            if (lastLine.length < 10 && !/[.!?:}\])"'`]$/.test(lastLine)) {
                console.log('[CopilotClaudeClient] Truncation: Suspicious line ending');
                return true;
            }
        }

        return false;
    }

    /**
     * Stitch continuation onto original response, cleaning up filler text
     */
    private stitchResponses(first: string, continuation: string): string {
        // Remove common "continuation filler" from the start of the continuation
        const fillerPatterns = [
            /^(Here is the rest|Continuing|I'll continue|I will continue|Resuming|Let me continue|Here's the rest|...continuing)[\s.:]*\n*/i,
            /^```\w*\n/, // Remove duplicate code fence if present
        ];

        let cleaned = continuation;
        for (const pattern of fillerPatterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        console.log('[CopilotClaudeClient] Stitched continuation:', cleaned.substring(0, 100) + '...');
        return first + cleaned;
    }

    /**
     * Recursively continue generation until response is complete (max 5 attempts)
     */
    private async continueGeneration(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        token: vscode.CancellationToken,
        depth: number
    ): Promise<string> {
        if (depth >= 5) {
            console.warn('[CopilotClaudeClient] Max continuation depth (5) reached, stopping');
            return '';
        }

        try {
            const response = await model.sendRequest(messages, {}, token);
            let text = '';
            for await (const fragment of response.text) {
                text += fragment;
            }

            console.log(`[CopilotClaudeClient] Continuation ${depth + 1} received: ${text.length} chars`);

            // Check if this continuation also got truncated
            if (this.detectTruncation(text)) {
                messages.push(vscode.LanguageModelChatMessage.Assistant(text));
                messages.push(vscode.LanguageModelChatMessage.User("Continue exactly where you left off. Do not repeat content."));
                const more = await this.continueGeneration(model, messages, token, depth + 1);
                return this.stitchResponses(text, more);
            }

            return text;
        } catch (error: any) {
            console.error(`[CopilotClaudeClient] Continuation error at depth ${depth}:`, error.message);
            return '';
        }
    }

    /**
     * Research/search the web using Copilot Claude
     * Note: vscode.lm API doesn't have native web search, so we simulate with a research prompt
     */
    public async research(query: string): Promise<string> {
        if (!this.model) {
            return 'Error: Copilot Claude model not initialized.';
        }

        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(`You are a research assistant. Please provide comprehensive, factual information about the following query. Include relevant technical details, best practices, and current recommendations. If this is about a specific technology or library, include version-specific information where relevant.

Query: ${query}

Provide a detailed, helpful response based on your training data. If you're uncertain about specific details, indicate that clearly.`)
            ];

            const response = await this.model.sendRequest(
                messages,
                {},
                new vscode.CancellationTokenSource().token
            );

            let result = '';
            for await (const fragment of response.text) {
                result += fragment;
            }

            return result || 'No research results found.';
        } catch (error: any) {
            return `Research failed: ${error.message}`;
        }
    }

    /**
     * Analyze a screenshot using Copilot Claude Vision
     * Uses the new vscode.lm API with image content support
     */
    public async analyzeScreenshot(
        imageBase64: Uint8Array,
        mimeType: string,
        expectedDescription: string,
        missionObjective: string
    ): Promise<{
        matches: boolean;
        confidence: number;
        issues: string[];
        suggestions: string[];
        analysis: string;
    }> {
        if (!this.model) {
            return {
                matches: false,
                confidence: 0,
                issues: ['Copilot Claude model not initialized'],
                suggestions: ['Ensure VS Code Copilot is available'],
                analysis: 'Vision analysis failed: Model not initialized'
            };
        }

        try {
            // Save base64 image to a temp file and get URI
            const fs = await import('fs');
            const path = await import('path');
            const os = await import('os');

            const tempDir = os.tmpdir();
            const ext = mimeType.includes('png') ? 'png' : 'jpg';
            const tempPath = path.join(tempDir, `vibe_screenshot_${Date.now()}.${ext}`);

            // Write base64 to file
            //const imageBuffer = Buffer.from(imageBase64, 'base64');
            //fs.writeFileSync(tempPath, imageBuffer);

            //const imageUri = vscode.Uri.file(tempPath);
            //console.log(`[CopilotClaudeClient] Vision analysis: saved temp image to ${tempPath}`);

            const prompt = `You are a UI testing expert. Analyze this screenshot and determine if it matches the expected design.

MISSION OBJECTIVE: ${missionObjective}

EXPECTED UI DESCRIPTION: ${expectedDescription}

Analyze the screenshot and respond in this EXACT JSON format:
{
"matches": true/false,
"confidence": 0-100,
"issues": ["list of specific UI problems found"],
"suggestions": ["list of specific code fixes to address the issues"],
"analysis": "Brief description of what you see vs what was expected"
}

IMPORTANT:
- Set "matches" to true ONLY if the UI clearly fulfills the expected description
- Be specific about issues (e.g., "Button text is 'Submit' but should be 'Login'")
- Provide actionable suggestions (e.g., "Change the h1 text from 'Welcome' to 'Login Form'")
- If the page is blank, loading, or shows an error, that's a critical issue

Respond ONLY with the JSON, no other text.`;

            // Create multimodal message with text and image
            const messages = [
                vscode.LanguageModelChatMessage.User([new vscode.LanguageModelDataPart(imageBase64, mimeType)]),
                vscode.LanguageModelChatMessage.User(prompt),];

            const response = await this.model.sendRequest(
                messages,
                {},
                new vscode.CancellationTokenSource().token
            );

            let responseText = '';
            for await (const fragment of response.text) {
                responseText += fragment;
            }

            // Clean up temp file
            try {
                fs.unlinkSync(tempPath);
            } catch { /* ignore cleanup errors */ }

            console.log(`[CopilotClaudeClient] Vision response: ${responseText.substring(0, 100)}...`);

            // Parse the JSON response
            try {
                let jsonText = responseText.trim();
                if (jsonText.startsWith('```json')) { jsonText = jsonText.slice(7); }
                if (jsonText.startsWith('```')) { jsonText = jsonText.slice(3); }
                if (jsonText.endsWith('```')) { jsonText = jsonText.slice(0, -3); }
                jsonText = jsonText.trim();

                const parsed = JSON.parse(jsonText);
                return {
                    matches: parsed.matches === true,
                    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
                    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
                    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
                    analysis: parsed.analysis || 'No analysis provided'
                };
            } catch (parseError) {
                // If JSON parsing fails, try to extract meaning from text
                const lowerText = responseText.toLowerCase();
                const matches = lowerText.includes('matches": true') ||
                    (lowerText.includes('looks correct') && !lowerText.includes('not'));

                return {
                    matches: matches,
                    confidence: 30,
                    issues: ['Could not parse vision analysis response'],
                    suggestions: ['Manual review recommended'],
                    analysis: responseText.substring(0, 500)
                };
            }
        } catch (error: any) {
            console.error('[CopilotClaudeClient] Vision analysis failed:', error.message);

            // Check if it's a "not supported" error - fall back gracefully
            if (error.message?.includes('image') || error.message?.includes('multimodal') || error.message?.includes('content')) {
                return {
                    matches: false,
                    confidence: 0,
                    issues: ['This Claude model may not support vision through Copilot'],
                    suggestions: [
                        'Use Gemini for vision analysis (set Gemini API key)',
                        'Use Claude API mode for full vision support',
                        `Expected: ${expectedDescription.substring(0, 100)}...`
                    ],
                    analysis: `Vision analysis not available for this model. Mission objective: ${missionObjective}`
                };
            }

            return {
                matches: false,
                confidence: 0,
                issues: [`Vision analysis error: ${error.message}`],
                suggestions: ['Check Copilot connection and try again'],
                analysis: 'Analysis failed due to API error'
            };
        }
    }
}
