import * as vscode from 'vscode';
import { ISession } from './GeminiClient';

/**
 * Claude client using VS Code's Language Model API (vscode.lm)
 * This leverages the user's GitHub Copilot subscription for Claude access
 */
export class CopilotClaudeClient {
    private model: vscode.LanguageModelChat | undefined;

    constructor() {
        // Model will be selected when session starts
    }

    public async initialize(): Promise<boolean> {
        try {
            // First, list ALL available models to debug
            const allModels = await vscode.lm.selectChatModels({});
            console.log('[CopilotClaudeClient] All available models:');
            allModels.forEach(m => {
                console.log(`  - id: ${m.id}, name: ${m.name}, vendor: ${m.vendor}, family: ${m.family}`);
            });

            // Try to find Claude model - prefer opus if available
            let claudeModel = allModels.find(m =>
                m.id.toLowerCase().includes('claude-opus')
            );

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
                console.log(`[CopilotClaudeClient] Found Claude model: ${this.model.id} (${this.model.name})`);
                return true;
            }

            // Fallback: try specific family filters that might work
            const familyAttempts = ['claude', 'anthropic', 'claude-3', 'claude-opus'];
            for (const family of familyAttempts) {
                const models = await vscode.lm.selectChatModels({ family });
                if (models.length > 0) {
                    this.model = models[0];
                    console.log(`[CopilotClaudeClient] Found Claude model via family '${family}': ${this.model.id}`);
                    return true;
                }
            }

            console.error('[CopilotClaudeClient] No Claude models found. Available models:', allModels.map(m => m.id).join(', '));
            return false;
        } catch (error: any) {
            console.error('[CopilotClaudeClient] Error initializing:', error.message);
            return false;
        }
    }

    public startSession(systemPrompt: string, _thinkingLevel: 'low' | 'high' = 'high'): ISession {
        const messages: vscode.LanguageModelChatMessage[] = [];
        const model = this.model;

        // Inject tool call format instructions since vscode.lm doesn't support native function calling
        const toolCallInstructions = `

CRITICAL - TOOL CALL FORMAT:
Since you're running through VS Code's Language Model API, you MUST output tool calls in this EXACT format:

\`\`\`tool_call
{"name": "tool_name", "args": {"param1": "value1", "param2": "value2"}}
\`\`\`

Available tools and their formats:
- \`\`\`tool_call
{"name": "list_files", "args": {"path": "."}}
\`\`\`
- \`\`\`tool_call
{"name": "read_file", "args": {"path": "path/to/file"}}
\`\`\`
- \`\`\`tool_call
{"name": "write_file", "args": {"path": "path/to/file", "content": "file content"}}
\`\`\`
- \`\`\`tool_call
{"name": "run_command", "args": {"command": "npm start"}}
\`\`\`
- \`\`\`tool_call
{"name": "reload_browser", "args": {}}
\`\`\`
- \`\`\`tool_call
{"name": "navigate_browser", "args": {"url": "http://localhost:3000"}}
\`\`\`
- \`\`\`tool_call
{"name": "search_web", "args": {"query": "search query"}}
\`\`\`

You MUST use this exact format. Do NOT just describe what you want to do - actually output the tool_call block!
`;

        // Add system context as first user message (vscode.lm may not support system role)
        messages.push(vscode.LanguageModelChatMessage.User(`[SYSTEM CONTEXT]\n${systemPrompt}\n${toolCallInstructions}\n[END SYSTEM CONTEXT]`));

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

                    if (typeof prompt === 'string') {
                        userMessage = prompt;
                    } else if (Array.isArray(prompt)) {
                        // Check if this is a tool response
                        const toolResponses = prompt.filter((p: any) => p.functionResponse);
                        if (toolResponses.length > 0) {
                            // Format tool responses as text (vscode.lm doesn't support native tool_use)
                            userMessage = toolResponses.map((tr: any) =>
                                `[TOOL RESULT: ${tr.functionResponse.name}]\n${JSON.stringify(tr.functionResponse.response, null, 2)}\n[END TOOL RESULT]`
                            ).join('\n\n');
                        } else {
                            // Regular text parts
                            userMessage = prompt.map((p: any) => p.text || '').join('\n');
                        }
                    }

                    if (userMessage) {
                        messages.push(vscode.LanguageModelChatMessage.User(userMessage));
                    }

                    // Send request to model
                    const response = await model.sendRequest(
                        messages,
                        {},
                        new vscode.CancellationTokenSource().token
                    );

                    // Collect response text
                    let responseText = '';
                    for await (const fragment of response.text) {
                        responseText += fragment;
                    }

                    // Add assistant response to history
                    messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));

                    // Parse for tool calls (text-based parsing since vscode.lm doesn't support native tool_use)
                    const functionCalls = this.parseToolCalls(responseText);

                    // Strip tool call blocks from text to avoid showing JSON in UI
                    // This makes the output match Gemini's behavior where text and tool calls are separate
                    const cleanedText = this.stripToolCallsFromText(responseText);

                    return {
                        response: {
                            text: () => cleanedText,
                            functionCalls: () => functionCalls.length > 0 ? functionCalls : undefined
                        }
                    };
                } catch (error: any) {
                    console.error('[CopilotClaudeClient] API Error:', error.message);

                    // Check for consent error
                    if (error.message?.includes('consent') || error.message?.includes('permission')) {
                        return {
                            response: {
                                text: () => `Error: Copilot access denied. Please grant permission when prompted, or use API mode instead.\n\nDetails: ${error.message}`,
                                functionCalls: () => undefined
                            }
                        }

                        // Check for content filtering (Enterprise/Org policies)
                        if (error.message?.includes('filtered') || error.message?.includes('content policy')) {
                            return {
                                response: {
                                    text: () => `**⚠️ Copilot Response Filtered**\n\nThe response was blocked by your organization's Copilot content filters (Responsible AI).\n\n**Why this happens:**\n- Code might resemble a security violation\n- System prompt complexity triggering safety guards\n- Enterprise policy restrictions\n\n**Workaround:**\nTry using the **Claude API Mode** (via API Key) instead, which bypasses these enterprise filters.`,
                                    functionCalls: () => undefined
                                }
                            };
                        }
                    }

                    return {
                        response: {
                            text: () => `Error: ${error.message}`,
                            functionCalls: () => undefined
                        }
                    };
                }
            }
        };
    }

    /**
     * Parse tool calls from text response
     * Model is instructed to output tool calls in a specific format
     */
    private parseToolCalls(text: string): { name: string; args: any }[] {
        const calls: { name: string; args: any }[] = [];

        // Method 1: Look for fenced code blocks with tool_call
        // Format: ```tool_call\n{"name": "tool_name", "args": {...}}\n```
        const fencedRegex = /```tool_call\s*\n?([\s\S]*?)\n?```/g;
        let match;

        while ((match = fencedRegex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (parsed.name) {
                    calls.push({
                        name: parsed.name,
                        args: parsed.args || parsed.arguments || {}
                    });
                    console.log(`[CopilotClaudeClient] Parsed fenced tool call: ${parsed.name}`);
                }
            } catch (e) {
                console.warn('[CopilotClaudeClient] Failed to parse fenced tool call:', match[1]);
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
        imageBase64: string,
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
            const imageBuffer = Buffer.from(imageBase64, 'base64');
            fs.writeFileSync(tempPath, imageBuffer);

            const imageUri = vscode.Uri.file(tempPath);
            console.log(`[CopilotClaudeClient] Vision analysis: saved temp image to ${tempPath}`);

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
                vscode.LanguageModelChatMessage.User([
                    { type: 'text', value: prompt },
                    { type: 'image', value: imageUri }
                ] as any) // Using 'as any' for the new content array format
            ];

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
                if (jsonText.startsWith('```json')) jsonText = jsonText.slice(7);
                if (jsonText.startsWith('```')) jsonText = jsonText.slice(3);
                if (jsonText.endsWith('```')) jsonText = jsonText.slice(0, -3);
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
